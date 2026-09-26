import type { Database } from 'bun:sqlite';

export const KITE_CROSS_SESSION_INTERRUPT_COLUMNS = Object.freeze([
  'source_session_id',
  'command_id',
  'request_digest',
  'source_run_id',
  'source_turn_id',
  'source_model_invocation_id',
  'source_tool_call_id',
  'source_effect_attempt_id',
  'source_task_id',
  'source_grant_digest',
  'source_revision',
  'target_session_id',
  'target_run_id',
  'target_task_id',
  'target_owner_generation',
  'queued_intent_event_id',
  'target_revision',
  'status',
  'accepted_generation',
  'accepted_revision',
  'terminal_revision',
  'created_at_ms',
] as const);

/** An interrupt receipt, never a second directory of live tasks. */
export const KITE_CROSS_SESSION_INTERRUPT_DDL = `CREATE TABLE agent_interrupt_intents (
  source_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
  command_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest)=64),
  source_run_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  source_model_invocation_id TEXT NOT NULL,
  source_tool_call_id TEXT NOT NULL,
  source_effect_attempt_id TEXT NOT NULL,
  source_task_id TEXT,
  source_grant_digest TEXT,
  source_revision INTEGER NOT NULL CHECK (source_revision>=1),
  target_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
  target_run_id TEXT,
  target_task_id TEXT NOT NULL,
  target_owner_generation INTEGER CHECK (target_owner_generation>=1),
  queued_intent_event_id TEXT,
  target_revision INTEGER NOT NULL CHECK (target_revision>=0),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','settled','unknown','idle')),
  accepted_generation INTEGER CHECK (accepted_generation>=target_owner_generation),
  accepted_revision INTEGER CHECK (accepted_revision>=target_revision),
  terminal_revision INTEGER CHECK (terminal_revision>=target_revision),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms>=0),
  PRIMARY KEY (source_session_id,command_id),
  UNIQUE (target_session_id,target_run_id,target_task_id),
  UNIQUE (target_session_id,target_task_id,queued_intent_event_id),
  CHECK ((target_run_id IS NULL)=(target_owner_generation IS NULL)),
  CHECK ((target_run_id IS NULL)=(queued_intent_event_id IS NOT NULL)),
  CHECK (target_run_id IS NOT NULL OR target_revision=0),
  CHECK (source_session_id<>target_session_id),
  CHECK ((accepted_generation IS NULL)=(accepted_revision IS NULL)),
  CHECK ((status='pending')=(accepted_generation IS NULL AND terminal_revision IS NULL)),
  CHECK ((status IN ('settled','unknown','idle'))=(terminal_revision IS NOT NULL))
) STRICT`;

export const KITE_CROSS_SESSION_INTERRUPT_PENDING_INDEX =
  "CREATE INDEX agent_interrupt_intents_target_pending ON agent_interrupt_intents(target_session_id,command_id) WHERE status IN ('pending','accepted')";

export interface CrossSessionInterruptTarget {
  readonly targetSessionId: string;
  readonly status: 'active' | 'queued' | 'idle' | 'unavailable';
  readonly targetRunId: string | null;
  readonly targetTaskId: string | null;
  readonly targetOwnerGeneration: number | null;
  readonly targetRevision: number;
  readonly queuedIntentEventId?: string;
}

export interface CrossSessionInterruptIntent {
  readonly sourceSessionId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly sourceRunId: string;
  readonly sourceTurnId: string;
  readonly sourceModelInvocationId: string;
  readonly sourceToolCallId: string;
  readonly sourceEffectAttemptId: string;
  readonly sourceTaskId?: string;
  readonly sourceGrantDigest?: string;
  readonly sourceRevision: number;
  readonly targetSessionId: string;
  readonly targetRunId: string | null;
  readonly targetTaskId: string;
  readonly targetOwnerGeneration: number | null;
  readonly queuedIntentEventId?: string;
  readonly targetRevision: number;
  readonly createdAtMs: number;
}

