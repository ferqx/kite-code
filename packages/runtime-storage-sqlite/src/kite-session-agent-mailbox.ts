import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type {
  RuntimeAgentMailboxMutation,
  RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';
import { createKiteHomeArtifactStore } from './kite-home-artifacts';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const HEX = /^[a-f0-9]{64}$/u;

export class KiteSessionAgentMailboxError extends Error {
  readonly code:
    | 'invalid_source'
    | 'identity_conflict'
    | 'capacity_exceeded'
    | 'context_unavailable'
    | 'watermark_conflict';
  constructor(code: KiteSessionAgentMailboxError['code'], message: string) {
    super(message);
    this.name = 'KiteSessionAgentMailboxError';
    this.code = code;
  }
}

type EventRecord = Readonly<Record<string, unknown>>;

/** Initial Controller creation has already proven a fresh Session and its command receipt. */
export function ensureRootAgentOnInitialCreationInTransaction<Event, State>(
  database: Database,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  const receipt = transaction.commandReceipt;
  if (
    !database.inTransaction ||
    !receipt ||
    receipt.scopeSessionId !== transaction.sessionId ||
    receipt.targetSessionId !== transaction.sessionId ||
    transaction.runMutation ||
    transaction.agentMailboxMutations?.length ||
    transaction.events.length !== 0
  )
    invalidSource();
  if (node(database, transaction.sessionId, transaction.sessionId)) conflict();
  database
    .query(`INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,created_at_ms)
    VALUES (?,?,NULL,NULL,'idle',0,?)`)
    .run(transaction.sessionId, transaction.sessionId, receipt.committedAt);
}

/** Called only from the existing fenced Session transaction, after its State and receipt writes. */
export function applyKiteSessionAgentMailboxMutations<Event, State>(
  database: Database,
  transaction: RuntimeTransactionInput<Event, State>,
  currentOwnerGeneration?: string,
): void {
  const mutations = transaction.agentMailboxMutations;
  if (!mutations?.length) return;
  if (!database.inTransaction)
    throw new Error('Agent mailbox mutation requires a Session transaction.');
  const events = transaction.events.filter(
    (event): event is Event & EventRecord => typeof event === 'object' && event !== null,
  ) as readonly EventRecord[];
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'create_agent':
        if (
          !mutations.some(
            (next) =>
              next.kind === 'turn_started' &&
              next.agentId === mutation.agentId &&
              next.taskId === mutation.initialTaskId &&
              next.turnOrdinal === 1,
          )
        )
          invalidSource();
        requireEvent(
          events,
          'agent.created',
          (event) =>
            event.agentId === mutation.agentId &&
            event.parentAgentId === mutation.parentAgentId &&
            event.initialTaskId === mutation.initialTaskId,
        );
        createAgent(database, transaction.sessionId, mutation);
        break;
      case 'accept_mail':
        requireEvent(
          events,
          'agent.mail_accepted',
          (event) =>
            event.messageId === mutation.messageId &&
            event.senderAgentId === mutation.senderAgentId &&
            event.targetAgentId === mutation.targetAgentId &&
            event.sequence === mutation.sequence &&
            event.mode === mutation.mode &&
            event.submissionId === mutation.submissionId &&
            event.bodyDigest === mutation.bodyDigest &&
            JSON.stringify(event.bodyRef) === JSON.stringify(mutation.bodyRef) &&
            JSON.stringify(event.source) === JSON.stringify(mutation.source) &&
            JSON.stringify(event.followupAdmissionRef) ===
              JSON.stringify(mutation.followupAdmission?.ref) &&
            event.followupAdmissionDigest === mutation.followupAdmission?.digest,
        );
        acceptMail(database, transaction, mutation);
        break;
      case 'prepare_input':
        requireEvent(
          events,
          'agent.mail_input_prepared',
          (event) =>
            event.targetAgentId === mutation.targetAgentId &&
            event.invocationId === mutation.modelInvocationId &&
            event.modelAdmissionId === mutation.modelAdmissionId &&
            event.fromSequence === mutation.fromSequence &&
            event.throughSequence === mutation.throughSequence &&
            JSON.stringify(event.messageIds) === JSON.stringify(mutation.messageIds),
        );
        assertModelAdmissionForPreparedMail(events, transaction.snapshot, mutation);
        prepareInput(database, transaction.sessionId, mutation);
        break;
      case 'turn_started':
        requireEvent(
          events,
          'agent.turn_started',
          (event) =>
            event.agentId === mutation.agentId &&
            event.taskId === mutation.taskId &&
            event.turnOrdinal === mutation.turnOrdinal &&
            event.submissionId === mutation.submissionId &&
            event.ownerGeneration === currentOwnerGeneration &&
            typeof event.grantDigest === 'string' &&
            /^sha256:[a-f0-9]{64}$/u.test(event.grantDigest),
        );
        turnStarted(
          database,
          transaction.sessionId,
          mutation,
          events.find(
            (event) =>
              event.type === 'agent.turn_started' &&
              event.agentId === mutation.agentId &&
              event.taskId === mutation.taskId,
          )!,
          currentOwnerGeneration,
        );
        break;
      case 'task_settled':
        requireEvent(
          events,
          'agent.task_settled',
          (event) =>
            event.agentId === mutation.agentId &&
            event.taskId === mutation.taskId &&
            event.ownerGeneration ===
              node(database, transaction.sessionId, mutation.agentId)?.current_owner_generation &&
            event.submissionId ===
              (node(database, transaction.sessionId, mutation.agentId)?.current_submission_id ??
                undefined) &&
            JSON.stringify(event.checkpointRef) === JSON.stringify(mutation.checkpointRef),
        );
        taskSettled(database, transaction.sessionId, mutation);
        break;
    }
  }
}

