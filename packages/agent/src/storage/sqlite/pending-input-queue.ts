import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import { AgentError, type Json } from '../types';
import type { SqliteOperations } from './operations';

// Command.seq remains immutable provenance. Only pending prompt slots may be permuted.
export const pendingInputPredicate =
  "kind IN ('input.steer','input.follow_up','result.include') AND status='accepted' AND cancelled=0 AND COALESCE(json_extract(receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')";
export const pendingOrder = 'COALESCE(pending_order,seq)';
function scope(
  db: SqliteOperations,
  input: { expectedStoreId: string; sessionId: string; subjectId?: string },
) {
  db.identity(input.expectedStoreId);
  const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (!session || session.delete_requested) throw new AgentError('session_not_found');
  if (session.parent_id !== null) throw new AgentError('group_root_required');
  if (input.subjectId !== undefined) {
    const creator = db.row(
      "SELECT subject_id FROM command WHERE session_id=? AND kind='session.create'",
      input.sessionId,
    );
    if (creator?.subject_id !== input.subjectId) throw new AgentError('permission_denied');
  }
}
function members(db: SqliteOperations, input: { expectedStoreId: string; sessionId: string }) {
  return db.rows(
    `SELECT id,seq,pending_order,request_digest,kind,subject_id,input_target_run_id,json_type(request_json,'$.content') AS content_type FROM command WHERE session_id=? AND origin_store_id=? AND ${pendingInputPredicate} AND ((SELECT parent_id FROM session WHERE id=command.session_id) IS NULL OR agent_source_execution_id IS NOT NULL) ORDER BY ${pendingOrder},seq`,
    input.sessionId,
    input.expectedStoreId,
  );
}
function revision(db: SqliteOperations, sessionId: string, rows: ReturnType<typeof members>) {
  const hash = createHash('sha256');
  hash.update(
    String(
      db.row('SELECT revision FROM pending_input_queue_revision WHERE session_id=?', sessionId)
        ?.revision ?? 0,
    ),
  );
  for (const row of rows)
    hash.update(
      canonicalJson([
        String(row.id),
        String(row.seq),
        String(row.pending_order ?? row.seq),
        String(row.request_digest),
      ]),
    );
  return hash.digest('hex');
}
function mutableInput(row: ReturnType<typeof members>[number]) {
  if (!['input.steer', 'input.follow_up'].includes(String(row.kind))) return false;
  if (row.content_type !== undefined) return row.content_type === 'text';
  const body = JSON.parse(String(row.request_json));
  return typeof body.content === 'string';
}
export function getPendingInputQueue(
  db: SqliteOperations,
  input: Parameters<Store['getPendingInputQueue']>[0],
) {
  db.db.run('BEGIN');
  try {
    if (input.owner) {
      db.identity(input.expectedStoreId);
      db.owner(input.owner, input.sessionId);
    } else scope(db, input);
    const after = input.afterOrder ?? '0',
      limit = input.limit ?? 50;
    if (
      !/^(0|[1-9][0-9]*)$/.test(after) ||
      BigInt(after) > 9223372036854775807n ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      (input.kind !== undefined && !['input.steer', 'input.follow_up'].includes(input.kind)) ||
      (input.expectedRevision !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedRevision))
    )
      throw new AgentError('invalid_input_cursor');
    const all = members(db, input),
      current = revision(db, input.sessionId, all);
    if (input.expectedRevision !== undefined && input.expectedRevision !== current)
      throw new AgentError('input_queue_changed');
    const rows = all.filter(
      (row) =>
        BigInt(String(row.pending_order ?? row.seq)) > BigInt(after) &&
        (!input.kind ||
          (input.kind === 'input.steer'
            ? ['input.steer', 'result.include'].includes(String(row.kind))
            : row.kind === input.kind)) &&
        (!input.targetRunId || row.input_target_run_id === input.targetRunId),
    );
    const page = rows.slice(0, limit);
    const result = {
      commands: page.map((row) => db.command(db.row('SELECT * FROM command WHERE id=?', row.id!)!)),
      orders: page.map((row) => String(row.pending_order ?? row.seq)),
      nextAfterOrder:
        rows.length > limit ? String(page.at(-1)!.pending_order ?? page.at(-1)!.seq) : null,
      revision: current,
      snapshotCursor: db.metadata().lastChangeCursor,
    };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    return db.rollback(error);
  }
}
export function mutatePendingInputQueue(
  db: SqliteOperations,
  input:
    | Parameters<Store['withdrawPendingInput']>[0]
    | Parameters<Store['reorderPendingInputs']>[0],
) {
  return db.tx(() => {
    scope(db, input);
    if (!['input.withdraw', 'input.reorder'].includes(input.kind))
      throw new AgentError('invalid_input_operation');
    const expectedKeys = [
      'expectedStoreId',
      'sessionId',
      'subjectId',
      'commandId',
      'kind',
      'expectedRevision',
      input.kind === 'input.withdraw' ? 'targetCommandId' : 'commandIds',
    ].sort();
    if (Object.keys(input).sort().join(',') !== expectedKeys.join(','))
      throw new AgentError('invalid_input_operation');
    const request: Json =
      input.kind === 'input.withdraw'
        ? {
            kind: input.kind,
            targetCommandId: input.targetCommandId,
            expectedRevision: input.expectedRevision,
          }
        : {
            kind: input.kind,
            commandIds: input.commandIds,
            expectedRevision: input.expectedRevision,
          };
    const digest = createHash('sha256').update(canonicalJson(request)).digest('hex');
    const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
    if (prior) {
      if (
        prior.request_digest !== digest ||
        prior.session_id !== input.sessionId ||
        prior.subject_id !== input.subjectId ||
        prior.origin_store_id !== input.expectedStoreId
      )
        throw new AgentError('command_conflict');
      return db.command(prior);
    }
    if (!/^[a-f0-9]{64}$/.test(input.expectedRevision))
      throw new AgentError('invalid_input_revision');
    const rows = members(db, input);
    if (input.kind === 'input.withdraw') {
      const target = db.row(
        'SELECT * FROM command WHERE id=? AND session_id=?',
        input.targetCommandId,
        input.sessionId,
      );
      if (
        !target ||
        target.origin_store_id !== input.expectedStoreId ||
        target.subject_id !== input.subjectId
      )
        throw new AgentError('input_not_found');
      if (
        target.status !== 'accepted' ||
        target.cancelled ||
        !rows.some((row) => row.id === target.id)
      )
        throw new AgentError('input_already_consumed');
      if (!mutableInput(target)) throw new AgentError('input_not_editable');
      if (revision(db, input.sessionId, rows) !== input.expectedRevision)
        throw new AgentError('input_queue_changed');
      // A withdrawal never traverses Run/execution or human work selection bindings.
      db.run(
        "UPDATE command SET status='rejected',cancelled=1,cancel_requested_at=?,receipt_json=? WHERE id=? AND status='accepted' AND cancelled=0",
        Date.now(),
        canonicalJson({ outcome: 'withdrawn_before_apply', withdrawCommandId: input.commandId }),
        input.targetCommandId,
      );
      db.insertCommand(input, request, digest, 'applied', {
        outcome: 'input_withdrawn',
        targetCommandId: input.targetCommandId,
      });
      db.event(input.sessionId, input.targetCommandId, 'input.withdrawn');
    } else {
      if (revision(db, input.sessionId, rows) !== input.expectedRevision)
        throw new AgentError('input_queue_changed');
      const movable = rows.filter(mutableInput);
      if (
        !Array.isArray(input.commandIds) ||
        input.commandIds.length > 4096 ||
        input.commandIds.length !== movable.length ||
        new Set(input.commandIds).size !== movable.length ||
        input.commandIds.some(
          (id) => typeof id !== 'string' || !movable.some((row) => row.id === id),
        ) ||
        movable.some((row) => row.subject_id !== input.subjectId)
      )
        throw new AgentError('input_queue_members_changed');
      // Keep result.include in its original slot and preserve every original seq/digest.
      for (let index = 0; index < movable.length; index++)
        db.run(
          'UPDATE command SET pending_order=? WHERE id=?',
          movable[index]!.pending_order ?? movable[index]!.seq!,
          input.commandIds[index]!,
        );
      db.insertCommand(input, request, digest, 'applied', { outcome: 'inputs_reordered' });
      db.event(input.sessionId, input.commandId, 'input.reordered');
    }
    return db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!);
  });
}
