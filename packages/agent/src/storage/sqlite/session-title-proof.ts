import { createHash } from 'node:crypto';
import { originalTitleSource } from '../../business/session-title/source';
import {
  automaticTitleIdentity,
  automaticTitleRecord,
  readAutomaticTitleAttempt,
  titleDigest,
} from '../../business/session-title/state';
import { fallbackSessionTitle } from '../../business/session-title/title';
import { canonicalJson } from '../../json';
import { AgentError, type Json } from '../types';
import { record } from './extension-operations';
import type { SqliteOperations } from './operations';

export type TitleRow = Record<string, string | number | bigint | null>;
export const titleHash = (value: Json) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export function titleObject(value: unknown): Record<string, Json> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}
const parse = (value: TitleRow[string] | undefined) => titleObject(JSON.parse(String(value)));

export function readTitleClaim(
  db: SqliteOperations,
  input: {
    expectedStoreId: string;
    sessionId: string;
    sourceCommandId?: string;
    subjectId?: string;
  },
) {
  db.identity(input.expectedStoreId);
  const row = db.row(
    "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    automaticTitleRecord.extensionId,
    input.sessionId,
    automaticTitleRecord.key,
  );
  if (!row) return null;
  const savedRecord = record(row);
  if (savedRecord.originStoreId !== input.expectedStoreId || row.fork_provenance_json !== null)
    return null;
  const attempt = readAutomaticTitleAttempt(savedRecord.value);
  if (
    !attempt ||
    savedRecord.contentType !== automaticTitleRecord.contentType ||
    savedRecord.contentVersion !== 1 ||
    attempt.manualRenameCommandId !== null
  )
    throw new AgentError('session_title_attempt_invalid');
  if (input.sourceCommandId !== undefined && attempt.sourceCommandId !== input.sourceCommandId)
    return null;
  const source = db.row('SELECT * FROM command WHERE id=?', attempt.sourceCommandId);
  const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (
    !source ||
    !session ||
    session.parent_id !== null ||
    source.session_id !== input.sessionId ||
    source.origin_store_id !== input.expectedStoreId ||
    (input.subjectId !== undefined && source.subject_id !== input.subjectId) ||
    !['run.start', 'input.follow_up'].includes(String(source.kind))
  )
    throw new AgentError('session_title_source_invalid');
  const request = parse(source.request_json);
  if (typeof request.content !== 'string' || titleHash(request) !== source.request_digest)
    throw new AgentError('session_title_source_invalid');
  const creator = db.row(
    "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
    input.sessionId,
  );
  if (creator?.subject_id !== source.subject_id) throw new AgentError('permission_denied');
  const identity = automaticTitleIdentity(
    input.expectedStoreId,
    input.sessionId,
    attempt.sourceCommandId,
  );
  const fallback = db.row('SELECT * FROM command WHERE id=?', identity.fallbackCommandId);
  const savedRequest = fallback ? parse(fallback.request_json) : {},
    receipt = fallback ? parse(fallback.receipt_json) : {};
  const snapshot = titleObject(receipt.session);
  if (
    !fallback ||
    fallback.extension_id !== automaticTitleRecord.extensionId ||
    fallback.scope_kind !== 'session' ||
    fallback.scope_id !== input.sessionId ||
    fallback.operation_key !== `fallback/${identity.operationKey.slice(9)}` ||
    fallback.kind !== 'session.rename' ||
    fallback.status !== 'applied' ||
    fallback.session_id !== input.sessionId ||
    fallback.origin_store_id !== input.expectedStoreId ||
    fallback.subject_id !== source.subject_id ||
    savedRequest.kind !== 'session.rename' ||
    savedRequest.title !== fallbackSessionTitle(request.content) ||
    attempt.fallbackDigest !== titleDigest(fallbackSessionTitle(request.content)) ||
    fallback.request_digest !== titleHash(savedRequest) ||
    receipt.outcome !== 'renamed' ||
    snapshot.id !== input.sessionId ||
    snapshot.title !== savedRequest.title ||
    snapshot.controlRevision !== savedRequest.ifRevision
  )
    throw new AgentError('session_title_attempt_invalid');
  return { record: savedRecord, attempt, identity, source, session, fallback };
}