export function assertModelAdmissionForPreparedMail(
  events: readonly EventRecord[],
  snapshot: unknown,
  mutation: { readonly modelInvocationId: string; readonly modelAdmissionId: string },
): void {
  const prepared = events.filter(
    (event) =>
      event.type === 'model.invocation_prepared' &&
      event.invocationId === mutation.modelInvocationId,
  );
  if (prepared.length !== 1) invalidSource();
  const budget = prepared[0]?.budget;
  const snapshotState =
    snapshot && typeof snapshot === 'object'
      ? (snapshot as { resourceBudget?: unknown; retainedResourceBudgets?: unknown })
      : undefined;
  const state = snapshotState?.resourceBudget;
  if (!budget || typeof budget !== 'object' || !state || typeof state !== 'object') invalidSource();
  const modelBudget = budget as { kind?: unknown; reservationId?: unknown };
  const resourceBudget = state as { status?: unknown; runId?: unknown; reservations?: unknown };
  if (modelBudget.kind === 'no_budget') {
    if (
      resourceBudget.status !== 'unconfigured' ||
      mutation.modelAdmissionId !== mutation.modelInvocationId
    )
      invalidSource();
    return;
  }
  if (modelBudget.kind !== 'reservation' || modelBudget.reservationId !== mutation.modelAdmissionId)
    invalidSource();
  const retained = snapshotState?.retainedResourceBudgets ?? {};
  if (!retained || typeof retained !== 'object' || Array.isArray(retained)) invalidSource();
  const ledgers: Array<{ runId: string; reservation: unknown }> = [];
  const collect = (ledger: unknown, runId: string): void => {
    if (!ledger || typeof ledger !== 'object') invalidSource();
    const candidate = ledger as { status?: unknown; runId?: unknown; reservations?: unknown };
    if (
      candidate.status !== 'active' ||
      candidate.runId !== runId ||
      !candidate.reservations ||
      typeof candidate.reservations !== 'object' ||
      Array.isArray(candidate.reservations)
    )
      invalidSource();
    const reservation = (candidate.reservations as Record<string, unknown>)[
      mutation.modelAdmissionId
    ];
    if (reservation !== undefined) ledgers.push({ runId, reservation });
  };
  if (resourceBudget.status === 'active') {
    if (typeof resourceBudget.runId !== 'string' || !resourceBudget.runId) invalidSource();
    collect(resourceBudget, resourceBudget.runId);
  } else if (resourceBudget.status !== 'unconfigured') invalidSource();
  for (const [runId, ledger] of Object.entries(retained)) {
    if (!runId || (resourceBudget.status === 'active' && runId === resourceBudget.runId))
      invalidSource();
    collect(ledger, runId);
  }
  if (ledgers.length !== 1) invalidSource();
  const match = ledgers[0]!;
  if (!match.reservation || typeof match.reservation !== 'object') invalidSource();
  const exact = match.reservation as {
    reservationId?: unknown;
    runId?: unknown;
    invocationId?: unknown;
    resourceKind?: unknown;
    state?: unknown;
  };
  if (
    exact.reservationId !== mutation.modelAdmissionId ||
    exact.runId !== match.runId ||
    exact.invocationId !== `model-invocation:${mutation.modelInvocationId}` ||
    exact.resourceKind !== 'model' ||
    (exact.state !== 'reserved' && exact.state !== 'dispatch_started')
  )
    invalidSource();
}

