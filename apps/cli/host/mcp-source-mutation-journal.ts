import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FileLock, ProfileAccess } from '@kite-ai/agent/profile-access';
import { parseMcpSourceApprovalRecord } from './mcp-source-approval-intents';
import { assertMcpSourceJournalAvailable, readMcpSourceJournal } from './mcp-source-journal-files';
import {
  type McpSourceMutationRecord,
  mcpSourceMutationRecordIdentity,
  parseMcpSourceMutationRecord,
} from './mcp-source-mutation-intents';
export interface McpSourceMutationJournal {
  prepare(record: McpSourceMutationRecord): boolean;
  record(record: McpSourceMutationRecord, phase: McpSourceMutationRecord['phase']): void;
  list(): McpSourceMutationRecord[];
  close(): void;
}
const unavailable = () => Error('mcp_source_mutation_journal_unavailable');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
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
function finite<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'mcp_source_mutation_intent_limit',
        'mcp_source_mutation_capacity_exceeded',
        'mcp_source_mutation_intent_conflict',
        'mcp_source_mutation_journal_unavailable',
        'mcp_source_mutation_original_outcome_required',
      ].includes(error.message)
    )
      throw error;
    throw unavailable();
  }
}
/** Caller metadata only; held public profile-use lease and data lock protect publication. */
export function openMcpSourceMutationJournal(input: {
  access: ProfileAccess;
  acquireWriteLock: () => FileLock;
}): McpSourceMutationJournal {
  const parent = join(input.access.profilePath, 'ui'),
    path = join(parent, 'mcp-source-mutation-intents.json');
  let closed = false;
  const read = () => {
    if (closed) throw unavailable();
    return readMcpSourceJournal(
      input.access,
      'mcp-source-mutation-intents.json',
      parseMcpSourceMutationRecord,
      unavailable,
    );
  };
  const mutate = <T>(
    change: (rows: McpSourceMutationRecord[]) => { result: T; changed: boolean },
  ) => {
    const lock = input.acquireWriteLock();
    let temporary: string | undefined;
    try {
      const original = read(),
        rows = structuredClone(original.records),
        next = change(rows);
      if (!next.changed) return next.result;
      const bytes = Buffer.from(`${JSON.stringify({ version: 1, records: rows })}\n`);
      if (bytes.length > 16 * 1024 * 1024) throw Error('mcp_source_mutation_capacity_exceeded');
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      privateStat(parent, true);
      temporary = join(parent, `.mcp-source-mutation-intents-${randomUUID()}.tmp`);
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
      const record = parseMcpSourceMutationRecord(raw);
      return finite(() =>
        mutate((rows) => {
          const old = rows.find(
            (row) => row.intent.request.commandId === record.intent.request.commandId,
          );
          if (old) {
            if (mcpSourceMutationRecordIdentity(old) !== mcpSourceMutationRecordIdentity(record))
              throw Error('mcp_source_mutation_intent_conflict');
            return { result: false, changed: false };
          }
          if (rows.length >= 128) throw Error('mcp_source_mutation_intent_limit');
          assertMcpSourceJournalAvailable(rows, record, () =>
            Error('mcp_source_mutation_original_outcome_required'),
          );
          assertMcpSourceJournalAvailable(
            readMcpSourceJournal(
              input.access,
              'mcp-source-approval-intents.json',
              parseMcpSourceApprovalRecord,
              unavailable,
            ).records,
            record,
            () => Error('mcp_source_mutation_original_outcome_required'),
          );
          rows.push({ ...record, phase: 'submitting' });
          return { result: true, changed: true };
        }),
      );
    },
    record(raw, phase) {
      const record = parseMcpSourceMutationRecord({ ...raw, phase });
      finite(() =>
        mutate((rows) => {
          const old = rows.find(
            (row) => row.intent.request.commandId === record.intent.request.commandId,
          );
          if (
            !old ||
            mcpSourceMutationRecordIdentity(old) !== mcpSourceMutationRecordIdentity(record)
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
