import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readChildSealedGrant } from './kite-child-session-intents';
import { readProvenUnfundedExpiredFollowupRelease } from './kite-cross-session-followup-proof';

const HEX = /^[a-f0-9]{64}$/u;

export class KiteCrossSessionAgentMailError extends Error {
  readonly code: 'invalid_source' | 'identity_conflict' | 'target_unavailable';
  constructor(
    code: 'invalid_source' | 'identity_conflict' | 'target_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'KiteCrossSessionAgentMailError';
    this.code = code;
  }
}

export interface CrossSessionMailIntent {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly messageId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly sourceRunId: string;
  readonly sourceTurnId: string;
  readonly sourceModelInvocationId: string;
  readonly sourceToolCallId: string;
  readonly sourceEffectAttemptId: string;
  readonly sourceTaskId?: string;
  readonly sourceGrantId?: string;
  readonly sourceGrantDigest?: string;
  readonly sourceOwnerGeneration?: number;
  readonly sourceSnapshot?: unknown;
  readonly sourceSequence: number;
  readonly sourceRevision: number;
  readonly bodyText: string;
  readonly acceptedAtMs: number;
}

export interface CrossSessionFollowupTerminalReplyIntent {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly submissionId: string;
  readonly acceptedAtMs: number;
}