/** Exact Run start owns the root row, including first use of a converted Store10 Session. */
export function startRootAgentRunInTransaction<Event, State>(
  database: Database,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  const mutation = transaction.runMutation;
  if (mutation?.type !== 'insert') return;
  const run = mutation.run;
  if (
    run.sessionId !== transaction.sessionId ||
    run.status !== 'queued' ||
    !transaction.events.some(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        (event as { type?: unknown }).type === 'turn.started' &&
        (event as { turnId?: unknown }).turnId === run.runId,
    )
  )
    return;
  const stored = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(transaction.sessionId, run.runId);
  if (stored?.status !== 'queued') conflict();
  const root = node(database, transaction.sessionId, transaction.sessionId);
  if (!root) {
    database
      .query(`INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,created_at_ms)
      VALUES (?,?,NULL,?,'active',1,?)`)
      .run(transaction.sessionId, transaction.sessionId, run.runId, run.createdAtMs);
    return;
  }
  const checkpointlessFollowup =
    transaction.followupRunStart?.checkpointRef === undefined &&
    Number.isSafeInteger(transaction.followupRunStart?.sourceRevision) &&
    typeof transaction.followupRunStart?.sourceStateDigest === 'string';
  if (
    root.parent_agent_id !== null ||
    (root.status !== 'idle' &&
      !(root.status === 'context_unavailable' && checkpointlessFollowup)) ||
    root.current_task_id !== null
  )
    conflict();
  database
    .query(
      "UPDATE agent_nodes SET current_task_id=?,status='active',turn_ordinal=turn_ordinal+1 WHERE session_id=? AND agent_id=?",
    )
    .run(run.runId, transaction.sessionId, transaction.sessionId);
}

/** Root Agent lane follows the canonical Run terminal transition, with no second terminal event. */
export function settleRootAgentRunInTransaction<Event, State>(
  database: Database,
  transaction: RuntimeTransactionInput<Event, State>,
): void {
  const mutation = transaction.runMutation;
  if (
    mutation?.type !== 'transition' ||
    !['completed', 'failed', 'cancelled', 'unknown'].includes(mutation.transition.next.status) ||
    !transaction.events.some(
      (event) =>
        typeof event === 'object' &&
        event !== null &&
        ['run.completed', 'run.error', 'turn.aborted'].includes(
          String((event as { type?: unknown }).type),
        ),
    )
  )
    return;
  const sessionId = transaction.sessionId;
  const runId = mutation.transition.runId;
  const root = database
    .query<{ current_task_id: string | null; status: string }, [string, string]>(
      'SELECT current_task_id,status FROM agent_nodes WHERE session_id=? AND agent_id=? AND parent_agent_id IS NULL',
    )
    .get(sessionId, sessionId);
  if (!root || root.current_task_id !== runId) return;
  if (root.status !== 'active') conflict();
  const stored = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(sessionId, runId);
  if (stored?.status !== mutation.transition.next.status) conflict();
  database
    .query(
      "UPDATE agent_nodes SET status='idle',current_task_id=NULL,current_submission_id=NULL WHERE session_id=? AND agent_id=?",
    )
    .run(sessionId, sessionId);
}

function requireEvent(
  events: readonly EventRecord[],
  type: string,
  matches: (event: EventRecord) => boolean,
): void {
  if (!events.some((event) => event.type === type && matches(event)))
    throw new KiteSessionAgentMailboxError(
      'invalid_source',
      `Agent mailbox ${type} event does not match its private mutation.`,
    );
}

