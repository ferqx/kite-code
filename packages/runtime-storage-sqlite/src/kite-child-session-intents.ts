import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type {
  RuntimeChildSessionIntentMutation,
  RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';
import {
  assertChildBudgetWithinDelegation,
  CHILD_SESSION_TASK_USER_GOAL,
  childDelegatedUpperBoundDigest,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import { verifyCompletedChildFollowupModelWork } from './kite-cross-session-followup';

export const KITE_CHILD_SESSION_INTENT_COLUMNS = [
  'child_thread_id',
  'parent_session_id',
  'parent_invocation_id',
  'origin_run_id',
  'origin_turn_id',
  'origin_tool_call_id',
  'attempt',
  'child_invocation_id',
  'grant_digest',
  'sealed_grant_json',
  'sealed_grant_byte_length',
  'sealed_grant_digest',
  'task_artifact_digest',
  'task_text_digest',
  'task_artifact_id',
  'task_artifact_byte_length',
  'disposition',
  'role',
  'tool_event_id',
  'tool_event_revision',
  'funding_run_id',
  'delegated_reservation_id',
  'delegated_upper_bound_digest',
  'delegated_upper_bound_json',
  'deadline_at',
  'failure_receipt_digest',
  'failure_mode',
  'child_budget_activated_run_id',
  'child_budget_activated_event_id',
  'child_budget_activated_revision',
  'dispatch_ack_event_id',
  'dispatch_ack_revision',
  'parent_claim_settled_event_id',
  'parent_claim_settled_revision',
] as const;

export const KITE_CHILD_SESSION_INTENT_DDL = `CREATE TABLE child_session_intents (
  child_thread_id TEXT PRIMARY KEY NOT NULL,
  parent_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
  parent_invocation_id TEXT NOT NULL,
  origin_run_id TEXT NOT NULL,
  origin_turn_id TEXT NOT NULL,
  origin_tool_call_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  child_invocation_id TEXT NOT NULL,
  grant_digest TEXT NOT NULL,
  sealed_grant_json TEXT NOT NULL CHECK (json_valid(sealed_grant_json)),
  sealed_grant_byte_length INTEGER NOT NULL CHECK (sealed_grant_byte_length BETWEEN 1 AND 131072),
  sealed_grant_digest TEXT NOT NULL,
  task_artifact_digest TEXT NOT NULL,
  task_text_digest TEXT NOT NULL,
  task_artifact_id TEXT NOT NULL REFERENCES subagent_task_artifacts(artifact_id),
  task_artifact_byte_length INTEGER NOT NULL CHECK (task_artifact_byte_length >= 1),
  disposition TEXT NOT NULL CHECK (disposition IN ('required','after_turn')),
  role TEXT NOT NULL CHECK (role IN ('explore','plan','code','review')),
  tool_event_id TEXT NOT NULL,
  tool_event_revision INTEGER NOT NULL CHECK (tool_event_revision >= 1),
  funding_run_id TEXT NOT NULL,
  delegated_reservation_id TEXT NOT NULL UNIQUE,
  delegated_upper_bound_digest TEXT NOT NULL,
  delegated_upper_bound_json TEXT NOT NULL CHECK (json_valid(delegated_upper_bound_json)),
  deadline_at TEXT NOT NULL,
  failure_receipt_digest TEXT,
  failure_mode TEXT CHECK (failure_mode IN ('absent_child','created_unactivated','activated_no_ack')),
  child_budget_activated_run_id TEXT,
  child_budget_activated_event_id TEXT,
  child_budget_activated_revision INTEGER,
  dispatch_ack_event_id TEXT,
  dispatch_ack_revision INTEGER,
  parent_claim_settled_event_id TEXT,
  parent_claim_settled_revision INTEGER,
  UNIQUE(parent_session_id,parent_invocation_id,origin_tool_call_id,attempt),
  UNIQUE(parent_session_id,child_invocation_id)
) STRICT`;

export const KITE_CHILD_SESSION_INTENT_PENDING_INDEX = `CREATE INDEX child_session_intents_parent_pending
  ON child_session_intents(parent_session_id,child_thread_id)
  WHERE failure_receipt_digest IS NULL AND parent_claim_settled_event_id IS NULL`;

export interface KiteChildSessionIntentRecord
  extends Omit<RuntimeChildSessionIntentMutation, 'sealedGrantJson'> {
  readonly taskArtifactId: string;
  readonly taskArtifactByteLength: number;
  readonly delegatedUpperBoundJson: string;
  readonly toolEventId: string;
  readonly toolEventRevision: number;
  readonly childSessionCreated: boolean;
  readonly failureReceiptDigest: string | null;
  readonly failureMode: 'absent_child' | 'created_unactivated' | 'activated_no_ack' | null;
  readonly childBudgetActivatedRunId: string | null;
  readonly childBudgetActivatedEventId: string | null;
  readonly childBudgetActivatedRevision: number | null;
  readonly dispatchAckEventId: string | null;
  readonly dispatchAckRevision: number | null;
  readonly parentClaimSettledEventId: string | null;
  readonly parentClaimSettledRevision: number | null;
}

/** Store evidence of an acknowledged, sealed child awaiting its parent import. */
export interface KitePendingChildTerminalSeal {
  readonly childThreadId: string;
  readonly parentInvocationId: string;
  readonly childInvocationId: string;
  readonly fundingRunId: string;
  readonly delegatedReservationId: string;
  readonly sealEventId: string;
  readonly sealRevision: number;
  readonly terminalReceiptId: string;
  readonly status:
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted'
    | 'exhausted'
    | 'suspended'
    | 'unknown';
}

const fields = [
  'childThreadId',
  'parentSessionId',
  'parentInvocationId',
  'originRunId',
  'originTurnId',
  'originToolCallId',
  'attempt',
  'childInvocationId',
  'grantDigest',
  'sealedGrantByteLength',
  'sealedGrantDigest',
  'taskArtifactRef',
  'taskArtifactDigest',
  'taskTextDigest',
  'disposition',
  'role',
  'fundingRunId',
  'delegatedReservationId',
  'delegatedUpperBoundDigest',
  'deadlineAt',
] as const;

function exactTuple(a: RuntimeChildSessionIntentMutation, b: object): boolean {
  const record = b as Record<string, unknown>;
  return fields.every((field) =>
    field === 'taskArtifactRef'
      ? sameTaskRef(a.taskArtifactRef, record.taskArtifactRef)
      : a[field] === record[field],
  );
}

function exactIntendedEventTuple(a: RuntimeChildSessionIntentMutation, b: object): boolean {
  const record = b as Record<string, unknown>;
  return fields
    .filter((field) => field !== 'sealedGrantByteLength' && field !== 'sealedGrantDigest')
    .every((field) =>
      field === 'taskArtifactRef'
        ? sameTaskRef(a.taskArtifactRef, record.taskArtifactRef)
        : a[field] === record[field],
    );
}

function deterministicChildId(intent: RuntimeChildSessionIntentMutation): string {
  return `child_${createHash('sha256')
    .update(
      JSON.stringify([
        'kite.child-session.v1',
        intent.parentSessionId,
        intent.parentInvocationId,
        intent.originToolCallId,
        intent.attempt,
      ]),
    )
    .digest('hex')}`;
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function sameTaskRef(left: unknown, right: unknown): boolean {
  const a = object(left);
  const b = object(right);
  return (
    !!a &&
    !!b &&
    a.artifactId === b.artifactId &&
    a.kind === 'subagent_task' &&
    b.kind === 'subagent_task' &&
    a.integrityIdentifier === b.integrityIdentifier &&
    a.byteLength === b.byteLength &&
    Object.keys(a).length === 4 &&
    Object.keys(b).length === 4
  );
}

/** Store-side attestation of Builtin's versioned private Artifact reference.
 * The Store deliberately cannot depend on Builtin; the integration test uses
 * its actual writer so this exact domain binding cannot drift unnoticed. */
function matchesDurableTaskReference(input: {
  readonly artifactId: string;
  readonly integrityIdentifier: string;
  readonly byteLength: number;
  readonly canonicalJson: string;
}): boolean {
  const bytes = Buffer.from(input.canonicalJson, 'utf8');
  if (bytes.byteLength !== input.byteLength || bytes.byteLength < 1) return false;
  const material = `subagent-tasks\0subagent_task\0${createHash('sha256').update(bytes).digest('hex')}`;
  const artifactId = `pa_${createHash('sha256')
    .update('kite.private-immutable-artifact.id.v1\0')
    .update(material)
    .digest('hex')}`;
  const integrityIdentifier = `sha256:${createHash('sha256')
    .update('kite.private-immutable-artifact.integrity.v1\0')
    .update(material)
    .update('\0')
    .update(artifactId)
    .update('\0')
    .update(String(bytes.byteLength))
    .digest('hex')}`;
  return input.artifactId === artifactId && input.integrityIdentifier === integrityIdentifier;
}

export function persistChildSessionIntentInTransaction<Event, State>(
  database: Database,
  channel: string,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  const intent = transaction.childSessionIntent;
  if (!intent) return;
  if (
    channel !== 'receipt_evidence' ||
    transaction.sessionId !== intent.parentSessionId ||
    (intent.disposition !== 'required' && intent.disposition !== 'after_turn') ||
    !Number.isSafeInteger(intent.attempt) ||
    intent.attempt < 1 ||
    intent.childThreadId !== deterministicChildId(intent) ||
    fields.some((field) => typeof intent[field] === 'string' && !(intent[field] as string).trim())
  )
    throw new Error('Child Session intent identity is invalid.');
  let sealedGrant: Record<string, unknown> | null = null;
  try {
    sealedGrant = object(JSON.parse(intent.sealedGrantJson));
  } catch {
    /* invalid JSON */
  }
  if (!sealedGrant) throw new Error('Child Session sealed grant is not JSON.');
  const sealed = sealChildGrantPayload(sealedGrant);
  if (
    sealed.sealedGrantJson !== intent.sealedGrantJson ||
    sealed.sealedGrantByteLength !== intent.sealedGrantByteLength ||
    sealed.sealedGrantDigest !== intent.sealedGrantDigest ||
    intent.grantDigest !== intent.sealedGrantDigest ||
    sealedGrant.purpose !== 'start' ||
    sealedGrant.parentInvocationId !== intent.parentInvocationId ||
    sealedGrant.parentToolCallId !== intent.originToolCallId ||
    sealedGrant.parentAttempt !== intent.attempt ||
    sealedGrant.childInvocationId !== intent.childInvocationId ||
    sealedGrant.role !== intent.role ||
    !sameTaskRef(sealedGrant.taskArtifact, intent.taskArtifactRef) ||
    sealedGrant.taskDigest !== intent.taskTextDigest
  )
    throw new Error('Child Session sealed grant tuple or bytes conflict.');
  const typed = transaction.events.map(object);
  const indexed = (type: string) =>
    typed.flatMap((event, index) => (event?.type === type ? [{ event, index }] : []));
  const intents = indexed('subagent.child_session_intended');
  const dispatches = indexed('capability.subagent_dispatch_intent_recorded');
  const subagentStarts = indexed('subagent.started');
  const terminals = indexed('tool.finished');
  const reservations = indexed('resource_budget.reserved');
  const allotments = reservations.filter(
    ({ event }) =>
      object(event.reservation)?.invocationId === `child-allotment:${intent.childThreadId}`,
  );
  const reports = reservations.filter(
    ({ event }) =>
      object(event.reservation)?.invocationId ===
      `model-invocation:after-turn:${intent.childInvocationId}`,
  );
  if (
    intents.length !== 1 ||
    dispatches.length !== 1 ||
    subagentStarts.length !== 1 ||
    terminals.length !== 1 ||
    reservations.length !== (intent.disposition === 'after_turn' ? 2 : 1) ||
    allotments.length !== 1 ||
    reports.length !== (intent.disposition === 'after_turn' ? 1 : 0)
  )
    throw new Error('Child Session acceptance batch is incomplete or ambiguous.');
  const intended = intents[0]!;
  const dispatch = dispatches[0]!;
  const terminal = terminals[0]!;
  const taskArtifact = object(dispatch.event.taskArtifact);
  const subagent = object(subagentStarts[0]!.event.subagent);
  const result = object(terminal.event.result);
  const resultMeta = object(result?.resultMeta);
  const reservation = object(allotments[0]!.event.reservation);
  const report = reports[0] ? object(reports[0].event.reservation) : undefined;
  const reportUpper = object(report?.executableUpperBound);
  const reportCounters = object(reportUpper?.counters);
  const reportGauges = object(reportUpper?.gauges);
  const metadata = transaction.metadata?.[terminal.index];
  if (
    !exactIntendedEventTuple(intent, intended.event) ||
    dispatch.event.invocationId !== intent.parentInvocationId ||
    dispatch.event.childInvocationId !== intent.childInvocationId ||
    dispatch.event.attempt !== intent.attempt ||
    subagent?.id !== intent.childInvocationId ||
    subagent.role !== intent.role ||
    !sameTaskRef(taskArtifact, intent.taskArtifactRef) ||
    taskArtifact?.integrityIdentifier !== intent.taskArtifactDigest ||
    taskArtifact?.kind !== 'subagent_task' ||
    typeof taskArtifact.artifactId !== 'string' ||
    !Number.isSafeInteger(taskArtifact.byteLength) ||
    (taskArtifact.byteLength as number) < 1 ||
    terminal.event.toolCallId !== intent.originToolCallId ||
    terminal.event.name !== 'task' ||
    result?.ok !== true ||
    resultMeta?.taskId !== intent.childInvocationId ||
    resultMeta?.taskStatus !== 'running' ||
    resultMeta?.taskDisposition !== intent.disposition ||
    reservation?.reservationId !== intent.delegatedReservationId ||
    reservation?.runId !== intent.fundingRunId ||
    reservation?.invocationId !== `child-allotment:${intent.childThreadId}` ||
    reservation?.resourceKind !== 'subagent' ||
    (reservation?.state !== 'reserved' && reservation?.state !== 'queued') ||
    object(reservation?.executableUpperBound)?.source !== 'versioned_upper_bound' ||
    object(object(reservation?.executableUpperBound)?.gauges)?.activeSubagents !== 1 ||
    childDelegatedUpperBoundDigest(reservation?.executableUpperBound as never) !==
      intent.delegatedUpperBoundDigest ||
    (intent.disposition === 'after_turn' &&
      (report?.runId !== intent.fundingRunId ||
        report.resourceKind !== 'model' ||
        report.state !== 'reserved' ||
        report.parentReservationId !== undefined ||
        reportUpper?.source !== 'versioned_upper_bound' ||
        reportCounters?.modelRequests !== 1 ||
        !Number.isSafeInteger(reportCounters.inputTokens) ||
        (reportCounters.inputTokens as number) <
          (reportUpper?.unboundedModelTokens === true ? 0 : 1) ||
        !Number.isSafeInteger(reportCounters.outputTokens) ||
        (reportCounters.outputTokens as number) <
          (reportUpper?.unboundedModelTokens === true ? 0 : 1) ||
        reportGauges?.activeSubagents !== 0 ||
        reportGauges?.activeWriters !== 0 ||
        !(allotments[0]!.index < reports[0]!.index && reports[0]!.index < intended.index))) ||
    !(
      dispatch.index < intended.index &&
      subagentStarts[0]!.index < intended.index &&
      intended.index < terminal.index
    ) ||
    !metadata?.eventId ||
    !Number.isSafeInteger(metadata.revision) ||
    metadata.revision < 1
  )
    throw new Error('Child Session intent does not match the parent Tool terminal.');
  const artifact = database
    .query<
      {
        artifact_id: string;
        kind: string;
        integrity_identifier: string;
        byte_length: number;
        canonical_json: string;
      },
      [string]
    >(
      'SELECT artifact_id,kind,integrity_identifier,byte_length,canonical_json FROM subagent_task_artifacts WHERE artifact_id = ?',
    )
    .get(taskArtifact.artifactId as string);
  if (
    artifact?.kind !== 'subagent_task' ||
    artifact.integrity_identifier !== intent.taskArtifactDigest ||
    artifact.byte_length !== taskArtifact.byteLength ||
    !matchesDurableTaskReference({
      artifactId: artifact.artifact_id,
      integrityIdentifier: artifact.integrity_identifier,
      byteLength: artifact.byte_length,
      canonicalJson: artifact.canonical_json,
    })
  )
    throw new Error('Child Session Task Artifact reference is not durable.');
  const payload = object(JSON.parse(artifact.canonical_json));
  const owner = object(payload?.owner);
  if (
    payload?.artifactFormatVersion !== 1 ||
    typeof payload.task !== 'string' ||
    payload.taskDigest !== intent.taskTextDigest ||
    payload.taskByteLength !== Buffer.byteLength(payload.task, 'utf8') ||
    `sha256:${createHash('sha256').update(payload.task, 'utf8').digest('hex')}` !==
      intent.taskTextDigest ||
    owner?.parentInvocationId !== intent.parentInvocationId ||
    owner.parentAttempt !== intent.attempt ||
    owner.parentToolCallId !== intent.originToolCallId ||
    owner.childInvocationId !== intent.childInvocationId
  )
    throw new Error('Child Session Task Artifact owner or task digest conflicts.');
  const snapshot = object(transaction.snapshot);
  const activeLedger = object(snapshot?.resourceBudget);
  const retained = object(snapshot?.retainedResourceBudgets);
  const ledger =
    activeLedger?.runId === intent.fundingRunId
      ? activeLedger
      : object(retained?.[intent.fundingRunId]);
  if (
    ledger?.status !== 'active' ||
    ledger.deadlineAt !== intent.deadlineAt ||
    reservation?.runId !== ledger.runId ||
    (intent.disposition === 'after_turn' &&
      (JSON.stringify(object(object(ledger.reservations)?.[intent.delegatedReservationId])) !==
        JSON.stringify(reservation) ||
        JSON.stringify(object(object(ledger.reservations)?.[report?.reservationId as string])) !==
          JSON.stringify(report)))
  )
    throw new Error('Child Session allotment has no exact funding ledger deadline.');
  const existing = readChildSessionIntent(database, intent.childThreadId);
  const { sealedGrantJson: _, ...publicIntent } = intent;
  const expected = {
    ...publicIntent,
    toolEventId: metadata.eventId,
    toolEventRevision: metadata.revision,
  };
  if (existing) {
    if (
      Object.entries(expected).some(([key, value]) =>
        key === 'taskArtifactRef'
          ? !sameTaskRef(existing.taskArtifactRef, value)
          : (existing as unknown as Record<string, unknown>)[key] !== value,
      )
    )
      throw new Error('Child Session intent replay conflicts with its durable identity.');
    if (existing.delegatedUpperBoundJson !== JSON.stringify(reservation.executableUpperBound))
      throw new Error('Child Session delegated ceiling replay conflicts.');
    if (
      readChildSealedGrant(database, intent.parentSessionId, intent.childThreadId)
        ?.sealedGrantJson !== intent.sealedGrantJson
    )
      throw new Error('Child Session sealed grant replay conflicts.');
    return;
  }
  database
    .query(`INSERT INTO child_session_intents (
    child_thread_id,parent_session_id,parent_invocation_id,origin_run_id,origin_turn_id,
    origin_tool_call_id,attempt,child_invocation_id,grant_digest,
    sealed_grant_json,sealed_grant_byte_length,sealed_grant_digest,
    task_artifact_digest,task_text_digest,
    task_artifact_id,task_artifact_byte_length,
    disposition,role,tool_event_id,tool_event_revision,funding_run_id,delegated_reservation_id,
    delegated_upper_bound_digest,delegated_upper_bound_json,deadline_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      intent.childThreadId,
      intent.parentSessionId,
      intent.parentInvocationId,
      intent.originRunId,
      intent.originTurnId,
      intent.originToolCallId,
      intent.attempt,
      intent.childInvocationId,
      intent.grantDigest,
      intent.sealedGrantJson,
      intent.sealedGrantByteLength,
      intent.sealedGrantDigest,
      intent.taskArtifactDigest,
      intent.taskTextDigest,
      taskArtifact.artifactId,
      taskArtifact.byteLength,
      intent.disposition,
      intent.role,
      metadata.eventId,
      metadata.revision,
      intent.fundingRunId,
      intent.delegatedReservationId,
      intent.delegatedUpperBoundDigest,
      JSON.stringify(reservation.executableUpperBound),
      intent.deadlineAt,
    );
}

export function settleChildCreationFailureInTransaction<Event, State>(
  database: Database,
  channel: string,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  const failure = transaction.childCreationFailure;
  if (!failure) return;
  if (
    channel !== 'receipt_evidence' ||
    transaction.sessionId !== failure.parentSessionId ||
    !/^sha256:[a-f0-9]{64}$/u.test(failure.failureReceiptDigest) ||
    !['absent_child', 'created_unactivated', 'activated_no_ack'].includes(failure.mode) ||
    transaction.childSessionIntent
  )
    throw new Error('Child creation failure has no exact parent receipt boundary.');
  const intent = readChildSessionIntent(database, failure.childThreadId);
  if (!intent || intent.parentSessionId !== failure.parentSessionId)
    throw new Error('Child creation failure has no accepted parent intent.');
  const events = transaction.events.map(object);
  const failures = events.filter(
    (event) =>
      event?.type === 'subagent.child_creation_failed' ||
      event?.type === 'subagent.child_pre_dispatch_cancelled',
  );
  const releases = events.filter((event) => event?.type === 'resource_budget.released');
  const results = events.filter((event) => event?.type === 'subagent.background_result_persisted');
  const event = failures[0];
  const cancelled = event?.type === 'subagent.child_pre_dispatch_cancelled';
  const alreadyReleasedAfterParentCancel = releases.length === 0 && cancelled;
  const resultEvent = results[0];
  const resultRef = object(event?.resultRef);
  if (
    failures.length !== 1 ||
    (alreadyReleasedAfterParentCancel
      ? failure.mode !== 'created_unactivated'
      : releases.length !== 1) ||
    results.length !== 1 ||
    !event ||
    event.childThreadId !== failure.childThreadId ||
    event.parentInvocationId !== intent.parentInvocationId ||
    event.childInvocationId !== intent.childInvocationId ||
    event.mode !== failure.mode ||
    (cancelled ? event.terminalReceiptDigest : event.failureReceiptDigest) !==
      failure.failureReceiptDigest ||
    resultRef?.integrityIdentifier !== failure.failureReceiptDigest ||
    (!alreadyReleasedAfterParentCancel &&
      releases[0]?.reservationId !== intent.delegatedReservationId) ||
    !resultEvent ||
    resultEvent.taskId !== intent.childInvocationId ||
    resultEvent.artifactIntegrityIdentifier !== failure.failureReceiptDigest ||
    resultEvent.originRunId !== intent.originRunId ||
    resultEvent.originTurnId !== intent.originTurnId ||
    resultEvent.originToolCallId !== intent.originToolCallId ||
    resultEvent.attempt !== intent.attempt ||
    resultEvent.childTerminalStatus !== (cancelled ? 'cancelled' : 'failed')
  )
    throw new Error('Child creation failure does not match its result import.');
  if (alreadyReleasedAfterParentCancel) {
    const run = database
      .query<{ status: string }, [string, string]>(
        'SELECT status FROM runtime_runs WHERE session_id = ? AND run_id = ? LIMIT 1',
      )
      .get(intent.parentSessionId, intent.originRunId);
    const snapshot = database
      .query<{ state_json: string }, [string]>(
        'SELECT state_json FROM runtime_snapshots WHERE session_id = ? LIMIT 1',
      )
      .get(intent.parentSessionId);
    const state = snapshot ? object(JSON.parse(snapshot.state_json) as unknown) : null;
    const activeBudget = object(state?.resourceBudget);
    const retained = object(state?.retainedResourceBudgets);
    const funding =
      activeBudget?.runId === intent.fundingRunId
        ? activeBudget
        : object(retained?.[intent.fundingRunId]);
    const reservation = object(object(funding?.reservations)?.[intent.delegatedReservationId]);
    const completedRow = reservation
      ? null
      : database
          .query<{ reservation_json: string }, [string, string]>(
            `SELECT reservation_json FROM runtime_resource_reservation_receipts
         WHERE session_id = ? AND reservation_id = ? LIMIT 1`,
          )
          .get(intent.parentSessionId, intent.delegatedReservationId);
    const completed = completedRow ? object(JSON.parse(completedRow.reservation_json)) : null;
    const releasedReservation = reservation ?? completed;
    const released = database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM runtime_events
         WHERE session_id = ? AND json_extract(event_json, '$.type') = 'resource_budget.released'
           AND json_extract(event_json, '$.reservationId') = ?`,
      )
      .get(intent.parentSessionId, intent.delegatedReservationId);
    const aborted = database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM runtime_events
         WHERE session_id = ? AND json_extract(event_json, '$.type') = 'turn.aborted'
           AND json_extract(event_json, '$.turnId') = ?
           AND json_extract(event_json, '$.cause') = 'user'`,
      )
      .get(intent.parentSessionId, intent.originRunId);
    if (
      intent.disposition !== 'required' ||
      intent.fundingRunId !== intent.originRunId ||
      run?.status !== 'cancelled' ||
      releasedReservation?.state !== 'released' ||
      releasedReservation.reservationId !== intent.delegatedReservationId ||
      releasedReservation.runId !== intent.fundingRunId ||
      releasedReservation.invocationId !== `child-allotment:${intent.childThreadId}` ||
      releasedReservation.resourceKind !== 'subagent' ||
      childDelegatedUpperBoundDigest(releasedReservation.executableUpperBound as never) !==
        intent.delegatedUpperBoundDigest ||
      released?.count !== 1 ||
      aborted?.count !== 1 ||
      intent.childBudgetActivatedRunId ||
      intent.dispatchAckEventId
    )
      throw new Error('Released child has no exact cancelled parent and prior release proof.');
  }
  const child = database
    .query<{ session_id: string }, [string]>(
      'SELECT session_id FROM runtime_sessions WHERE session_id = ? LIMIT 1',
    )
    .get(failure.childThreadId);
  if (failure.mode === 'absent_child' && child)
    throw new Error('Absent-child failure conflicts with a created child Session.');
  if (failure.mode === 'created_unactivated') assertCreatedChildAbandonable(database, intent);
  if (failure.mode === 'activated_no_ack') assertActivatedChildAbandonable(database, intent);
  if (
    (failure.mode === 'activated_no_ack' && !intent.childBudgetActivatedRunId) ||
    (failure.mode !== 'activated_no_ack' && intent.childBudgetActivatedRunId) ||
    intent.dispatchAckEventId
  )
    throw new Error('Child creation failure conflicts with activation or dispatch ACK.');
  if (intent.failureReceiptDigest) {
    if (
      intent.failureReceiptDigest !== failure.failureReceiptDigest ||
      intent.failureMode !== failure.mode
    )
      throw new Error('Child creation failure replay digest conflicts.');
    return;
  }
  const childPredicate =
    failure.mode === 'absent_child'
      ? 'NOT EXISTS (SELECT 1 FROM runtime_sessions WHERE session_id = ?)'
      : failure.mode === 'activated_no_ack'
        ? ACTIVATED_CHILD_ABANDONABLE_PREDICATE
        : `EXISTS (SELECT 1 FROM runtime_sessions c
        JOIN runtime_sessions p ON p.session_id = c.parent_session_id
        JOIN runtime_snapshots s ON s.session_id = c.session_id
        JOIN kite_meta a ON a.key = 'session_execution/' || c.session_id
        WHERE c.session_id = ? AND c.parent_session_id = child_session_intents.parent_session_id
          AND c.revision = 0 AND s.revision = 0 AND s.event_position = 0
          AND c.workspace_id = p.workspace_id AND c.project_id = p.project_id
          AND c.workspace_digest = p.workspace_digest
          AND json_extract(a.value,'$.status') = 'idle'
          AND json_extract(a.value,'$.cleanupConfirmed') = 1
          AND json_extract(a.value,'$.hostInstanceId') IS NULL
          AND json_extract(a.value,'$.leaseUntilMs') IS NULL
          AND NOT EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id = c.session_id)
          AND NOT EXISTS (SELECT 1 FROM runtime_runs r WHERE r.session_id = c.session_id)
          AND NOT EXISTS (SELECT 1 FROM runtime_effect_leases l WHERE l.session_id = c.session_id))`;
  const result = database
    .query(`UPDATE child_session_intents
      SET failure_receipt_digest = ?, failure_mode = ?
      WHERE child_thread_id = ? AND parent_session_id = ? AND failure_receipt_digest IS NULL
        AND ${failure.mode === 'activated_no_ack' ? 'child_budget_activated_run_id IS NOT NULL' : 'child_budget_activated_run_id IS NULL'}
        AND dispatch_ack_event_id IS NULL
        AND ${childPredicate}`)
    .run(
      failure.failureReceiptDigest,
      failure.mode,
      failure.childThreadId,
      failure.parentSessionId,
      failure.childThreadId,
    );
  if (result.changes !== 1) throw new Error('Child creation failure lost its Store CAS.');
}

/** The activation transaction is exactly five events and one queued Run. Any later fact fails closed. */
const ACTIVATED_CHILD_ABANDONABLE_PREDICATE = `EXISTS (SELECT 1 FROM runtime_sessions c
  JOIN runtime_sessions p ON p.session_id = c.parent_session_id
  JOIN runtime_snapshots s ON s.session_id = c.session_id
  JOIN kite_meta a ON a.key = 'session_execution/' || c.session_id
  JOIN runtime_runs r ON r.session_id = c.session_id
    AND r.run_id = child_session_intents.child_budget_activated_run_id
  WHERE c.session_id = ? AND c.parent_session_id = child_session_intents.parent_session_id
    AND c.workspace_id = p.workspace_id AND c.project_id = p.project_id
    AND c.workspace_digest = p.workspace_digest
    AND c.revision = 5 AND s.revision = 5 AND s.event_position = 5
    AND child_session_intents.child_budget_activated_revision = 3
    AND r.status = 'queued' AND r.phase = 'building'
    AND r.created_revision = 5 AND r.last_revision = 5
    AND r.started_at_ms IS NULL AND r.finished_at_ms IS NULL AND r.terminal_json IS NULL
    AND json_extract(a.value,'$.status') = 'idle'
    AND json_extract(a.value,'$.cleanupConfirmed') = 1
    AND json_extract(a.value,'$.hostInstanceId') IS NULL
    AND json_extract(a.value,'$.leaseUntilMs') IS NULL
    AND (SELECT count(*) FROM runtime_runs x WHERE x.session_id = c.session_id) = 1
    AND (SELECT count(*) FROM runtime_events e WHERE e.session_id = c.session_id) = 5
    AND EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id = c.session_id
      AND e.sequence = 1 AND json_extract(e.event_json,'$.type') = 'subagent.child_session_adopted'
      AND json_extract(e.event_json,'$.parentSessionId') = child_session_intents.parent_session_id
      AND json_extract(e.event_json,'$.parentInvocationId') = child_session_intents.parent_invocation_id
      AND json_extract(e.event_json,'$.parentToolCallId') = child_session_intents.origin_tool_call_id
      AND json_extract(e.event_json,'$.attempt') = child_session_intents.attempt
      AND json_extract(e.event_json,'$.childInvocationId') = child_session_intents.child_invocation_id
      AND json_extract(e.event_json,'$.grantDigest') = child_session_intents.grant_digest
      AND json_extract(e.event_json,'$.fundingRunId') = child_session_intents.funding_run_id
      AND json_extract(e.event_json,'$.delegatedReservationId') = child_session_intents.delegated_reservation_id
      AND json_extract(e.event_json,'$.delegatedUpperBoundDigest') = child_session_intents.delegated_upper_bound_digest
      AND json_extract(e.event_json,'$.deadlineAt') = child_session_intents.deadline_at)
    AND EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id = c.session_id
      AND e.sequence = 2 AND json_extract(e.event_json,'$.type') = 'subagent.child_task_input_admitted'
      AND json_extract(e.event_json,'$.childInvocationId') = child_session_intents.child_invocation_id
      AND json_extract(e.event_json,'$.taskDigest') = child_session_intents.task_artifact_digest
      AND json_extract(e.event_json,'$.taskTextDigest') = child_session_intents.task_text_digest
      AND json_extract(e.event_json,'$.grantDigest') = child_session_intents.grant_digest
      AND json_extract(e.event_json,'$.taskArtifactRef.artifactId') = child_session_intents.task_artifact_id
      AND json_extract(e.event_json,'$.taskArtifactRef.integrityIdentifier') = child_session_intents.task_artifact_digest)
    AND EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id = c.session_id
      AND e.sequence = 3 AND e.event_id = child_session_intents.child_budget_activated_event_id
      AND json_extract(e.event_json,'$.type') = 'resource_budget.configured'
      AND json_extract(e.event_json,'$.runId') = child_session_intents.child_budget_activated_run_id)
    AND EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id = c.session_id
      AND e.sequence = 4 AND json_extract(e.event_json,'$.type') = 'turn.started'
      AND json_extract(e.event_json,'$.turnId') = child_session_intents.child_budget_activated_run_id)
    AND EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id = c.session_id
      AND e.sequence = 5 AND json_extract(e.event_json,'$.type') = 'task.started'
      AND json_extract(e.event_json,'$.taskId') = child_session_intents.child_invocation_id
      AND json_extract(e.event_json,'$.turnId') = child_session_intents.child_budget_activated_run_id
      AND json_extract(e.event_json,'$.userGoal') = '${CHILD_SESSION_TASK_USER_GOAL}')
    AND NOT EXISTS (SELECT 1 FROM runtime_effect_leases l WHERE l.session_id = c.session_id))`;

function assertActivatedChildAbandonable(
  database: Database,
  intent: KiteChildSessionIntentRecord,
): void {
  const found = database
    .query<{ child_thread_id: string }, [string, string]>(
      `SELECT child_thread_id FROM child_session_intents
       WHERE child_thread_id = ? AND ${ACTIVATED_CHILD_ABANDONABLE_PREDICATE}`,
    )
    .get(intent.childThreadId, intent.childThreadId);
  if (!found) throw new Error('Activated child Session is not safely released before dispatch.');
}

function assertCreatedChildAbandonable(
  database: Database,
  intent: KiteChildSessionIntentRecord,
): void {
  const child = database
    .query<
      {
        parent_session_id: string | null;
        workspace_id: string;
        project_id: string;
        workspace_digest: string;
        revision: number;
      },
      [string]
    >(
      'SELECT parent_session_id,workspace_id,project_id,workspace_digest,revision FROM runtime_sessions WHERE session_id=? LIMIT 1',
    )
    .get(intent.childThreadId);
  const parent = database
    .query<
      {
        workspace_id: string;
        project_id: string;
        workspace_digest: string;
      },
      [string]
    >(
      'SELECT workspace_id,project_id,workspace_digest FROM runtime_sessions WHERE session_id=? LIMIT 1',
    )
    .get(intent.parentSessionId);
  const snapshot = database
    .query<{ revision: number; event_position: number }, [string]>(
      'SELECT revision,event_position FROM runtime_snapshots WHERE session_id=? LIMIT 1',
    )
    .get(intent.childThreadId);
  const authorityJson = database
    .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=? LIMIT 1')
    .get(`session_execution/${intent.childThreadId}`)?.value;
  let authority: Record<string, unknown> | null = null;
  try {
    authority = object(authorityJson ? JSON.parse(authorityJson) : null);
  } catch {
    /* malformed is unsafe */
  }
  const facts = database
    .query<
      {
        events: number;
        runs: number;
        effects: number;
      },
      [string, string, string]
    >(`SELECT
    (SELECT count(*) FROM runtime_events WHERE session_id=?) AS events,
    (SELECT count(*) FROM runtime_runs WHERE session_id=?) AS runs,
    (SELECT count(*) FROM runtime_effect_leases WHERE session_id=?) AS effects`)
    .get(intent.childThreadId, intent.childThreadId, intent.childThreadId);
  if (
    !child ||
    !parent ||
    child.parent_session_id !== intent.parentSessionId ||
    child.workspace_id !== parent.workspace_id ||
    child.project_id !== parent.project_id ||
    child.workspace_digest !== parent.workspace_digest ||
    child.revision !== 0 ||
    snapshot?.revision !== 0 ||
    snapshot.event_position !== 0 ||
    facts?.events !== 0 ||
    facts.runs !== 0 ||
    facts.effects !== 0 ||
    authority?.schema !== 'kite.session-execution-authority.v1' ||
    authority.sessionId !== intent.childThreadId ||
    authority.status !== 'idle' ||
    authority.cleanupConfirmed !== true ||
    authority.hostInstanceId !== null ||
    authority.leaseUntilMs !== null ||
    !Number.isSafeInteger(authority.controllerGeneration) ||
    (authority.controllerGeneration as number) < 2
  )
    throw new Error('Created child has not been safely released before abandonment.');
}

export function recordChildDispatchAckInTransaction<Event, State>(
  database: Database,
  channel: string,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  const ack = transaction.childDispatchAck;
  if (!ack) return;
  const row = readChildSessionIntent(database, ack.childThreadId);
  if (
    channel !== 'receipt_evidence' ||
    transaction.sessionId !== ack.parentSessionId ||
    !row ||
    row.parentSessionId !== ack.parentSessionId ||
    row.originRunId !== ack.originRunId ||
    row.originToolCallId !== ack.originToolCallId ||
    row.delegatedReservationId !== ack.delegatedReservationId ||
    row.failureReceiptDigest ||
    row.parentClaimSettledEventId
  )
    throw new Error('Child dispatch ACK has no live parent claim.');
  const parentRun = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=? LIMIT 1',
    )
    .get(ack.parentSessionId, ack.originRunId);
  const liveRequiredRun = parentRun?.status === 'running' || parentRun?.status === 'waiting';
  if (
    row.disposition === 'required'
      ? !liveRequiredRun
      : !liveRequiredRun && parentRun?.status !== 'completed'
  )
    throw new Error('Child dispatch ACK has no eligible parent Run.');
  const started = transaction.events
    .map(object)
    .flatMap((event, index) =>
      event?.type === 'resource_budget.dispatch_started' ? [{ event, index }] : [],
    );
  const evidence = started[0];
  const metadata = evidence ? transaction.metadata?.[evidence.index] : undefined;
  const snapshot = object(transaction.snapshot);
  const active = object(snapshot?.resourceBudget);
  const retained = object(snapshot?.retainedResourceBudgets);
  const ledger =
    active?.runId === row.fundingRunId ? active : object(retained?.[row.fundingRunId as string]);
  const reservations = object(ledger?.reservations);
  const reservation = object(reservations?.[ack.delegatedReservationId]);
  const reportReservations = Object.values(reservations ?? {}).filter(
    (candidate) =>
      object(candidate)?.invocationId === `model-invocation:after-turn:${row.childInvocationId}`,
  );
  const report = object(reportReservations[0]);
  if (
    started.length !== 1 ||
    evidence?.event.reservationId !== ack.delegatedReservationId ||
    !metadata?.eventId ||
    !Number.isSafeInteger(metadata.revision) ||
    metadata.revision < 1 ||
    reservation?.state !== 'dispatch_started' ||
    reservation.runId !== row.fundingRunId ||
    (row.disposition === 'after_turn' &&
      (ledger?.status !== 'active' ||
        ledger.deadlineAt !== row.deadlineAt ||
        reportReservations.length !== 1 ||
        report?.resourceKind !== 'model' ||
        report.state !== 'reserved' ||
        report.runId !== row.fundingRunId ||
        !Number.isFinite(Date.parse(row.deadlineAt)) ||
        Date.parse(row.deadlineAt) <= Date.now()))
  )
    throw new Error('Child dispatch ACK lacks exact delegated reservation evidence.');
  if (row.dispatchAckEventId) {
    if (
      row.dispatchAckEventId !== metadata.eventId ||
      row.dispatchAckRevision !== metadata.revision
    )
      throw new Error('Child dispatch ACK replay conflicts.');
    return;
  }
  const result = database
    .query(`UPDATE child_session_intents
    SET dispatch_ack_event_id=?,dispatch_ack_revision=?
    WHERE child_thread_id=? AND dispatch_ack_event_id IS NULL
      AND failure_receipt_digest IS NULL AND parent_claim_settled_event_id IS NULL`)
    .run(metadata.eventId, metadata.revision, ack.childThreadId);
  if (result.changes !== 1) throw new Error('Child dispatch ACK lost its Store CAS.');
}

/** One bounded parent-visible diagnostic, without settling the child or its funding. */
export function assertChildRecoveryDiagnosticInTransaction<Event, State>(
  database: Database,
  channel: string,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  const diagnostics = transaction.events
    .map(object)
    .filter((event) => event?.type === 'subagent.child_recovery_required');
  if (diagnostics.length === 0) return;
  if (channel !== 'receipt_evidence' || diagnostics.length !== 1 || transaction.events.length !== 1)
    throw new Error('Child recovery diagnostic has an invalid receipt boundary.');
  const diagnostic = diagnostics[0]!;
  const childThreadId = diagnostic.childThreadId;
  if (typeof childThreadId !== 'string') throw new Error('Child recovery identity is invalid.');
  const row = readChildSessionIntent(database, childThreadId);
  const snapshot = object(transaction.snapshot);
  const invocation = object(
    object(object(snapshot?.capabilities)?.invocations)?.[String(diagnostic.parentInvocationId)],
  );
  const lifecycle = object(invocation?.subagentProviderLifecycle);
  const link = object(lifecycle?.childSession);
  const projected = object(link?.recoveryDiagnostic);
  if (
    !row ||
    row.parentSessionId !== transaction.sessionId ||
    row.parentSessionId !== diagnostic.parentSessionId ||
    row.parentInvocationId !== diagnostic.parentInvocationId ||
    row.childInvocationId !== diagnostic.childInvocationId ||
    row.originToolCallId !== diagnostic.originToolCallId ||
    row.attempt !== diagnostic.attempt ||
    row.grantDigest !== diagnostic.grantDigest ||
    row.failureReceiptDigest !== null ||
    row.parentClaimSettledEventId !== null ||
    link?.childThreadId !== childThreadId ||
    link.terminalImport !== undefined ||
    lifecycle?.backgroundResult !== undefined ||
    projected?.diagnosticCode !== diagnostic.diagnosticCode ||
    projected?.observedAt !== diagnostic.observedAt
  )
    throw new Error('Child recovery diagnostic does not match a pending exact intent.');
  if (row.childSessionCreated) {
    const terminal = database
      .query<{ found: number }, [string]>(
        `SELECT EXISTS(SELECT 1 FROM runtime_events WHERE session_id=?
         AND json_extract(event_json,'$.type')='subagent.child_terminal_sealed') AS found`,
      )
      .get(childThreadId)?.found;
    if (terminal === 1)
      throw new Error('Child recovery diagnostic cannot replace a sealed child terminal.');
    const owner = database
      .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=? LIMIT 1')
      .get(`session_execution/${childThreadId}`);
    const authority = object(owner ? JSON.parse(owner.value) : null);
    if (authority?.status !== 'idle' && authority?.status !== 'recovery_required')
      throw new Error('Child recovery diagnostic cannot fence a live child owner.');
  }
}

export function recordChildParentSettlementInTransaction<Event, State>(
  database: Database,
  channel: string,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  const imported = transaction.events
    .map(object)
    .flatMap((event, index) =>
      event?.type === 'subagent.child_terminal_imported' ? [{ event, index }] : [],
    );
  if (imported.length === 0) return;
  if (channel !== 'receipt_evidence' || imported.length !== 1)
    throw new Error('Child parent settlement has an invalid receipt boundary.');
  const item = imported[0]!;
  const childThreadId = item.event.childThreadId;
  if (typeof childThreadId !== 'string') throw new Error('Child settlement identity is invalid.');
  const row = readChildSessionIntent(database, childThreadId);
  const metadata = transaction.metadata?.[item.index];
  if (
    !row ||
    row.parentSessionId !== transaction.sessionId ||
    row.parentInvocationId !== item.event.parentInvocationId ||
    row.childInvocationId !== item.event.childInvocationId ||
    !metadata?.eventId ||
    !Number.isSafeInteger(metadata.revision) ||
    metadata.revision < 1
  )
    throw new Error('Child parent settlement does not match its accepted intent.');
  const resultEvents = transaction.events.filter(
    (event) => object(event)?.type === 'subagent.background_result_persisted',
  );
  if (
    resultEvents.length !== 1 ||
    object(resultEvents[0])?.childTerminalStatus !== item.event.status
  )
    throw new Error('Child parent result status does not match its terminal import.');
  if (item.event.status === 'unknown') {
    const authority = database
      .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=? LIMIT 1')
      .get(`session_execution/${childThreadId}`);
    const fenced = object(authority ? JSON.parse(authority.value) : null);
    const childRun = database
      .query<{ status: string }, [string, string]>(
        'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=? LIMIT 1',
      )
      .get(childThreadId, row.childBudgetActivatedRunId ?? '');
    const sealed = database
      .query<{ event_json: string }, [string]>(
        `SELECT event_json FROM runtime_events WHERE session_id=?
         AND json_extract(event_json,'$.type')='subagent.child_terminal_sealed'
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(childThreadId);
    const seal = object(sealed ? JSON.parse(sealed.event_json) : null);
    const parentState = object(transaction.snapshot);
    const activeBudget = object(parentState?.resourceBudget);
    const fundingBudget =
      activeBudget?.runId === row.fundingRunId
        ? activeBudget
        : object(object(parentState?.retainedResourceBudgets)?.[row.fundingRunId]);
    const delegatedReservation = object(
      object(fundingBudget?.reservations)?.[row.delegatedReservationId],
    );
    const allBudgetUnknownEvents = transaction.events.filter(
      (event) => object(event)?.type === 'resource_budget.unknown',
    );
    const budgetUnknownEvents = transaction.events.filter(
      (event) =>
        object(event)?.type === 'resource_budget.unknown' &&
        object(event)?.reservationId === row.delegatedReservationId,
    );
    const earlierBudgetUnknown =
      database
        .query<{ found: number }, [string, string]>(
          `SELECT EXISTS(SELECT 1 FROM runtime_events WHERE session_id=?
         AND json_extract(event_json,'$.type')='resource_budget.unknown'
         AND json_extract(event_json,'$.reservationId')=?) AS found`,
        )
        .get(transaction.sessionId, row.delegatedReservationId)?.found === 1;
    if (
      !row.dispatchAckEventId ||
      childRun?.status !== 'unknown' ||
      fenced?.status !== 'recovery_required' ||
      fenced.cleanupConfirmed !== false ||
      fenced.hostInstanceId !== null ||
      fenced.leaseUntilMs !== null ||
      seal?.status !== 'unknown' ||
      seal.cleanupConfirmed !== false ||
      object(seal.resultRef)?.integrityIdentifier !==
        object(item.event.resultRef)?.integrityIdentifier ||
      allBudgetUnknownEvents.length !== budgetUnknownEvents.length ||
      (budgetUnknownEvents.length !== 1 &&
        !(
          budgetUnknownEvents.length === 0 &&
          earlierBudgetUnknown &&
          delegatedReservation?.state === 'unknown'
        )) ||
      resultEvents.length !== 1
    )
      throw new Error('Unknown child settlement lacks fenced terminal evidence.');
  }
  if (row.parentClaimSettledEventId) {
    if (
      row.parentClaimSettledEventId !== metadata.eventId ||
      row.parentClaimSettledRevision !== metadata.revision
    )
      throw new Error('Child parent settlement replay conflicts.');
    return;
  }
  const result = database
    .query(`UPDATE child_session_intents
    SET parent_claim_settled_event_id=?,parent_claim_settled_revision=?
    WHERE child_thread_id=? AND parent_claim_settled_event_id IS NULL`)
    .run(metadata.eventId, metadata.revision, childThreadId);
  if (result.changes !== 1) throw new Error('Child parent settlement lost its Store CAS.');
}