export interface CrossSessionInterruptRecord extends CrossSessionInterruptIntent {
  readonly status: 'pending' | 'accepted' | 'settled' | 'unknown' | 'idle';
  readonly acceptedGeneration: number | null;
  readonly acceptedRevision: number | null;
  readonly terminalRevision: number | null;
}

function invalid(): never {
  throw new Error('Cross-Session interrupt identity is invalid.');
}
function conflict(): never {
  throw new Error('Cross-Session interrupt intent conflicts with a durable fact.');
}
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function storedState(
  database: Database,
  sessionId: string,
): { revision: number; state: Record<string, unknown> } | null {
  const row = database
    .query<{ revision: number; state_json: string }, [string]>(
      'SELECT revision,state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(sessionId);
  if (!row) return null;
  return { revision: row.revision, state: asRecord(JSON.parse(row.state_json)) };
}

function storedGeneration(database: Database, sessionId: string): number | null {
  const row = database
    .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=?')
    .get(`session_execution/${sessionId}`);
  if (!row) return null;
  const authority = asRecord(JSON.parse(row.value));
  return authority.status === 'active' && Number.isSafeInteger(authority.controllerGeneration)
    ? (authority.controllerGeneration as number)
    : null;
}

/** Source owner may inspect only its exact direct child in the same Workspace. */
export function readCrossSessionInterruptTarget(
  database: Database,
  sourceSessionId: string,
  targetSessionId: string,
): CrossSessionInterruptTarget | null {
  if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) invalid();
  const pair = database
    .query<{ revision: number }, [string, string]>(
      `SELECT t.revision FROM runtime_sessions t JOIN runtime_sessions s
      ON t.parent_session_id=s.session_id AND t.workspace_id=s.workspace_id
      AND t.project_id=s.project_id AND t.workspace_digest=s.workspace_digest
      WHERE s.session_id=? AND t.session_id=?`,
    )
    .get(sourceSessionId, targetSessionId);
  if (!pair) return null;
  const snapshot = storedState(database, targetSessionId);
  if (!snapshot || snapshot.revision !== pair.revision) invalid();
  const state = snapshot.state;
  const origin = asRecord(state.childSessionOrigin);
  if (origin.parentSessionId !== sourceSessionId) invalid();
  const active = asRecord(state.activeFollowupTurn);
  const runId = active.targetRunId ?? asRecord(state.turn).turnId;
  const taskId = active.taskId ?? origin.childInvocationId;
  const run =
    typeof runId === 'string'
      ? database
          .query<{ status: string }, [string, string]>(
            'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
          )
          .get(targetSessionId, runId)
      : null;
  const live =
    (run?.status === 'running' || run?.status === 'waiting') &&
    state.activeTaskId === taskId &&
    asRecord(state.turn).status === 'active' &&
    typeof taskId === 'string' &&
    taskId.length > 0;
  if (!live) {
    const queued = database
      .query<
        {
          child_invocation_id: string;
          tool_event_id: string;
        },
        [string, string]
      >(`SELECT child_invocation_id,tool_event_id FROM child_session_intents
      WHERE child_thread_id=? AND parent_session_id=?
      AND failure_receipt_digest IS NULL AND parent_claim_settled_event_id IS NULL
      AND child_budget_activated_run_id IS NULL AND dispatch_ack_event_id IS NULL`)
      .get(targetSessionId, sourceSessionId);
    const anyRun = database
      .query<{ run_id: string }, [string]>(
        'SELECT run_id FROM runtime_runs WHERE session_id=? LIMIT 1',
      )
      .get(targetSessionId);
    if (
      queued &&
      !anyRun &&
      pair.revision === 0 &&
      state.activeTaskId === null &&
      typeof queued.child_invocation_id === 'string' &&
      queued.child_invocation_id.length > 0 &&
      typeof queued.tool_event_id === 'string' &&
      queued.tool_event_id.length > 0 &&
      origin.parentSessionId === sourceSessionId &&
      origin.childInvocationId === queued.child_invocation_id &&
      origin.terminal === undefined &&
      origin.taskInputAdmitted !== true
    )
      return {
        targetSessionId,
        status: 'queued',
        targetRunId: null,
        targetTaskId: queued.child_invocation_id,
        targetOwnerGeneration: null,
        targetRevision: 0,
        queuedIntentEventId: queued.tool_event_id,
      };
    return {
      targetSessionId,
      // A recovering child can still own a task without an active Run row.
      status: pair.revision === 0 || state.activeTaskId ? 'unavailable' : 'idle',
      targetRunId: null,
      targetTaskId: null,
      targetOwnerGeneration: null,
      targetRevision: pair.revision,
    };
  }
  const generation = storedGeneration(database, targetSessionId);
  return {
    targetSessionId,
    status: generation === null ? 'unavailable' : 'active',
    targetRunId: runId as string,
    targetTaskId: taskId as string,
    targetOwnerGeneration: generation,
    targetRevision: pair.revision,
  };
}