function createAgent(
  database: Database,
  sessionId: string,
  mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'create_agent' }>,
): void {
  if (!mutation.agentId || !Number.isSafeInteger(mutation.createdAtMs) || mutation.createdAtMs < 0)
    invalidSource();
  if (mutation.parentAgentId === null) {
    invalidSource();
  } else {
    if (mutation.initialTaskId !== mutation.agentId || mutation.parentAgentId === mutation.agentId)
      invalidSource();
    if (!node(database, sessionId, mutation.parentAgentId)) invalidSource();
  }
  const existing = node(database, sessionId, mutation.agentId);
  if (existing) {
    if (
      existing.parent_agent_id !== mutation.parentAgentId ||
      existing.current_task_id !== (mutation.initialTaskId ?? null)
    )
      conflict();
    return;
  }
  database
    .query(`INSERT INTO agent_nodes(session_id,agent_id,parent_agent_id,current_task_id,status,turn_ordinal,created_at_ms)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      sessionId,
      mutation.agentId,
      mutation.parentAgentId,
      mutation.initialTaskId ?? null,
      'idle',
      0,
      mutation.createdAtMs,
    );
}

type NodeRow = {
  parent_agent_id: string | null;
  current_task_id: string | null;
  current_submission_id: string | null;
  current_owner_generation: string | null;
  current_grant_digest: string | null;
  status: string;
  turn_ordinal: number;
  prepared_through_sequence: number;
  latest_checkpoint_artifact_id: string | null;
};
function node(database: Database, sessionId: string, agentId: string): NodeRow | null {
  return database
    .query<
      NodeRow,
      [string, string]
    >(`SELECT parent_agent_id,current_task_id,current_submission_id,current_owner_generation,current_grant_digest,status,turn_ordinal,prepared_through_sequence,latest_checkpoint_artifact_id
    FROM agent_nodes WHERE session_id=? AND agent_id=?`)
    .get(sessionId, agentId);
}

function treeVisible(
  database: Database,
  sessionId: string,
  sourceAgentId: string,
  targetAgentId: string,
): boolean {
  if (sourceAgentId === targetAgentId) return true;
  const ancestor = (childId: string, ancestorId: string): boolean =>
    database
      .query<
        { present: number },
        [string, string, string, string]
      >(`WITH RECURSIVE lineage(agent_id,parent_agent_id) AS (
      SELECT agent_id,parent_agent_id FROM agent_nodes WHERE session_id=? AND agent_id=?
      UNION SELECT n.agent_id,n.parent_agent_id FROM agent_nodes n JOIN lineage l
        ON n.session_id=? AND n.agent_id=l.parent_agent_id
    ) SELECT 1 AS present FROM lineage WHERE agent_id=? LIMIT 1`)
      .get(sessionId, childId, sessionId, ancestorId) !== null;
  return ancestor(sourceAgentId, targetAgentId) || ancestor(targetAgentId, sourceAgentId);
}

function acceptMail<Event, State>(
  database: Database,
  transaction: RuntimeTransactionInput<Event, State>,
  mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'accept_mail' }>,
): void {
  const sessionId = transaction.sessionId;
  const sender = node(database, sessionId, mutation.senderAgentId);
  const target = node(database, sessionId, mutation.targetAgentId);
  if (
    !sender ||
    !target ||
    !treeVisible(database, sessionId, mutation.senderAgentId, mutation.targetAgentId) ||
    !mutation.messageId ||
    !mutation.source.effectAttemptId ||
    !HEX.test(mutation.requestDigest)
  )
    invalidSource();
  if (
    target.status === 'context_unavailable' ||
    (target.status === 'idle' &&
      target.parent_agent_id !== null &&
      target.latest_checkpoint_artifact_id === null)
  )
    throw new KiteSessionAgentMailboxError(
      'context_unavailable',
      'Target Agent has no settled continuation checkpoint.',
    );
  const bodyBytes = Buffer.byteLength(mutation.bodyText, 'utf8');
  const digest = `sha256:${createHash('sha256').update(mutation.bodyText).digest('hex')}`;
  if (
    bodyBytes < 1 ||
    !Number.isSafeInteger(bodyBytes) ||
    !/^pa_[a-f0-9]{64}$/u.test(mutation.bodyRef.artifactId) ||
    mutation.bodyRef.byteLength !== bodyBytes ||
    mutation.bodyRef.kind !== 'agent_mail' ||
    mutation.bodyRef.integrityIdentifier !== digest ||
    mutation.bodyDigest !== digest
  )
    invalidSource();
  if (mutation.mode !== 'reply') {
    const receipt = transaction.commandReceipt;
    const lease = transaction.requiredEffectLease;
    if (
      !receipt ||
      !lease ||
      receipt.scopeSessionId !== sessionId ||
      receipt.targetSessionId !== sessionId ||
      receipt.commandId !== mutation.messageId ||
      receipt.requestDigest !== mutation.requestDigest
    )
      invalidSource();
  }
  if (
    (mutation.mode === 'trigger_turn') !==
    Boolean(mutation.followupAdmission && mutation.submissionId)
  )
    invalidSource();
  if (mutation.followupAdmission) {
    const admission = mutation.followupAdmission;
    if (
      !SHA256.test(admission.digest) ||
      admission.ref.integrityIdentifier !== admission.digest ||
      `sha256:${createHash('sha256').update(admission.canonicalJson).digest('hex')}` !==
        admission.digest
    )
      invalidSource();
    createKiteHomeArtifactStore(database).writeAgentFollowupAdmission({
      ref: admission.ref,
      artifactFormatVersion: 1,
      canonicalJson: admission.canonicalJson,
      createdAt: admission.createdAt,
    });
  }
  const existing = database
    .query<
      {
        request_digest: string;
        message_id: string;
        submission_id: string | null;
        sender_agent_id: string;
        target_agent_id: string;
        mode: string;
        body_id: string;
        sequence: number;
        source_run_id: string;
        source_turn_id: string;
        source_model_invocation_id: string;
        source_tool_call_id: string;
        source_effect_attempt_id: string;
        source_task_id: string | null;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
      },
      [string, string]
    >(
      `SELECT request_digest,message_id,submission_id,sender_agent_id,target_agent_id,mode,body_id,sequence,
      source_run_id,source_turn_id,source_model_invocation_id,source_tool_call_id,source_effect_attempt_id,source_task_id,
      followup_admission_artifact_id,followup_admission_digest FROM agent_mail WHERE session_id=? AND message_id=?`,
    )
    .get(sessionId, mutation.messageId);
  if (existing) {
    if (
      existing.request_digest !== mutation.requestDigest ||
      existing.sender_agent_id !== mutation.senderAgentId ||
      existing.target_agent_id !== mutation.targetAgentId ||
      existing.mode !== mutation.mode ||
      existing.body_id !== mutation.bodyRef.artifactId ||
      existing.sequence !== mutation.sequence ||
      existing.submission_id !== (mutation.submissionId ?? null) ||
      existing.source_run_id !== mutation.source.runId ||
      existing.source_turn_id !== mutation.source.turnId ||
      existing.source_model_invocation_id !== mutation.source.modelInvocationId ||
      existing.source_tool_call_id !== mutation.source.toolCallId ||
      existing.source_effect_attempt_id !== mutation.source.effectAttemptId ||
      existing.source_task_id !== (mutation.source.sourceTaskId ?? null) ||
      existing.followup_admission_artifact_id !==
        (mutation.followupAdmission?.ref.artifactId ?? null) ||
      existing.followup_admission_digest !== (mutation.followupAdmission?.digest ?? null)
    )
      conflict();
    return;
  }
  const next = database
    .query<{ sequence: number }, [string]>(
      'SELECT coalesce(max(sequence),0)+1 AS sequence FROM agent_mail WHERE session_id=?',
    )
    .get(sessionId)?.sequence;
  if (next !== mutation.sequence) conflict();
  database
    .query(`INSERT OR IGNORE INTO agent_mail_bodies(session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms)
    VALUES (?,?,?,?,?,?)`)
    .run(
      sessionId,
      mutation.bodyRef.artifactId,
      digest,
      bodyBytes,
      mutation.bodyText,
      mutation.acceptedAtMs,
    );
  const storedBody = database
    .query<
      { integrity_identifier: string; byte_length: number; body_text: string },
      [string, string]
    >(
      'SELECT integrity_identifier,byte_length,body_text FROM agent_mail_bodies WHERE session_id=? AND body_id=?',
    )
    .get(sessionId, mutation.bodyRef.artifactId);
  if (
    !storedBody ||
    storedBody.integrity_identifier !== digest ||
    storedBody.byte_length !== bodyBytes ||
    storedBody.body_text !== mutation.bodyText
  )
    conflict();
  const source = mutation.source;
  const recipientRunId =
    target.parent_agent_id === null &&
    target.status === 'active' &&
    target.current_task_id === source.runId
      ? target.current_task_id
      : null;
  database
    .query(`INSERT INTO agent_mail(session_id,message_id,submission_id,sequence,sender_agent_id,target_agent_id,mode,
    recipient_run_id,
    source_run_id,source_turn_id,source_model_invocation_id,source_tool_call_id,source_effect_attempt_id,source_task_id,
    request_digest,body_id,followup_admission_artifact_id,followup_admission_digest,status,accepted_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queued',?)`)
    .run(
      sessionId,
      mutation.messageId,
      mutation.submissionId ?? null,
      mutation.sequence,
      mutation.senderAgentId,
      mutation.targetAgentId,
      mutation.mode,
      recipientRunId,
      source.runId,
      source.turnId,
      source.modelInvocationId,
      source.toolCallId,
      source.effectAttemptId,
      source.sourceTaskId ?? null,
      mutation.requestDigest,
      mutation.bodyRef.artifactId,
      mutation.followupAdmission?.ref.artifactId ?? null,
      mutation.followupAdmission?.digest ?? null,
      mutation.acceptedAtMs,
    );
}

function prepareInput(
  database: Database,
  sessionId: string,
  mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'prepare_input' }>,
): void {
  const target = node(database, sessionId, mutation.targetAgentId);
  if (
    target?.status !== 'active' ||
    mutation.messageIds.length < 1 ||
    !mutation.modelAdmissionId ||
    !mutation.modelInvocationId
  )
    throw new KiteSessionAgentMailboxError(
      'watermark_conflict',
      'Agent mailbox preparation boundary changed.',
    );
  if (target.parent_agent_id === null && !target.current_task_id) invalidSource();
  const rootRecipient = target.parent_agent_id === null ? target.current_task_id : null;
  const recipientClause = target.parent_agent_id === null ? ' AND recipient_run_id=?' : '';
  if (target.prepared_through_sequence === mutation.throughSequence) {
    const replay = database.query<
      { message_id: string; sequence: number; model_admission_id: string },
      (string | number)[]
    >(
      `SELECT message_id,sequence,model_admission_id FROM agent_mail WHERE session_id=? AND target_agent_id=? AND status='prepared' AND prepared_invocation_id=?${recipientClause} ORDER BY sequence`,
    );
    const rows = replay.all(
      sessionId,
      mutation.targetAgentId,
      mutation.modelInvocationId,
      ...(rootRecipient === null ? [] : [rootRecipient]),
    );
    if (
      JSON.stringify(rows.map((row) => row.message_id)) === JSON.stringify(mutation.messageIds) &&
      rows.at(-1)?.sequence === mutation.throughSequence &&
      rows.every((row) => row.model_admission_id === mutation.modelAdmissionId)
    )
      return;
  }
  if (target.prepared_through_sequence !== mutation.fromSequence)
    throw new KiteSessionAgentMailboxError(
      'watermark_conflict',
      'Agent mailbox preparation boundary changed.',
    );
  const rows = database
    .query<{ message_id: string; sequence: number }, (string | number)[]>(
      `SELECT message_id,sequence FROM agent_mail WHERE session_id=? AND target_agent_id=? AND status='queued' AND sequence>?${recipientClause} ORDER BY sequence`,
    )
    .all(
      sessionId,
      mutation.targetAgentId,
      mutation.fromSequence,
      ...(rootRecipient === null ? [] : [rootRecipient]),
    );
  if (
    JSON.stringify(rows.map((row) => row.message_id)) !== JSON.stringify(mutation.messageIds) ||
    rows.at(-1)?.sequence !== mutation.throughSequence
  )
    throw new KiteSessionAgentMailboxError(
      'watermark_conflict',
      'Agent mailbox prepared batch differs from queued order.',
    );
  const update = database.query(
    "UPDATE agent_mail SET status='prepared',prepared_invocation_id=?,model_admission_id=? WHERE session_id=? AND message_id=? AND status='queued'",
  );
  for (const id of mutation.messageIds) {
    if (
      update.run(mutation.modelInvocationId, mutation.modelAdmissionId, sessionId, id).changes !== 1
    )
      conflict();
  }
  database
    .query('UPDATE agent_nodes SET prepared_through_sequence=? WHERE session_id=? AND agent_id=?')
    .run(mutation.throughSequence, sessionId, mutation.targetAgentId);
}

function turnStarted(
  database: Database,
  sessionId: string,
  mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'turn_started' }>,
  event: EventRecord,
  currentOwnerGeneration?: string,
): void {
  const target = node(database, sessionId, mutation.agentId);
  if (
    target?.status !== 'idle' ||
    target.parent_agent_id === null ||
    target.turn_ordinal + 1 !== mutation.turnOrdinal ||
    !currentOwnerGeneration ||
    event.ownerGeneration !== currentOwnerGeneration ||
    typeof event.grantDigest !== 'string' ||
    (target.parent_agent_id !== null &&
      target.latest_checkpoint_artifact_id === null &&
      !(target.turn_ordinal === 0 && target.current_task_id === mutation.taskId))
  )
    conflict();
  if (mutation.turnOrdinal === 1) {
    if (mutation.submissionId !== undefined) invalidSource();
  } else {
    if (!mutation.submissionId || mutation.taskId === target.current_task_id) invalidSource();
    const accepted = database
      .query<{ present: number }, [string, string, string]>(
        "SELECT 1 AS present FROM agent_mail WHERE session_id=? AND target_agent_id=? AND submission_id=? AND mode='trigger_turn' LIMIT 1",
      )
      .get(sessionId, mutation.agentId, mutation.submissionId);
    if (!accepted) invalidSource();
  }
  database
    .query(
      "UPDATE agent_nodes SET current_task_id=?,current_submission_id=?,current_owner_generation=?,current_grant_digest=?,status='active',turn_ordinal=? WHERE session_id=? AND agent_id=?",
    )
    .run(
      mutation.taskId,
      mutation.submissionId ?? null,
      currentOwnerGeneration,
      event.grantDigest,
      mutation.turnOrdinal,
      sessionId,
      mutation.agentId,
    );
}