/** A new Turn reply requires target settlement and its matching source funding ACK. */
export function acceptCrossSessionFollowupTerminalReplyInTransaction(
  database: Database,
  input: CrossSessionFollowupTerminalReplyIntent,
): CrossSessionMailOutboxRecord {
  requireTransaction(database);
  if (
    !input.childSessionId ||
    !input.parentSessionId ||
    !input.submissionId ||
    !Number.isSafeInteger(input.acceptedAtMs) ||
    input.acceptedAtMs < 0
  )
    invalidSource();
  const child = database
    .query<{ parent_session_id: string | null; revision: number }, [string]>(
      'SELECT parent_session_id,revision FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.childSessionId);
  if (child?.parent_session_id !== input.parentSessionId) invalidSource();
  assertPair(database, input.childSessionId, input.parentSessionId);
  const persistedRoute = database
    .query<
      {
        source_session_id: string;
        message_id: string;
        route: string;
        target_run_id: string;
        task_id: string;
        invocation_id: string;
      },
      [string, string]
    >(
      `SELECT source_session_id,message_id,route,target_run_id,task_id,invocation_id
       FROM agent_followup_routes WHERE target_session_id=? AND submission_id=?`,
    )
    .get(input.childSessionId, input.submissionId);
  // A failed independent turn can settle before preparing its first Model route.
  const preDispatch = persistedRoute
    ? null
    : database
        .query<
          { message_id: string; target_run_id: string; task_id: string; event_id: string },
          [string, string, string]
        >(
          `SELECT o.message_id,r.run_id AS target_run_id,
           json_extract(e.event_json,'$.taskId') AS task_id,e.event_id
           FROM agent_mail_outbox o JOIN runtime_runs r
             ON r.session_id=o.target_session_id
             AND r.start_command_id='followup:'||o.submission_id
           JOIN runtime_events e ON e.session_id=o.target_session_id
             AND json_extract(e.event_json,'$.type')='agent.followup_turn_settled'
             AND json_extract(e.event_json,'$.submissionId')=o.submission_id
             AND json_extract(e.event_json,'$.sourceSessionId')=o.source_session_id
             AND json_extract(e.event_json,'$.targetRunId')=r.run_id
             AND json_extract(e.event_json,'$.status') IN ('failed','cancelled')
           WHERE o.target_session_id=? AND o.source_session_id=? AND o.submission_id=?
             AND o.mode='trigger_turn'`,
        )
        .get(input.childSessionId, input.parentSessionId, input.submissionId);
  const route =
    persistedRoute ??
    (preDispatch
      ? {
          source_session_id: input.parentSessionId,
          message_id: preDispatch.message_id,
          route: 'new_turn',
          target_run_id: preDispatch.target_run_id,
          task_id: preDispatch.task_id,
          invocation_id: preDispatch.event_id,
        }
      : null);
  if (preDispatch && (!preDispatch.task_id || !preDispatch.event_id)) invalidSource();
  if (route?.source_session_id !== input.parentSessionId) invalidSource();
  if (route.route === 'current_turn') return acceptCurrentTurnTerminalReply(database, input, route);
  if (route.route !== 'new_turn') invalidSource();
  const submitted = database
    .query<
      {
        target_session_id: string;
        submission_id: string | null;
        mode: string;
        source_run_id: string;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
      },
      [string, string]
    >(
      `SELECT target_session_id,submission_id,mode,source_run_id,
       followup_admission_artifact_id,followup_admission_digest FROM agent_mail_outbox
       WHERE source_session_id=? AND message_id=?`,
    )
    .get(input.parentSessionId, route.message_id);
  if (
    submitted?.target_session_id !== input.childSessionId ||
    submitted.submission_id !== input.submissionId ||
    submitted.mode !== 'trigger_turn'
  )
    invalidSource();
  if (
    preDispatch &&
    (!submitted.followup_admission_artifact_id || !submitted.followup_admission_digest)
  )
    invalidSource();
  const legacyFunding = database
    .query<
      {
        target_session_id: string;
        message_id: string;
        target_run_id: string;
        funding_run_id: string;
        model_invocation_id: string;
        turn_reservation_id: string;
        model_reservation_id: string;
        terminal_disposition: string | null;
        terminal_target_revision: number | null;
        terminal_source_revision: number | null;
        terminal_evidence_digest: string | null;
      },
      [string, string]
    >(
      `SELECT target_session_id,message_id,target_run_id,funding_run_id,model_invocation_id,
       turn_reservation_id,model_reservation_id,
       terminal_disposition,terminal_target_revision,terminal_source_revision,
       terminal_evidence_digest FROM agent_followup_funding_receipts
       WHERE source_session_id=? AND submission_id=?`,
    )
    .get(input.parentSessionId, input.submissionId);
  const independentAudits = legacyFunding
    ? []
    : database
        .query<{ sequence: number; event_json: string }, [string, string]>(
          `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
           AND json_extract(event_json,'$.type')='agent.followup_independent_settled'
           AND json_extract(event_json,'$.submissionId')=?`,
        )
        .all(input.parentSessionId, input.submissionId);
  if (!legacyFunding && independentAudits.length !== 1) invalidSource();
  const independent = independentAudits[0];
  const audit = independent
    ? (JSON.parse(independent.event_json) as Record<string, unknown>)
    : null;
  if (
    audit &&
    (audit.targetAgentId !== input.childSessionId ||
      audit.targetRunId !== route.target_run_id ||
      !Number.isSafeInteger(audit.targetRevision) ||
      !Number.isSafeInteger(independent?.sequence) ||
      !/^sha256:[a-f0-9]{64}$/u.test(String(audit.evidenceDigest)))
  )
    invalidSource();
  const funding =
    legacyFunding ??
    (audit && independent
      ? {
          target_session_id: input.childSessionId,
          message_id: route.message_id,
          target_run_id: route.target_run_id,
          funding_run_id: submitted.source_run_id,
          model_invocation_id: route.invocation_id,
          turn_reservation_id: '',
          model_reservation_id: '',
          terminal_disposition: String(audit.disposition),
          terminal_target_revision: Number(audit.targetRevision),
          terminal_source_revision: independent.sequence,
          terminal_evidence_digest: String(audit.evidenceDigest),
        }
      : null);
  const parent = database
    .query<{ revision: number }, [string]>(
      'SELECT revision FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.parentSessionId);
  if (
    funding?.target_session_id !== input.childSessionId ||
    funding.message_id !== route.message_id ||
    funding.target_run_id !== route.target_run_id ||
    funding.funding_run_id !== submitted.source_run_id ||
    funding.model_invocation_id !== route.invocation_id ||
    !['completed', 'unknown', 'pre_dispatch_released'].includes(
      String(funding.terminal_disposition),
    ) ||
    !funding.terminal_target_revision ||
    !funding.terminal_source_revision ||
    !funding.terminal_evidence_digest ||
    child.revision < funding.terminal_target_revision ||
    !parent ||
    parent.revision < funding.terminal_source_revision
  )
    invalidSource();
  const currentChildSnapshot = database
    .query<{ revision: number; state_json: string }, [string]>(
      'SELECT revision,state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(input.childSessionId);
  if (
    !currentChildSnapshot ||
    currentChildSnapshot.revision !== child.revision ||
    (currentChildSnapshot.revision === funding.terminal_target_revision &&
      `sha256:${createHash('sha256').update(currentChildSnapshot.state_json).digest('hex')}` !==
        funding.terminal_evidence_digest)
  )
    invalidSource();
  const settledRows = database
    .query<{ event_id: string; sequence: number; event_json: string }, [string, string]>(
      `SELECT event_id,sequence,event_json FROM runtime_events
       WHERE session_id=? AND json_extract(event_json,'$.type')='agent.followup_turn_settled'
       AND json_extract(event_json,'$.submissionId')=?`,
    )
    .all(input.childSessionId, input.submissionId);
  if (settledRows.length !== 1) invalidSource();
  const settledRow = settledRows[0]!;
  const settled = JSON.parse(settledRow.event_json) as Record<string, unknown>;
  const status = settled.status;
  const completed = funding.terminal_disposition === 'completed' && status === 'completed';
  const uncertain =
    independent && funding.terminal_disposition === 'unknown' && status === 'unknown';
  const released =
    funding.terminal_disposition === 'pre_dispatch_released' &&
    (status === 'failed' || status === 'cancelled');
  if (
    settledRow.sequence !== funding.terminal_target_revision ||
    settled.sourceSessionId !== input.parentSessionId ||
    settled.submissionId !== input.submissionId ||
    settled.targetRunId !== route.target_run_id ||
    settled.taskId !== route.task_id ||
    (!completed && !uncertain && !released)
  )
    invalidSource();
  const run = database
    .query<
      {
        status: string;
        start_command_id: string;
        origin_session_id: string | null;
        origin_run_id: string | null;
        last_revision: number;
      },
      [string, string]
    >(
      `SELECT status,start_command_id,origin_session_id,origin_run_id,last_revision FROM runtime_runs
       WHERE session_id=? AND run_id=?`,
    )
    .get(input.childSessionId, route.target_run_id);
  if (
    run?.status !== status ||
    run.start_command_id !== `followup:${input.submissionId}` ||
    run.origin_session_id !== null ||
    run.origin_run_id !== null ||
    run.last_revision > settledRow.sequence
  )
    invalidSource();
  if (released && !independent) {
    const releases = database
      .query<{ reservation_id: string }, [string, number, string, string]>(
        `SELECT json_extract(event_json,'$.reservationId') AS reservation_id
         FROM runtime_events WHERE session_id=? AND sequence<=?
           AND json_extract(event_json,'$.type')='resource_budget.released'
           AND json_extract(event_json,'$.proof')='local_pre_dispatch_failure'
           AND json_extract(event_json,'$.reservationId') IN (?,?)`,
      )
      .all(
        input.parentSessionId,
        funding.terminal_source_revision!,
        funding.turn_reservation_id,
        funding.model_reservation_id,
      );
    const attempts = database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
         AND json_extract(event_json,'$.type')='model.invocation_attempt_started'
         AND json_extract(event_json,'$.invocationId')=?`,
      )
      .get(input.childSessionId, route.invocation_id)?.count;
    if (
      funding.turn_reservation_id === funding.model_reservation_id ||
      releases.length !== 2 ||
      new Set(releases.map((row) => row.reservation_id)).size !== 2 ||
      attempts !== 0
    )
      invalidSource();
  }
  const checkpointRows = completed
    ? database
        .query<
          { canonical_json: string; byte_length: number; integrity_identifier: string },
          [string, string, number]
        >(
          `SELECT canonical_json,byte_length,integrity_identifier FROM subagent_checkpoint_artifacts
       WHERE json_extract(canonical_json,'$.childSessionId')=?
         AND json_extract(canonical_json,'$.submissionId')=?
         AND json_extract(canonical_json,'$.terminalRevision')=?`,
        )
        .all(input.childSessionId, input.submissionId, settledRow.sequence)
    : [];
  if (completed) {
    if (checkpointRows.length !== 1) invalidSource();
    const checkpointRow = checkpointRows[0]!;
    const checkpoint = JSON.parse(checkpointRow.canonical_json) as Record<string, unknown>;
    if (
      checkpoint.artifactFormatVersion !== 1 ||
      checkpoint.terminalRunId !== route.target_run_id ||
      checkpoint.terminalTaskId !== route.task_id ||
      checkpoint.terminalStatus !== 'completed' ||
      checkpoint.stateDigest !== funding.terminal_evidence_digest ||
      Buffer.byteLength(checkpointRow.canonical_json, 'utf8') !== checkpointRow.byte_length ||
      `sha256:${createHash('sha256').update(checkpointRow.canonical_json).digest('hex')}` !==
        checkpointRow.integrity_identifier
    )
      invalidSource();
  }
  const identity = createHash('sha256')
    .update(JSON.stringify([input.childSessionId, input.submissionId, settledRow.event_id]))
    .digest('hex');
  const messageId = `followup-reply-${identity}`;
  const commandId = messageId;
  const bodyText = JSON.stringify({
    kind: 'agent_terminal_reply',
    taskId: route.task_id,
    status,
    taskReadHint: `Use task_read with task_id ${route.task_id} for the full result.`,
  });
  const byteLength = Buffer.byteLength(bodyText, 'utf8');
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) invalidSource();
  const bodyDigest = createHash('sha256').update(bodyText).digest('hex');
  const bodyId = `pa_${bodyDigest}`;
  const requestDigest = createHash('sha256')
    .update(
      JSON.stringify([
        input.childSessionId,
        input.submissionId,
        settledRow.event_id,
        settledRow.sequence,
        funding.terminal_evidence_digest,
      ]),
    )
    .digest('hex');
  const existing = readCrossSessionMail(database, input.childSessionId, messageId);
  if (existing) {
    if (
      existing.mode !== 'reply' ||
      existing.targetSessionId !== input.parentSessionId ||
      existing.commandId !== commandId ||
      existing.requestDigest !== requestDigest ||
      existing.sourceRunId !== route.target_run_id ||
      existing.sourceTurnId !== route.target_run_id ||
      existing.sourceModelInvocationId !== route.invocation_id ||
      existing.sourceToolCallId !== settledRow.event_id ||
      existing.sourceEffectAttemptId !== input.submissionId ||
      existing.sourceTaskId !== route.task_id ||
      existing.sourceGrantId !== null ||
      existing.sourceGrantDigest !== null ||
      existing.sourceRevision !== settledRow.sequence ||
      existing.bodyRef.artifactId !== bodyId
    )
      conflict();
    return existing;
  }
  const target = database
    .query<{ status: string; current_task_id: string | null }, [string]>(
      'SELECT status,current_task_id FROM agent_nodes WHERE session_id=? AND agent_id=session_id',
    )
    .get(input.parentSessionId);
  if (!target || target.status === 'context_unavailable') unavailable();
  const activeTargetRun =
    target.status === 'active' && target.current_task_id
      ? database
          .query<{ run_id: string }, [string, string]>(
            "SELECT run_id FROM runtime_runs WHERE session_id=? AND run_id=? AND status IN ('running','waiting')",
          )
          .get(input.parentSessionId, target.current_task_id)
      : null;
  const duplicateCommand = database
    .query<{ message_id: string }, [string, string]>(
      'SELECT message_id FROM agent_mail_outbox WHERE source_session_id=? AND command_id=?',
    )
    .get(input.childSessionId, commandId);
  if (duplicateCommand) conflict();
  database
    .query(`INSERT OR IGNORE INTO agent_mail_bodies
      (session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms)
      VALUES (?,?,?,?,?,?)`)
    .run(
      input.childSessionId,
      bodyId,
      `sha256:${bodyDigest}`,
      byteLength,
      bodyText,
      input.acceptedAtMs,
    );
  const body = database
    .query<
      { integrity_identifier: string; byte_length: number; body_text: string },
      [string, string]
    >(
      `SELECT integrity_identifier,byte_length,body_text FROM agent_mail_bodies
       WHERE session_id=? AND body_id=?`,
    )
    .get(input.childSessionId, bodyId);
  if (
    body?.integrity_identifier !== `sha256:${bodyDigest}` ||
    body.byte_length !== byteLength ||
    body.body_text !== bodyText
  )
    conflict();
  database
    .query(`INSERT INTO agent_mail_outbox
      (source_session_id,message_id,target_session_id,target_run_id,command_id,request_digest,
       source_run_id,source_turn_id,source_model_invocation_id,source_tool_call_id,
       source_effect_attempt_id,source_task_id,source_grant_id,source_grant_digest,
       mode,body_id,source_sequence,source_revision,accepted_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reply',?,?,?,?)`)
    .run(
      input.childSessionId,
      messageId,
      input.parentSessionId,
      activeTargetRun?.run_id ?? null,
      commandId,
      requestDigest,
      route.target_run_id,
      route.target_run_id,
      route.invocation_id,
      settledRow.event_id,
      input.submissionId,
      route.task_id,
      null,
      null,
      bodyId,
      nextCrossSessionSourceSequence(database, input.childSessionId),
      settledRow.sequence,
      input.acceptedAtMs,
    );
  return readCrossSessionMail(database, input.childSessionId, messageId)!;
}

function acceptCurrentTurnTerminalReply(
  database: Database,
  input: CrossSessionFollowupTerminalReplyIntent,
  route: Readonly<{
    source_session_id: string;
    message_id: string;
    route: string;
    target_run_id: string;
    task_id: string;
    invocation_id: string;
  }>,
): CrossSessionMailOutboxRecord {
  const submitted = database
    .query<
      {
        target_session_id: string;
        source_run_id: string;
        mode: string;
        submission_id: string | null;
        followup_admission_artifact_id: string | null;
        current_turn_release_source_revision: number | null;
        current_turn_release_target_revision: number | null;
      },
      [string, string]
    >(
      `SELECT target_session_id,source_run_id,mode,submission_id,followup_admission_artifact_id,
       current_turn_release_source_revision,current_turn_release_target_revision
       FROM agent_mail_outbox WHERE source_session_id=? AND message_id=?`,
    )
    .get(input.parentSessionId, route.message_id);
  const admission = submitted?.followup_admission_artifact_id
    ? database
        .query<{ canonical_json: string }, [string]>(
          'SELECT canonical_json FROM agent_followup_admission_artifacts WHERE artifact_id=?',
        )
        .get(submitted.followup_admission_artifact_id)
    : null;
  const admissionPayload = admission ? JSON.parse(admission.canonical_json) : null;
  const source = database
    .query<{ revision: number }, [string]>(
      'SELECT revision FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.parentSessionId);
  const sourceRelease = database
    .query<{ event_json: string }, [string, number]>(
      `SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=?
       AND json_extract(event_json,'$.type')='resource_budget.released'`,
    )
    .get(input.parentSessionId, submitted?.current_turn_release_source_revision ?? -1);
  const releaseEvent = sourceRelease ? JSON.parse(sourceRelease.event_json) : null;
  const intent = database
    .query<
      {
        disposition: string;
        parent_invocation_id: string;
        origin_run_id: string;
        origin_tool_call_id: string;
        attempt: number;
        child_invocation_id: string;
        child_budget_activated_run_id: string | null;
        parent_claim_settled_event_id: string | null;
      },
      [string]
    >(
      `SELECT disposition,parent_invocation_id,origin_run_id,origin_tool_call_id,attempt,
       child_invocation_id,child_budget_activated_run_id,
       parent_claim_settled_event_id FROM child_session_intents WHERE child_thread_id=?`,
    )
    .get(input.childSessionId);
  const inbox = database
    .query<
      {
        source_session_id: string;
        target_run_id: string | null;
        prepared_invocation_id: string | null;
        prepared_model_admission_id: string | null;
      },
      [string, string]
    >(
      `SELECT source_session_id,target_run_id,prepared_invocation_id,prepared_model_admission_id
       FROM agent_mail_inbox WHERE target_session_id=? AND message_id=?`,
    )
    .get(input.childSessionId, route.message_id);
  const routed = database
    .query<{ sequence: number; event_json: string }, [string, string]>(
      `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='agent.followup_routed'
       AND json_extract(event_json,'$.submissionId')=?`,
    )
    .all(input.childSessionId, input.submissionId);
  const prepared = database
    .query<{ sequence: number; event_json: string }, [string]>(
      `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='agent.mail_input_prepared'`,
    )
    .all(input.childSessionId);
  const seals = database
    .query<{ sequence: number; event_json: string }, [string]>(
      `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='subagent.child_terminal_sealed'`,
    )
    .all(input.childSessionId);
  const settledRows = database
    .query<{ event_id: string; sequence: number; event_json: string }, [string, string]>(
      `SELECT event_id,sequence,event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='agent.followup_turn_settled'
       AND json_extract(event_json,'$.submissionId')=?`,
    )
    .all(input.childSessionId, input.submissionId);
  const run = database
    .query<{ status: string; start_command_id: string }, [string, string]>(
      'SELECT status,start_command_id FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.childSessionId, route.target_run_id);
  const child = database
    .query<{ revision: number; state_json: string }, [string]>(
      'SELECT revision,state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(input.childSessionId);
  const routedEvent = routed.length === 1 ? JSON.parse(routed[0]!.event_json) : null;
  const preparedEvents = prepared
    .map((row) => ({ sequence: row.sequence, event: JSON.parse(row.event_json) }))
    .filter((row) => row.event.messageIds?.includes(route.message_id));
  const seal = seals.length === 1 ? JSON.parse(seals[0]!.event_json) : null;
  const settledRow = settledRows.length === 1 ? settledRows[0]! : null;
  const settled = settledRow ? JSON.parse(settledRow.event_json) : null;
  const childState = child ? JSON.parse(child.state_json) : null;
  const terminal = childState?.childSessionOrigin?.terminal;
  const originRun = intent
    ? database
        .query<{ status: string }, [string, string]>(
          'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
        )
        .get(input.parentSessionId, intent.origin_run_id)
    : null;
  const sourceRun = submitted
    ? database
        .query<{ status: string }, [string, string]>(
          'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
        )
        .get(input.parentSessionId, submitted.source_run_id)
    : null;
  const imports = intent
    ? database
        .query<{ sequence: number; event_json: string }, [string, string]>(
          `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
           AND json_extract(event_json,'$.type')='subagent.child_terminal_imported'
           AND json_extract(event_json,'$.childThreadId')=?`,
        )
        .all(input.parentSessionId, input.childSessionId)
    : [];
  const backgroundResults = intent
    ? database
        .query<{ sequence: number; event_json: string }, [string, string]>(
          `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
           AND json_extract(event_json,'$.type')='subagent.background_result_persisted'
           AND json_extract(event_json,'$.taskId')=?`,
        )
        .all(input.parentSessionId, route.task_id)
    : [];
  const imported = imports.length === 1 ? JSON.parse(imports[0]!.event_json) : null;
  const backgroundResult =
    backgroundResults.length === 1 ? JSON.parse(backgroundResults[0]!.event_json) : null;
  const afterTurnResultProven =
    intent?.disposition === 'after_turn' &&
    sourceRun !== null &&
    (originRun?.status === 'completed' || submitted?.source_run_id !== intent.origin_run_id) &&
    imported?.parentInvocationId === intent.parent_invocation_id &&
    imported.childInvocationId === intent.child_invocation_id &&
    imported.childThreadId === input.childSessionId &&
    imported.terminalRevision === seals[0]?.sequence &&
    imported.status === seal?.status &&
    imported.resultRef?.integrityIdentifier === seal?.resultRef?.integrityIdentifier &&
    backgroundResult?.taskId === intent.child_invocation_id &&
    backgroundResult.originRunId === intent.origin_run_id &&
    backgroundResult.originToolCallId === intent.origin_tool_call_id &&
    backgroundResult.attempt === intent.attempt &&
    backgroundResult.childTerminalStatus === seal?.status &&
    backgroundResult.artifactIntegrityIdentifier === seal?.resultRef?.integrityIdentifier &&
    imports[0]!.sequence < backgroundResults[0]!.sequence;
  const status =
    seal?.status === 'completed'
      ? 'completed'
      : seal?.status === 'cancelled'
        ? 'cancelled'
        : seal?.status === 'unknown'
          ? 'unknown'
          : 'failed';
  const runStatus =
    run?.status === 'completed'
      ? 'completed'
      : run?.status === 'cancelled'
        ? 'cancelled'
        : run?.status === 'unknown'
          ? 'unknown'
          : 'failed';
  if (
    submitted?.target_session_id !== input.childSessionId ||
    submitted.mode !== 'trigger_turn' ||
    submitted.submission_id !== input.submissionId ||
    !submitted.current_turn_release_source_revision ||
    !submitted.current_turn_release_target_revision ||
    !source ||
    source.revision < submitted.current_turn_release_source_revision ||
    !admissionPayload ||
    admissionPayload.fundingRunId !== submitted.source_run_id ||
    typeof admissionPayload.backupReservationId !== 'string' ||
    releaseEvent?.reservationId !== admissionPayload.backupReservationId ||
    intent?.child_invocation_id !== route.task_id ||
    intent.child_budget_activated_run_id !== route.target_run_id ||
    (intent.disposition === 'required'
      ? !intent.parent_claim_settled_event_id
      : !afterTurnResultProven) ||
    inbox?.source_session_id !== input.parentSessionId ||
    inbox.target_run_id !== route.target_run_id ||
    inbox.prepared_invocation_id !== route.invocation_id ||
    routedEvent?.route !== 'current_turn' ||
    routedEvent.submissionId !== input.submissionId ||
    routedEvent.taskId !== route.task_id ||
    routedEvent.invocationId !== route.invocation_id ||
    routed[0]!.sequence >= submitted.current_turn_release_target_revision ||
    preparedEvents.length !== 1 ||
    preparedEvents[0]!.event.invocationId !== route.invocation_id ||
    preparedEvents[0]!.event.modelAdmissionId !== inbox.prepared_model_admission_id ||
    preparedEvents[0]!.sequence !== submitted.current_turn_release_target_revision ||
    !seal ||
    preparedEvents[0]!.sequence > seals[0]!.sequence ||
    !settledRow ||
    settled.sourceSessionId !== input.parentSessionId ||
    settled.targetRunId !== route.target_run_id ||
    settled.taskId !== route.task_id ||
    settled.status !== status ||
    settledRow.sequence <= seals[0]!.sequence ||
    terminal?.sealedRevision !== seals[0]!.sequence ||
    terminal.status !== seal.status ||
    terminal.resultRef?.integrityIdentifier !== seal.resultRef?.integrityIdentifier ||
    child!.revision < settledRow.sequence ||
    !run ||
    runStatus !== status ||
    run.start_command_id.startsWith('followup:') ||
    !['completed', 'failed', 'cancelled', 'unknown'].includes(status)
  )
    invalidSource();
  const identity = createHash('sha256')
    .update(JSON.stringify([input.childSessionId, input.submissionId, settledRow.event_id]))
    .digest('hex');
  const messageId = `followup-reply-${identity}`;
  const bodyText = JSON.stringify({
    kind: 'agent_terminal_reply',
    taskId: route.task_id,
    status,
    taskReadHint: `Use task_read with task_id ${route.task_id} for the full result.`,
  });
  const bodyDigest = createHash('sha256').update(bodyText).digest('hex');
  const bodyId = `pa_${bodyDigest}`;
  const requestDigest = createHash('sha256')
    .update(
      JSON.stringify([
        input.childSessionId,
        input.submissionId,
        settledRow.event_id,
        seal.resultRef,
      ]),
    )
    .digest('hex');
  const existing = readCrossSessionMail(database, input.childSessionId, messageId);
  if (existing) {
    if (
      existing.mode !== 'reply' ||
      existing.targetSessionId !== input.parentSessionId ||
      existing.commandId !== messageId ||
      existing.requestDigest !== requestDigest ||
      existing.sourceRunId !== route.target_run_id ||
      existing.sourceTurnId !== route.target_run_id ||
      existing.sourceModelInvocationId !== route.invocation_id ||
      existing.sourceToolCallId !== settledRow.event_id ||
      existing.sourceEffectAttemptId !== input.submissionId ||
      existing.sourceTaskId !== route.task_id ||
      existing.sourceRevision !== settledRow.sequence ||
      existing.bodyRef.artifactId !== bodyId
    )
      conflict();
    return existing;
  }
  const target = database
    .query<{ status: string; current_task_id: string | null }, [string]>(
      'SELECT status,current_task_id FROM agent_nodes WHERE session_id=? AND agent_id=session_id',
    )
    .get(input.parentSessionId);
  if (!target || target.status === 'context_unavailable') unavailable();
  const activeTargetRun =
    target.status === 'active' && target.current_task_id
      ? database
          .query<{ run_id: string }, [string, string]>(
            "SELECT run_id FROM runtime_runs WHERE session_id=? AND run_id=? AND status IN ('running','waiting')",
          )
          .get(input.parentSessionId, target.current_task_id)
      : null;
  database
    .query(`INSERT OR IGNORE INTO agent_mail_bodies
      (session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms)
      VALUES (?,?,?,?,?,?)`)
    .run(
      input.childSessionId,
      bodyId,
      `sha256:${bodyDigest}`,
      Buffer.byteLength(bodyText),
      bodyText,
      input.acceptedAtMs,
    );
  database
    .query(`INSERT INTO agent_mail_outbox
      (source_session_id,message_id,target_session_id,target_run_id,command_id,request_digest,
       source_run_id,source_turn_id,source_model_invocation_id,source_tool_call_id,
       source_effect_attempt_id,source_task_id,source_grant_id,source_grant_digest,
       mode,body_id,source_sequence,source_revision,accepted_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reply',?,?,?,?)`)
    .run(
      input.childSessionId,
      messageId,
      input.parentSessionId,
      activeTargetRun?.run_id ?? null,
      messageId,
      requestDigest,
      route.target_run_id,
      route.target_run_id,
      route.invocation_id,
      settledRow.event_id,
      input.submissionId,
      route.task_id,
      null,
      null,
      bodyId,
      nextCrossSessionSourceSequence(database, input.childSessionId),
      settledRow.sequence,
      input.acceptedAtMs,
    );
  return readCrossSessionMail(database, input.childSessionId, messageId)!;
}

export interface CrossSessionAcceptedReleaseNoticeIntent {
  readonly childSessionId: string;
  readonly parentSessionId: string;
  readonly submissionId: string;
  readonly acceptedAtMs: number;
}

/** Source release proves non-dispatch; this low-trust notice never claims a child result. */
export function acceptCrossSessionAcceptedReleaseNoticeInTransaction(
  database: Database,
  input: CrossSessionAcceptedReleaseNoticeIntent,
): CrossSessionMailOutboxRecord {
  requireTransaction(database);
  if (
    !input.childSessionId ||
    !input.parentSessionId ||
    !input.submissionId ||
    !Number.isSafeInteger(input.acceptedAtMs) ||
    input.acceptedAtMs < 0
  )
    invalidSource();
  const child = database
    .query<{ parent_session_id: string | null }, [string]>(
      'SELECT parent_session_id FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.childSessionId);
  if (child?.parent_session_id !== input.parentSessionId) invalidSource();
  assertPair(database, input.childSessionId, input.parentSessionId);
  const original = database
    .query<
      {
        message_id: string;
        target_session_id: string;
        source_run_id: string;
        source_turn_id: string;
        source_revision: number;
        mode: string;
        accepted_release_source_revision: number | null;
        accepted_release_reason: string | null;
        accepted_release_evidence_digest: string | null;
        accepted_released_at_ms: number | null;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
      },
      [string, string]
    >(
      `SELECT message_id,target_session_id,source_run_id,source_turn_id,source_revision,mode,
       accepted_release_source_revision,accepted_release_reason,accepted_release_evidence_digest,
       accepted_released_at_ms,followup_admission_artifact_id,followup_admission_digest
       FROM agent_mail_outbox
       WHERE source_session_id=? AND submission_id=?`,
    )
    .get(input.parentSessionId, input.submissionId);
  const reason = original?.accepted_release_reason;
  if (
    original?.target_session_id !== input.childSessionId ||
    original.mode !== 'trigger_turn' ||
    !original.accepted_release_source_revision ||
    !original.accepted_release_evidence_digest ||
    ![
      'tool_failed',
      'expired',
      'context_unavailable',
      'authorization_changed',
      'capacity_timeout',
      'source_cancelled',
    ].includes(String(reason))
  )
    invalidSource();
  const admissionRow = database
    .query<{ canonical_json: string; integrity_identifier: string; byte_length: number }, [string]>(
      `SELECT canonical_json,integrity_identifier,byte_length
       FROM agent_followup_admission_artifacts WHERE artifact_id=?`,
    )
    .get(original.followup_admission_artifact_id ?? '');
  const admission = admissionRow
    ? (JSON.parse(admissionRow.canonical_json) as Record<string, unknown>)
    : null;
  const admissionDigest = admissionRow
    ? `sha256:${createHash('sha256').update(admissionRow.canonical_json).digest('hex')}`
    : null;
  if (
    !admission ||
    (admission.schema !== 'kite.cross-session-followup-admission.v1' &&
      (admission.schema !== 'kite.cross-session-followup-admission.v2' ||
        (admission.policy as Record<string, unknown> | undefined)?.executionMode !==
          'independent_turn_v2')) ||
    admission.messageId !== original.message_id ||
    admission.submissionId !== input.submissionId ||
    admission.sourceSessionId !== input.parentSessionId ||
    admission.targetSessionId !== input.childSessionId ||
    admission.fundingRunId !== original.source_run_id ||
    typeof admission.backupReservationId !== 'string' ||
    !admission.backupReservationId ||
    admissionDigest !== original.followup_admission_digest ||
    admissionRow?.integrity_identifier !== admissionDigest ||
    admissionRow.byte_length !== Buffer.byteLength(admissionRow.canonical_json, 'utf8') ||
    original.followup_admission_artifact_id !== `pa_${admissionDigest.slice(7)}`
  )
    invalidSource();
  const releases = database
    .query<
      { event_id: string; sequence: number; event_json: string },
      [string, number, number, string]
    >(
      `SELECT event_id,sequence,event_json FROM runtime_events
       WHERE session_id=? AND sequence>? AND sequence<=?
         AND json_extract(event_json,'$.type')='resource_budget.released'
         AND json_extract(event_json,'$.reservationId')=?`,
    )
    .all(
      input.parentSessionId,
      original.source_revision,
      original.accepted_release_source_revision,
      admission.backupReservationId,
    );
  const release =
    reason === 'source_cancelled'
      ? releases.length === 1
        ? releases[0]
        : null
      : releases.find((row) => row.sequence === original.accepted_release_source_revision);
  const releaseEvent = release ? (JSON.parse(release.event_json) as Record<string, unknown>) : null;
  if (
    !release ||
    (reason !== 'source_cancelled' &&
      releases.filter((row) => row.sequence === release.sequence).length !== 1) ||
    releaseEvent?.type !== 'resource_budget.released' ||
    releaseEvent.reservationId !== admission.backupReservationId ||
    releaseEvent.proof !== undefined
  )
    invalidSource();
  if (reason === 'source_cancelled') {
    const cancelledRun = database
      .query<{ status: string; finished_at_ms: number | null }, [string, string]>(
        'SELECT status,finished_at_ms FROM runtime_runs WHERE session_id=? AND run_id=?',
      )
      .get(input.parentSessionId, original.source_run_id);
    const userAbort = database
      .query<{ count: number }, [string, number, number, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
         AND sequence>? AND sequence<=?
         AND json_extract(event_json,'$.type')='turn.aborted'
         AND json_extract(event_json,'$.turnId')=?
         AND json_extract(event_json,'$.cause')='user'`,
      )
      .get(
        input.parentSessionId,
        release.sequence,
        original.accepted_release_source_revision,
        original.source_turn_id,
      )?.count;
    if (
      cancelledRun?.status !== 'cancelled' ||
      cancelledRun.finished_at_ms !== original.accepted_released_at_ms ||
      userAbort !== 1
    )
      invalidSource();
  }
  const parent = database
    .query<{ revision: number }, [string]>(
      'SELECT revision FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.parentSessionId);
  if (!parent || parent.revision < original.accepted_release_source_revision) invalidSource();
  const snapshot = database
    .query<{ revision: number; state_json: string }, [string]>(
      'SELECT revision,state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(input.parentSessionId);
  if (
    !snapshot ||
    snapshot.revision !== parent.revision ||
    (snapshot.revision === original.accepted_release_source_revision &&
      `sha256:${createHash('sha256').update(snapshot.state_json).digest('hex')}` !==
        original.accepted_release_evidence_digest)
  )
    invalidSource();
  const disallowed = database
    .query<{ count: number }, [string, string, string, string]>(
      `SELECT
       (SELECT count(*) FROM agent_followup_funding_receipts
         WHERE source_session_id=? AND submission_id=?) +
       (SELECT count(*) FROM agent_followup_routes
         WHERE target_session_id=? AND submission_id=?) AS count`,
    )
    .get(
      input.parentSessionId,
      input.submissionId,
      input.childSessionId,
      input.submissionId,
    )?.count;
  if (disallowed !== 0) invalidSource();
  const started = database
    .query<{ run_id: string }, [string, string]>(
      'SELECT run_id FROM runtime_runs WHERE session_id=? AND start_command_id=?',
    )
    .get(input.childSessionId, `followup:${input.submissionId}`);
  if (
    started &&
    (reason !== 'expired' ||
      readProvenUnfundedExpiredFollowupRelease(
        database,
        input.parentSessionId,
        input.childSessionId,
        input.submissionId,
      )?.targetRunId !== started.run_id)
  )
    invalidSource();
  const childRunId = database
    .query<{ child_budget_activated_run_id: string | null }, [string, string]>(
      `SELECT child_budget_activated_run_id FROM child_session_intents
       WHERE child_thread_id=? AND parent_session_id=?`,
    )
    .get(input.childSessionId, input.parentSessionId)?.child_budget_activated_run_id;
  if (!childRunId) invalidSource();
  const childRun = database
    .query<{ status: string; last_revision: number }, [string, string]>(
      'SELECT status,last_revision FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.childSessionId, childRunId);
  if (childRun?.status !== 'completed' || childRun.last_revision < 1) invalidSource();
  const identity = createHash('sha256')
    .update(
      JSON.stringify([
        input.parentSessionId,
        input.submissionId,
        original.accepted_release_source_revision,
      ]),
    )
    .digest('hex');
  const messageId = `accepted-release-notice-${identity}`;
  const bodyText = JSON.stringify({
    kind: 'agent_followup_not_dispatched',
    submissionId: input.submissionId,
    status: reason === 'source_cancelled' ? 'cancelled' : 'failed',
    reason,
  });
  const byteLength = Buffer.byteLength(bodyText, 'utf8');
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) invalidSource();
  const bodyDigest = createHash('sha256').update(bodyText).digest('hex');
  const bodyId = `pa_${bodyDigest}`;
  const requestDigest = createHash('sha256')
    .update(
      JSON.stringify([
        input.parentSessionId,
        input.submissionId,
        original.accepted_release_source_revision,
        reason,
        original.accepted_release_evidence_digest,
      ]),
    )
    .digest('hex');
  const existing = readCrossSessionMail(database, input.childSessionId, messageId);
  if (existing) {
    if (
      existing.mode !== 'reply' ||
      existing.targetSessionId !== input.parentSessionId ||
      existing.commandId !== messageId ||
      existing.requestDigest !== requestDigest ||
      existing.sourceRunId !== childRunId ||
      existing.sourceTurnId !== childRunId ||
      existing.sourceModelInvocationId !== release!.event_id ||
      existing.sourceToolCallId !== release!.event_id ||
      existing.sourceEffectAttemptId !== input.submissionId ||
      existing.sourceTaskId !== null ||
      existing.sourceGrantId !== null ||
      existing.sourceGrantDigest !== null ||
      existing.sourceRevision !== childRun.last_revision ||
      existing.bodyRef.artifactId !== bodyId
    )
      conflict();
    return existing;
  }
  const node = database
    .query<{ status: string; current_task_id: string | null }, [string]>(
      'SELECT status,current_task_id FROM agent_nodes WHERE session_id=? AND agent_id=session_id',
    )
    .get(input.parentSessionId);
  if (!node || node.status === 'context_unavailable') unavailable();
  const activeTargetRun =
    node.status === 'active' && node.current_task_id
      ? database
          .query<{ run_id: string }, [string, string]>(
            "SELECT run_id FROM runtime_runs WHERE session_id=? AND run_id=? AND status IN ('running','waiting')",
          )
          .get(input.parentSessionId, node.current_task_id)
      : null;
  const duplicateCommand = database
    .query<{ message_id: string }, [string, string]>(
      'SELECT message_id FROM agent_mail_outbox WHERE source_session_id=? AND command_id=?',
    )
    .get(input.childSessionId, messageId);
  if (duplicateCommand) conflict();
  database
    .query(`INSERT OR IGNORE INTO agent_mail_bodies
      (session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms)
      VALUES (?,?,?,?,?,?)`)
    .run(
      input.childSessionId,
      bodyId,
      `sha256:${bodyDigest}`,
      byteLength,
      bodyText,
      input.acceptedAtMs,
    );
  const body = database
    .query<
      { integrity_identifier: string; byte_length: number; body_text: string },
      [string, string]
    >(
      `SELECT integrity_identifier,byte_length,body_text FROM agent_mail_bodies
       WHERE session_id=? AND body_id=?`,
    )
    .get(input.childSessionId, bodyId);
  if (
    body?.integrity_identifier !== `sha256:${bodyDigest}` ||
    body.byte_length !== byteLength ||
    body.body_text !== bodyText
  )
    conflict();
  database
    .query(`INSERT INTO agent_mail_outbox
      (source_session_id,message_id,target_session_id,target_run_id,command_id,request_digest,
       source_run_id,source_turn_id,source_model_invocation_id,source_tool_call_id,
       source_effect_attempt_id,source_task_id,source_grant_id,source_grant_digest,
       mode,body_id,source_sequence,source_revision,accepted_at_ms)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'reply',?,?,?,?)`)
    .run(
      input.childSessionId,
      messageId,
      input.parentSessionId,
      activeTargetRun?.run_id ?? null,
      messageId,
      requestDigest,
      childRunId,
      childRunId,
      release!.event_id,
      release!.event_id,
      input.submissionId,
      null,
      null,
      null,
      bodyId,
      nextCrossSessionSourceSequence(database, input.childSessionId),
      childRun.last_revision,
      input.acceptedAtMs,
    );
  return readCrossSessionMail(database, input.childSessionId, messageId)!;
}

export interface CrossSessionMailOutboxRecord {
  readonly mode: 'queue_only' | 'trigger_turn' | 'reply';
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly messageId: string;
  readonly commandId: string;
  readonly requestDigest: string;
  readonly sourceRunId: string;
  readonly sourceTurnId: string;
  readonly sourceModelInvocationId: string;
  readonly sourceToolCallId: string;
  readonly sourceEffectAttemptId: string;
  readonly sourceTaskId: string | null;
  readonly sourceGrantId: string | null;
  readonly sourceGrantDigest: string | null;
  readonly targetRunId: string | null;
  readonly sourceSequence: number;
  readonly sourceRevision: number;
  readonly acceptedAtMs: number;
  readonly deliveredTargetRevision: number | null;
  readonly bodyRef: {
    readonly artifactId: string;
    readonly integrityIdentifier: string;
    readonly byteLength: number;
  };
}

type OutboxRow = {
  mode: 'queue_only' | 'trigger_turn' | 'reply';
  source_session_id: string;
  target_session_id: string;
  message_id: string;
  command_id: string;
  request_digest: string;
  source_run_id: string;
  source_turn_id: string;
  source_model_invocation_id: string;
  source_tool_call_id: string;
  source_effect_attempt_id: string;
  source_task_id: string | null;
  source_grant_id: string | null;
  source_grant_digest: string | null;
  target_run_id: string | null;
  source_sequence: number;
  source_revision: number;
  accepted_at_ms: number;
  delivered_target_revision: number | null;
  body_id: string;
  integrity_identifier: string;
  byte_length: number;
};

/** Only call from the fenced source Session transaction, after its exact command receipt exists. */
export function acceptCrossSessionQueueMailInTransaction(
  database: Database,
  input: CrossSessionMailIntent,
  allowContextUnavailableTarget = false,
): CrossSessionMailOutboxRecord {
  requireTransaction(database);
  if (
    !input.sourceSessionId ||
    !input.targetSessionId ||
    !input.messageId ||
    !input.commandId ||
    !input.sourceRunId ||
    !input.sourceTurnId ||
    !input.sourceModelInvocationId ||
    !input.sourceToolCallId ||
    !input.sourceEffectAttemptId ||
    (input.sourceTaskId !== undefined && !input.sourceTaskId) ||
    (input.sourceGrantId === undefined) !== (input.sourceGrantDigest === undefined) ||
    !HEX.test(input.requestDigest) ||
    !Number.isSafeInteger(input.sourceSequence) ||
    input.sourceSequence < 1 ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 1 ||
    !Number.isSafeInteger(input.acceptedAtMs) ||
    input.acceptedAtMs < 0
  )
    invalidSource();
  const byteLength = Buffer.byteLength(input.bodyText, 'utf8');
  if (!Number.isSafeInteger(byteLength) || byteLength < 1) invalidSource();
  const bodyDigest = createHash('sha256').update(input.bodyText).digest('hex');
  const bodyId = `pa_${bodyDigest}`;
  const existing = readCrossSessionMail(database, input.sourceSessionId, input.messageId);
  if (existing) {
    if (
      existing.targetSessionId !== input.targetSessionId ||
      existing.commandId !== input.commandId ||
      existing.requestDigest !== input.requestDigest ||
      existing.sourceRunId !== input.sourceRunId ||
      existing.sourceTurnId !== input.sourceTurnId ||
      existing.sourceModelInvocationId !== input.sourceModelInvocationId ||
      existing.sourceToolCallId !== input.sourceToolCallId ||
      existing.sourceEffectAttemptId !== input.sourceEffectAttemptId ||
      existing.sourceTaskId !== (input.sourceTaskId ?? null) ||
      existing.sourceGrantId !== (input.sourceGrantId ?? null) ||
      existing.sourceGrantDigest !== (input.sourceGrantDigest ?? null) ||
      existing.sourceSequence !== input.sourceSequence ||
      existing.sourceRevision !== input.sourceRevision ||
      existing.bodyRef.artifactId !== bodyId
    )
      conflict();
    return existing;
  }
  const conflictingCommand = database
    .query<{ message_id: string }, [string, string]>(
      'SELECT message_id FROM agent_mail_outbox WHERE source_session_id=? AND command_id=?',
    )
    .get(input.sourceSessionId, input.commandId);
  if (conflictingCommand) conflict();
  if (nextCrossSessionSourceSequence(database, input.sourceSessionId) !== input.sourceSequence)
    conflict();
  assertPair(database, input.sourceSessionId, input.targetSessionId);
  assertSourceGrant(database, input);
  const source = database
    .query<{ revision: number }, [string]>(
      'SELECT revision FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.sourceSessionId);
  if (source?.revision !== input.sourceRevision) invalidSource();
  const receipt = database
    .query<{ request_digest: string; committed_revision: number }, [string, string]>(
      `SELECT request_digest,committed_revision FROM runtime_command_receipts
     WHERE scope_session_id=? AND target_session_id=scope_session_id AND command_id=?`,
    )
    .get(input.sourceSessionId, input.commandId);
  if (
    receipt?.request_digest !== input.requestDigest ||
    receipt.committed_revision !== input.sourceRevision
  )
    invalidSource();
  const run = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.sourceSessionId, input.sourceRunId);
  if (!run || !['running', 'waiting'].includes(run.status)) invalidSource();
  const sender = database
    .query<{ status: string; current_task_id: string | null }, [string]>(
      'SELECT status,current_task_id FROM agent_nodes WHERE session_id=? AND agent_id=session_id',
    )
    .get(input.sourceSessionId);
  if (sender?.status !== 'active' || sender.current_task_id !== input.sourceRunId) invalidSource();
  const target = database
    .query<{ status: string; current_task_id: string | null }, [string]>(
      'SELECT status,current_task_id FROM agent_nodes WHERE session_id=? AND agent_id=session_id',
    )
    .get(input.targetSessionId);
  if (!target || (target.status === 'context_unavailable' && !allowContextUnavailableTarget))
    unavailable();
  const activeTargetRun =
    target.status === 'active' && target.current_task_id
      ? database
          .query<{ run_id: string }, [string, string]>(
            "SELECT run_id FROM runtime_runs WHERE session_id=? AND run_id=? AND status IN ('running','waiting')",
          )
          .get(input.targetSessionId, target.current_task_id)
      : null;
  const targetRunId = activeTargetRun?.run_id ?? null;

  database
    .query(`INSERT OR IGNORE INTO agent_mail_bodies
    (session_id,body_id,integrity_identifier,byte_length,body_text,created_at_ms)
    VALUES (?,?,?,?,?,?)`)
    .run(
      input.sourceSessionId,
      bodyId,
      `sha256:${bodyDigest}`,
      byteLength,
      input.bodyText,
      input.acceptedAtMs,
    );
  const body = database
    .query<
      {
        integrity_identifier: string;
        byte_length: number;
        body_text: string;
      },
      [string, string]
    >(`SELECT integrity_identifier,byte_length,body_text FROM agent_mail_bodies
    WHERE session_id=? AND body_id=?`)
    .get(input.sourceSessionId, bodyId);
  if (
    body?.body_text !== input.bodyText ||
    body.byte_length !== byteLength ||
    body.integrity_identifier !== `sha256:${bodyDigest}`
  )
    conflict();
  database
    .query(`INSERT INTO agent_mail_outbox
    (source_session_id,message_id,target_session_id,target_run_id,command_id,request_digest,source_run_id,
     source_turn_id,source_model_invocation_id,source_tool_call_id,source_effect_attempt_id,
     source_task_id,source_grant_id,source_grant_digest,mode,body_id,source_sequence,source_revision,accepted_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'queue_only',?,?,?,?)`)
    .run(
      input.sourceSessionId,
      input.messageId,
      input.targetSessionId,
      targetRunId,
      input.commandId,
      input.requestDigest,
      input.sourceRunId,
      input.sourceTurnId,
      input.sourceModelInvocationId,
      input.sourceToolCallId,
      input.sourceEffectAttemptId,
      input.sourceTaskId ?? null,
      input.sourceGrantId ?? null,
      input.sourceGrantDigest ?? null,
      bodyId,
      input.sourceSequence,
      input.sourceRevision,
      input.acceptedAtMs,
    );
  return readCrossSessionMail(database, input.sourceSessionId, input.messageId)!;
}

/** Receiver writes only to its own Session transaction; duplicate delivery returns its first receipt. */
export function receiveCrossSessionQueueMailInTransaction(
  database: Database,
  input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly messageId: string;
    readonly targetRevision: number;
    readonly receivedAtMs: number;
  },
  allowContextUnavailableTarget = false,
): { readonly sequence: number; readonly targetRevision: number } {
  requireTransaction(database);
  const outbox = readCrossSessionMail(database, input.sourceSessionId, input.messageId);
  if (!outbox || outbox.targetSessionId !== input.targetSessionId) invalidSource();
  assertPair(database, input.sourceSessionId, input.targetSessionId);
  const prior = database
    .query<
      {
        sequence: number;
        target_revision: number;
        source_session_id: string;
        target_run_id: string | null;
      },
      [string, string]
    >(
      `SELECT sequence,target_revision,source_session_id,target_run_id FROM agent_mail_inbox
     WHERE target_session_id=? AND message_id=?`,
    )
    .get(input.targetSessionId, input.messageId);
  if (prior) {
    const rerouted =
      outbox.mode === 'trigger_turn' &&
      database
        .query<{ target_run_id: string }, [string, string]>(
          `SELECT target_run_id FROM agent_followup_routes
       WHERE target_session_id=? AND message_id=? AND route='new_turn'`,
        )
        .get(input.targetSessionId, input.messageId)?.target_run_id === prior.target_run_id;
    if (
      prior.source_session_id !== input.sourceSessionId ||
      (prior.target_run_id !== outbox.targetRunId && !rerouted)
    )
      conflict();
    return { sequence: prior.sequence, targetRevision: prior.target_revision };
  }
  if (
    !Number.isSafeInteger(input.targetRevision) ||
    input.targetRevision < 1 ||
    !Number.isSafeInteger(input.receivedAtMs) ||
    input.receivedAtMs < 0
  )
    invalidSource();
  const target = database
    .query<{ revision: number }, [string]>(
      'SELECT revision FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.targetSessionId);
  if (target?.revision !== input.targetRevision) invalidSource();
  const node = database
    .query<{ status: string }, [string]>(
      'SELECT status FROM agent_nodes WHERE session_id=? AND agent_id=session_id',
    )
    .get(input.targetSessionId);
  if (!node || (node.status === 'context_unavailable' && !allowContextUnavailableTarget))
    unavailable();
  const sequence = nextCrossSessionTargetSequence(database, input.targetSessionId);
  database
    .query(`INSERT INTO agent_mail_inbox
    (target_session_id,message_id,source_session_id,target_run_id,sequence,target_revision,received_at_ms)
    VALUES (?,?,?,?,?,?,?)`)
    .run(
      input.targetSessionId,
      input.messageId,
      input.sourceSessionId,
      outbox.targetRunId,
      sequence,
      input.targetRevision,
      input.receivedAtMs,
    );
  return { sequence, targetRevision: input.targetRevision };
}

/** Confirmation may follow the target receipt; recovery trusts the inbox and repeats this step. */
export function confirmCrossSessionQueueMailInTransaction(
  database: Database,
  input: {
    readonly sourceSessionId: string;
    readonly messageId: string;
  },
): CrossSessionMailOutboxRecord {
  requireTransaction(database);
  const outbox = readCrossSessionMail(database, input.sourceSessionId, input.messageId);
  if (!outbox) invalidSource();
  const received = database
    .query<{ target_revision: number; source_session_id: string }, [string, string]>(
      `SELECT target_revision,source_session_id FROM agent_mail_inbox
     WHERE target_session_id=? AND message_id=?`,
    )
    .get(outbox.targetSessionId, input.messageId);
  if (!received || received.source_session_id !== input.sourceSessionId) invalidSource();
  if (
    outbox.deliveredTargetRevision !== null &&
    outbox.deliveredTargetRevision !== received.target_revision
  )
    conflict();
  database
    .query(`UPDATE agent_mail_outbox SET delivered_target_revision=?
    WHERE source_session_id=? AND message_id=? AND delivered_target_revision IS NULL`)
    .run(received.target_revision, input.sourceSessionId, input.messageId);
  return readCrossSessionMail(database, input.sourceSessionId, input.messageId)!;
}

/** Recovery cursor is stable by message ID; recheck target receipt before redelivery. */
export function listPendingCrossSessionQueueMail(
  database: Database,
  sourceSessionId: string,
  limit: number,
  afterMessageId?: string,
): readonly CrossSessionMailOutboxRecord[] {
  if (!sourceSessionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidSource();
  const rows = database
    .query<{ message_id: string }, (string | number)[]>(
      `SELECT message_id FROM agent_mail_outbox WHERE source_session_id=?
       AND mode='queue_only' AND delivered_target_revision IS NULL ${afterMessageId ? 'AND message_id>?' : ''}
     ORDER BY message_id LIMIT ?`,
    )
    .all(sourceSessionId, ...(afterMessageId ? [afterMessageId] : []), limit);
  return rows.map((row) => readCrossSessionMail(database, sourceSessionId, row.message_id)!);
}

/** Global startup index only identifies sources; delivery still requires each source owner. */
export function listPendingCrossSessionQueueMailSources(
  database: Database,
  limit: number,
  afterSessionId?: string,
): readonly string[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (afterSessionId !== undefined && afterSessionId.length === 0)
  )
    invalidSource();
  return database
    .query<{ source_session_id: string }, (string | number)[]>(
      `SELECT DISTINCT source_session_id FROM agent_mail_outbox
       WHERE mode='queue_only' AND delivered_target_revision IS NULL ${afterSessionId ? 'AND source_session_id>?' : ''}
       ORDER BY source_session_id LIMIT ?`,
    )
    .all(...(afterSessionId ? [afterSessionId] : []), limit)
    .map((row) => row.source_session_id);
}

/** Reply delivery is separately indexed so QueueOnly recovery keeps its existing scope. */
export function listPendingCrossSessionTerminalReplyMail(
  database: Database,
  sourceSessionId: string,
  limit: number,
  afterMessageId?: string,
): readonly CrossSessionMailOutboxRecord[] {
  if (!sourceSessionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalidSource();
  const rows = database
    .query<{ message_id: string }, (string | number)[]>(
      `SELECT message_id FROM agent_mail_outbox WHERE source_session_id=?
       AND mode='reply' AND delivered_target_revision IS NULL ${afterMessageId ? 'AND message_id>?' : ''}
       ORDER BY message_id LIMIT ?`,
    )
    .all(sourceSessionId, ...(afterMessageId ? [afterMessageId] : []), limit);
  return rows.map((row) => readCrossSessionMail(database, sourceSessionId, row.message_id)!);
}

export function listPendingCrossSessionTerminalReplyMailSources(
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
    invalidSource();
  return database
    .query<{ source_session_id: string }, (string | number)[]>(
      `SELECT DISTINCT source_session_id FROM agent_mail_outbox
       WHERE mode='reply' AND delivered_target_revision IS NULL ${afterSessionId ? 'AND source_session_id>?' : ''}
       ORDER BY source_session_id LIMIT ?`,
    )
    .all(...(afterSessionId ? [afterSessionId] : []), limit)
    .map((row) => row.source_session_id);
}

/** Crash recovery enumerates terminal followups that have no derived reply outbox. */
export function listUnrepliedSettledFollowupTerminalSources(
  database: Database,
  limit: number,
  after?: Readonly<{ childSessionId: string; submissionId: string }>,
): readonly Readonly<{
  childSessionId: string;
  parentSessionId: string;
  submissionId: string;
}>[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (after !== undefined && (!after.childSessionId || !after.submissionId))
  )
    invalidSource();
  const newTurns = database
    .query<
      { child_session_id: string; parent_session_id: string; submission_id: string },
      (string | number)[]
    >(
      `SELECT r.target_session_id AS child_session_id,r.source_session_id AS parent_session_id,
       r.submission_id FROM agent_followup_routes r
       JOIN agent_followup_funding_receipts f ON f.source_session_id=r.source_session_id
         AND f.submission_id=r.submission_id AND f.target_session_id=r.target_session_id
         AND f.target_run_id=r.target_run_id AND f.message_id=r.message_id
       JOIN runtime_sessions child ON child.session_id=r.target_session_id
       JOIN runtime_sessions parent ON parent.session_id=r.source_session_id
       JOIN runtime_runs terminal_run ON terminal_run.session_id=r.target_session_id
         AND terminal_run.run_id=r.target_run_id
       WHERE r.route='new_turn'
         AND f.terminal_disposition IN ('completed','pre_dispatch_released')
         AND child.parent_session_id=parent.session_id
         AND child.workspace_id=parent.workspace_id AND child.project_id=parent.project_id
         AND child.workspace_digest=parent.workspace_digest
         AND EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id=r.target_session_id
           AND e.sequence=f.terminal_target_revision
           AND json_extract(e.event_json,'$.type')='agent.followup_turn_settled'
           AND json_extract(e.event_json,'$.sourceSessionId')=r.source_session_id
           AND json_extract(e.event_json,'$.submissionId')=r.submission_id
           AND json_extract(e.event_json,'$.targetRunId')=r.target_run_id
           AND json_extract(e.event_json,'$.taskId')=r.task_id
           AND json_extract(e.event_json,'$.status')=terminal_run.status
           AND ((f.terminal_disposition='completed' AND terminal_run.status='completed')
             OR (f.terminal_disposition='pre_dispatch_released'
               AND terminal_run.status IN ('failed','cancelled'))))
         AND (f.terminal_disposition='completed' OR
           (f.turn_reservation_id<>f.model_reservation_id
             AND (SELECT count(DISTINCT json_extract(e.event_json,'$.reservationId'))
               FROM runtime_events e WHERE e.session_id=r.source_session_id
                 AND e.sequence<=f.terminal_source_revision
                 AND json_extract(e.event_json,'$.type')='resource_budget.released'
                 AND json_extract(e.event_json,'$.proof')='local_pre_dispatch_failure'
                 AND json_extract(e.event_json,'$.reservationId')
                   IN (f.turn_reservation_id,f.model_reservation_id))=2
             AND NOT EXISTS (SELECT 1 FROM runtime_events attempt
               WHERE attempt.session_id=r.target_session_id
                 AND json_extract(attempt.event_json,'$.type')='model.invocation_attempt_started'
                 AND json_extract(attempt.event_json,'$.invocationId')=r.invocation_id)))
         AND NOT EXISTS (SELECT 1 FROM agent_mail_outbox o
           WHERE o.source_session_id=r.target_session_id AND o.mode='reply'
             AND o.source_effect_attempt_id=r.submission_id)
         ${after ? 'AND (r.target_session_id>? OR (r.target_session_id=? AND r.submission_id>?))' : ''}
       ORDER BY r.target_session_id,r.submission_id LIMIT ?`,
    )
    .all(...(after ? [after.childSessionId, after.childSessionId, after.submissionId] : []), limit)
    .map((row) => ({
      childSessionId: row.child_session_id,
      parentSessionId: row.parent_session_id,
      submissionId: row.submission_id,
    }));
  const independentTurns = database
    .query<
      { child_session_id: string; parent_session_id: string; submission_id: string },
      (string | number)[]
    >(
      `SELECT o.target_session_id AS child_session_id,
       o.source_session_id AS parent_session_id,o.submission_id
       FROM agent_mail_outbox o
       JOIN runtime_sessions child ON child.session_id=o.target_session_id
       JOIN runtime_sessions parent ON parent.session_id=o.source_session_id
       JOIN runtime_events audit ON audit.session_id=o.source_session_id
         AND json_extract(audit.event_json,'$.type')='agent.followup_independent_settled'
         AND json_extract(audit.event_json,'$.submissionId')=o.submission_id
         AND json_extract(audit.event_json,'$.targetAgentId')=o.target_session_id
       JOIN runtime_runs terminal_run ON terminal_run.session_id=o.target_session_id
         AND terminal_run.run_id=json_extract(audit.event_json,'$.targetRunId')
       WHERE o.mode='trigger_turn'
         AND json_extract(audit.event_json,'$.disposition') IN
           ('completed','pre_dispatch_released')
         AND child.parent_session_id=parent.session_id
         AND child.workspace_id=parent.workspace_id AND child.project_id=parent.project_id
         AND child.workspace_digest=parent.workspace_digest
         AND EXISTS (SELECT 1 FROM runtime_events settled
           WHERE settled.session_id=o.target_session_id
             AND settled.sequence=json_extract(audit.event_json,'$.targetRevision')
             AND json_extract(settled.event_json,'$.type')='agent.followup_turn_settled'
             AND json_extract(settled.event_json,'$.sourceSessionId')=o.source_session_id
             AND json_extract(settled.event_json,'$.submissionId')=o.submission_id
             AND json_extract(settled.event_json,'$.targetRunId')=terminal_run.run_id
             AND json_extract(settled.event_json,'$.status')=terminal_run.status)
         AND ((json_extract(audit.event_json,'$.disposition')='completed'
             AND terminal_run.status='completed')
           OR (json_extract(audit.event_json,'$.disposition')='pre_dispatch_released'
             AND terminal_run.status IN ('failed','cancelled')))
         AND NOT EXISTS (SELECT 1 FROM agent_mail_outbox reply
           WHERE reply.source_session_id=o.target_session_id AND reply.mode='reply'
             AND reply.source_effect_attempt_id=o.submission_id)
         ${after ? 'AND (o.target_session_id>? OR (o.target_session_id=? AND o.submission_id>?))' : ''}
       ORDER BY o.target_session_id,o.submission_id LIMIT ?`,
    )
    .all(...(after ? [after.childSessionId, after.childSessionId, after.submissionId] : []), limit)
    .map((row) => ({
      childSessionId: row.child_session_id,
      parentSessionId: row.parent_session_id,
      submissionId: row.submission_id,
    }));
  const currentTurns = database
    .query<
      { child_session_id: string; parent_session_id: string; submission_id: string },
      (string | number)[]
    >(
      `SELECT r.target_session_id AS child_session_id,r.source_session_id AS parent_session_id,
       r.submission_id FROM agent_followup_routes r
       JOIN agent_mail_outbox accepted ON accepted.source_session_id=r.source_session_id
         AND accepted.submission_id=r.submission_id AND accepted.message_id=r.message_id
       JOIN child_session_intents intent ON intent.child_thread_id=r.target_session_id
         AND intent.parent_session_id=r.source_session_id
         AND intent.child_invocation_id=r.task_id
       WHERE r.route='current_turn'
         AND accepted.current_turn_release_source_revision IS NOT NULL
         AND (intent.disposition='required' AND intent.parent_claim_settled_event_id IS NOT NULL
           OR intent.disposition='after_turn'
             AND EXISTS (SELECT 1 FROM runtime_events imported
               WHERE imported.session_id=r.source_session_id
                 AND json_extract(imported.event_json,'$.type')='subagent.child_terminal_imported'
                 AND json_extract(imported.event_json,'$.childThreadId')=r.target_session_id
                 AND json_extract(imported.event_json,'$.childInvocationId')=r.task_id)
             AND EXISTS (SELECT 1 FROM runtime_events result
               WHERE result.session_id=r.source_session_id
                 AND json_extract(result.event_json,'$.type')='subagent.background_result_persisted'
                 AND json_extract(result.event_json,'$.taskId')=r.task_id
                 AND json_extract(result.event_json,'$.originRunId')=intent.origin_run_id))
         AND EXISTS (SELECT 1 FROM runtime_events e WHERE e.session_id=r.target_session_id
           AND json_extract(e.event_json,'$.type')='agent.followup_turn_settled'
           AND json_extract(e.event_json,'$.submissionId')=r.submission_id
           AND json_extract(e.event_json,'$.status')<>'unknown')
         AND NOT EXISTS (SELECT 1 FROM agent_mail_outbox o
           WHERE o.source_session_id=r.target_session_id AND o.mode='reply'
             AND o.source_effect_attempt_id=r.submission_id)
         ${after ? 'AND (r.target_session_id>? OR (r.target_session_id=? AND r.submission_id>?))' : ''}
       ORDER BY r.target_session_id,r.submission_id LIMIT ?`,
    )
    .all(...(after ? [after.childSessionId, after.childSessionId, after.submissionId] : []), limit)
    .map((row) => ({
      childSessionId: row.child_session_id,
      parentSessionId: row.parent_session_id,
      submissionId: row.submission_id,
    }));
  return [...newTurns, ...independentTurns, ...currentTurns]
    .sort(
      (a, b) =>
        a.childSessionId.localeCompare(b.childSessionId) ||
        a.submissionId.localeCompare(b.submissionId),
    )
    .slice(0, limit);
}

/** A released accepted backup needs one notice even if the process died before outbox insert. */
export function listUnnotifiedAcceptedFollowupReleases(
  database: Database,
  limit: number,
  after?: Readonly<{ childSessionId: string; submissionId: string }>,
): readonly Readonly<{
  childSessionId: string;
  parentSessionId: string;
  submissionId: string;
}>[] {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (after !== undefined && (!after.childSessionId || !after.submissionId))
  )
    invalidSource();
  return database
    .query<
      { child_session_id: string; parent_session_id: string; submission_id: string },
      (string | number)[]
    >(
      `SELECT o.target_session_id AS child_session_id,
       o.source_session_id AS parent_session_id,o.submission_id
       FROM agent_mail_outbox o
       JOIN runtime_sessions child ON child.session_id=o.target_session_id
       JOIN runtime_sessions parent ON parent.session_id=o.source_session_id
       WHERE o.mode='trigger_turn' AND o.accepted_release_source_revision IS NOT NULL
         AND o.accepted_release_reason IN
           ('tool_failed','expired','context_unavailable','authorization_changed','capacity_timeout','source_cancelled')
         AND child.parent_session_id=parent.session_id
         AND child.workspace_id=parent.workspace_id AND child.project_id=parent.project_id
         AND child.workspace_digest=parent.workspace_digest
         AND NOT EXISTS (SELECT 1 FROM agent_mail_outbox reply
           WHERE reply.source_session_id=o.target_session_id AND reply.mode='reply'
             AND reply.command_id LIKE 'accepted-release-notice-%'
             AND reply.source_effect_attempt_id=o.submission_id)
         ${after ? 'AND (o.target_session_id>? OR (o.target_session_id=? AND o.submission_id>?))' : ''}
       ORDER BY o.target_session_id,o.submission_id LIMIT ?`,
    )
    .all(...(after ? [after.childSessionId, after.childSessionId, after.submissionId] : []), limit)
    .map((row) => ({
      childSessionId: row.child_session_id,
      parentSessionId: row.parent_session_id,
      submissionId: row.submission_id,
    }));
}

/** Source-owned read for direct child mail; it never advances a target watermark. */
export function readUnreadDirectChildMail(
  database: Database,
  parentSessionId: string,
  currentRunId: string,
  childSessionId: string,
): Readonly<{ count: number; throughSequence: number }> {
  if (!parentSessionId || !currentRunId || !childSessionId || parentSessionId === childSessionId)
    invalidSource();
  const lineage = database
    .query<{ child_session_id: string }, [string, string]>(
      `SELECT child.session_id AS child_session_id FROM runtime_sessions child
     JOIN runtime_sessions parent ON parent.session_id=?
     WHERE child.session_id=? AND child.parent_session_id=parent.session_id
       AND child.workspace_id=parent.workspace_id AND child.project_id=parent.project_id
       AND child.workspace_digest=parent.workspace_digest`,
    )
    .get(parentSessionId, childSessionId);
  if (!lineage) unavailable();
  const unread = database
    .query<{ count: number; sequence: number }, [string, string, string]>(
      `SELECT count(*) AS count,coalesce(max(sequence),0) AS sequence FROM agent_mail_inbox
     WHERE target_session_id=? AND target_run_id=? AND source_session_id=?
       AND prepared_invocation_id IS NULL`,
    )
    .get(parentSessionId, currentRunId, childSessionId);
  return Object.freeze({ count: unread?.count ?? 0, throughSequence: unread?.sequence ?? 0 });
}

export function readDirectChildInboxWatermark(
  database: Database,
  parentSessionId: string,
  currentRunId: string,
): Readonly<{ unreadCount: number; throughSequence: number }> {
  if (!parentSessionId || !currentRunId) invalidSource();
  const unread = database
    .query<{ count: number; sequence: number }, [string, string]>(
      `SELECT count(*) AS count,coalesce(max(i.sequence),0) AS sequence
     FROM agent_mail_inbox i
     JOIN runtime_sessions child ON child.session_id=i.source_session_id
     JOIN runtime_sessions parent ON parent.session_id=i.target_session_id
     WHERE i.target_session_id=? AND i.target_run_id=? AND i.prepared_invocation_id IS NULL
       AND child.parent_session_id=parent.session_id
       AND child.workspace_id=parent.workspace_id AND child.project_id=parent.project_id
       AND child.workspace_digest=parent.workspace_digest`,
    )
    .get(parentSessionId, currentRunId);
  return Object.freeze({ unreadCount: unread?.count ?? 0, throughSequence: unread?.sequence ?? 0 });
}

/** Source-local sequence for the canonical acceptance event; the commit rechecks it. */
export function nextCrossSessionSourceSequence(
  database: Database,
  sourceSessionId: string,
): number {
  if (!sourceSessionId) invalidSource();
  const next = database
    .query<{ sequence: number }, [string]>(
      'SELECT coalesce(max(source_sequence),0)+1 AS sequence FROM agent_mail_outbox WHERE source_session_id=?',
    )
    .get(sourceSessionId)?.sequence;
  if (!Number.isSafeInteger(next) || next! < 1) conflict();
  return next!;
}

/** Target-local sequence for the canonical acceptance event; the receiver rechecks it. */
export function nextCrossSessionTargetSequence(
  database: Database,
  targetSessionId: string,
): number {
  if (!targetSessionId) invalidSource();
  const next = database
    .query<{ sequence: number }, [string]>(
      'SELECT coalesce(max(sequence),0)+1 AS sequence FROM agent_mail_inbox WHERE target_session_id=?',
    )
    .get(targetSessionId)?.sequence;
  if (!Number.isSafeInteger(next) || next! < 1) conflict();
  return next!;
}

export interface CrossSessionInboxReceipt {
  readonly targetSessionId: string;
  readonly sourceSessionId: string;
  readonly targetRunId: string | null;
  readonly messageId: string;
  readonly sequence: number;
  readonly targetRevision: number;
  readonly receivedAtMs: number;
}

/** Target-scoped receipt read for crash recovery; it never prepares model input. */
export function readCrossSessionInboxReceipt(
  database: Database,
  targetSessionId: string,
  messageId: string,
): CrossSessionInboxReceipt | null {
  if (!targetSessionId || !messageId) invalidSource();
  const row = database
    .query<
      {
        source_session_id: string;
        target_run_id: string | null;
        sequence: number;
        target_revision: number;
        received_at_ms: number;
      },
      [string, string]
    >(
      `SELECT source_session_id,target_run_id,sequence,target_revision,received_at_ms
       FROM agent_mail_inbox WHERE target_session_id=? AND message_id=?`,
    )
    .get(targetSessionId, messageId);
  if (!row) return null;
  assertPair(database, row.source_session_id, targetSessionId);
  return {
    targetSessionId,
    sourceSessionId: row.source_session_id,
    targetRunId: row.target_run_id,
    messageId,
    sequence: row.sequence,
    targetRevision: row.target_revision,
    receivedAtMs: row.received_at_ms,
  };
}

export interface CrossSessionQueuedMail {
  readonly messageId: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly targetRunId: string;
  readonly sourceRunId: string;
  readonly sourceTurnId: string;
  readonly sourceModelInvocationId: string;
  readonly sourceToolCallId: string;
  readonly sourceEffectAttemptId: string;
  readonly sourceTaskId: string | null;
  readonly bodyText: string;
}

/** Per-Run prepared watermark; target inbox sequence itself is Session-global. */
export function readCrossSessionPreparedThrough(
  database: Database,
  targetSessionId: string,
  currentRunId: string,
): number {
  if (!targetSessionId || !currentRunId) invalidSource();
  return (
    database
      .query<{ sequence: number }, [string, string]>(
        `SELECT coalesce(max(i.sequence),0) AS sequence FROM agent_mail_inbox i
         JOIN agent_mail_outbox o ON o.source_session_id=i.source_session_id
           AND o.message_id=i.message_id AND o.target_session_id=i.target_session_id
         WHERE i.target_session_id=? AND i.target_run_id=?
           AND i.prepared_invocation_id IS NOT NULL AND o.mode IN ('queue_only','reply')`,
      )
      .get(targetSessionId, currentRunId)?.sequence ?? 0
  );
}

/** Target-only, unprepared inbox read; does not advance the model-input watermark. */
export function listQueuedCrossSessionInbox(
  database: Database,
  targetSessionId: string,
  currentRunId: string,
  limit: number,
): readonly CrossSessionQueuedMail[] {
  if (!targetSessionId || !currentRunId || !Number.isSafeInteger(limit) || limit < 1)
    invalidSource();
  assertTargetCurrentRun(database, targetSessionId, currentRunId);
  const rows = database
    .query<
      {
        message_id: string;
        sequence: number;
        source_session_id: string;
        target_run_id: string;
        source_run_id: string;
        source_turn_id: string;
        source_model_invocation_id: string;
        source_tool_call_id: string;
        source_effect_attempt_id: string;
        source_task_id: string | null;
      },
      [string, string, number]
    >(
      `SELECT i.message_id,i.sequence,i.source_session_id,i.target_run_id,o.source_run_id,o.source_turn_id,
         o.source_model_invocation_id,o.source_tool_call_id,o.source_effect_attempt_id,o.source_task_id
       FROM agent_mail_inbox i JOIN agent_mail_outbox o
         ON o.source_session_id=i.source_session_id AND o.message_id=i.message_id
         AND o.target_session_id=i.target_session_id
       WHERE i.target_session_id=? AND i.target_run_id=? AND i.prepared_invocation_id IS NULL
         AND o.mode IN ('queue_only','reply')
       ORDER BY i.sequence LIMIT ?`,
    )
    .all(targetSessionId, currentRunId, limit);
  return rows.map((row) => {
    const bodyText = readReceivedCrossSessionMailBody(database, targetSessionId, row.message_id);
    if (bodyText === null) invalidSource();
    return {
      messageId: row.message_id,
      sequence: row.sequence,
      sourceSessionId: row.source_session_id,
      targetRunId: row.target_run_id,
      sourceRunId: row.source_run_id,
      sourceTurnId: row.source_turn_id,
      sourceModelInvocationId: row.source_model_invocation_id,
      sourceToolCallId: row.source_tool_call_id,
      sourceEffectAttemptId: row.source_effect_attempt_id,
      sourceTaskId: row.source_task_id,
      bodyText,
    };
  });
}

export function readCrossSessionMail(
  database: Database,
  sourceSessionId: string,
  messageId: string,
): CrossSessionMailOutboxRecord | null {
  const row = database
    .query<OutboxRow, [string, string]>(
      `SELECT o.*,b.integrity_identifier,b.byte_length FROM agent_mail_outbox o
     JOIN agent_mail_bodies b ON b.session_id=o.source_session_id AND b.body_id=o.body_id
     WHERE o.source_session_id=? AND o.message_id=?`,
    )
    .get(sourceSessionId, messageId);
  return row
    ? {
        mode: row.mode,
        sourceSessionId: row.source_session_id,
        targetSessionId: row.target_session_id,
        messageId: row.message_id,
        commandId: row.command_id,
        requestDigest: row.request_digest,
        sourceRunId: row.source_run_id,
        sourceTurnId: row.source_turn_id,
        sourceModelInvocationId: row.source_model_invocation_id,
        sourceToolCallId: row.source_tool_call_id,
        sourceEffectAttemptId: row.source_effect_attempt_id,
        sourceTaskId: row.source_task_id,
        sourceGrantId: row.source_grant_id,
        sourceGrantDigest: row.source_grant_digest,
        targetRunId: row.target_run_id,
        sourceSequence: row.source_sequence,
        sourceRevision: row.source_revision,
        acceptedAtMs: row.accepted_at_ms,
        deliveredTargetRevision: row.delivered_target_revision,
        bodyRef: {
          artifactId: row.body_id,
          integrityIdentifier: row.integrity_identifier,
          byteLength: row.byte_length,
        },
      }
    : null;
}

/** Private body read is scoped to the exact target inbox receipt and current lineage. */
export function readReceivedCrossSessionMailBody(
  database: Database,
  targetSessionId: string,
  messageId: string,
): string | null {
  const row = database
    .query<
      {
        source_session_id: string;
        body_text: string;
        integrity_identifier: string;
        byte_length: number;
      },
      [string, string]
    >(
      `SELECT i.source_session_id,b.body_text,b.integrity_identifier,b.byte_length FROM agent_mail_inbox i
     JOIN agent_mail_outbox o ON o.source_session_id=i.source_session_id AND o.message_id=i.message_id
     JOIN agent_mail_bodies b ON b.session_id=o.source_session_id AND b.body_id=o.body_id
     WHERE i.target_session_id=? AND i.message_id=? AND o.target_session_id=i.target_session_id`,
    )
    .get(targetSessionId, messageId);
  if (!row) return null;
  assertPair(database, row.source_session_id, targetSessionId);
  if (
    Buffer.byteLength(row.body_text, 'utf8') !== row.byte_length ||
    `sha256:${createHash('sha256').update(row.body_text).digest('hex')}` !==
      row.integrity_identifier
  )
    conflict();
  return row.body_text;
}

export interface CrossSessionPreparedMail {
  readonly messageId: string;
  readonly sequence: number;
  readonly sourceSessionId: string;
  readonly bodyText: string;
}

/** Input preparation is the only mailbox read that advances the target's model-input watermark. */
export function prepareCrossSessionQueueMailInputInTransaction(
  database: Database,
  input: {
    readonly targetSessionId: string;
    readonly targetRevision: number;
    readonly currentRunId: string;
    readonly modelInvocationId: string;
    readonly modelAdmissionId: string;
  },
): readonly CrossSessionPreparedMail[] {
  requireTransaction(database);
  if (
    !input.targetSessionId ||
    !input.currentRunId ||
    !input.modelInvocationId ||
    !input.modelAdmissionId ||
    !Number.isSafeInteger(input.targetRevision) ||
    input.targetRevision < 1
  )
    invalidSource();
  const target = database
    .query<{ revision: number }, [string]>(
      'SELECT revision FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.targetSessionId);
  const node = database
    .query<{ status: string }, [string]>(
      'SELECT status FROM agent_nodes WHERE session_id=? AND agent_id=session_id',
    )
    .get(input.targetSessionId);
  if (target?.revision !== input.targetRevision || node?.status !== 'active') invalidSource();
  assertTargetCurrentRun(database, input.targetSessionId, input.currentRunId);
  const already = database
    .query<
      {
        message_id: string;
        sequence: number;
        source_session_id: string;
        target_run_id: string | null;
        prepared_model_admission_id: string;
      },
      [string, string, string]
    >(
      `SELECT i.message_id,i.sequence,i.source_session_id,i.target_run_id,i.prepared_model_admission_id
       FROM agent_mail_inbox i JOIN agent_mail_outbox o
         ON o.source_session_id=i.source_session_id AND o.message_id=i.message_id
         AND o.target_session_id=i.target_session_id
       WHERE i.target_session_id=? AND i.prepared_invocation_id=? AND i.target_run_id=?
         AND o.mode IN ('queue_only','reply')
       ORDER BY sequence`,
    )
    .all(input.targetSessionId, input.modelInvocationId, input.currentRunId);
  if (already.some((row) => row.prepared_model_admission_id !== input.modelAdmissionId)) conflict();
  const selected =
    already.length > 0
      ? already
      : database
          .query<
            { message_id: string; sequence: number; source_session_id: string },
            [string, string]
          >(
            `SELECT i.message_id,i.sequence,i.source_session_id FROM agent_mail_inbox i
       JOIN agent_mail_outbox o ON o.source_session_id=i.source_session_id
         AND o.message_id=i.message_id AND o.target_session_id=i.target_session_id
       WHERE i.target_session_id=? AND i.target_run_id=? AND i.prepared_invocation_id IS NULL
         AND o.mode IN ('queue_only','reply')
       ORDER BY sequence`,
          )
          .all(input.targetSessionId, input.currentRunId);
  if (already.length === 0) {
    const update = database.query(`UPDATE agent_mail_inbox
      SET prepared_invocation_id=?,prepared_model_admission_id=?
      WHERE target_session_id=? AND target_run_id=? AND message_id=? AND prepared_invocation_id IS NULL
        AND EXISTS (SELECT 1 FROM agent_mail_outbox o
          WHERE o.source_session_id=agent_mail_inbox.source_session_id
            AND o.target_session_id=agent_mail_inbox.target_session_id
            AND o.message_id=agent_mail_inbox.message_id AND o.mode IN ('queue_only','reply'))`);
    for (const row of selected) {
      if (
        update.run(
          input.modelInvocationId,
          input.modelAdmissionId,
          input.targetSessionId,
          input.currentRunId,
          row.message_id,
        ).changes !== 1
      )
        conflict();
    }
  }
  return selected.map((row) => {
    const bodyText = readReceivedCrossSessionMailBody(
      database,
      input.targetSessionId,
      row.message_id,
    );
    if (bodyText === null) invalidSource();
    return {
      messageId: row.message_id,
      sequence: row.sequence,
      sourceSessionId: row.source_session_id,
      bodyText,
    };
  });
}

function assertPair(database: Database, sourceSessionId: string, targetSessionId: string): void {
  const row = database
    .query<{ valid: number }, [string, string]>(
      `SELECT 1 AS valid FROM runtime_sessions s JOIN runtime_sessions t
      ON s.workspace_id=t.workspace_id AND s.project_id=t.project_id AND s.workspace_digest=t.workspace_digest
      WHERE s.session_id=? AND t.session_id=? AND
       (s.parent_session_id=t.session_id OR t.parent_session_id=s.session_id)`,
    )
    .get(sourceSessionId, targetSessionId);
  if (!row) invalidSource();
}

function assertTargetCurrentRun(
  database: Database,
  targetSessionId: string,
  currentRunId: string,
): void {
  const row = database
    .query<{ run_id: string }, [string, string]>(
      `SELECT r.run_id FROM runtime_runs r JOIN agent_nodes n
       ON n.session_id=r.session_id AND n.agent_id=r.session_id
     WHERE r.session_id=? AND r.run_id=? AND r.status IN ('running','waiting')
       AND n.status='active' AND n.current_task_id=r.run_id`,
    )
    .get(targetSessionId, currentRunId);
  if (!row) invalidSource();
}

function assertSourceGrant(database: Database, input: CrossSessionMailIntent): void {
  const source = database
    .query<{ parent_session_id: string | null }, [string]>(
      'SELECT parent_session_id FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.sourceSessionId);
  if (!source) invalidSource();
  if (source.parent_session_id === null) {
    if (input.sourceGrantId !== undefined || input.sourceGrantDigest !== undefined) invalidSource();
    return;
  }
  if (
    !input.sourceGrantId ||
    !input.sourceGrantDigest ||
    !Number.isSafeInteger(input.sourceOwnerGeneration) ||
    input.sourceOwnerGeneration! < 1
  )
    invalidSource();
  const intent = database
    .query<
      {
        child_invocation_id: string;
        grant_digest: string;
        origin_run_id: string;
        child_budget_activated_run_id: string | null;
        dispatch_ack_event_id: string | null;
        parent_claim_settled_event_id: string | null;
        failure_receipt_digest: string | null;
      },
      [string, string]
    >(
      `SELECT child_invocation_id,grant_digest,origin_run_id,child_budget_activated_run_id,
       dispatch_ack_event_id,parent_claim_settled_event_id,failure_receipt_digest
     FROM child_session_intents WHERE parent_session_id=? AND child_thread_id=?`,
    )
    .get(source.parent_session_id, input.sourceSessionId);
  if (
    !intent ||
    intent.failure_receipt_digest ||
    intent.parent_claim_settled_event_id ||
    !intent.dispatch_ack_event_id ||
    intent.child_budget_activated_run_id !== input.sourceRunId ||
    intent.grant_digest !== input.sourceGrantDigest ||
    input.sourceTaskId !== intent.child_invocation_id
  )
    invalidSource();
  const sealed = readChildSealedGrant(database, source.parent_session_id, input.sourceSessionId);
  if (!sealed || sealed.sealedGrantDigest !== input.sourceGrantDigest) invalidSource();
  const grant = JSON.parse(sealed.sealedGrantJson) as Record<string, unknown>;
  if (
    grant.grantId !== input.sourceGrantId ||
    grant.childInvocationId !== intent.child_invocation_id
  )
    invalidSource();
  const run = database
    .query<
      {
        origin_session_id: string | null;
        origin_run_id: string | null;
      },
      [string, string]
    >(
      `SELECT origin_session_id,origin_run_id FROM runtime_runs
     WHERE session_id=? AND run_id=? AND status IN ('running','waiting')`,
    )
    .get(input.sourceSessionId, input.sourceRunId);
  if (
    run?.origin_session_id !== source.parent_session_id ||
    run.origin_run_id !== intent.origin_run_id
  )
    invalidSource();
  const state = input.sourceSnapshot as Record<string, unknown> | undefined;
  const origin = state?.childSessionOrigin as Record<string, unknown> | undefined;
  if (
    !origin ||
    origin.terminal !== undefined ||
    origin.taskInputAdmitted !== true ||
    origin.parentSessionId !== source.parent_session_id ||
    origin.childInvocationId !== intent.child_invocation_id ||
    origin.grantDigest !== intent.grant_digest ||
    state?.activeTaskId !== intent.child_invocation_id
  )
    invalidSource();
  const authority = database
    .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=?')
    .get(`session_execution/${input.sourceSessionId}`);
  const current = authority ? (JSON.parse(authority.value) as Record<string, unknown>) : null;
  if (current?.status !== 'active' || current.controllerGeneration !== input.sourceOwnerGeneration)
    invalidSource();
}

function requireTransaction(database: Database): void {
  if (!database.inTransaction) invalidSource();
}
function invalidSource(): never {
  throw new KiteCrossSessionAgentMailError(
    'invalid_source',
    'Cross-Session mail source or transaction is invalid.',
  );
}
function conflict(): never {
  throw new KiteCrossSessionAgentMailError(
    'identity_conflict',
    'Cross-Session mail identity conflicts with durable receipt.',
  );
}
function unavailable(): never {
  throw new KiteCrossSessionAgentMailError(
    'target_unavailable',
    'Target Agent Session is unavailable.',
  );
}