export function readCrossSessionInterruptIntent(
  database: Database,
  sourceSessionId: string,
  commandId: string,
): CrossSessionInterruptRecord | null {
  const row = database
    .query<Record<string, unknown>, [string, string]>(
      'SELECT * FROM agent_interrupt_intents WHERE source_session_id=? AND command_id=?',
    )
    .get(sourceSessionId, commandId);
  if (!row) return null;
  return {
    sourceSessionId: row.source_session_id as string,
    commandId: row.command_id as string,
    requestDigest: row.request_digest as string,
    sourceRunId: row.source_run_id as string,
    sourceTurnId: row.source_turn_id as string,
    sourceModelInvocationId: row.source_model_invocation_id as string,
    sourceToolCallId: row.source_tool_call_id as string,
    sourceEffectAttemptId: row.source_effect_attempt_id as string,
    ...(row.source_task_id ? { sourceTaskId: row.source_task_id as string } : {}),
    ...(row.source_grant_digest ? { sourceGrantDigest: row.source_grant_digest as string } : {}),
    sourceRevision: row.source_revision as number,
    targetSessionId: row.target_session_id as string,
    targetRunId: row.target_run_id as string | null,
    targetTaskId: row.target_task_id as string,
    targetOwnerGeneration: row.target_owner_generation as number | null,
    ...(row.queued_intent_event_id
      ? { queuedIntentEventId: row.queued_intent_event_id as string }
      : {}),
    targetRevision: row.target_revision as number,
    status: row.status as CrossSessionInterruptRecord['status'],
    acceptedGeneration: row.accepted_generation as number | null,
    acceptedRevision: row.accepted_revision as number | null,
    terminalRevision: row.terminal_revision as number | null,
    createdAtMs: row.created_at_ms as number,
  };
}

