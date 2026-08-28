import type { Database } from 'bun:sqlite';
import type {
  RuntimeCommandReceiptLookup,
  RuntimeCommandReceiptLookupInput,
  RuntimeCommandReceiptPort,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import {
  SqliteRuntimeCommandReceiptValidationError,
  type SqliteRuntimeSessionBinding,
  type SqliteRuntimeWorkspaceBinding,
} from './preflight';

function assertReceiptText(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0')
  ) {
    throw new SqliteRuntimeCommandReceiptValidationError(
      `Runtime command receipt ${field} is invalid.`,
    );
  }
}

export function assertSqliteRuntimeCommandReceipt(
  receipt: RuntimeStoredCommandReceipt,
  transactionSessionId?: string,
  committedRevision?: number,
): void {
  assertReceiptText(receipt.scopeSessionId, 'scope session identity');
  assertReceiptText(receipt.commandId, 'command identity');
  assertReceiptText(receipt.targetSessionId, 'target session identity');
  if (
    !/^[a-f0-9]{64}$/u.test(receipt.requestDigest) ||
    !Number.isSafeInteger(receipt.committedRevision) ||
    receipt.committedRevision < 0 ||
    !Number.isSafeInteger(receipt.committedAt) ||
    receipt.committedAt < 0
  ) {
    throw new SqliteRuntimeCommandReceiptValidationError('Runtime command receipt is invalid.');
  }
  if (
    (transactionSessionId !== undefined && receipt.targetSessionId !== transactionSessionId) ||
    (committedRevision !== undefined && receipt.committedRevision !== committedRevision)
  ) {
    throw new SqliteRuntimeCommandReceiptValidationError(
      'Runtime command receipt does not bind the committed State decision.',
    );
  }
  const canonicalOriginal = JSON.stringify({
    status: 'applied',
    commandId: receipt.commandId,
    sessionId: receipt.targetSessionId,
    revision: receipt.committedRevision,
  });
  if (receipt.originalReceiptJson !== canonicalOriginal) {
    throw new SqliteRuntimeCommandReceiptValidationError(
      'Runtime command receipt original applied receipt is not canonical.',
    );
  }
}

export function isSqliteRuntimeCommandReceiptConstraint(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(
      'UNIQUE constraint failed: runtime_command_receipts.scope_session_id, runtime_command_receipts.command_id',
    ) ||
    (message.includes('PRIMARY KEY') && message.includes('runtime_command_receipts'))
  );
}

export interface SqliteRuntimeCommandReceiptWriter {
  insert(
    receipt: RuntimeStoredCommandReceipt,
    transactionSessionId: string,
    committedRevision: number,
    sessionBinding?: SqliteRuntimeSessionBinding,
  ): void;
}

