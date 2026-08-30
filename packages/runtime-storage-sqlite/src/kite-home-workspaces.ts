import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { RuntimeSessionModelRoute } from '@kite-ai/runtime-host/storage';
import { assertKiteHomeStoreSchema } from './kite-home-store';
import { KiteHomeWriteError, type KiteHomeWriteTransactionPort } from './kite-home-write';
import type { SqliteRuntimeSnapshotCodec } from './preflight';

export type KiteHomeWorkspaceStoreErrorCode =
  | 'invalid_workspace'
  | 'workspace_conflict'
  | 'workspace_not_admitted'
  | 'invalid_session'
  | 'session_conflict'
  | 'session_tombstoned';

export class KiteHomeWorkspaceStoreError extends Error {
  readonly code: KiteHomeWorkspaceStoreErrorCode;

  constructor(code: KiteHomeWorkspaceStoreErrorCode, message: string) {
    super(message);
    this.name = 'KiteHomeWorkspaceStoreError';
    this.code = code;
  }
}

export interface KiteHomeWorkspaceAdmission {
  readonly workspaceId: string;
  readonly canonicalPath: string;
  readonly workspaceIdentityDigest: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
  readonly displayName: string;
}

export type KiteHomeWorkspaceAdmissionResult =
  | {
      readonly status: 'admitted';
      readonly workspace: KiteHomeWorkspaceAdmission;
    }
  | {
      readonly status: 'existing';
      readonly workspace: KiteHomeWorkspaceAdmission;
    };

export interface KiteHomeWorkspaceAdmissionPort {
  admit(workspace: KiteHomeWorkspaceAdmission): KiteHomeWorkspaceAdmissionResult;
  get(workspaceId: string): KiteHomeWorkspaceAdmission | null;
}

export interface KiteHomeSessionBinding {
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly workspaceDigest: string;
  readonly revision: number;
}

export interface KiteHomeWorkspaceSessionStore<State> {
  ensure(sessionId: string, state: State): void;
  /** Same-connection primitive. The caller must already own the Store writer transaction. */
  ensureInTransaction(sessionId: string, state?: State): void;
  binding(sessionId: string): KiteHomeSessionBinding | null;
  has(sessionId: string): boolean;
  list(limit?: number): readonly {
    readonly threadId: string;
    readonly name: string;
    readonly updatedAt: number;
  }[];
  setName(sessionId: string, name: string): void;
  getModelRoute(sessionId: string): RuntimeSessionModelRoute | null;
  /** Same-connection primitive. The caller must already own the Store writer transaction. */
  setModelRouteInTransaction(sessionId: string, route: RuntimeSessionModelRoute): void;
  setModelRoute(sessionId: string, route: RuntimeSessionModelRoute): void;
  /** Same-connection primitive. The caller must already own the Store writer transaction. */
  deleteInTransaction(sessionId: string, expectedRevision?: number): boolean;
  delete(sessionId: string, expectedRevision?: number): boolean;
}