/** An unclean unknown seal is accepted only in a fenced recovery generation. */
export function assertChildUnknownTerminalSealInTransaction<Event, State>(
  database: Database,
  channel: string,
  transaction: RuntimeTransactionInput<Event, State>,
  recoveryOnly: boolean,
): void {
  const seals = transaction.events.filter(
    (event) => object(event)?.type === 'subagent.child_terminal_sealed',
  );
  if (seals.length === 0) return;
  if (seals.length !== 1) throw new Error('Child terminal seal batch is ambiguous.');
  const seal = object(seals[0]);
  if (seal?.status !== 'unknown') return;
  const row = readChildSessionIntent(database, transaction.sessionId);
  const state = object(transaction.snapshot);
  const origin = object(state?.childSessionOrigin);
  const terminal = object(origin?.terminal);
  const outcome = object(state?.terminalOutcome);
  const run = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=? LIMIT 1',
    )
    .get(transaction.sessionId, row?.childBudgetActivatedRunId ?? '');
  const attempt = database
    .query<{ found: number }, [string]>(
      `SELECT EXISTS(SELECT 1 FROM runtime_events WHERE session_id=? AND
        json_extract(event_json,'$.type') IN
          ('model.invocation_attempt_started','tool.started')) AS found`,
    )
    .get(transaction.sessionId);
  if (
    !recoveryOnly ||
    (channel !== 'terminal_recovery' && channel !== 'receipt_evidence') ||
    !row?.dispatchAckEventId ||
    !row.childBudgetActivatedRunId ||
    run?.status !== 'unknown' ||
    attempt?.found !== 1 ||
    seal.cleanupConfirmed !== false ||
    terminal?.status !== 'unknown' ||
    terminal.cleanupConfirmed !== false ||
    object(terminal.resultRef)?.integrityIdentifier !==
      object(seal.resultRef)?.integrityIdentifier ||
    origin?.parentSessionId !== row.parentSessionId ||
    origin.childInvocationId !== row.childInvocationId ||
    origin.fundingRunId !== row.fundingRunId ||
    origin.delegatedReservationId !== row.delegatedReservationId ||
    outcome?.status !== 'unknown' ||
    outcome.knownExternalEffects !== 'unknown'
  )
    throw new Error('Unknown child seal lacks fenced Run and external-attempt evidence.');
}

