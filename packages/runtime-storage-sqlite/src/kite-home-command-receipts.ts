import type { Database } from 'bun:sqlite';
import type {
  RuntimeCommandReceiptLookup,
  RuntimeCommandReceiptLookupInput,
  RuntimeCommandReceiptPort,
  RuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import {
  assertSqliteRuntimeCommandReceipt,
  type SqliteRuntimeCommandReceiptWriter,
} from './command-receipts';
import { assertKiteHomeStoreSchema } from './kite-home-store';
import type { KiteHomeWorkspaceAdmission } from './kite-home-workspaces';
import {
  SqliteRuntimeCommandReceiptValidationError,
  type SqliteRuntimeSessionBinding,
} from './preflight';

interface ReceiptOwnerRow {
  readonly workspace_id: string;
  readonly project_id: string;
  readonly workspace_digest: string;
}

interface ReceiptRow extends ReceiptOwnerRow {
  readonly scope_session_id: string;
  readonly command_id: string;
  readonly request_digest: string;
  readonly target_session_id: string;
  readonly original_receipt_json: string;
  readonly committed_revision: number;
  readonly committed_at: number;
  readonly result_schema: string | null;
  readonly result_json: string | null;
  readonly result_digest: string | null;
}

export interface KiteHomeCommandReceiptStore {
  readonly port: RuntimeCommandReceiptPort;
  readonly writer: SqliteRuntimeCommandReceiptWriter;
  readExact(receipt: RuntimeStoredCommandReceipt): RuntimeStoredCommandReceipt | null;
}

/** Store 9 receipt owner. Retained receipts resolve scope through Session or tombstone facts. */
export function createKiteHomeCommandReceiptStore(input: {
  readonly database: Database;
  readonly workspace: KiteHomeWorkspaceAdmission;
  readonly assertStoreSchema?: (database: Database) => void;
  readonly isClosed: () => boolean;
}): KiteHomeCommandReceiptStore {
  (input.assertStoreSchema ?? assertKiteHomeStoreSchema)(input.database);
  const selectReceipt = input.database.query<ReceiptRow, [string, string]>(
    `SELECT scope_session_id, command_id, workspace_id, project_id, workspace_digest,
            request_digest, target_session_id, original_receipt_json, committed_revision,
            committed_at, result_schema, result_json, result_digest
       FROM runtime_command_receipts
      WHERE scope_session_id = ? AND command_id = ?
      LIMIT 1`,
  );
  const selectActiveOwner = input.database.query<ReceiptOwnerRow, [string]>(
    `SELECT workspace_id, project_id, workspace_digest
       FROM runtime_sessions WHERE session_id = ? LIMIT 1`,
  );
  const selectDeletedOwner = input.database.query<ReceiptOwnerRow, [string]>(
    `SELECT workspace_id, project_id, workspace_digest
       FROM runtime_session_tombstones WHERE session_id = ? LIMIT 1`,
  );
  const insert = input.database.query(
    `INSERT INTO runtime_command_receipts(
      scope_session_id, command_id, workspace_id, project_id, workspace_digest,
      request_digest, target_session_id, original_receipt_json, committed_revision,
      committed_at, result_schema, result_json, result_digest
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const ownerForTarget = (targetSessionId: string): ReceiptOwnerRow | null =>
    selectActiveOwner.get(targetSessionId) ?? selectDeletedOwner.get(targetSessionId) ?? null;

  const assertOwner = (owner: ReceiptOwnerRow | null): ReceiptOwnerRow => {
    if (
      !owner ||
      owner.workspace_id !== input.workspace.workspaceId ||
      owner.project_id !== input.workspace.projectId ||
      owner.workspace_digest !== input.workspace.workspaceDigest
    ) {
      throw new SqliteRuntimeCommandReceiptValidationError(
        'Runtime command receipt Workspace binding is invalid.',
      );
    }
    return owner;
  };

  const fromRow = (row: ReceiptRow): RuntimeStoredCommandReceipt => {
    const resultCount = [row.result_schema, row.result_json, row.result_digest].filter(
      (value) => value !== null,
    ).length;
    if (resultCount !== 0 && resultCount !== 3) {
      throw new SqliteRuntimeCommandReceiptValidationError(
        'Runtime command resource result triple is incomplete.',
      );
    }
    const receipt: RuntimeStoredCommandReceipt = Object.freeze({
      scopeSessionId: row.scope_session_id,
      commandId: row.command_id,
      requestDigest: row.request_digest,
      targetSessionId: row.target_session_id,
      originalReceiptJson: row.original_receipt_json,
      committedRevision: row.committed_revision,
      committedAt: row.committed_at,
      ...(resultCount === 3
        ? {
            resourceResult: Object.freeze({
              schema: row.result_schema!,
              json: row.result_json!,
              digest: row.result_digest!,
            }),
          }
        : {}),
    });
    assertSqliteRuntimeCommandReceipt(receipt, undefined, undefined, true);
    const owner = assertOwner(ownerForTarget(row.target_session_id));
    if (
      row.workspace_id !== owner.workspace_id ||
      row.project_id !== owner.project_id ||
      row.workspace_digest !== owner.workspace_digest
    ) {
      throw new SqliteRuntimeCommandReceiptValidationError(
        'Runtime command receipt retained owner is invalid.',
      );
    }
    return receipt;
  };

  const readExact = (receipt: RuntimeStoredCommandReceipt): RuntimeStoredCommandReceipt | null => {
    const row = selectReceipt.get(receipt.scopeSessionId, receipt.commandId);
    return row ? fromRow(row) : null;
  };

  const writer: SqliteRuntimeCommandReceiptWriter = Object.freeze({
    insert(
      receipt: RuntimeStoredCommandReceipt,
      transactionSessionId: string,
      committedRevision: number,
      sessionBinding?: SqliteRuntimeSessionBinding,
    ): void {
      assertSqliteRuntimeCommandReceipt(receipt, transactionSessionId, committedRevision, true);
      const owner = assertOwner(ownerForTarget(receipt.targetSessionId));
      if (
        sessionBinding &&
        (sessionBinding.workerScopeId !== owner.workspace_id ||
          sessionBinding.projectId !== owner.project_id ||
          sessionBinding.workspaceDigest !== owner.workspace_digest)
      ) {
        throw new SqliteRuntimeCommandReceiptValidationError(
          'Runtime command receipt transaction owner is invalid.',
        );
      }
      insert.run(
        receipt.scopeSessionId,
        receipt.commandId,
        owner.workspace_id,
        owner.project_id,
        owner.workspace_digest,
        receipt.requestDigest,
        receipt.targetSessionId,
        receipt.originalReceiptJson,
        receipt.committedRevision,
        receipt.committedAt,
        receipt.resourceResult?.schema ?? null,
        receipt.resourceResult?.json ?? null,
        receipt.resourceResult?.digest ?? null,
      );
    },
  });

  const port: RuntimeCommandReceiptPort = Object.freeze({
    lookup(receipt: RuntimeCommandReceiptLookupInput): RuntimeCommandReceiptLookup {
      if (input.isClosed()) return { status: 'missing' };
      assertLookup(receipt);
      const row = selectReceipt.get(receipt.scopeSessionId, receipt.commandId);
      if (!row) return { status: 'missing' };
      const stored = fromRow(row);
      return stored.requestDigest === receipt.requestDigest
        ? { status: 'replay', receipt: stored }
        : { status: 'digest_mismatch', receipt: stored };
    },
  });

  return Object.freeze({ port, writer, readExact });
}

function assertLookup(receipt: RuntimeCommandReceiptLookupInput): void {
  if (
    !receipt.scopeSessionId ||
    receipt.scopeSessionId.length > 512 ||
    !receipt.commandId ||
    receipt.commandId.length > 512 ||
    !/^[a-f0-9]{64}$/u.test(receipt.requestDigest)
  ) {
    throw new SqliteRuntimeCommandReceiptValidationError(
      'Runtime command receipt lookup is invalid.',
    );
  }
}
