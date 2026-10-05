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
  canonicalFileRecoveryIntent,
  canTransitionFileRecoveryPhase,
  type FileRecoveryIntent,
  parseFileRecoveryIntent,
} from '@kite-ai/client/file-recovery-intent';

const unavailable = () => Error('file_recovery_journal_unavailable');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type Phase = NonNullable<FileRecoveryIntent['code']>['phase'];
function privateStat(path: string, directory = false) {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) ||
    (s.mode & 0o077) !== 0 ||
    typeof process.getuid !== 'function' ||
    s.uid !== process.getuid()
  )
    throw unavailable();
  return s;
}
function present(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}
function ids(intent: FileRecoveryIntent) {
  return [intent.code?.request.commandId, intent.fork?.request.commandId].filter(
    (id): id is string => id !== undefined,
  );
}
async function parse(bytes: Uint8Array) {
  const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as {
    version?: unknown;
    records?: unknown;
  };
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'records,version' ||
    raw.version !== 1 ||
    !Array.isArray(raw.records) ||
    raw.records.length > 128
  )
    throw unavailable();
  const result: FileRecoveryIntent[] = [],
    commands = new Set<string>();
  for (const value of raw.records) {
    const intent = await parseFileRecoveryIntent(value);
    for (const id of ids(intent)) {
      if (commands.has(id)) throw unavailable();
      commands.add(id);
    }
    result.push(intent);
  }
  return result;
}
/** Original caller metadata only. No POST capability, permit, owner or execution authority. */
export function openFileRecoveryJournal(input: {
  access: ProfileAccess;
  acquireWriteLock: () => FileLock;
}) {
  const parent = join(input.access.profilePath, 'ui'),
    path = join(parent, 'file-recovery-intents.json');
  let closed = false,
    queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  }
  const read = async () => {
    if (closed || typeof constants.O_NOFOLLOW !== 'number' || constants.O_NOFOLLOW === 0)
      throw unavailable();
    privateStat(input.access.profilePath, true);
    if (present(parent)) privateStat(parent, true);
    if (!present(path)) return { records: [] as FileRecoveryIntent[], etag: null as string | null };
    const before = privateStat(path),
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const opened = fstatSync(fd);
      if (
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.ctimeMs !== before.ctimeMs ||
        opened.size !== before.size ||
        opened.nlink !== 1 ||
        opened.uid !== process.getuid!() ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.size > 16 * 1024 * 1024
      )
        throw unavailable();
      bytes = readFileSync(fd);
      const after = fstatSync(fd);
      if (
        bytes.length !== opened.size ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.nlink !== 1 ||
        after.uid !== opened.uid ||
        after.mode !== opened.mode ||
        after.ctimeMs !== opened.ctimeMs ||
        after.size !== opened.size
      )
        throw unavailable();
    } finally {
      closeSync(fd);
    }
    const records = await parse(bytes!);
    if (closed) throw unavailable();
    return { records, etag: hash(bytes!) };
  };
  const mutate = async <T>(
    change: (rows: FileRecoveryIntent[]) => { result: T; changed: boolean },
  ) => {
    if (closed) throw unavailable();
    const lock = input.acquireWriteLock();
    let temporary: string | undefined;
    try {
      const original = await read(),
        rows = structuredClone(original.records),
        next = change(rows);
      if (!next.changed) return next.result;
      const bytes = Buffer.from(`${JSON.stringify({ version: 1, records: rows })}\n`);
      if (bytes.length > 16 * 1024 * 1024) throw Error('file_recovery_journal_capacity');
      await parse(bytes);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      privateStat(parent, true);
      temporary = join(parent, `.file-recovery-intents-${randomUUID()}.tmp`);
      const fd = openSync(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const n = writeSync(fd, bytes, offset, bytes.length - offset);
          if (!n) throw unavailable();
          offset += n;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (closed || (await read()).etag !== original.etag) throw unavailable();
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
      if ((await read()).etag !== hash(bytes)) throw unavailable();
      return next.result;
    } finally {
      if (temporary) rmSync(temporary, { force: true });
      lock.release();
    }
  };
  return {
    prepare(raw: FileRecoveryIntent) {
      const saved = structuredClone(raw);
      return serial(async () => {
        const intent = await parseFileRecoveryIntent(saved);
        return mutate((rows) => {
          const old = rows.find((row) => ids(row).some((id) => ids(intent).includes(id)));
          if (old) {
            if (canonicalFileRecoveryIntent(old) !== canonicalFileRecoveryIntent(intent))
              throw Error('file_recovery_intent_conflict');
            return { result: false, changed: false };
          }
          if (rows.length >= 128) throw Error('file_recovery_journal_limit');
          rows.push(intent);
          return { result: true, changed: true };
        });
      });
    },
    record(raw: FileRecoveryIntent, leg: 'code' | 'fork', phase: Phase) {
      const saved = structuredClone(raw);
      return serial(async () => {
        const intent = await parseFileRecoveryIntent(saved);
        return mutate((rows) => {
          const old = rows.find(
            (row) => canonicalFileRecoveryIntent(row) === canonicalFileRecoveryIntent(intent),
          );
          if (!old?.[leg] || !canTransitionFileRecoveryPhase(old[leg]!.phase, phase))
            throw unavailable();
          if (old[leg]!.phase === phase) return { result: undefined, changed: false };
          old[leg]!.phase = phase;
          return { result: undefined, changed: true };
        });
      });
    },
    list() {
      return serial(async () => structuredClone((await read()).records));
    },
    close() {
      closed = true;
    },
  };
}
