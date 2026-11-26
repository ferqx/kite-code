import { fileEditBatchSeal } from '../file-edit-batch';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;

/** Uncommitted members share the leader's one physical effect. Do not infer
 * success from disk bytes or cancellation of a non-dispatched companion. */
export function uncertainFileEditBatches(db: SqliteOperations, executions: readonly Row[]) {
  const pending = new Set(executions.map(({ id }) => id));
  const byExecution = new Map<string, { leaderExecutionId: string; digest: string }>();
  for (const row of executions) {
    const seal = fileEditBatchSeal(JSON.parse(String(row.decision_source_json)) as Json);
    if (!seal || row.id !== seal.leaderExecutionId || row.dispatched !== 1n) continue;
    const batch = db.fileEditBatchRows(row, 'settlement');
    if (!batch || batch.members.some(({ id }) => !pending.has(id)))
      throw new AgentError('file_edit_batch_binding_changed');
    const evidence = { leaderExecutionId: batch.leader.id, digest: seal.digest };
    for (const { id } of [batch.leader, ...batch.members]) byExecution.set(id, evidence);
  }
  return byExecution;
}
