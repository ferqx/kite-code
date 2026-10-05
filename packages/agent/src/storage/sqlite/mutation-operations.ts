import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json, type MutationFactPage, type RequirementRef } from '../types';
import type { SqliteOperations } from './operations';

const contentType = 'agent.mutation-policy';
const object = (value: unknown): Record<string, Json> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('mutation_policy_invalid');
  return value as Record<string, Json>;
};
const decode = (value: unknown) => object(JSON.parse(String(value)));
const decimal = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new AgentError('invalid_cursor');
  return BigInt(value);
};
function policy(db: SqliteOperations, storeId: string, ref: RequirementRef) {
  db.identity(storeId);
  const run = db.row('SELECT * FROM run WHERE id=? AND session_id=?', ref.runId, ref.sessionId);
  if (!run || run.origin_store_id !== storeId || ref.originStoreId !== storeId)
    throw new AgentError('operation_unverifiable');
  const refs = JSON.parse(String(run.requirements_json)) as RequirementRef[];
  if (
    !refs.some(
      (value) => canonicalJson(value as unknown as Json) === canonicalJson(ref as unknown as Json),
    )
  )
    throw new AgentError('requirement_scope_mismatch');
  const record = db.row(
    "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    ref.extensionId,
    ref.sessionId,
    ref.recordKey,
  );
  if (
    !record ||
    String(record.revision) !== ref.revision ||
    record.origin_store_id !== storeId ||
    record.content_type !== contentType ||
    Number(record.content_version) !== 1
  )
    throw new AgentError('mutation_policy_invalid');
  const value = decode(record.json);
  if (
    value.kind !== 'mutation_policy' ||
    value.runId !== ref.runId ||
    !Array.isArray(value.definitions) ||
    value.definitions.length > 64 ||
    typeof value.checkDefinitionId !== 'string' ||
    typeof value.checkDefinitionVersion !== 'string'
  )
    throw new AgentError('mutation_policy_invalid');
  return { run, value };
}
function record(db: SqliteOperations, ref: RequirementRef, key: string) {
  const row = db.row(
    "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
    ref.extensionId,
    ref.sessionId,
    key,
  );
  if (
    row &&
    (row.content_type !== contentType ||
      Number(row.content_version) !== 1 ||
      row.origin_store_id !== ref.originStoreId)
  )
    throw new AgentError('mutation_record_unverifiable');
  return row;
}
function save(db: SqliteOperations, ref: RequirementRef, key: string, value: Json) {
  if (Buffer.byteLength(canonicalJson(value)) > 32 * 1024 || key.length > 256)
    throw new AgentError('mutation_limit');
  const prior = record(db, ref, key),
    revision = prior ? BigInt(prior.revision!) + 1n : 1n;
  if (revision > 9223372036854775807n) throw new AgentError('sequence_exhausted');
  db.run(
    "INSERT INTO extension_record(extension_id,scope_kind,scope_id,key,revision,content_type,content_version,origin_store_id,json) VALUES(?,'session',?,?,?,?,1,?,?) ON CONFLICT(extension_id,scope_kind,scope_id,key) DO UPDATE SET revision=excluded.revision,json=excluded.json",
    ref.extensionId,
    ref.sessionId,
    key,
    revision,
    contentType,
    ref.originStoreId!,
    canonicalJson(value),
  );
  db.event(ref.sessionId, `${ref.extensionId}/${key}`, 'extension.record_updated');
}
const prefix = (ref: RequirementRef) => `run/${ref.runId}/mutation/`;
const headKey = (ref: RequirementRef) => `run/${ref.runId}/mutation.current`;
function getHead(db: SqliteOperations, ref: RequirementRef) {
  const row = record(db, ref, headKey(ref));
  const value = row
    ? decode(row.json)
    : { lastSeq: '0', checkedThrough: '0', lastOutcome: null, lastCheckerExecutionId: null };
  if (decimal(value.checkedThrough) > decimal(value.lastSeq))
    throw new AgentError('mutation_record_unverifiable');
  return { row, value };
}
function belongsToRun(
  db: SqliteOperations,
  execution: Record<string, string | number | bigint | null>,
  runId: string,
): boolean {
  let current = execution;
  const seen = new Set<string>();
  for (let depth = 0; depth < 32; depth++) {
    if (seen.has(String(current.id))) throw new AgentError('operation_unverifiable');
    seen.add(String(current.id));
    if (current.run_id !== null) return current.run_id === runId;
    if (!current.parent_execution_id) return false;
    const parent = db.row('SELECT * FROM execution WHERE id=?', current.parent_execution_id);
    if (
      !parent ||
      parent.origin_store_id !== execution.origin_store_id ||
      parent.session_id !== execution.session_id ||
      parent.root_work_command_id !== execution.root_work_command_id ||
      parent.root_work_seq !== execution.root_work_seq
    )
      throw new AgentError('operation_unverifiable');
    current = parent;
  }
  throw new AgentError('operation_unverifiable');
}
export function registerMutationIntent(
  db: SqliteOperations,
  input: Parameters<Store['registerMutationIntent']>[0],
): void {
  db.tx(() => {
    const { run, value } = policy(db, input.expectedStoreId, input.requirement),
      ref = input.requirement;
    db.active(input.owner, String(run.origin_command_id), String(run.id));
    const execution = db.row(
      "SELECT * FROM execution WHERE id=? AND session_id=? AND kind='tool'",
      input.executionId,
      run.session_id!,
    );
    if (
      !execution ||
      !belongsToRun(db, execution, String(run.id)) ||
      execution.origin_store_id !== input.expectedStoreId ||
      String(execution.owner_generation) !== input.owner.generation ||
      execution.state !== 'planned'
    )
      throw new AgentError('mutation_execution_invalid');
    db.ancestors(input.owner, input.executionId);
    if (
      !(value.definitions as Json[]).some((item) => {
        const definition = object(item);
        return (
          definition.id === execution.adapter_id &&
          definition.version === execution.definition_version &&
          Array.isArray(definition.effects) &&
          definition.effects.length > 0
        );
      })
    )
      throw new AgentError('mutation_definition_mismatch');
    const key = `${prefix(ref)}intent/${execution.id}`,
      prior = record(db, ref, key);
    if (prior) {
      if (canonicalJson(decode(prior.json).descriptor!) !== canonicalJson(input.descriptor))
        throw new AgentError('mutation_conflict');
      return;
    }
    const head = getHead(db, ref),
      seq = decimal(head.value.lastSeq) + 1n;
    if (seq > 9223372036854775807n) throw new AgentError('sequence_exhausted');
    save(db, ref, key, {
      executionId: String(execution.id),
      seq: String(seq),
      descriptor: input.descriptor,
    });
    save(db, ref, headKey(ref), { ...head.value, lastSeq: String(seq), lastOutcome: null });
  });
}
/** Enforced again in the final dispatch transaction; a missing callback cannot bypass governance. */
export function assertMutationIntent(
  db: SqliteOperations,
  execution: Record<string, string | number | bigint | null>,
): void {
  const source = decode(execution.decision_source_json);
  if (source.kind === 'completion_decision') {
    const ref = object(source.requirement) as unknown as RequirementRef,
      selected = policy(db, String(execution.origin_store_id), ref);
    const input = decode(execution.intent_json),
      head = getHead(db, ref);
    const parent =
      execution.run_id === null && execution.parent_execution_id
        ? db.row('SELECT * FROM execution WHERE id=?', execution.parent_execution_id)
        : null;
    const rootInput = parent ? decode(parent.intent_json) : input;
    const checker = parent ?? execution;
    if (
      checker.run_id !== ref.runId ||
      checker.session_id !== ref.sessionId ||
      checker.adapter_id !== selected.value.checkDefinitionId ||
      checker.definition_version !== selected.value.checkDefinitionVersion ||
      !head.row ||
      rootInput.headRevision !== String(head.row.revision) ||
      typeof rootInput.mutationExecutionId !== 'string' ||
      !record(db, ref, `${prefix(ref)}intent/${rootInput.mutationExecutionId}`)
    )
      throw new AgentError('mutation_head_changed');
    if (
      parent &&
      (!['dispatching', 'running'].includes(String(parent.state)) ||
        parent.decision_source_json !== execution.decision_source_json ||
        !Array.isArray(selected.value.checkTools) ||
        !selected.value.checkTools.some((item) => {
          const definition = object(item);
          return (
            definition.id === execution.adapter_id &&
            definition.version === execution.definition_version
          );
        }))
    )
      throw new AgentError('mutation_check_invalid');
  }
  if (execution.kind !== 'tool') return;
  const refs =
    execution.run_id === null
      ? (JSON.parse(String(execution.requirements_json ?? '[]')) as RequirementRef[])
      : (JSON.parse(
          String(
            db.row('SELECT requirements_json FROM run WHERE id=?', execution.run_id!)
              ?.requirements_json ?? '[]',
          ),
        ) as RequirementRef[]);
  for (const ref of refs) {
    const row = db.row(
      "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      ref.extensionId,
      ref.sessionId,
      ref.recordKey,
    );
    if (row?.content_type !== contentType) continue;
    const { value } = policy(db, String(execution.origin_store_id), ref);
    if (
      !(value.definitions as Json[]).some((item) => {
        const definition = object(item);
        return (
          definition.id === execution.adapter_id &&
          definition.version === execution.definition_version
        );
      })
    )
      continue;
    if (!record(db, ref, `${prefix(ref)}intent/${execution.id}`))
      throw new AgentError('mutation_intent_missing');
  }
}
/** No copied result authority: settlement reads the exact execution row updated in this transaction. */
export function settleMutation(
  db: SqliteOperations,
  execution: Record<string, string | number | bigint | null>,
): void {
  const refs =
    execution.run_id === null
      ? (JSON.parse(String(execution.requirements_json ?? '[]')) as RequirementRef[])
      : (JSON.parse(
          String(
            db.row('SELECT requirements_json FROM run WHERE id=?', execution.run_id!)
              ?.requirements_json ?? '[]',
          ),
        ) as RequirementRef[]);
  for (const ref of refs) {
    const row = db.row(
      "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND key=?",
      ref.extensionId,
      ref.sessionId,
      ref.recordKey,
    );
    if (
      row?.content_type !== contentType ||
      !record(db, ref, `${prefix(ref)}intent/${execution.id}`)
    )
      continue;
    policy(db, String(execution.origin_store_id), ref);
    const head = getHead(db, ref);
    save(db, ref, `${prefix(ref)}settled/${execution.id}`, {
      executionId: String(execution.id),
      resultRevision: String(execution.result_revision),
      status: String(execution.state),
    });
    save(db, ref, headKey(ref), head.value);
  }
}
function superseding(db: SqliteOperations, ref: RequirementRef, intent: Record<string, Json>) {
  const original = db.row('SELECT * FROM execution WHERE id=?', String(intent.executionId));
  if (original?.state !== 'succeeded') return undefined;
  const candidate = db.row(
    "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND substr(key,1,?)=? AND json_extract(json,'$.descriptor')=? AND CAST(json_extract(json,'$.seq') AS INTEGER)>? ORDER BY CAST(json_extract(json,'$.seq') AS INTEGER) DESC LIMIT 1",
    ref.extensionId,
    ref.sessionId,
    `${prefix(ref)}intent/`.length,
    `${prefix(ref)}intent/`,
    canonicalJson(intent.descriptor!),
    decimal(intent.seq),
  );
  if (!candidate) return undefined;
  if (
    candidate.content_type !== contentType ||
    Number(candidate.content_version) !== 1 ||
    candidate.origin_store_id !== ref.originStoreId
  )
    throw new AgentError('mutation_record_unverifiable');
  const later = decode(candidate.json),
    execution = db.row('SELECT * FROM execution WHERE id=?', String(later.executionId));
  if (execution?.state !== 'succeeded') return undefined;
  if (
    !belongsToRun(db, execution, ref.runId) ||
    execution.session_id !== ref.sessionId ||
    execution.origin_store_id !== ref.originStoreId
  )
    throw new AgentError('operation_unverifiable');
  try {
    const oldBody = object(JSON.parse(String(decode(original.result_json).content))),
      newBody = object(JSON.parse(String(decode(execution.result_json).content))),
      hash = object(newBody.baseline).hash;
    if (
      oldBody.path !== newBody.path ||
      typeof hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(hash) ||
      typeof object(oldBody.baseline).hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(String(object(oldBody.baseline).hash))
    )
      return undefined;
    return { executionId: String(execution.id), seq: String(later.seq), hash };
  } catch {
    return undefined;
  }
}
export function listMutationFacts(
  db: SqliteOperations,
  input: Parameters<Store['listMutationFacts']>[0],
): MutationFactPage {
  db.db.run('BEGIN');
  try {
    policy(db, input.expectedStoreId, input.requirement);
    const ref = input.requirement,
      after = decimal(input.afterSeq ?? '0'),
      head = getHead(db, ref),
      high = decimal(head.value.lastSeq);
    if (after > high) throw new AgentError('cursor_ahead');
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      throw new AgentError('invalid_page_limit');
    const rows = db.rows(
      "SELECT * FROM extension_record WHERE extension_id=? AND scope_kind='session' AND scope_id=? AND substr(key,1,?)=? AND CAST(json_extract(json,'$.seq') AS INTEGER)>? ORDER BY CAST(json_extract(json,'$.seq') AS INTEGER) LIMIT ?",
      ref.extensionId,
      ref.sessionId,
      `${prefix(ref)}intent/`.length,
      `${prefix(ref)}intent/`,
      after,
      limit,
    );
    const facts = rows.map((row) => {
      if (
        row.content_type !== contentType ||
        Number(row.content_version) !== 1 ||
        row.origin_store_id !== input.expectedStoreId
      )
        throw new AgentError('mutation_record_unverifiable');
      const intent = decode(row.json),
        execution = db.row('SELECT * FROM execution WHERE id=?', String(intent.executionId));
      if (
        !execution ||
        !belongsToRun(db, execution, ref.runId) ||
        execution.session_id !== ref.sessionId ||
        execution.origin_store_id !== input.expectedStoreId
      )
        throw new AgentError('operation_unverifiable');
      const checked = record(db, ref, `${prefix(ref)}check/${execution.id}`);
      return {
        executionId: String(execution.id),
        seq: String(intent.seq),
        descriptor: intent.descriptor!,
        supersededBy: superseding(db, ref, intent),
        status: String(execution.state) as import('../types').ExecutionStatus,
        resultRevision: String(execution.result_revision),
        result: JSON.parse(String(execution.result_json)) as Json,
        check: checked
          ? (decode(checked.json) as unknown as import('../types').MutationFact['check'])
          : null,
      };
    });
    db.db.run('COMMIT');
    return {
      facts,
      headRevision: head.row ? String(head.row.revision) : null,
      nextAfterSeq: facts.length === limit ? facts.at(-1)!.seq : null,
      highWaterSeq: String(high),
    };
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
export function commitMutationCheck(
  db: SqliteOperations,
  input: Parameters<Store['commitMutationCheck']>[0],
): void {
  db.tx(() => {
    const ref = input.requirement,
      { run, value } = policy(db, input.expectedStoreId, ref);
    db.active(input.owner, String(run.origin_command_id), String(run.id));
    const execution = db.row(
      'SELECT * FROM execution WHERE id=? AND run_id=?',
      input.executionId,
      run.id!,
    );
    if (
      !execution ||
      !['dispatching', 'running'].includes(String(execution.state)) ||
      execution.adapter_id !== value.checkDefinitionId ||
      execution.definition_version !== value.checkDefinitionVersion ||
      execution.origin_store_id !== input.expectedStoreId ||
      String(execution.owner_generation) !== input.owner.generation
    )
      throw new AgentError('mutation_check_invalid');
    db.ancestors(input.owner, input.executionId);
    const checkInput = decode(execution.intent_json);
    if (
      checkInput.mutationExecutionId !== input.mutationExecutionId ||
      checkInput.headRevision !== input.headRevision
    )
      throw new AgentError('mutation_check_invalid');
    const target = db.row(
        'SELECT * FROM execution WHERE id=? AND run_id=?',
        input.mutationExecutionId,
        run.id!,
      ),
      intent = record(db, ref, `${prefix(ref)}intent/${input.mutationExecutionId}`),
      head = getHead(db, ref);
    if (!target || !intent || !head.row || String(head.row.revision) !== input.headRevision)
      throw new AgentError('mutation_head_changed');
    if (!['succeeded', 'failed', 'cancelled'].includes(String(target.state)))
      throw new AgentError('operation_unverifiable');
    const seq = decimal(decode(intent.json).seq),
      through = decimal(head.value.checkedThrough);
    if (seq !== through + 1n) throw new AgentError('mutation_check_order');
    if (!['passed', 'failed', 'inconclusive', 'superseded'].includes(input.outcome))
      throw new AgentError('mutation_check_invalid');
    if (input.outcome === 'superseded') {
      const successor = superseding(db, ref, decode(intent.json));
      if (
        !successor ||
        canonicalJson(object(input.evidence).supersededBy!) !== canonicalJson(successor)
      )
        throw new AgentError('mutation_check_invalid');
    }
    save(db, ref, `${prefix(ref)}check-attempt/${input.executionId}`, {
      outcome: input.outcome,
      executionId: input.executionId,
      evidence: input.evidence,
    });
    save(db, ref, `${prefix(ref)}check/${input.mutationExecutionId}`, {
      outcome: input.outcome,
      executionId: input.executionId,
      evidence: input.evidence,
    });
    save(db, ref, headKey(ref), {
      ...head.value,
      checkedThrough: ['passed', 'superseded'].includes(input.outcome)
        ? String(seq)
        : String(through),
      lastOutcome: input.outcome,
      lastCheckerExecutionId: input.executionId,
    });
  });
}