/** Exact immutable default Job lineage. No self-reported purpose grants this proof. */
export function readTitleJob(
  db: SqliteOperations,
  input: {
    expectedStoreId: string;
    sessionId: string;
    jobExecutionId: string;
  },
) {
  const claim = readTitleClaim(db, input);
  if (!claim) throw new AgentError('session_title_attempt_invalid');
  const job = db.row('SELECT * FROM execution WHERE id=?', input.jobExecutionId);
  const operation = job && db.row('SELECT * FROM command WHERE id=?', job.origin_command_id!);
  const parent =
    job?.parent_execution_id &&
    db.row('SELECT * FROM execution WHERE id=?', job.parent_execution_id);
  const action = parent && db.row('SELECT * FROM command WHERE id=?', parent.origin_command_id!);
  if (!job || !operation || !parent || !action) throw new AgentError('session_title_job_invalid');
  const intent = parse(job.intent_json),
    actionInput = parse(parent.intent_json);
  const commandId = intent.commandId;
  const business =
    typeof commandId === 'string' ? db.row('SELECT * FROM command WHERE id=?', commandId) : null;
  const same = (row: TitleRow) =>
    row.session_id === input.sessionId && row.origin_store_id === input.expectedStoreId;
  const actionRequest = parse(action.request_json),
    operationRequest = parse(operation.request_json);
  const actionReceipt = parse(action.receipt_json),
    operationReceipt = parse(operation.receipt_json);
  const decision = parse(parent.decision_source_json);
  if (
    !business ||
    [job, operation, parent, action, business].some((row) => !same(row)) ||
    [operation, action, business].some((row) => row.subject_id !== claim.source.subject_id) ||
    job.kind !== 'job' ||
    job.adapter_id !== 'builtin.session-title/generate' ||
    job.definition_version !== '1' ||
    job.run_id !== null ||
    job.child_session_id !== null ||
    job.child_configuration_json !== null ||
    job.cancel_with_parent ||
    job.requirements_json !== '[]' ||
    job.root_session_id !== input.sessionId ||
    Object.keys(intent).length !== 1 ||
    Object.keys(actionInput).length !== 1 ||
    parent.kind !== 'job' ||
    parent.adapter_id !== 'builtin.session-title/fallback' ||
    parent.definition_version !== '1' ||
    parent.run_id !== null ||
    parent.parent_execution_id !== null ||
    parent.child_session_id !== null ||
    parent.child_configuration_json !== null ||
    !parent.dispatched ||
    action.kind !== 'extension.invoke' ||
    action.status !== 'applied' ||
    action.root_work_command_id !== action.id ||
    action.root_work_seq !== action.seq ||
    action.id !==
      `lifecycle-${titleHash({ phase: 'before_start', commandId: String(business.id), extensionId: automaticTitleRecord.extensionId })}` ||
    actionRequest.kind !== 'extension.invoke' ||
    actionRequest.extensionId !== automaticTitleRecord.extensionId ||
    actionRequest.actionId !== 'fallback' ||
    actionRequest.definitionVersion !== '1' ||
    canonicalJson(actionRequest.input ?? null) !== canonicalJson(actionInput) ||
    actionInput.commandId !== business.id ||
    decision.kind !== 'action_decision' ||
    decision.commandId !== action.id ||
    decision.extensionId !== automaticTitleRecord.extensionId ||
    decision.actionId !== 'fallback' ||
    decision.definitionVersion !== '1' ||
    decision.preparedDigest !== titleHash(actionInput) ||
    actionReceipt.executionId !== parent.id ||
    operation.kind !== 'operation.job' ||
    operation.status !== 'applied' ||
    operation.extension_id !== automaticTitleRecord.extensionId ||
    operation.scope_kind !== 'session' ||
    operation.scope_id !== input.sessionId ||
    operation.operation_key !== claim.identity.operationKey ||
    operationRequest.kind !== 'operation.job' ||
    operationRequest.definitionId !== job.adapter_id ||
    operationRequest.definitionVersion !== '1' ||
    canonicalJson(operationRequest.input ?? null) !== canonicalJson(intent) ||
    operationRequest.parentExecutionId !== parent.id ||
    operationRequest.extensionId !== automaticTitleRecord.extensionId ||
    operationRequest.operationKey !== claim.identity.operationKey ||
    operationRequest.cancellation !== 'detached' ||
    operationReceipt.executionId !== job.id ||
    operationReceipt.commandId !== operation.id ||
    job.owner_generation !== parent.owner_generation ||
    job.root_session_id !== parent.root_session_id ||
    job.root_work_command_id !== parent.root_work_command_id ||
    job.root_work_seq !== parent.root_work_seq ||
    operation.root_work_command_id !== parent.root_work_command_id ||
    operation.root_work_seq !== parent.root_work_seq ||
    action.root_work_command_id !== parent.root_work_command_id ||
    action.root_work_seq !== parent.root_work_seq ||
    job.decision_source_json !== parent.decision_source_json ||
    titleHash(actionRequest) !== action.request_digest ||
    titleHash(operationRequest) !== operation.request_digest
  )
    throw new AgentError('session_title_job_invalid');
  const lookup = originalTitleSource(db.command(business));
  let step = lookup.next();
  while (!step.done) {
    const row = db.row('SELECT * FROM command WHERE id=?', step.value);
    if (row && titleHash(JSON.parse(String(row.request_json)) as Json) !== row.request_digest)
      throw new AgentError('session_title_source_invalid');
    step = lookup.next(row ? db.command(row) : null);
  }
  if (
    titleHash(JSON.parse(String(business.request_json)) as Json) !== business.request_digest ||
    step.value?.id !== claim.source.id
  )
    throw new AgentError('session_title_source_invalid');
  return { ...claim, job, operation, parent, action, business };
}
