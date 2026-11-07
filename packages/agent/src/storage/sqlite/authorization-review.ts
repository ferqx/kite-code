import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import { bodyReference } from '../../model-body';
import { selectedApprovalOption } from '../../permission-grants';
import {
  AgentError,
  type ArtifactReference,
  type ExecutionAuthorizationObservation,
  type ExecutionStatus,
  type Json,
} from '../types';
import { authorizationCheckFact } from './authorization-check';
import { authorizationPolicyObservation } from './authorization-policy-evidence';
import { verifyModelBody } from './model-body';
import type { SqliteOperations } from './operations';

const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const object = (value: Json): Record<string, Json> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('authorization_check_unverifiable');
  return value;
};
type Row = Record<string, string | number | bigint | null>;
export function decisionContext(
  db: SqliteOperations,
  target: Record<string, string | number | bigint | null>,
): Json {
  const source = object(JSON.parse(String(target.decision_source_json)));
  if (typeof source.modelExecutionId !== 'string') return null;
  const model = db.row('SELECT * FROM execution WHERE id=?', source.modelExecutionId);
  if (
    model?.kind !== 'model' ||
    model.state !== 'succeeded' ||
    model.session_id !== target.session_id ||
    model.origin_store_id !== target.origin_store_id ||
    model.root_work_command_id !== target.root_work_command_id ||
    model.root_work_seq !== target.root_work_seq
  )
    throw new AgentError('authorization_review_context_unverifiable');
  const intent = object(JSON.parse(String(model.intent_json)));
  verifyModelBody(db, intent, model);
  if (!Array.isArray(intent.messages) && !intent.body)
    throw new AgentError('authorization_review_context_unverifiable');
  return intent.body
    ? { modelExecutionId: source.modelExecutionId, modelInput: intent }
    : { modelExecutionId: source.modelExecutionId, messages: intent.messages! };
}
/** An exact public human card permits only its original check request Artifact. */
export function isHumanBoundReviewRequest(
  db: SqliteOperations,
  reference: ArtifactReference,
): boolean {
  if (!reference.id.startsWith('model-body-')) return false;
  const candidates = db.rows(
    `SELECT i.* FROM interaction i
     WHERE i.session_id=? AND i.subject_id=? AND i.origin_store_id=? AND i.kind='approval'
       AND json_extract(i.request_json,'$.policy.check.reference.id')=?`,
    reference.sessionId,
    reference.subjectId,
    reference.storeId,
    reference.id,
  );
  for (const human of candidates) {
    try {
      const target = db.row('SELECT * FROM execution WHERE id=?', human.execution_id!);
      const request = object(JSON.parse(String(human.request_json)));
      const policy = object(request.policy!);
      const review = object(policy.check!);
      const binding = target?.interaction_binding_json
        ? object(JSON.parse(String(target.interaction_binding_json)))
        : undefined;
      if (
        !target ||
        binding?.interactionId !== human.id ||
        human.origin_store_id !== target.origin_store_id ||
        human.session_id !== target.session_id ||
        human.run_id !== target.run_id ||
        human.presentation_session_id !== target.root_session_id ||
        human.attempt !== target.attempt ||
        human.definition_id !== target.adapter_id ||
        human.definition_version !== target.definition_version ||
        human.input_digest !== hash(JSON.parse(String(target.intent_json))) ||
        human.source_json !== target.decision_source_json ||
        human.information_permission_json !== null ||
        human.request_digest !==
          hash({
            executionId: String(human.execution_id),
            attempt: Number(human.attempt),
            kind: 'approval',
            definitionId: String(human.definition_id),
            definitionVersion: String(human.definition_version),
            inputDigest: String(human.input_digest),
            policyRevision: String(human.policy_revision),
            requiredRefs: JSON.parse(String(human.required_refs_json)),
            source: JSON.parse(String(human.source_json)),
            request,
          }) ||
        canonicalJson(review) !==
          canonicalJson({
            kind: 'artifact',
            complete: true,
            reference: {
              id: reference.id,
              mediaType: reference.mediaType,
              size: reference.size,
              scope: reference.scope,
            },
          })
      )
        continue;
      const reviews = db.rows(
        `SELECT e.id,c.kind FROM execution e JOIN command c ON c.id=e.origin_command_id
         WHERE e.parent_execution_id=? AND c.kind='authorization.check'`,
        target.id!,
      );
      for (const carrier of reviews) {
        try {
          const verified = authorizationCheckFact(
            db,
            String(target.id),
            String(carrier.id),
            String(human.policy_revision),
            true,
          );
          const body = bodyReference(verified.payload.requestBody);
          if (
            body &&
            canonicalJson(body.reference as unknown as Json) ===
              canonicalJson(reference as unknown as Json)
          )
            return true;
        } catch {
          // An earlier policy/carrier cannot hide a later exact public binding.
        }
      }
    } catch {
      // A malformed, stale, or unrelated card supplies no public read authority.
    }
  }
  return false;
}

