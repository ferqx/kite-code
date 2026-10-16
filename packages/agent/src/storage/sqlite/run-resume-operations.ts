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
import { transferAuthorizationReviewOwnership } from './authorization-review';
import { assertConfigurationReads } from './child-operations';
import { assertNoExecutionGroupFence } from './execution-group-safety';
import { identity as modelIdentity, sessionScope } from './model-input-operations';
import type { SqliteOperations } from './operations';
import { assertEffectFreeModel, assertHistoricalExecution } from './recovery-audit-validation';

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
// A validated read snapshot, never a durable authority. SQLite invalidates it for
// every local write and every peer commit, including raw SQL without change events.
const validatedScopes = new WeakMap<
  SqliteOperations,
  {
    key: string;
    token: string;
    state: RunResumeState;
    executions: Row[];
  }
>();
function snapshotToken(db: SqliteOperations): string {
  return `${db.row('PRAGMA data_version')!.data_version}:${db.row('SELECT total_changes() AS changes')!.changes}`;
}
const scopeKey = (input: RunResumeInput) =>
  canonicalJson({
    expectedStoreId: input.expectedStoreId,
    commandId: input.commandId,
    subjectId: input.subjectId,
    sessionId: input.sessionId,
    runId: input.runId,
    expectedOwnerGeneration: input.expectedOwnerGeneration,
  });