/** One strict receipt writer shared by Store 6 and the bound Store 7 target. */
export function createSqliteRuntimeCommandReceiptWriter(
  input:
    | {
        readonly db: Database;
        readonly workspaceBinding?: SqliteRuntimeWorkspaceBinding;
        readonly beforeWrite?: () => void;
      }
    | Database,
): SqliteRuntimeCommandReceiptWriter {
  const configured = typeof input === 'object' && input !== null && 'db' in input;
  const db = configured ? input.db : input;
  const workspaceBinding = configured ? input.workspaceBinding : undefined;
  const beforeWrite = configured ? input.beforeWrite : undefined;
  const selectSessionBinding = workspaceBinding
    ? db.query<SqliteRuntimeSessionBinding, [string]>(
        'SELECT worker_scope_id AS workerScopeId, project_id AS projectId, workspace_digest AS workspaceDigest FROM runtime_sessions WHERE session_id = ? LIMIT 1',
      )
    : undefined;
  const insert = workspaceBinding
    ? db.query(
        `INSERT INTO runtime_command_receipts (
          scope_session_id, command_id, worker_scope_id, project_id, workspace_digest,
          request_digest, target_session_id, original_receipt_json, committed_revision, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
    : db.query(
        `INSERT INTO runtime_command_receipts (
          scope_session_id, command_id, request_digest, target_session_id,
          original_receipt_json, committed_revision, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
  return Object.freeze({
    insert(
      receipt: RuntimeStoredCommandReceipt,
      transactionSessionId: string,
      committedRevision: number,
      sessionBinding?: SqliteRuntimeSessionBinding,
    ): void {
      assertSqliteRuntimeCommandReceipt(receipt, transactionSessionId, committedRevision);
      if (workspaceBinding) {
        const owner = sessionBinding ?? selectSessionBinding?.get(receipt.targetSessionId);
        if (!owner || !matchesWorkspaceBinding(owner, workspaceBinding)) {
          throw new SqliteRuntimeCommandReceiptValidationError(
            'Runtime command receipt Workspace binding is invalid.',
          );
        }
        beforeWrite?.();
        insert.run(
          receipt.scopeSessionId,
          receipt.commandId,
          owner.workerScopeId,
          owner.projectId,
          owner.workspaceDigest,
          receipt.requestDigest,
          receipt.targetSessionId,
          receipt.originalReceiptJson,
          receipt.committedRevision,
          receipt.committedAt,
        );
      } else {
        beforeWrite?.();
        insert.run(
          receipt.scopeSessionId,
          receipt.commandId,
          receipt.requestDigest,
          receipt.targetSessionId,
          receipt.originalReceiptJson,
          receipt.committedRevision,
          receipt.committedAt,
        );
      }
    },
  });
}

/** Persistent Store 6 receipt lookup over the adapter's only connection. */
export function createSqliteRuntimeCommandReceiptPort(input: {
  readonly db: Database;
  readonly isClosed: () => boolean;
  readonly workspaceBinding?: SqliteRuntimeWorkspaceBinding;
}): RuntimeCommandReceiptPort {
  const find = input.workspaceBinding
    ? input.db.query<
        {
          scope_session_id: string;
          command_id: string;
          worker_scope_id: string;
          project_id: string;
          workspace_digest: string;
          request_digest: string;
          target_session_id: string;
          original_receipt_json: string;
          committed_revision: number;
          committed_at: number;
        },
        [string, string]
      >(
        `SELECT scope_session_id, command_id, worker_scope_id, project_id, workspace_digest,
          request_digest, target_session_id, original_receipt_json, committed_revision, committed_at
          FROM runtime_command_receipts
          WHERE scope_session_id = ? AND command_id = ? LIMIT 1`,
      )
    : input.db.query<
        {
          scope_session_id: string;
          command_id: string;
          worker_scope_id?: string;
          project_id?: string;
          workspace_digest?: string;
          request_digest: string;
          target_session_id: string;
          original_receipt_json: string;
          committed_revision: number;
          committed_at: number;
        },
        [string, string]
      >(
        `SELECT scope_session_id, command_id, request_digest, target_session_id,
          original_receipt_json, committed_revision, committed_at
          FROM runtime_command_receipts
          WHERE scope_session_id = ? AND command_id = ? LIMIT 1`,
      );

  return Object.freeze({
    lookup(inputReceipt: RuntimeCommandReceiptLookupInput): RuntimeCommandReceiptLookup {
      if (input.isClosed()) return { status: 'missing' };
      assertReceiptText(inputReceipt.scopeSessionId, 'scope session identity');
      assertReceiptText(inputReceipt.commandId, 'command identity');
      if (!/^[a-f0-9]{64}$/u.test(inputReceipt.requestDigest)) {
        throw new SqliteRuntimeCommandReceiptValidationError(
          'Runtime command receipt digest is invalid.',
        );
      }
      const row = find.get(inputReceipt.scopeSessionId, inputReceipt.commandId);
      if (!row) return { status: 'missing' };
      const receipt: RuntimeStoredCommandReceipt = Object.freeze({
        scopeSessionId: row.scope_session_id,
        commandId: row.command_id,
        requestDigest: row.request_digest,
        targetSessionId: row.target_session_id,
        originalReceiptJson: row.original_receipt_json,
        committedRevision: row.committed_revision,
        committedAt: row.committed_at,
      });
      assertSqliteRuntimeCommandReceipt(receipt);
      if (input.workspaceBinding) {
        const owner = ownerForTarget(input.db, row.target_session_id);
        const receiptOwner =
          row.worker_scope_id && row.project_id && row.workspace_digest
            ? {
                workerScopeId: row.worker_scope_id,
                projectId: row.project_id,
                workspaceDigest: row.workspace_digest,
              }
            : null;
        if (
          !owner ||
          !receiptOwner ||
          !matchesWorkspaceBinding(receiptOwner, input.workspaceBinding) ||
          !matchesOwner(receiptOwner, owner)
        ) {
          throw new SqliteRuntimeCommandReceiptValidationError(
            'Runtime command receipt Workspace binding is invalid.',
          );
        }
      }
      return receipt.requestDigest === inputReceipt.requestDigest
        ? { status: 'replay', receipt }
        : { status: 'digest_mismatch', receipt };
    },
  });
}

function matchesWorkspaceBinding(
  owner: SqliteRuntimeSessionBinding,
  binding: SqliteRuntimeWorkspaceBinding,
): boolean {
  return owner.workerScopeId === binding.workerScopeId;
}

function matchesOwner(
  left: SqliteRuntimeSessionBinding,
  right: SqliteRuntimeSessionBinding,
): boolean {
  return (
    left.workerScopeId === right.workerScopeId &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function ownerForTarget(db: Database, targetSessionId: string): SqliteRuntimeSessionBinding | null {
  const session = db
    .query<SqliteRuntimeSessionBinding, [string]>(
      'SELECT worker_scope_id AS workerScopeId, project_id AS projectId, workspace_digest AS workspaceDigest FROM runtime_sessions WHERE session_id = ? LIMIT 1',
    )
    .get(targetSessionId);
  if (session) return session;
  return (
    db
      .query<SqliteRuntimeSessionBinding, [string]>(
        'SELECT worker_scope_id AS workerScopeId, project_id AS projectId, workspace_digest AS workspaceDigest FROM session_workspace_tombstone WHERE session_id = ? LIMIT 1',
      )
      .get(targetSessionId) ?? null
  );
}