export function assertChildRuntimeActivationInTransaction<Event, State>(
  database: Database,
  channel: string,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  if (channel === 'session_create') return;
  const lineage = database
    .query<{ parent_session_id: string | null }, [string]>(
      'SELECT parent_session_id FROM runtime_sessions WHERE session_id = ? LIMIT 1',
    )
    .get(transaction.sessionId);
  const activation = transaction.childBudgetActivation;
  if (!lineage?.parent_session_id) {
    if (activation) throw new Error('Root Session cannot activate a child delegation.');
    return;
  }
  const row = readChildSessionIntent(database, transaction.sessionId);
  if (!row || row.parentSessionId !== lineage.parent_session_id || row.failureReceiptDigest)
    throw new Error('Child Session has no live parent delegation.');
  const startsExternalWork = transaction.events
    .map(object)
    .some(
      (event) =>
        event?.type === 'model.invocation_prepared' ||
        event?.type === 'model.invocation_attempt_started' ||
        event?.type === 'tool.started' ||
        event?.type === 'capability.subagent_dispatch_intent_recorded',
    );
  if (startsExternalWork) {
    if (object(object(transaction.snapshot)?.childSessionOrigin)?.terminal) {
      if (!verifyCompletedChildFollowupModelWork(database, transaction))
        throw new Error('Sealed child Session cannot start external work.');
    } else {
      const parentRun = database
        .query<{ status: string }, [string, string]>(
          'SELECT status FROM runtime_runs WHERE session_id = ? AND run_id = ? LIMIT 1',
        )
        .get(row.parentSessionId as string, row.originRunId as string);
      if (
        !row.childBudgetActivatedRunId ||
        !row.dispatchAckEventId ||
        row.parentClaimSettledEventId ||
        (parentRun?.status !== 'running' &&
          parentRun?.status !== 'waiting' &&
          !(
            row.disposition === 'after_turn' &&
            parentRun?.status === 'completed' &&
            Date.parse(row.deadlineAt) > Date.now()
          ))
      )
        throw new Error('Child external work has no live parent dispatch ACK.');
    }
  }
  if (!activation) {
    if (
      !row.childBudgetActivatedRunId &&
      (transaction.events.length > 0 || transaction.runMutation)
    )
      throw new Error('Child Session cannot execute before delegated budget activation.');
    return;
  }
  if (row.parentClaimSettledEventId)
    throw new Error('Child budget activation follows a settled parent claim.');
  const parentRun = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id = ? AND run_id = ? LIMIT 1',
    )
    .get(row.parentSessionId as string, row.originRunId as string);
  if (parentRun?.status !== 'running' && parentRun?.status !== 'waiting')
    throw new Error('Child budget activation has no live parent Run.');
  if (
    channel !== 'decision' ||
    activation.childThreadId !== transaction.sessionId ||
    activation.parentSessionId !== row.parentSessionId ||
    activation.parentInvocationId !== row.parentInvocationId ||
    activation.childInvocationId !== row.childInvocationId ||
    activation.grantDigest !== row.grantDigest ||
    activation.fundingRunId !== row.fundingRunId ||
    activation.delegatedReservationId !== row.delegatedReservationId ||
    activation.delegatedUpperBoundDigest !== row.delegatedUpperBoundDigest ||
    activation.childMayWrite !== (row.role === 'code') ||
    activation.childMaySpawn !== false ||
    transaction.runMutation?.type !== 'insert' ||
    transaction.runMutation.run.runId !== activation.childRunId ||
    transaction.runMutation.run.sessionId !== transaction.sessionId ||
    transaction.runMutation.run.originSessionId !== row.parentSessionId ||
    transaction.runMutation.run.originRunId !== row.originRunId
  )
    throw new Error('Child budget activation identity or Run insert is invalid.');
  const typed = transaction.events.map(object);
  const indexed = (type: string) =>
    typed.flatMap((event, index) => (event?.type === type ? [{ event, index }] : []));
  const adopted = indexed('subagent.child_session_adopted');
  const configured = indexed('resource_budget.configured');
  const started = indexed('turn.started');
  const taskStarted = indexed('task.started');
  const taskInputs = indexed('subagent.child_task_input_admitted');
  const adoption = adopted[0]?.event;
  const configuration = configured[0]?.event;
  const taskInput = taskInputs[0]?.event;
  const metadata = configured[0] ? transaction.metadata?.[configured[0].index] : undefined;
  if (
    adopted.length !== 1 ||
    configured.length !== 1 ||
    started.length !== 1 ||
    taskStarted.length !== 1 ||
    taskInputs.length !== 1 ||
    typed.length !== 5 ||
    typed[0]?.type !== 'subagent.child_session_adopted' ||
    typed[1]?.type !== 'subagent.child_task_input_admitted' ||
    typed[2]?.type !== 'resource_budget.configured' ||
    typed[3]?.type !== 'turn.started' ||
    typed[4]?.type !== 'task.started' ||
    started[0]?.event.turnId !== activation.childRunId ||
    taskStarted[0]?.event.taskId !== row.childInvocationId ||
    taskStarted[0]?.event.turnId !== activation.childRunId ||
    taskStarted[0]?.event.userGoal !== CHILD_SESSION_TASK_USER_GOAL ||
    !taskInput ||
    !adoption ||
    !configuration ||
    activation.taskArtifactDigest !== row.taskArtifactDigest ||
    activation.taskTextDigest !== row.taskTextDigest ||
    object(activation.taskArtifactRef)?.artifactId !== row.taskArtifactId ||
    object(activation.taskArtifactRef)?.integrityIdentifier !== row.taskArtifactDigest ||
    object(activation.taskArtifactRef)?.byteLength !== row.taskArtifactByteLength ||
    object(activation.taskArtifactRef)?.kind !== 'subagent_task' ||
    taskInput.childInvocationId !== row.childInvocationId ||
    taskInput.taskDigest !== row.taskArtifactDigest ||
    taskInput.taskTextDigest !== row.taskTextDigest ||
    taskInput.grantDigest !== row.grantDigest ||
    !sameTaskRef(taskInput.taskArtifactRef, activation.taskArtifactRef) ||
    adoption.parentSessionId !== row.parentSessionId ||
    adoption.parentInvocationId !== row.parentInvocationId ||
    adoption.parentToolCallId !== row.originToolCallId ||
    adoption.attempt !== row.attempt ||
    adoption.childInvocationId !== row.childInvocationId ||
    adoption.grantDigest !== row.grantDigest ||
    adoption.fundingRunId !== row.fundingRunId ||
    adoption.delegatedReservationId !== row.delegatedReservationId ||
    adoption.delegatedUpperBoundDigest !== row.delegatedUpperBoundDigest ||
    adoption.deadlineAt !== row.deadlineAt ||
    configuration.runId !== activation.childRunId ||
    !metadata?.eventId ||
    !Number.isSafeInteger(metadata.revision) ||
    metadata.revision < 1
  )
    throw new Error('Child budget activation lacks exact adopted/configured/turn events.');
  const snapshot = object(transaction.snapshot);
  const origin = object(snapshot?.childSessionOrigin);
  const resource = object(snapshot?.resourceBudget);
  const activeTask = object(object(snapshot?.tasks)?.[row.childInvocationId]);
  const budget = object(configuration.budget);
  const upper = object(JSON.parse(row.delegatedUpperBoundJson as string));
  if (
    !origin ||
    !resource ||
    !budget ||
    !upper ||
    origin.parentSessionId !== row.parentSessionId ||
    origin.parentInvocationId !== row.parentInvocationId ||
    origin.childInvocationId !== row.childInvocationId ||
    origin.grantDigest !== row.grantDigest ||
    origin.role !== row.role ||
    origin.delegatedReservationId !== row.delegatedReservationId ||
    origin.taskArtifactDigest !== row.taskArtifactDigest ||
    origin.taskTextDigest !== row.taskTextDigest ||
    origin.taskInputAdmitted !== true ||
    snapshot?.activeTaskId !== row.childInvocationId ||
    activeTask?.taskId !== row.childInvocationId ||
    activeTask.userGoal !== CHILD_SESSION_TASK_USER_GOAL ||
    activeTask.startedAtTurnId !== activation.childRunId ||
    activeTask.status !== 'active' ||
    !sameTaskRef(origin.taskArtifactRef, activation.taskArtifactRef) ||
    resource.status !== 'active' ||
    resource.runId !== activation.childRunId ||
    resource.deadlineAt !== configuration.deadlineAt ||
    JSON.stringify(resource.budget) !== JSON.stringify(budget) ||
    childDelegatedUpperBoundDigest(upper as never) !== row.delegatedUpperBoundDigest
  )
    throw new Error('Child budget activation State or ceiling conflicts.');
  const budgetFields = [
    'maxRunDurationMs',
    'maxTurns',
    'maxModelRequests',
    'maxToolInvocations',
    'maxRunInputTokens',
    'maxRunOutputTokens',
    'maxConcurrentSubagents',
    'maxConcurrentWriters',
    'maxConcurrentToolInvocations',
    'maxConcurrentShellInvocations',
    'maxConcurrencyWaitMs',
    'maxArtifactBytes',
  ];
  if (
    budgetFields.some(
      (field) => !Number.isSafeInteger(budget[field]) || (budget[field] as number) < 0,
    )
  )
    throw new Error('Child budget contains a non-finite limit.');
  assertChildBudgetWithinDelegation({
    reservation: {
      version: 1,
      reservationId: row.delegatedReservationId,
      runId: row.fundingRunId,
      invocationId: `child-allotment:${transaction.sessionId}`,
      resourceKind: 'subagent',
      executableUpperBound: upper,
      state: 'reserved',
    } as never,
    childBudget: budget as never,
    childStartedAt: configuration.startedAt as string,
    childDeadlineAt: configuration.deadlineAt as string,
    fundingDeadlineAt: row.deadlineAt as string,
    childMaySpawn: activation.childMaySpawn,
    childMayWrite: activation.childMayWrite,
  });
  if (row.childBudgetActivatedRunId) {
    if (
      row.childBudgetActivatedRunId !== activation.childRunId ||
      row.childBudgetActivatedEventId !== metadata.eventId ||
      row.childBudgetActivatedRevision !== metadata.revision
    )
      throw new Error('Child budget activation replay conflicts.');
    return;
  }
  const updated = database
    .query(`UPDATE child_session_intents
    SET child_budget_activated_run_id=?,child_budget_activated_event_id=?,child_budget_activated_revision=?
    WHERE child_thread_id=? AND child_budget_activated_run_id IS NULL AND failure_receipt_digest IS NULL`)
    .run(activation.childRunId, metadata.eventId, metadata.revision, transaction.sessionId);
  if (updated.changes !== 1) throw new Error('Child budget activation lost its Store CAS.');
}