function canContinueTool(execution: Row, run: Row): boolean {
  const source = parse(execution.decision_source_json) as Record<string, Json>;
  const manifest = parse(run.config_json) as Record<string, Json>;
  return (
    execution.kind === 'tool' &&
    !execution.cancel_requested &&
    ['dispatching', 'running'].includes(String(execution.state)) &&
    typeof source.toolRecoveryVersion === 'string' &&
    !!source.toolRecoveryVersion &&
    Array.isArray(manifest.tools) &&
    manifest.tools.some((item) => {
      const tool = item as Record<string, Json>;
      return (
        tool.id === execution.adapter_id &&
        tool.version === execution.definition_version &&
        tool.recoveryVersion === source.toolRecoveryVersion
      );
    })
  );
}
function scope(
  db: SqliteOperations,
  input: RunResumeInput,
  generation?: string,
  ignorePrior = false,
  member = false,
) {
  db.identity(input.expectedStoreId);
  const session = db.row('SELECT * FROM session WHERE id=?', input.sessionId);
  if (!session || session.delete_requested) throw new AgentError('session_not_found');
  if (!member && (session.parent_id !== null || session.root_id !== session.id))
    throw new AgentError('group_root_required');
  const creator = db.row(
    "SELECT * FROM command WHERE session_id=? AND kind='session.create'",
    session.root_id!,
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
  const prior = member ? null : db.row('SELECT * FROM command WHERE id=?', input.commandId);
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
  if (member && !run.is_active)
    return { state: base, run, session, original, executions: [] as Row[], request, prior };
  if (
    !(member ? ['child.start', 'input.follow_up'] : ['run.start', 'input.follow_up']).includes(
      String(original.kind),
    )
  )
    throw new AgentError('run_resume_checkpoint_unavailable');
  if (!member && String(session.owner_generation) !== (generation ?? input.expectedOwnerGeneration))
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
  const parentExecutionId = member ? db.childCarrier(original, input.runId)?.id : null;
  const cached = !member && validatedScopes.get(db);
  if (cached && cached.key === scopeKey(input) && cached.token === snapshotToken(db)) {
    base.executions = cached.state.executions;
    base.children = cached.state.children;
    base.checkpoint = cached.state.checkpoint;
    return { state: base, run, session, original, executions: cached.executions, request, prior };
  }
  const certificate = db.recoveryAudit.read(run, input.expectedStoreId);
  // Old or invalidated proof protocols retain the original full audit. Certified
  // histories need only the live frontier, latest Model and uncertified deltas.
  const digest = certificate ? null : createHash('sha256').update('{"executions":[');
  const planned: { row: Row; position: bigint }[] = [];
  let last: Row | undefined;
  let lastPosition = 0n;
  let count = 0n;
  let plannedModels = 0;
  let rows: Iterable<Row>;
  if (certificate) {
    const frontier = db.rows(
      "SELECT rowid AS resume_position,* FROM execution WHERE run_id=? AND session_id=? AND state IN('planned','dispatching','running','outcome_unknown') ORDER BY rowid LIMIT 4097",
      input.runId,
      input.sessionId,
    );
    const latest = db.row(
      "SELECT rowid AS resume_position,* FROM execution WHERE run_id=? AND kind='model' ORDER BY rowid DESC LIMIT 1",
      input.runId,
    );
    if (latest && !frontier.some((row) => row.id === latest.id)) frontier.push(latest);
    frontier.sort((a, b) => (BigInt(a.resume_position!) < BigInt(b.resume_position!) ? -1 : 1));
    rows = frontier;
  } else {
    const statement = db.db.query<Row, [string, string]>(
      'SELECT * FROM execution WHERE run_id=? AND session_id=? ORDER BY rowid',
    );
    (
      statement as typeof statement & { safeIntegers(value: boolean): typeof statement }
    ).safeIntegers(true);
    rows = statement.iterate(input.runId, input.sessionId);
  }
  for (const e of rows) {
    if (digest) {
      if (count) digest.update(',');
      digest.update(canonicalJson(jsonRow(e)));
    }
    ++count;
    if (e.origin_store_id !== input.expectedStoreId) throw new AgentError('operation_unverifiable');
    if (
      e.state === 'outcome_unknown' ||
      (e.kind !== 'model' &&
        ['dispatching', 'running'].includes(String(e.state)) &&
        !canContinueTool(e, run))
    )
      throw new AgentError('run_resume_checkpoint_unavailable');
    if (
      e.state === 'planned' &&
      (e.run_id !== input.runId ||
        e.session_id !== input.sessionId ||
        e.dispatched !== 0n ||
        e.kind === 'job' ||
        e.parent_execution_id !== parentExecutionId ||
        e.cancel_requested)
    )
      throw new AgentError('run_resume_checkpoint_unavailable');
    assertHistoricalExecution(db, e, input.expectedStoreId, String(session.root_id));
    if (e.kind === 'model' && ['dispatching', 'running'].includes(String(e.state)))
      assertEffectFreeModel(db, e);
    if (e.state === 'planned' || canContinueTool(e, run)) {
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
  if (
    run.initialization_state === 'started' ||
    (run.initialization_state === 'unstarted' &&
      (certificate
        ? !!db.row('SELECT id FROM execution WHERE run_id=? LIMIT 1', input.runId)
        : count > 0n))
  )
    throw new AgentError('run_initialization_incomplete');
  const boundary: RunResumeCheckpoint['boundary'] =
    last?.state !== 'succeeded' ||
    (parse(last.decision_source_json) as Record<string, Json>)?.compressionId
      ? 'before_model_dispatch'
      : (parse(last.result_json) as Record<string, Json>).finishReason === 'tool_calls'
        ? 'tool_calls'
        : 'completion';
  if (boundary === 'before_model_dispatch' && planned.some(({ row }) => row.kind !== 'model'))
    throw new AgentError('run_resume_checkpoint_unavailable');
  digest?.update('],"interactions":[');
  const interactions = db.db.query<Row, [string]>(
    certificate
      ? "SELECT * FROM interaction WHERE run_id=? AND state IN('pending','answered') ORDER BY id"
      : 'SELECT * FROM interaction WHERE run_id=? ORDER BY id',
  );
  (
    interactions as typeof interactions & { safeIntegers(value: boolean): typeof interactions }
  ).safeIntegers(true);
  let firstInteraction = true;
  for (const i of interactions.iterate(input.runId)) {
    if (!firstInteraction) digest?.update(',');
    firstInteraction = false;
    digest?.update(canonicalJson(jsonRow(i)));
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
    ?.update('],"run":')
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
    bindingDigest: certificate
      ? hash({
          kind: 'transactional-recovery-audit-v1',
          certificate,
          run: jsonRow(run),
          selection: String(session.context_selection_id),
        })
      : digest!.digest('hex'),
  };
  base.checkpoint = checkpoint;
  if (!member) attachGroup(db, input, base, run);
  return { state: base, run, session, original, executions, request, prior };
}
/** Discover through actual execution edges, never through Session insertion order or UI views. */
function attachGroup(
  db: SqliteOperations,
  input: RunResumeInput,
  root: RunResumeState,
  rootRun: Row,
) {
  const runs = new Set([input.runId]);
  const pending = db.rows(
    `WITH RECURSIVE seeds(id) AS (
      SELECT e.id FROM execution e
      WHERE e.root_session_id=? AND e.root_work_command_id=? AND e.root_work_seq=? AND e.child_session_id IS NOT NULL
        AND e.state IN('planned','dispatching','running','outcome_unknown')
      UNION SELECT e.id FROM run r JOIN command c ON c.id=r.origin_command_id JOIN execution e
        ON e.id=CASE WHEN c.kind='child.start' THEN json_extract(c.request_json,'$.parentExecutionId') ELSE c.agent_carrier_execution_id END
      WHERE r.is_active=1 AND e.root_session_id=? AND e.root_work_command_id=? AND e.root_work_seq=? AND e.child_session_id IS NOT NULL
    ), ancestry(id) AS (
      SELECT id FROM seeds
      UNION SELECT e.parent_execution_id FROM execution e JOIN ancestry a ON e.id=a.id WHERE e.parent_execution_id IS NOT NULL
    ) SELECT e.* FROM execution e JOIN ancestry a ON e.id=a.id WHERE e.child_session_id IS NOT NULL ORDER BY e.rowid`,
    input.sessionId,
    rootRun.root_work_command_id!,
    rootRun.root_work_seq!,
    input.sessionId,
    rootRun.root_work_command_id!,
    rootRun.root_work_seq!,
  );
  const children: NonNullable<RunResumeState['children']> = [];
  const identities = new Map<string, Json>();
  const paths = new Map<string, Row[]>();
  const nearestRun = (carrier: Row): string => {
    let current = carrier;
    const seen = new Set<string>();
    const path: Row[] = [];
    while (current.run_id === null) {
      if (!current.parent_execution_id || seen.has(String(current.id)))
        throw new AgentError('operation_unverifiable');
      seen.add(String(current.id));
      const parent = db.row('SELECT * FROM execution WHERE id=?', current.parent_execution_id);
      if (
        !parent ||
        parent.session_id !== carrier.session_id ||
        parent.root_session_id !== input.sessionId
      )
        throw new AgentError('operation_unverifiable');
      if (
        parent.origin_store_id !== input.expectedStoreId ||
        parent.root_work_command_id !== rootRun.root_work_command_id ||
        String(parent.root_work_seq) !== String(rootRun.root_work_seq)
      )
        throw new AgentError('operation_unverifiable');
      path.push(parent);
      current = parent;
    }
    paths.set(String(carrier.id), path);
    return String(current.run_id);
  };
  for (let progress = true; progress; ) {
    progress = false;
    for (let index = 0; index < pending.length; ) {
      const carrier = pending[index]!;
      const parentRunId = nearestRun(carrier);
      if (!runs.has(parentRunId)) {
        index++;
        continue;
      }
      pending.splice(index, 1);
      progress = true;
      const session = db.row('SELECT * FROM session WHERE id=?', carrier.child_session_id!);
      const command = db.row('SELECT * FROM command WHERE id=?', `child-start-${carrier.id}`);
      const origin = db.row('SELECT * FROM command WHERE id=?', carrier.origin_command_id!);
      const run = command && db.row('SELECT * FROM run WHERE origin_command_id=?', command.id!);
      const request = command && (parse(command.request_json) as Record<string, Json> | null);
      const configuration = parse(carrier.child_configuration_json) as Record<string, Json> | null;
      const operation = origin && (parse(origin.request_json) as Record<string, Json> | null);
      const parent =
        carrier.parent_execution_id &&
        db.row('SELECT * FROM execution WHERE id=?', carrier.parent_execution_id);
      if (
        carrier.kind !== 'job' ||
        !configuration ||
        !session ||
        !command ||
        !origin ||
        origin.kind !== 'operation.agent' ||
        origin.session_id !== carrier.session_id ||
        carrier.run_id !== null ||
        operation?.kind !== 'operation.agent' ||
        operation.parentExecutionId !== carrier.parent_execution_id ||
        operation.definitionId !== carrier.adapter_id ||
        operation.definitionVersion !== carrier.definition_version ||
        operation.configurationId !== configuration.id ||
        canonicalJson(operation.childConfiguration!) !== carrier.child_configuration_json ||
        canonicalJson(operation.input!) !== carrier.intent_json ||
        (operation.cancellation === 'detached') !== !carrier.cancel_with_parent ||
        carrier.step_id !== `operation-${origin.id}` ||
        carrier.call_id !== origin.id ||
        !parent ||
        parent.decision_source_json !== carrier.decision_source_json ||
        origin.subject_id !== input.subjectId ||
        session.parent_id !== carrier.session_id ||
        session.root_id !== input.sessionId ||
        session.delete_requested ||
        command.session_id !== session.id ||
        command.subject_id !== input.subjectId ||
        !['child.start', 'input.follow_up'].includes(String(command.kind)) ||
        (command.kind === 'child.start'
          ? request?.parentExecutionId !== carrier.id
          : command.agent_carrier_execution_id !== carrier.id) ||
        carrier.origin_store_id !== input.expectedStoreId ||
        origin.origin_store_id !== input.expectedStoreId ||
        command.origin_store_id !== input.expectedStoreId ||
        [carrier, command, origin].some(
          (row) =>
            row.root_work_command_id !== rootRun.root_work_command_id ||
            String(row.root_work_seq) !== String(rootRun.root_work_seq),
        ) ||
        (run &&
          (run.session_id !== session.id ||
            db.childCarrier(command, String(run.id))?.id !== carrier.id ||
            canonicalJson(configuration.snapshot!) !== run.config_json)) ||
        carrier.state === 'outcome_unknown' ||
        (run?.is_active && !['dispatching', 'running'].includes(String(carrier.state))) ||
        (!run && carrier.state !== 'planned' && carrier.state !== 'dispatching')
      )
        throw new AgentError('run_resume_checkpoint_unavailable', 'child_relationship');
      if (
        carrier.reference_json !== null &&
        canonicalJson(parse(carrier.reference_json)) !==
          canonicalJson({
            kind: 'child_session',
            childSessionId: String(session.id),
            runId: run ? String(run.id) : null,
            commandId: String(command.id),
          })
      )
        throw new AgentError('run_resume_checkpoint_unavailable', 'child_reference');
      let child: RunResumeState | null = null;
      try {
        child = run
          ? scope(
              db,
              { ...input, sessionId: String(session.id), runId: String(run.id) },
              undefined,
              false,
              true,
            ).state
          : null;
      } catch (error) {
        throw new AgentError(
          'run_resume_checkpoint_unavailable',
          `child_frontier:${error instanceof Error ? error.message : error}`,
        );
      }
      if (run) runs.add(String(run.id));
      children.push({
        parentRunId,
        carrier: db.execution(carrier),
        session: db.session(session),
        command: db.command(command),
        state: child,
      });
      identities.set(String(carrier.id), {
        carrier: jsonRow(carrier),
        session: jsonRow(session),
        command: jsonRow(command),
        origin: jsonRow(origin),
        path: paths.get(String(carrier.id))!.map(jsonRow),
      });
    }
  }
  // Only retain live supervision and the ancestors needed to recreate its trusted bindings.
  const needed = new Set(
    children
      .filter(
        (child) =>
          child.state?.run.isActive ||
          ['planned', 'dispatching', 'running'].includes(child.carrier.status),
      )
      .map((child) => child.carrier.id),
  );
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index]!;
    if (!needed.has(child.carrier.id)) continue;
    const parent = children.find((candidate) => candidate.state?.run.id === child.parentRunId);
    if (parent) needed.add(parent.carrier.id);
  }
  root.children = children.filter((child) => needed.has(child.carrier.id));
  const allowed = new Set(
    [root, ...root.children.flatMap((child) => (child.state ? [child.state] : []))].flatMap(
      (state) => state.executions.map((execution) => execution.id),
    ),
  );
  for (const child of root.children) allowed.add(child.carrier.id);
  for (const execution of db.rows(
    "SELECT e.id FROM execution e LEFT JOIN session s ON s.id=e.session_id WHERE (s.root_id=? OR e.root_session_id=?) AND e.state IN('planned','dispatching','running','outcome_unknown')",
    input.sessionId,
    input.sessionId,
  ))
    if (!allowed.has(String(execution.id)))
      throw new AgentError('run_resume_checkpoint_unavailable');
  for (const active of db.rows(
    'SELECT r.id FROM run r JOIN session s ON s.id=r.session_id WHERE r.is_active=1 AND s.root_id=?',
    input.sessionId,
  ))
    if (!runs.has(String(active.id))) throw new AgentError('run_resume_checkpoint_unavailable');
  if (root.children.length)
    root.checkpoint!.groupDigest = hash({
      root: root.checkpoint!.bindingDigest,
      children: root.children.map((child) => ({
        parentRunId: child.parentRunId,
        identity: identities.get(child.carrier.id)!,
        run: (child.state?.run as unknown as Json) ?? null,
        checkpoint: (child.state?.checkpoint as unknown as Json) ?? null,
      })),
    });
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
    const before = snapshotToken(db);
    db.db.run('BEGIN');
    try {
      const input = value as RunResumeInput;
      const result = scope(db, input);
      db.db.run('COMMIT');
      if (!result.prior && before === snapshotToken(db))
        validatedScopes.set(db, {
          key: scopeKey(input),
          token: before,
          state: result.state,
          executions: result.executions,
        });
      return result.state;
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
      validatedScopes.set(db, {
        key: scopeKey({
          expectedStoreId: input.expectedStoreId,
          commandId: input.commandId,
          subjectId: input.subjectId,
          sessionId: input.sessionId,
          runId: input.runId,
          expectedOwnerGeneration: input.expectedOwnerGeneration,
        }),
        token: snapshotToken(db),
        state: s.state,
        executions: s.executions,
      });
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
    const children = s.state.children ?? [];
    const configurations = input.childConfigurations ?? [];
    for (const child of children)
      assertConfigurationReads(
        db,
        child.carrier.childConfiguration!,
        db.row('SELECT * FROM execution WHERE id=?', child.carrier.parentExecutionId!)!,
        input.expectedStoreId,
      );
    if (
      configurations.length !== children.length ||
      children.some((child) => {
        const matching = configurations.filter((item) => item.executionId === child.carrier.id);
        return (
          matching.length !== 1 ||
          canonicalJson(matching[0]!.configuration) !==
            canonicalJson(child.carrier.childConfiguration!.snapshot)
        );
      })
    )
      throw new AgentError('run_configuration_changed');
    const frontier = [
      ...s.executions,
      ...children.flatMap(
        (child) =>
          child.state?.executions.map((e) => db.row('SELECT * FROM execution WHERE id=?', e.id)!) ??
          [],
      ),
    ];
    for (const e of frontier)
      if (e.kind === 'model' && ['dispatching', 'running'].includes(String(e.state))) {
        assertEffectFreeModel(db, e);
        if (BigInt(e.result_revision!) >= 9223372036854775807n)
          throw new AgentError('sequence_exhausted');
        const partial = db.row(
          'SELECT source_json FROM message WHERE id=? AND session_id=?',
          `partial_${e.id}`,
          e.session_id!,
        );
        const body = (partial ? parse(partial.source_json) : null) as Record<string, Json> | null;
        db.run(
          "UPDATE execution SET state='failed',result_json=?,result_revision=result_revision+1 WHERE id=?",
          canonicalJson({
            code: 'model_attempt_interrupted',
            incomplete: true,
            content: typeof body?.content === 'string' ? body.content : '',
            reasoning: typeof body?.reasoning === 'string' ? body.reasoning : '',
            ...(body?.modelOutput ? { modelOutput: body.modelOutput } : {}),
          }),
          e.id!,
        );
        db.event(String(e.session_id), String(e.id), 'execution.finished');
        db.run(
          'UPDATE execution SET completed_cursor=(SELECT last_change_cursor FROM storage_meta WHERE singleton=1) WHERE id=?',
          e.id!,
        );
      } else if (e.state === 'planned' || e.kind === 'tool') {
        if (e.state === 'planned')
          transferAuthorizationReviewOwnership(db, e, String(e.owner_generation), lease.generation);
        const changed = db.row(
          'UPDATE execution SET owner_generation=? WHERE id=? AND owner_generation=? AND state=? RETURNING id',
          BigInt(lease.generation),
          e.id!,
          e.owner_generation!,
          e.state!,
        );
        if (!changed) throw new AgentError('run_resume_checkpoint_changed');
      }
    for (const child of children) {
      if (!['planned', 'dispatching', 'running'].includes(child.carrier.status)) continue;
      db.run(
        'UPDATE execution SET owner_generation=? WHERE id=?',
        BigInt(lease.generation),
        child.carrier.id,
      );
      // Transfer the existing supervision chain, including settled provenance. State and
      // result revisions stay unchanged; a terminal ancestor cannot dispatch again.
      let parentId = child.carrier.parentExecutionId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        seen.add(parentId);
        const parent = db.row('SELECT * FROM execution WHERE id=?', parentId)!;
        db.run(
          'UPDATE execution SET owner_generation=? WHERE id=?',
          BigInt(lease.generation),
          parentId,
        );
        parentId = parent.parent_execution_id === null ? null : String(parent.parent_execution_id);
      }
    }
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
