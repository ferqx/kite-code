import Ajv from 'ajv';
import { canonicalJson } from '../../json';
import type { EnsureOperationInput } from '../port';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';
import { registerRunRequirementsWork } from './requirement-operations';

const validators = new Map<string, import('ajv').ValidateFunction>();
export function prepareResultRequirement(input: EnsureOperationInput): void {
  if (!input.resultRequirement) return;
  if (!input.resultRequirementSchema) throw new AgentError('invalid_result_requirement');
  const key = canonicalJson(input.resultRequirementSchema);
  if (Buffer.byteLength(key) > 32768) throw new AgentError('invalid_result_requirement');
  if (validators.has(key)) return;
  try {
    const validator = new Ajv({ strict: false }).compile(input.resultRequirementSchema as object);
    if (validators.size >= 64) validators.delete(validators.keys().next().value!);
    validators.set(key, validator);
  } catch {
    throw new AgentError('invalid_result_requirement');
  }
}

/** The declaration supplies only names; all execution authority comes from this committed parent. */
export function sealResultRequirement(
  db: SqliteOperations,
  input: EnsureOperationInput,
  executionId: string,
): void {
  const declared = input.resultRequirement;
  if (!declared) {
    if (input.resultRequirementSchema !== undefined)
      throw new AgentError('invalid_result_requirement');
    return;
  }
  if (
    Object.keys(declared).some(
      (key) =>
        ![
          'recordKey',
          'requirementId',
          'definitionVersion',
          'contentType',
          'contentVersion',
        ].includes(key),
    ) ||
    !Number.isSafeInteger(declared.contentVersion) ||
    declared.contentVersion < 1
  )
    throw new AgentError('invalid_result_requirement');
  for (const text of [
    declared.recordKey,
    declared.requirementId,
    declared.definitionVersion,
    declared.contentType,
  ])
    if (typeof text !== 'string' || !text || text.length > 256)
      throw new AgentError('invalid_result_requirement');
  const parent = db.row(
    'SELECT * FROM execution WHERE id=? AND session_id=?',
    input.parentExecutionId,
    input.sessionId,
  );
  const job = db.row(
    'SELECT * FROM execution WHERE id=? AND origin_command_id IS NOT NULL',
    executionId,
  );
  if (
    !parent ||
    parent.run_id === null ||
    !job ||
    job.kind !== 'job' ||
    job.parent_execution_id !== parent.id ||
    job.origin_store_id !== input.expectedStoreId
  )
    throw new AgentError('result_requirement_scope_mismatch');
  const run = db.row(
    'SELECT * FROM run WHERE id=? AND session_id=?',
    parent.run_id!,
    input.sessionId,
  );
  if (!run?.is_active || !declared.recordKey.startsWith(`run/${run.id}/`))
    throw new AgentError('result_requirement_scope_mismatch');
  const value: Json = {
    kind: 'operation_result',
    executionId,
    sessionId: input.sessionId,
    runId: String(run.id),
    parentExecutionId: input.parentExecutionId,
    originStoreId: input.expectedStoreId,
    originCommandId: String(job.origin_command_id),
    rootWorkCommandId: String(job.root_work_command_id),
    rootWorkSeq: String(job.root_work_seq),
    contextSelectionId: String(job.context_selection_id),
  };
  if (
    !input.resultRequirementSchema ||
    Buffer.byteLength(canonicalJson(input.resultRequirementSchema)) > 32768
  )
    throw new AgentError('invalid_result_requirement');
  try {
    if (!validators.get(canonicalJson(input.resultRequirementSchema))?.(value))
      throw new AgentError('invalid_result_requirement');
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('invalid_result_requirement');
  }
  if (
    db.row(
      "SELECT key FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      input.extensionId,
      input.sessionId,
      declared.recordKey,
    )
  )
    throw new AgentError('record_revision_conflict');
  db.run(
    "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES(?,'session',?,?,1,?,?,?,?)",
    input.extensionId,
    input.sessionId,
    declared.recordKey,
    declared.contentType,
    declared.contentVersion,
    input.expectedStoreId,
    canonicalJson(value),
  );
  registerRunRequirementsWork(db, {
    expectedStoreId: input.expectedStoreId,
    owner: input.owner,
    runId: String(run.id),
    requirements: [
      {
        evaluationProvider: 'extension',
        extensionId: input.extensionId,
        requirementId: declared.requirementId,
        definitionVersion: declared.definitionVersion,
        recordKey: declared.recordKey,
        revision: '1',
        phase: 'completion',
        sessionId: input.sessionId,
        runId: String(run.id),
        originStoreId: input.expectedStoreId,
      },
    ],
  });
  db.event(input.sessionId, declared.recordKey, 'extension.record_written');
}