export function readChildSessionIntent(
  database: Database,
  childThreadId: string,
): KiteChildSessionIntentRecord | null {
  const row = database
    .query<Record<string, string | number | null>, [string]>(
      'SELECT * FROM child_session_intents WHERE child_thread_id = ? LIMIT 1',
    )
    .get(childThreadId);
  if (!row) return null;
  const childSessionCreated =
    database
      .query<{ session_id: string }, [string]>(
        'SELECT session_id FROM runtime_sessions WHERE session_id = ? LIMIT 1',
      )
      .get(childThreadId) !== null;
  return {
    childThreadId: row.child_thread_id as string,
    parentSessionId: row.parent_session_id as string,
    parentInvocationId: row.parent_invocation_id as string,
    originRunId: row.origin_run_id as string,
    originTurnId: row.origin_turn_id as string,
    originToolCallId: row.origin_tool_call_id as string,
    attempt: row.attempt as number,
    childInvocationId: row.child_invocation_id as string,
    grantDigest: row.grant_digest as string,
    sealedGrantByteLength: row.sealed_grant_byte_length as number,
    sealedGrantDigest: row.sealed_grant_digest as `sha256:${string}`,
    taskArtifactDigest: row.task_artifact_digest as string,
    taskTextDigest: row.task_text_digest as string,
    taskArtifactRef: {
      artifactId: row.task_artifact_id as string,
      kind: 'subagent_task',
      integrityIdentifier: row.task_artifact_digest as string,
      byteLength: row.task_artifact_byte_length as number,
    },
    taskArtifactId: row.task_artifact_id as string,
    taskArtifactByteLength: row.task_artifact_byte_length as number,
    disposition: row.disposition as KiteChildSessionIntentRecord['disposition'],
    role: row.role as KiteChildSessionIntentRecord['role'],
    toolEventId: row.tool_event_id as string,
    toolEventRevision: row.tool_event_revision as number,
    fundingRunId: row.funding_run_id as string,
    delegatedReservationId: row.delegated_reservation_id as string,
    delegatedUpperBoundDigest: row.delegated_upper_bound_digest as string,
    delegatedUpperBoundJson: row.delegated_upper_bound_json as string,
    deadlineAt: row.deadline_at as string,
    childSessionCreated,
    failureReceiptDigest: row.failure_receipt_digest as string | null,
    failureMode: row.failure_mode as KiteChildSessionIntentRecord['failureMode'],
    childBudgetActivatedRunId: row.child_budget_activated_run_id as string | null,
    childBudgetActivatedEventId: row.child_budget_activated_event_id as string | null,
    childBudgetActivatedRevision: row.child_budget_activated_revision as number | null,
    dispatchAckEventId: row.dispatch_ack_event_id as string | null,
    dispatchAckRevision: row.dispatch_ack_revision as number | null,
    parentClaimSettledEventId: row.parent_claim_settled_event_id as string | null,
    parentClaimSettledRevision: row.parent_claim_settled_revision as number | null,
  };
}

