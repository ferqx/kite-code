import type { Database } from 'bun:sqlite';
import type { SqliteRuntimeWorkspaceBinding } from './preflight';

/** The only durable Worker-to-Coordinator Session Directory fact stream. */
export const SQLITE_SESSION_DIRECTORY_OUTBOX_TABLE_ = 'session_directory_outbox' as const;
export const SQLITE_SESSION_DIRECTORY_OUTBOX_MAX_PAGE_SIZE = 200 as const;

export interface SqliteWorkspaceDirectoryOutboxEntry {
  readonly sessionId: string;
  readonly workerScopeId: string;
  readonly revision: number;
  readonly updatedAt: number;
  readonly tombstone: boolean;
}

export interface SqliteWorkspaceDirectoryOutboxPage {
  readonly entries: readonly SqliteWorkspaceDirectoryOutboxEntry[];
  /** SQLite's private rowid is an opaque resume cursor, never a directory fact. */
  readonly nextCursor?: number;
  readonly hasMore: boolean;
}

export interface SqliteWorkspaceDirectoryOutbox {
  /** Must be called inside the caller's existing Store transaction. */
  append(entry: SqliteWorkspaceDirectoryOutboxEntry): void;
  list(input?: {
    readonly cursor?: number;
    readonly limit?: number;
  }): SqliteWorkspaceDirectoryOutboxPage;
}

/**
 * Bind a read/write outbox facade to the already-open Store 7 connection. This module never opens
 * SQLite and never exposes Runtime State, titles, paths, or controller/effect facts.
 */
export function createSqliteWorkspaceDirectoryOutbox(input: {
  readonly db: Database;
  readonly binding: SqliteRuntimeWorkspaceBinding;
}): SqliteWorkspaceDirectoryOutbox {
  const insert = input.db.query(
    `INSERT OR IGNORE INTO ${SQLITE_SESSION_DIRECTORY_OUTBOX_TABLE_}
       (session_id, worker_scope_id, revision, updated_at, tombstone)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const select = input.db.query<DirectoryOutboxRow, [string, number, number]>(
    `SELECT rowid AS outbox_id, session_id, worker_scope_id, revision, updated_at, tombstone
       FROM ${SQLITE_SESSION_DIRECTORY_OUTBOX_TABLE_}
      WHERE worker_scope_id = ? AND rowid > ?
      ORDER BY rowid ASC
      LIMIT ?`,
  );

  return Object.freeze({
    append(entry: SqliteWorkspaceDirectoryOutboxEntry): void {
      assertEntry(entry, input.binding.workerScopeId);
      insert.run(
        entry.sessionId,
        entry.workerScopeId,
        entry.revision,
        entry.updatedAt,
        entry.tombstone ? 1 : 0,
      );
    },

    list(request: { readonly cursor?: number; readonly limit?: number } = {}) {
      const cursor = request.cursor ?? 0;
      assertCursor(cursor);
      const limit = request.limit ?? SQLITE_SESSION_DIRECTORY_OUTBOX_MAX_PAGE_SIZE;
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > SQLITE_SESSION_DIRECTORY_OUTBOX_MAX_PAGE_SIZE
      ) {
        throw new RangeError('Workspace Directory outbox page limit is invalid.');
      }
      const rows = select.all(input.binding.workerScopeId, cursor, limit + 1);
      const hasMore = rows.length > limit;
      const selected = hasMore ? rows.slice(0, limit) : rows;
      const entries = selected.map((row) => decodeRow(row, input.binding.workerScopeId));
      const last = selected.at(-1);
      const nextCursor = last?.outbox_id;
      if (nextCursor !== undefined && nextCursor <= cursor) {
        throw new Error('Workspace Directory outbox cursor did not advance.');
      }
      return Object.freeze({
        entries: Object.freeze(entries),
        ...(nextCursor === undefined ? {} : { nextCursor }),
        hasMore,
      });
    },
  });
}

interface DirectoryOutboxRow {
  readonly outbox_id: number;
  readonly session_id: string;
  readonly worker_scope_id: string;
  readonly revision: number;
  readonly updated_at: number;
  readonly tombstone: number;
}

function decodeRow(
  row: DirectoryOutboxRow,
  workerScopeId: string,
): SqliteWorkspaceDirectoryOutboxEntry {
  if (
    !Number.isSafeInteger(row.outbox_id) ||
    row.outbox_id < 1 ||
    row.worker_scope_id !== workerScopeId ||
    (row.tombstone !== 0 && row.tombstone !== 1)
  ) {
    throw new Error('Workspace Directory outbox row is invalid.');
  }
  assertEntry(
    {
      sessionId: row.session_id,
      workerScopeId: row.worker_scope_id,
      revision: row.revision,
      updatedAt: row.updated_at,
      tombstone: row.tombstone === 1,
    },
    workerScopeId,
  );
  return Object.freeze({
    sessionId: row.session_id,
    workerScopeId: row.worker_scope_id,
    revision: row.revision,
    updatedAt: row.updated_at,
    tombstone: row.tombstone === 1,
  });
}

function assertEntry(entry: SqliteWorkspaceDirectoryOutboxEntry, workerScopeId: string): void {
  if (
    !safeText(entry.sessionId) ||
    entry.workerScopeId !== workerScopeId ||
    !safeText(entry.workerScopeId) ||
    !Number.isSafeInteger(entry.revision) ||
    entry.revision < 0 ||
    !Number.isSafeInteger(entry.updatedAt) ||
    entry.updatedAt < 0 ||
    typeof entry.tombstone !== 'boolean'
  ) {
    throw new TypeError('Workspace Directory outbox entry is invalid.');
  }
}

function assertCursor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('Workspace Directory outbox cursor is invalid.');
  }
}

function safeText(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}