function taskSettled(
  database: Database,
  sessionId: string,
  mutation: Extract<RuntimeAgentMailboxMutation, { kind: 'task_settled' }>,
): void {
  const target = node(database, sessionId, mutation.agentId);
  if (target?.status !== 'active' || target.current_task_id !== mutation.taskId) conflict();
  const ref = mutation.checkpointRef;
  if (ref) {
    const artifact = createKiteHomeArtifactStore(database).readSubagentCheckpoint(ref);
    if (artifact.artifactFormatVersion !== 1) invalidSource();
  }
  database
    .query(`UPDATE agent_nodes SET status=?,latest_checkpoint_artifact_id=?,
    latest_checkpoint_integrity_identifier=?,latest_checkpoint_byte_length=? WHERE session_id=? AND agent_id=?`)
    .run(
      ref ? 'idle' : 'context_unavailable',
      ref?.artifactId ?? null,
      ref?.integrityIdentifier ?? null,
      ref?.byteLength ?? null,
      sessionId,
      mutation.agentId,
    );
  if (!ref)
    database
      .query(
        "UPDATE agent_mail SET status='context_unavailable' WHERE session_id=? AND target_agent_id=? AND status='queued'",
      )
      .run(sessionId, mutation.agentId);
}

function invalidSource(): never {
  throw new KiteSessionAgentMailboxError(
    'invalid_source',
    'Agent mailbox source or body proof is invalid.',
  );
}
function conflict(): never {
  throw new KiteSessionAgentMailboxError(
    'identity_conflict',
    'Agent mailbox identity conflicts with durable facts.',
  );
}