export function acceptCrossSessionInterruptInTransaction(
  database: Database,
  intent: CrossSessionInterruptIntent,
): void {
  const prior = readCrossSessionInterruptIntent(database, intent.sourceSessionId, intent.commandId);
  if (prior) {
    for (const key of Object.keys(intent) as (keyof CrossSessionInterruptIntent)[])
      if (prior[key] !== intent[key]) conflict();
    return;
  }
  if (
    !Number.isSafeInteger(intent.createdAtMs) ||
    intent.createdAtMs < 0 ||
    !/^[a-f0-9]{64}$/u.test(intent.requestDigest)
  )
    invalid();
  const receipt = database
    .query<{ request_digest: string; committed_revision: number }, [string, string]>(
      `SELECT request_digest,committed_revision FROM runtime_command_receipts
      WHERE scope_session_id=? AND target_session_id=scope_session_id AND command_id=?`,
    )
    .get(intent.sourceSessionId, intent.commandId);
  if (
    receipt?.request_digest !== intent.requestDigest ||
    receipt.committed_revision !== intent.sourceRevision
  )
    invalid();
  const source = storedState(database, intent.sourceSessionId);
  if (!source || source.revision !== intent.sourceRevision) invalid();
  const state = source.state;
  const tool = asRecord(asRecord(asRecord(state.tools).calls)[intent.sourceToolCallId]);
  const invocation = Object.values(asRecord(asRecord(state.capabilities).invocations))
    .map(asRecord)
    .filter((item) => item.toolCallId === intent.sourceToolCallId && item.status === 'running');
  const exact = invocation[0];
  if (
    asRecord(state.turn).turnId !== intent.sourceTurnId ||
    asRecord(state.turn).status !== 'active' ||
    tool.name !== 'interrupt_agent' ||
    asRecord(tool.args).agent_id !== intent.targetSessionId ||
    tool.modelInvocationId !== intent.sourceModelInvocationId ||
    tool.status !== 'running' ||
    tool.createdAtTurnId !== intent.sourceTurnId ||
    invocation.length !== 1 ||
    exact?.capabilityId !== 'builtin:interrupt_agent' ||
    intent.sourceEffectAttemptId !== `${exact.invocationId}:attempt:${exact.attemptsStarted}` ||
    !Array.isArray(asRecord(state.tools).active) ||
    !(asRecord(state.tools).active as unknown[]).includes(intent.sourceToolCallId)
  )
    invalid();
  const run = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(intent.sourceSessionId, intent.sourceRunId);
  if (!run || (run.status !== 'running' && run.status !== 'waiting')) invalid();
  const origin = asRecord(state.childSessionOrigin);
  if (origin.parentSessionId) {
    const grant = database
      .query<
        {
          child_invocation_id: string;
          grant_digest: string;
          failure_receipt_digest: string | null;
        },
        [string]
      >(
        'SELECT child_invocation_id,grant_digest,failure_receipt_digest FROM child_session_intents WHERE child_thread_id=?',
      )
      .get(intent.sourceSessionId);
    if (
      !grant ||
      grant.failure_receipt_digest ||
      grant.child_invocation_id !== intent.sourceTaskId ||
      grant.grant_digest !== intent.sourceGrantDigest
    )
      invalid();
  } else if (intent.sourceTaskId || intent.sourceGrantDigest) invalid();
  const target = readCrossSessionInterruptTarget(
    database,
    intent.sourceSessionId,
    intent.targetSessionId,
  );
  if (
    !target ||
    (intent.targetRunId === null ? target.status !== 'queued' : target.status !== 'active') ||
    target.targetRunId !== intent.targetRunId ||
    target.targetTaskId !== intent.targetTaskId ||
    target.targetOwnerGeneration !== intent.targetOwnerGeneration ||
    target.queuedIntentEventId !== intent.queuedIntentEventId ||
    target.targetRevision !== intent.targetRevision
  )
    conflict();
  database
    .query(`INSERT INTO agent_interrupt_intents
    (source_session_id,command_id,request_digest,source_run_id,source_turn_id,
      source_model_invocation_id,source_tool_call_id,source_effect_attempt_id,
      source_task_id,source_grant_digest,source_revision,target_session_id,
      target_run_id,target_task_id,target_owner_generation,queued_intent_event_id,target_revision,status,created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`)
    .run(
      intent.sourceSessionId,
      intent.commandId,
      intent.requestDigest,
      intent.sourceRunId,
      intent.sourceTurnId,
      intent.sourceModelInvocationId,
      intent.sourceToolCallId,
      intent.sourceEffectAttemptId,
      intent.sourceTaskId ?? null,
      intent.sourceGrantDigest ?? null,
      intent.sourceRevision,
      intent.targetSessionId,
      intent.targetRunId,
      intent.targetTaskId,
      intent.targetOwnerGeneration,
      intent.queuedIntentEventId ?? null,
      intent.targetRevision,
      intent.createdAtMs,
    );
}