/** Display facts from new checks and frozen human decisions; never reinterpret output. */
export function executionAuthorizationObservation(
  db: SqliteOperations,
  target: Row,
): ExecutionAuthorizationObservation | undefined {
  if (!['tool', 'job'].includes(String(target.kind))) return;
  const observed: ExecutionAuthorizationObservation = { dispatched: Boolean(target.dispatched) };
  const policy = authorizationPolicyObservation(db, target);
  if (policy) observed.policy = policy;
  try {
    const dispatch = target.dispatch_authorization_json
      ? object(JSON.parse(String(target.dispatch_authorization_json)))
      : undefined;
    const pointer = dispatch?.checkExecutionId;
    const checks =
      typeof pointer === 'string'
        ? db.rows(
            "SELECT e.* FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE c.kind='authorization.check' AND e.parent_execution_id=? AND e.id=?",
            target.id!,
            pointer,
          )
        : db.rows(
            "SELECT e.* FROM execution e JOIN command c ON c.id=e.origin_command_id WHERE c.kind='authorization.check' AND e.parent_execution_id=? LIMIT 2",
            target.id!,
          );
    if (checks.length === 1) {
      const check = checks[0]!,
        command = db.row('SELECT request_json FROM command WHERE id=?', check.origin_command_id!)!;
      const payload = object(object(JSON.parse(String(command.request_json))).input!);
      const value = authorizationCheckFact(
        db,
        String(target.id),
        String(check.id),
        String(payload.policyRevision),
        true,
      );
      observed.check = {
        executionId: String(check.id),
        status: check.state as ExecutionStatus,
        decision: value.result.decision,
        reason: value.result.reason,
        requireApproval: payload.requireApproval === true,
      };
    }
  } catch {
    /* An ambiguous or corrupt check supplies no display proof. */
  }
  try {
    const binding = target.interaction_binding_json
      ? object(JSON.parse(String(target.interaction_binding_json)))
      : undefined;
    const human =
      typeof binding?.interactionId === 'string'
        ? db.row('SELECT * FROM interaction WHERE id=?', binding.interactionId)
        : null;
    if (
      human &&
      human.kind === 'approval' &&
      human.execution_id === target.id &&
      human.origin_store_id === target.origin_store_id &&
      human.session_id === target.session_id &&
      human.run_id === target.run_id &&
      human.attempt === target.attempt &&
      human.definition_id === target.adapter_id &&
      human.definition_version === target.definition_version &&
      human.input_digest === hash(JSON.parse(String(target.intent_json)))
    ) {
      const answer = human.answer_json ? object(JSON.parse(String(human.answer_json))) : undefined;
      observed.human = {
        interactionId: String(human.id),
        state: human.state as 'pending' | 'answered' | 'cancelled',
        revision: String(human.revision),
        acceptedDecisionRevision:
          human.accepted_decision_revision === null
            ? null
            : String(human.accepted_decision_revision),
        accepted:
          human.state === 'answered' &&
          human.accepted_decision_revision !== null &&
          String(human.accepted_decision_revision) === String(human.revision) &&
          binding?.decisionRevision === String(human.accepted_decision_revision),
        decision:
          answer?.kind === 'approval' &&
          (answer.decision === 'approve' || answer.decision === 'deny')
            ? answer.decision
            : null,
        ...(answer?.kind === 'approval' &&
        answer.decision === 'approve' &&
        typeof answer.optionId === 'string'
          ? (() => {
              const option = selectedApprovalOption(
                JSON.parse(String(human.request_json)),
                answer.optionId,
              );
              return {
                optionId: option.optionId,
                optionKind: option.kind,
                presentation: option.presentation,
              };
            })()
          : {}),
      };
    }
  } catch {}
  // The persisted dispatch bit is a complete fact even when no reviewer or
  // human interaction was needed. Recovery must not infer it from Tool output.
  return observed;
}
