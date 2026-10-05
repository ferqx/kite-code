import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type ExecutionOutputRecord, type OwnerRef } from '../types';
import type { SqliteOperations } from './operations';

const max = 9223372036854775807n;
function decimal(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new AgentError('invalid_cursor');
  const number = BigInt(value);
  if (number > max) throw new AgentError('invalid_cursor');
  return number;
}
function output(row: Record<string, string | number | bigint | null>): ExecutionOutputRecord {
  return {
    executionId: String(row.execution_id),
    seq: String(row.seq),
    throughSeq: String(row.through_seq),
    stream: row.stream as ExecutionOutputRecord['stream'],
    content: String(row.content),
    droppedBytes: String(row.dropped_bytes),
  };
}
function owned(
  db: SqliteOperations,
  expectedStoreId: string,
  owner: OwnerRef,
  executionId: string,
) {
  db.identity(expectedStoreId);
  db.owner(owner);
  const execution = db.row('SELECT * FROM execution WHERE id=?', executionId);
  if (execution) db.owner(owner, String(execution.session_id));
  if (!execution || String(execution.owner_generation) !== owner.generation)
    throw new AgentError('owner_changed');
  if (execution.origin_store_id !== expectedStoreId) throw new AgentError('operation_unverifiable');
  return execution;
}
export function callJob(
  db: SqliteOperations,
  method: 'markRunning' | 'appendExecutionOutput' | 'listExecutionOutput',
  args: unknown[],
): unknown {
  if (method === 'markRunning') {
    const input = args[0] as Parameters<Store['markRunning']>[0];
    return db.tx(() => {
      const execution = owned(db, input.expectedStoreId, input.owner, input.executionId);
      if (execution.kind !== 'job' || input.reference === null)
        throw new AgentError('invalid_job_reference');
      if (execution.reference_json !== null) {
        if (execution.reference_json !== canonicalJson(input.reference))
          throw new AgentError('job_reference_conflict');
        return db.execution(execution);
      }
      if (execution.state === 'planned' || execution.dispatched !== 1n)
        throw new AgentError('execution_not_dispatched');
      db.run(
        "UPDATE execution SET state=CASE WHEN state='dispatching' THEN 'running' ELSE state END,reference_json=? WHERE id=?",
        canonicalJson(input.reference),
        input.executionId,
      );
      db.event(String(execution.session_id), input.executionId, 'execution.running');
      return db.execution(db.row('SELECT * FROM execution WHERE id=?', input.executionId)!);
    });
  }
  if (method === 'appendExecutionOutput') {
    const input = args[0] as Parameters<Store['appendExecutionOutput']>[0];
    return db.tx(() => {
      const execution = owned(db, input.expectedStoreId, input.owner, input.executionId);
      const toolProgress =
        execution.kind === 'tool' &&
        input.stream === 'progress' &&
        ['dispatching', 'running'].includes(String(execution.state)) &&
        execution.dispatched === 1n;
      if (
        (!toolProgress && execution.kind !== 'job') ||
        !['stdout', 'stderr', 'progress'].includes(input.stream)
      )
        throw new AgentError('invalid_execution_output');
      const size = new TextEncoder().encode(input.content).byteLength;
      if (size > 32768) throw new AgentError('output_chunk_too_large');
      const retainedCost = new TextEncoder().encode(JSON.stringify(input.content)).byteLength + 128;
      const dropped = decimal(input.droppedBytes ?? '0');
      if (!size && !dropped) throw new AgentError('empty_execution_output');
      if (BigInt(execution.output_seq!) >= max) throw new AgentError('sequence_exhausted');
      const seq = BigInt(execution.output_seq!) + 1n;
      const prior = db.row(
        'SELECT * FROM execution_output WHERE execution_id=? AND stream=? AND is_gap=1',
        input.executionId,
        input.stream,
      );
      const budgetExhausted = Number(execution.output_bytes) + retainedCost > 1048576;
      const gap =
        execution.output_budget_exhausted === 1n ||
        prior !== null ||
        dropped > 0n ||
        budgetExhausted;
      if (gap) {
        const total = BigInt(prior?.dropped_bytes ?? 0) + BigInt(size) + dropped;
        if (total > max) throw new AgentError('sequence_exhausted');
        if (prior)
          db.run(
            'UPDATE execution_output SET through_seq=?,dropped_bytes=? WHERE execution_id=? AND stream=? AND is_gap=1',
            seq,
            total,
            input.executionId,
            input.stream,
          );
        else
          db.run(
            'INSERT INTO execution_output(execution_id,stream,seq,through_seq,dropped_bytes,is_gap) VALUES(?,?,?,?,?,1)',
            input.executionId,
            input.stream,
            seq,
            seq,
            total,
          );
        db.run(
          'UPDATE execution SET output_seq=?,output_truncated=1,output_budget_exhausted=CASE WHEN ? THEN 1 ELSE output_budget_exhausted END WHERE id=?',
          seq,
          budgetExhausted ? 1 : 0,
          input.executionId,
        );
      } else {
        db.run(
          'INSERT INTO execution_output(execution_id,stream,seq,through_seq,content) VALUES(?,?,?,?,?)',
          input.executionId,
          input.stream,
          seq,
          seq,
          input.content,
        );
        db.run(
          'UPDATE execution SET output_seq=?,output_bytes=output_bytes+? WHERE id=?',
          seq,
          retainedCost,
          input.executionId,
        );
      }
      db.event(String(execution.session_id), input.executionId, 'execution.output');
      return output(
        db.row(
          'SELECT * FROM execution_output WHERE execution_id=? AND stream=? AND through_seq=?',
          input.executionId,
          input.stream,
          seq,
        )!,
      );
    });
  }
  const input = args[0] as Parameters<Store['listExecutionOutput']>[0];
  db.db.run('BEGIN');
  try {
    const execution = db.row('SELECT output_seq FROM execution WHERE id=?', input.executionId);
    if (!execution) throw new AgentError('execution_not_found');
    const highWater = BigInt(execution.output_seq!);
    const after = decimal(input.afterSeq ?? '0');
    const upper = input.upperSeq === undefined ? highWater : decimal(input.upperSeq);
    if (upper > highWater || after > highWater) throw new AgentError('cursor_ahead');
    if (after > upper) throw new AgentError('invalid_cursor');
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1))
      throw new AgentError('invalid_page_limit');
    const pageLimit = Math.min(200, input.limit ?? 100);
    const rows = db.rows(
      'SELECT * FROM execution_output WHERE execution_id=? AND is_gap=0 AND seq>? AND seq<=? ORDER BY seq LIMIT ?',
      input.executionId,
      after,
      upper,
      pageLimit,
    );
    // Gaps are at most three coalesced stream facts. Merge them before advancing the page cursor;
    // a gap must never jump over content rows omitted by the normal-row limit.
    const pageUpper = rows.length === pageLimit ? BigInt(rows.at(-1)!.seq!) : upper;
    rows.push(
      ...db.rows(
        'SELECT * FROM execution_output WHERE execution_id=? AND is_gap=1 AND through_seq>? AND seq<=? ORDER BY seq',
        input.executionId,
        after,
        pageUpper,
      ),
    );
    rows.sort((a, b) => {
      const left = BigInt(a.seq!) <= after ? after + 1n : BigInt(a.seq!);
      const right = BigInt(b.seq!) <= after ? after + 1n : BigInt(b.seq!);
      return left < right
        ? -1
        : left > right
          ? 1
          : String(a.stream).localeCompare(String(b.stream));
    });
    const items = rows.map((row) => {
      const value = output(row);
      const start = BigInt(value.seq);
      const end = BigInt(value.throughSeq);
      if (row.is_gap === 1n && (start <= after || end > pageUpper)) {
        value.seq = String(start <= after ? after + 1n : start);
        value.throughSeq = String(end > pageUpper ? pageUpper : end);
        value.droppedBytes = null;
      }
      return value;
    });
    db.db.run('COMMIT');
    return { items, highWaterSeq: String(highWater) };
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
export function finishJobDelivery(
  db: SqliteOperations,
  execution: Record<string, string | number | bigint | null>,
): void {
  if (execution.kind !== 'job') return;
  const command = db.row('SELECT kind FROM command WHERE id=?', execution.origin_command_id!);
  if (!['operation.job', 'operation.agent'].includes(String(command?.kind))) return;
  const target = db.row('SELECT * FROM session WHERE id=?', execution.delivery_target_session_id!);
  const reason =
    !target || target.delete_requested
      ? 'target_deleted'
      : target.context_selection_id !== execution.context_selection_id
        ? 'context_changed'
        : BigInt(execution.root_work_seq!) <= BigInt(target.stop_boundary!)
          ? 'root_cancelled'
          : execution.cancel_requested
            ? 'execution_cancel'
            : execution.origin_store_id !== db.metadata().storeId
              ? 'origin_unverifiable'
              : null;
  db.run(
    'UPDATE execution SET delivery=?,delivery_reason=? WHERE id=?',
    reason ? 'suppressed' : 'pending',
    reason,
    execution.id!,
  );
}