/** Target owner pins its current Run before the existing task-control path acts. */
export function acknowledgeCrossSessionInterruptInTransaction(
  database: Database,
  input: {
    readonly sourceSessionId: string;
    readonly commandId: string;
    readonly targetSessionId: string;
    readonly targetGeneration: number;
    readonly targetRevision: number;
    readonly event: Record<string, unknown>;
  },
): CrossSessionInterruptRecord {
  const intent = readCrossSessionInterruptIntent(database, input.sourceSessionId, input.commandId);
  if (
    !intent ||
    intent.targetSessionId !== input.targetSessionId ||
    intent.targetRunId === null ||
    intent.targetOwnerGeneration === null
  )
    invalid();
  if (
    intent.status === 'accepted' &&
    intent.acceptedGeneration === input.targetGeneration &&
    intent.acceptedRevision === input.targetRevision
  )
    return intent;
  if (intent.status !== 'pending') conflict();
  const target = readCrossSessionInterruptTarget(
    database,
    input.sourceSessionId,
    input.targetSessionId,
  );
  if (
    target?.status === 'idle' &&
    storedGeneration(database, input.targetSessionId) === input.targetGeneration &&
    input.targetGeneration >= intent.targetOwnerGeneration &&
    input.targetRevision === target.targetRevision &&
    input.event.type === 'background_execution.stop_unknown' &&
    input.event.commandId === intent.commandId &&
    input.event.executionId === intent.targetTaskId &&
    input.event.reason === 'target_already_idle'
  ) {
    database
      .query(`UPDATE agent_interrupt_intents SET status='idle',terminal_revision=?
      WHERE source_session_id=? AND command_id=? AND status='pending'`)
      .run(input.targetRevision, input.sourceSessionId, input.commandId);
    return readCrossSessionInterruptIntent(database, input.sourceSessionId, input.commandId)!;
  }
  if (
    target?.status !== 'active' ||
    target.targetRunId !== intent.targetRunId ||
    target.targetTaskId !== intent.targetTaskId ||
    target.targetOwnerGeneration !== input.targetGeneration ||
    target.targetRevision !== input.targetRevision ||
    input.targetGeneration < intent.targetOwnerGeneration ||
    input.event.type !== 'background_execution.stop_requested' ||
    input.event.commandId !== intent.commandId ||
    input.event.executionId !== intent.targetTaskId ||
    input.event.executionKind !== 'subagent' ||
    input.event.ownerGeneration !== `child:${input.targetGeneration}`
  )
    conflict();
  database
    .query(`UPDATE agent_interrupt_intents SET status='accepted',accepted_generation=?,accepted_revision=?
    WHERE source_session_id=? AND command_id=? AND status='pending'`)
    .run(input.targetGeneration, input.targetRevision, input.sourceSessionId, input.commandId);
  return readCrossSessionInterruptIntent(database, input.sourceSessionId, input.commandId)!;
}

/** Completion may only report cleanup after the existing Run has actually terminalized. */
export function settleCrossSessionInterruptInTransaction(
  database: Database,
  input: {
    readonly sourceSessionId: string;
    readonly commandId: string;
    readonly targetSessionId: string;
    readonly targetGeneration: number;
    readonly targetRevision: number;
    readonly event: Record<string, unknown>;
  },
): CrossSessionInterruptRecord {
  const intent = readCrossSessionInterruptIntent(database, input.sourceSessionId, input.commandId);
  if (
    !intent ||
    intent.targetSessionId !== input.targetSessionId ||
    intent.status !== 'accepted' ||
    intent.targetRunId === null ||
    input.targetGeneration < (intent.acceptedGeneration ?? 0)
  )
    invalid();
  const target = storedState(database, input.targetSessionId);
  const run = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, intent.targetRunId);
  if (
    !target ||
    target.revision !== input.targetRevision ||
    storedGeneration(database, input.targetSessionId) !== input.targetGeneration ||
    input.event.commandId !== intent.commandId ||
    input.event.executionId !== intent.targetTaskId
  )
    invalid();
  const unknownEffect =
    database
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM runtime_effect_leases WHERE session_id=? AND (state='unknown' OR certainty='uncertain')",
      )
      .get(input.targetSessionId)?.count ?? 0;
  const outcome =
    input.event.type === 'background_execution.stop_settled' &&
    input.event.cleanupConfirmed === true &&
    run?.status === 'cancelled' &&
    unknownEffect === 0
      ? 'settled'
      : input.event.type === 'background_execution.stop_unknown' && run?.status === 'unknown'
        ? 'unknown'
        : input.event.type === 'background_execution.stop_unknown' &&
            input.event.reason === 'target_completed_before_cleanup' &&
            (run?.status === 'completed' || run?.status === 'failed')
          ? 'idle'
          : null;
  if (!outcome) invalid();
  database
    .query(`UPDATE agent_interrupt_intents SET status=?,terminal_revision=?
    WHERE source_session_id=? AND command_id=? AND status='accepted'`)
    .run(outcome, input.targetRevision, input.sourceSessionId, input.commandId);
  return readCrossSessionInterruptIntent(database, input.sourceSessionId, input.commandId)!;
}

