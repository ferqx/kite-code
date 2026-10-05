import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { and, eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { canonicalJson } from '../../json';
import type { DispatchInput, Store } from '../port';
import {
  AgentError,
  type InteractionAnswer,
  type InteractionRecord,
  type Json,
  type RequirementRef,
} from '../types';
import { verifyHostControlReads } from './host-control-dispatch';
import type { SqliteOperations } from './operations';
import { savePermissionGrant } from './permission-grants';
import { interactions } from './schema';

type Row = Record<string, string | number | bigint | null | undefined>;
const digest = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const decode = <T>(value: Row[string]): T => JSON.parse(String(value)) as T;
function record(row: Row): InteractionRecord {
  return {
    ...(row.information_permission_json
      ? {
          informationPermission: decode<import('../types').InformationPermissionStamp>(
            row.information_permission_json,
          ),
        }
      : {}),
    id: String(row.id),
    originStoreId: String(row.origin_store_id),
    sessionId: String(row.session_id),
    runId: row.run_id === null ? null : String(row.run_id),
    executionId: String(row.execution_id),
    attempt: Number(row.attempt),
    presentationSessionId: String(row.presentation_session_id),
    ancestry: decode(row.ancestry_json),
    subjectId: String(row.subject_id),
    kind: row.kind as InteractionRecord['kind'],
    definitionId: String(row.definition_id),
    definitionVersion: String(row.definition_version),
    inputDigest: String(row.input_digest),
    policyRevision: String(row.policy_revision),
    requiredRefs: decode(row.required_refs_json),
    source: decode(row.source_json),
    request: decode(row.request_json),
    answer: row.answer_json === null ? null : decode(row.answer_json),
    revision: String(row.revision),
    acceptedDecisionRevision:
      row.accepted_decision_revision === null ? null : String(row.accepted_decision_revision),
    state: row.state as InteractionRecord['state'],
  };
}
function decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw new AgentError('invalid_revision');
  return BigInt(value);
}
function bounded(value: Json, bytes = 32768): void {
  if (Buffer.byteLength(canonicalJson(value)) > bytes)
    throw new AgentError('interaction_too_large');
  let nodes = 0;
  const visit = (v: Json, depth: number) => {
    if (++nodes > 2048 || depth > 16) throw new AgentError('interaction_too_complex');
    if (v && typeof v === 'object') for (const child of Object.values(v)) visit(child, depth + 1);
  };
  visit(value, 0);
}
function schema(value: Json): ReturnType<Ajv['compile']> {
  const keywords = new Set([
    'type',
    'properties',
    'required',
    'additionalProperties',
    'items',
    'enum',
    'const',
    'oneOf',
    'anyOf',
    'minLength',
    'maxLength',
    'pattern',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
    'description',
    'title',
  ]);
  let count = 0;
  const walk = (v: Json, depth: number) => {
    if (!v || typeof v !== 'object' || Array.isArray(v) || ++count > 256 || depth > 12)
      throw new AgentError('question_schema_invalid');
    for (const [key, child] of Object.entries(v)) {
      if (!keywords.has(key)) throw new AgentError('question_schema_invalid');
      // Permit only the bounded, linear nonblank string constraint.
      if (key === 'pattern' && child !== '\\S') throw new AgentError('question_schema_invalid');
      if (key === 'properties') {
        if (!child || typeof child !== 'object' || Array.isArray(child))
          throw new AgentError('question_schema_invalid');
        if (Object.hasOwn(child, '__proto__')) throw new AgentError('question_schema_invalid');
        for (const entry of Object.values(child)) walk(entry, depth + 1);
      } else if (key === 'required' && Array.isArray(child) && child.includes('__proto__')) {
        throw new AgentError('question_schema_invalid');
      } else if (key === 'oneOf' || key === 'anyOf') {
        if (!Array.isArray(child) || child.length === 0)
          throw new AgentError('question_schema_invalid');
        for (const branch of child) walk(branch, depth + 1);
      } else if (key === 'items' || (key === 'additionalProperties' && typeof child !== 'boolean'))
        walk(child, depth + 1);
    }
  };
  walk(value, 0);
  try {
    return new Ajv({
      strict: false,
      allErrors: false,
      validateFormats: false,
      ownProperties: true,
    }).compile(value as object);
  } catch {
    throw new AgentError('question_schema_invalid');
  }
}
function answer(kind: InteractionRecord['kind'], value: InteractionAnswer, request: Json): void {
  bounded(value as unknown as Json);
  if (!value || value.kind !== kind) throw new AgentError('interaction_answer_invalid');
  const allowed =
    kind === 'question'
      ? ['kind', 'answers']
      : kind === 'approval'
        ? ['kind', 'decision', 'grant']
        : ['kind', 'decision', 'feedback', 'mode'];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new AgentError('interaction_answer_invalid');
  if (kind === 'question') {
    if (!('answers' in value)) throw new AgentError('interaction_answer_invalid');
    const body = request as { schema?: Json };
    if (body?.schema !== undefined && !schema(body.schema)(value.answers))
      throw new AgentError('interaction_answer_invalid');
  } else {
    if (
      value.kind === 'approval' &&
      value.grant !== undefined &&
      (value.decision !== 'approve' ||
        !['approve_once', 'same_command'].includes(value.grant) ||
        (value.grant === 'same_command' &&
          !(request as { grants?: string[] })?.grants?.includes('same_command')))
    )
      throw new AgentError('interaction_answer_invalid');
    if (
      !('decision' in value) ||
      !['approve', 'deny', ...(kind === 'plan_review' ? ['revise'] : [])].includes(value.decision)
    )
      throw new AgentError('interaction_answer_invalid');
    if ('feedback' in value && (typeof value.feedback !== 'string' || value.feedback.length > 8192))
      throw new AgentError('interaction_answer_invalid');
    if ('mode' in value && (typeof value.mode !== 'string' || value.mode.length > 128))
      throw new AgentError('interaction_answer_invalid');
  }
}
function binding(
  execution: Row,
  input: {
    executionId: string;
    attempt: number;
    definitionId: string;
    definitionVersion: string;
    inputDigest: string;
  },
): void {
  if (
    execution.id !== input.executionId ||
    Number(execution.attempt) !== input.attempt ||
    execution.adapter_id !== input.definitionId ||
    execution.definition_version !== input.definitionVersion ||
    digest(decode(execution.intent_json)) !== input.inputDigest
  )
    throw new AgentError('interaction_binding_changed');
}
function required(db: SqliteOperations, execution: Row): RequirementRef[] {
  const run =
    execution.run_id === null
      ? null
      : db.row('SELECT requirements_json FROM run WHERE id=?', String(execution.run_id));
  return decode(run?.requirements_json ?? execution.requirements_json);
}
function live(
  db: SqliteOperations,
  execution: Row,
  owner: Parameters<Store['requestInteraction']>[0]['owner'],
): void {
  db.active(
    owner,
    String(execution.origin_command_id),
    execution.run_id === null ? null : String(execution.run_id),
  );
  db.ancestors(owner, String(execution.id));
  if (execution.origin_store_id !== db.metadata().storeId)
    throw new AgentError('operation_unverifiable');
  if (String(execution.owner_generation) !== owner.generation)
    throw new AgentError('owner_changed');
  if (execution.cancel_requested) throw new AgentError('cancelled_before_dispatch');
  if (!['planned', 'dispatching', 'running'].includes(String(execution.state)))
    throw new AgentError('interaction_not_active');
}
function stopped(db: SqliteOperations, execution: Row): boolean {
  if (!['planned', 'dispatching', 'running'].includes(String(execution.state))) return true;
  let e: Row | null = execution;
  for (let depth = 0; e && depth < 64; depth++) {
    const command = db.row('SELECT cancelled FROM command WHERE id=?', String(e.origin_command_id));
    const run =
      e.run_id === null
        ? null
        : db.row('SELECT cancel_requested FROM run WHERE id=?', String(e.run_id));
    if (e.cancel_requested || command?.cancelled || run?.cancel_requested) return true;
    if (!e.cancel_with_parent || e.parent_execution_id === null) break;
    e = db.row('SELECT * FROM execution WHERE id=?', String(e.parent_execution_id));
  }
  let session = db.row('SELECT * FROM session WHERE id=?', String(execution.session_id));
  for (let depth = 0; session && depth < 64; depth++) {
    if (
      session.delete_requested ||
      (session.stop_boundary !== null &&
        BigInt(String(execution.root_work_seq)) <= BigInt(String(session.stop_boundary)))
    )
      return true;
    if (session.parent_id === null) break;
    session = db.row('SELECT * FROM session WHERE id=?', String(session.parent_id));
  }
  return false;
}
export function verifyInteractionDispatch(
  db: SqliteOperations,
  execution: Row,
  input: DispatchInput,
): void {
  if (execution.interaction_binding_json === null) {
    if (
      input.authorization.interactionId !== undefined ||
      input.authorization.decisionRevision !== undefined
    )
      throw new AgentError('interaction_binding_changed');
    return;
  }
  const ref = decode<{ interactionId: string; decisionRevision: string | null }>(
    execution.interaction_binding_json,
  );
  const row = db.row('SELECT * FROM interaction WHERE id=?', ref.interactionId);
  if (
    row?.kind !== 'approval' ||
    row.state !== 'answered' ||
    row.accepted_decision_revision === null ||
    ref.decisionRevision === null ||
    input.authorization.interactionId !== row.id ||
    input.authorization.decisionRevision !== String(row.accepted_decision_revision) ||
    ref.decisionRevision !== String(row.accepted_decision_revision) ||
    String(row.revision) !== ref.decisionRevision ||
    row.policy_revision !== input.authorization.revision
  )
    throw new AgentError('interaction_decision_required');
  binding(execution, record(row));
  const decision = decode<InteractionAnswer>(row.answer_json);
  if (!('decision' in decision) || decision.decision !== 'approve')
    throw new AgentError('permission_denied');
  if (
    canonicalJson(required(db, execution) as unknown as Json) !== row.required_refs_json ||
    execution.decision_source_json !== row.source_json
  )
    throw new AgentError('interaction_binding_changed');
}
export function callInteraction(db: SqliteOperations, method: string, args: unknown[]): unknown {
  if (method === 'getInteraction' || method === 'listInteractions') {
    const input = args[0] as Parameters<Store['listInteractions']>[0] & { interactionId: string };
    db.db.run('BEGIN');
    try {
      db.identity(input.expectedStoreId);
      const session = db.row('SELECT id FROM session WHERE id=?', input.sessionId);
      if (!session) throw new AgentError('session_not_found');
      let result: unknown;
      if (method === 'getInteraction') {
        const selected = drizzle(db.db)
          .select({ id: interactions.id })
          .from(interactions)
          .where(
            and(
              eq(interactions.id, input.interactionId),
              eq(interactions.originStoreId, input.expectedStoreId),
              or(
                eq(interactions.sessionId, input.sessionId),
                eq(interactions.presentationSessionId, input.sessionId),
              ),
            ),
          )
          .get();
        const row = selected ? db.row('SELECT * FROM interaction WHERE id=?', selected.id) : null;
        result = row ? record(row) : null;
      } else {
        if (
          input.state !== undefined &&
          !['pending', 'answered', 'cancelled'].includes(input.state)
        )
          throw new AgentError('interaction_filter_invalid');
        const limit = input.limit ?? 50;
        if (
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          (input.afterId?.length ?? 0) > 128
        )
          throw new AgentError('interaction_filter_invalid');
        const rows = db.rows(
          `SELECT * FROM interaction WHERE origin_store_id=? AND (session_id=? OR presentation_session_id=?) AND id>?${input.state ? ' AND state=?' : ''} ORDER BY id LIMIT ?`,
          input.expectedStoreId,
          input.sessionId,
          input.sessionId,
          input.afterId ?? '',
          ...(input.state ? [input.state] : []),
          limit + 1,
        );
        result = {
          interactions: rows.slice(0, limit).map(record),
          nextAfterId: rows.length > limit ? String(rows[limit - 1]!.id) : null,
          snapshotCursor: db.metadata().lastChangeCursor,
        };
      }
      db.db.run('COMMIT');
      return result;
    } catch (error) {
      db.db.run('ROLLBACK');
      throw error;
    }
  }
  return db.tx(() => {
    const input = args[0] as Parameters<Store['requestInteraction']>[0] &
      Parameters<Store['answerInteraction']>[0] &
      Parameters<Store['acceptInteractionDecision']>[0];
    db.identity(input.expectedStoreId);
    if (method === 'requestInteraction') {
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(input.interactionId) ||
        !['approval', 'question', 'plan_review'].includes(input.kind) ||
        typeof input.policyRevision !== 'string' ||
        !input.policyRevision ||
        input.policyRevision.length > 256
      )
        throw new AgentError('interaction_invalid');
      bounded(input.request);
      bounded(input.requiredRefs as unknown as Json);
      if (
        input.kind === 'question' &&
        input.request &&
        typeof input.request === 'object' &&
        !Array.isArray(input.request) &&
        input.request.schema !== undefined
      )
        schema(input.request.schema);
      const execution = db.row('SELECT * FROM execution WHERE id=?', input.executionId);
      if (!execution) throw new AgentError('execution_not_found');
      db.owner(input.owner, String(execution.session_id));
      if (String(execution.owner_generation) !== input.owner.generation)
        throw new AgentError('owner_changed');
      binding(execution, input);
      const requestDigest = digest({
        executionId: input.executionId,
        attempt: input.attempt,
        kind: input.kind,
        definitionId: input.definitionId,
        definitionVersion: input.definitionVersion,
        inputDigest: input.inputDigest,
        policyRevision: input.policyRevision,
        requiredRefs: input.requiredRefs as unknown as Json,
        source: input.source,
        request: input.request,
        ...(input.informationPermission
          ? { informationPermission: input.informationPermission as unknown as Json }
          : {}),
      });
      if (input.informationPermission) {
        validateInformationPermission(input.informationPermission);
        if (input.kind === 'approval') throw new AgentError('interaction_kind_invalid');
        verifyHostControlReads(
          db,
          execution,
          input.expectedStoreId,
          input.informationPermission.controlReads,
        );
      }
      const prior = db.row('SELECT * FROM interaction WHERE id=?', input.interactionId);
      if (prior) {
        if (
          prior.request_digest !== requestDigest ||
          prior.origin_store_id !== input.expectedStoreId
        )
          throw new AgentError('interaction_conflict');
        return record(prior);
      }
      live(db, execution, input.owner);
      binding(execution, input);
      if (
        input.kind === 'approval'
          ? execution.state !== 'planned'
          : !['dispatching', 'running'].includes(String(execution.state))
      )
        throw new AgentError('interaction_not_active');
      if (
        canonicalJson(input.source) !== execution.decision_source_json ||
        canonicalJson(input.requiredRefs as unknown as Json) !==
          canonicalJson(required(db, execution) as unknown as Json)
      )
        throw new AgentError('interaction_binding_changed');
      if (
        db.rows(
          "SELECT id FROM interaction WHERE presentation_session_id=? AND state='pending' LIMIT 65",
          input.owner.sessionId,
        ).length >= 64
      )
        throw new AgentError('interaction_limit');
      if (input.kind === 'approval' && execution.interaction_binding_json !== null)
        throw new AgentError('interaction_conflict');
      const session = db.row('SELECT * FROM session WHERE id=?', String(execution.session_id))!;
      const ancestry: string[] = [];
      let cursor: Row | null = session;
      for (let i = 0; cursor && i < 64; i++) {
        ancestry.push(String(cursor.id));
        if (cursor.parent_id === null) break;
        cursor = db.row('SELECT * FROM session WHERE id=?', String(cursor.parent_id));
      }
      if (ancestry.at(-1) !== input.owner.sessionId)
        throw new AgentError('interaction_scope_denied');
      const command = db.row(
        'SELECT subject_id FROM command WHERE id=?',
        String(execution.origin_command_id),
      )!;
      db.run(
        "INSERT INTO interaction(information_permission_json,id,origin_store_id,subject_id,session_id,run_id,execution_id,attempt,presentation_session_id,ancestry_json,kind,definition_id,definition_version,input_digest,policy_revision,required_refs_json,source_json,request_digest,request_json,revision,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'pending')",
        input.informationPermission
          ? canonicalJson(input.informationPermission as unknown as Json)
          : null,
        input.interactionId,
        input.expectedStoreId,
        String(command.subject_id),
        String(execution.session_id),
        execution.run_id === null ? null : String(execution.run_id),
        input.executionId,
        input.attempt,
        input.owner.sessionId,
        canonicalJson(ancestry),
        input.kind,
        input.definitionId,
        input.definitionVersion,
        input.inputDigest,
        input.policyRevision,
        canonicalJson(input.requiredRefs as unknown as Json),
        canonicalJson(input.source),
        requestDigest,
        canonicalJson(input.request),
      );
      if (input.kind === 'approval')
        db.run(
          'UPDATE execution SET interaction_binding_json=? WHERE id=?',
          canonicalJson({ interactionId: input.interactionId, decisionRevision: null }),
          input.executionId,
        );
      if (execution.run_id !== null)
        db.run(
          "UPDATE run SET status='waiting_interaction' WHERE id=? AND is_active=1",
          String(execution.run_id),
        );
      db.event(String(execution.session_id), input.interactionId, 'interaction.requested');
      if (execution.session_id !== input.owner.sessionId)
        db.event(input.owner.sessionId, input.interactionId, 'interaction.projected');
      return record(db.row('SELECT * FROM interaction WHERE id=?', input.interactionId)!);
    }
    const row = db.row('SELECT * FROM interaction WHERE id=?', input.interactionId);
    if (!row || row.origin_store_id !== input.expectedStoreId)
      throw new AgentError('interaction_not_found');
    const execution = db.row('SELECT * FROM execution WHERE id=?', String(row.execution_id))!;
    if (method === 'answerInteraction') {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.commandId)) throw new AgentError('invalid_command');
      decimal(input.expectedRevision);
      if (
        row.presentation_session_id !== input.presentationSessionId ||
        row.subject_id !== input.subjectId
      )
        throw new AgentError('interaction_scope_denied');
      answer(row.kind as InteractionRecord['kind'], input.answer, decode(row.request_json));
      const request: Json = {
        kind: 'interaction.answer',
        interactionId: input.interactionId,
        expectedRevision: input.expectedRevision,
        answer: input.answer as unknown as Json,
      };
      const requestDigest = digest(request);
      const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
      if (prior) {
        if (
          prior.origin_store_id !== input.expectedStoreId ||
          prior.session_id !== input.presentationSessionId ||
          prior.subject_id !== input.subjectId ||
          prior.request_digest !== requestDigest
        )
          throw new AgentError('command_conflict');
        return db.command(prior);
      }
      if (row.answer_json !== null) {
        if (row.answer_json !== canonicalJson(input.answer as unknown as Json))
          throw new AgentError('interaction_answer_conflict');
      } else {
        if (String(row.revision) !== input.expectedRevision)
          throw new AgentError('interaction_revision_conflict');
        if (decimal(String(row.revision)) === 9223372036854775807n)
          throw new AgentError('sequence_exhausted');
        db.run(
          'UPDATE interaction SET answer_json=?,revision=revision+1,state=? WHERE id=?',
          canonicalJson(input.answer as unknown as Json),
          row.state === 'cancelled' || stopped(db, execution) ? 'cancelled' : 'answered',
          input.interactionId,
        );
      }
      const updated = db.row('SELECT * FROM interaction WHERE id=?', input.interactionId)!;
      db.allocateSessionSequence(input.presentationSessionId);
      const seq = db.row(
        'SELECT next_seq FROM session WHERE id=?',
        input.presentationSessionId,
      )!.next_seq;
      db.run(
        "INSERT INTO command(id,session_id,seq,kind,subject_id,request_digest,request_json,status,receipt_json,origin_store_id,root_work_command_id,root_work_seq) VALUES(?,?,?,'interaction.answer',?,?,?,'applied',?,?,?,?)",
        input.commandId,
        input.presentationSessionId,
        seq,
        input.subjectId,
        requestDigest,
        canonicalJson(request),
        canonicalJson({
          interactionId: input.interactionId,
          decisionRevision: String(updated.revision),
          outcome: 'answer_saved',
          cancelled: updated.state === 'cancelled',
        }),
        input.expectedStoreId,
        String(execution.root_work_command_id),
        String(execution.root_work_seq),
      );
      db.event(String(row.session_id), input.interactionId, 'interaction.answered');
      if (row.session_id !== row.presentation_session_id)
        db.event(String(row.presentation_session_id), input.interactionId, 'interaction.answered');
      return db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
    }
    if (method !== 'acceptInteractionDecision') throw new AgentError('unknown_store_method');
    live(db, execution, input.owner);
    binding(execution, input);
    if (row.information_permission_json !== null && row.information_permission_json !== undefined) {
      if (
        !input.informationPermission ||
        canonicalJson(input.informationPermission as unknown as Json) !==
          row.information_permission_json
      )
        throw new AgentError('information_permission_changed');
      validateInformationPermission(input.informationPermission);
      verifyHostControlReads(
        db,
        execution,
        input.expectedStoreId,
        input.informationPermission.controlReads,
      );
    } else if (input.informationPermission) throw new AgentError('information_permission_changed');
    if (
      row.execution_id !== input.executionId ||
      Number(row.attempt) !== input.attempt ||
      row.policy_revision !== input.policyRevision ||
      row.state !== 'answered' ||
      row.answer_json === null ||
      String(row.revision) !== input.decisionRevision
    )
      throw new AgentError('interaction_binding_changed');
    if (
      !input.freshness.checked ||
      canonicalJson(input.freshness.source) !== row.source_json ||
      execution.decision_source_json !== row.source_json
    )
      throw new AgentError('context_refresh_required');
    if (canonicalJson(required(db, execution) as unknown as Json) !== row.required_refs_json)
      throw new AgentError('interaction_binding_changed');
    if (row.kind === 'approval')
      db.requirements(
        decode(row.required_refs_json),
        input.requirements,
        'dispatch',
        String(execution.id),
      );
    else
      for (const ref of decode<RequirementRef[]>(row.required_refs_json)) {
        const current = db.row(
          "SELECT revision,origin_store_id FROM extension_record WHERE fork_provenance_json IS NULL AND extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
          ref.extensionId,
          ref.sessionId,
          ref.recordKey,
        );
        if (
          !current ||
          String(current.revision) !== ref.revision ||
          current.origin_store_id !== ref.originStoreId ||
          ref.originStoreId !== input.expectedStoreId
        )
          throw new AgentError('interaction_binding_changed');
      }
    if (
      row.accepted_decision_revision !== null &&
      String(row.accepted_decision_revision) !== input.decisionRevision
    )
      throw new AgentError('interaction_conflict');
    if (row.accepted_decision_revision !== null) return record(row);
    db.run(
      'UPDATE interaction SET accepted_decision_revision=? WHERE id=?',
      input.decisionRevision,
      input.interactionId,
    );
    savePermissionGrant(db, row, execution);
    if (row.kind === 'approval')
      db.run(
        'UPDATE execution SET interaction_binding_json=? WHERE id=?',
        canonicalJson({
          interactionId: input.interactionId,
          decisionRevision: input.decisionRevision,
        }),
        input.executionId,
      );
    if (
      execution.run_id !== null &&
      !db.row(
        "SELECT id FROM interaction WHERE run_id=? AND (state='pending' OR (state='answered' AND accepted_decision_revision IS NULL)) LIMIT 1",
        String(execution.run_id),
      )
    )
      db.run(
        "UPDATE run SET status='running' WHERE id=? AND is_active=1 AND status='waiting_interaction'",
        String(execution.run_id),
      );
    db.event(String(row.session_id), input.interactionId, 'interaction.accepted');
    if (row.session_id !== row.presentation_session_id)
      db.event(String(row.presentation_session_id), input.interactionId, 'interaction.accepted');
    return record(db.row('SELECT * FROM interaction WHERE id=?', input.interactionId)!);
  });
}

function validateInformationPermission(value: import('../types').InformationPermissionStamp): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['revision', 'bindingDigest', 'controlReads'].includes(key),
    ) ||
    typeof value.revision !== 'string' ||
    !value.revision ||
    value.revision.length > 256 ||
    typeof value.bindingDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.bindingDigest)
  )
    throw new AgentError('information_permission_invalid');
}
