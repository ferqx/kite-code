import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json, type RequirementRef, type RunRecord } from '../types';
import type { SqliteOperations } from './operations';

function key(ref: RequirementRef): string {
  return canonicalJson([
    ref.extensionId,
    ref.requirementId,
    ref.sessionId,
    ref.runId,
    ref.executionId ?? null,
    ref.attempt ?? null,
  ]);
}
function validate(ref: RequirementRef): void {
  const fields = [
    'originStoreId',
    'evaluationProvider',
    'extensionId',
    'definitionVersion',
    'requirementId',
    'revision',
    'phase',
    'sessionId',
    'runId',
    'executionId',
    'attempt',
    'recordKey',
  ];
  if (
    !ref ||
    typeof ref !== 'object' ||
    Array.isArray(ref) ||
    Object.keys(ref).some((field) => !fields.includes(field)) ||
    !/^[A-Za-z0-9_.-]{1,128}$/.test(ref.extensionId) ||
    !['dispatch', 'completion', 'both'].includes(ref.phase) ||
    (ref.evaluationProvider !== undefined && ref.evaluationProvider !== 'extension')
  )
    throw new AgentError('invalid_requirement');
  for (const value of [
    ref.definitionVersion,
    ref.requirementId,
    ref.sessionId,
    ref.runId,
    ref.recordKey,
  ])
    if (typeof value !== 'string' || value.length < 1 || value.length > 256)
      throw new AgentError('invalid_requirement');
  if (
    typeof ref.revision !== 'string' ||
    !/^[1-9][0-9]*$/.test(ref.revision) ||
    BigInt(ref.revision) > 9223372036854775807n ||
    (ref.executionId !== undefined &&
      (typeof ref.executionId !== 'string' || !ref.executionId || ref.executionId.length > 256)) ||
    (ref.attempt !== undefined &&
      (!Number.isSafeInteger(ref.attempt) || ref.attempt < 1 || ref.executionId === undefined)) ||
    (ref.originStoreId !== undefined &&
      (typeof ref.originStoreId !== 'string' ||
        !ref.originStoreId ||
        ref.originStoreId.length > 256))
  )
    throw new AgentError('invalid_requirement');
}
export function registerRunRequirements(
  db: SqliteOperations,
  input: Parameters<Store['registerRunRequirements']>[0],
): RunRecord {
  return db.tx(() => registerRunRequirementsWork(db, input));
}
export function registerRunRequirementsWork(
  db: SqliteOperations,
  input: Parameters<Store['registerRunRequirements']>[0],
): RunRecord {
  db.identity(input.expectedStoreId);
  if (
    !Array.isArray(input.requirements) ||
    input.requirements.length > 64 ||
    Buffer.byteLength(canonicalJson(input.requirements as unknown as Json)) > 32 * 1024
  )
    throw new AgentError('requirement_limit');
  const run = db.row('SELECT * FROM run WHERE id=?', input.runId);
  if (!run) throw new AgentError('run_not_found');
  db.active(input.owner, String(run.origin_command_id), input.runId);
  if (run.origin_store_id !== input.expectedStoreId) throw new AgentError('operation_unverifiable');
  if (input.initialize) {
    if (run.initialization_state !== 'started')
      throw new AgentError('run_initialization_state_changed');
    db.run("UPDATE run SET initialization_state='completed' WHERE id=?", run.id!);
    db.event(String(run.session_id), String(run.id), 'run.requirements_initialized');
  }
  const refs = JSON.parse(String(run.requirements_json)) as RequirementRef[];
  let changed = false;
  for (const requested of input.requirements) {
    validate(requested);
    if (requested.sessionId !== run.session_id || requested.runId !== run.id)
      throw new AgentError('requirement_scope_mismatch');
    if (requested.executionId !== undefined) {
      const execution = db.row(
        'SELECT * FROM execution WHERE id=? AND session_id=? AND run_id=?',
        requested.executionId,
        requested.sessionId,
        requested.runId,
      );
      if (
        !execution ||
        (requested.attempt !== undefined &&
          BigInt(requested.attempt) !== BigInt(execution.attempt!))
      )
        throw new AgentError('requirement_scope_mismatch');
      if (execution.state === 'outcome_unknown') throw new AgentError('operation_unverifiable');
      if (
        execution.origin_store_id !== input.expectedStoreId ||
        String(execution.owner_generation) !== input.owner.generation
      )
        throw new AgentError('operation_unverifiable');
      db.ancestors(input.owner, requested.executionId);
    }
    const previous = refs.find((old) => key(old) === key(requested));
    if (previous) {
      if (previous.originStoreId === undefined) throw new AgentError('operation_unverifiable');
      if (
        requested.originStoreId !== undefined &&
        requested.originStoreId !== previous.originStoreId
      )
        throw new AgentError('operation_unverifiable');
      const retry = { ...requested, originStoreId: previous.originStoreId };
      if (canonicalJson(previous as unknown as Json) !== canonicalJson(retry as unknown as Json))
        throw new AgentError('requirement_conflict');
      continue;
    }
    const record = db.row(
      "SELECT revision,origin_store_id FROM extension_record WHERE fork_provenance_json IS NULL AND extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      requested.extensionId,
      requested.sessionId,
      requested.recordKey,
    );
    if (!record || String(record.revision) !== requested.revision)
      throw new AgentError('record_revision_conflict');
    if (
      record.origin_store_id === null ||
      record.origin_store_id !== input.expectedStoreId ||
      (requested.originStoreId !== undefined && requested.originStoreId !== record.origin_store_id)
    )
      throw new AgentError('operation_unverifiable');
    const ref: RequirementRef = { ...requested, originStoreId: String(record.origin_store_id) };
    refs.push(ref);
    changed = true;
  }
  if (refs.length > 64 || Buffer.byteLength(canonicalJson(refs as unknown as Json)) > 32 * 1024)
    throw new AgentError('requirement_limit');
  if (changed) {
    db.run(
      'UPDATE run SET requirements_json=? WHERE id=?',
      canonicalJson(refs as unknown as Json),
      input.runId,
    );
    db.event(String(run.session_id), input.runId, 'run.requirements_registered');
  }
  return db.runRecord(db.row('SELECT * FROM run WHERE id=?', input.runId)!);
}
