import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { DispatchInput, Store } from '../port';
import { AgentError, type InteractionAnswer, type Json, type PermissionGrant } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null | undefined>;
function commandDigest(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new AgentError('invalid_command_digest');
  return value;
}
function decimal(value: string): bigint {
  if (!/^(0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new AgentError('invalid_permission_revision');
  return BigInt(value);
}
function scope(db: SqliteOperations, sessionId: string, subjectId: string) {
  const session = db.row('SELECT * FROM session WHERE id=?', sessionId);
  const root =
    session && db.row('SELECT * FROM session WHERE id=? AND parent_id IS NULL', session.root_id!);
  const creator =
    root &&
    db.row(
      "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
      session.root_id!,
    );
  if (
    !session ||
    !root ||
    root.workspace_id !== session.workspace_id ||
    !creator ||
    creator.subject_id !== subjectId
  )
    throw new AgentError('permission_grant_scope_denied');
  if (session.delete_requested || root.delete_requested) throw new AgentError('session_deleted');
  return session;
}
function epoch(
  db: SqliteOperations,
  storeId: string,
  subjectId: string,
  sessionId: string,
): string {
  return String(
    db.row(
      'SELECT CAST(MAX(seq) AS TEXT) AS revision FROM permission_grant_change WHERE origin_store_id=? AND subject_id=? AND session_id=?',
      storeId,
      subjectId,
      sessionId,
    )?.revision ?? '0',
  );
}
function change(
  db: SqliteOperations,
  storeId: string,
  subjectId: string,
  sessionId: string,
  kind: string,
): string {
  db.run(
    'INSERT INTO permission_grant_change(origin_store_id,subject_id,session_id,kind) VALUES(?,?,?,?)',
    storeId,
    subjectId,
    sessionId,
    kind,
  );
  return epoch(db, storeId, subjectId, sessionId);
}
function projection(row: Row): PermissionGrant {
  return {
    ...(row.command_digest === null ? {} : { commandDigest: String(row.command_digest) }),
    id: String(row.id),
    originStoreId: String(row.origin_store_id),
    sessionId: String(row.session_id),
    workspaceId: String(row.workspace_id),
    kind: String(row.kind),
    definitionId: String(row.definition_id),
    definitionVersion: String(row.definition_version),
    inputDigest: String(row.input_digest),
    interactionId: String(row.id),
    decisionRevision: String(row.decision_revision),
    executionId: String(row.execution_id),
  };
}
function target(db: SqliteOperations, executionId: string, storeId: string) {
  const execution = db.row('SELECT * FROM execution WHERE id=?', executionId);
  const command =
    execution && db.row('SELECT * FROM command WHERE id=?', execution.origin_command_id!);
  if (
    !execution ||
    !command ||
    execution.origin_store_id !== storeId ||
    command.origin_store_id !== storeId
  )
    throw new AgentError('operation_unverifiable');
  const session = scope(db, String(execution.session_id), String(command.subject_id));
  return { execution, command, session };
}
function exact(row: Row, value: ReturnType<typeof target>, currentDigest?: string): boolean {
  return (
    row.subject_id === value.command.subject_id &&
    row.session_id === value.execution.session_id &&
    row.workspace_id === value.session.workspace_id &&
    row.kind === value.execution.kind &&
    row.definition_id === value.execution.adapter_id &&
    row.definition_version === value.execution.definition_version &&
    (row.command_digest === null
      ? currentDigest === undefined &&
        row.input_digest ===
          createHash('sha256')
            .update(canonicalJson(JSON.parse(String(value.execution.intent_json)) as Json))
            .digest('hex')
      : row.command_digest === commandDigest(currentDigest))
  );
}
function proof(db: SqliteOperations, row: Row): void {
  const interaction = db.row('SELECT * FROM interaction WHERE id=?', row.id!);
  const original = db.row('SELECT * FROM execution WHERE id=?', row.execution_id!);
  const answer = interaction && (JSON.parse(String(interaction.answer_json)) as InteractionAnswer);
  if (
    !interaction ||
    !original ||
    interaction.kind !== 'approval' ||
    interaction.state !== 'answered' ||
    interaction.origin_store_id !== row.origin_store_id ||
    interaction.subject_id !== row.subject_id ||
    interaction.session_id !== row.session_id ||
    interaction.execution_id !== row.execution_id ||
    interaction.input_digest !== row.input_digest ||
    interaction.definition_id !== row.definition_id ||
    interaction.definition_version !== row.definition_version ||
    String(interaction.accepted_decision_revision) !== row.decision_revision ||
    String(interaction.revision) !== row.decision_revision ||
    answer?.kind !== 'approval' ||
    answer.decision !== 'approve' ||
    answer.grant !== 'same_command' ||
    original.origin_store_id !== row.origin_store_id ||
    original.session_id !== row.session_id ||
    Number(original.attempt) !== Number(interaction.attempt) ||
    original.kind !== row.kind ||
    original.adapter_id !== row.definition_id ||
    original.definition_version !== row.definition_version ||
    row.input_digest !==
      createHash('sha256')
        .update(canonicalJson(JSON.parse(String(original.intent_json)) as Json))
        .digest('hex') ||
    commandDigest(
      (JSON.parse(String(interaction.request_json)) as { commandDigest?: string }).commandDigest,
    ) !== row.command_digest
  )
    throw new AgentError('permission_grant_unverifiable');
}
/** Called only after the genuine owner has accepted the exact original human decision. */
export function savePermissionGrant(db: SqliteOperations, interaction: Row, execution: Row): void {
  const answer = JSON.parse(String(interaction.answer_json)) as InteractionAnswer;
  if (
    interaction.kind !== 'approval' ||
    answer.kind !== 'approval' ||
    answer.decision !== 'approve' ||
    answer.grant !== 'same_command'
  )
    return;
  if (execution.kind === 'model') throw new AgentError('permission_denied');
  const body = JSON.parse(String(interaction.request_json)) as {
    grants?: string[];
    commandDigest?: string;
  };
  const digest = commandDigest(body.commandDigest);
  if (!body.grants?.includes('same_command')) throw new AgentError('interaction_answer_invalid');
  if (db.row('SELECT id FROM permission_grant WHERE id=?', interaction.id!)) return;
  const value = target(db, String(execution.id), String(interaction.origin_store_id));
  const seq = change(
    db,
    String(interaction.origin_store_id),
    String(interaction.subject_id),
    String(execution.session_id),
    'grant',
  );
  db.run(
    'INSERT INTO permission_grant(id,origin_store_id,subject_id,session_id,workspace_id,kind,definition_id,definition_version,input_digest,command_digest,execution_id,decision_revision,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
    interaction.id!,
    interaction.origin_store_id!,
    interaction.subject_id!,
    execution.session_id!,
    value.session.workspace_id!,
    execution.kind!,
    interaction.definition_id!,
    interaction.definition_version!,
    interaction.input_digest!,
    digest,
    execution.id!,
    String(interaction.revision),
    seq,
  );
  db.event(String(execution.session_id), String(interaction.id), 'permission.granted');
}
export function verifyPermissionGrantDispatch(db: SqliteOperations, input: DispatchInput): void {
  const reference = input.authorization.grant;
  if (!reference) return;
  if (
    typeof reference !== 'object' ||
    Array.isArray(reference) ||
    typeof reference.grantId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(reference.grantId) ||
    typeof reference.revision !== 'string'
  )
    throw new AgentError('permission_grant_unverifiable');
  if (Object.keys(reference).some((key) => !['grantId', 'revision', 'commandDigest'].includes(key)))
    throw new AgentError('permission_grant_unverifiable');
  decimal(reference.revision);
  const value = target(db, input.executionId, input.expectedStoreId);
  const row = db.row('SELECT * FROM permission_grant WHERE id=?', reference.grantId);
  if (
    !row ||
    row.origin_store_id !== input.expectedStoreId ||
    row.revoked_seq !== null ||
    !exact(row, value, reference.commandDigest) ||
    epoch(
      db,
      input.expectedStoreId,
      String(value.command.subject_id),
      String(value.execution.session_id),
    ) !== reference.revision
  )
    throw new AgentError('permission_grant_changed');
  proof(db, row);
}
export function callPermissionGrant(
  db: SqliteOperations,
  method: string,
  args: unknown[],
): unknown {
  if (method === 'clearPermissionGrants') {
    const input = args[0] as Parameters<Store['clearPermissionGrants']>[0];
    return db.tx(() => {
      db.identity(input.expectedStoreId);
      scope(db, input.sessionId, input.subjectId);
      decimal(input.ifRevision);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.commandId))
        throw new AgentError('invalid_host_mutation');
      const request: Json = { sessionId: input.sessionId, ifRevision: input.ifRevision };
      const requestDigest = createHash('sha256').update(canonicalJson(request)).digest('hex');
      const prior = db.row('SELECT * FROM host_mutation WHERE id=?', input.commandId);
      if (prior) {
        if (
          prior.origin_store_id !== input.expectedStoreId ||
          prior.subject_id !== input.subjectId ||
          prior.kind !== 'permission.grants.clear' ||
          prior.scope !== `session:${input.sessionId}` ||
          prior.request_digest !== requestDigest
        )
          throw new AgentError('host_mutation_conflict');
      } else {
        if (epoch(db, input.expectedStoreId, input.subjectId, input.sessionId) !== input.ifRevision)
          throw new AgentError('host_control_conflict');
        const revision = change(
          db,
          input.expectedStoreId,
          input.subjectId,
          input.sessionId,
          'clear',
        );
        db.run(
          'UPDATE permission_grant SET revoked_seq=? WHERE origin_store_id=? AND subject_id=? AND session_id=? AND revoked_seq IS NULL',
          revision,
          input.expectedStoreId,
          input.subjectId,
          input.sessionId,
        );
        db.run(
          "INSERT INTO host_mutation(id,origin_store_id,subject_id,kind,scope,request_digest,safe_request_json,state,receipt_json) VALUES(?,?,?,'permission.grants.clear',?,?,?,'applied',?)",
          input.commandId,
          input.expectedStoreId,
          input.subjectId,
          `session:${input.sessionId}`,
          requestDigest,
          canonicalJson(request),
          canonicalJson({ status: 'applied', sessionId: input.sessionId, revision }),
        );
        db.event(input.sessionId, input.commandId, 'permission.grants.cleared');
      }
      const saved = db.row('SELECT * FROM host_mutation WHERE id=?', input.commandId)!;
      return {
        id: String(saved.id),
        originStoreId: String(saved.origin_store_id),
        subjectId: String(saved.subject_id),
        kind: 'permission.grants.clear',
        scope: String(saved.scope),
        requestDigest: String(saved.request_digest),
        safeRequest: JSON.parse(String(saved.safe_request_json)),
        state: saved.state,
        receipt: JSON.parse(String(saved.receipt_json)),
      };
    });
  }
  db.db.run('BEGIN');
  try {
    const input = args[0] as Parameters<Store['listPermissionGrants']>[0] & {
      executionId: string;
      commandDigest?: string;
    };
    db.identity(input.expectedStoreId);
    let result: unknown;
    if (method === 'getPermissionGrant') {
      const value = target(db, input.executionId, input.expectedStoreId);
      const rows = db.db
        .query(
          'SELECT * FROM permission_grant WHERE origin_store_id=? AND subject_id=? AND session_id=? AND workspace_id=? AND kind=? AND definition_id=? AND definition_version=? AND command_digest IS ? AND (command_digest IS NOT NULL OR input_digest=?) AND revoked_seq IS NULL ORDER BY seq DESC LIMIT 1',
        )
        .all(
          input.expectedStoreId,
          value.command.subject_id!,
          value.execution.session_id!,
          value.session.workspace_id!,
          value.execution.kind!,
          value.execution.adapter_id!,
          value.execution.definition_version!,
          commandDigest(input.commandDigest),
          createHash('sha256')
            .update(canonicalJson(JSON.parse(String(value.execution.intent_json)) as Json))
            .digest('hex')!,
        ) as Row[];
      const row = rows[0];
      if (row) proof(db, row);
      result = row
        ? {
            grantId: String(row.id),
            ...(row.command_digest === null ? {} : { commandDigest: String(row.command_digest) }),
            revision: epoch(
              db,
              input.expectedStoreId,
              String(value.command.subject_id),
              String(value.execution.session_id),
            ),
          }
        : null;
    } else {
      scope(db, input.sessionId, input.subjectId);
      const highWaterSeq = String(
        db.row('SELECT CAST(MAX(seq) AS TEXT) AS seq FROM permission_grant_change')?.seq ?? '0',
      );
      const after = decimal(input.afterSeq ?? '0'),
        upper = decimal(input.upperSeq ?? highWaterSeq);
      const limit = input.limit ?? 100;
      if (
        after > upper ||
        upper > decimal(highWaterSeq) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        throw new AgentError('invalid_permission_grant_page');
      const rows = db.db
        .query(
          'SELECT *,CAST(seq AS TEXT) AS page_seq FROM permission_grant WHERE origin_store_id=? AND subject_id=? AND session_id=? AND seq>? AND seq<=? AND revoked_seq IS NULL ORDER BY seq LIMIT ?',
        )
        .all(
          input.expectedStoreId,
          input.subjectId,
          input.sessionId,
          after,
          upper,
          limit + 1,
        ) as Row[];
      const items = rows
        .slice(0, limit)
        .map((row) => ({ seq: String(row.page_seq), grant: projection(row) }));
      result = {
        storeId: input.expectedStoreId,
        sessionId: input.sessionId,
        revision: epoch(db, input.expectedStoreId, input.subjectId, input.sessionId),
        items,
        highWaterSeq,
        upperSeq: String(upper),
        nextAfterSeq: rows.length > limit ? items.at(-1)!.seq : null,
        snapshotCursor: String(
          db.row('SELECT CAST(MAX(cursor) AS TEXT) AS cursor FROM change_event')?.cursor ?? '0',
        ),
      };
    }
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