/** Private bytes; caller must first prove exact parent execution or recovery scope. */
export function readChildSealedGrant(
  database: Database,
  parentSessionId: string,
  childThreadId: string,
): {
  readonly sealedGrantJson: string;
  readonly sealedGrantByteLength: number;
  readonly sealedGrantDigest: `sha256:${string}`;
} | null {
  const row = database
    .query<
      {
        sealed_grant_json: string;
        sealed_grant_byte_length: number;
        sealed_grant_digest: string;
      },
      [string, string]
    >(`SELECT sealed_grant_json,sealed_grant_byte_length,sealed_grant_digest
    FROM child_session_intents WHERE parent_session_id=? AND child_thread_id=? LIMIT 1`)
    .get(parentSessionId, childThreadId);
  if (!row) return null;
  const parsed = JSON.parse(row.sealed_grant_json) as unknown;
  const sealed = sealChildGrantPayload(parsed);
  if (
    sealed.sealedGrantJson !== row.sealed_grant_json ||
    sealed.sealedGrantByteLength !== row.sealed_grant_byte_length ||
    sealed.sealedGrantDigest !== row.sealed_grant_digest
  )
    throw new Error('Durable child sealed grant failed byte integrity validation.');
  return sealed;
}

export function listPendingChildSessionIntents(
  database: Database,
  parentSessionId: string,
  limit: number,
  cursor?: string,
): { readonly entries: readonly KiteChildSessionIntentRecord[]; readonly nextCursor?: string } {
  if (!parentSessionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new Error('Child Session intent query bound is invalid.');
  const ids = database
    .query<{ child_thread_id: string }, [string, string, number]>(
      `SELECT child_thread_id FROM child_session_intents
      WHERE parent_session_id = ? AND child_thread_id > ?
        AND failure_receipt_digest IS NULL AND parent_claim_settled_event_id IS NULL
      ORDER BY child_thread_id ASC LIMIT ?`,
    )
    .all(parentSessionId, cursor ?? '', limit + 1);
  const entries = ids
    .slice(0, limit)
    .map((id) => readChildSessionIntent(database, id.child_thread_id)!);
  return ids.length > limit ? { entries, nextCursor: entries.at(-1)!.childThreadId } : { entries };
}

/** Return only a committed terminal seal for an ACKed, unsettled after_turn intent. */
export function readPendingAfterTurnChildTerminalSeal(
  database: Database,
  parentSessionId: string,
  childThreadId: string,
): KitePendingChildTerminalSeal | null {
  const intent = readChildSessionIntent(database, childThreadId);
  if (
    !intent ||
    intent.parentSessionId !== parentSessionId ||
    intent.disposition !== 'after_turn' ||
    !intent.dispatchAckEventId ||
    !intent.childBudgetActivatedRunId ||
    intent.failureReceiptDigest ||
    intent.parentClaimSettledEventId
  )
    return null;
  const seals = database
    .query<{ event_id: string; sequence: number; event_json: string }, [string]>(
      `SELECT event_id,sequence,event_json FROM runtime_events WHERE session_id=?
     AND json_extract(event_json,'$.type')='subagent.child_terminal_sealed'
     ORDER BY sequence ASC LIMIT 2`,
    )
    .all(childThreadId);
  if (seals.length === 0) return null;
  if (seals.length !== 1) throw new Error('Pending child has ambiguous terminal seals.');
  const seal = object(JSON.parse(seals[0]!.event_json));
  const status = seal?.status;
  const snapshot = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=? LIMIT 1',
    )
    .get(childThreadId);
  const state = object(snapshot ? JSON.parse(snapshot.state_json) : null);
  const origin = object(state?.childSessionOrigin);
  const terminal = object(origin?.terminal);
  const outcome = object(state?.terminalOutcome);
  const resultRef = object(seal?.resultRef);
  const storedRef = object(terminal?.resultRef);
  if (
    !seal ||
    ![
      'completed',
      'failed',
      'cancelled',
      'interrupted',
      'exhausted',
      'suspended',
      'unknown',
    ].includes(status as string) ||
    typeof seal.terminalReceiptId !== 'string' ||
    !seal.terminalReceiptId ||
    typeof seal.cleanupConfirmed !== 'boolean' ||
    typeof resultRef?.integrityIdentifier !== 'string' ||
    !origin ||
    origin.parentSessionId !== parentSessionId ||
    origin.parentInvocationId !== intent.parentInvocationId ||
    origin.childInvocationId !== intent.childInvocationId ||
    origin.taskInputAdmitted !== true ||
    origin.fundingRunId !== intent.fundingRunId ||
    origin.delegatedReservationId !== intent.delegatedReservationId ||
    terminal?.terminalReceiptId !== seal.terminalReceiptId ||
    terminal.status !== status ||
    terminal.cleanupConfirmed !== seal.cleanupConfirmed ||
    storedRef?.integrityIdentifier !== resultRef.integrityIdentifier ||
    object(state?.resourceBudget)?.status !== 'active' ||
    object(state?.turn)?.status === 'active' ||
    (status !== 'unknown' && seal.cleanupConfirmed !== true) ||
    (!outcome &&
      !(
        status === 'cancelled' &&
        seal.cleanupConfirmed === true &&
        object(state?.turn)?.status === 'aborted' &&
        object(state?.turn)?.abortCause === 'user'
      )) ||
    (status === 'completed') !== (outcome?.status === 'completed') ||
    (status === 'unknown' &&
      (outcome?.status !== 'unknown' || outcome.knownExternalEffects !== 'unknown'))
  )
    throw new Error('Pending child terminal seal is invalid.');
  return {
    childThreadId,
    parentInvocationId: intent.parentInvocationId,
    childInvocationId: intent.childInvocationId,
    fundingRunId: intent.fundingRunId,
    delegatedReservationId: intent.delegatedReservationId,
    sealEventId: seals[0]!.event_id,
    sealRevision: seals[0]!.sequence,
    terminalReceiptId: seal.terminalReceiptId,
    status: status as KitePendingChildTerminalSeal['status'],
  };
}

