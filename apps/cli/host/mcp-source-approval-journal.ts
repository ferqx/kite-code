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
import {
  assertProfileAccess,
  type FileLock,
  type ProfileAccess,
} from '@kite-ai/agent/profile-access';
import {
  type McpSourceApprovalRecord,
  mcpSourceApprovalRecordIdentity,
  parseMcpSourceApprovalRecord,
} from './mcp-source-approval-intents';
export interface McpSourceApprovalJournal {
  prepare(record: McpSourceApprovalRecord): boolean;
  record(record: McpSourceApprovalRecord, phase: McpSourceApprovalRecord['phase']): void;
  list(): McpSourceApprovalRecord[];
  close(): void;
}
const unavailable = () => Error('mcp_source_approval_journal_unavailable');
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
function parse(value: unknown): McpSourceApprovalRecord[] {
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
    const record = parseMcpSourceApprovalRecord(raw);
    if (ids.has(record.intent.request.commandId)) throw unavailable();
    ids.add(record.intent.request.commandId);
    return record;
  });
}
function finite<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'mcp_source_approval_intent_limit',
        'mcp_source_approval_capacity_exceeded',
        'mcp_source_approval_intent_conflict',
        'mcp_source_approval_journal_unavailable',
        'mcp_source_approval_original_outcome_required',
      ].includes(error.message)
    )
      throw error;
    throw unavailable();
  }
}
/** Caller metadata only; held public profile-use lease and data lock protect publication. */
export function openMcpSourceApprovalJournal(input: {
  access: ProfileAccess;
  acquireWriteLock: () => FileLock;
}): McpSourceApprovalJournal {
  const parent = join(input.access.profilePath, 'ui'),
    path = join(parent, 'mcp-source-approval-intents.json');
  let closed = false;
  const read = () => {
    if (closed) throw unavailable();
    assertProfileAccess(input.access);
    privateStat(input.access.profilePath, true);
    if (present(parent)) privateStat(parent, true);
    if (!present(path))
      return { records: [] as McpSourceApprovalRecord[], etag: null as string | null };
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
        opened.size > 16 * 1024 * 1024
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
  const mutate = <T>(
    change: (rows: McpSourceApprovalRecord[]) => { result: T; changed: boolean },
  ) => {
    const lock = input.acquireWriteLock();
    let temporary: string | undefined;
    try {
      const original = read(),
        rows = structuredClone(original.records),
        next = change(rows);
      if (!next.changed) return next.result;
      const bytes = Buffer.from(`${JSON.stringify({ version: 1, records: rows })}\n`);
      if (bytes.length > 16 * 1024 * 1024) throw Error('mcp_source_approval_capacity_exceeded');
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      privateStat(parent, true);
      temporary = join(parent, `.mcp-source-approval-intents-${randomUUID()}.tmp`);
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
      try {
        if (temporary) rmSync(temporary, { force: true });
      } finally {
        lock.release();
      }
    }
  };
  return {
    prepare(raw) {
      const record = parseMcpSourceApprovalRecord(raw);
      return finite(() =>
        mutate((rows) => {
          const old = rows.find(
            (row) => row.intent.request.commandId === record.intent.request.commandId,
          );
          if (old) {
            if (mcpSourceApprovalRecordIdentity(old) !== mcpSourceApprovalRecordIdentity(record))
              throw Error('mcp_source_approval_intent_conflict');
            return { result: false, changed: false };
          }
          if (rows.length >= 128) throw Error('mcp_source_approval_intent_limit');
          if (
            rows.some(
              (row) =>
                row.intent.request.expectedStoreId === record.intent.request.expectedStoreId &&
                ['submitting', 'pending', 'outcome_unknown'].includes(row.phase) &&
                row.intent.workspaceId === record.intent.workspaceId &&
                row.intent.request.input.serverId === record.intent.request.input.serverId,
            )
          )
            throw Error('mcp_source_approval_original_outcome_required');
          rows.push({ ...record, phase: 'submitting' });
          return { result: true, changed: true };
        }),
      );
    },
    record(raw, phase) {
      const record = parseMcpSourceApprovalRecord({ ...raw, phase });
      finite(() =>
        mutate((rows) => {
          const old = rows.find(
            (row) => row.intent.request.commandId === record.intent.request.commandId,
          );
          if (
            !old ||
            mcpSourceApprovalRecordIdentity(old) !== mcpSourceApprovalRecordIdentity(record)
          )
            throw unavailable();
          if (old.phase === phase) return { result: undefined, changed: false };
          if (['saved', 'failed', 'cancelled'].includes(old.phase)) throw unavailable();
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