export function listPendingCrossSessionInterrupts(
  database: Database,
  targetSessionId: string,
  limit: number,
): readonly CrossSessionInterruptRecord[] {
  if (!targetSessionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 64) invalid();
  const commands = database
    .query<{ source_session_id: string; command_id: string }, [string, number]>(
      `SELECT source_session_id,command_id FROM agent_interrupt_intents
      WHERE target_session_id=? AND status IN ('pending','accepted') ORDER BY command_id LIMIT ?`,
    )
    .all(targetSessionId, limit);
  return commands
    .map(
      ({ source_session_id, command_id }) =>
        readCrossSessionInterruptIntent(database, source_session_id, command_id)!,
    )
    .filter(Boolean);
}

/** Offline maintenance verifies receipts without inferring a live task from old rows. */
export function validateCrossSessionInterruptContinuity(database: Database): void {
  const broken =
    database
      .query<{ count: number }, []>(`SELECT count(*) AS count
    FROM agent_interrupt_intents i
    LEFT JOIN runtime_sessions source ON source.session_id=i.source_session_id
    LEFT JOIN runtime_sessions target ON target.session_id=i.target_session_id
    LEFT JOIN runtime_command_receipts receipt ON receipt.scope_session_id=i.source_session_id
      AND receipt.target_session_id=i.source_session_id AND receipt.command_id=i.command_id
    LEFT JOIN runtime_runs source_run ON source_run.session_id=i.source_session_id AND source_run.run_id=i.source_run_id
    LEFT JOIN runtime_runs target_run ON target_run.session_id=i.target_session_id AND target_run.run_id=i.target_run_id
    WHERE source.session_id IS NULL OR target.session_id IS NULL OR
      target.parent_session_id<>i.source_session_id OR target.workspace_id<>source.workspace_id OR
      target.project_id<>source.project_id OR target.workspace_digest<>source.workspace_digest OR
      receipt.command_id IS NULL OR receipt.request_digest<>i.request_digest OR
      receipt.committed_revision<>i.source_revision OR source_run.run_id IS NULL OR
      (i.target_run_id IS NOT NULL AND target_run.run_id IS NULL) OR
      (i.target_run_id IS NULL AND target.revision<0) OR i.source_revision>source.revision OR
      i.target_revision>target.revision OR
      (i.accepted_revision IS NOT NULL AND i.accepted_revision>target.revision) OR
      (i.terminal_revision IS NOT NULL AND i.terminal_revision>
        CASE WHEN i.target_run_id IS NULL THEN source.revision ELSE target.revision END) OR
      NOT EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id=i.source_session_id
        AND json_extract(e.event_json,'$.type')='background_execution.stop_requested'
        AND json_extract(e.event_json,'$.commandId')=i.command_id
        AND json_extract(e.event_json,'$.executionId')=i.target_task_id)
  `)
      .get()?.count ?? 0;
  if (broken !== 0) throw new Error('Cross-Session interrupt continuity is invalid.');
}