export interface KiteSessionAgentMetadata {
  readonly agentId: string;
  readonly parentAgentId: string | null;
  readonly currentTaskId: string | null;
  readonly currentSubmissionId: string | null;
  readonly status: 'idle' | 'active' | 'context_unavailable';
  readonly turnOrdinal: number;
  readonly mailRevision: number;
  readonly preparedThroughSequence: number;
  readonly unreadCount: number;
}

export interface KiteSessionAgentMetadataPort {
  readAgent(
    sessionId: string,
    sourceAgentId: string,
    targetAgentId: string,
  ): KiteSessionAgentMetadata | null;
  listAgents(sessionId: string, sourceAgentId: string): readonly KiteSessionAgentMetadata[];
  nextSequence(sessionId: string, sourceAgentId: string): number;
}

/** Metadata only. Private body delivery requires a separately proven execution scope. */
export function createKiteSessionAgentMetadataPort(
  database: Database,
): KiteSessionAgentMetadataPort {
  const sourceExists = (sessionId: string, sourceAgentId: string): boolean =>
    database
      .query<{ present: number }, [string, string]>(
        'SELECT 1 AS present FROM agent_nodes WHERE session_id=? AND agent_id=?',
      )
      .get(sessionId, sourceAgentId) !== null;
  const readAgent = (
    sessionId: string,
    sourceAgentId: string,
    targetAgentId: string,
  ): KiteSessionAgentMetadata | null => {
    if (!sourceExists(sessionId, sourceAgentId)) invalidSource();
    if (!treeVisible(database, sessionId, sourceAgentId, targetAgentId)) return null;
    const row = database
      .query<
        {
          agent_id: string;
          parent_agent_id: string | null;
          current_task_id: string | null;
          current_submission_id: string | null;
          status: KiteSessionAgentMetadata['status'];
          turn_ordinal: number;
          mail_revision: number;
          prepared_through_sequence: number;
          unread_count: number;
        },
        [string, string]
      >(`SELECT n.agent_id,n.parent_agent_id,n.current_task_id,n.current_submission_id,n.status,n.turn_ordinal,
      (SELECT coalesce(max(m.sequence),0) FROM agent_mail m WHERE m.session_id=n.session_id AND m.target_agent_id=n.agent_id) AS mail_revision,
      n.prepared_through_sequence,(SELECT count(*) FROM agent_mail m
      WHERE m.session_id=n.session_id AND m.target_agent_id=n.agent_id AND m.status='queued') AS unread_count
      FROM agent_nodes n WHERE n.session_id=? AND n.agent_id=?`)
      .get(sessionId, targetAgentId);
    return row
      ? Object.freeze({
          agentId: row.agent_id,
          parentAgentId: row.parent_agent_id,
          currentTaskId: row.current_task_id,
          currentSubmissionId: row.current_submission_id,
          status: row.status,
          turnOrdinal: row.turn_ordinal,
          mailRevision: row.mail_revision,
          preparedThroughSequence: row.prepared_through_sequence,
          unreadCount: row.unread_count,
        })
      : null;
  };
  return Object.freeze({
    readAgent,
    nextSequence: (sessionId: string, sourceAgentId: string) => {
      if (!sourceExists(sessionId, sourceAgentId)) invalidSource();
      const next = database
        .query<{ sequence: number }, [string]>(
          'SELECT coalesce(max(sequence),0)+1 AS sequence FROM agent_mail WHERE session_id=?',
        )
        .get(sessionId)?.sequence;
      if (!Number.isSafeInteger(next) || next! < 1) conflict();
      return next!;
    },
    listAgents: (sessionId: string, sourceAgentId: string) => {
      if (!sourceExists(sessionId, sourceAgentId)) invalidSource();
      const rows = database
        .query<{ agent_id: string }, [string]>(
          'SELECT agent_id FROM agent_nodes WHERE session_id=? ORDER BY created_at_ms,agent_id LIMIT 100',
        )
        .all(sessionId);
      return Object.freeze(
        rows.flatMap((row) => {
          const visible = readAgent(sessionId, sourceAgentId, row.agent_id);
          return visible ? [visible] : [];
        }),
      );
    },
  });
}