export function assertChildSessionIntent(
  database: Database,
  intent: RuntimeChildSessionIntentMutation,
  childState: unknown,
): void {
  const row = readChildSessionIntent(database, intent.childThreadId);
  if (!row || !exactTuple(intent, row))
    throw new Error('Child Session has no exact parent Tool intent.');
  if (row.failureReceiptDigest) throw new Error('Child Session creation already failed durably.');
  const parentEvent = database
    .query<{ event_id: string }, [string, string, number]>(
      'SELECT event_id FROM runtime_events WHERE session_id = ? AND event_id = ? AND sequence = ? LIMIT 1',
    )
    .get(intent.parentSessionId, row.toolEventId as string, row.toolEventRevision as number);
  if (!parentEvent) throw new Error('Child Session parent Tool terminal no longer exists.');
  const upperJson = row.delegatedUpperBoundJson;
  if (typeof upperJson !== 'string') throw new Error('Child Session delegated ceiling is absent.');
  const upper = object(JSON.parse(upperJson));
  if (!upper || childDelegatedUpperBoundDigest(upper as never) !== intent.delegatedUpperBoundDigest)
    throw new Error('Child Session delegated ceiling digest conflicts.');
  const state = object(childState);
  const origin = object(state?.childSessionOrigin);
  const artifactRef = object(origin?.taskArtifactRef);
  const resource = object(state?.resourceBudget);
  if (
    !origin ||
    resource?.status !== 'unconfigured' ||
    origin.parentSessionId !== intent.parentSessionId ||
    origin.parentInvocationId !== intent.parentInvocationId ||
    origin.parentToolCallId !== intent.originToolCallId ||
    origin.attempt !== intent.attempt ||
    origin.childInvocationId !== intent.childInvocationId ||
    origin.grantDigest !== intent.grantDigest ||
    origin.role !== row.role ||
    origin.taskArtifactDigest !== intent.taskArtifactDigest ||
    origin.taskTextDigest !== intent.taskTextDigest ||
    artifactRef?.artifactId !== row.taskArtifactId ||
    artifactRef?.kind !== 'subagent_task' ||
    artifactRef?.integrityIdentifier !== row.taskArtifactDigest ||
    artifactRef?.byteLength !== row.taskArtifactByteLength ||
    origin.taskInputAdmitted === true ||
    origin.fundingRunId !== intent.fundingRunId ||
    origin.delegatedReservationId !== intent.delegatedReservationId ||
    origin.delegatedUpperBoundDigest !== intent.delegatedUpperBoundDigest ||
    origin.deadlineAt !== intent.deadlineAt
  )
    throw new Error('Child Session initial origin or budget is not exact.');
}
