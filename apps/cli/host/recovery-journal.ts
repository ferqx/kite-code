import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FileLock, ProfileAccess } from '@kite-ai/agent/profile-access';
import {
  parseRecoveryIntent,
  type RecoveryIntent,
  type RecoveryJournal,
  type RecoveryPhase,
} from '../src/recovery';
export type RecoveryRecord = { intent: RecoveryIntent; phase: RecoveryPhase };
const phases: RecoveryPhase[] = [
  'submitting',
  'accepted',
  'resumed',
  'interrupted',
  'suppressed',
  'failed',
  'outcome_unknown',
];
const unavailable = () => Error('recovery_journal_unavailable');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const present = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
};
function privateStat(path: string, directory = false) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  )
    throw unavailable();
  return stat;
}
function parse(value: unknown): RecoveryRecord[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const doc = value as Record<string, unknown>;
  if (
    Object.keys(doc).sort().join(',') !== 'records,version' ||
    doc.version !== 1 ||
    !Array.isArray(doc.records) ||
    doc.records.length > 128
  )
    throw unavailable();
  const ids = new Set<string>();
  return doc.records.map((raw) => {
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(',') !== 'intent,phase'
    )
      throw unavailable();
    const record = raw as RecoveryRecord;
    const intent = parseRecoveryIntent(record.intent);
    if (!phases.includes(record.phase) || ids.has(intent.request.commandId)) throw unavailable();
    ids.add(intent.request.commandId);
    return { intent, phase: record.phase };
  });
}
function finite<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'recovery_intent_limit',
        'recovery_intent_conflict',
        'recovery_journal_unavailable',
      ].includes(error.message)
    )
      throw error;
    throw unavailable();
  }
}
/** Caller metadata only; held public profile-use lease and data lock protect publication. */
export function openRecoveryJournal(input: {
  access: ProfileAccess;
  acquireWriteLock: () => FileLock;
}): RecoveryJournal & { list(): RecoveryRecord[]; close(): void } {
  const parent = join(input.access.profilePath, 'ui'),
    path = join(parent, 'recovery.json');
  let closed = false;
  const read = () => {
    if (closed) throw unavailable();
    privateStat(input.access.profilePath, true);
    if (present(parent)) privateStat(parent, true);
    if (!present(path)) return { records: [] as RecoveryRecord[], etag: null as string | null };
    const before = privateStat(path),
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.ctimeMs !== before.ctimeMs ||
        opened.size !== before.size ||
        opened.nlink !== 1 ||
        (opened.mode & 0o077) !== 0 ||
        opened.size > 262144
      )
        throw unavailable();
      const bytes = readFileSync(fd),
        after = fstatSync(fd);
      if (
        bytes.length !== opened.size ||
        after.ctimeMs !== opened.ctimeMs ||
        after.size !== opened.size
      )
        throw unavailable();
      return {
        records: parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))),
        etag: hash(bytes),
      };
    } finally {
      closeSync(fd);
    }
  };
  const mutate = <T>(change: (rows: RecoveryRecord[]) => { result: T; changed: boolean }) => {
    const lock = input.acquireWriteLock();
    let temporary: string | undefined;
    try {
      const original = read(),
        rows = structuredClone(original.records),
        next = change(rows);
      if (!next.changed) return next.result;
      const bytes = Buffer.from(JSON.stringify({ version: 1, records: rows }) + '\n');
      if (bytes.length > 262144) throw unavailable();
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      privateStat(parent, true);
      temporary = join(parent, `.recovery-${randomUUID()}.tmp`);
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const written = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!written) throw unavailable();
          offset += written;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (read().etag !== original.etag) throw unavailable();
      renameSync(temporary, path);
      temporary = undefined;
      const dir = openSync(
        parent,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
      if (read().etag !== hash(bytes)) throw unavailable();
      return next.result;
    } finally {
      if (temporary) rmSync(temporary, { force: true });
      lock.release();
    }
  };
  return {
    prepare(raw) {
      const intent = parseRecoveryIntent(raw);
      return finite(() =>
        mutate((rows) => {
          const old = rows.find((row) => row.intent.request.commandId === intent.request.commandId);
          if (old) {
            if (JSON.stringify(old.intent) !== JSON.stringify(intent))
              throw Error('recovery_intent_conflict');
            return { result: false, changed: false };
          }
          if (rows.length >= 128) throw Error('recovery_intent_limit');
          rows.push({ intent, phase: 'submitting' });
          return { result: true, changed: true };
        }),
      );
    },
    record(intent, phase) {
      if (!phases.includes(phase)) throw unavailable();
      finite(() =>
        mutate((rows) => {
          const old = rows.find((row) => row.intent.request.commandId === intent.request.commandId);
          if (!old || JSON.stringify(old.intent) !== JSON.stringify(parseRecoveryIntent(intent)))
            throw unavailable();
          if (old.phase === phase) return { result: undefined, changed: false };
          old.phase = phase;
          return { result: undefined, changed: true };
        }),
      );
    },
    list() {
      return finite(() => structuredClone(read().records));
    },
    close() {
      closed = true;
    },
  };
}
