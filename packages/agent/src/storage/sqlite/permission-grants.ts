import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import {
  type GrantOffer,
  type GrantUse,
  parseGrantOffer,
  sameCapability,
  selectedApprovalOption,
} from '../../permission-grants';
import type { DispatchInput, Store } from '../port';
import { AgentError, type InteractionAnswer, type Json, type PermissionGrant } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null | undefined>;
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
/** The caller owns the transaction that invalidates this exact approval. */
export function revokePermissionGrant(
  db: SqliteOperations,
  input: {
    interactionId: string;
    expectedStoreId: string;
    subjectId: string;
    sessionId: string;
  },
): void {
  if (
    !db.row(
      'SELECT id FROM permission_grant WHERE id=? AND origin_store_id=? AND subject_id=? AND session_id=? AND revoked_seq IS NULL',
      input.interactionId,
      input.expectedStoreId,
      input.subjectId,
      input.sessionId,
    )
  )
    return;
  const revision = change(db, input.expectedStoreId, input.subjectId, input.sessionId, 'clear');
  db.run(
    'UPDATE permission_grant SET revoked_seq=? WHERE id=? AND revoked_seq IS NULL',
    revision,
    input.interactionId,
  );
}
function projection(row: Row): PermissionGrant {
  return {
    ...publicOffer(parseGrantOffer(JSON.parse(String(row.payload_json)))),
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
function publicOffer(offer: GrantOffer) {
  const { policyBindings: _bindings, ...publicValue } = offer;
  return publicValue;
}
function exact(row: Row, value: ReturnType<typeof target>, offer: GrantOffer): boolean {
  return (
    row.subject_id === value.command.subject_id &&
    row.session_id === value.execution.session_id &&
    row.workspace_id === value.session.workspace_id &&
    row.scope_digest === offer.scopeDigest &&
    offer.bindings.some((binding) =>
      sameCapability(binding, {
        kind: String(value.execution.kind) as 'tool' | 'job',
        definitionId: String(value.execution.adapter_id),
        definitionVersion: String(value.execution.definition_version),
      }),
    )
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
    !answer.optionId ||
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
    canonicalJson(
      parseGrantOffer(
        selectedApprovalOption(
          JSON.parse(String(interaction.request_json)),
          answer.kind === 'approval' && answer.decision === 'approve' ? answer.optionId : null,
        ),
      ) as unknown as Json,
    ) !== row.payload_json
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
    !answer.optionId
  )
    return;
  if (execution.kind === 'model') throw new AgentError('permission_denied');
  const selected = selectedApprovalOption(
    JSON.parse(String(interaction.request_json)),
    answer.optionId,
  );
  if (selected.kind === 'once') return;
  const offer = parseGrantOffer(selected);
  if (
    !offer.bindings.some((binding) =>
      sameCapability(binding, {
        kind: String(execution.kind) as 'tool' | 'job',
        definitionId: String(execution.adapter_id),
        definitionVersion: String(execution.definition_version),
      }),
    )
  )
    throw new AgentError('interaction_answer_invalid');
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
    'INSERT INTO permission_grant(id,origin_store_id,subject_id,session_id,workspace_id,kind,definition_id,definition_version,input_digest,scope_digest,payload_json,execution_id,decision_revision,seq) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    interaction.id!,
    interaction.origin_store_id!,
    interaction.subject_id!,
    execution.session_id!,
    value.session.workspace_id!,
    execution.kind!,
    interaction.definition_id!,
    interaction.definition_version!,
    interaction.input_digest!,
    offer.scopeDigest,
    canonicalJson(offer as unknown as Json),
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
  if (
    Object.keys(reference).some(
      (key) =>
        !['grantId', 'revision', 'acceptedRevision', 'offer', 'binding', 'reuseRevision'].includes(
          key,
        ),
    )
  )
    throw new AgentError('permission_grant_unverifiable');
  decimal(reference.revision);
  const offer = parseGrantOffer(reference.offer);
  const policyBinding = offer.policyBindings.find((binding) =>
    sameCapability(binding.capability, reference.binding),
  );
  if (!policyBinding || policyBinding.reuseRevision !== reference.reuseRevision)
    throw new AgentError('permission_grant_changed');
  const value = target(db, input.executionId, input.expectedStoreId);
  const row = db.row('SELECT * FROM permission_grant WHERE id=?', reference.grantId);
  if (
    !row ||
    row.origin_store_id !== input.expectedStoreId ||
    row.revoked_seq !== null ||
    !exact(row, value, offer) ||
    row.payload_json !== canonicalJson(offer as unknown as Json) ||
    String(row.decision_revision) !== reference.acceptedRevision ||
    !sameCapability(reference.binding, {
      kind: String(value.execution.kind) as 'tool' | 'job',
      definitionId: String(value.execution.adapter_id),
      definitionVersion: String(value.execution.definition_version),
    }) ||
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
      offers: readonly GrantOffer[];
    };
    db.identity(input.expectedStoreId);
    let result: unknown;
    if (method === 'getPermissionGrant') {
      const value = target(db, input.executionId, input.expectedStoreId);
      result = null;
      for (const current of input.offers) {
        parseGrantOffer(current);
        const rows = db.db
          .query(
            'SELECT * FROM permission_grant WHERE origin_store_id=? AND subject_id=? AND session_id=? AND workspace_id=? AND scope_digest=? AND revoked_seq IS NULL ORDER BY seq DESC',
          )
          .all(
            input.expectedStoreId,
            value.command.subject_id!,
            value.execution.session_id!,
            value.session.workspace_id!,
            current.scopeDigest,
          ) as Row[];
        for (const row of rows) {
          const offer = parseGrantOffer(JSON.parse(String(row.payload_json)));
          const binding = {
            kind: String(value.execution.kind) as 'tool' | 'job',
            definitionId: String(value.execution.adapter_id),
            definitionVersion: String(value.execution.definition_version),
          };
          const prior = offer.policyBindings.find((entry) =>
            sameCapability(entry.capability, binding),
          );
          const now = current.policyBindings.find((entry) =>
            sameCapability(entry.capability, binding),
          );
          if (
            !exact(row, value, current) ||
            !prior ||
            !now ||
            canonicalJson(prior as unknown as Json) !== canonicalJson(now as unknown as Json) ||
            canonicalJson(offer.scope) !== canonicalJson(current.scope) ||
            offer.ruleId !== current.ruleId ||
            offer.contractId !== current.contractId
          )
            continue;
          proof(db, row);
          result = {
            grantId: String(row.id),
            revision: epoch(
              db,
              input.expectedStoreId,
              String(value.command.subject_id),
              String(value.execution.session_id),
            ),
            acceptedRevision: String(row.decision_revision),
            offer,
            binding,
            reuseRevision: now.reuseRevision,
          } satisfies GrantUse;
          break;
        }
        if (result) break;
      }
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
    return db.rollback(error);
  }
}
