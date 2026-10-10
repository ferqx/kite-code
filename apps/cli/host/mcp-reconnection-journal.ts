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
import {
  assertProfileAccess,
  type FileLock,
  type ProfileAccess,
} from '@kite-ai/agent/profile-access';
import { parseMcpConnectionRecord } from './mcp-connection-intents';
import {
  type McpReconnectionRecord,
  mcpReconnectionRecordIdentity,
  parseMcpReconnectionRecord,
} from './mcp-reconnection-intents';
import {
  assertMcpTransportJournalAvailable,
  readMcpTransportJournal,
} from './mcp-transport-journal-files';
import { publishWindowsTuiPrivateFile } from './windows-tui-private-files';

export interface McpReconnectionJournal {
  prepare(record: McpReconnectionRecord): boolean;
  record(record: McpReconnectionRecord, phase: McpReconnectionRecord['phase']): void;
  list(): McpReconnectionRecord[];
  close(): void;
}
const unavailable = () => Error('mcp_reconnection_journal_unavailable');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function finite<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (
      error instanceof Error &&
      [
        'mcp_reconnection_intent_limit',
        'mcp_reconnection_capacity_exceeded',
        'mcp_reconnection_intent_conflict',
        'mcp_reconnection_journal_unavailable',
        'mcp_reconnection_original_outcome_required',
      ].includes(error.message)
    )
      throw error;
    if (process.platform === 'win32') throw new Error(unavailable().message, { cause: error });
    throw unavailable();
  }
}
/** Caller metadata only. The same profile data lock protects both connection assets. */
export function openMcpReconnectionJournal(input: {
  access: ProfileAccess;
  acquireWriteLock: () => FileLock;
}): McpReconnectionJournal {
  const parent = join(input.access.profilePath, 'ui'),
    path = join(parent, 'mcp-reconnection-intents.json');
  let closed = false;
  const read = () => {
    if (closed) throw unavailable();
    return readMcpTransportJournal(
      input.access,
      'mcp-reconnection-intents.json',
      parseMcpReconnectionRecord,
      unavailable,
    );
  };
  const privateDirectory = () => {
    const stat = lstatSync(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      throw unavailable();
  };
  const mutate = <T>(
    change: (rows: McpReconnectionRecord[]) => { result: T; changed: boolean },
  ) => {
    const lock = input.acquireWriteLock();
    let temporary: string | undefined;
    let failure: unknown;
    const releaseWindowsLock = () => {
      try {
        lock.release();
      } catch (cleanupError) {
        if (failure !== undefined)
          throw new Error(
            failure instanceof Error ? failure.message : 'tui_private_publication_unknown',
            {
              cause: new AggregateError([failure, cleanupError], 'tui_private_cleanup_unknown'),
            },
          );
        throw cleanupError;
      }
    };
    try {
      const original = read(),
        rows = structuredClone(original.records),
        next = change(rows);
      if (!next.changed) return next.result;
      const bytes = Buffer.from(`${JSON.stringify({ version: 1, records: rows })}\n`);
      if (bytes.length > 16 * 1024 * 1024) throw Error('mcp_reconnection_capacity_exceeded');
      if (process.platform === 'win32') {
        publishWindowsTuiPrivateFile({
          access: input.access,
          filename: 'mcp-reconnection-intents.json',
          bytes,
          writeLock: lock,
          expectedEtag: original.etag,
          recheck: () => {
            if (read().etag !== original.etag) throw unavailable();
          },
        });
        if (read().etag !== hash(bytes)) throw unavailable();
        return next.result;
      }
      assertProfileAccess(input.access);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      privateDirectory();
      temporary = join(parent, `.mcp-reconnection-intents-${randomUUID()}.tmp`);
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
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (process.platform === 'win32') releaseWindowsLock();
      else {
        try {
          if (temporary) rmSync(temporary, { force: true });
        } finally {
          lock.release();
        }
      }
    }
  };
  return {
    prepare(raw) {
      const record = parseMcpReconnectionRecord(raw);
      return finite(() =>
        mutate((rows) => {
          const old = rows.find(
            (row) => row.intent.request.commandId === record.intent.request.commandId,
          );
          if (old) {
            if (mcpReconnectionRecordIdentity(old) !== mcpReconnectionRecordIdentity(record))
              throw Error('mcp_reconnection_intent_conflict');
            return { result: false, changed: false };
          }
          if (rows.length >= 128) throw Error('mcp_reconnection_intent_limit');
          assertMcpTransportJournalAvailable(rows, record, () =>
            Error('mcp_reconnection_original_outcome_required'),
          );
          assertMcpTransportJournalAvailable(
            readMcpTransportJournal(
              input.access,
              'mcp-connection-intents.json',
              parseMcpConnectionRecord,
              unavailable,
            ).records,
            record,
            () => Error('mcp_reconnection_original_outcome_required'),
          );
          rows.push({ ...record, phase: 'submitting' });
          return { result: true, changed: true };
        }),
      );
    },
    record(raw, phase) {
      const record = parseMcpReconnectionRecord({ ...raw, phase });
      finite(() =>
        mutate((rows) => {
          const old = rows.find(
            (row) => row.intent.request.commandId === record.intent.request.commandId,
          );
          if (!old || mcpReconnectionRecordIdentity(old) !== mcpReconnectionRecordIdentity(record))
            throw unavailable();
          if (old.phase === phase) return { result: undefined, changed: false };
          if (['ready', 'failed', 'cancelled'].includes(old.phase)) throw unavailable();
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
