import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../../json';
import type { Store } from '../port';
import {
  AgentError,
  type Json,
  type RunResumeCheckpoint,
  type RunResumeInput,
  type RunResumeLease,
  type RunResumeState,
} from '../types';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { identity as modelIdentity, sessionScope } from './model-input-operations';
import type { SqliteOperations } from './operations';

type Row = Record<string, string | number | bigint | null>;
const parse = (value: Row[string] | undefined): Json =>
  value == null ? null : (JSON.parse(String(value)) as Json);
const hash = (value: Json) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const jsonRow = (row: Row): Json =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? String(value) : value,
    ]),
  );
function scope(
  db: SqliteOperations,
  input: RunResumeInput,
  generation?: string,
  ignorePrior = false,
) {
  db.identity(input.expectedStoreId);
  const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (!session || session.delete_requested) throw new AgentError('session_not_found');
  if (session.parent_id !== null || session.root_id !== session.id)
    throw new AgentError('group_root_required');
  const creator = db.row(
    "SELECT * FROM command WHERE session_id=? AND kind='session.create'",
    input.sessionId,
  );
  if (creator?.subject_id !== input.subjectId) throw new AgentError('permission_denied');
  const run = db.row('SELECT * FROM run WHERE id=? AND session_id=?', input.runId, input.sessionId);
  if (!run) throw new AgentError('run_not_found');
  const original = db.row('SELECT * FROM command WHERE id=?', run.origin_command_id!);
  if (
    run.origin_store_id !== input.expectedStoreId ||
    original?.origin_store_id !== input.expectedStoreId ||
    creator.origin_store_id !== input.expectedStoreId
  )
    throw new AgentError('operation_unverifiable');
  if (original.subject_id !== input.subjectId) throw new AgentError('permission_denied');
  const request: Json = {
    kind: 'run.resume',
    runId: input.runId,
    expectedOwnerGeneration: input.expectedOwnerGeneration,
  };
  const prior = db.row('SELECT * FROM command WHERE id=?', input.commandId);
  if (
    prior &&
    (prior.kind !== 'run.resume' ||
      prior.session_id !== input.sessionId ||
      prior.subject_id !== input.subjectId ||
      prior.origin_store_id !== input.expectedStoreId ||
      prior.request_digest !== hash(request))
  )
    throw new AgentError('command_conflict');
  const base: RunResumeState = {
    command: prior ? db.command(prior) : null,
    run: db.runRecord(run),
    originalCommand: db.command(original),
    session: db.session(session),
    executions: [],
    checkpoint: null,
    requirementsInitialized: run.initialization_state === 'completed',
  };
  if (prior && !ignorePrior)
    return { state: base, run, session, original, executions: [] as Row[], request, prior };
  if (!['run.start', 'input.follow_up'].includes(String(original.kind)))
    throw new AgentError('run_resume_checkpoint_unavailable');
  if (String(session.owner_generation) !== (generation ?? input.expectedOwnerGeneration))
    throw new AgentError('owner_changed');
  if (
    !run.is_active ||
    !['running', 'waiting_interaction', 'waiting_execution'].includes(String(run.status))
  )
    throw new AgentError('run_not_active');
  if (
    run.cancel_requested ||
    original.cancelled ||
    BigInt(original.root_work_seq!) <= BigInt(session.stop_boundary!)
  )
    throw new AgentError('cancelled_before_dispatch');
  if (run.context_selection_id !== session.context_selection_id)
    throw new AgentError('context_selection_changed');
  if (
    db.row(
      'SELECT id FROM run WHERE session_id IN(SELECT id FROM session WHERE root_id=?) AND is_active=1 AND id<>?',
      input.sessionId,
      input.runId,
    )
  )
    throw new AgentError('run_resume_checkpoint_unavailable');
  if (
    db.row(
      "SELECT id FROM execution WHERE root_session_id=? AND state IN('planned','dispatching','running','outcome_unknown') AND NOT(COALESCE(run_id=?,0) AND session_id=? AND state='planned' AND dispatched=0 AND kind IN('model','tool') AND parent_execution_id IS NULL) LIMIT 1",
      input.sessionId,
      input.runId,
      input.sessionId,
    )
  )
    throw new AgentError('run_resume_checkpoint_unavailable');
  // Hash exactly the original canonical object, streaming its sorted keys and row arrays.
  // Every historical row is validated; only the latest Model and zero-dispatch frontier leave SQLite.
  const digest = createHash('sha256').update('{"executions":[');
  const planned: { row: Row; position: bigint }[] = [];
  let last: Row | undefined;
  let lastPosition = 0n;
  let count = 0n;
  let plannedModels = 0;
  const rows = db.db.query<Row, [string, string]>(
    'SELECT * FROM execution WHERE run_id=? AND session_id=? ORDER BY rowid',
  );
  (rows as typeof rows & { safeIntegers(value: boolean): typeof rows }).safeIntegers(true);
  for (const e of rows.iterate(input.runId, input.sessionId)) {
    if (count) digest.update(',');
    digest.update(canonicalJson(jsonRow(e)));
    ++count;
    if (e.origin_store_id !== input.expectedStoreId) throw new AgentError('operation_unverifiable');
    if (['dispatching', 'running', 'outcome_unknown'].includes(String(e.state)))
      throw new AgentError('run_resume_checkpoint_unavailable');
    if (
      e.state === 'planned' &&
      (e.run_id !== input.runId ||
        e.session_id !== input.sessionId ||
        e.dispatched !== 0n ||
        e.kind === 'job' ||
        e.parent_execution_id !== null ||
        e.cancel_requested)
    )
      throw new AgentError('run_resume_checkpoint_unavailable');
    if (e.kind === 'tool' && ['succeeded', 'failed', 'cancelled'].includes(String(e.state))) {
      const result = parse(e.result_json) as Record<string, Json> | null;
      if (!result || result.outcome !== e.state || typeof result.content !== 'string')
        throw new AgentError('run_resume_checkpoint_unavailable');
    }
    if (e.run_id === input.runId && e.kind === 'model' && e.state !== 'planned') {
      const result = parse(e.result_json) as Record<string, Json> | null;
      if (
        e.state !== 'succeeded' ||
        !result ||
        typeof result.content !== 'string' ||
        !['stop', 'tool_calls'].includes(String(result.finishReason)) ||
        !Array.isArray(result.toolCalls)
      )
        throw new AgentError('run_resume_checkpoint_unavailable');
      if (result.modelOutput && !(result.modelOutput as Record<string, Json>).complete)
        throw new AgentError('run_resume_checkpoint_unavailable');
    }
    if (e.state === 'planned') {
      planned.push({ row: e, position: count });
      if (planned.length > 4096) throw new AgentError('run_resume_checkpoint_unavailable');
      if (e.kind === 'model') ++plannedModels;
    }
    if (e.kind === 'model') {
      last = e;
      lastPosition = count;
    }
  }
  if (plannedModels > 1 || (plannedModels && last?.state !== 'planned'))
    throw new AgentError('run_resume_checkpoint_unavailable');
  if (run.initialization_state === 'started' || (run.initialization_state === 'unstarted' && count))
    throw new AgentError('run_initialization_incomplete');
  const boundary: RunResumeCheckpoint['boundary'] =
    !last || last.state === 'planned'
      ? 'before_model_dispatch'
      : (parse(last.result_json) as Record<string, Json>).finishReason === 'tool_calls'
        ? 'tool_calls'
        : 'completion';
  if (boundary === 'before_model_dispatch' && planned.some(({ row }) => row.kind !== 'model'))
    throw new AgentError('run_resume_checkpoint_unavailable');
  digest.update('],"interactions":[');
  const interactions = db.db.query<Row, [string]>(
    'SELECT * FROM interaction WHERE run_id=? ORDER BY id',
  );
  (
    interactions as typeof interactions & { safeIntegers(value: boolean): typeof interactions }
  ).safeIntegers(true);
  let firstInteraction = true;
  for (const i of interactions.iterate(input.runId)) {
    if (!firstInteraction) digest.update(',');
    firstInteraction = false;
    digest.update(canonicalJson(jsonRow(i)));
    if (['pending', 'answered'].includes(String(i.state))) {
      const e = db.row(
        'SELECT * FROM execution WHERE id=? AND run_id=? AND session_id=?',
        i.execution_id!,
        input.runId,
        input.sessionId,
      );
      if (
        e?.state !== 'planned' ||
        i.origin_store_id !== input.expectedStoreId ||
        i.subject_id !== input.subjectId ||
        i.attempt !== e.attempt
      )
        throw new AgentError('run_resume_checkpoint_unavailable');
    }
  }
  digest
    .update('],"run":')
    .update(canonicalJson(jsonRow(run)))
    .update(',"selection":')
    .update(canonicalJson(String(session.context_selection_id)))
    .update('}');
  if (last && last.state !== 'planned') planned.push({ row: last, position: lastPosition });
  const executions = planned
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .map(({ row }) => row);
  base.executions = executions.map((e) => db.execution(e));
  const checkpoint: RunResumeCheckpoint = {
    boundary,
    contextSelectionId: String(session.context_selection_id),
    initializationState: run.initialization_state as RunResumeCheckpoint['initializationState'],
    bindingDigest: digest.digest('hex'),
  };
  base.checkpoint = checkpoint;
  return { state: base, run, session, original, executions, request, prior };
}
function readExecutionPage(
  db: SqliteOperations,
  input: Parameters<Store['readRunResumeExecutionPage']>[0],
): import('../types').RunResumeExecutionPage {
  if (!['prior_models', 'model_tools'].includes(input.kind))
    throw new AgentError('invalid_run_resume_cursor');
  const cursor = input.afterRowid ?? '0';
  if (
    typeof cursor !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(cursor) ||
    BigInt(cursor) > 9223372036854775807n
  )
    throw new AgentError('invalid_run_resume_cursor');
  db.db.run('BEGIN');
  try {
    const session = sessionScope(db, input);
    if (session.parent_id !== null || session.root_id !== session.id)
      throw new AgentError('group_root_required');
    const anchor = db.row(
      'SELECT rowid AS resume_rowid,* FROM execution WHERE id=?',
      input.modelExecutionId,
    );
    if (
      !anchor ||
      anchor.origin_store_id !== input.expectedStoreId ||
      anchor.run_id !== input.runId
    )
      throw new AgentError('operation_unverifiable');
    modelIdentity(db, input, session, anchor);
    const page =
      input.kind === 'prior_models'
        ? db.rows(
            "SELECT id,rowid AS resume_rowid FROM execution WHERE run_id=? AND session_id=? AND kind='model' AND rowid>? AND rowid<? ORDER BY rowid LIMIT 201",
            input.runId,
            input.sessionId,
            BigInt(cursor),
            anchor.resume_rowid!,
          )
        : db.rows(
            "SELECT id,rowid AS resume_rowid FROM execution WHERE run_id=? AND session_id=? AND kind='tool' AND step_id=? AND rowid>? ORDER BY rowid LIMIT 201",
            input.runId,
            input.sessionId,
            anchor.step_id!,
            BigInt(cursor),
          );
    const items = page
      .slice(0, 200)
      .map((row) => ({ executionId: String(row.id), cursor: String(row.resume_rowid) }));
    const result = { items, nextCursor: page.length > 200 ? items.at(-1)!.cursor : null };
    db.db.run('COMMIT');
    return result;
  } catch (error) {
    db.db.run('ROLLBACK');
    throw error;
  }
}
export function callRunResume(db: SqliteOperations, method: string, value: unknown): unknown {
  if (method === 'readRunResumeExecutionPage')
    return readExecutionPage(db, value as Parameters<Store['readRunResumeExecutionPage']>[0]);
  if (method === 'verifyRunResume') {
    db.db.run('BEGIN');
    try {
      const result = scope(db, value as RunResumeInput).state;
      db.db.run('COMMIT');
      return result;
    } catch (error) {
      db.db.run('ROLLBACK');
      throw error;
    }
  }
  return db.tx(() => {
    if (method === 'beginRunRequirementsInitialization') {
      const input = value as Parameters<Store['beginRunRequirementsInitialization']>[0];
      db.identity(input.expectedStoreId);
      const run = db.row('SELECT * FROM run WHERE id=?', input.runId);
      if (!run) throw new AgentError('run_not_found');
      db.active(input.owner, String(run.origin_command_id), input.runId);
      if (run.initialization_state !== 'unstarted')
        throw new AgentError('run_initialization_state_changed');
      db.run("UPDATE run SET initialization_state='started' WHERE id=?", input.runId);
      db.event(String(run.session_id), input.runId, 'run.requirements_initializing');
      return db.runRecord(db.row('SELECT * FROM run WHERE id=?', input.runId)!);
    }
    if (method === 'beginRunResume') {
      const input = value as Parameters<Store['beginRunResume']>[0],
        s = scope(db, input);
      if (s.prior)
        return { command: db.command(s.prior), lease: null, state: s.state, started: false };
      assertNoExecutionGroupFence(db, input.sessionId);
      if (
        canonicalJson(input.checkpoint as unknown as Json) !==
        canonicalJson(s.state.checkpoint as unknown as Json)
      )
        throw new AgentError('run_resume_checkpoint_changed');
      if (BigInt(s.session.owner_generation!) >= 9223372036854775807n)
        throw new AgentError('sequence_exhausted');
      const lease: RunResumeLease = {
        kind: 'run_resume',
        id: randomUUID(),
        sessionId: input.sessionId,
        instanceId: input.instanceId,
        generation: String(BigInt(s.session.owner_generation!) + 1n),
        commandId: input.commandId,
        runId: input.runId,
        originalOwnerGeneration: input.expectedOwnerGeneration,
      };
      db.run(
        'UPDATE session SET owner_generation=?,owner_instance=? WHERE id=?',
        BigInt(lease.generation),
        lease.instanceId,
        lease.sessionId,
      );
      db.insertCommand(input, s.request, hash(s.request), 'accepted', null);
      db.run(
        'UPDATE command SET run_resume_lease_json=? WHERE id=?',
        canonicalJson(lease as unknown as Json),
        input.commandId,
      );
      db.event(input.sessionId, input.commandId, 'run.resume_prepared');
      return {
        command: db.command(db.row('SELECT * FROM command WHERE id=?', input.commandId)!),
        lease,
        state: s.state,
        started: false,
      };
    }
    if (method === 'releaseRunResumeLease') {
      const lease = value as RunResumeLease;
      db.run(
        'UPDATE session SET owner_instance=NULL WHERE id=? AND owner_generation=? AND owner_instance=?',
        lease.sessionId,
        BigInt(lease.generation),
        lease.instanceId,
      );
      return;
    }
    const input = value as Parameters<Store['commitRunResume']>[0],
      lease = input.lease;
    db.identity(input.expectedStoreId);
    const command = db.row('SELECT * FROM command WHERE id=?', lease.commandId),
      session = db.row('SELECT * FROM session WHERE id=?', lease.sessionId);
    if (
      command?.kind !== 'run.resume' ||
      command.status !== 'accepted' ||
      canonicalJson(parse(command.run_resume_lease_json)) !==
        canonicalJson(lease as unknown as Json) ||
      session?.owner_instance !== lease.instanceId ||
      String(session.owner_generation) !== lease.generation
    )
      throw new AgentError('recovery_lease_changed');
    if (command.cancelled) throw new AgentError('run_resume_cancelled');
    assertNoExecutionGroupFence(db, lease.sessionId);
    const s = scope(
      db,
      {
        expectedStoreId: input.expectedStoreId,
        commandId: lease.commandId,
        sessionId: lease.sessionId,
        subjectId: String(command.subject_id),
        runId: lease.runId,
        expectedOwnerGeneration: lease.originalOwnerGeneration,
      },
      lease.generation,
      true,
    );
    if (canonicalJson(input.expectedConfiguration) !== s.run.config_json)
      throw new AgentError('run_configuration_changed');
    if (
      canonicalJson(input.checkpoint as unknown as Json) !==
      canonicalJson(s.state.checkpoint as unknown as Json)
    )
      throw new AgentError('run_resume_checkpoint_changed');
    for (const e of s.executions)
      if (e.state === 'planned')
        db.run(
          "UPDATE execution SET owner_generation=? WHERE id=? AND state='planned' AND dispatched=0",
          BigInt(lease.generation),
          e.id!,
        );
    const receipt: Json = {
      outcome: 'run_resumed',
      runId: lease.runId,
      boundary: input.checkpoint.boundary,
      originalCommandId: String(s.original.id),
    };
    db.run(
      "UPDATE command SET status='applied',receipt_json=? WHERE id=?",
      canonicalJson(receipt),
      lease.commandId,
    );
    db.event(lease.sessionId, lease.commandId, 'run.resumed');
    return {
      command: db.command(db.row('SELECT * FROM command WHERE id=?', lease.commandId)!),
      owner: {
        sessionId: lease.sessionId,
        instanceId: lease.instanceId,
        generation: lease.generation,
      },
      run: s.state.run,
      originalCommand: s.state.originalCommand,
      executions: s.executions.map((e) =>
        db.execution(db.row('SELECT * FROM execution WHERE id=?', e.id!)!),
      ),
      checkpoint: input.checkpoint,
      started: true,
    };
  });
}