interface WorkspaceRow {
  readonly workspace_id: string;
  readonly canonical_path: string;
  readonly workspace_identity_digest: string;
  readonly project_id: string;
  readonly workspace_digest: string;
  readonly display_name: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SessionRow {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly workspace_digest: string;
  readonly state_schema: number;
  readonly format_epoch: string;
  readonly revision: number;
  readonly name: string;
  readonly model_provider: string | null;
  readonly model_name: string | null;
  readonly updated_at: number;
}

const WORKSPACE_ID_PATTERN = /^workspace_[a-f0-9]{64}$/u;
const PROJECT_ID_PATTERN = /^project_[a-f0-9]{64}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_TEXT_LENGTH = 512;

/**
 * Admit canonical Workspaces into Store 9. Identity is immutable; only the safe display label may
 * change. Exact replay is read-only and therefore does not cross the first-write rollback cutoff.
 */
export function createKiteHomeWorkspaceAdmissionPort(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly now?: () => number;
}): KiteHomeWorkspaceAdmissionPort {
  assertKiteHomeStoreSchema(input.database);
  const now = input.now ?? Date.now;
  const selectById = input.database.query<WorkspaceRow, [string]>(
    'SELECT * FROM workspaces WHERE workspace_id = ? LIMIT 1',
  );
  const selectCollision = input.database.query<WorkspaceRow, [string, string]>(
    `SELECT * FROM workspaces
      WHERE canonical_path = ? OR workspace_identity_digest = ?
      LIMIT 1`,
  );
  const insert = input.database.query(
    `INSERT INTO workspaces(
      workspace_id, canonical_path, workspace_identity_digest, project_id,
      workspace_digest, display_name, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateDisplayName = input.database.query(
    'UPDATE workspaces SET display_name = ?, updated_at = ? WHERE workspace_id = ?',
  );

  const get = (workspaceId: string): KiteHomeWorkspaceAdmission | null => {
    assertWorkspaceId(workspaceId);
    const row = selectById.get(workspaceId);
    if (!row) return null;
    const workspace = workspaceFromRow(row);
    assertWorkspace(workspace);
    return workspace;
  };

  return Object.freeze({
    get,
    admit(workspace: KiteHomeWorkspaceAdmission): KiteHomeWorkspaceAdmissionResult {
      assertWorkspace(workspace);
      const existing = selectById.get(workspace.workspaceId);
      if (existing) {
        assertSameWorkspaceIdentity(existing, workspace);
        if (existing.display_name === workspace.displayName) {
          return Object.freeze({
            status: 'existing',
            workspace: workspaceFromRow(existing),
          });
        }
        const updatedAt = monotonicTime(now(), existing.updated_at);
        input.writer.run(() => {
          const current = selectById.get(workspace.workspaceId);
          if (!current) conflict('Workspace disappeared during admission.');
          assertSameWorkspaceIdentity(current, workspace);
          updateDisplayName.run(workspace.displayName, updatedAt, workspace.workspaceId);
        });
        return Object.freeze({
          status: 'existing',
          workspace: Object.freeze({ ...workspace }),
        });
      }
      const collision = selectCollision.get(
        workspace.canonicalPath,
        workspace.workspaceIdentityDigest,
      );
      if (collision) conflict('Workspace path or identity digest is already admitted.');
      const createdAt = monotonicTime(now());
      input.writer.run(() => {
        if (
          selectById.get(workspace.workspaceId) ||
          selectCollision.get(workspace.canonicalPath, workspace.workspaceIdentityDigest)
        ) {
          conflict('Workspace identity changed during admission.');
        }
        insert.run(
          workspace.workspaceId,
          workspace.canonicalPath,
          workspace.workspaceIdentityDigest,
          workspace.projectId,
          workspace.workspaceDigest,
          workspace.displayName,
          createdAt,
          createdAt,
        );
      });
      return Object.freeze({
        status: 'admitted',
        workspace: Object.freeze({ ...workspace }),
      });
    },
  });
}

/** Store 9 Session metadata bound to one admitted Workspace. */
export function createKiteHomeWorkspaceSessionStore<State>(input: {
  readonly database: Database;
  readonly writer: KiteHomeWriteTransactionPort;
  readonly workspace: KiteHomeWorkspaceAdmission;
  readonly codec: SqliteRuntimeSnapshotCodec<unknown, State>;
  readonly stateSchemaVersion: number;
  /** Runtime State format, deliberately distinct from the Store 9 physical format epoch. */
  readonly formatEpoch: string;
  readonly now?: () => number;
}): KiteHomeWorkspaceSessionStore<State> {
  assertKiteHomeStoreSchema(input.database);
  assertWorkspace(input.workspace);
  if (!Number.isSafeInteger(input.stateSchemaVersion) || input.stateSchemaVersion < 1) {
    throw new TypeError('Kite Home State schema version is invalid.');
  }
  const formatEpoch = input.formatEpoch;
  assertSafeText(formatEpoch, 'Runtime format epoch');
  const now = input.now ?? Date.now;
  const selectWorkspace = input.database.query<WorkspaceRow, [string]>(
    'SELECT * FROM workspaces WHERE workspace_id = ? LIMIT 1',
  );
  const selectSession = input.database.query<SessionRow, [string]>(
    'SELECT * FROM runtime_sessions WHERE session_id = ? LIMIT 1',
  );
  const selectTombstone = input.database.query<
    { session_id: string; workspace_id: string },
    [string]
  >('SELECT session_id, workspace_id FROM runtime_session_tombstones WHERE session_id = ? LIMIT 1');
  const insertSession = input.database.query(
    `INSERT INTO runtime_sessions(
      session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
      revision, updated_at, run_index_from_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  );
  const updateRevision = input.database.query(
    'UPDATE runtime_sessions SET revision = ?, updated_at = ? WHERE session_id = ? AND workspace_id = ?',
  );
  const listSessions = input.database.query<
    { thread_id: string; name: string; updated_at: number },
    [string, number]
  >(
    `SELECT session_id AS thread_id, name, updated_at
       FROM runtime_sessions
      WHERE workspace_id = ?
      ORDER BY updated_at DESC, session_id ASC
      LIMIT ?`,
  );
  const updateName = input.database.query(
    'UPDATE runtime_sessions SET name = ?, updated_at = ? WHERE session_id = ? AND workspace_id = ?',
  );
  const updateModelRoute = input.database.query(
    `UPDATE runtime_sessions
        SET model_provider = ?, model_name = ?, updated_at = ?
      WHERE session_id = ? AND workspace_id = ?`,
  );
  const insertTombstone = input.database.query(
    `INSERT INTO runtime_session_tombstones(
      session_id, workspace_id, project_id, workspace_digest, deleted_revision, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deleteSession = input.database.query(
    'DELETE FROM runtime_sessions WHERE session_id = ? AND workspace_id = ?',
  );

  const assertAdmittedWorkspace = (): WorkspaceRow => {
    const row = selectWorkspace.get(input.workspace.workspaceId);
    if (!row) {
      throw new KiteHomeWorkspaceStoreError(
        'workspace_not_admitted',
        'Runtime Workspace is not admitted to the Kite Home Store.',
      );
    }
    assertSameWorkspaceIdentity(row, input.workspace);
    return row;
  };

  const scopedSession = (sessionId: string): SessionRow | null => {
    assertSessionId(sessionId);
    const row = selectSession.get(sessionId);
    if (row && row.workspace_id !== input.workspace.workspaceId) {
      throw new KiteHomeWorkspaceStoreError(
        'session_conflict',
        'Runtime Session belongs to a different Workspace.',
      );
    }
    return row;
  };

  const ensureInTransaction = (sessionId: string, state?: State): void => {
    assertWriterTransaction(input.writer);
    assertSessionId(sessionId);
    const workspace = assertAdmittedWorkspace();
    if (selectTombstone.get(sessionId)) {
      throw new KiteHomeWorkspaceStoreError(
        'session_tombstoned',
        'A deleted Runtime Session identity cannot be reused.',
      );
    }
    const existing = scopedSession(sessionId);
    if (state === undefined) {
      if (existing) return;
      throw new KiteHomeWorkspaceStoreError(
        'invalid_session',
        'New Runtime Session State has no project/workspace identity.',
      );
    }
    const identity = input.codec.sessionIdentity?.(state);
    if (!identity) {
      throw new KiteHomeWorkspaceStoreError(
        'invalid_session',
        'New Runtime Session State has no project/workspace identity.',
      );
    }
    if (
      identity.projectId !== workspace.project_id ||
      identity.canonicalWorkspaceDigest !== workspace.workspace_digest
    ) {
      throw new KiteHomeWorkspaceStoreError(
        'session_conflict',
        'Runtime Session State does not match its admitted Workspace.',
      );
    }
    const metadata = input.codec.snapshotMetadata(state);
    if (
      metadata.schemaVersion !== input.stateSchemaVersion ||
      !Number.isSafeInteger(metadata.stateRevision) ||
      metadata.stateRevision < 0
    ) {
      throw new KiteHomeWorkspaceStoreError(
        'invalid_session',
        'Runtime Session State metadata is incompatible.',
      );
    }
    if (existing) {
      if (
        existing.project_id !== workspace.project_id ||
        existing.workspace_digest !== workspace.workspace_digest ||
        existing.state_schema !== input.stateSchemaVersion ||
        existing.format_epoch !== formatEpoch
      ) {
        throw new KiteHomeWorkspaceStoreError(
          'session_conflict',
          'Runtime Session metadata does not match its admitted Workspace.',
        );
      }
      updateRevision.run(
        metadata.stateRevision,
        monotonicTime(now(), existing.updated_at),
        sessionId,
        input.workspace.workspaceId,
      );
      return;
    }
    insertSession.run(
      sessionId,
      input.workspace.workspaceId,
      workspace.project_id,
      workspace.workspace_digest,
      input.stateSchemaVersion,
      formatEpoch,
      metadata.stateRevision,
      monotonicTime(now()),
    );
  };

  const deleteInTransaction = (sessionId: string, expectedRevision?: number): boolean => {
    assertWriterTransaction(input.writer);
    const existing = scopedSession(sessionId);
    if (!existing) return false;
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0 ||
        expectedRevision !== existing.revision)
    ) {
      throw new KiteHomeWorkspaceStoreError(
        'session_conflict',
        'Runtime Session deletion revision does not match.',
      );
    }
    insertTombstone.run(
      sessionId,
      existing.workspace_id,
      existing.project_id,
      existing.workspace_digest,
      existing.revision,
      Math.floor(monotonicTime(now()) / 1000),
    );
    deleteSession.run(sessionId, input.workspace.workspaceId);
    return true;
  };

  const setModelRouteInTransaction = (sessionId: string, route: RuntimeSessionModelRoute): void => {
    assertWriterTransaction(input.writer);
    const provider = route.provider.trim();
    const name = route.name.trim();
    assertSafeText(provider, 'Runtime model provider');
    assertSafeText(name, 'Runtime model name');
    const existing = scopedSession(sessionId);
    if (!existing) invalidSession('Runtime Session is not admitted.');
    updateModelRoute.run(
      provider,
      name,
      monotonicTime(now(), existing.updated_at),
      sessionId,
      input.workspace.workspaceId,
    );
  };

  return Object.freeze({
    ensure(sessionId: string, state: State): void {
      input.writer.run(() => ensureInTransaction(sessionId, state));
    },
    ensureInTransaction,
    binding(sessionId: string): KiteHomeSessionBinding | null {
      const row = scopedSession(sessionId);
      return row
        ? Object.freeze({
            sessionId: row.session_id,
            workspaceId: row.workspace_id,
            projectId: row.project_id,
            workspaceDigest: row.workspace_digest,
            revision: row.revision,
          })
        : null;
    },
    has: (sessionId: string) => scopedSession(sessionId) !== null,
    list(limit = 50) {
      assertLimit(limit);
      assertAdmittedWorkspace();
      return Object.freeze(
        listSessions.all(input.workspace.workspaceId, limit).map((row) =>
          Object.freeze({
            threadId: row.thread_id,
            name: row.name,
            updatedAt: row.updated_at,
          }),
        ),
      );
    },
    setName(sessionId: string, name: string): void {
      assertSafeText(name, 'Runtime Session name', true);
      const existing = scopedSession(sessionId);
      if (!existing) invalidSession('Runtime Session is not admitted.');
      const updatedAt = monotonicTime(now(), existing.updated_at);
      input.writer.run(() => {
        const current = scopedSession(sessionId);
        if (!current) invalidSession('Runtime Session disappeared before its name update.');
        updateName.run(name, updatedAt, sessionId, input.workspace.workspaceId);
      });
    },
    getModelRoute(sessionId: string): RuntimeSessionModelRoute | null {
      const row = scopedSession(sessionId);
      return row?.model_provider && row.model_name
        ? Object.freeze({ provider: row.model_provider, name: row.model_name })
        : null;
    },
    setModelRouteInTransaction,
    setModelRoute: (sessionId: string, route: RuntimeSessionModelRoute) =>
      input.writer.run(() => setModelRouteInTransaction(sessionId, route)),
    deleteInTransaction,
    delete: (sessionId: string, expectedRevision?: number) =>
      input.writer.run(() => deleteInTransaction(sessionId, expectedRevision)),
  });
}

function workspaceFromRow(row: WorkspaceRow): KiteHomeWorkspaceAdmission {
  return Object.freeze({
    workspaceId: row.workspace_id,
    canonicalPath: row.canonical_path,
    workspaceIdentityDigest: row.workspace_identity_digest,
    projectId: row.project_id,
    workspaceDigest: row.workspace_digest,
    displayName: row.display_name,
  });
}

function assertWorkspace(workspace: KiteHomeWorkspaceAdmission): void {
  assertWorkspaceId(workspace.workspaceId);
  if (!isAbsolute(workspace.canonicalPath) || !safeText(workspace.canonicalPath)) {
    invalidWorkspace('Workspace canonical path is invalid.');
  }
  if (!SHA256_PATTERN.test(workspace.workspaceIdentityDigest)) {
    invalidWorkspace('Workspace identity digest is invalid.');
  }
  const pathHex = createHash('sha256').update(workspace.canonicalPath).digest('hex');
  if (
    workspace.workspaceDigest !== `sha256:${pathHex}` ||
    workspace.projectId !== `project_${pathHex}`
  ) {
    invalidWorkspace('Workspace project identity does not match its canonical path.');
  }
  const material = JSON.stringify({
    canonicalPath: workspace.canonicalPath,
    projectId: workspace.projectId,
    workspaceDigest: workspace.workspaceDigest,
  });
  const expectedIdentity = `sha256:${createHash('sha256')
    .update(`kite.workspace-identity.v1\0${material}`)
    .digest('hex')}`;
  if (workspace.workspaceIdentityDigest !== expectedIdentity) {
    invalidWorkspace('Workspace identity digest does not match its canonical identity.');
  }
  const identityHex = workspace.workspaceIdentityDigest.slice('sha256:'.length);
  if (workspace.workspaceId !== `workspace_${identityHex}`) {
    invalidWorkspace('Workspace id does not match its identity digest.');
  }
  if (
    !PROJECT_ID_PATTERN.test(workspace.projectId) ||
    !SHA256_PATTERN.test(workspace.workspaceDigest)
  ) {
    invalidWorkspace('Workspace project identity is invalid.');
  }
  if (!safeText(workspace.displayName, true)) {
    invalidWorkspace('Workspace display name is invalid.');
  }
}

function assertSameWorkspaceIdentity(
  row: WorkspaceRow,
  workspace: KiteHomeWorkspaceAdmission,
): void {
  if (
    row.workspace_id !== workspace.workspaceId ||
    row.canonical_path !== workspace.canonicalPath ||
    row.workspace_identity_digest !== workspace.workspaceIdentityDigest ||
    row.project_id !== workspace.projectId ||
    row.workspace_digest !== workspace.workspaceDigest
  ) {
    conflict('Workspace admission conflicts with an existing identity.');
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) invalidWorkspace('Workspace id is invalid.');
}

function assertSessionId(sessionId: string): void {
  if (!safeText(sessionId)) invalidSession('Runtime Session id is invalid.');
}

function assertSafeText(value: string, label: string, allowEmpty = false): void {
  if (!safeText(value, allowEmpty)) throw new TypeError(`${label} is invalid.`);
}

function safeText(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === 'string' &&
    (allowEmpty || value.length > 0) &&
    value.length <= MAX_TEXT_LENGTH &&
    !value.includes('\0') &&
    !/\p{Cc}/u.test(value)
  );
}

function monotonicTime(value: number, previous = -1): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Store clock is invalid.');
  return Math.max(value, previous + 1);
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
    throw new RangeError('Session list limit must be between 1 and 256.');
  }
}

function assertWriterTransaction(writer: KiteHomeWriteTransactionPort): void {
  if (!writer.inTransaction) {
    throw new KiteHomeWriteError(
      'transaction_required',
      'Runtime Session mutation requires the single Store writer transaction.',
    );
  }
}

function invalidWorkspace(message: string): never {
  throw new KiteHomeWorkspaceStoreError('invalid_workspace', message);
}

function invalidSession(message: string): never {
  throw new KiteHomeWorkspaceStoreError('invalid_session', message);
}

function conflict(message: string): never {
  throw new KiteHomeWorkspaceStoreError('workspace_conflict', message);
}