/** Read-only startup index. A Session ID is a recovery candidate, never an execution handle. */
export function listPendingCrossSessionInterruptTargets(
  database: Database,
  limit: number,
  afterSessionId?: string,
): readonly string[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (afterSessionId !== undefined && !afterSessionId)
  )
    invalid();
  return database
    .query<{ target_session_id: string }, (string | number)[]>(
      `SELECT DISTINCT target_session_id FROM agent_interrupt_intents
      WHERE status IN ('pending','accepted')
      ${afterSessionId ? 'AND target_session_id>?' : ''}
      ORDER BY target_session_id LIMIT ?`,
    )
    .all(...(afterSessionId ? [afterSessionId] : []), limit)
    .map((row) => row.target_session_id);
}

/** Parent owner resolves a revision-zero child through the original task-control authority. */
export function settleQueuedCrossSessionInterruptInTransaction(
  database: Database,
  input: {
    readonly sourceSessionId: string;
    readonly commandId: string;
    readonly targetSessionId: string;
    readonly sourceRevision: number;
    readonly event: Record<string, unknown>;
  },
): CrossSessionInterruptRecord {
  const prior = readCrossSessionInterruptIntent(database, input.sourceSessionId, input.commandId);
  if (
    prior?.status !== 'pending' ||
    prior.targetRunId !== null ||
    prior.targetSessionId !== input.targetSessionId ||
    !prior.queuedIntentEventId ||
    input.event.commandId !== input.commandId ||
    input.event.executionId !== prior.targetTaskId
  )
    invalid();
  const source = storedState(database, input.sourceSessionId);
  if (!source || source.revision !== input.sourceRevision) invalid();
  const child = database
    .query<
      {
        child_invocation_id: string;
        tool_event_id: string;
        child_budget_activated_run_id: string | null;
        dispatch_ack_event_id: string | null;
        failure_receipt_digest: string | null;
        parent_claim_settled_event_id: string | null;
      },
      [string, string]
    >(`SELECT child_invocation_id,tool_event_id,child_budget_activated_run_id,
    dispatch_ack_event_id,failure_receipt_digest,parent_claim_settled_event_id
    FROM child_session_intents WHERE child_thread_id=? AND parent_session_id=?`)
    .get(prior.targetSessionId, prior.sourceSessionId);
  const anyRun = database
    .query<{ run_id: string }, [string]>(
      'SELECT run_id FROM runtime_runs WHERE session_id=? LIMIT 1',
    )
    .get(prior.targetSessionId);
  if (
    !child ||
    child.child_invocation_id !== prior.targetTaskId ||
    child.tool_event_id !== prior.queuedIntentEventId ||
    child.child_budget_activated_run_id ||
    child.dispatch_ack_event_id ||
    anyRun
  )
    conflict();
  const terminal = Boolean(child.failure_receipt_digest || child.parent_claim_settled_event_id);
  const outcome =
    input.event.type === 'background_execution.stop_settled' &&
    input.event.cleanupConfirmed === true &&
    terminal
      ? 'settled'
      : input.event.type === 'background_execution.stop_unknown' &&
          input.event.reason === 'target_already_idle' &&
          terminal
        ? 'idle'
        : input.event.type === 'background_execution.stop_unknown' &&
            typeof input.event.reason === 'string' &&
            input.event.reason.length > 0
          ? 'unknown'
          : null;
  if (!outcome) invalid();
  database
    .query(`UPDATE agent_interrupt_intents SET status=?,terminal_revision=?
    WHERE source_session_id=? AND command_id=? AND status='pending'`)
    .run(outcome, input.sourceRevision, input.sourceSessionId, input.commandId);
  return readCrossSessionInterruptIntent(database, input.sourceSessionId, input.commandId)!;
}

/** Serializes a queued stop receipt against child Run/budget activation. */
export function assertNoQueuedInterruptBeforeChildActivation(
  database: Database,
  targetSessionId: string,
): void {
  const pending = database
    .query<{ command_id: string }, [string]>(
      `SELECT command_id FROM agent_interrupt_intents WHERE target_session_id=?
      AND target_run_id IS NULL AND status IN ('pending','unknown') LIMIT 1`,
    )
    .get(targetSessionId);
  if (pending) conflict();
}
