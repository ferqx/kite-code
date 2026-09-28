import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type {
  RuntimeChildTerminalCheckpointMutation,
  RuntimeFollowupRunStartMutation,
  RuntimeStoredRun,
  RuntimeTransactionInput,
} from '@kite-ai/runtime-host/storage';
import {
  CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED,
  childDelegatedUpperBoundDigest,
} from '@kite-ai/runtime-host/storage';
import { readChildSealedGrant, readChildSessionIntent } from './kite-child-session-intents';
import {
  acceptCrossSessionQueueMailInTransaction,
  type CrossSessionMailIntent,
  type CrossSessionMailOutboxRecord,
  nextCrossSessionTargetSequence,
  readCrossSessionInboxReceipt,
  readCrossSessionMail,
  readReceivedCrossSessionMailBody,
  receiveCrossSessionQueueMailInTransaction,
} from './kite-cross-session-agent-mail';
import { readProvenUnfundedExpiredFollowupRelease } from './kite-cross-session-followup-proof';
import { createKiteHomeArtifactStore } from './kite-home-artifacts';

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ARTIFACT_ID = /^pa_[a-f0-9]{64}$/u;
const BARE_DIGEST = /^[a-f0-9]{64}$/u;

/** Store readback of Builtin's versioned private Model Artifact reference. */
function matchesModelArtifactReference(
  kind: 'model_surface' | 'model_response',
  canonicalJson: string,
  ref: RecordValue,
): boolean {
  const bytes = Buffer.from(canonicalJson, 'utf8');
  const contentDigest = createHash('sha256').update(bytes).digest('hex');
  const material = `model-artifacts\0${kind}\0${contentDigest}`;
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
  return (
    ref.kind === kind &&
    ref.artifactId === artifactId &&
    ref.integrityIdentifier === integrityIdentifier &&
    ref.byteLength === bytes.byteLength
  );
}

function validPreparedFollowupTool(
  value: unknown,
  source: RecordValue,
  policy: RecordValue,
): boolean {
  const tool = record(value);
  return (
    tool.operationId === 'builtin:followup_task' &&
    tool.capabilityId === 'builtin:followup_task' &&
    tool.bindingId === null &&
    typeof tool.invocationId === 'string' &&
    tool.invocationId.length > 0 &&
    typeof tool.capabilityRevision === 'string' &&
    tool.capabilityRevision.length > 0 &&
    tool.toolCallId === source.toolCallId &&
    tool.attemptId === source.effectAttemptId &&
    tool.turnId === source.turnId &&
    typeof tool.modelMessageId === 'string' &&
    tool.modelMessageId.length > 0 &&
    BARE_DIGEST.test(String(tool.argumentsDigest)) &&
    BARE_DIGEST.test(String(tool.schemaDigest)) &&
    tool.authorizationDigest === policy.authorizationDigest &&
    tool.admissionDigest === policy.admissionDigest &&
    tool.effectiveEffectsDigest === policy.effectiveEffectsDigest &&
    tool.policyRevision === policy.policyRevision &&
    tool.interactionMode === policy.interactionMode &&
    ['policy_allow', 'approved_call'].includes(String(tool.authorizationKind)) &&
    ['none', 'approve_once', 'same_command'].includes(String(tool.grantUsed)) &&
    Object.hasOwn(tool, 'policyEffects') &&
    Object.hasOwn(tool, 'effectiveEffects') &&
    Object.hasOwn(tool, 'sandboxScope') &&
    typeof tool.policyEffects === 'object' &&
    tool.policyEffects !== null &&
    !Array.isArray(tool.policyEffects) &&
    typeof tool.effectiveEffects === 'object' &&
    tool.effectiveEffects !== null &&
    !Array.isArray(tool.effectiveEffects) &&
    (tool.sandboxScope === null ||
      (typeof tool.sandboxScope === 'object' && !Array.isArray(tool.sandboxScope)))
  );
}

export class KiteCrossSessionFollowupError extends Error {
  readonly code: 'invalid_source' | 'identity_conflict' | 'target_unavailable';
  constructor(code: 'invalid_source' | 'identity_conflict' | 'target_unavailable') {
    super(`Cross-Session followup ${code}.`);
    this.name = 'KiteCrossSessionFollowupError';
    this.code = code;
  }
}

/** Seal a completed child checkpoint with its terminal Event and persisted State. */
export function sealChildTerminalCheckpointInTransaction(
  database: Database,
  input: {
    readonly sessionId: string;
    readonly revision: number;
    readonly mutation: RuntimeChildTerminalCheckpointMutation;
    readonly terminalEvent: Readonly<Record<string, unknown>>;
  },
): void {
  requireTransaction(database);
  const { sessionId, revision, mutation, terminalEvent } = input;
  const ref = mutation.ref;
  const digest = `sha256:${createHash('sha256').update(mutation.canonicalJson).digest('hex')}`;
  const payload = parse(mutation.canonicalJson);
  const snapshot = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(sessionId);
  const state = snapshot ? parse(snapshot.state_json) : {};
  const origin = record(state.childSessionOrigin);
  const terminal = record(origin.terminal);
  const outcome = record(state.terminalOutcome);
  const latestRun = database
    .query<
      { run_id: string; status: string; last_revision: number },
      [string]
    >(`SELECT run_id,status,last_revision FROM runtime_runs WHERE session_id=?
      ORDER BY created_revision DESC LIMIT 1`)
    .get(sessionId);
  const node = database
    .query<
      {
        status: string;
        artifact_id: string | null;
        integrity: string | null;
        byte_length: number | null;
      },
      [string]
    >(`SELECT status,latest_checkpoint_artifact_id AS artifact_id,
      latest_checkpoint_integrity_identifier AS integrity,latest_checkpoint_byte_length AS byte_length
      FROM agent_nodes WHERE session_id=? AND agent_id=session_id`)
    .get(sessionId);
  const followup = mutation.submissionId !== undefined;
  const priorPrepared = followup
    ? database
        .query<{ event_json: string }, [string, string]>(
          `SELECT event_json FROM runtime_events WHERE session_id=?
     AND json_extract(event_json,'$.type')='agent.followup_turn_prepared'
     AND json_extract(event_json,'$.submissionId')=? ORDER BY sequence DESC LIMIT 1`,
        )
        .get(sessionId, mutation.submissionId!)
    : null;
  const prepared = priorPrepared ? parse(priorPrepared.event_json) : {};
  const previousRef = record(prepared.checkpointRef);
  const route = followup
    ? readCrossSessionFollowupRoute(database, sessionId, mutation.submissionId!)
    : null;
  const messages = record(state.transcript).messages;
  const followupModel = route ? record(record(state.modelInvocations)[route.invocationId]) : {};
  const followupResponse = record(followupModel.responseArtifact);
  const followupLocalReservation = route
    ? record(record(record(state.resourceBudget).reservations)[route.reservationId])
    : {};
  const followupResponseRow =
    followupResponse.artifactId && typeof followupResponse.artifactId === 'string'
      ? database
          .query<
            { integrity_identifier: string; byte_length: number; canonical_json: string },
            [string]
          >(
            'SELECT integrity_identifier,byte_length,canonical_json FROM model_artifacts WHERE artifact_id=?',
          )
          .get(followupResponse.artifactId)
      : null;
  const hasExactFollowupModel = Boolean(
    route &&
      followupModel.status === 'completed' &&
      followupModel.invocationId === route.invocationId &&
      followupModel.attempts === 1 &&
      record(followupModel.budget).kind === 'reservation' &&
      record(followupModel.budget).reservationId === route.reservationId &&
      followupResponse.kind === 'model_response' &&
      typeof followupResponse.integrityIdentifier === 'string' &&
      followupResponseRow?.integrity_identifier === followupResponse.integrityIdentifier &&
      followupResponseRow.byte_length === followupResponse.byteLength &&
      followupResponseRow.byte_length ===
        Buffer.byteLength(followupResponseRow.canonical_json, 'utf8') &&
      matchesModelArtifactReference(
        'model_response',
        followupResponseRow.canonical_json,
        followupResponse,
      ) &&
      followupLocalReservation.reservationId === route.reservationId &&
      followupLocalReservation.runId === mutation.terminalRunId &&
      followupLocalReservation.resourceKind === 'model' &&
      followupLocalReservation.state === 'reconciled' &&
      Array.isArray(messages) &&
      messages.some((item) => {
        const message = record(item);
        return message.kind === 'assistant' && message.modelInvocationId === route.invocationId;
      }),
  );
  if (
    !snapshot ||
    !latestRun ||
    latestRun.run_id !== mutation.terminalRunId ||
    latestRun.status !== 'completed' ||
    latestRun.last_revision > revision ||
    !node ||
    node.status !== 'idle' ||
    (followup
      ? terminalEvent.type !== 'agent.followup_turn_settled' ||
        terminalEvent.status !== 'completed' ||
        terminalEvent.submissionId !== mutation.submissionId ||
        terminalEvent.targetRunId !== mutation.terminalRunId ||
        terminalEvent.taskId !== mutation.terminalTaskId ||
        terminalEvent.sourceSessionId !== origin.parentSessionId ||
        payload.submissionId !== mutation.submissionId ||
        !route ||
        route.route !== 'new_turn' ||
        route.targetRunId !== mutation.terminalRunId ||
        route.taskId !== mutation.terminalTaskId ||
        !hasExactFollowupModel ||
        prepared.targetRunId !== mutation.terminalRunId ||
        prepared.taskId !== mutation.terminalTaskId ||
        prepared.sourceSessionId !== origin.parentSessionId ||
        !priorPrepared ||
        node.artifact_id !== previousRef.artifactId ||
        node.integrity !== previousRef.integrityIdentifier ||
        node.byte_length !== previousRef.byteLength
      : terminalEvent.type !== 'subagent.child_terminal_sealed' ||
        terminalEvent.status !== 'completed' ||
        mutation.terminalTaskId !== origin.childInvocationId ||
        payload.submissionId !== undefined) ||
    terminal.status !== 'completed' ||
    outcome.status !== 'completed' ||
    payload.artifactFormatVersion !== 1 ||
    payload.childSessionId !== sessionId ||
    payload.terminalRunId !== mutation.terminalRunId ||
    payload.terminalTaskId !== mutation.terminalTaskId ||
    payload.terminalRevision !== revision ||
    state.revision !== revision ||
    payload.terminalStatus !== 'completed' ||
    payload.stateDigest !==
      `sha256:${createHash('sha256').update(snapshot.state_json).digest('hex')}` ||
    payload.transcriptDigest !==
      `sha256:${createHash('sha256').update(JSON.stringify(state.transcript)).digest('hex')}` ||
    !sameCanonicalValue(payload.transcript, state.transcript) ||
    typeof record(state.transcript).final !== 'string' ||
    !Array.isArray(messages) ||
    (!followup &&
      !messages.some((item) => {
        const message = record(item);
        const model = record(record(state.modelInvocations)[String(message.modelInvocationId)]);
        return (
          message.kind === 'assistant' &&
          model.status === 'completed' &&
          record(model.responseArtifact).kind === 'model_response'
        );
      })) ||
    ref.kind !== 'subagent_checkpoint' ||
    ref.artifactId !== `pa_${digest.slice(7)}` ||
    ref.integrityIdentifier !== digest ||
    ref.byteLength !== Buffer.byteLength(mutation.canonicalJson, 'utf8')
  )
    invalid();
  if (followup && !readChildTerminalCheckpoint(database, sessionId)) unavailable();
  if (node.artifact_id && !followup) {
    if (
      node.artifact_id !== ref.artifactId ||
      node.integrity !== ref.integrityIdentifier ||
      node.byte_length !== ref.byteLength
    )
      conflict();
    const stored = createKiteHomeArtifactStore(database).readSubagentCheckpoint(ref);
    if (stored.canonicalJson !== mutation.canonicalJson) conflict();
    return;
  }
  createKiteHomeArtifactStore(database).writeSubagentCheckpoint({
    ref,
    artifactFormatVersion: 1,
    canonicalJson: mutation.canonicalJson,
    createdAt: 0,
  });
  const changed = database
    .query(`UPDATE agent_nodes SET latest_checkpoint_artifact_id=?,
    latest_checkpoint_integrity_identifier=?,latest_checkpoint_byte_length=?
    WHERE session_id=? AND agent_id=session_id AND latest_checkpoint_artifact_id IS ?
      AND latest_checkpoint_integrity_identifier IS ? AND latest_checkpoint_byte_length IS ?`)
    .run(
      ref.artifactId,
      ref.integrityIdentifier,
      ref.byteLength,
      sessionId,
      followup ? String(previousRef.artifactId) : null,
      followup ? String(previousRef.integrityIdentifier) : null,
      followup ? Number(previousRef.byteLength) : null,
    ).changes;
  if (changed !== 1) conflict();
  createKiteHomeArtifactStore(database).readSubagentCheckpoint(ref);
}

const FOLLOWUP_TURN_DURATION_MS = 30 * 60 * 1000;
const READ_ONLY_FOLLOWUP_TOOLS = new Set([
  'read_file',
  'search_content',
  'search_files',
  'shell_execute',
  'read_mcp_resource',
]);

function validIndependentFollowupGrant(
  database: Database,
  input: {
    sourceSessionId: string;
    targetSessionId: string;
    submissionId: string;
    intentRole: string;
    origin: RecordValue;
    targetLedger: RecordValue;
    grantPayload: RecordValue;
    grantBudget: RecordValue;
    admission: RecordValue;
    backupState: 'reserved' | 'dispatch_started';
  },
): boolean {
  const { sourceSessionId, targetSessionId, submissionId, intentRole, origin, targetLedger } =
    input;
  const { grantPayload, grantBudget, admission } = input;
  const policy = record(admission.policy);
  const upper = record(admission.executableUpperBound);
  const upperCounters = record(upper.counters);
  const upperGauges = record(upper.gauges);
  const allowed = Array.isArray(grantPayload.allowedTools) ? grantPayload.allowedTools : [];
  const original = readChildSealedGrant(database, sourceSessionId, targetSessionId);
  const originalGrant = original ? parse(original.sealedGrantJson) : {};
  const originalCeiling = record(originalGrant.capabilityCeiling);
  const originalAllowed = Array.isArray(originalCeiling.allowedTools)
    ? originalCeiling.allowedTools
    : [];
  const sourceRow = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(sourceSessionId);
  const sourceState = sourceRow ? parse(sourceRow.state_json) : {};
  const active = record(sourceState.resourceBudget);
  const retained = record(sourceState.retainedResourceBudgets);
  const funding =
    active.runId === admission.fundingRunId
      ? active
      : record(retained[String(admission.fundingRunId)]);
  const backup = record(record(funding.reservations)[String(admission.backupReservationId)]);
  const startedAt = Date.parse(String(targetLedger.startedAt));
  const deadlineAt = Date.parse(String(targetLedger.deadlineAt));
  const duration = deadlineAt - startedAt;
  const limits: readonly [string, unknown][] = [
    ['maxTurns', upperCounters.turns],
    ['maxModelRequests', upperCounters.modelRequests],
    ['maxRunInputTokens', upperCounters.inputTokens],
    ['maxRunOutputTokens', upperCounters.outputTokens],
    ['maxArtifactBytes', upperCounters.artifactBytes],
    ['maxConcurrentWriters', upperGauges.activeWriters],
    ['maxConcurrentToolInvocations', upperGauges.activeToolInvocations],
    ['maxConcurrentShellInvocations', upperGauges.activeShellInvocations],
  ];
  return (
    admission.schema === 'kite.cross-session-followup-admission.v2' &&
    policy.executionMode === 'independent_turn_v2' &&
    policy.targetRole === intentRole &&
    policy.targetGrantDigest === original?.sealedGrantDigest &&
    origin.grantDigest === original?.sealedGrantDigest &&
    originalGrant.role === intentRole &&
    ['explore', 'plan', 'review', 'code'].includes(intentRole) &&
    grantPayload.schema === 'kite.child-followup-grant.v2' &&
    grantPayload.originRole === intentRole &&
    grantPayload.denyTools === false &&
    Array.isArray(grantPayload.allowedTools) &&
    allowed.length > 0 &&
    allowed.every((name) => typeof name === 'string' && name.length > 0 && name !== 'task') &&
    new Set(allowed).size === allowed.length &&
    Array.isArray(originalCeiling.allowedTools) &&
    (intentRole === 'code'
      ? originalAllowed.length === 0 || allowed.every((name) => originalAllowed.includes(name))
      : allowed.every(
          (name) => READ_ONLY_FOLLOWUP_TOOLS.has(name) && originalAllowed.includes(name),
        )) &&
    grantPayload.sourceBackupUpperDigest ===
      childDelegatedUpperBoundDigest(
        upper as unknown as Parameters<typeof childDelegatedUpperBoundDigest>[0],
      ) &&
    upper.source === 'versioned_upper_bound' &&
    upper.independentFollowupTurn === true &&
    upper.unboundedToolInvocations === true &&
    upperCounters.toolInvocations === 0 &&
    upperGauges.elapsedRunMs === FOLLOWUP_TURN_DURATION_MS &&
    admission.sourceSessionId === sourceSessionId &&
    admission.targetSessionId === targetSessionId &&
    admission.submissionId === submissionId &&
    admission.sourceRunId === admission.fundingRunId &&
    /^backup_[a-f0-9]{64}$/u.test(String(admission.backupReservationId)) &&
    funding.status === 'active' &&
    funding.runId === admission.fundingRunId &&
    backup.reservationId === admission.backupReservationId &&
    backup.runId === admission.fundingRunId &&
    backup.invocationId === submissionId &&
    backup.resourceKind === 'subagent' &&
    backup.parentReservationId === undefined &&
    backup.state === input.backupState &&
    sameCanonicalValue(backup.executableUpperBound, upper) &&
    grantBudget.version === 1 &&
    grantBudget.unboundedToolInvocations === true &&
    grantBudget.maxToolInvocations === 0 &&
    grantBudget.maxConcurrentSubagents === 0 &&
    grantBudget.maxRunDurationMs === FOLLOWUP_TURN_DURATION_MS &&
    Number.isSafeInteger(startedAt) &&
    Number.isSafeInteger(deadlineAt) &&
    duration === FOLLOWUP_TURN_DURATION_MS &&
    grantBudget.deadlineAt === targetLedger.deadlineAt &&
    limits.every(
      ([key, maximum]) =>
        Number.isSafeInteger(grantBudget[key]) &&
        Number.isSafeInteger(maximum) &&
        Number(grantBudget[key]) >= 0 &&
        Number(grantBudget[key]) <= Number(maximum),
    ) &&
    (intentRole === 'code'
      ? grantBudget.maxConcurrentWriters === 1
      : grantBudget.maxConcurrentWriters === 0)
  );
}

export function assertCrossSessionFollowupRunStartInTransaction(
  database: Database,
  input: {
    readonly targetSessionId: string;
    readonly mutation: RuntimeFollowupRunStartMutation;
    readonly preparedEvent: Readonly<Record<string, unknown>>;
  },
): void {
  requireTransaction(database);
  const { targetSessionId, mutation, event } = {
    targetSessionId: input.targetSessionId,
    mutation: input.mutation,
    event: input.preparedEvent,
  };
  const target = database
    .query<
      { parent_session_id: string | null; workspace_digest: string; state_json: string },
      [string]
    >(
      `SELECT s.parent_session_id,s.workspace_digest,p.state_json FROM runtime_sessions s
     JOIN runtime_snapshots p ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(targetSessionId);
  const intent = database
    .query<{ grant_digest: string; role: string }, [string]>(
      'SELECT grant_digest,role FROM child_session_intents WHERE child_thread_id=?',
    )
    .get(targetSessionId);
  const outbox = database
    .query<
      {
        message_id: string;
        target_session_id: string;
        mode: string;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
      },
      [string, string]
    >(`SELECT message_id,target_session_id,mode,followup_admission_artifact_id,
    followup_admission_digest
    FROM agent_mail_outbox WHERE source_session_id=? AND submission_id=?
      AND accepted_release_source_revision IS NULL`)
    .get(mutation.sourceSessionId, mutation.submissionId);
  const inbox = outbox
    ? database
        .query<{ target_run_id: string | null }, [string, string]>(
          'SELECT target_run_id FROM agent_mail_inbox WHERE target_session_id=? AND message_id=?',
        )
        .get(targetSessionId, outbox.message_id)
    : null;
  const runs = database
    .query<{ run_id: string; status: string; start_command_id: string; phase: string }, [string]>(
      `SELECT run_id,status,start_command_id,phase FROM runtime_runs WHERE session_id=?
     ORDER BY created_revision DESC LIMIT 2`,
    )
    .all(targetSessionId);
  const checkpoint = readChildTerminalCheckpoint(database, targetSessionId);
  const checkpointPayload = checkpoint ? parse(checkpoint.canonicalJson) : {};
  const grant = mutation.grant;
  const grantHash = `sha256:${createHash('sha256').update(grant.canonicalJson).digest('hex')}`;
  const grantPayload = parse(grant.canonicalJson);
  const grantBudget = record(grantPayload.budget);
  const targetState = target ? parse(target.state_json) : {};
  const targetLedger = record(targetState.resourceBudget);
  const activeFollowup = record(targetState.activeFollowupTurn);
  const admissionRow = outbox?.followup_admission_artifact_id
    ? database
        .query<
          {
            canonical_json: string;
            integrity_identifier: string;
          },
          [string]
        >(`SELECT canonical_json,integrity_identifier FROM agent_followup_admission_artifacts
    WHERE artifact_id=?`)
        .get(outbox.followup_admission_artifact_id)
    : null;
  const admission = admissionRow ? parse(admissionRow.canonical_json) : {};
  const policy = record(admission.policy);
  const isIndependentTurnProtocol = grantPayload.schema === 'kite.child-followup-grant.v2';
  const unsettledEarlierIndependent = isIndependentTurnProtocol
    ? (database
        .query<{ count: number }, [string, string]>(
          `SELECT count(*) AS count FROM agent_mail_outbox prior
           JOIN agent_followup_admission_artifacts admission
             ON admission.artifact_id=prior.followup_admission_artifact_id
           JOIN runtime_runs prior_run ON prior_run.session_id=prior.target_session_id
             AND prior_run.start_command_id='followup:'||prior.submission_id
           WHERE prior.target_session_id=? AND prior.submission_id<>?
             AND prior.mode='trigger_turn'
             AND json_extract(admission.canonical_json,'$.schema')
               ='kite.cross-session-followup-admission.v2'
             AND EXISTS (SELECT 1 FROM runtime_events settled
               WHERE settled.session_id=prior.target_session_id
                 AND json_extract(settled.event_json,'$.type')='agent.followup_turn_settled'
                 AND json_extract(settled.event_json,'$.submissionId')=prior.submission_id
                 AND json_extract(settled.event_json,'$.targetRunId')=prior_run.run_id)
             AND NOT EXISTS (SELECT 1 FROM runtime_events audit
               WHERE audit.session_id=prior.source_session_id
                 AND json_extract(audit.event_json,'$.type')='agent.followup_independent_settled'
                 AND json_extract(audit.event_json,'$.submissionId')=prior.submission_id
                 AND json_extract(audit.event_json,'$.targetAgentId')=prior.target_session_id
                 AND json_extract(audit.event_json,'$.targetRunId')=prior_run.run_id)`,
        )
        .get(targetSessionId, mutation.submissionId)?.count ?? 0)
    : 0;
  const validGrantBudget = isIndependentTurnProtocol
    ? validIndependentFollowupGrant(database, {
        sourceSessionId: mutation.sourceSessionId,
        targetSessionId,
        submissionId: mutation.submissionId,
        intentRole: intent?.role ?? '',
        origin: record(targetState.childSessionOrigin),
        targetLedger,
        grantPayload,
        grantBudget,
        admission,
        backupState: 'reserved',
      })
    : grantPayload.schema === 'kite.child-followup-grant.v1' &&
      grantPayload.denyTools === true &&
      Array.isArray(grantPayload.allowedTools) &&
      grantPayload.allowedTools.length === 0 &&
      boundedDelegatedBudget(grantBudget, record(admission.executableUpperBound)) &&
      Number.isFinite(Date.parse(String(grantBudget.deadlineAt))) &&
      Date.parse(String(grantBudget.deadlineAt)) <= Number(admission.deadlineAt);
  if (
    target?.parent_session_id !== mutation.sourceSessionId ||
    !intent ||
    intent.grant_digest === mutation.grantDigest ||
    !outbox ||
    outbox.target_session_id !== targetSessionId ||
    outbox.mode !== 'trigger_turn' ||
    !outbox.followup_admission_artifact_id ||
    !outbox.followup_admission_digest ||
    !inbox ||
    !checkpoint ||
    !sameCanonicalValue(checkpoint.ref, mutation.checkpointRef) ||
    !runs[0] ||
    runs[0].run_id !== mutation.targetRunId ||
    runs[0].status !== 'queued' ||
    runs[0].start_command_id !== `followup:${mutation.submissionId}` ||
    runs[0].phase !== mutation.phase ||
    !runs[1] ||
    runs[1].status !== 'completed' ||
    checkpointPayload.terminalRunId !== runs[1].run_id ||
    (inbox.target_run_id !== null && inbox.target_run_id !== runs[1].run_id) ||
    event.type !== 'agent.followup_turn_prepared' ||
    event.sourceSessionId !== mutation.sourceSessionId ||
    event.submissionId !== mutation.submissionId ||
    event.targetRunId !== mutation.targetRunId ||
    event.taskId !== mutation.taskId ||
    event.grantDigest !== mutation.grantDigest ||
    !sameCanonicalValue(event.checkpointRef, mutation.checkpointRef) ||
    !sameCanonicalValue(event.grantRef, grant.ref) ||
    grant.ref.kind !== 'agent_followup_grant' ||
    grant.ref.artifactId !== `pa_${grantHash.slice(7)}` ||
    grant.ref.integrityIdentifier !== grantHash ||
    grant.ref.byteLength !== Buffer.byteLength(grant.canonicalJson, 'utf8') ||
    mutation.grantDigest !== grantHash ||
    !Number.isSafeInteger(grant.createdAt) ||
    grant.createdAt < 0 ||
    !validGrantBudget ||
    unsettledEarlierIndependent !== 0 ||
    grantPayload.sourceSessionId !== mutation.sourceSessionId ||
    grantPayload.targetSessionId !== targetSessionId ||
    grantPayload.submissionId !== mutation.submissionId ||
    grantPayload.targetRunId !== mutation.targetRunId ||
    grantPayload.taskId !== mutation.taskId ||
    !sameCanonicalValue(grantPayload.checkpointRef, mutation.checkpointRef) ||
    grantPayload.originRole !== intent.role ||
    grantPayload.originRole !== record(targetState.childSessionOrigin).role ||
    grantPayload.workspaceDigest !== target.workspace_digest ||
    grantPayload.interactionModeRevision !== targetState.interactionModeRevision ||
    grantPayload.capabilityDigest !== record(targetState.capabilities).catalogRevision ||
    typeof grantPayload.capabilityDigest !== 'string' ||
    grantPayload.capabilityDigest.length === 0 ||
    grantPayload.phaseCeiling !== runs[0].phase ||
    (policy.phaseCeiling === 'planning' && grantPayload.phaseCeiling !== 'planning') ||
    (policy.phaseCeiling !== 'planning' && policy.phaseCeiling !== 'building') ||
    policy.interactionMode !== targetState.mode ||
    policy.workspaceAccess !== targetState.workspaceAccess ||
    !sameCanonicalValue(grantPayload.sourceAdmissionRef, {
      artifactId: outbox.followup_admission_artifact_id,
      kind: 'agent_followup_admission' as const,
      integrityIdentifier: outbox.followup_admission_digest,
      byteLength: admissionRow ? Buffer.byteLength(admissionRow.canonical_json, 'utf8') : -1,
    }) ||
    grantPayload.sourceAdmissionDigest !== outbox.followup_admission_digest ||
    admissionRow?.integrity_identifier !== outbox.followup_admission_digest ||
    grantPayload.firstAttemptTimeoutMs !== policy.firstAttemptTimeoutMs ||
    targetLedger.status !== 'active' ||
    targetLedger.runId !== mutation.targetRunId ||
    activeFollowup.sourceSessionId !== mutation.sourceSessionId ||
    activeFollowup.submissionId !== mutation.submissionId ||
    activeFollowup.targetRunId !== mutation.targetRunId ||
    activeFollowup.taskId !== mutation.taskId ||
    activeFollowup.grantDigest !== mutation.grantDigest ||
    !sameCanonicalValue(activeFollowup.grantRef, grant.ref) ||
    !sameCanonicalValue(activeFollowup.checkpointRef, mutation.checkpointRef) ||
    !Object.entries(record(targetLedger.budget)).every(([key, value]) => grantBudget[key] === value)
  )
    invalid();
  const existing = database
    .query<{ canonical_json: string }, [string]>(
      'SELECT canonical_json FROM agent_followup_grant_artifacts WHERE artifact_id=?',
    )
    .get(grant.ref.artifactId);
  if (existing) {
    if (existing.canonical_json !== grant.canonicalJson) conflict();
    return;
  }
  database
    .query(`INSERT INTO agent_followup_grant_artifacts(
    artifact_id,integrity_identifier,artifact_format_version,canonical_json,byte_length,created_at)
    VALUES (?,?,1,?,?,?)`)
    .run(
      grant.ref.artifactId,
      grantHash,
      grant.canonicalJson,
      grant.ref.byteLength,
      grant.createdAt,
    );
  const written = database
    .query<{ canonical_json: string }, [string]>(
      'SELECT canonical_json FROM agent_followup_grant_artifacts WHERE artifact_id=?',
    )
    .get(grant.ref.artifactId);
  if (written?.canonical_json !== grant.canonicalJson) conflict();
}

export function readCrossSessionFollowupGrant(
  database: Database,
  artifactId: string,
): Readonly<{
  ref: {
    artifactId: string;
    kind: 'agent_followup_grant';
    integrityIdentifier: string;
    byteLength: number;
  };
  canonicalJson: string;
}> | null {
  const row = database
    .query<
      {
        integrity_identifier: string;
        canonical_json: string;
        byte_length: number;
      },
      [string]
    >(`SELECT integrity_identifier,canonical_json,byte_length
    FROM agent_followup_grant_artifacts WHERE artifact_id=?`)
    .get(artifactId);
  if (!row) return null;
  const digest = `sha256:${createHash('sha256').update(row.canonical_json).digest('hex')}`;
  if (
    artifactId !== `pa_${digest.slice(7)}` ||
    row.integrity_identifier !== digest ||
    row.byte_length !== Buffer.byteLength(row.canonical_json, 'utf8')
  )
    invalid();
  return Object.freeze({
    ref: {
      artifactId,
      kind: 'agent_followup_grant' as const,
      integrityIdentifier: digest,
      byteLength: row.byte_length,
    },
    canonicalJson: row.canonical_json,
  });
}

export function readCrossSessionFollowupAdmissionForTarget(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  messageId: string,
): Readonly<{
  messageId: string;
  submissionId: string;
  admission: { ref: Ref; digest: string; canonicalJson: string };
}> | null {
  const row = database
    .query<
      {
        submission_id: string | null;
        mode: string;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
        canonical_json: string | null;
        byte_length: number | null;
      },
      [string, string, string]
    >(`SELECT o.submission_id,o.mode,o.followup_admission_artifact_id,
    o.followup_admission_digest,a.canonical_json,a.byte_length FROM agent_mail_outbox o
    JOIN runtime_sessions source ON source.session_id=o.source_session_id
    JOIN runtime_sessions target ON target.session_id=o.target_session_id
    JOIN agent_mail_inbox i ON i.target_session_id=o.target_session_id AND i.message_id=o.message_id
    LEFT JOIN agent_followup_admission_artifacts a
      ON a.artifact_id=o.followup_admission_artifact_id
    WHERE o.target_session_id=? AND o.source_session_id=? AND o.message_id=?
      AND o.accepted_release_source_revision IS NULL
      AND target.parent_session_id=source.session_id
      AND source.workspace_id=target.workspace_id AND source.project_id=target.project_id
      AND source.workspace_digest=target.workspace_digest
      AND i.source_session_id=o.source_session_id`)
    .get(targetSessionId, sourceSessionId, messageId);
  if (!row) return null;
  if (
    row.mode !== 'trigger_turn' ||
    !row.submission_id ||
    !row.followup_admission_artifact_id ||
    !row.followup_admission_digest ||
    !row.canonical_json ||
    row.byte_length === null
  )
    invalid();
  const digest = `sha256:${createHash('sha256').update(row.canonical_json).digest('hex')}`;
  if (
    digest !== row.followup_admission_digest ||
    row.followup_admission_artifact_id !== `pa_${digest.slice(7)}` ||
    row.byte_length !== Buffer.byteLength(row.canonical_json, 'utf8')
  )
    invalid();
  return Object.freeze({
    messageId,
    submissionId: row.submission_id,
    admission: {
      ref: {
        artifactId: row.followup_admission_artifact_id,
        kind: 'agent_followup_admission' as const,
        integrityIdentifier: digest,
        byteLength: row.byte_length,
      },
      digest,
      canonicalJson: row.canonical_json,
    },
  });
}

export function readUnroutedCrossSessionFollowupMessage(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
  messageId: string,
): Readonly<{
  bodyText: string;
  bodyRef: CrossSessionMailOutboxRecord['bodyRef'];
  bodyDigest: string;
  admissionDigest: string;
  requestDigest: string;
  sequence: number;
  oldTargetRunId: string | null;
  sourceRunId: string;
  sourceTurnId: string;
  sourceModelInvocationId: string;
  sourceToolCallId: string;
  sourceEffectAttemptId: string;
  sourceTaskId: string | null;
}> | null {
  const admission = readCrossSessionFollowupAdmissionBySubmissionForTarget(
    database,
    targetSessionId,
    sourceSessionId,
    submissionId,
  );
  if (!admission || admission.messageId !== messageId) return null;
  if (readCrossSessionFollowupRoute(database, targetSessionId, submissionId)) return null;
  const row = database
    .query<
      {
        sequence: number;
        target_run_id: string | null;
        prepared_invocation_id: string | null;
      },
      [string, string, string, string]
    >(`SELECT i.sequence,i.target_run_id,i.prepared_invocation_id
    FROM agent_mail_inbox i JOIN agent_mail_outbox o
      ON o.source_session_id=i.source_session_id AND o.message_id=i.message_id
      AND o.target_session_id=i.target_session_id
    WHERE i.target_session_id=? AND i.source_session_id=? AND i.message_id=?
      AND o.mode='trigger_turn' AND o.submission_id=?`)
    .get(targetSessionId, sourceSessionId, messageId, submissionId);
  if (!row || row.prepared_invocation_id !== null) return null;
  const outbox = readCrossSessionMail(database, sourceSessionId, messageId);
  if (
    !outbox ||
    outbox.mode !== 'trigger_turn' ||
    outbox.targetSessionId !== targetSessionId ||
    outbox.targetRunId !== row.target_run_id
  )
    invalid();
  const bodyText = readReceivedCrossSessionMailBody(database, targetSessionId, messageId);
  if (bodyText === null) invalid();
  return Object.freeze({
    bodyText,
    bodyRef: outbox.bodyRef,
    bodyDigest: outbox.bodyRef.integrityIdentifier,
    admissionDigest: admission.admission.digest,
    requestDigest: outbox.requestDigest,
    sequence: row.sequence,
    oldTargetRunId: row.target_run_id,
    sourceRunId: outbox.sourceRunId,
    sourceTurnId: outbox.sourceTurnId,
    sourceModelInvocationId: outbox.sourceModelInvocationId,
    sourceToolCallId: outbox.sourceToolCallId,
    sourceEffectAttemptId: outbox.sourceEffectAttemptId,
    sourceTaskId: outbox.sourceTaskId,
  });
}

export function readCrossSessionFollowupAdmissionBySubmissionForTarget(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
): ReturnType<typeof readCrossSessionFollowupAdmissionForTarget> {
  const row = database
    .query<{ message_id: string }, [string, string, string]>(
      `SELECT o.message_id FROM agent_mail_outbox o
     LEFT JOIN agent_followup_funding_receipts f
       ON f.source_session_id=o.source_session_id AND f.submission_id=o.submission_id
     WHERE o.source_session_id=? AND o.target_session_id=? AND o.submission_id=?
       AND o.mode='trigger_turn' AND o.accepted_release_source_revision IS NULL
       AND (f.submission_id IS NULL OR f.terminal_disposition IS NULL)`,
    )
    .get(sourceSessionId, targetSessionId, submissionId);
  if (!row) return null;
  return readCrossSessionFollowupAdmissionForTarget(
    database,
    targetSessionId,
    sourceSessionId,
    row.message_id,
  );
}

/** Reconstruct the accepted v2 policy only from source-owned immutable receipts. */
export function readAcceptedIndependentFollowupSourcePolicyProof(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
): Readonly<{ admission: RecordValue; policy: RecordValue }> | null {
  const outbox = database
    .query<
      {
        message_id: string;
        command_id: string;
        request_digest: string;
        source_run_id: string;
        source_turn_id: string;
        source_model_invocation_id: string;
        source_tool_call_id: string;
        source_effect_attempt_id: string;
        source_task_id: string | null;
        source_revision: number;
        followup_admission_artifact_id: string;
        followup_admission_digest: string;
        canonical_json: string;
        integrity_identifier: string;
        byte_length: number;
      },
      [string, string, string]
    >(
      `SELECT o.message_id,o.command_id,o.request_digest,o.source_run_id,o.source_turn_id,
       o.source_model_invocation_id,o.source_tool_call_id,o.source_effect_attempt_id,
       o.source_task_id,o.source_revision,o.followup_admission_artifact_id,
       o.followup_admission_digest,a.canonical_json,a.integrity_identifier,a.byte_length
       FROM agent_mail_outbox o
       JOIN runtime_sessions source ON source.session_id=o.source_session_id
       JOIN runtime_sessions target ON target.session_id=o.target_session_id
       JOIN agent_followup_admission_artifacts a
         ON a.artifact_id=o.followup_admission_artifact_id
       WHERE o.source_session_id=? AND o.submission_id=?
       AND o.target_session_id=? AND o.mode='trigger_turn'
       AND o.accepted_release_source_revision IS NULL
       AND target.parent_session_id=source.session_id
       AND source.workspace_id=target.workspace_id AND source.project_id=target.project_id
       AND source.workspace_digest=target.workspace_digest`,
    )
    .get(sourceSessionId, submissionId, targetSessionId);
  if (!outbox) return null;
  const admissionDigest = `sha256:${createHash('sha256').update(outbox.canonical_json).digest('hex')}`;
  if (
    admissionDigest !== outbox.followup_admission_digest ||
    outbox.integrity_identifier !== admissionDigest ||
    outbox.followup_admission_artifact_id !== `pa_${admissionDigest.slice(7)}` ||
    outbox.byte_length !== Buffer.byteLength(outbox.canonical_json, 'utf8')
  )
    return null;
  const admission = parse(outbox.canonical_json);
  const policy = record(admission.policy);
  const source = record(admission.source);
  const preparedTool = record(admission.preparedTool);
  const command = database
    .query<{ request_digest: string; committed_revision: number }, [string, string]>(
      'SELECT request_digest,committed_revision FROM runtime_command_receipts WHERE scope_session_id=? AND command_id=?',
    )
    .get(sourceSessionId, outbox.command_id);
  const accepted = database
    .query<{ sequence: number; event_json: string }, [string, string]>(
      `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='agent.mail_accepted'
       AND json_extract(event_json,'$.messageId')=?`,
    )
    .all(sourceSessionId, outbox.message_id);
  const reserved = database
    .query<{ sequence: number; event_json: string }, [string, string]>(
      `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='resource_budget.reserved'
       AND json_extract(event_json,'$.reservation.reservationId')=?`,
    )
    .all(sourceSessionId, String(admission.backupReservationId));
  if (accepted.length !== 1 || reserved.length !== 1) return null;
  const acceptedEvent = parse(accepted[0]!.event_json);
  const reservedEvent = parse(reserved[0]!.event_json);
  const backup = record(reservedEvent.reservation);
  const eventSource = record(acceptedEvent.source);
  if (
    admission.schema !== 'kite.cross-session-followup-admission.v2' ||
    policy.executionMode !== 'independent_turn_v2' ||
    admissionDigest !== outbox.followup_admission_digest ||
    admission.messageId !== outbox.message_id ||
    admission.submissionId !== submissionId ||
    admission.sourceSessionId !== sourceSessionId ||
    admission.targetSessionId !== targetSessionId ||
    admission.sourceRunId !== outbox.source_run_id ||
    admission.sourceTurnId !== outbox.source_turn_id ||
    admission.sourceModelInvocationId !== outbox.source_model_invocation_id ||
    admission.sourceToolCallId !== outbox.source_tool_call_id ||
    admission.sourceEffectAttemptId !== outbox.source_effect_attempt_id ||
    source.runId !== outbox.source_run_id ||
    source.turnId !== outbox.source_turn_id ||
    source.modelInvocationId !== outbox.source_model_invocation_id ||
    source.toolCallId !== outbox.source_tool_call_id ||
    source.effectAttemptId !== outbox.source_effect_attempt_id ||
    (source.sourceTaskId ?? null) !== outbox.source_task_id ||
    !validPreparedFollowupTool(preparedTool, source, policy) ||
    command?.request_digest !== outbox.request_digest ||
    command.committed_revision !== outbox.source_revision ||
    accepted[0]!.sequence > outbox.source_revision ||
    reserved[0]!.sequence > outbox.source_revision ||
    acceptedEvent.mode !== 'trigger_turn' ||
    acceptedEvent.messageId !== outbox.message_id ||
    acceptedEvent.submissionId !== submissionId ||
    acceptedEvent.followupAdmissionDigest !== admissionDigest ||
    acceptedEvent.senderAgentId !== sourceSessionId ||
    acceptedEvent.targetAgentId !== targetSessionId ||
    eventSource.runId !== outbox.source_run_id ||
    eventSource.turnId !== outbox.source_turn_id ||
    eventSource.modelInvocationId !== outbox.source_model_invocation_id ||
    eventSource.toolCallId !== outbox.source_tool_call_id ||
    eventSource.effectAttemptId !== outbox.source_effect_attempt_id ||
    (eventSource.sourceTaskId ?? null) !== outbox.source_task_id ||
    backup.reservationId !== admission.backupReservationId ||
    backup.runId !== admission.fundingRunId ||
    backup.invocationId !== submissionId ||
    !sameCanonicalValue(backup.executableUpperBound, admission.executableUpperBound) ||
    !DIGEST.test(String(policy.targetGrantDigest)) ||
    !['explore', 'plan', 'code', 'review'].includes(String(policy.targetRole))
  )
    return null;
  return Object.freeze({ admission, policy });
}

export type CrossSessionFollowupDeliveryForTarget =
  | Readonly<{
      status: 'received';
      messageId: string;
      sequence: number;
      targetRevision: number;
    }>
  | Readonly<{
      status: 'pending';
      messageId: string;
      sequence: number;
      source: Readonly<{
        runId: string;
        turnId: string;
        modelInvocationId: string;
        toolCallId: string;
        effectAttemptId: string;
        sourceTaskId?: string;
      }>;
      bodyRef: Readonly<{
        artifactId: string;
        kind: 'agent_mail';
        integrityIdentifier: string;
        byteLength: number;
      }>;
      bodyDigest: string;
      followupAdmissionRef: Ref;
      followupAdmissionDigest: string;
    }>;

/** Target-owner read for one low-information receive Event; it consumes no mail. */
export function readCrossSessionFollowupDeliveryForTarget(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
): CrossSessionFollowupDeliveryForTarget | null {
  if (!targetSessionId || !sourceSessionId || !submissionId || targetSessionId === sourceSessionId)
    invalid();
  const row = database
    .query<
      {
        message_id: string;
        admission_artifact_id: string | null;
        admission_digest: string | null;
        admission_json: string | null;
        admission_bytes: number | null;
        body_text: string;
        target_status: string | null;
      },
      [string, string, string]
    >(`SELECT o.message_id,o.followup_admission_artifact_id AS admission_artifact_id,
      o.followup_admission_digest AS admission_digest,a.canonical_json AS admission_json,
      a.byte_length AS admission_bytes,b.body_text,n.status AS target_status
      FROM agent_mail_outbox o
      JOIN runtime_sessions source ON source.session_id=o.source_session_id
      JOIN runtime_sessions target ON target.session_id=o.target_session_id
      JOIN agent_mail_bodies b ON b.session_id=o.source_session_id AND b.body_id=o.body_id
      LEFT JOIN agent_followup_admission_artifacts a
        ON a.artifact_id=o.followup_admission_artifact_id
      LEFT JOIN agent_nodes n ON n.session_id=target.session_id AND n.agent_id=target.session_id
      WHERE o.target_session_id=? AND o.source_session_id=? AND o.submission_id=?
        AND o.mode='trigger_turn' AND o.accepted_release_source_revision IS NULL
        AND target.parent_session_id=source.session_id
        AND source.workspace_id=target.workspace_id AND source.project_id=target.project_id
        AND source.workspace_digest=target.workspace_digest`)
    .get(targetSessionId, sourceSessionId, submissionId);
  if (!row) return null;
  const outbox = readCrossSessionMail(database, sourceSessionId, row.message_id);
  const admissionDigest = row.admission_json
    ? `sha256:${createHash('sha256').update(row.admission_json).digest('hex')}`
    : null;
  const bodyDigest = `sha256:${createHash('sha256').update(row.body_text).digest('hex')}`;
  if (
    !outbox ||
    outbox.mode !== 'trigger_turn' ||
    outbox.targetSessionId !== targetSessionId ||
    row.target_status === null ||
    row.target_status === 'context_unavailable' ||
    !row.admission_json ||
    !row.admission_artifact_id ||
    !row.admission_digest ||
    row.admission_bytes === null ||
    admissionDigest !== row.admission_digest ||
    row.admission_artifact_id !== `pa_${admissionDigest.slice(7)}` ||
    row.admission_bytes !== Buffer.byteLength(row.admission_json, 'utf8') ||
    bodyDigest !== outbox.bodyRef.integrityIdentifier ||
    outbox.bodyRef.artifactId !== `pa_${bodyDigest.slice(7)}` ||
    outbox.bodyRef.byteLength !== Buffer.byteLength(row.body_text, 'utf8') ||
    outbox.bodyRef.byteLength > 4096
  )
    invalid();
  const payload = parse(row.admission_json);
  if (
    (payload.schema !== 'kite.cross-session-followup-admission.v1' &&
      payload.schema !== 'kite.cross-session-followup-admission.v2') ||
    payload.sourceSessionId !== sourceSessionId ||
    payload.targetSessionId !== targetSessionId ||
    payload.submissionId !== submissionId ||
    payload.messageId !== row.message_id ||
    payload.bodyDigest !== bodyDigest
  )
    invalid();
  const received = readCrossSessionInboxReceipt(database, targetSessionId, row.message_id);
  if (received) {
    if (received.sourceSessionId !== sourceSessionId) invalid();
    return Object.freeze({
      status: 'received' as const,
      messageId: row.message_id,
      sequence: received.sequence,
      targetRevision: received.targetRevision,
    });
  }
  if (readCrossSessionFollowupRoute(database, targetSessionId, submissionId)) invalid();
  const ref: Ref = Object.freeze({
    artifactId: row.admission_artifact_id,
    kind: 'agent_followup_admission',
    integrityIdentifier: row.admission_digest,
    byteLength: row.admission_bytes,
  });
  return Object.freeze({
    status: 'pending' as const,
    messageId: row.message_id,
    sequence: nextCrossSessionTargetSequence(database, targetSessionId),
    source: Object.freeze({
      runId: outbox.sourceRunId,
      turnId: outbox.sourceTurnId,
      modelInvocationId: outbox.sourceModelInvocationId,
      toolCallId: outbox.sourceToolCallId,
      effectAttemptId: outbox.sourceEffectAttemptId,
      ...(outbox.sourceTaskId ? { sourceTaskId: outbox.sourceTaskId } : {}),
    }),
    bodyRef: Object.freeze({ ...outbox.bodyRef, kind: 'agent_mail' as const }),
    bodyDigest,
    followupAdmissionRef: ref,
    followupAdmissionDigest: row.admission_digest,
  });
}

/** Readback for every historical internal Run, including completed continuations. */
export function verifyPersistedCrossSessionFollowupRunStart(
  database: Database,
  run: Pick<
    RuntimeStoredRun,
    'sessionId' | 'runId' | 'startCommandId' | 'createdRevision' | 'originSessionId'
  >,
): boolean {
  if (
    run.originSessionId !== undefined ||
    !run.startCommandId.startsWith('followup:') ||
    run.startCommandId.length <= 'followup:'.length
  )
    return false;
  const submissionId = run.startCommandId.slice('followup:'.length);
  const preparedRow = database
    .query<{ sequence: number; event_json: string }, [string, string, string]>(
      `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='agent.followup_turn_prepared'
       AND json_extract(event_json,'$.targetRunId')=?
       AND json_extract(event_json,'$.submissionId')=? ORDER BY sequence DESC LIMIT 1`,
    )
    .get(run.sessionId, run.runId, submissionId);
  if (!preparedRow || preparedRow.sequence > run.createdRevision) return false;
  const prepared = parse(preparedRow.event_json);
  const grantRef = record(prepared.grantRef);
  const checkpointRef = record(prepared.checkpointRef);
  const sourceSessionId = String(prepared.sourceSessionId ?? '');
  const row = database
    .query<
      {
        message_id: string;
        admission_artifact_id: string | null;
        admission_digest: string | null;
        admission_json: string | null;
        admission_bytes: number | null;
        inbox_source_session_id: string | null;
        accepted_release_source_revision: number | null;
        accepted_release_reason: string | null;
        accepted_released_at_ms: number | null;
      },
      [string, string, string]
    >(`SELECT o.message_id,o.followup_admission_artifact_id AS admission_artifact_id,
      o.followup_admission_digest AS admission_digest,a.canonical_json AS admission_json,
      a.byte_length AS admission_bytes,i.source_session_id AS inbox_source_session_id,
      o.accepted_release_source_revision,o.accepted_release_reason,o.accepted_released_at_ms
      FROM agent_mail_outbox o
      JOIN runtime_sessions source ON source.session_id=o.source_session_id
      JOIN runtime_sessions target ON target.session_id=o.target_session_id
      JOIN agent_mail_inbox i ON i.target_session_id=o.target_session_id AND i.message_id=o.message_id
      LEFT JOIN agent_followup_admission_artifacts a
        ON a.artifact_id=o.followup_admission_artifact_id
      WHERE o.target_session_id=? AND o.source_session_id=? AND o.submission_id=?
        AND o.mode='trigger_turn'
        AND target.parent_session_id=source.session_id
        AND source.workspace_id=target.workspace_id AND source.project_id=target.project_id
        AND source.workspace_digest=target.workspace_digest`)
    .get(run.sessionId, sourceSessionId, submissionId);
  if (
    !row ||
    row.inbox_source_session_id !== sourceSessionId ||
    !row.admission_json ||
    !row.admission_digest ||
    !row.admission_artifact_id ||
    row.admission_bytes === null ||
    `sha256:${createHash('sha256').update(row.admission_json).digest('hex')}` !==
      row.admission_digest ||
    row.admission_artifact_id !== `pa_${row.admission_digest.slice(7)}` ||
    row.admission_bytes !== Buffer.byteLength(row.admission_json, 'utf8') ||
    !DIGEST.test(String(prepared.grantDigest)) ||
    grantRef.integrityIdentifier !== prepared.grantDigest ||
    checkpointRef.kind !== 'subagent_checkpoint'
  )
    return false;
  const admission = parse(row.admission_json);
  const grant = readCrossSessionFollowupGrant(database, String(grantRef.artifactId));
  const checkpoint = database
    .query<{ canonical_json: string; integrity_identifier: string; byte_length: number }, [string]>(
      'SELECT canonical_json,integrity_identifier,byte_length FROM subagent_checkpoint_artifacts WHERE artifact_id=?',
    )
    .get(String(checkpointRef.artifactId));
  if (!grant || !checkpoint) return false;
  const grantPayload = parse(grant.canonicalJson);
  const checkpointPayload = parse(checkpoint.canonical_json);
  const expiredReleased =
    row.accepted_release_source_revision === null ||
    readProvenUnfundedExpiredFollowupRelease(database, sourceSessionId, run.sessionId, submissionId)
      ?.targetRunId === run.runId;
  return (
    expiredReleased &&
    prepared.taskId === grantPayload.taskId &&
    prepared.sourceSessionId === sourceSessionId &&
    prepared.targetRunId === run.runId &&
    grant.ref.integrityIdentifier === grantRef.integrityIdentifier &&
    grant.ref.byteLength === grantRef.byteLength &&
    (grantPayload.schema === 'kite.child-followup-grant.v1' ||
      grantPayload.schema === 'kite.child-followup-grant.v2') &&
    grantPayload.sourceSessionId === sourceSessionId &&
    grantPayload.targetSessionId === run.sessionId &&
    grantPayload.submissionId === submissionId &&
    grantPayload.targetRunId === run.runId &&
    sameCanonicalValue(grantPayload.checkpointRef, checkpointRef) &&
    sameCanonicalValue(grantPayload.sourceAdmissionRef, {
      artifactId: row.admission_artifact_id,
      kind: 'agent_followup_admission',
      integrityIdentifier: row.admission_digest,
      byteLength: row.admission_bytes,
    }) &&
    grantPayload.sourceAdmissionDigest === row.admission_digest &&
    admission.sourceSessionId === sourceSessionId &&
    admission.targetSessionId === run.sessionId &&
    admission.submissionId === submissionId &&
    admission.messageId === row.message_id &&
    checkpointRef.integrityIdentifier === checkpoint.integrity_identifier &&
    checkpointRef.byteLength === checkpoint.byte_length &&
    checkpointRef.artifactId === `pa_${checkpoint.integrity_identifier.slice(7)}` &&
    `sha256:${createHash('sha256').update(checkpoint.canonical_json).digest('hex')}` ===
      checkpoint.integrity_identifier &&
    checkpoint.byte_length === Buffer.byteLength(checkpoint.canonical_json, 'utf8') &&
    checkpointPayload.childSessionId === run.sessionId &&
    checkpointPayload.terminalStatus === 'completed'
  );
}

/** An independent followup is funded by one durable source backup for its entire target Run. */
function verifyIndependentChildFollowupWork(
  database: Database,
  targetSessionId: string,
  state: RecordValue,
  events: readonly RecordValue[],
  grant: NonNullable<ReturnType<typeof readCrossSessionFollowupGrant>>,
): boolean {
  const active = record(state.activeFollowupTurn);
  const origin = record(state.childSessionOrigin);
  const terminal = record(origin.terminal);
  const sourceSessionId = String(active.sourceSessionId ?? '');
  const submissionId = String(active.submissionId ?? '');
  const targetRunId = String(active.targetRunId ?? '');
  const grantPayload = parse(grant.canonicalJson);
  const grantBudget = record(grantPayload.budget);
  const grantRef = record(active.grantRef);
  const admissionRow = readCrossSessionFollowupAdmissionBySubmissionForTarget(
    database,
    targetSessionId,
    sourceSessionId,
    submissionId,
  );
  const admission = admissionRow ? parse(admissionRow.admission.canonicalJson) : {};
  const run = database
    .query<
      { status: string; start_command_id: string; created_revision: number },
      [string, string]
    >(
      'SELECT status,start_command_id,created_revision FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(targetSessionId, targetRunId);
  const ledger = record(state.resourceBudget);
  const allowed = Array.isArray(grantPayload.allowedTools) ? grantPayload.allowedTools : [];
  const external = events.filter((event) =>
    ['model.invocation_prepared', 'model.invocation_attempt_started', 'tool.started'].includes(
      String(event.type),
    ),
  );
  if (
    external.length !== 1 ||
    events.some((event) => event.type === 'capability.subagent_dispatch_intent_recorded') ||
    !run ||
    !['running', 'waiting'].includes(run.status) ||
    run.start_command_id !== `followup:${submissionId}` ||
    !verifyPersistedCrossSessionFollowupRunStart(database, {
      sessionId: targetSessionId,
      runId: targetRunId,
      startCommandId: run.start_command_id,
      createdRevision: run.created_revision,
    }) ||
    terminal.status !== 'completed' ||
    sourceSessionId !== origin.parentSessionId ||
    record(state.turn).turnId !== targetRunId ||
    record(state.turn).status !== 'active' ||
    state.activeTaskId !== active.taskId ||
    ledger.runId !== targetRunId ||
    ledger.status !== 'active' ||
    active.grantDigest !== grant.ref.integrityIdentifier ||
    grantRef.integrityIdentifier !== grant.ref.integrityIdentifier ||
    !admissionRow ||
    !validIndependentFollowupGrant(database, {
      sourceSessionId,
      targetSessionId,
      submissionId,
      intentRole: String(origin.role ?? ''),
      origin,
      targetLedger: ledger,
      grantPayload,
      grantBudget,
      admission,
      backupState: 'dispatch_started',
    })
  )
    return false;
  if (!hasIndependentFollowupSourceActivation(database, sourceSessionId, admission)) return false;
  const work = external[0]!;
  if (work.type === 'tool.started') {
    const toolCallId = String(work.toolCallId ?? '');
    const call = record(record(record(state.tools).calls)[toolCallId]);
    const parentModel = record(record(state.modelInvocations)[String(call.modelInvocationId)]);
    const parentModelReservation = record(
      record(ledger.reservations)[String(record(parentModel.budget).reservationId)],
    );
    const route = readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
    return (
      toolCallId.length > 0 &&
      call.toolCallId === toolCallId &&
      typeof call.name === 'string' &&
      allowed.includes(call.name) &&
      call.name !== 'task' &&
      call.createdAtTurnId === targetRunId &&
      call.taskId === active.taskId &&
      typeof call.modelMessageId === 'string' &&
      call.modelMessageId.length > 0 &&
      parentModel.invocationId === call.modelInvocationId &&
      parentModel.status === 'completed' &&
      record(parentModel.responseArtifact).kind === 'model_response' &&
      parentModelReservation.runId === targetRunId &&
      parentModelReservation.resourceKind === 'model' &&
      parentModelReservation.state === 'reconciled' &&
      route?.route === 'new_turn' &&
      route.targetRunId === targetRunId
    );
  }
  const invocationId = String(work.invocationId ?? '');
  const model = record(record(state.modelInvocations)[invocationId]);
  const modelBudget = record(model.budget);
  const reservationId = String(modelBudget.reservationId ?? '');
  const local = record(record(ledger.reservations)[reservationId]);
  if (
    !invocationId ||
    model.invocationId !== invocationId ||
    modelBudget.kind !== 'reservation' ||
    local.reservationId !== reservationId ||
    local.runId !== targetRunId ||
    local.resourceKind !== 'model' ||
    local.invocationId !== `model-invocation:${invocationId}`
  )
    return false;
  if (work.type === 'model.invocation_prepared') {
    const surface = record(model.surfaceArtifact);
    if (
      work.purpose !== 'primary_agent' ||
      model.status !== 'prepared' ||
      model.attempts !== 0 ||
      local.state !== 'reserved' ||
      surface.kind !== 'model_surface' ||
      !DIGEST.test(String(surface.integrityIdentifier))
    )
      return false;
    try {
      const stored = createKiteHomeArtifactStore(database).readModel({
        artifactId: String(surface.artifactId),
        kind: 'model_surface',
        integrityIdentifier: String(surface.integrityIdentifier),
        byteLength: Number(surface.byteLength),
      });
      return matchesModelArtifactReference('model_surface', stored.canonicalJson, surface);
    } catch {
      return false;
    }
  }
  const route = readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
  return (
    route?.route === 'new_turn' &&
    route.targetRunId === targetRunId &&
    Number(model.attempts) >= 1 &&
    local.state === 'dispatch_started' &&
    events.some(
      (event) =>
        event.type === 'resource_budget.dispatch_started' && event.reservationId === reservationId,
    )
  );
}

function hasIndependentFollowupSourceActivation(
  database: Database,
  sourceSessionId: string,
  admission: RecordValue,
): boolean {
  const count = database
    .query<{ count: number }, [string, string]>(
      `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='resource_budget.dispatch_started'
       AND json_extract(event_json,'$.reservationId')=?`,
    )
    .get(sourceSessionId, String(admission.backupReservationId))?.count;
  return count === 1;
}

export interface IndependentCrossSessionFollowupActivation {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly backupReservationId: string;
  readonly grantDigest: string;
  readonly sourceRevision: number;
  readonly createdAtMs: number;
}

/** The source's single dispatch Event is the immutable v2 activation receipt. */
export function activateIndependentCrossSessionFollowupTurnInTransaction(
  database: Database,
  input: Readonly<{
    sourceSessionId: string;
    targetSessionId: string;
    submissionId: string;
    targetRunId: string;
    grantDigest: string;
    targetRevision: number;
    sourceRevision: number;
    createdAtMs: number;
    sourceSnapshot: Readonly<RecordValue>;
    events: readonly Readonly<RecordValue>[];
  }>,
): IndependentCrossSessionFollowupActivation {
  requireTransaction(database);
  const targetRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
       ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  const target = targetRow ? parse(targetRow.state_json) : {};
  const followup = record(target.activeFollowupTurn);
  const origin = record(target.childSessionOrigin);
  const ledger = record(target.resourceBudget);
  const ref = record(followup.grantRef);
  const grant = readCrossSessionFollowupGrant(database, String(ref.artifactId));
  const payload = grant ? parse(grant.canonicalJson) : {};
  const admissionRow = readCrossSessionFollowupAdmissionBySubmissionForTarget(
    database,
    input.targetSessionId,
    input.sourceSessionId,
    input.submissionId,
  );
  const admission = admissionRow ? parse(admissionRow.admission.canonicalJson) : {};
  const acceptedProof = readAcceptedIndependentFollowupSourcePolicyProof(
    database,
    input.targetSessionId,
    input.sourceSessionId,
    input.submissionId,
  );
  const sourceTool = record(
    record(record(input.sourceSnapshot.tools).calls)[String(admission.sourceToolCallId)],
  );
  const sourceInvocation = record(
    record(record(input.sourceSnapshot.capabilities).invocations)[
      String(record(admission.preparedTool).invocationId)
    ],
  );
  const intent = database
    .query<{ role: string }, [string]>(
      'SELECT role FROM child_session_intents WHERE child_thread_id=?',
    )
    .get(input.targetSessionId);
  const sourceActive = record(input.sourceSnapshot.resourceBudget);
  const sourceRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
       ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.sourceSessionId);
  const sourceLedger =
    sourceActive.runId === admission.fundingRunId
      ? sourceActive
      : record(
          record(input.sourceSnapshot.retainedResourceBudgets)[String(admission.fundingRunId)],
        );
  const backup = record(record(sourceLedger.reservations)[String(admission.backupReservationId)]);
  const run = database
    .query<
      { status: string; start_command_id: string; created_revision: number },
      [string, string]
    >(
      'SELECT status,start_command_id,created_revision FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  if (
    !targetRow ||
    targetRow.revision !== input.targetRevision ||
    !sourceRow ||
    sourceRow.revision !== input.sourceRevision ||
    !sameCanonicalValue(parse(sourceRow.state_json), input.sourceSnapshot) ||
    !run ||
    !['queued', 'running', 'waiting'].includes(run.status) ||
    run.start_command_id !== `followup:${input.submissionId}` ||
    !verifyPersistedCrossSessionFollowupRunStart(database, {
      sessionId: input.targetSessionId,
      runId: input.targetRunId,
      startCommandId: run.start_command_id,
      createdRevision: run.created_revision,
    }) ||
    !grant ||
    grant.ref.integrityIdentifier !== input.grantDigest ||
    followup.grantDigest !== input.grantDigest ||
    ref.integrityIdentifier !== input.grantDigest ||
    followup.targetRunId !== input.targetRunId ||
    followup.submissionId !== input.submissionId ||
    !admissionRow ||
    !acceptedProof ||
    sourceTool.name !== 'followup_task' ||
    sourceTool.status !== 'succeeded' ||
    sourceTool.modelInvocationId !== admission.sourceModelInvocationId ||
    sourceInvocation.status !== 'succeeded' ||
    sourceInvocation.toolCallId !== admission.sourceToolCallId ||
    sourceInvocation.capabilityId !== 'builtin:followup_task' ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 1 ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0 ||
    input.events.length !== 1 ||
    input.events[0]?.type !== 'resource_budget.dispatch_started' ||
    input.events[0]?.reservationId !== admission.backupReservationId ||
    !validIndependentFollowupGrant(database, {
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      submissionId: input.submissionId,
      intentRole: intent?.role ?? '',
      origin,
      targetLedger: ledger,
      grantPayload: payload,
      grantBudget: record(payload.budget),
      admission,
      backupState: 'dispatch_started',
    }) ||
    backup.state !== 'dispatch_started'
  )
    invalid();
  return Object.freeze({
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    submissionId: input.submissionId,
    targetRunId: input.targetRunId,
    backupReservationId: String(admission.backupReservationId),
    grantDigest: input.grantDigest,
    sourceRevision: input.sourceRevision,
    createdAtMs: input.createdAtMs,
  });
}

/** Active-turn recovery proof. Historical turns use the immutable terminal audit Event. */
export function readIndependentCrossSessionFollowupActivation(
  database: Database,
  sourceSessionId: string,
  submissionId: string,
): IndependentCrossSessionFollowupActivation | null {
  const row = database
    .query<
      { target_session_id: string; canonical_json: string; source_run_id: string },
      [string, string]
    >(
      `SELECT o.target_session_id,a.canonical_json,o.source_run_id FROM agent_mail_outbox o
       JOIN agent_followup_admission_artifacts a
         ON a.artifact_id=o.followup_admission_artifact_id
       WHERE o.source_session_id=? AND o.submission_id=? AND o.mode='trigger_turn'`,
    )
    .get(sourceSessionId, submissionId);
  if (!row) return null;
  const admission = parse(row.canonical_json);
  if (admission.schema !== 'kite.cross-session-followup-admission.v2') return null;
  const eventRow = database
    .query<{ sequence: number; event_json: string; created_at: number }, [string, string]>(
      `SELECT sequence,event_json,created_at FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='resource_budget.dispatch_started'
       AND json_extract(event_json,'$.reservationId')=?`,
    )
    .all(sourceSessionId, String(admission.backupReservationId));
  if (eventRow.length !== 1) return null;
  const sourceRow = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(sourceSessionId);
  const source = sourceRow ? parse(sourceRow.state_json) : {};
  const active = record(source.resourceBudget);
  const ledger =
    active.runId === row.source_run_id
      ? active
      : record(record(source.retainedResourceBudgets)[row.source_run_id]);
  const backup = record(record(ledger.reservations)[String(admission.backupReservationId)]);
  if (!['dispatch_started', 'reconciled', 'unknown'].includes(String(backup.state))) return null;
  const targetRow = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(row.target_session_id);
  const target = targetRow ? parse(targetRow.state_json) : {};
  const followup = record(target.activeFollowupTurn);
  const grant = readCrossSessionFollowupGrant(
    database,
    String(record(followup.grantRef).artifactId),
  );
  if (
    !grant ||
    followup.submissionId !== submissionId ||
    followup.grantDigest !== grant.ref.integrityIdentifier ||
    parse(grant.canonicalJson).schema !== 'kite.child-followup-grant.v2'
  )
    return null;
  return Object.freeze({
    sourceSessionId,
    targetSessionId: row.target_session_id,
    submissionId,
    targetRunId: String(followup.targetRunId),
    backupReservationId: String(admission.backupReservationId),
    grantDigest: grant.ref.integrityIdentifier,
    sourceRevision: eventRow[0]!.sequence,
    createdAtMs: eventRow[0]!.created_at * 1000,
  });
}

/** Store13 exception for already sealed children, preserving v1 first-model replay. */
export function verifyCompletedChildFollowupModelWork<Event, State>(
  database: Database,
  transaction: RuntimeTransactionInput<Event, State>,
): boolean {
  const events = transaction.events.map((event) => record(event));
  const state = record(transaction.snapshot);
  const active = record(state.activeFollowupTurn);
  const grantRef = record(active.grantRef);
  const grant = readCrossSessionFollowupGrant(database, String(grantRef.artifactId));
  if (grant && parse(grant.canonicalJson).schema === 'kite.child-followup-grant.v2') {
    return verifyIndependentChildFollowupWork(
      database,
      transaction.sessionId,
      state,
      events,
      grant,
    );
  }
  if (
    events.some(
      (event) =>
        event.type === 'tool.started' ||
        event.type === 'capability.subagent_dispatch_intent_recorded',
    )
  )
    return false;
  const prepared = events.filter((event) => event.type === 'model.invocation_prepared');
  const attempted = events.filter((event) => event.type === 'model.invocation_attempt_started');
  if (
    (prepared.length === 1) === (attempted.length === 1) ||
    prepared.length > 1 ||
    attempted.length > 1
  )
    return false;
  const origin = record(state.childSessionOrigin);
  const terminal = record(origin.terminal);
  const sourceSessionId = String(active.sourceSessionId ?? '');
  const submissionId = String(active.submissionId ?? '');
  const targetRunId = String(active.targetRunId ?? '');
  const run = database
    .query<
      { status: string; start_command_id: string; phase: string; created_revision: number },
      [string, string]
    >(
      'SELECT status,start_command_id,phase,created_revision FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(transaction.sessionId, targetRunId);
  if (
    terminal.status !== 'completed' ||
    sourceSessionId !== origin.parentSessionId ||
    !submissionId ||
    !targetRunId ||
    !active.taskId ||
    state.turn === undefined ||
    record(state.turn).turnId !== targetRunId ||
    record(state.turn).status !== 'active' ||
    state.activeTaskId !== active.taskId ||
    !run ||
    !['running', 'waiting'].includes(run.status) ||
    run.start_command_id !== `followup:${submissionId}` ||
    !verifyPersistedCrossSessionFollowupRunStart(database, {
      sessionId: transaction.sessionId,
      runId: targetRunId,
      startCommandId: `followup:${submissionId}`,
      createdRevision: run.created_revision,
    })
  )
    return false;
  const admission = readCrossSessionFollowupAdmissionBySubmissionForTarget(
    database,
    transaction.sessionId,
    sourceSessionId,
    submissionId,
  );
  if (
    !grant ||
    grant.ref.integrityIdentifier !== active.grantDigest ||
    grant.ref.integrityIdentifier !== grantRef.integrityIdentifier ||
    !admission ||
    record(parse(grant.canonicalJson).budget).maxToolInvocations !== 0
  )
    return false;
  const modelEvent = prepared[0] ?? attempted[0]!;
  const invocationId = String(modelEvent.invocationId ?? '');
  const model = record(record(state.modelInvocations)[invocationId]);
  const modelBudget = record(model.budget);
  const ledger = record(state.resourceBudget);
  const reservationId = String(modelBudget.reservationId ?? '');
  const local = record(record(ledger.reservations)[reservationId]);
  if (
    !invocationId ||
    ledger.runId !== targetRunId ||
    ledger.status !== 'active' ||
    model.invocationId !== invocationId ||
    modelBudget.kind !== 'reservation' ||
    local.reservationId !== reservationId ||
    local.runId !== targetRunId ||
    local.resourceKind !== 'model' ||
    local.invocationId !== `model-invocation:${invocationId}`
  )
    return false;
  if (prepared.length === 1) {
    const surface = record(model.surfaceArtifact);
    if (
      modelEvent.purpose !== 'primary_agent' ||
      model.status !== 'prepared' ||
      model.attempts !== 0 ||
      local.state !== 'reserved' ||
      !Number.isSafeInteger(model.estimatedInputTokens) ||
      surface.kind !== 'model_surface' ||
      !DIGEST.test(String(surface.integrityIdentifier))
    )
      return false;
    try {
      const stored = createKiteHomeArtifactStore(database).readModel({
        artifactId: String(surface.artifactId),
        kind: 'model_surface',
        integrityIdentifier: String(surface.integrityIdentifier),
        byteLength: Number(surface.byteLength),
      });
      return matchesModelArtifactReference('model_surface', stored.canonicalJson, surface);
    } catch {
      return false;
    }
  }
  const route = readCrossSessionFollowupRoute(database, transaction.sessionId, submissionId);
  const activation = readCrossSessionFollowupActivationReceipt(
    database,
    sourceSessionId,
    submissionId,
  );
  return Boolean(
    route &&
      route.route === 'new_turn' &&
      route.targetRunId === targetRunId &&
      route.invocationId === invocationId &&
      route.reservationId === reservationId &&
      activation &&
      activation.targetSessionId === transaction.sessionId &&
      activation.targetRunId === targetRunId &&
      activation.modelInvocationId === invocationId &&
      model.attempts === 1 &&
      local.state === 'dispatch_started' &&
      events.some(
        (event) =>
          event.type === 'resource_budget.dispatch_started' &&
          event.reservationId === reservationId,
      ),
  );
}

/** Target Event and inbox row are committed in one fenced target transaction. */
export function receiveCrossSessionFollowupInTransaction(
  database: Database,
  input: {
    readonly targetSessionId: string;
    readonly sourceSessionId: string;
    readonly messageId: string;
    readonly submissionId: string;
    readonly targetRevision: number;
    readonly receivedAtMs: number;
  },
): Readonly<{ sequence: number; targetRevision: number }> {
  requireTransaction(database);
  const delivery = readCrossSessionFollowupDeliveryForTarget(
    database,
    input.targetSessionId,
    input.sourceSessionId,
    input.submissionId,
  );
  if (!delivery || delivery.messageId !== input.messageId) invalid();
  if (delivery.status === 'received')
    return { sequence: delivery.sequence, targetRevision: delivery.targetRevision };
  return receiveCrossSessionQueueMailInTransaction(database, input);
}

type RecordValue = Record<string, unknown>;
type Ref = Readonly<{
  artifactId: string;
  kind: 'agent_followup_admission';
  integrityIdentifier: string;
  byteLength: number;
}>;

export interface CrossSessionFollowupSourceIntent extends CrossSessionMailIntent {
  readonly submissionId: string;
  readonly acceptedEvent: Readonly<RecordValue>;
  readonly reservationEvent: Readonly<RecordValue>;
  readonly admission: Readonly<{
    ref: Ref;
    digest: string;
    canonicalJson: string;
    createdAt: number;
  }>;
  readonly sourceSnapshot: Readonly<RecordValue>;
}

export interface CrossSessionFollowupAcceptance {
  readonly outbox: CrossSessionMailOutboxRecord;
  readonly submissionId: string;
  readonly admissionRef: Ref;
  readonly backupReservationId: string;
}

export interface CrossSessionFollowupRouteIntent {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly messageId: string;
  readonly submissionId: string;
  readonly route: 'current_turn' | 'new_turn';
  readonly targetRunId: string;
  readonly taskId: string;
  readonly invocationId: string;
  readonly modelAdmissionId: string;
  readonly reservationId: string;
  readonly routedRevision: number;
  readonly createdAtMs: number;
  readonly routedEvent: Readonly<RecordValue>;
  readonly preparedEvent: Readonly<RecordValue>;
  readonly targetSnapshot: Readonly<RecordValue>;
}

export type CrossSessionFollowupRouteReceipt = Readonly<
  Pick<
    CrossSessionFollowupRouteIntent,
    | 'sourceSessionId'
    | 'targetSessionId'
    | 'messageId'
    | 'submissionId'
    | 'route'
    | 'targetRunId'
    | 'taskId'
    | 'invocationId'
    | 'modelAdmissionId'
    | 'reservationId'
    | 'routedRevision'
    | 'createdAtMs'
  >
>;

export interface CrossSessionFollowupFundingIntent {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly messageId: string;
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly modelInvocationId: string;
  readonly targetRevision: number;
  readonly surfaceArtifact: Readonly<{
    artifactId: string;
    kind: 'model_surface';
    integrityIdentifier: string;
    byteLength: number;
  }>;
  readonly surfaceInputTokens: number;
  readonly surfaceMaxOutputTokens: number;
  readonly sourceRevision: number;
  readonly createdAtMs: number;
  readonly replacementEvent: Readonly<RecordValue>;
  readonly sourceSnapshot: Readonly<RecordValue>;
}

export interface CrossSessionFollowupFundingReceipt {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly messageId: string;
  readonly submissionId: string;
  readonly fundingRunId: string;
  readonly backupReservationId: string;
  readonly turnReservationId: string;
  readonly modelReservationId: string;
  readonly targetModelReservationId: string;
  readonly targetBudgetDigest: string;
  readonly targetRunId: string;
  readonly modelInvocationId: string;
  readonly surfaceArtifactId: string;
  readonly surfaceDigest: string;
  readonly surfaceInputTokens: number;
  readonly surfaceMaxOutputTokens: number;
  readonly targetRevision: number;
  readonly sourceRevision: number;
  readonly createdAtMs: number;
}

export interface CrossSessionFollowupActivationIntent {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly modelInvocationId: string;
  readonly sourceRevision: number;
  readonly createdAtMs: number;
  readonly events: readonly Readonly<RecordValue>[];
  readonly sourceSnapshot: Readonly<RecordValue>;
}

export interface CrossSessionFollowupActivationReceipt {
  readonly sourceSessionId: string;
  readonly submissionId: string;
  readonly targetSessionId: string;
  readonly targetRunId: string;
  readonly modelInvocationId: string;
  readonly sourceRevision: number;
  readonly activatedAtMs: number;
}

export function activateCrossSessionFollowupFundingInTransaction(
  database: Database,
  input: CrossSessionFollowupActivationIntent,
): CrossSessionFollowupActivationReceipt {
  requireTransaction(database);
  const funding = readCrossSessionFollowupFundingReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  const prior = readCrossSessionFollowupActivationReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  if (
    !funding ||
    funding.targetSessionId !== input.targetSessionId ||
    funding.targetRunId !== input.targetRunId ||
    funding.modelInvocationId !== input.modelInvocationId
  )
    invalid();
  if (prior) {
    if (prior.sourceRevision !== input.sourceRevision || prior.activatedAtMs !== input.createdAtMs)
      conflict();
    return prior;
  }
  const route = readCrossSessionFollowupRoute(database, input.targetSessionId, input.submissionId);
  const targetRow = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(input.targetSessionId);
  const target = targetRow ? parse(targetRow.state_json) : {};
  const model = record(record(target.modelInvocations)[input.modelInvocationId]);
  const modelBudget = record(model.budget);
  const localReservation = record(
    record(record(target.resourceBudget).reservations)[funding.targetModelReservationId],
  );
  const targetBudgetDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(record(record(target.resourceBudget).budget)))
    .digest('hex')}`;
  const sourceBudget = record(input.sourceSnapshot.resourceBudget);
  const ledger =
    sourceBudget.runId === funding.fundingRunId
      ? sourceBudget
      : record(record(input.sourceSnapshot.retainedResourceBudgets)[funding.fundingRunId]);
  const reservations = record(ledger.reservations);
  const turn = record(reservations[funding.turnReservationId]);
  const sourceModel = record(reservations[funding.modelReservationId]);
  const dispatched = input.events.filter(
    (event) => event.type === 'resource_budget.dispatch_started',
  );
  const ids = dispatched.map((event) => event.reservationId);
  if (
    !route ||
    route.messageId !== funding.messageId ||
    route.targetRunId !== input.targetRunId ||
    route.invocationId !== input.modelInvocationId ||
    route.reservationId !== funding.targetModelReservationId ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < funding.sourceRevision ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < funding.createdAtMs ||
    targetBudgetDigest !== funding.targetBudgetDigest ||
    model.status !== 'prepared' ||
    model.attempts !== 0 ||
    modelBudget.reservationId !== funding.targetModelReservationId ||
    record(model.surfaceArtifact).artifactId !== funding.surfaceArtifactId ||
    localReservation.state !== 'reserved' ||
    input.events.length !== 2 ||
    dispatched.length !== 2 ||
    !ids.includes(funding.turnReservationId) ||
    !ids.includes(funding.modelReservationId) ||
    turn.state !== 'dispatch_started' ||
    sourceModel.state !== 'dispatch_started' ||
    turn.runId !== funding.fundingRunId ||
    sourceModel.runId !== funding.fundingRunId ||
    Object.values(reservations).some((item) => record(item).state === 'unknown')
  )
    invalid();
  const changed = database
    .query(`UPDATE agent_followup_funding_receipts
    SET activated_source_revision=?,activated_at_ms=?
    WHERE source_session_id=? AND submission_id=? AND activated_source_revision IS NULL`)
    .run(
      input.sourceRevision,
      input.createdAtMs,
      input.sourceSessionId,
      input.submissionId,
    ).changes;
  if (changed !== 1) conflict();
  return Object.freeze({
    sourceSessionId: input.sourceSessionId,
    submissionId: input.submissionId,
    targetSessionId: input.targetSessionId,
    targetRunId: input.targetRunId,
    modelInvocationId: input.modelInvocationId,
    sourceRevision: input.sourceRevision,
    activatedAtMs: input.createdAtMs,
  });
}

export function readCrossSessionFollowupActivationReceipt(
  database: Database,
  sourceSessionId: string,
  submissionId: string,
): CrossSessionFollowupActivationReceipt | null {
  const row = database
    .query<
      {
        target_session_id: string;
        target_run_id: string;
        model_invocation_id: string;
        activated_source_revision: number | null;
        activated_at_ms: number | null;
      },
      [string, string]
    >(`SELECT target_session_id,target_run_id,model_invocation_id,
    activated_source_revision,activated_at_ms FROM agent_followup_funding_receipts
    WHERE source_session_id=? AND submission_id=?`)
    .get(sourceSessionId, submissionId);
  if (!row?.activated_source_revision || row.activated_at_ms === null) return null;
  return Object.freeze({
    sourceSessionId,
    submissionId,
    targetSessionId: row.target_session_id,
    targetRunId: row.target_run_id,
    modelInvocationId: row.model_invocation_id,
    sourceRevision: row.activated_source_revision,
    activatedAtMs: row.activated_at_ms,
  });
}

export interface CrossSessionPreparedFollowupRecoveryProof {
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly invocationId: string;
  readonly modelReservationId: string;
  readonly preparedStateRevision: number;
  readonly surfaceRef: Readonly<{
    artifactId: string;
    kind: 'model_surface';
    integrityIdentifier: string;
    byteLength: number;
  }>;
  readonly surfaceDigest: string;
  readonly estimatedInputTokens: number;
  readonly activationSourceRevision: number;
}

/** A single target-owner snapshot proving that a routed model has never begun dispatch. */
export function readPreparedCrossSessionFollowupRecoveryProof(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
): CrossSessionPreparedFollowupRecoveryProof | null {
  const accepted = readAcceptedIndependentFollowupSourcePolicyProof(
    database,
    targetSessionId,
    sourceSessionId,
    submissionId,
  );
  if (accepted)
    return readPreparedIndependentFollowupRecoveryProof(
      database,
      targetSessionId,
      sourceSessionId,
      submissionId,
      accepted,
    );
  const route = readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
  const funding = readCrossSessionFollowupFundingReceipt(database, sourceSessionId, submissionId);
  const activation = readCrossSessionFollowupActivationReceipt(
    database,
    sourceSessionId,
    submissionId,
  );
  const terminal = readCrossSessionFollowupTerminalReceipt(database, sourceSessionId, submissionId);
  const target = database
    .query<
      {
        revision: number;
        parent_session_id: string | null;
        state_json: string;
        snapshot_revision: number;
      },
      [string]
    >(`SELECT s.revision,s.parent_session_id,p.state_json,p.revision AS snapshot_revision
      FROM runtime_sessions s JOIN runtime_snapshots p ON p.session_id=s.session_id
      WHERE s.session_id=?`)
    .get(targetSessionId);
  if (
    !route ||
    route.route !== 'new_turn' ||
    route.sourceSessionId !== sourceSessionId ||
    !funding ||
    funding.targetSessionId !== targetSessionId ||
    funding.messageId !== route.messageId ||
    funding.targetRunId !== route.targetRunId ||
    funding.modelInvocationId !== route.invocationId ||
    funding.targetModelReservationId !== route.reservationId ||
    !activation ||
    activation.targetSessionId !== targetSessionId ||
    activation.targetRunId !== route.targetRunId ||
    activation.modelInvocationId !== route.invocationId ||
    terminal ||
    !target ||
    target.parent_session_id !== sourceSessionId ||
    target.revision !== target.snapshot_revision ||
    target.revision < route.routedRevision
  )
    return null;
  const state = parse(target.state_json);
  const model = record(record(state.modelInvocations)[route.invocationId]);
  const budget = record(model.budget);
  const surface = record(model.surfaceArtifact);
  const ledger = record(state.resourceBudget);
  const local = record(record(ledger.reservations)[route.reservationId]);
  const active = record(state.activeFollowupTurn);
  const run = database
    .query<
      { status: string; start_command_id: string; created_revision: number },
      [string, string]
    >(
      'SELECT status,start_command_id,created_revision FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(targetSessionId, route.targetRunId);
  const inbox = database
    .query<
      {
        source_session_id: string;
        target_run_id: string | null;
        prepared_invocation_id: string | null;
        prepared_model_admission_id: string | null;
      },
      [string, string]
    >(`SELECT source_session_id,target_run_id,prepared_invocation_id,prepared_model_admission_id
      FROM agent_mail_inbox WHERE target_session_id=? AND message_id=?`)
    .get(targetSessionId, route.messageId);
  const attempted = database
    .query<{ found: number }, [string, string, string]>(
      `SELECT 1 AS found FROM runtime_events WHERE session_id=?
       AND ((json_extract(event_json,'$.type')='model.invocation_attempt_started'
         AND json_extract(event_json,'$.invocationId')=?)
       OR (json_extract(event_json,'$.type')='resource_budget.dispatch_started'
         AND json_extract(event_json,'$.reservationId')=?)) LIMIT 1`,
    )
    .get(targetSessionId, route.invocationId, route.reservationId);
  const effect = database
    .query<{ found: number }, [string]>(
      'SELECT 1 AS found FROM runtime_effect_leases WHERE session_id=? LIMIT 1',
    )
    .get(targetSessionId);
  if (
    !run ||
    !['running', 'waiting'].includes(run.status) ||
    run.start_command_id !== `followup:${submissionId}` ||
    active.sourceSessionId !== sourceSessionId ||
    active.submissionId !== submissionId ||
    active.targetRunId !== route.targetRunId ||
    active.taskId !== route.taskId ||
    model.status !== 'prepared' ||
    model.invocationId !== route.invocationId ||
    model.attempts !== 0 ||
    !Number.isSafeInteger(model.estimatedInputTokens) ||
    model.estimatedInputTokens !== funding.surfaceInputTokens ||
    budget.kind !== 'reservation' ||
    budget.reservationId !== route.reservationId ||
    ledger.status !== 'active' ||
    ledger.runId !== route.targetRunId ||
    local.state !== 'reserved' ||
    local.runId !== route.targetRunId ||
    local.invocationId !== `model-invocation:${route.invocationId}` ||
    local.resourceKind !== 'model' ||
    surface.kind !== 'model_surface' ||
    surface.artifactId !== funding.surfaceArtifactId ||
    surface.integrityIdentifier !== funding.surfaceDigest ||
    model.surfaceIntegrityIdentifier !== funding.surfaceDigest ||
    !Number.isSafeInteger(surface.byteLength) ||
    Number(surface.byteLength) < 0 ||
    !inbox ||
    inbox.source_session_id !== sourceSessionId ||
    inbox.target_run_id !== route.targetRunId ||
    inbox.prepared_invocation_id !== route.invocationId ||
    inbox.prepared_model_admission_id !== route.modelAdmissionId ||
    attempted ||
    effect
  )
    return null;
  const surfaceRef = {
    artifactId: funding.surfaceArtifactId,
    kind: 'model_surface' as const,
    integrityIdentifier: funding.surfaceDigest,
    byteLength: Number(surface.byteLength),
  };
  try {
    const stored = createKiteHomeArtifactStore(database).readModel(surfaceRef);
    if (
      stored.artifactFormatVersion !== 1 ||
      !matchesModelArtifactReference('model_surface', stored.canonicalJson, surfaceRef)
    )
      return null;
  } catch {
    return null;
  }
  return Object.freeze({
    submissionId,
    targetRunId: route.targetRunId,
    invocationId: route.invocationId,
    modelReservationId: route.reservationId,
    preparedStateRevision: target.revision,
    surfaceRef: Object.freeze(surfaceRef),
    surfaceDigest: funding.surfaceDigest,
    estimatedInputTokens: Number(model.estimatedInputTokens),
    activationSourceRevision: activation.sourceRevision,
  });
}

/** A v2 target may retry only its still-reserved first Model Surface before any attempt. */
function readPreparedIndependentFollowupRecoveryProof(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
  accepted: NonNullable<ReturnType<typeof readAcceptedIndependentFollowupSourcePolicyProof>>,
): CrossSessionPreparedFollowupRecoveryProof | null {
  const activation = readIndependentCrossSessionFollowupActivation(
    database,
    sourceSessionId,
    submissionId,
  );
  const route = readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
  const terminal = readCrossSessionFollowupTerminalReceipt(database, sourceSessionId, submissionId);
  const target = database
    .query<
      {
        revision: number;
        snapshot_revision: number;
        parent_session_id: string | null;
        state_json: string;
      },
      [string]
    >(
      `SELECT s.revision,p.revision AS snapshot_revision,s.parent_session_id,p.state_json
       FROM runtime_sessions s JOIN runtime_snapshots p ON p.session_id=s.session_id
       WHERE s.session_id=?`,
    )
    .get(targetSessionId);
  if (
    !activation ||
    activation.targetSessionId !== targetSessionId ||
    !route ||
    route.route !== 'new_turn' ||
    route.sourceSessionId !== sourceSessionId ||
    route.targetRunId !== activation.targetRunId ||
    terminal ||
    !target ||
    target.parent_session_id !== sourceSessionId ||
    target.revision !== target.snapshot_revision ||
    target.revision < route.routedRevision
  )
    return null;
  const state = parse(target.state_json);
  const active = record(state.activeFollowupTurn);
  const origin = record(state.childSessionOrigin);
  const ledger = record(state.resourceBudget);
  const model = record(record(state.modelInvocations)[route.invocationId]);
  const modelBudget = record(model.budget);
  const local = record(record(ledger.reservations)[route.reservationId]);
  const surface = record(model.surfaceArtifact);
  const grant = readCrossSessionFollowupGrant(database, String(record(active.grantRef).artifactId));
  const grantPayload = grant ? parse(grant.canonicalJson) : {};
  const run = database
    .query<
      { status: string; start_command_id: string; created_revision: number },
      [string, string]
    >(
      'SELECT status,start_command_id,created_revision FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(targetSessionId, route.targetRunId);
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
    .get(targetSessionId, route.messageId);
  const prepared = database
    .query<{ count: number }, [string, string]>(
      `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='model.invocation_prepared'
       AND json_extract(event_json,'$.invocationId')=?`,
    )
    .get(targetSessionId, route.invocationId)?.count;
  const attempted = database
    .query<{ found: number }, [string, string, string]>(
      `SELECT 1 AS found FROM runtime_events WHERE session_id=?
       AND ((json_extract(event_json,'$.type')='model.invocation_attempt_started'
         AND json_extract(event_json,'$.invocationId')=?)
       OR (json_extract(event_json,'$.type')='resource_budget.dispatch_started'
         AND json_extract(event_json,'$.reservationId')=?)) LIMIT 1`,
    )
    .get(targetSessionId, route.invocationId, route.reservationId);
  const effect = database
    .query<{ found: number }, [string]>(
      'SELECT 1 AS found FROM runtime_effect_leases WHERE session_id=? LIMIT 1',
    )
    .get(targetSessionId);
  if (
    !run ||
    !['running', 'waiting'].includes(run.status) ||
    run.start_command_id !== `followup:${submissionId}` ||
    !verifyPersistedCrossSessionFollowupRunStart(database, {
      sessionId: targetSessionId,
      runId: route.targetRunId,
      startCommandId: run.start_command_id,
      createdRevision: run.created_revision,
    }) ||
    active.sourceSessionId !== sourceSessionId ||
    active.submissionId !== submissionId ||
    active.targetRunId !== route.targetRunId ||
    active.taskId !== route.taskId ||
    active.grantDigest !== activation.grantDigest ||
    !grant ||
    grant.ref.integrityIdentifier !== activation.grantDigest ||
    grantPayload.schema !== 'kite.child-followup-grant.v2' ||
    !validIndependentFollowupGrant(database, {
      sourceSessionId,
      targetSessionId,
      submissionId,
      intentRole: String(origin.role ?? ''),
      origin,
      targetLedger: ledger,
      grantPayload,
      grantBudget: record(grantPayload.budget),
      admission: accepted.admission,
      backupState: 'dispatch_started',
    }) ||
    record(state.turn).turnId !== route.targetRunId ||
    record(state.turn).status !== 'active' ||
    state.activeTaskId !== route.taskId ||
    model.status !== 'prepared' ||
    model.purpose !== 'primary_agent' ||
    model.invocationId !== route.invocationId ||
    model.attempts !== 0 ||
    !Number.isSafeInteger(model.estimatedInputTokens) ||
    modelBudget.kind !== 'reservation' ||
    modelBudget.reservationId !== route.reservationId ||
    ledger.status !== 'active' ||
    ledger.runId !== route.targetRunId ||
    local.state !== 'reserved' ||
    local.runId !== route.targetRunId ||
    local.invocationId !== `model-invocation:${route.invocationId}` ||
    local.resourceKind !== 'model' ||
    surface.kind !== 'model_surface' ||
    !DIGEST.test(String(surface.integrityIdentifier)) ||
    model.surfaceIntegrityIdentifier !== surface.integrityIdentifier ||
    !Number.isSafeInteger(surface.byteLength) ||
    Number(surface.byteLength) < 0 ||
    !inbox ||
    inbox.source_session_id !== sourceSessionId ||
    inbox.target_run_id !== route.targetRunId ||
    inbox.prepared_invocation_id !== route.invocationId ||
    inbox.prepared_model_admission_id !== route.modelAdmissionId ||
    prepared !== 1 ||
    attempted ||
    effect
  )
    return null;
  const surfaceRef = {
    artifactId: String(surface.artifactId),
    kind: 'model_surface' as const,
    integrityIdentifier: String(surface.integrityIdentifier),
    byteLength: Number(surface.byteLength),
  };
  try {
    const stored = createKiteHomeArtifactStore(database).readModel(surfaceRef);
    if (
      stored.artifactFormatVersion !== 1 ||
      !matchesModelArtifactReference('model_surface', stored.canonicalJson, surfaceRef)
    )
      return null;
  } catch {
    return null;
  }
  return Object.freeze({
    submissionId,
    targetRunId: route.targetRunId,
    invocationId: route.invocationId,
    modelReservationId: route.reservationId,
    preparedStateRevision: target.revision,
    surfaceRef: Object.freeze(surfaceRef),
    surfaceDigest: surfaceRef.integrityIdentifier,
    estimatedInputTokens: Number(model.estimatedInputTokens),
    activationSourceRevision: activation.sourceRevision,
  });
}

export interface CrossSessionFollowupTerminalIntent {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly modelInvocationId: string;
  readonly targetRevision: number;
  readonly disposition: 'completed' | 'unknown' | 'pre_dispatch_released';
  readonly sourceRevision: number;
  readonly createdAtMs: number;
  readonly events: readonly Readonly<RecordValue>[];
  readonly sourceSnapshot: Readonly<RecordValue>;
}

export type CrossSessionAcceptedFollowupReleaseReason =
  | 'tool_failed'
  | 'expired'
  | 'context_unavailable'
  | 'authorization_changed'
  | 'source_cancelled'
  | 'capacity_timeout';

export interface CrossSessionAcceptedFollowupReleaseIntent {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly submissionId: string;
  readonly reason: Exclude<CrossSessionAcceptedFollowupReleaseReason, 'source_cancelled'>;
  readonly createdAtMs: number;
  readonly sourceRevision: number;
  readonly sourceSnapshot: Readonly<RecordValue>;
  readonly releaseEvent: Readonly<RecordValue>;
}

/** Derive accepted-only cancellation receipts from the same canonical Run cancel transaction. */
export function settleCancelledAcceptedFollowupsInTransaction(
  database: Database,
  input: Readonly<{
    sourceSessionId: string;
    sourceRevision: number;
    sourceSnapshot: Readonly<RecordValue>;
    events: readonly Readonly<RecordValue>[];
  }>,
): readonly Readonly<{ submissionId: string; targetSessionId: string }>[] {
  requireTransaction(database);
  const aborted = input.events.filter(
    (event) => event.type === 'turn.aborted' && event.cause === 'user',
  );
  if (aborted.length === 0) return [];
  if (aborted.length !== 1 || typeof aborted[0]?.turnId !== 'string') invalid();
  const sourceRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s
       JOIN runtime_snapshots p ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.sourceSessionId);
  if (
    !sourceRow ||
    sourceRow.revision !== input.sourceRevision ||
    !sameCanonicalValue(parse(sourceRow.state_json), input.sourceSnapshot)
  )
    invalid();
  const rows = database
    .query<
      {
        submission_id: string;
        target_session_id: string;
        source_run_id: string;
        followup_admission_artifact_id: string;
        followup_admission_digest: string;
      },
      [string, string]
    >(
      `SELECT submission_id,target_session_id,source_run_id,
        followup_admission_artifact_id,followup_admission_digest
       FROM agent_mail_outbox WHERE source_session_id=? AND source_turn_id=?
       AND mode='trigger_turn' AND accepted_release_source_revision IS NULL`,
    )
    .all(input.sourceSessionId, aborted[0]!.turnId as string);
  const state = input.sourceSnapshot;
  const evidenceDigest = `sha256:${createHash('sha256').update(sourceRow.state_json).digest('hex')}`;
  const settled: { submissionId: string; targetSessionId: string }[] = [];
  for (const row of rows) {
    const run = database
      .query<{ status: string; finished_at_ms: number | null }, [string, string]>(
        'SELECT status,finished_at_ms FROM runtime_runs WHERE session_id=? AND run_id=?',
      )
      .get(input.sourceSessionId, row.source_run_id);
    if (run?.status !== 'cancelled' || run.finished_at_ms === null) continue;
    const artifact = database
      .query<{ canonical_json: string; integrity_identifier: string }, [string]>(
        'SELECT canonical_json,integrity_identifier FROM agent_followup_admission_artifacts WHERE artifact_id=?',
      )
      .get(row.followup_admission_artifact_id);
    if (
      !artifact ||
      artifact.integrity_identifier !== row.followup_admission_digest ||
      `sha256:${createHash('sha256').update(artifact.canonical_json).digest('hex')}` !==
        row.followup_admission_digest
    )
      invalid();
    const admission = parse(artifact.canonical_json);
    const backupId = String(admission.backupReservationId);
    const released = input.events.filter(
      (event) =>
        event.type === 'resource_budget.released' &&
        event.reservationId === backupId &&
        event.proof === undefined,
    );
    if (released.length === 0) continue;
    if (
      released.length !== 1 ||
      admission.submissionId !== row.submission_id ||
      admission.sourceSessionId !== input.sourceSessionId ||
      admission.targetSessionId !== row.target_session_id ||
      admission.fundingRunId !== row.source_run_id
    )
      invalid();
    const active = record(state.resourceBudget);
    const ledger =
      active.runId === row.source_run_id
        ? active
        : record(record(state.retainedResourceBudgets)[row.source_run_id]);
    const backup = record(record(ledger.reservations)[backupId]);
    if (
      ledger.runId !== row.source_run_id ||
      backup.reservationId !== backupId ||
      backup.runId !== row.source_run_id ||
      backup.resourceKind !== 'subagent' ||
      backup.state !== 'released'
    )
      invalid();
    const funding = readCrossSessionFollowupFundingReceipt(
      database,
      input.sourceSessionId,
      row.submission_id,
    );
    const route = database
      .query<{ found: number }, [string, string]>(
        'SELECT 1 AS found FROM agent_followup_routes WHERE source_session_id=? AND submission_id=?',
      )
      .get(input.sourceSessionId, row.submission_id);
    const targetRun = database
      .query<{ found: number }, [string, string]>(
        'SELECT 1 AS found FROM runtime_runs WHERE session_id=? AND start_command_id=?',
      )
      .get(row.target_session_id, `followup:${row.submission_id}`);
    if (funding || route || targetRun) continue;
    const changed = database
      .query(`UPDATE agent_mail_outbox SET accepted_release_source_revision=?,
        accepted_release_reason='source_cancelled',accepted_release_evidence_digest=?,
        accepted_released_at_ms=? WHERE source_session_id=? AND submission_id=?
        AND accepted_release_source_revision IS NULL`)
      .run(
        input.sourceRevision,
        evidenceDigest,
        run.finished_at_ms,
        input.sourceSessionId,
        row.submission_id,
      ).changes;
    if (changed !== 1) conflict();
    settled.push({ submissionId: row.submission_id, targetSessionId: row.target_session_id });
  }
  return Object.freeze(settled);
}

/** A started target may close the still-unreplaced backup only after its exact local failure. */
function provenUnfundedExpiredTarget(
  database: Database,
  input: CrossSessionAcceptedFollowupReleaseIntent,
  targetRunId: string,
): boolean {
  const target = database
    .query<
      {
        parent_session_id: string | null;
        revision: number;
        snapshot_revision: number;
        state_json: string;
      },
      [string]
    >(
      `SELECT s.parent_session_id,s.revision,p.revision AS snapshot_revision,p.state_json
       FROM runtime_sessions s JOIN runtime_snapshots p ON p.session_id=s.session_id
       WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  if (
    !target ||
    target.parent_session_id !== input.sourceSessionId ||
    target.revision !== target.snapshot_revision
  )
    return false;
  const state = parse(target.state_json);
  const followup = record(state.activeFollowupTurn);
  const turn = record(state.turn);
  const ledger = record(state.resourceBudget);
  if (
    followup.sourceSessionId !== input.sourceSessionId ||
    followup.submissionId !== input.submissionId ||
    followup.targetRunId !== targetRunId ||
    typeof followup.taskId !== 'string' ||
    turn.turnId !== targetRunId ||
    turn.status !== 'aborted' ||
    turn.abortCause !== 'error' ||
    ledger.runId !== targetRunId
  )
    return false;
  const models = Object.values(record(state.modelInvocations))
    .map((value) => record(value))
    .filter((model) => {
      const reservation = record(
        record(ledger.reservations)[String(record(model.budget).reservationId)],
      );
      return (
        model.purpose === 'primary_agent' &&
        reservation.runId === targetRunId &&
        reservation.resourceKind === 'model'
      );
    });
  if (models.length !== 1) return false;
  const model = models[0]!;
  const reservationId = String(record(model.budget).reservationId);
  const local = record(record(ledger.reservations)[reservationId]);
  if (
    typeof model.invocationId !== 'string' ||
    model.status !== 'prepared' ||
    model.attempts !== 0 ||
    local.state !== 'released'
  )
    return false;
  const events = database
    .query<{ event_json: string }, [string]>(
      'SELECT event_json FROM runtime_events WHERE session_id=? ORDER BY sequence',
    )
    .all(input.targetSessionId)
    .map((row) => parse(row.event_json));
  const count = (type: string, match: (event: RecordValue) => boolean): number =>
    events.filter((event) => event.type === type && match(event)).length;
  const reason = CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED;
  const exact =
    count(
      'agent.followup_turn_prepared',
      (event) =>
        event.sourceSessionId === input.sourceSessionId &&
        event.submissionId === input.submissionId &&
        event.targetRunId === targetRunId &&
        event.taskId === followup.taskId,
    ) === 1 &&
    count('model.invocation_prepared', (event) => event.invocationId === model.invocationId) ===
      1 &&
    count(
      'resource_budget.released',
      (event) =>
        event.reservationId === reservationId && event.proof === 'local_pre_dispatch_failure',
    ) === 1 &&
    count('task.failed', (event) => event.taskId === followup.taskId && event.reason === reason) ===
      1 &&
    count(
      'turn.aborted',
      (event) => event.turnId === targetRunId && event.cause === 'error' && event.reason === reason,
    ) === 1 &&
    count('run.error', (event) => event.turnId === targetRunId && event.message === reason) === 1 &&
    count(
      'model.invocation_attempt_started',
      (event) => event.invocationId === model.invocationId,
    ) === 0 &&
    count('resource_budget.dispatch_started', (event) => event.reservationId === reservationId) ===
      0;
  const effect = database
    .query<{ found: number }, [string]>(
      'SELECT 1 AS found FROM runtime_effect_leases WHERE session_id=? LIMIT 1',
    )
    .get(input.targetSessionId);
  return exact && !effect;
}

/** A source-only terminal ACK for an accepted backup that was never replaced. */
function provenQueuedCapacityTimeout(
  database: Database,
  input: CrossSessionAcceptedFollowupReleaseIntent,
  outbox: Readonly<{ accepted_at_ms: number; source_run_id: string }>,
  ledger: RecordValue,
  backupId: string,
): boolean {
  const budget = record(ledger.budget);
  const waitMs = budget.maxConcurrencyWaitMs;
  const limit = budget.maxConcurrentSubagents;
  const acceptedAtMs = outbox.accepted_at_ms;
  if (
    ledger.status !== 'active' ||
    ledger.runId !== outbox.source_run_id ||
    !Number.isSafeInteger(waitMs) ||
    Number(waitMs) < 0 ||
    !Number.isSafeInteger(limit) ||
    Number(limit) < 1 ||
    !Number.isSafeInteger(acceptedAtMs) ||
    acceptedAtMs < 0 ||
    !Number.isSafeInteger(acceptedAtMs + Number(waitMs)) ||
    input.createdAtMs < acceptedAtMs + Number(waitMs)
  )
    return false;
  const reservations = Object.values(record(ledger.reservations)).map((item) => record(item));
  const reconciled = Number(record(record(ledger.reconciledUsage).gauges).activeSubagents);
  if (!Number.isSafeInteger(reconciled) || reconciled < 0) return false;
  let committedSlots = reconciled;
  for (const reservation of reservations) {
    if (!['reserved', 'dispatch_started', 'unknown'].includes(String(reservation.state))) continue;
    const slots = Number(record(record(reservation.executableUpperBound).gauges).activeSubagents);
    if (!Number.isSafeInteger(slots) || slots < 0) return false;
    committedSlots += slots;
    if (!Number.isSafeInteger(committedSlots)) return false;
  }
  if (committedSlots !== limit) return false;
  const events = database
    .query<{ event_json: string }, [string]>(
      'SELECT event_json FROM runtime_events WHERE session_id=? ORDER BY sequence',
    )
    .all(input.sourceSessionId)
    .map((row) => parse(row.event_json));
  const reserved = events.filter(
    (event) =>
      event.type === 'resource_budget.reserved' &&
      record(event.reservation).reservationId === backupId,
  );
  return (
    reserved.length === 1 &&
    record(reserved[0]!.reservation).state === 'queued' &&
    events.every(
      (event) =>
        !(
          (event.type === 'resource_budget.child_slot_acquired' ||
            event.type === 'resource_budget.dispatch_started' ||
            event.type === 'resource_budget.unknown') &&
          event.reservationId === backupId
        ),
    )
  );
}

function queuedBackupHasExactSlotAcquisition(
  database: Database,
  sourceSessionId: string,
  backupId: string,
): boolean {
  const events = database
    .query<{ event_json: string }, [string]>(
      'SELECT event_json FROM runtime_events WHERE session_id=? ORDER BY sequence',
    )
    .all(sourceSessionId)
    .map((row) => parse(row.event_json));
  const original = events.filter(
    (event) =>
      event.type === 'resource_budget.reserved' &&
      record(event.reservation).reservationId === backupId,
  );
  if (original.length !== 1) return false;
  const state = record(original[0]!.reservation).state;
  const acquired = events.filter(
    (event) =>
      event.type === 'resource_budget.child_slot_acquired' && event.reservationId === backupId,
  ).length;
  return state === 'reserved' ? acquired === 0 : state === 'queued' && acquired === 1;
}

const CURRENT_TURN_READ_ONLY_ROLE_TOOLS = new Set([
  'read_file',
  'search_content',
  'search_files',
  'shell_execute',
  'read_mcp_resource',
]);
const CURRENT_TURN_STORE_PROVEN_TOOLS = new Set(['read_file', 'search_content', 'search_files']);

function finiteCurrentTurnToolCeiling(ceiling: RecordValue, role: unknown): boolean {
  const allowed = ceiling.allowedTools;
  return (
    ['explore', 'plan', 'review'].includes(String(role)) &&
    Array.isArray(allowed) &&
    allowed.length <= CURRENT_TURN_READ_ONLY_ROLE_TOOLS.size &&
    allowed.every(
      (name) => typeof name === 'string' && CURRENT_TURN_READ_ONLY_ROLE_TOOLS.has(name),
    ) &&
    new Set(allowed).size === allowed.length &&
    Array.isArray(ceiling.bindingIds) &&
    ceiling.bindingIds.length === 0
  );
}

function currentTurnSurfaceWithinCeiling(tools: unknown, ceiling: RecordValue): boolean {
  if (!Array.isArray(tools) || !Array.isArray(ceiling.allowedTools)) return false;
  const allowed = ceiling.allowedTools;
  const names = tools.map((item) => record(item).name);
  return (
    tools.length <= allowed.length &&
    new Set(names).size === names.length &&
    names.every(
      (name) =>
        typeof name === 'string' &&
        CURRENT_TURN_STORE_PROVEN_TOOLS.has(name) &&
        allowed.includes(name),
    ) &&
    tools.every((item) => {
      const tool = record(item);
      return (
        Object.keys(tool).sort().join(',') === 'description,inputSchema,name' &&
        (tool.description === null || typeof tool.description === 'string') &&
        typeof tool.inputSchema === 'object' &&
        tool.inputSchema !== null &&
        !Array.isArray(tool.inputSchema)
      );
    })
  );
}

function currentTurnHeldBackupProven(
  database: Database,
  sourceSessionId: string,
  backupId: string,
  state: unknown,
): boolean {
  if (state === 'reserved')
    return queuedBackupHasExactSlotAcquisition(database, sourceSessionId, backupId);
  if (state !== 'queued') return false;
  const events = database
    .query<{ event_json: string }, [string]>(
      'SELECT event_json FROM runtime_events WHERE session_id=? ORDER BY sequence',
    )
    .all(sourceSessionId)
    .map((row) => parse(row.event_json));
  return (
    events.filter(
      (event) =>
        event.type === 'resource_budget.reserved' &&
        record(event.reservation).reservationId === backupId &&
        record(event.reservation).state === 'queued',
    ).length === 1 &&
    events.every(
      (event) =>
        event.reservationId !== backupId ||
        ![
          'resource_budget.child_slot_acquired',
          'resource_budget.dispatch_started',
          'resource_budget.unknown',
          'resource_budget.released',
        ].includes(String(event.type)),
    )
  );
}

function currentTurnReleasedBackupHistoryProven(
  database: Database,
  sourceSessionId: string,
  backupId: string,
): boolean {
  const events = database
    .query<{ event_json: string }, [string]>(
      'SELECT event_json FROM runtime_events WHERE session_id=? ORDER BY sequence',
    )
    .all(sourceSessionId)
    .map((row) => parse(row.event_json));
  const original = events.filter(
    (event) =>
      event.type === 'resource_budget.reserved' &&
      record(event.reservation).reservationId === backupId,
  );
  if (
    original.length > 1 ||
    (original.length === 1 &&
      !['queued', 'reserved'].includes(String(record(original[0]!.reservation).state)))
  )
    return false;
  return events.every(
    (event) =>
      event.reservationId !== backupId ||
      ![
        'resource_budget.child_slot_acquired',
        'resource_budget.dispatch_started',
        'resource_budget.unknown',
      ].includes(String(event.type)),
  );
}

export function releaseAcceptedCrossSessionFollowupBackupInTransaction(
  database: Database,
  input: CrossSessionAcceptedFollowupReleaseIntent,
): void {
  requireTransaction(database);
  const outbox = database
    .query<
      {
        message_id: string;
        target_session_id: string;
        source_run_id: string;
        source_tool_call_id: string;
        accepted_at_ms: number;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
        accepted_release_source_revision: number | null;
        accepted_release_reason: string | null;
        accepted_release_evidence_digest: string | null;
        accepted_released_at_ms: number | null;
      },
      [string, string]
    >(`SELECT message_id,target_session_id,source_run_id,source_tool_call_id,accepted_at_ms,
    followup_admission_artifact_id,followup_admission_digest,
    accepted_release_source_revision,accepted_release_reason,accepted_release_evidence_digest,
    accepted_released_at_ms FROM agent_mail_outbox
    WHERE source_session_id=? AND submission_id=? AND mode='trigger_turn'`)
    .get(input.sourceSessionId, input.submissionId);
  const sourceRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
     ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.sourceSessionId);
  if (
    !outbox ||
    !sourceRow ||
    sourceRow.revision !== input.sourceRevision ||
    !sameCanonicalValue(parse(sourceRow.state_json), input.sourceSnapshot) ||
    outbox.target_session_id !== input.targetSessionId ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0 ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 1
  )
    invalid();
  const evidenceDigest = `sha256:${createHash('sha256').update(sourceRow.state_json).digest('hex')}`;
  if (outbox.accepted_release_source_revision !== null) {
    if (
      outbox.accepted_release_source_revision !== input.sourceRevision ||
      outbox.accepted_release_reason !== input.reason ||
      outbox.accepted_release_evidence_digest !== evidenceDigest ||
      outbox.accepted_released_at_ms !== input.createdAtMs
    )
      conflict();
    return;
  }
  const admissionRow = outbox.followup_admission_artifact_id
    ? database
        .query<{ canonical_json: string; integrity_identifier: string }, [string]>(
          `SELECT canonical_json,integrity_identifier FROM agent_followup_admission_artifacts
       WHERE artifact_id=?`,
        )
        .get(outbox.followup_admission_artifact_id)
    : null;
  const admissionDigest = admissionRow
    ? `sha256:${createHash('sha256').update(admissionRow.canonical_json).digest('hex')}`
    : '';
  if (
    !admissionRow ||
    admissionDigest !== outbox.followup_admission_digest ||
    admissionRow.integrity_identifier !== admissionDigest ||
    outbox.followup_admission_artifact_id !== `pa_${admissionDigest.slice(7)}`
  )
    invalid();
  const admission = parse(admissionRow.canonical_json);
  const independent = admission.schema === 'kite.cross-session-followup-admission.v2';
  const acceptedIndependent = independent
    ? readAcceptedIndependentFollowupSourcePolicyProof(
        database,
        input.targetSessionId,
        input.sourceSessionId,
        input.submissionId,
      )
    : null;
  const state = input.sourceSnapshot;
  const active = record(state.resourceBudget);
  const ledger =
    active.runId === outbox.source_run_id
      ? active
      : record(record(state.retainedResourceBudgets)[outbox.source_run_id]);
  const backupId = String(admission.backupReservationId);
  const backup = record(record(ledger.reservations)[backupId]);
  const tool = record(record(record(state.tools).calls)[outbox.source_tool_call_id]);
  const preparedTool = record(admission.preparedTool);
  const invocation = record(
    record(record(state.capabilities).invocations)[preparedTool.invocationId as string],
  );
  const funding = readCrossSessionFollowupFundingReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  const route = database
    .query<{ submission_id: string }, [string, string]>(
      'SELECT submission_id FROM agent_followup_routes WHERE source_session_id=? AND submission_id=?',
    )
    .get(input.sourceSessionId, input.submissionId);
  const started = database
    .query<{ run_id: string; status: string }, [string, string]>(
      'SELECT run_id,status FROM runtime_runs WHERE session_id=? AND start_command_id=?',
    )
    .get(input.targetSessionId, `followup:${input.submissionId}`);
  const failed = tool.status === 'failed' && invocation.status === 'failed';
  const targetNode = database
    .query<{ status: string }, [string]>(
      'SELECT status FROM agent_nodes WHERE session_id=? AND agent_id=session_id',
    )
    .get(input.targetSessionId);
  const policy = record(admission.policy);
  const session = record(state.session);
  const capabilities = record(state.capabilities);
  const authorizationChanged =
    policy.interactionMode !== state.mode ||
    policy.interactionModeRevision !== state.interactionModeRevision ||
    policy.workspaceAccess !== state.workspaceAccess ||
    policy.workspaceDigest !== session.canonicalWorkspaceDigest ||
    policy.capabilityDigest !== capabilities.catalogRevision;
  const deadlineAt = Number(admission.deadlineAt);
  const reasonProven =
    (input.reason === 'tool_failed' && failed) ||
    (input.reason === 'expired' &&
      !independent &&
      Number.isSafeInteger(deadlineAt) &&
      input.createdAtMs >= deadlineAt) ||
    (input.reason === 'context_unavailable' &&
      (targetNode?.status === 'context_unavailable' ||
        (targetNode?.status === 'idle' &&
          readChildTerminalCheckpoint(database, input.targetSessionId) === null))) ||
    (input.reason === 'authorization_changed' && authorizationChanged) ||
    (input.reason === 'capacity_timeout' &&
      provenQueuedCapacityTimeout(database, input, outbox, ledger, backupId));
  if (
    (admission.schema !== 'kite.cross-session-followup-admission.v1' && !independent) ||
    (independent &&
      (!acceptedIndependent ||
        acceptedIndependent.admission.backupReservationId !== backupId ||
        record(backup.executableUpperBound).independentFollowupTurn !== true ||
        record(backup.executableUpperBound).unboundedToolInvocations !== true)) ||
    admission.sourceSessionId !== input.sourceSessionId ||
    admission.targetSessionId !== input.targetSessionId ||
    admission.submissionId !== input.submissionId ||
    admission.messageId !== outbox.message_id ||
    admission.fundingRunId !== outbox.source_run_id ||
    ledger.runId !== outbox.source_run_id ||
    backup.reservationId !== backupId ||
    backup.runId !== outbox.source_run_id ||
    backup.resourceKind !== 'subagent' ||
    backup.state !== 'released' ||
    input.releaseEvent.type !== 'resource_budget.released' ||
    input.releaseEvent.reservationId !== backupId ||
    input.releaseEvent.proof !== undefined ||
    tool.toolCallId !== outbox.source_tool_call_id ||
    invocation.invocationId !== preparedTool.invocationId ||
    invocation.toolCallId !== outbox.source_tool_call_id ||
    funding ||
    route ||
    (started != null &&
      !(
        input.reason === 'expired' &&
        started.status === 'failed' &&
        provenUnfundedExpiredTarget(database, input, started.run_id)
      )) ||
    !reasonProven
  )
    invalid();
  const changed = database
    .query(`UPDATE agent_mail_outbox SET
    accepted_release_source_revision=?,accepted_release_reason=?,accepted_release_evidence_digest=?,
    accepted_released_at_ms=?
    WHERE source_session_id=? AND submission_id=? AND accepted_release_source_revision IS NULL`)
    .run(
      input.sourceRevision,
      input.reason,
      evidenceDigest,
      input.createdAtMs,
      input.sourceSessionId,
      input.submissionId,
    ).changes;
  if (changed !== 1) conflict();
}

export interface CrossSessionCurrentTurnBackupReleaseReceipt {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly invocationId: string;
  readonly modelAdmissionId: string;
  readonly reservationId: string;
  readonly sourceRevision: number;
  readonly targetRevision: number;
  readonly routeDigest: string;
  readonly createdAtMs: number;
}

/** Source owner releases its undispatched backup after the old Run has funded the exact mail Surface. */
export function releaseCrossSessionCurrentTurnBackupInTransaction(
  database: Database,
  input: Readonly<{
    sourceSessionId: string;
    targetSessionId: string;
    submissionId: string;
    targetRunId: string;
    invocationId: string;
    modelAdmissionId: string;
    reservationId: string;
    targetRevision: number;
    sourceRevision: number;
    createdAtMs: number;
    sourceSnapshot: Readonly<RecordValue>;
    releaseEvent: Readonly<RecordValue>;
  }>,
): CrossSessionCurrentTurnBackupReleaseReceipt {
  requireTransaction(database);
  const outbox = database
    .query<
      {
        message_id: string;
        source_run_id: string;
        target_session_id: string;
        source_tool_call_id: string;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
        accepted_release_source_revision: number | null;
        current_turn_release_source_revision: number | null;
        current_turn_release_target_revision: number | null;
        current_turn_release_route_digest: string | null;
        current_turn_released_at_ms: number | null;
      },
      [string, string]
    >(`SELECT message_id,source_run_id,target_session_id,source_tool_call_id,
    followup_admission_artifact_id,followup_admission_digest,
    accepted_release_source_revision,current_turn_release_source_revision,
    current_turn_release_target_revision,current_turn_release_route_digest,
    current_turn_released_at_ms FROM agent_mail_outbox
    WHERE source_session_id=? AND submission_id=? AND mode='trigger_turn'`)
    .get(input.sourceSessionId, input.submissionId);
  const route = readCrossSessionFollowupRoute(database, input.targetSessionId, input.submissionId);
  const routeDigest = route
    ? `sha256:${createHash('sha256').update(JSON.stringify(route)).digest('hex')}`
    : '';
  const sourceRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
     ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.sourceSessionId);
  const targetRow = database
    .query<
      {
        revision: number;
        state_json: string;
        parent_session_id: string | null;
        workspace_id: string;
        project_id: string;
        workspace_digest: string;
      },
      [string]
    >(
      `SELECT s.revision,p.state_json,s.parent_session_id,s.workspace_id,s.project_id,
      s.workspace_digest FROM runtime_sessions s JOIN runtime_snapshots p ON p.session_id=s.session_id
      WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  const sourceSession = database
    .query<{ workspace_id: string; project_id: string; workspace_digest: string }, [string]>(
      'SELECT workspace_id,project_id,workspace_digest FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.sourceSessionId);
  const childRole = database
    .query<{ role: string }, [string]>(
      'SELECT role FROM child_session_intents WHERE child_thread_id=?',
    )
    .get(input.targetSessionId)?.role;
  if (
    !outbox ||
    !route ||
    route.route !== 'current_turn' ||
    !['explore', 'plan', 'review'].includes(String(childRole)) ||
    outbox.target_session_id !== input.targetSessionId ||
    outbox.accepted_release_source_revision !== null ||
    route.sourceSessionId !== input.sourceSessionId ||
    route.messageId !== outbox.message_id ||
    route.targetRunId !== input.targetRunId ||
    route.invocationId !== input.invocationId ||
    route.modelAdmissionId !== input.modelAdmissionId ||
    route.reservationId !== input.reservationId ||
    route.routedRevision !== input.targetRevision ||
    !sourceRow ||
    sourceRow.revision !== input.sourceRevision ||
    !sameCanonicalValue(parse(sourceRow.state_json), input.sourceSnapshot) ||
    !targetRow ||
    targetRow.revision !== input.targetRevision ||
    targetRow.parent_session_id !== input.sourceSessionId ||
    !sourceSession ||
    sourceSession.workspace_id !== targetRow.workspace_id ||
    sourceSession.project_id !== targetRow.project_id ||
    sourceSession.workspace_digest !== targetRow.workspace_digest ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < route.createdAtMs
  )
    invalid();
  const receipt: CrossSessionCurrentTurnBackupReleaseReceipt = Object.freeze({
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    submissionId: input.submissionId,
    targetRunId: input.targetRunId,
    invocationId: input.invocationId,
    modelAdmissionId: input.modelAdmissionId,
    reservationId: input.reservationId,
    sourceRevision: input.sourceRevision,
    targetRevision: input.targetRevision,
    routeDigest,
    createdAtMs: input.createdAtMs,
  });
  if (outbox.current_turn_release_source_revision !== null) {
    if (
      outbox.current_turn_release_source_revision !== input.sourceRevision ||
      outbox.current_turn_release_target_revision !== input.targetRevision ||
      outbox.current_turn_release_route_digest !== routeDigest ||
      outbox.current_turn_released_at_ms !== input.createdAtMs
    )
      conflict();
    return receipt;
  }
  const admissionRow = outbox.followup_admission_artifact_id
    ? database
        .query<
          { canonical_json: string; integrity_identifier: string; byte_length: number },
          [string]
        >(
          `SELECT canonical_json,integrity_identifier,byte_length
       FROM agent_followup_admission_artifacts WHERE artifact_id=?`,
        )
        .get(outbox.followup_admission_artifact_id)
    : null;
  const admissionDigest = admissionRow
    ? `sha256:${createHash('sha256').update(admissionRow.canonical_json).digest('hex')}`
    : '';
  const admission = admissionRow ? parse(admissionRow.canonical_json) : {};
  const acceptedPolicy = record(admission.policy);
  const sourceState = input.sourceSnapshot;
  const active = record(sourceState.resourceBudget);
  const ledger =
    active.runId === outbox.source_run_id
      ? active
      : record(record(sourceState.retainedResourceBudgets)[outbox.source_run_id]);
  const backupId = String(admission.backupReservationId);
  const backup = record(record(ledger.reservations)[backupId]);
  const tool = record(record(record(sourceState.tools).calls)[outbox.source_tool_call_id]);
  const preparedTool = record(admission.preparedTool);
  const invocation = record(
    record(record(sourceState.capabilities).invocations)[String(preparedTool.invocationId)],
  );
  const target = parse(targetRow.state_json);
  const model = record(record(target.modelInvocations)[input.invocationId]);
  const local = record(record(record(target.resourceBudget).reservations)[input.reservationId]);
  const run = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  const inbox = database
    .query<
      {
        target_run_id: string | null;
        prepared_invocation_id: string | null;
        prepared_model_admission_id: string | null;
      },
      [string, string]
    >(
      `SELECT target_run_id,prepared_invocation_id,prepared_model_admission_id
     FROM agent_mail_inbox WHERE target_session_id=? AND message_id=?`,
    )
    .get(input.targetSessionId, outbox.message_id);
  const preparedMailCount =
    database
      .query<{ count: number }, [string, string, string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
     AND json_extract(event_json,'$.type')='agent.mail_input_prepared'
     AND json_extract(event_json,'$.invocationId')=?
     AND json_extract(event_json,'$.modelAdmissionId')=?
     AND json_array_length(event_json,'$.messageIds')=1
     AND json_extract(event_json,'$.messageIds[0]')=?`,
      )
      .get(input.targetSessionId, input.invocationId, input.modelAdmissionId, outbox.message_id)
      ?.count ?? 0;
  const attemptCount =
    database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
     AND json_extract(event_json,'$.type')='model.invocation_attempt_started'
     AND json_extract(event_json,'$.invocationId')=?`,
      )
      .get(input.targetSessionId, input.invocationId)?.count ?? 0;
  if (
    !admissionRow ||
    admissionDigest !== outbox.followup_admission_digest ||
    admissionRow.integrity_identifier !== admissionDigest ||
    outbox.followup_admission_artifact_id !== `pa_${admissionDigest.slice(7)}` ||
    admissionRow.byte_length !== Buffer.byteLength(admissionRow.canonical_json, 'utf8') ||
    admission.schema !== 'kite.cross-session-followup-admission.v1' ||
    admission.sourceSessionId !== input.sourceSessionId ||
    admission.targetSessionId !== input.targetSessionId ||
    admission.submissionId !== input.submissionId ||
    admission.messageId !== outbox.message_id ||
    admission.fundingRunId !== outbox.source_run_id ||
    acceptedPolicy.interactionMode !== sourceState.mode ||
    acceptedPolicy.interactionModeRevision !== sourceState.interactionModeRevision ||
    acceptedPolicy.workspaceAccess !== sourceState.workspaceAccess ||
    ledger.runId !== outbox.source_run_id ||
    backup.reservationId !== backupId ||
    backup.runId !== outbox.source_run_id ||
    backup.resourceKind !== 'subagent' ||
    backup.state !== 'released' ||
    !currentTurnReleasedBackupHistoryProven(database, input.sourceSessionId, backupId) ||
    input.releaseEvent.type !== 'resource_budget.released' ||
    input.releaseEvent.reservationId !== backupId ||
    input.releaseEvent.proof !== undefined ||
    tool.status !== 'succeeded' ||
    invocation.status !== 'succeeded' ||
    invocation.toolCallId !== outbox.source_tool_call_id ||
    readCrossSessionFollowupFundingReceipt(database, input.sourceSessionId, input.submissionId) ||
    !run ||
    !['running', 'waiting'].includes(run.status) ||
    record(target.turn).status !== 'active' ||
    record(target.resourceBudget).runId !== input.targetRunId ||
    model.status !== 'prepared' ||
    model.attempts !== 0 ||
    record(model.budget).reservationId !== input.reservationId ||
    local.reservationId !== input.reservationId ||
    local.state !== 'reserved' ||
    !inbox ||
    inbox.target_run_id !== input.targetRunId ||
    inbox.prepared_invocation_id !== input.invocationId ||
    inbox.prepared_model_admission_id !== input.modelAdmissionId ||
    preparedMailCount !== 1 ||
    attemptCount !== 0
  )
    invalid();
  const changed = database
    .query(`UPDATE agent_mail_outbox SET
    current_turn_release_source_revision=?,current_turn_release_target_revision=?,
    current_turn_release_route_digest=?,current_turn_released_at_ms=?
    WHERE source_session_id=? AND submission_id=?
      AND accepted_release_source_revision IS NULL
      AND current_turn_release_source_revision IS NULL`)
    .run(
      input.sourceRevision,
      input.targetRevision,
      routeDigest,
      input.createdAtMs,
      input.sourceSessionId,
      input.submissionId,
    ).changes;
  if (changed !== 1) conflict();
  return receipt;
}

/** Target owner reads a source ACK before dispatching its already funded old-Run Model. */
export function readCrossSessionCurrentTurnBackupReleaseForTarget(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
): CrossSessionCurrentTurnBackupReleaseReceipt | null {
  const row = database
    .query<
      {
        message_id: string;
        source_run_id: string;
        target_session_id: string;
        accepted_release_source_revision: number | null;
        current_turn_release_source_revision: number | null;
        current_turn_release_target_revision: number | null;
        current_turn_release_route_digest: string | null;
        current_turn_released_at_ms: number | null;
      },
      [string, string, string]
    >(`SELECT message_id,source_run_id,target_session_id,
    accepted_release_source_revision,current_turn_release_source_revision,
    current_turn_release_target_revision,current_turn_release_route_digest,
    current_turn_released_at_ms FROM agent_mail_outbox
    WHERE source_session_id=? AND target_session_id=? AND submission_id=? AND mode='trigger_turn'`)
    .get(sourceSessionId, targetSessionId, submissionId);
  if (!row?.current_turn_release_source_revision) return null;
  const route = readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
  const source = database
    .query<{ state_json: string; revision: number }, [string]>(
      `SELECT p.state_json,s.revision FROM runtime_sessions s JOIN runtime_snapshots p
     ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(sourceSessionId);
  const target = database
    .query<
      {
        parent_session_id: string | null;
        workspace_id: string;
        project_id: string;
        workspace_digest: string;
      },
      [string]
    >(
      `SELECT parent_session_id,workspace_id,project_id,workspace_digest
     FROM runtime_sessions WHERE session_id=?`,
    )
    .get(targetSessionId);
  const sourceSession = database
    .query<{ workspace_id: string; project_id: string; workspace_digest: string }, [string]>(
      'SELECT workspace_id,project_id,workspace_digest FROM runtime_sessions WHERE session_id=?',
    )
    .get(sourceSessionId);
  const admissionRow = database
    .query<{ canonical_json: string }, [string, string]>(
      `SELECT a.canonical_json FROM agent_followup_admission_artifacts a
     JOIN agent_mail_outbox o ON o.followup_admission_artifact_id=a.artifact_id
     WHERE o.source_session_id=? AND o.submission_id=?`,
    )
    .get(sourceSessionId, submissionId);
  const admission = admissionRow ? parse(admissionRow.canonical_json) : {};
  const state = source ? parse(source.state_json) : {};
  const active = record(state.resourceBudget);
  const ledger =
    active.runId === row.source_run_id
      ? active
      : record(record(state.retainedResourceBudgets)[row.source_run_id]);
  const backup = record(record(ledger.reservations)[String(admission.backupReservationId)]);
  const routeDigest = route
    ? `sha256:${createHash('sha256').update(JSON.stringify(route)).digest('hex')}`
    : '';
  const releasedEventCount =
    database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
     AND json_extract(event_json,'$.type')='resource_budget.released'
     AND json_extract(event_json,'$.reservationId')=?`,
      )
      .get(sourceSessionId, String(admission.backupReservationId))?.count ?? 0;
  if (
    !route ||
    route.route !== 'current_turn' ||
    route.sourceSessionId !== sourceSessionId ||
    route.messageId !== row.message_id ||
    route.routedRevision !== row.current_turn_release_target_revision ||
    routeDigest !== row.current_turn_release_route_digest ||
    row.accepted_release_source_revision !== null ||
    !source ||
    source.revision < row.current_turn_release_source_revision ||
    !target ||
    target.parent_session_id !== sourceSessionId ||
    !sourceSession ||
    sourceSession.workspace_id !== target.workspace_id ||
    sourceSession.project_id !== target.project_id ||
    sourceSession.workspace_digest !== target.workspace_digest ||
    ledger.runId !== row.source_run_id ||
    backup.reservationId !== admission.backupReservationId ||
    backup.state !== 'released' ||
    !currentTurnReleasedBackupHistoryProven(
      database,
      sourceSessionId,
      String(admission.backupReservationId),
    ) ||
    releasedEventCount !== 1
  )
    invalid();
  return Object.freeze({
    sourceSessionId,
    targetSessionId,
    submissionId,
    targetRunId: route.targetRunId,
    invocationId: route.invocationId,
    modelAdmissionId: route.modelAdmissionId,
    reservationId: route.reservationId,
    sourceRevision: row.current_turn_release_source_revision,
    targetRevision: row.current_turn_release_target_revision,
    routeDigest,
    createdAtMs: row.current_turn_released_at_ms!,
  });
}

export interface CrossSessionCurrentTurnPreparedNoAttemptProof {
  readonly submissionId: string;
  readonly targetRunId: string;
  readonly invocationId: string;
  readonly modelReservationId: string;
  readonly preparedStateRevision: number;
  readonly surfaceRef: Readonly<{
    artifactId: string;
    kind: 'model_surface';
    integrityIdentifier: string;
    byteLength: number;
  }>;
  readonly surfaceDigest: string;
  readonly estimatedInputTokens: number;
  readonly releaseSourceRevision: number;
  readonly routeDigest: string;
  readonly routedTargetRevision: number;
}

/** Source-owner proof for retaining exactly one dispatched D0 child allotment. */
export interface CrossSessionCurrentTurnDispatchedChildProof {
  readonly sourceSessionId: string;
  readonly delegatedReservationId: string;
  readonly childThreadId: string;
  readonly parentInvocationId: string;
  readonly originToolCallId: string;
  readonly fundingRunId: string;
  readonly targetRunId: string;
  readonly modelInvocationId: string;
  readonly submissionId: string;
  readonly preparedStateRevision: number;
  readonly stage: 'released';
  readonly releaseSourceRevision: number;
  readonly routedTargetRevision: number;
}

export interface CrossSessionCurrentTurnRoutedChildProof
  extends Omit<CrossSessionCurrentTurnDispatchedChildProof, 'stage' | 'releaseSourceRevision'> {
  readonly stage: 'routed';
  readonly releaseSourceRevision: null;
  readonly sourceRevision: number;
}

function readCurrentTurnChildProofForSource(
  database: Database,
  sourceSessionId: string,
  targetSessionId: string,
  submissionId: string,
  stage: 'routed' | 'released',
): CrossSessionCurrentTurnDispatchedChildProof | CrossSessionCurrentTurnRoutedChildProof | null {
  const target = readCurrentTurnTargetNoAttemptProof(
    database,
    targetSessionId,
    sourceSessionId,
    submissionId,
    stage,
  );
  const intent = readChildSessionIntent(database, targetSessionId);
  if (
    !target ||
    !intent ||
    intent.parentSessionId !== sourceSessionId ||
    intent.childThreadId !== targetSessionId ||
    intent.disposition !== 'required' ||
    intent.childBudgetActivatedRunId !== target.targetRunId ||
    !intent.dispatchAckEventId ||
    intent.failureReceiptDigest ||
    intent.parentClaimSettledEventId ||
    intent.delegatedReservationId !== `child-allotment:${targetSessionId}`
  )
    return null;
  const source = database
    .query<{ state_json: string; revision: number; snapshot_revision: number }, [string]>(
      `SELECT p.state_json,s.revision,p.revision AS snapshot_revision
       FROM runtime_sessions s JOIN runtime_snapshots p ON p.session_id=s.session_id
       WHERE s.session_id=?`,
    )
    .get(sourceSessionId);
  if (!source || source.revision !== source.snapshot_revision) return null;
  const state = parse(source.state_json);
  const active = record(state.resourceBudget);
  const ledger =
    active.runId === intent.fundingRunId
      ? active
      : record(record(state.retainedResourceBudgets)[intent.fundingRunId]);
  const reservation = record(record(ledger.reservations)[intent.delegatedReservationId]);
  const invocation = record(
    record(record(state.capabilities).invocations)[intent.parentInvocationId],
  );
  const lifecycle = record(invocation.subagentProviderLifecycle);
  const link = record(lifecycle.childSession);
  const call = record(record(record(state.tools).calls)[intent.originToolCallId]);
  if (
    ledger.runId !== intent.fundingRunId ||
    reservation.reservationId !== intent.delegatedReservationId ||
    reservation.runId !== intent.fundingRunId ||
    reservation.resourceKind !== 'subagent' ||
    reservation.invocationId !== intent.delegatedReservationId ||
    reservation.state !== 'dispatch_started' ||
    invocation.toolCallId !== intent.originToolCallId ||
    invocation.status !== 'succeeded' ||
    call.status !== 'succeeded' ||
    link.childThreadId !== targetSessionId ||
    link.delegatedReservationId !== intent.delegatedReservationId ||
    lifecycle.childInvocationId !== intent.childInvocationId
  )
    return null;
  const common = {
    sourceSessionId,
    delegatedReservationId: intent.delegatedReservationId,
    childThreadId: targetSessionId,
    parentInvocationId: intent.parentInvocationId,
    originToolCallId: intent.originToolCallId,
    fundingRunId: intent.fundingRunId,
    targetRunId: target.targetRunId,
    modelInvocationId: target.invocationId,
    submissionId,
    preparedStateRevision: target.preparedStateRevision,
    routedTargetRevision: target.routedTargetRevision,
  };
  if (stage === 'released') {
    if (target.releaseSourceRevision === null || source.revision < target.releaseSourceRevision)
      return null;
    return Object.freeze({
      ...common,
      stage: 'released' as const,
      releaseSourceRevision: target.releaseSourceRevision,
    });
  }
  const route = readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
  if (!route || route.route !== 'current_turn' || route.targetRunId !== target.targetRunId)
    return null;
  const admission = readCrossSessionFollowupAdmissionForTarget(
    database,
    targetSessionId,
    sourceSessionId,
    route.messageId,
  );
  const outbox = readCrossSessionMail(database, sourceSessionId, route.messageId);
  const releaseColumns = database
    .query<
      {
        accepted_release_source_revision: number | null;
        current_turn_release_source_revision: number | null;
      },
      [string, string]
    >(`SELECT accepted_release_source_revision,current_turn_release_source_revision
       FROM agent_mail_outbox WHERE source_session_id=? AND message_id=?`)
    .get(sourceSessionId, route.messageId);
  if (
    !admission ||
    admission.submissionId !== submissionId ||
    !outbox ||
    outbox.mode !== 'trigger_turn' ||
    outbox.targetSessionId !== targetSessionId ||
    outbox.targetRunId !== target.targetRunId ||
    !releaseColumns ||
    releaseColumns.accepted_release_source_revision !== null ||
    releaseColumns.current_turn_release_source_revision !== null
  )
    return null;
  const payload = parse(admission.admission.canonicalJson);
  const fundingRunId = String(payload.fundingRunId ?? '');
  const fundingLedger =
    active.runId === fundingRunId
      ? active
      : record(record(state.retainedResourceBudgets)[fundingRunId]);
  const backup = record(record(fundingLedger.reservations)[String(payload.backupReservationId)]);
  const backupDispatch = database
    .query<{ count: number }, [string, string]>(
      `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.reservationId')=?
       AND json_extract(event_json,'$.type') IN
         ('resource_budget.dispatch_started','resource_budget.unknown','resource_budget.released')`,
    )
    .get(sourceSessionId, String(payload.backupReservationId))?.count;
  if (
    payload.sourceSessionId !== sourceSessionId ||
    payload.targetSessionId !== targetSessionId ||
    payload.submissionId !== submissionId ||
    payload.messageId !== route.messageId ||
    fundingRunId !== outbox.sourceRunId ||
    fundingLedger.runId !== fundingRunId ||
    backup.reservationId !== payload.backupReservationId ||
    backup.runId !== fundingRunId ||
    backup.invocationId !== submissionId ||
    backup.resourceKind !== 'subagent' ||
    !currentTurnHeldBackupProven(
      database,
      sourceSessionId,
      String(payload.backupReservationId),
      backup.state,
    ) ||
    !sameCanonicalValue(backup.executableUpperBound, payload.executableUpperBound) ||
    backupDispatch !== 0
  )
    return null;
  return Object.freeze({
    ...common,
    stage: 'routed' as const,
    releaseSourceRevision: null,
    sourceRevision: source.revision,
  });
}

/** Source-owner proof after the exact backup release ACK; unchanged admission checks. */
export function readCurrentTurnDispatchedChildProofForSource(
  database: Database,
  sourceSessionId: string,
  targetSessionId: string,
  submissionId: string,
): CrossSessionCurrentTurnDispatchedChildProof | null {
  const proof = readCurrentTurnChildProofForSource(
    database,
    sourceSessionId,
    targetSessionId,
    submissionId,
    'released',
  );
  return proof?.stage === 'released' ? proof : null;
}

/** Source-owner proof for a routed, unattempted child before backup release. */
export function readCurrentTurnRoutedNoAttemptChildProofForSource(
  database: Database,
  sourceSessionId: string,
  targetSessionId: string,
  submissionId: string,
): CrossSessionCurrentTurnRoutedChildProof | null {
  const proof = readCurrentTurnChildProofForSource(
    database,
    sourceSessionId,
    targetSessionId,
    submissionId,
    'routed',
  );
  return proof?.stage === 'routed' ? proof : null;
}

type CrossSessionCurrentTurnTargetNoAttemptProof = Omit<
  CrossSessionCurrentTurnPreparedNoAttemptProof,
  'releaseSourceRevision'
> & { readonly releaseSourceRevision: number | null };

/** Shared exact old-Run Model proof. A routed proof never invents a source release ACK. */
function readCurrentTurnTargetNoAttemptProof(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
  stage: 'routed' | 'released',
): CrossSessionCurrentTurnTargetNoAttemptProof | null {
  const route = readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
  const release = readCrossSessionCurrentTurnBackupReleaseForTarget(
    database,
    targetSessionId,
    sourceSessionId,
    submissionId,
  );
  const target = database
    .query<{ revision: number; snapshot_revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.revision AS snapshot_revision,p.state_json FROM runtime_sessions s
     JOIN runtime_snapshots p ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(targetSessionId);
  if (
    !route ||
    route.route !== 'current_turn' ||
    route.sourceSessionId !== sourceSessionId ||
    (stage === 'released' && !release) ||
    (stage === 'routed' && release !== null) ||
    (release !== null &&
      (release.targetRunId !== route.targetRunId ||
        release.invocationId !== route.invocationId ||
        release.reservationId !== route.reservationId)) ||
    !target ||
    target.revision !== target.snapshot_revision ||
    target.revision < route.routedRevision
  )
    return null;
  const state = parse(target.state_json);
  const model = record(record(state.modelInvocations)[route.invocationId]);
  const surface = record(model.surfaceArtifact);
  const budget = record(model.budget);
  const ledger = record(state.resourceBudget);
  const local = record(record(ledger.reservations)[route.reservationId]);
  const grant = readChildSealedGrant(database, sourceSessionId, targetSessionId);
  const childRole = database
    .query<{ role: string }, [string]>(
      'SELECT role FROM child_session_intents WHERE child_thread_id=?',
    )
    .get(targetSessionId)?.role;
  const grantPayload = grant ? parse(grant.sealedGrantJson) : {};
  const ceiling = record(grantPayload.capabilityCeiling);
  const authorization = record(grantPayload.authorization);
  const origin = record(state.childSessionOrigin);
  const run = database
    .query<{ status: string; start_command_id: string; phase: string }, [string, string]>(
      'SELECT status,start_command_id,phase FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(targetSessionId, route.targetRunId);
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
    .get(targetSessionId, route.messageId);
  const attempted = database
    .query<{ found: number }, [string, string, string]>(
      `SELECT 1 AS found FROM runtime_events WHERE session_id=? AND
      ((json_extract(event_json,'$.type')='model.invocation_attempt_started'
        AND json_extract(event_json,'$.invocationId')=?) OR
       (json_extract(event_json,'$.type')='resource_budget.dispatch_started'
        AND json_extract(event_json,'$.reservationId')=?)) LIMIT 1`,
    )
    .get(targetSessionId, route.invocationId, route.reservationId);
  const effect = database
    .query<{ found: number }, [string]>(
      'SELECT 1 AS found FROM runtime_effect_leases WHERE session_id=? LIMIT 1',
    )
    .get(targetSessionId);
  if (
    !run ||
    (!['running', 'waiting'].includes(run.status) &&
      !isAdmittedQueuedChildFollowupTarget(
        database,
        sourceSessionId,
        targetSessionId,
        route.targetRunId,
      )) ||
    run.start_command_id.startsWith('followup:') ||
    record(state.turn).status !== 'active' ||
    state.activeTaskId !== route.taskId ||
    state.activeFollowupTurn !== undefined ||
    !grant ||
    !['explore', 'plan', 'review'].includes(String(childRole)) ||
    origin.grantDigest !== grant.sealedGrantDigest ||
    origin.parentSessionId !== sourceSessionId ||
    origin.terminal !== undefined ||
    !finiteCurrentTurnToolCeiling(ceiling, childRole) ||
    (Array.isArray(ceiling.allowedTools) &&
      ceiling.allowedTools.length > 0 &&
      grantPayload.role !== childRole) ||
    authorization.interactionMode !== state.mode ||
    (Array.isArray(ceiling.allowedTools) &&
      ceiling.allowedTools.length > 0 &&
      authorization.phase !== run.phase) ||
    model.status !== 'prepared' ||
    model.attempts !== 0 ||
    !Number.isSafeInteger(model.estimatedInputTokens) ||
    budget.kind !== 'reservation' ||
    budget.reservationId !== route.reservationId ||
    ledger.status !== 'active' ||
    ledger.runId !== route.targetRunId ||
    local.reservationId !== route.reservationId ||
    local.state !== 'reserved' ||
    local.runId !== route.targetRunId ||
    local.invocationId !== `model-invocation:${route.invocationId}` ||
    local.resourceKind !== 'model' ||
    surface.kind !== 'model_surface' ||
    typeof surface.artifactId !== 'string' ||
    typeof surface.integrityIdentifier !== 'string' ||
    !Number.isSafeInteger(surface.byteLength) ||
    model.surfaceIntegrityIdentifier !== surface.integrityIdentifier ||
    !inbox ||
    inbox.source_session_id !== sourceSessionId ||
    inbox.target_run_id !== route.targetRunId ||
    inbox.prepared_invocation_id !== route.invocationId ||
    inbox.prepared_model_admission_id !== route.modelAdmissionId ||
    attempted ||
    effect
  )
    return null;
  const surfaceRef = Object.freeze({
    artifactId: String(surface.artifactId),
    kind: 'model_surface' as const,
    integrityIdentifier: String(surface.integrityIdentifier),
    byteLength: Number(surface.byteLength),
  });
  let stored: ReturnType<ReturnType<typeof createKiteHomeArtifactStore>['readModel']>;
  try {
    stored = createKiteHomeArtifactStore(database).readModel(surfaceRef);
  } catch {
    return null;
  }
  if (
    stored.artifactFormatVersion !== 1 ||
    !matchesModelArtifactReference('model_surface', stored.canonicalJson, surfaceRef)
  )
    return null;
  const outbox = database
    .query<{ source_task_id: string | null }, [string, string]>(
      'SELECT source_task_id FROM agent_mail_outbox WHERE source_session_id=? AND message_id=?',
    )
    .get(sourceSessionId, route.messageId);
  const body = readReceivedCrossSessionMailBody(database, targetSessionId, route.messageId);
  if (!outbox || body === null) return null;
  const frame = `<agent_message message_id="${escapeCurrentTurnMail(route.messageId)}" sender_agent_id="${escapeCurrentTurnMail(sourceSessionId)}"${outbox.source_task_id ? ` source_task_id="${escapeCurrentTurnMail(outbox.source_task_id)}"` : ''}>\n${escapeCurrentTurnMail(body)}\n</agent_message>`;
  const surfacePayload = parse(stored.canonicalJson);
  const request = record(surfacePayload.request);
  const surfaceSchema = record(surfacePayload.schema);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const frames = messages.filter((value) => {
    const message = record(value);
    const parts = Array.isArray(message.content) ? message.content : [];
    return (
      message.role === 'user' &&
      parts.length === 1 &&
      record(parts[0]).type === 'text' &&
      record(parts[0]).text === frame
    );
  });
  if (
    surfaceSchema.name !== 'kite.model-surface' ||
    surfaceSchema.canonicalizerVersion !== 'kite.model-surface.canonical-json.v1' ||
    surfaceSchema.surfaceFormatVersion !== 1 ||
    frames.length !== 1 ||
    !currentTurnSurfaceWithinCeiling(request.tools, ceiling)
  )
    return null;
  return Object.freeze({
    submissionId,
    targetRunId: route.targetRunId,
    invocationId: route.invocationId,
    modelReservationId: route.reservationId,
    preparedStateRevision: target.revision,
    surfaceRef,
    surfaceDigest: surfaceRef.integrityIdentifier,
    estimatedInputTokens: Number(model.estimatedInputTokens),
    releaseSourceRevision: release?.sourceRevision ?? null,
    routeDigest:
      release?.routeDigest ??
      `sha256:${createHash('sha256').update(JSON.stringify(route)).digest('hex')}`,
    routedTargetRevision: route.routedRevision,
  });
}

/** Exact old-Run prepared Model proof for same-ID recovery after source release. */
export function readCrossSessionCurrentTurnPreparedNoAttemptProof(
  database: Database,
  targetSessionId: string,
  sourceSessionId: string,
  submissionId: string,
): CrossSessionCurrentTurnPreparedNoAttemptProof | null {
  const proof = readCurrentTurnTargetNoAttemptProof(
    database,
    targetSessionId,
    sourceSessionId,
    submissionId,
    'released',
  );
  return proof?.releaseSourceRevision === null || !proof
    ? null
    : Object.freeze({ ...proof, releaseSourceRevision: proof.releaseSourceRevision });
}

export function readLastReleasedFollowupForDirectChild(
  database: Database,
  sourceSessionId: string,
  currentRunId: string,
  childSessionId: string,
): Readonly<{
  submissionId: string;
  status: 'failed';
  reason: CrossSessionAcceptedFollowupReleaseReason;
  sourceRevision: number;
}> | null {
  const row = database
    .query<
      {
        submission_id: string;
        accepted_release_source_revision: number;
        accepted_release_reason: CrossSessionAcceptedFollowupReleaseReason;
      },
      [string, string, string]
    >(`SELECT o.submission_id,o.accepted_release_source_revision,o.accepted_release_reason FROM agent_mail_outbox o
    JOIN runtime_sessions source ON source.session_id=o.source_session_id
    JOIN runtime_sessions child ON child.session_id=o.target_session_id
    WHERE o.source_session_id=? AND o.source_run_id=? AND o.target_session_id=?
      AND o.mode='trigger_turn' AND o.accepted_release_source_revision IS NOT NULL
      AND child.parent_session_id=source.session_id
      AND child.workspace_id=source.workspace_id AND child.project_id=source.project_id
      AND child.workspace_digest=source.workspace_digest
    ORDER BY o.accepted_release_source_revision DESC LIMIT 1`)
    .get(sourceSessionId, currentRunId, childSessionId);
  return row
    ? Object.freeze({
        submissionId: row.submission_id,
        status: 'failed' as const,
        reason: row.accepted_release_reason,
        sourceRevision: row.accepted_release_source_revision,
      })
    : null;
}

export function readDirectChildFollowupReleaseWatermark(
  database: Database,
  sourceSessionId: string,
  currentRunId: string,
): Readonly<{ count: number; throughRevision: number }> {
  const row = database
    .query<{ count: number; through_revision: number }, [string, string]>(
      `SELECT count(*) AS count,
      coalesce(max(o.accepted_release_source_revision),0) AS through_revision
     FROM agent_mail_outbox o
     JOIN runtime_sessions source ON source.session_id=o.source_session_id
     JOIN runtime_sessions child ON child.session_id=o.target_session_id
     WHERE o.source_session_id=? AND o.source_run_id=? AND o.mode='trigger_turn'
       AND o.accepted_release_source_revision IS NOT NULL
       AND child.parent_session_id=source.session_id
       AND child.workspace_id=source.workspace_id AND child.project_id=source.project_id
       AND child.workspace_digest=source.workspace_digest`,
    )
    .get(sourceSessionId, currentRunId);
  return Object.freeze({ count: row?.count ?? 0, throughRevision: row?.through_revision ?? 0 });
}

export function readLastFollowupOutcomeForDirectChild(
  database: Database,
  sourceSessionId: string,
  currentRunId: string,
  childSessionId: string,
): Readonly<{
  submissionId: string;
  status: 'completed' | 'unknown' | 'pre_dispatch_released' | 'failed';
  taskId?: string;
  reason?: CrossSessionAcceptedFollowupReleaseReason;
  sourceRevision: number;
}> | null {
  const row = database
    .query<
      {
        submission_id: string;
        status: 'completed' | 'unknown' | 'pre_dispatch_released' | 'failed';
        task_id: string | null;
        source_revision: number;
        accepted_release_source_revision: number | null;
        terminal_disposition: string | null;
        accepted_release_reason: CrossSessionAcceptedFollowupReleaseReason | null;
      },
      [string, string, string]
    >(`SELECT o.submission_id,
    CASE WHEN f.terminal_disposition IS NOT NULL THEN f.terminal_disposition
      ELSE 'failed' END AS status,
    route.task_id,coalesce(f.terminal_source_revision,o.accepted_release_source_revision)
      AS source_revision,o.accepted_release_source_revision,f.terminal_disposition,
      o.accepted_release_reason
    FROM agent_mail_outbox o
    JOIN runtime_sessions source ON source.session_id=o.source_session_id
    JOIN runtime_sessions child ON child.session_id=o.target_session_id
    LEFT JOIN agent_followup_funding_receipts f ON f.source_session_id=o.source_session_id
      AND f.submission_id=o.submission_id
    LEFT JOIN agent_followup_routes route ON route.source_session_id=o.source_session_id
      AND route.submission_id=o.submission_id
    WHERE o.source_session_id=? AND o.source_run_id=? AND o.target_session_id=?
      AND o.mode='trigger_turn' AND child.parent_session_id=source.session_id
      AND child.workspace_id=source.workspace_id AND child.project_id=source.project_id
      AND child.workspace_digest=source.workspace_digest
      AND (f.terminal_disposition IS NOT NULL OR o.accepted_release_source_revision IS NOT NULL)
    ORDER BY source_revision DESC,
      coalesce(f.terminal_at_ms,o.accepted_released_at_ms) DESC,o.submission_id DESC LIMIT 1`)
    .get(sourceSessionId, currentRunId, childSessionId);
  const independent = database
    .query<
      {
        submission_id: string;
        source_revision: number;
        event_json: string;
        task_id: string | null;
      },
      [string, string, string]
    >(
      `SELECT o.submission_id,e.sequence AS source_revision,e.event_json,r.task_id
       FROM agent_mail_outbox o JOIN runtime_events e ON e.session_id=o.source_session_id
       LEFT JOIN agent_followup_routes r ON r.source_session_id=o.source_session_id
         AND r.submission_id=o.submission_id
       WHERE o.source_session_id=? AND o.source_run_id=? AND o.target_session_id=?
         AND o.mode='trigger_turn'
         AND json_extract(e.event_json,'$.type')='agent.followup_independent_settled'
         AND json_extract(e.event_json,'$.submissionId')=o.submission_id
       ORDER BY e.sequence DESC LIMIT 1`,
    )
    .get(sourceSessionId, currentRunId, childSessionId);
  if (independent && (!row || independent.source_revision > row.source_revision)) {
    const audit = parse(independent.event_json);
    if (!['completed', 'unknown', 'pre_dispatch_released'].includes(String(audit.disposition)))
      invalid();
    return Object.freeze({
      submissionId: independent.submission_id,
      status: audit.disposition as 'completed' | 'unknown' | 'pre_dispatch_released',
      ...(independent.task_id ? { taskId: independent.task_id } : {}),
      sourceRevision: independent.source_revision,
    });
  }
  if (!row) return null;
  if (row.accepted_release_source_revision !== null && row.terminal_disposition !== null) invalid();
  return Object.freeze({
    submissionId: row.submission_id,
    status: row.status,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.accepted_release_reason ? { reason: row.accepted_release_reason } : {}),
    sourceRevision: row.source_revision,
  });
}

export function readDirectChildFollowupOutcomeWatermark(
  database: Database,
  sourceSessionId: string,
  currentRunId: string,
): Readonly<{ count: number; throughRevision: number }> {
  const row = database
    .query<{ count: number; through_revision: number; conflicts: number }, [string, string]>(
      `SELECT count(*) AS count,
      coalesce(max(coalesce(f.terminal_source_revision,o.accepted_release_source_revision)),0)
        AS through_revision,
      sum(CASE WHEN f.terminal_disposition IS NOT NULL
        AND o.accepted_release_source_revision IS NOT NULL THEN 1 ELSE 0 END) AS conflicts
     FROM agent_mail_outbox o
     JOIN runtime_sessions source ON source.session_id=o.source_session_id
     JOIN runtime_sessions child ON child.session_id=o.target_session_id
     LEFT JOIN agent_followup_funding_receipts f ON f.source_session_id=o.source_session_id
       AND f.submission_id=o.submission_id
     WHERE o.source_session_id=? AND o.source_run_id=? AND o.mode='trigger_turn'
       AND child.parent_session_id=source.session_id
       AND child.workspace_id=source.workspace_id AND child.project_id=source.project_id
       AND child.workspace_digest=source.workspace_digest
       AND (f.terminal_disposition IS NOT NULL OR o.accepted_release_source_revision IS NOT NULL)`,
    )
    .get(sourceSessionId, currentRunId);
  if (row?.conflicts) invalid();
  const independent = database
    .query<{ count: number; through_revision: number }, [string, string]>(
      `SELECT count(*) AS count,coalesce(max(e.sequence),0) AS through_revision
       FROM agent_mail_outbox o JOIN runtime_events e ON e.session_id=o.source_session_id
       WHERE o.source_session_id=? AND o.source_run_id=? AND o.mode='trigger_turn'
         AND json_extract(e.event_json,'$.type')='agent.followup_independent_settled'
         AND json_extract(e.event_json,'$.submissionId')=o.submission_id`,
    )
    .get(sourceSessionId, currentRunId);
  return Object.freeze({
    count: (row?.count ?? 0) + (independent?.count ?? 0),
    throughRevision: Math.max(row?.through_revision ?? 0, independent?.through_revision ?? 0),
  });
}

export interface CrossSessionFollowupTerminalReceipt {
  readonly sourceSessionId: string;
  readonly submissionId: string;
  readonly targetSessionId: string;
  readonly targetRunId: string;
  readonly modelInvocationId: string;
  readonly targetRevision: number;
  readonly sourceRevision: number;
  readonly disposition: CrossSessionFollowupTerminalIntent['disposition'];
  readonly evidenceDigest: string;
  readonly createdAtMs: number;
}

/** Hash the exact persisted snapshot bytes used by terminal settlement validation. */
export function readTargetSnapshotEvidence(
  database: Database,
  targetSessionId: string,
  expectedRevision: number,
): Readonly<{ revision: number; digest: string }> | null {
  if (!targetSessionId || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    return null;
  const row = database
    .query<{ revision: number; snapshot_revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.revision AS snapshot_revision,p.state_json FROM runtime_sessions s
       JOIN runtime_snapshots p ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(targetSessionId);
  if (!row || row.revision !== expectedRevision || row.snapshot_revision !== expectedRevision)
    return null;
  return Object.freeze({
    revision: expectedRevision,
    digest: `sha256:${createHash('sha256').update(row.state_json).digest('hex')}`,
  });
}

/** Source owner settles its two held reservations from durable target evidence. */
export function settleCrossSessionFollowupFundingInTransaction(
  database: Database,
  input: CrossSessionFollowupTerminalIntent,
): CrossSessionFollowupTerminalReceipt {
  requireTransaction(database);
  const funding = readCrossSessionFollowupFundingReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  const activation = readCrossSessionFollowupActivationReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  const targetRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
     ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  const evidenceDigest = targetRow
    ? `sha256:${createHash('sha256').update(targetRow.state_json).digest('hex')}`
    : '';
  const prior = readCrossSessionFollowupTerminalReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  if (prior) {
    if (
      prior.targetSessionId !== input.targetSessionId ||
      prior.targetRunId !== input.targetRunId ||
      prior.modelInvocationId !== input.modelInvocationId ||
      prior.targetRevision !== input.targetRevision ||
      prior.sourceRevision !== input.sourceRevision ||
      prior.disposition !== input.disposition ||
      prior.createdAtMs !== input.createdAtMs
    )
      conflict();
    return prior;
  }
  if (
    !funding ||
    funding.targetSessionId !== input.targetSessionId ||
    funding.targetRunId !== input.targetRunId ||
    funding.modelInvocationId !== input.modelInvocationId ||
    !targetRow ||
    targetRow.revision !== input.targetRevision ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < funding.createdAtMs ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < funding.sourceRevision ||
    input.events.length !== 2
  )
    invalid();
  const target = parse(targetRow.state_json);
  const targetModel = record(record(target.modelInvocations)[input.modelInvocationId]);
  const local = record(
    record(record(target.resourceBudget).reservations)[funding.targetModelReservationId],
  );
  const targetRun = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  const sourceBudget = record(input.sourceSnapshot.resourceBudget);
  const ledger =
    sourceBudget.runId === funding.fundingRunId
      ? sourceBudget
      : record(record(input.sourceSnapshot.retainedResourceBudgets)[funding.fundingRunId]);
  const reservations = record(ledger.reservations);
  const turn = record(reservations[funding.turnReservationId]);
  const model = record(reservations[funding.modelReservationId]);
  const eventById = new Map(input.events.map((event) => [event.reservationId, event]));
  const turnEvent = record(eventById.get(funding.turnReservationId));
  const modelEvent = record(eventById.get(funding.modelReservationId));
  if (
    eventById.size !== 2 ||
    !targetRun ||
    record(targetModel.surfaceArtifact).artifactId !== funding.surfaceArtifactId ||
    record(targetModel.budget).reservationId !== funding.targetModelReservationId ||
    (!sameCanonicalValue(turn.actual, turnEvent.actual) && input.disposition === 'completed') ||
    (!sameCanonicalValue(model.actual, modelEvent.actual) && input.disposition === 'completed')
  )
    invalid();
  if (input.disposition === 'completed') {
    const actual = record(local.actual);
    const turnActual = record(turnEvent.actual);
    const turnCounters = record(turnActual.counters);
    const turnGauges = record(turnActual.gauges);
    const checkpoint = readChildTerminalCheckpoint(database, input.targetSessionId);
    const checkpointPayload = checkpoint ? parse(checkpoint.canonicalJson) : {};
    if (
      !activation ||
      !checkpoint ||
      checkpoint.terminalRevision !== input.targetRevision ||
      checkpointPayload.terminalRunId !== input.targetRunId ||
      checkpointPayload.terminalStatus !== 'completed' ||
      checkpointPayload.stateDigest !== evidenceDigest ||
      checkpointPayload.transcriptDigest !==
        `sha256:${createHash('sha256').update(JSON.stringify(target.transcript)).digest('hex')}` ||
      targetRun.status !== 'completed' ||
      record(target.turn).status !== 'completed' ||
      record(target.terminalOutcome).status !== 'completed' ||
      targetModel.status !== 'completed' ||
      targetModel.attempts !== 1 ||
      record(targetModel.responseArtifact).kind !== 'model_response' ||
      local.state !== 'reconciled' ||
      !local.actual ||
      record(actual.counters).toolInvocations !== 0 ||
      !sameCanonicalValue(modelEvent.actual, local.actual) ||
      turnEvent.type !== 'resource_budget.reconciled' ||
      modelEvent.type !== 'resource_budget.reconciled' ||
      turn.state !== 'reconciled' ||
      model.state !== 'reconciled' ||
      turnCounters.turns !== 1 ||
      turnCounters.modelRequests !== 0 ||
      turnCounters.toolInvocations !== 0 ||
      turnCounters.inputTokens !== 0 ||
      turnCounters.outputTokens !== 0 ||
      turnCounters.artifactBytes !== 0 ||
      turnGauges.activeSubagents !== 1 ||
      !boundedUsage(turnActual, record(turn.executableUpperBound)) ||
      !boundedUsage(actual, record(model.executableUpperBound))
    )
      invalid();
    const response = record(targetModel.responseArtifact);
    if (
      typeof response.artifactId !== 'string' ||
      typeof response.integrityIdentifier !== 'string' ||
      !Number.isSafeInteger(response.byteLength)
    )
      invalid();
    const storedResponse = createKiteHomeArtifactStore(database).readModel({
      artifactId: response.artifactId,
      kind: 'model_response',
      integrityIdentifier: response.integrityIdentifier,
      byteLength: Number(response.byteLength),
    });
    if (!matchesModelArtifactReference('model_response', storedResponse.canonicalJson, response))
      invalid();
  } else if (input.disposition === 'unknown') {
    if (
      !activation ||
      targetRun.status !== 'unknown' ||
      local.state !== 'unknown' ||
      !Number.isSafeInteger(targetModel.attempts) ||
      Number(targetModel.attempts) < 1 ||
      turnEvent.type !== 'resource_budget.unknown' ||
      modelEvent.type !== 'resource_budget.unknown' ||
      turn.state !== 'unknown' ||
      model.state !== 'unknown'
    )
      invalid();
  } else {
    const attempts =
      database
        .query<{ count: number }, [string, string]>(
          `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='model.invocation_attempt_started'
       AND json_extract(event_json,'$.invocationId')=?`,
        )
        .get(input.targetSessionId, input.modelInvocationId)?.count ?? 0;
    if (
      attempts !== 0 ||
      targetModel.attempts !== 0 ||
      !['failed', 'cancelled'].includes(targetRun.status) ||
      !['reserved', 'released'].includes(String(local.state)) ||
      turnEvent.type !== 'resource_budget.released' ||
      modelEvent.type !== 'resource_budget.released' ||
      turnEvent.proof !== 'local_pre_dispatch_failure' ||
      modelEvent.proof !== 'local_pre_dispatch_failure' ||
      turn.state !== 'released' ||
      model.state !== 'released'
    )
      invalid();
  }
  const changed = database
    .query(`UPDATE agent_followup_funding_receipts SET
    terminal_disposition=?,terminal_target_revision=?,terminal_source_revision=?,
    terminal_evidence_digest=?,terminal_at_ms=?
    WHERE source_session_id=? AND submission_id=? AND terminal_disposition IS NULL`)
    .run(
      input.disposition,
      input.targetRevision,
      input.sourceRevision,
      evidenceDigest,
      input.createdAtMs,
      input.sourceSessionId,
      input.submissionId,
    ).changes;
  if (changed !== 1) conflict();
  return Object.freeze({
    sourceSessionId: input.sourceSessionId,
    submissionId: input.submissionId,
    targetSessionId: input.targetSessionId,
    targetRunId: input.targetRunId,
    modelInvocationId: input.modelInvocationId,
    targetRevision: input.targetRevision,
    sourceRevision: input.sourceRevision,
    disposition: input.disposition,
    evidenceDigest,
    createdAtMs: input.createdAtMs,
  });
}

/** Settle the v2 source backup against the entire durable target Run ledger. */
export function settleIndependentCrossSessionFollowupFundingInTransaction(
  database: Database,
  input: Readonly<{
    sourceSessionId: string;
    targetSessionId: string;
    submissionId: string;
    targetRunId: string;
    targetRevision: number;
    disposition: 'completed' | 'unknown' | 'pre_dispatch_released';
    sourceRevision: number;
    createdAtMs: number;
    sourceSnapshot: Readonly<RecordValue>;
    events: readonly Readonly<RecordValue>[];
  }>,
): CrossSessionFollowupTerminalReceipt {
  requireTransaction(database);
  const proof = readAcceptedIndependentFollowupSourcePolicyProof(
    database,
    input.targetSessionId,
    input.sourceSessionId,
    input.submissionId,
  );
  const targetRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
       ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  const target = targetRow ? parse(targetRow.state_json) : {};
  const targetLedger = record(target.resourceBudget);
  const targetUsage = record(targetLedger.reconciledUsage);
  const targetCounters = record(targetUsage.counters);
  const sourceActive = record(input.sourceSnapshot.resourceBudget);
  const sourceRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
       ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.sourceSessionId);
  const admission = proof?.admission ?? {};
  const sourceLedger =
    sourceActive.runId === admission.fundingRunId
      ? sourceActive
      : record(
          record(input.sourceSnapshot.retainedResourceBudgets)[String(admission.fundingRunId)],
        );
  const backup = record(record(sourceLedger.reservations)[String(admission.backupReservationId)]);
  const route = readCrossSessionFollowupRoute(database, input.targetSessionId, input.submissionId);
  const run = database
    .query<
      { status: string; start_command_id: string; created_revision: number },
      [string, string]
    >(
      'SELECT status,start_command_id,created_revision FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  const targetSettlement = database
    .query<{ event_json: string }, [string, number]>(
      `SELECT event_json FROM runtime_events WHERE session_id=? AND sequence=?
       AND json_extract(event_json,'$.type')='agent.followup_turn_settled'`,
    )
    .get(input.targetSessionId, input.targetRevision);
  const settled = targetSettlement ? parse(targetSettlement.event_json) : {};
  const budgetEvents = input.events.filter((item) =>
    ['resource_budget.reconciled', 'resource_budget.unknown', 'resource_budget.released'].includes(
      String(item.type),
    ),
  );
  const auditEvents = input.events.filter(
    (item) => item.type === 'agent.followup_independent_settled',
  );
  const event = record(budgetEvents[0]);
  const audit = record(auditEvents[0]);
  const actual = record(event.actual);
  const actualCounters = record(actual.counters);
  const evidenceDigest = targetRow
    ? `sha256:${createHash('sha256').update(targetRow.state_json).digest('hex')}`
    : '';
  const expectedEvent =
    input.disposition === 'completed'
      ? 'resource_budget.reconciled'
      : input.disposition === 'unknown'
        ? 'resource_budget.unknown'
        : 'resource_budget.released';
  if (
    !proof ||
    !targetRow ||
    targetRow.revision !== input.targetRevision ||
    !sourceRow ||
    sourceRow.revision !== input.sourceRevision ||
    !sameCanonicalValue(parse(sourceRow.state_json), input.sourceSnapshot) ||
    !run ||
    run.start_command_id !== `followup:${input.submissionId}` ||
    settled.sourceSessionId !== input.sourceSessionId ||
    settled.submissionId !== input.submissionId ||
    settled.targetRunId !== input.targetRunId ||
    settled.status !== run.status ||
    (route !== null && settled.taskId !== route.taskId) ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 1 ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0 ||
    sourceLedger.runId !== admission.fundingRunId ||
    backup.reservationId !== admission.backupReservationId ||
    !sameCanonicalValue(backup.executableUpperBound, admission.executableUpperBound) ||
    auditEvents.length !== 1 ||
    input.events.length !== budgetEvents.length + 1 ||
    budgetEvents.length > 1 ||
    (budgetEvents.length === 0 && input.disposition !== 'unknown') ||
    (budgetEvents.length === 1 && event.type !== expectedEvent) ||
    (budgetEvents.length === 1 && event.reservationId !== admission.backupReservationId) ||
    audit.submissionId !== input.submissionId ||
    audit.targetAgentId !== input.targetSessionId ||
    audit.targetRunId !== input.targetRunId ||
    audit.targetRevision !== input.targetRevision ||
    audit.disposition !== input.disposition ||
    audit.evidenceDigest !== evidenceDigest ||
    audit.createdAtMs !== input.createdAtMs ||
    (input.disposition === 'completed' && backup.state !== 'reconciled') ||
    (input.disposition === 'unknown' && backup.state !== 'unknown') ||
    (input.disposition === 'pre_dispatch_released' && backup.state !== 'released')
  )
    invalid();
  if (input.disposition === 'completed') {
    const checkpoint = readChildTerminalCheckpoint(database, input.targetSessionId);
    const checkpointPayload = checkpoint ? parse(checkpoint.canonicalJson) : {};
    if (
      !checkpoint ||
      ![input.targetRevision - 1, input.targetRevision].includes(checkpoint.terminalRevision) ||
      checkpointPayload.terminalRunId !== input.targetRunId ||
      checkpointPayload.terminalStatus !== 'completed' ||
      (checkpoint.terminalRevision === input.targetRevision &&
        checkpointPayload.stateDigest !== evidenceDigest) ||
      run.status !== 'completed' ||
      record(target.turn).status !== 'completed' ||
      record(target.terminalOutcome).status !== 'completed' ||
      budgetEvents.length !== 1 ||
      actual.source !== 'actual' ||
      !sameCanonicalValue(backup.actual, actual) ||
      !boundedUsage(actual, record(backup.executableUpperBound)) ||
      actualCounters.turns !== 1 ||
      record(actual.gauges).activeSubagents !== 1 ||
      !['modelRequests', 'toolInvocations', 'inputTokens', 'outputTokens', 'artifactBytes'].every(
        (key) =>
          Number.isSafeInteger(targetCounters[key]) && actualCounters[key] === targetCounters[key],
      )
    )
      invalid();
  } else if (input.disposition === 'unknown') {
    if (
      run.status !== 'unknown' ||
      !hasIndependentFollowupSourceActivation(database, input.sourceSessionId, admission)
    )
      invalid();
  } else {
    const attempts = database
      .query<{ count: number }, [string, number]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
         AND json_extract(event_json,'$.type')='model.invocation_attempt_started'
         AND sequence>?`,
      )
      .get(input.targetSessionId, run.created_revision)?.count;
    if (
      !['failed', 'cancelled'].includes(run.status) ||
      budgetEvents.length !== 1 ||
      event.proof !== 'local_pre_dispatch_failure' ||
      attempts !== 0
    )
      invalid();
  }
  return Object.freeze({
    sourceSessionId: input.sourceSessionId,
    submissionId: input.submissionId,
    targetSessionId: input.targetSessionId,
    targetRunId: input.targetRunId,
    modelInvocationId: route?.invocationId ?? '',
    targetRevision: input.targetRevision,
    sourceRevision: input.sourceRevision,
    disposition: input.disposition,
    evidenceDigest,
    createdAtMs: input.createdAtMs,
  });
}

/** Recovery ACK only: both source reservations were already made unknown by generic recovery. */
export function settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction(
  database: Database,
  input: Readonly<{
    sourceSessionId: string;
    targetSessionId: string;
    submissionId: string;
    targetRunId: string;
    modelInvocationId: string;
    targetRevision: number;
    sourceRevision: number;
    createdAtMs: number;
    sourceSnapshot: Readonly<RecordValue>;
  }>,
): CrossSessionFollowupTerminalReceipt {
  requireTransaction(database);
  const funding = readCrossSessionFollowupFundingReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  const activation = readCrossSessionFollowupActivationReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  const route = readCrossSessionFollowupRoute(database, input.targetSessionId, input.submissionId);
  const lineage = database
    .query<
      {
        parent_session_id: string | null;
        source_workspace_id: string;
        source_project_id: string;
        source_workspace_digest: string;
        target_workspace_id: string;
        target_project_id: string;
        target_workspace_digest: string;
      },
      [string, string]
    >(`SELECT target.parent_session_id,
    source.workspace_id AS source_workspace_id,source.project_id AS source_project_id,
    source.workspace_digest AS source_workspace_digest,
    target.workspace_id AS target_workspace_id,target.project_id AS target_project_id,
    target.workspace_digest AS target_workspace_digest
    FROM runtime_sessions source JOIN runtime_sessions target ON target.session_id=?
    WHERE source.session_id=?`)
    .get(input.targetSessionId, input.sourceSessionId);
  const sourceRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
     ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.sourceSessionId);
  const targetRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
     ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  const evidenceDigest = targetRow
    ? `sha256:${createHash('sha256').update(targetRow.state_json).digest('hex')}`
    : '';
  const prior = readCrossSessionFollowupTerminalReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  if (prior) {
    if (
      prior.targetSessionId !== input.targetSessionId ||
      prior.targetRunId !== input.targetRunId ||
      prior.modelInvocationId !== input.modelInvocationId ||
      prior.targetRevision !== input.targetRevision ||
      prior.sourceRevision !== input.sourceRevision ||
      prior.disposition !== 'unknown' ||
      prior.evidenceDigest !== evidenceDigest ||
      prior.createdAtMs !== input.createdAtMs
    )
      conflict();
    return prior;
  }
  if (
    !funding ||
    !activation ||
    !route ||
    route.route !== 'new_turn' ||
    !lineage ||
    lineage.parent_session_id !== input.sourceSessionId ||
    lineage.source_workspace_id !== lineage.target_workspace_id ||
    lineage.source_project_id !== lineage.target_project_id ||
    lineage.source_workspace_digest !== lineage.target_workspace_digest ||
    route.sourceSessionId !== input.sourceSessionId ||
    route.targetSessionId !== input.targetSessionId ||
    route.targetRunId !== input.targetRunId ||
    route.invocationId !== input.modelInvocationId ||
    route.reservationId !== funding.targetModelReservationId ||
    funding.targetSessionId !== input.targetSessionId ||
    funding.targetRunId !== input.targetRunId ||
    funding.modelInvocationId !== input.modelInvocationId ||
    activation.targetRunId !== input.targetRunId ||
    activation.modelInvocationId !== input.modelInvocationId ||
    !sourceRow ||
    sourceRow.revision !== input.sourceRevision ||
    !sameCanonicalValue(parse(sourceRow.state_json), input.sourceSnapshot) ||
    !targetRow ||
    targetRow.revision !== input.targetRevision ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < funding.createdAtMs
  )
    invalid();
  const source = input.sourceSnapshot;
  const active = record(source.resourceBudget);
  const ledger =
    active.runId === funding.fundingRunId
      ? active
      : record(record(source.retainedResourceBudgets)[funding.fundingRunId]);
  const reservations = record(ledger.reservations);
  const turn = record(reservations[funding.turnReservationId]);
  const model = record(reservations[funding.modelReservationId]);
  const target = parse(targetRow.state_json);
  const targetModel = record(record(target.modelInvocations)[input.modelInvocationId]);
  const targetLedger = record(target.resourceBudget);
  const local = record(record(targetLedger.reservations)[funding.targetModelReservationId]);
  const targetRun = database
    .query<{ status: string }, [string, string]>(
      'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  const countEvent = (sessionId: string, type: string, key: string, value: string): number =>
    database
      .query<{ count: number }, [string, string, string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')=?
       AND json_extract(event_json,?)=?`,
      )
      .get(sessionId, type, key, value)?.count ?? 0;
  const sourceTurnUnknown = countEvent(
    input.sourceSessionId,
    'resource_budget.unknown',
    '$.reservationId',
    funding.turnReservationId,
  );
  const sourceModelUnknown = countEvent(
    input.sourceSessionId,
    'resource_budget.unknown',
    '$.reservationId',
    funding.modelReservationId,
  );
  const targetAttempt = countEvent(
    input.targetSessionId,
    'model.invocation_attempt_started',
    '$.invocationId',
    input.modelInvocationId,
  );
  const targetInterrupted = countEvent(
    input.targetSessionId,
    'model.invocation_interrupted',
    '$.invocationId',
    input.modelInvocationId,
  );
  const targetTaskFailed = countEvent(
    input.targetSessionId,
    'task.failed',
    '$.taskId',
    route.taskId,
  );
  const settled =
    database
      .query<{ count: number }, [string, string, string, string, string, string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
     AND json_extract(event_json,'$.type')='agent.followup_turn_settled'
     AND json_extract(event_json,'$.sourceSessionId')=?
     AND json_extract(event_json,'$.submissionId')=?
     AND json_extract(event_json,'$.targetRunId')=?
     AND json_extract(event_json,'$.taskId')=(SELECT task_id FROM agent_followup_routes
       WHERE target_session_id=? AND submission_id=?)
     AND json_extract(event_json,'$.status')=?`,
      )
      .get(
        input.targetSessionId,
        input.sourceSessionId,
        input.submissionId,
        input.targetRunId,
        input.targetSessionId,
        input.submissionId,
        'unknown',
      )?.count ?? 0;
  if (
    ledger.runId !== funding.fundingRunId ||
    turn.reservationId !== funding.turnReservationId ||
    turn.state !== 'unknown' ||
    model.reservationId !== funding.modelReservationId ||
    model.state !== 'unknown' ||
    sourceTurnUnknown !== 1 ||
    sourceModelUnknown !== 1 ||
    !targetRun ||
    targetRun.status !== 'unknown' ||
    targetLedger.runId !== input.targetRunId ||
    local.reservationId !== funding.targetModelReservationId ||
    local.state !== 'unknown' ||
    targetModel.invocationId !== input.modelInvocationId ||
    targetModel.status !== 'interrupted' ||
    targetModel.attempts !== 1 ||
    record(targetModel.surfaceArtifact).artifactId !== funding.surfaceArtifactId ||
    record(targetModel.budget).reservationId !== funding.targetModelReservationId ||
    targetAttempt !== 1 ||
    targetInterrupted !== 1 ||
    targetTaskFailed !== 1 ||
    settled !== 1 ||
    record(target.turn).status !== 'aborted' ||
    record(target.terminalOutcome).status !== 'unknown'
  )
    invalid();
  const changed = database
    .query(`UPDATE agent_followup_funding_receipts SET
    terminal_disposition='unknown',terminal_target_revision=?,terminal_source_revision=?,
    terminal_evidence_digest=?,terminal_at_ms=?
    WHERE source_session_id=? AND submission_id=? AND terminal_disposition IS NULL`)
    .run(
      input.targetRevision,
      input.sourceRevision,
      evidenceDigest,
      input.createdAtMs,
      input.sourceSessionId,
      input.submissionId,
    ).changes;
  if (changed !== 1) conflict();
  return Object.freeze({
    sourceSessionId: input.sourceSessionId,
    submissionId: input.submissionId,
    targetSessionId: input.targetSessionId,
    targetRunId: input.targetRunId,
    modelInvocationId: input.modelInvocationId,
    targetRevision: input.targetRevision,
    sourceRevision: input.sourceRevision,
    disposition: 'unknown' as const,
    evidenceDigest,
    createdAtMs: input.createdAtMs,
  });
}

export function readCrossSessionFollowupTerminalReceipt(
  database: Database,
  sourceSessionId: string,
  submissionId: string,
): CrossSessionFollowupTerminalReceipt | null {
  const row = database
    .query<
      {
        target_session_id: string;
        target_run_id: string;
        model_invocation_id: string;
        terminal_disposition: 'completed' | 'unknown' | 'pre_dispatch_released' | null;
        terminal_target_revision: number | null;
        terminal_source_revision: number | null;
        terminal_evidence_digest: string | null;
        terminal_at_ms: number | null;
      },
      [string, string]
    >(`SELECT target_session_id,target_run_id,model_invocation_id,
    terminal_disposition,terminal_target_revision,terminal_source_revision,
    terminal_evidence_digest,terminal_at_ms FROM agent_followup_funding_receipts
    WHERE source_session_id=? AND submission_id=?`)
    .get(sourceSessionId, submissionId);
  if (
    !row?.terminal_disposition ||
    row.terminal_target_revision === null ||
    row.terminal_source_revision === null ||
    !row.terminal_evidence_digest ||
    row.terminal_at_ms === null
  )
    return readIndependentCrossSessionFollowupTerminalReceipt(
      database,
      sourceSessionId,
      submissionId,
    );
  return Object.freeze({
    sourceSessionId,
    submissionId,
    targetSessionId: row.target_session_id,
    targetRunId: row.target_run_id,
    modelInvocationId: row.model_invocation_id,
    targetRevision: row.terminal_target_revision,
    sourceRevision: row.terminal_source_revision,
    disposition: row.terminal_disposition,
    evidenceDigest: row.terminal_evidence_digest,
    createdAtMs: row.terminal_at_ms,
  });
}

function readIndependentCrossSessionFollowupTerminalReceipt(
  database: Database,
  sourceSessionId: string,
  submissionId: string,
): CrossSessionFollowupTerminalReceipt | null {
  const rows = database
    .query<{ sequence: number; event_json: string }, [string, string]>(
      `SELECT sequence,event_json FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='agent.followup_independent_settled'
       AND json_extract(event_json,'$.submissionId')=?`,
    )
    .all(sourceSessionId, submissionId);
  if (rows.length !== 1) return null;
  const audit = parse(rows[0]!.event_json);
  const targetSessionId = String(audit.targetAgentId ?? '');
  const proof = readAcceptedIndependentFollowupSourcePolicyProof(
    database,
    targetSessionId,
    sourceSessionId,
    submissionId,
  );
  const route = readCrossSessionFollowupRoute(database, targetSessionId, submissionId);
  const run = database
    .query<{ start_command_id: string }, [string, string]>(
      'SELECT start_command_id FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(targetSessionId, String(audit.targetRunId));
  if (
    !proof ||
    !run ||
    run.start_command_id !== `followup:${submissionId}` ||
    !DIGEST.test(String(audit.evidenceDigest)) ||
    !Number.isSafeInteger(audit.targetRevision) ||
    !Number.isSafeInteger(audit.createdAtMs) ||
    !['completed', 'unknown', 'pre_dispatch_released'].includes(String(audit.disposition))
  )
    return null;
  return Object.freeze({
    sourceSessionId,
    submissionId,
    targetSessionId,
    targetRunId: String(audit.targetRunId),
    modelInvocationId: route?.invocationId ?? '',
    targetRevision: Number(audit.targetRevision),
    sourceRevision: rows[0]!.sequence,
    disposition: audit.disposition as CrossSessionFollowupTerminalIntent['disposition'],
    evidenceDigest: String(audit.evidenceDigest),
    createdAtMs: Number(audit.createdAtMs),
  });
}

export interface PendingCrossSessionFollowupFunding {
  readonly submissionId: string;
  readonly messageId: string;
  readonly targetSessionId: string;
  readonly targetRunId: string | null;
  readonly modelInvocationId: string | null;
  readonly backupReservationId: string;
  readonly turnReservationId: string | null;
  readonly modelReservationId: string | null;
  readonly stage: 'accepted' | 'replaced' | 'routed' | 'activated';
  readonly fundingRunId: string;
  readonly reservationIds: readonly string[];
}

/** Only the source owner may feed these exact held IDs into restart recovery. */
export function listPendingCrossSessionFollowupFunding(
  database: Database,
  sourceSessionId: string,
  limit: number,
  afterSubmissionId?: string,
): readonly PendingCrossSessionFollowupFunding[] {
  if (
    !sourceSessionId ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (afterSubmissionId !== undefined && !afterSubmissionId)
  )
    invalid();
  const sourceRow = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(sourceSessionId);
  if (!sourceRow) invalid();
  const state = parse(sourceRow.state_json);
  const rows = database
    .query<
      {
        submission_id: string;
        source_run_id: string;
        target_session_id: string;
        message_id: string;
        followup_admission_artifact_id: string;
        followup_admission_digest: string;
        turn_reservation_id: string | null;
        model_reservation_id: string | null;
        activated_source_revision: number | null;
        target_run_id: string | null;
        model_invocation_id: string | null;
        routed_revision: number | null;
      },
      (string | number)[]
    >(`SELECT o.submission_id,o.source_run_id,o.target_session_id,o.message_id,
    o.followup_admission_artifact_id,o.followup_admission_digest,
    f.turn_reservation_id,f.model_reservation_id,f.activated_source_revision,
    f.target_run_id,f.model_invocation_id,
    route.routed_revision
    FROM agent_mail_outbox o LEFT JOIN agent_followup_funding_receipts f
      ON f.source_session_id=o.source_session_id AND f.submission_id=o.submission_id
    LEFT JOIN agent_followup_routes route ON route.source_session_id=o.source_session_id
      AND route.submission_id=o.submission_id
    WHERE o.source_session_id=? AND o.mode='trigger_turn'
      AND o.accepted_release_source_revision IS NULL
      AND o.current_turn_release_source_revision IS NULL
      AND (f.terminal_disposition IS NULL OR f.submission_id IS NULL)
      AND NOT EXISTS (SELECT 1 FROM runtime_events terminal
        WHERE terminal.session_id=o.source_session_id
          AND json_extract(terminal.event_json,'$.type')='agent.followup_independent_settled'
          AND json_extract(terminal.event_json,'$.submissionId')=o.submission_id)
      ${afterSubmissionId ? 'AND o.submission_id>?' : ''}
    ORDER BY o.submission_id LIMIT ?`)
    .all(sourceSessionId, ...(afterSubmissionId ? [afterSubmissionId] : []), limit);
  return rows.map((row) => {
    const artifact = database
      .query<{ canonical_json: string; integrity_identifier: string }, [string]>(
        `SELECT canonical_json,integrity_identifier FROM agent_followup_admission_artifacts
       WHERE artifact_id=?`,
      )
      .get(row.followup_admission_artifact_id);
    if (
      !artifact ||
      artifact.integrity_identifier !== row.followup_admission_digest ||
      `sha256:${createHash('sha256').update(artifact.canonical_json).digest('hex')}` !==
        row.followup_admission_digest
    )
      invalid();
    const admission = parse(artifact.canonical_json);
    const backupId = String(admission.backupReservationId);
    const active = record(state.resourceBudget);
    const ledger =
      active.runId === row.source_run_id
        ? active
        : record(record(state.retainedResourceBudgets)[row.source_run_id]);
    const reservations = record(ledger.reservations);
    const backup = record(reservations[backupId]);
    if (admission.schema === 'kite.cross-session-followup-admission.v2') {
      const accepted = readAcceptedIndependentFollowupSourcePolicyProof(
        database,
        row.target_session_id,
        sourceSessionId,
        row.submission_id,
      );
      const route = readCrossSessionFollowupRoute(
        database,
        row.target_session_id,
        row.submission_id,
      );
      if (
        !accepted ||
        backup.reservationId !== backupId ||
        backup.runId !== row.source_run_id ||
        record(backup.executableUpperBound).independentFollowupTurn !== true ||
        record(backup.executableUpperBound).unboundedToolInvocations !== true ||
        row.turn_reservation_id ||
        row.model_reservation_id ||
        !['queued', 'reserved', 'dispatch_started', 'unknown'].includes(String(backup.state))
      )
        invalid();
      return Object.freeze({
        submissionId: row.submission_id,
        messageId: row.message_id,
        targetSessionId: row.target_session_id,
        targetRunId: route?.targetRunId ?? row.target_run_id,
        modelInvocationId: route?.invocationId ?? row.model_invocation_id,
        backupReservationId: backupId,
        turnReservationId: null,
        modelReservationId: null,
        stage:
          backup.state === 'dispatch_started' || backup.state === 'unknown'
            ? ('activated' as const)
            : ('accepted' as const),
        fundingRunId: row.source_run_id,
        reservationIds: Object.freeze([backupId]),
      });
    }
    if (
      admission.submissionId !== row.submission_id ||
      admission.fundingRunId !== row.source_run_id ||
      ledger.runId !== row.source_run_id ||
      backup.reservationId !== backupId ||
      backup.runId !== row.source_run_id
    )
      invalid();
    if (row.turn_reservation_id && row.model_reservation_id) {
      const turn = record(reservations[row.turn_reservation_id]);
      const model = record(reservations[row.model_reservation_id]);
      if (
        backup.state !== 'released' ||
        turn.reservationId !== row.turn_reservation_id ||
        model.reservationId !== row.model_reservation_id ||
        !['reserved', 'dispatch_started', 'unknown'].includes(String(turn.state)) ||
        !['reserved', 'dispatch_started', 'unknown'].includes(String(model.state))
      )
        invalid();
      return Object.freeze({
        submissionId: row.submission_id,
        messageId: row.message_id,
        targetSessionId: row.target_session_id,
        targetRunId: row.target_run_id,
        modelInvocationId: row.model_invocation_id,
        backupReservationId: backupId,
        turnReservationId: row.turn_reservation_id,
        modelReservationId: row.model_reservation_id,
        stage:
          row.activated_source_revision !== null
            ? ('activated' as const)
            : row.routed_revision !== null
              ? ('routed' as const)
              : ('replaced' as const),
        fundingRunId: row.source_run_id,
        reservationIds: Object.freeze([row.turn_reservation_id, row.model_reservation_id]),
      });
    }
    if (
      row.turn_reservation_id ||
      row.model_reservation_id ||
      (backup.state !== 'reserved' && backup.state !== 'queued')
    )
      invalid();
    return Object.freeze({
      submissionId: row.submission_id,
      messageId: row.message_id,
      targetSessionId: row.target_session_id,
      stage: 'accepted' as const,
      targetRunId: null,
      modelInvocationId: null,
      backupReservationId: backupId,
      turnReservationId: null,
      modelReservationId: null,
      fundingRunId: row.source_run_id,
      reservationIds: Object.freeze([backupId]),
    });
  });
}

export function listPendingCrossSessionFollowupSources(
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
    .query<{ source_session_id: string }, (string | number)[]>(
      `SELECT DISTINCT o.source_session_id FROM agent_mail_outbox o
     LEFT JOIN agent_followup_funding_receipts f
       ON f.source_session_id=o.source_session_id AND f.submission_id=o.submission_id
     WHERE o.mode='trigger_turn' AND o.accepted_release_source_revision IS NULL
       AND (f.submission_id IS NULL OR f.terminal_disposition IS NULL)
       AND NOT EXISTS (SELECT 1 FROM runtime_events terminal
         WHERE terminal.session_id=o.source_session_id
           AND json_extract(terminal.event_json,'$.type')='agent.followup_independent_settled'
           AND json_extract(terminal.event_json,'$.submissionId')=o.submission_id)
       ${afterSessionId ? 'AND o.source_session_id>?' : ''}
     ORDER BY o.source_session_id LIMIT ?`,
    )
    .all(...(afterSessionId ? [afterSessionId] : []), limit)
    .map((row) => row.source_session_id);
}

/** Source owner commits the bounded replacement and ACK in one fenced transaction. */
export function replaceCrossSessionFollowupBackupInTransaction(
  database: Database,
  input: CrossSessionFollowupFundingIntent,
): CrossSessionFollowupFundingReceipt {
  requireTransaction(database);
  const prior = readCrossSessionFollowupFundingReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  if (prior) {
    if (
      prior.targetSessionId !== input.targetSessionId ||
      prior.messageId !== input.messageId ||
      prior.targetRunId !== input.targetRunId ||
      prior.modelInvocationId !== input.modelInvocationId ||
      prior.surfaceArtifactId !== input.surfaceArtifact.artifactId ||
      prior.surfaceDigest !== input.surfaceArtifact.integrityIdentifier ||
      prior.surfaceInputTokens !== input.surfaceInputTokens ||
      prior.surfaceMaxOutputTokens !== input.surfaceMaxOutputTokens ||
      prior.targetRevision !== input.targetRevision ||
      prior.sourceRevision !== input.sourceRevision
    )
      conflict();
    return prior;
  }
  const outbox = database
    .query<
      {
        target_session_id: string;
        submission_id: string | null;
        mode: string;
        source_run_id: string;
        accepted_release_source_revision: number | null;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
      },
      [string, string]
    >(
      `SELECT target_session_id,submission_id,mode,source_run_id,accepted_release_source_revision,
       followup_admission_artifact_id,followup_admission_digest
       FROM agent_mail_outbox WHERE source_session_id=? AND message_id=?`,
    )
    .get(input.sourceSessionId, input.messageId);
  const target = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision, p.state_json FROM runtime_sessions s
       JOIN runtime_snapshots p ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  const sourceRevision = database
    .query<{ revision: number }, [string]>(
      'SELECT revision FROM runtime_sessions WHERE session_id=?',
    )
    .get(input.sourceSessionId)?.revision;
  if (
    outbox?.mode !== 'trigger_turn' ||
    outbox.accepted_release_source_revision !== null ||
    outbox.target_session_id !== input.targetSessionId ||
    outbox.submission_id !== input.submissionId ||
    !outbox.followup_admission_artifact_id ||
    !outbox.followup_admission_digest ||
    target?.revision !== input.targetRevision ||
    sourceRevision !== input.sourceRevision ||
    !Number.isSafeInteger(input.sourceRevision) ||
    input.sourceRevision < 1 ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0 ||
    !Number.isSafeInteger(input.surfaceInputTokens) ||
    input.surfaceInputTokens < 0 ||
    !Number.isSafeInteger(input.surfaceMaxOutputTokens) ||
    input.surfaceMaxOutputTokens < 1
  )
    invalid();
  const admissionRow = database
    .query<{ canonical_json: string; integrity_identifier: string }, [string]>(
      'SELECT canonical_json,integrity_identifier FROM agent_followup_admission_artifacts WHERE artifact_id=?',
    )
    .get(outbox.followup_admission_artifact_id);
  if (!admissionRow || admissionRow.integrity_identifier !== outbox.followup_admission_digest)
    invalid();
  const admission = parse(admissionRow.canonical_json);
  const policy = record(admission.policy);
  if (!validPreparedFollowupTool(admission.preparedTool, record(admission.source), policy))
    unavailable();
  const targetState = parse(target.state_json);
  const targetModel = record(record(targetState.modelInvocations)[input.modelInvocationId]);
  const followupTurn = record(targetState.activeFollowupTurn);
  const surface = record(targetModel.surfaceArtifact);
  const targetLedger = record(targetState.resourceBudget);
  const targetBudget = record(targetLedger.budget);
  const localModelBudget = record(targetModel.budget);
  const targetModelReservationId = String(localModelBudget.reservationId);
  const localModelReservation = record(record(targetLedger.reservations)[targetModelReservationId]);
  const localCounters = record(record(localModelReservation.executableUpperBound).counters);
  const targetBudgetDigest = `sha256:${createHash('sha256').update(JSON.stringify(targetBudget)).digest('hex')}`;
  const targetRun = database
    .query<{ status: string; start_command_id: string }, [string, string]>(
      'SELECT status,start_command_id FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  if (
    (targetRun?.status !== 'running' && targetRun?.status !== 'waiting') ||
    targetRun.start_command_id !== `followup:${input.submissionId}` ||
    followupTurn.sourceSessionId !== input.sourceSessionId ||
    followupTurn.submissionId !== input.submissionId ||
    followupTurn.targetRunId !== input.targetRunId ||
    followupTurn.grantDigest !== record(followupTurn.grantRef).integrityIdentifier ||
    !readCrossSessionFollowupGrant(database, String(record(followupTurn.grantRef).artifactId)) ||
    targetModel.status !== 'prepared' ||
    targetModel.invocationId !== input.modelInvocationId ||
    !Number.isSafeInteger(targetModel.estimatedInputTokens) ||
    targetModel.estimatedInputTokens !== input.surfaceInputTokens ||
    surface.artifactId !== input.surfaceArtifact.artifactId ||
    surface.kind !== 'model_surface' ||
    surface.integrityIdentifier !== input.surfaceArtifact.integrityIdentifier ||
    surface.byteLength !== input.surfaceArtifact.byteLength ||
    targetModel.surfaceIntegrityIdentifier !== input.surfaceArtifact.integrityIdentifier ||
    targetLedger.status !== 'active' ||
    targetLedger.runId !== input.targetRunId ||
    localModelBudget.kind !== 'reservation' ||
    !targetModelReservationId ||
    targetModelReservationId === 'undefined' ||
    localModelReservation.reservationId !== targetModelReservationId ||
    localModelReservation.runId !== input.targetRunId ||
    localModelReservation.invocationId !== `model-invocation:${input.modelInvocationId}` ||
    localModelReservation.resourceKind !== 'model' ||
    localModelReservation.state !== 'reserved' ||
    localCounters.turns !== 0 ||
    localCounters.modelRequests !== 1 ||
    localCounters.toolInvocations !== 0 ||
    localCounters.artifactBytes !== 0 ||
    !Number.isSafeInteger(localCounters.inputTokens) ||
    Number(localCounters.inputTokens) < input.surfaceInputTokens ||
    Number(localCounters.inputTokens) > input.surfaceInputTokens * 2 ||
    !Number.isSafeInteger(localCounters.outputTokens) ||
    Number(localCounters.outputTokens) < 1 ||
    Number(localCounters.outputTokens) > input.surfaceMaxOutputTokens ||
    policy.workspaceDigest !== record(targetState.session).canonicalWorkspaceDigest ||
    Number(policy.maxOutputTokens) < input.surfaceMaxOutputTokens ||
    input.createdAtMs >= Number(admission.deadlineAt)
  )
    invalid();
  const persistedSurface = createKiteHomeArtifactStore(database).readModel(input.surfaceArtifact);
  if (
    persistedSurface.artifactFormatVersion !== 1 ||
    !matchesModelArtifactReference(
      'model_surface',
      persistedSurface.canonicalJson,
      record(input.surfaceArtifact),
    )
  )
    invalid();
  const budget = record(input.sourceSnapshot.resourceBudget);
  const ledger =
    budget.runId === outbox.source_run_id
      ? budget
      : record(record(input.sourceSnapshot.retainedResourceBudgets)[outbox.source_run_id]);
  const reservations = record(ledger.reservations);
  const replacementEvent = input.replacementEvent;
  const backupId = String(admission.backupReservationId);
  const turn = record(replacementEvent.turnReservation);
  const model = record(replacementEvent.replacement);
  const backup = record(reservations[backupId]);
  const storedTurn = record(reservations[turn.reservationId as string]);
  const storedModel = record(reservations[model.reservationId as string]);
  const modelUpper = record(model.executableUpperBound);
  const modelCounters = record(modelUpper.counters);
  const compositeUpper = sumUsage(record(turn.executableUpperBound), modelUpper);
  if (
    admission.submissionId !== input.submissionId ||
    admission.targetSessionId !== input.targetSessionId ||
    admission.messageId !== input.messageId ||
    admission.fundingRunId !== outbox.source_run_id ||
    ledger.runId !== outbox.source_run_id ||
    Object.values(reservations).some((item) => record(item).state === 'unknown') ||
    replacementEvent.type !== 'resource_budget.bounded_replaced' ||
    replacementEvent.reservationId !== backupId ||
    backup.state !== 'released' ||
    backup.resourceKind !== 'subagent' ||
    backup.runId !== outbox.source_run_id ||
    !queuedBackupHasExactSlotAcquisition(database, input.sourceSessionId, backupId) ||
    !sameCanonicalValue(backup.executableUpperBound, admission.executableUpperBound) ||
    !sameCanonicalValue(turn, storedTurn) ||
    !sameCanonicalValue(model, storedModel) ||
    turn.state !== 'reserved' ||
    turn.resourceKind !== 'subagent' ||
    turn.runId !== outbox.source_run_id ||
    turn.replacesReservationId !== backupId ||
    model.state !== 'reserved' ||
    model.resourceKind !== 'model' ||
    model.runId !== outbox.source_run_id ||
    model.replacesReservationId !== backupId ||
    model.parentReservationId !== turn.reservationId ||
    model.invocationId !== `model-invocation:${input.modelInvocationId}` ||
    modelCounters.inputTokens !==
      Math.max(input.surfaceInputTokens * 2, Number(targetBudget.maxRunInputTokens)) ||
    modelCounters.outputTokens !== input.surfaceMaxOutputTokens ||
    !boundedDelegatedBudget(targetBudget, compositeUpper) ||
    !boundedUsage(record(localModelReservation.executableUpperBound), modelUpper) ||
    !boundedSumBy(
      record(turn.executableUpperBound),
      modelUpper,
      record(backup.executableUpperBound),
    )
  )
    invalid();
  const receipt: CrossSessionFollowupFundingReceipt = Object.freeze({
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    messageId: input.messageId,
    submissionId: input.submissionId,
    fundingRunId: outbox.source_run_id,
    backupReservationId: backupId,
    turnReservationId: String(turn.reservationId),
    modelReservationId: String(model.reservationId),
    targetModelReservationId,
    targetBudgetDigest,
    targetRunId: input.targetRunId,
    modelInvocationId: input.modelInvocationId,
    surfaceArtifactId: input.surfaceArtifact.artifactId,
    surfaceDigest: input.surfaceArtifact.integrityIdentifier,
    surfaceInputTokens: input.surfaceInputTokens,
    surfaceMaxOutputTokens: input.surfaceMaxOutputTokens,
    targetRevision: input.targetRevision,
    sourceRevision: input.sourceRevision,
    createdAtMs: input.createdAtMs,
  });
  database
    .query(`INSERT INTO agent_followup_funding_receipts(
    source_session_id,submission_id,target_session_id,message_id,funding_run_id,
    backup_reservation_id,turn_reservation_id,model_reservation_id,target_model_reservation_id,
    target_budget_digest,target_run_id,
    model_invocation_id,surface_artifact_id,surface_digest,surface_input_tokens,
    surface_max_output_tokens,target_revision,source_revision,created_at_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      receipt.sourceSessionId,
      receipt.submissionId,
      receipt.targetSessionId,
      receipt.messageId,
      receipt.fundingRunId,
      receipt.backupReservationId,
      receipt.turnReservationId,
      receipt.modelReservationId,
      receipt.targetModelReservationId,
      receipt.targetBudgetDigest,
      receipt.targetRunId,
      receipt.modelInvocationId,
      receipt.surfaceArtifactId,
      receipt.surfaceDigest,
      receipt.surfaceInputTokens,
      receipt.surfaceMaxOutputTokens,
      receipt.targetRevision,
      receipt.sourceRevision,
      receipt.createdAtMs,
    );
  return receipt;
}

export function readCrossSessionFollowupFundingReceipt(
  database: Database,
  sourceSessionId: string,
  submissionId: string,
): CrossSessionFollowupFundingReceipt | null {
  const row = database
    .query<Record<string, string | number>, [string, string]>(
      'SELECT * FROM agent_followup_funding_receipts WHERE source_session_id=? AND submission_id=?',
    )
    .get(sourceSessionId, submissionId);
  if (!row) return null;
  return Object.freeze({
    sourceSessionId: String(row.source_session_id),
    submissionId: String(row.submission_id),
    targetSessionId: String(row.target_session_id),
    messageId: String(row.message_id),
    fundingRunId: String(row.funding_run_id),
    backupReservationId: String(row.backup_reservation_id),
    turnReservationId: String(row.turn_reservation_id),
    modelReservationId: String(row.model_reservation_id),
    targetModelReservationId: String(row.target_model_reservation_id),
    targetBudgetDigest: String(row.target_budget_digest),
    targetRunId: String(row.target_run_id),
    modelInvocationId: String(row.model_invocation_id),
    surfaceArtifactId: String(row.surface_artifact_id),
    surfaceDigest: String(row.surface_digest),
    surfaceInputTokens: Number(row.surface_input_tokens),
    surfaceMaxOutputTokens: Number(row.surface_max_output_tokens),
    targetRevision: Number(row.target_revision),
    sourceRevision: Number(row.source_revision),
    createdAtMs: Number(row.created_at_ms),
  });
}

function escapeCurrentTurnMail(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;');
}

/** Current-turn route consumes only an already funded, unattempted old-Run Surface. */
/** A queued D0 child is live after activation and parent dispatch ACK, before its first attempt. */
export function isAdmittedQueuedChildFollowupTarget(
  database: Database,
  sourceSessionId: string,
  targetSessionId: string,
  runId: string,
): boolean {
  const intent = database
    .query<
      {
        parent_session_id: string;
        child_invocation_id: string;
        grant_digest: string;
        child_budget_activated_run_id: string | null;
        dispatch_ack_event_id: string | null;
        failure_receipt_digest: string | null;
        parent_claim_settled_event_id: string | null;
      },
      [string]
    >(`SELECT parent_session_id,child_invocation_id,grant_digest,
      child_budget_activated_run_id,dispatch_ack_event_id,failure_receipt_digest,
      parent_claim_settled_event_id FROM child_session_intents WHERE child_thread_id=?`)
    .get(targetSessionId);
  const run = database
    .query<{ run_id: string; status: string; origin_session_id: string | null }, [string]>(
      `SELECT run_id,status,origin_session_id FROM runtime_runs WHERE session_id=?
       ORDER BY created_revision DESC LIMIT 1`,
    )
    .get(targetSessionId);
  const snapshot = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(targetSessionId);
  const state = snapshot ? parse(snapshot.state_json) : {};
  const origin = record(state.childSessionOrigin);
  const budget = record(state.resourceBudget);
  const turn = record(state.turn);
  const grant = readChildSealedGrant(database, sourceSessionId, targetSessionId);
  const ceiling = grant ? record(parse(grant.sealedGrantJson).capabilityCeiling) : {};
  const attempts = database
    .query<{ count: number }, [string]>(
      `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
       AND json_extract(event_json,'$.type')='model.invocation_attempt_started'`,
    )
    .get(targetSessionId)?.count;
  return Boolean(
    intent &&
      intent.parent_session_id === sourceSessionId &&
      intent.child_budget_activated_run_id === runId &&
      intent.dispatch_ack_event_id &&
      intent.failure_receipt_digest === null &&
      intent.parent_claim_settled_event_id === null &&
      run?.run_id === runId &&
      run.status === 'queued' &&
      run.origin_session_id === sourceSessionId &&
      origin.parentSessionId === sourceSessionId &&
      origin.childInvocationId === intent.child_invocation_id &&
      origin.grantDigest === intent.grant_digest &&
      origin.terminal === undefined &&
      state.activeTaskId === intent.child_invocation_id &&
      turn.turnId === runId &&
      turn.status === 'active' &&
      budget.status === 'active' &&
      budget.runId === runId &&
      grant?.sealedGrantDigest === intent.grant_digest &&
      finiteCurrentTurnToolCeiling(
        ceiling,
        database
          .query<{ role: string }, [string]>(
            'SELECT role FROM child_session_intents WHERE child_thread_id=?',
          )
          .get(targetSessionId)?.role,
      ) &&
      attempts === 0 &&
      Object.values(record(state.modelInvocations)).every((value) => record(value).attempts === 0),
  );
}

function routeCurrentTurnFollowupInTransaction(
  database: Database,
  input: CrossSessionFollowupRouteIntent,
): CrossSessionFollowupRouteReceipt {
  const outbox = database
    .query<
      {
        source_run_id: string;
        source_task_id: string | null;
        target_session_id: string;
        mode: string;
        submission_id: string | null;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
        accepted_release_source_revision: number | null;
      },
      [string, string]
    >(`SELECT source_run_id,source_task_id,target_session_id,mode,submission_id,
    followup_admission_artifact_id,followup_admission_digest,accepted_release_source_revision
    FROM agent_mail_outbox WHERE source_session_id=? AND message_id=?`)
    .get(input.sourceSessionId, input.messageId);
  const pair = database
    .query<
      {
        parent_session_id: string | null;
        source_workspace_id: string;
        target_workspace_id: string;
        source_project_id: string;
        target_project_id: string;
        source_workspace_digest: string;
        target_workspace_digest: string;
      },
      [string, string]
    >(`SELECT target.parent_session_id,
    source.workspace_id AS source_workspace_id,target.workspace_id AS target_workspace_id,
    source.project_id AS source_project_id,target.project_id AS target_project_id,
    source.workspace_digest AS source_workspace_digest,
    target.workspace_digest AS target_workspace_digest
    FROM runtime_sessions source JOIN runtime_sessions target ON target.session_id=?
    WHERE source.session_id=?`)
    .get(input.targetSessionId, input.sourceSessionId);
  const inbox = database
    .query<
      {
        source_session_id: string;
        target_run_id: string | null;
        sequence: number;
        prepared_invocation_id: string | null;
        prepared_model_admission_id: string | null;
      },
      [string, string]
    >(`SELECT source_session_id,target_run_id,sequence,
    prepared_invocation_id,prepared_model_admission_id FROM agent_mail_inbox
    WHERE target_session_id=? AND message_id=?`)
    .get(input.targetSessionId, input.messageId);
  const admissionRow = outbox?.followup_admission_artifact_id
    ? database
        .query<
          { canonical_json: string; integrity_identifier: string; byte_length: number },
          [string]
        >(
          `SELECT canonical_json,integrity_identifier,byte_length
       FROM agent_followup_admission_artifacts WHERE artifact_id=?`,
        )
        .get(outbox.followup_admission_artifact_id)
    : null;
  const admissionDigest = admissionRow
    ? `sha256:${createHash('sha256').update(admissionRow.canonical_json).digest('hex')}`
    : '';
  const admission = admissionRow ? parse(admissionRow.canonical_json) : {};
  const policy = record(admission.policy);
  const targetRow = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
     ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  const state = input.targetSnapshot;
  const model = record(record(state.modelInvocations)[input.invocationId]);
  const modelBudget = record(model.budget);
  const surfaceRef = record(model.surfaceArtifact);
  const ledger = record(state.resourceBudget);
  const reservation = record(record(ledger.reservations)[input.reservationId]);
  const run = database
    .query<{ status: string; phase: string; start_command_id: string }, [string, string]>(
      'SELECT status,phase,start_command_id FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  const grant = readChildSealedGrant(database, input.sourceSessionId, input.targetSessionId);
  const childRole = database
    .query<{ role: string }, [string]>(
      'SELECT role FROM child_session_intents WHERE child_thread_id=?',
    )
    .get(input.targetSessionId)?.role;
  const grantPayload = grant ? parse(grant.sealedGrantJson) : {};
  const grantCeiling = record(grantPayload.capabilityCeiling);
  const grantAuthorization = record(grantPayload.authorization);
  const origin = record(state.childSessionOrigin);
  const sourceRow = database
    .query<{ state_json: string }, [string]>(
      'SELECT state_json FROM runtime_snapshots WHERE session_id=?',
    )
    .get(input.sourceSessionId);
  const sourceState = sourceRow ? parse(sourceRow.state_json) : {};
  const sourceActive = record(sourceState.resourceBudget);
  const sourceLedger =
    sourceActive.runId === outbox?.source_run_id
      ? sourceActive
      : record(record(sourceState.retainedResourceBudgets)[String(outbox?.source_run_id)]);
  const backup = record(record(sourceLedger.reservations)[String(admission.backupReservationId)]);
  const body = readReceivedCrossSessionMailBody(database, input.targetSessionId, input.messageId);
  const expectedFrame =
    body === null
      ? ''
      : `<agent_message message_id="${escapeCurrentTurnMail(input.messageId)}" sender_agent_id="${escapeCurrentTurnMail(input.sourceSessionId)}"${outbox?.source_task_id ? ` source_task_id="${escapeCurrentTurnMail(outbox.source_task_id)}"` : ''}>\n${escapeCurrentTurnMail(body)}\n</agent_message>`;
  let surface: ReturnType<ReturnType<typeof createKiteHomeArtifactStore>['readModel']> | null =
    null;
  if (
    surfaceRef.kind === 'model_surface' &&
    typeof surfaceRef.artifactId === 'string' &&
    typeof surfaceRef.integrityIdentifier === 'string' &&
    Number.isSafeInteger(surfaceRef.byteLength)
  ) {
    try {
      surface = createKiteHomeArtifactStore(database).readModel({
        artifactId: surfaceRef.artifactId,
        kind: 'model_surface',
        integrityIdentifier: surfaceRef.integrityIdentifier,
        byteLength: Number(surfaceRef.byteLength),
      });
    } catch {
      invalid();
    }
  }
  const surfacePayload = surface ? parse(surface.canonicalJson) : {};
  const request = record(surfacePayload.request);
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const exactFrameCount = messages.filter((value) => {
    const message = record(value);
    const parts = Array.isArray(message.content) ? message.content : [];
    return (
      message.role === 'user' &&
      parts.length === 1 &&
      record(parts[0]).type === 'text' &&
      record(parts[0]).text === expectedFrame
    );
  }).length;
  const priorThrough =
    database
      .query<{ through_sequence: number }, [string, string]>(
        `SELECT coalesce(max(cast(json_extract(event_json,'$.throughSequence') AS INTEGER)),0)
      AS through_sequence FROM runtime_events WHERE session_id=?
      AND json_extract(event_json,'$.type')='agent.mail_input_prepared'
      AND json_extract(event_json,'$.invocationId')<>?`,
      )
      .get(input.targetSessionId, input.invocationId)?.through_sequence ?? 0;
  const preparedCount =
    database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
      AND json_extract(event_json,'$.type')='model.invocation_prepared'
      AND json_extract(event_json,'$.invocationId')=?`,
      )
      .get(input.targetSessionId, input.invocationId)?.count ?? 0;
  const attemptCount =
    database
      .query<{ count: number }, [string, string]>(
        `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
      AND json_extract(event_json,'$.type')='model.invocation_attempt_started'
      AND json_extract(event_json,'$.invocationId')=?`,
      )
      .get(input.targetSessionId, input.invocationId)?.count ?? 0;
  const event = input.routedEvent;
  const prepared = input.preparedEvent;
  if (
    !outbox ||
    outbox.mode !== 'trigger_turn' ||
    outbox.submission_id !== input.submissionId ||
    outbox.target_session_id !== input.targetSessionId ||
    outbox.accepted_release_source_revision !== null ||
    !pair ||
    pair.parent_session_id !== input.sourceSessionId ||
    pair.source_workspace_id !== pair.target_workspace_id ||
    pair.source_project_id !== pair.target_project_id ||
    pair.source_workspace_digest !== pair.target_workspace_digest ||
    !inbox ||
    inbox.source_session_id !== input.sourceSessionId ||
    inbox.target_run_id !== input.targetRunId ||
    inbox.prepared_invocation_id !== null ||
    inbox.prepared_model_admission_id !== null ||
    inbox.sequence - 1 !== priorThrough ||
    !admissionRow ||
    admissionDigest !== outbox.followup_admission_digest ||
    admissionRow.integrity_identifier !== admissionDigest ||
    outbox.followup_admission_artifact_id !== `pa_${admissionDigest.slice(7)}` ||
    admissionRow.byte_length !== Buffer.byteLength(admissionRow.canonical_json, 'utf8') ||
    admission.schema !== 'kite.cross-session-followup-admission.v1' ||
    admission.sourceSessionId !== input.sourceSessionId ||
    admission.targetSessionId !== input.targetSessionId ||
    admission.submissionId !== input.submissionId ||
    admission.messageId !== input.messageId ||
    admission.fundingRunId !== outbox.source_run_id ||
    !Number.isSafeInteger(admission.deadlineAt) ||
    input.createdAtMs >= Number(admission.deadlineAt) ||
    policy.workspaceDigest !== pair.target_workspace_digest ||
    !['planning', 'building'].includes(String(policy.phaseCeiling)) ||
    !['write', 'workspace_only'].includes(String(policy.workspaceAccess)) ||
    policy.interactionMode !== sourceState.mode ||
    policy.interactionModeRevision !== sourceState.interactionModeRevision ||
    policy.interactionMode !== state.mode ||
    state.interactionModeRevision !== 0 ||
    !targetRow ||
    targetRow.revision !== input.routedRevision ||
    !sameCanonicalValue(parse(targetRow.state_json), state) ||
    !grant ||
    !['explore', 'plan', 'review'].includes(String(childRole)) ||
    origin.grantDigest !== grant.sealedGrantDigest ||
    origin.parentSessionId !== input.sourceSessionId ||
    origin.terminal !== undefined ||
    !finiteCurrentTurnToolCeiling(grantCeiling, childRole) ||
    (Array.isArray(grantCeiling.allowedTools) &&
      grantCeiling.allowedTools.length > 0 &&
      grantPayload.role !== childRole) ||
    grantAuthorization.interactionMode !== policy.interactionMode ||
    (grantAuthorization.workspaceAccess !== 'read' &&
      !(policy.workspaceAccess === 'write' && grantAuthorization.workspaceAccess === 'write')) ||
    grantAuthorization.phase !== run?.phase ||
    (policy.phaseCeiling === 'planning' && run?.phase !== 'planning') ||
    !run ||
    (!['running', 'waiting'].includes(run.status) &&
      !isAdmittedQueuedChildFollowupTarget(
        database,
        input.sourceSessionId,
        input.targetSessionId,
        input.targetRunId,
      )) ||
    run.start_command_id.startsWith('followup:') ||
    record(state.turn).status !== 'active' ||
    state.activeTaskId !== input.taskId ||
    state.activeFollowupTurn !== undefined ||
    ledger.status !== 'active' ||
    ledger.runId !== input.targetRunId ||
    sourceLedger.runId !== outbox.source_run_id ||
    backup.reservationId !== admission.backupReservationId ||
    !currentTurnHeldBackupProven(
      database,
      input.sourceSessionId,
      String(admission.backupReservationId),
      backup.state,
    ) ||
    model.status !== 'prepared' ||
    model.invocationId !== input.invocationId ||
    model.attempts !== 0 ||
    preparedCount !== 1 ||
    attemptCount !== 0 ||
    modelBudget.kind !== 'reservation' ||
    modelBudget.reservationId !== input.reservationId ||
    model.surfaceIntegrityIdentifier !== surfaceRef.integrityIdentifier ||
    !Number.isSafeInteger(model.estimatedInputTokens) ||
    reservation.reservationId !== input.reservationId ||
    reservation.runId !== input.targetRunId ||
    reservation.invocationId !== `model-invocation:${input.invocationId}` ||
    reservation.resourceKind !== 'model' ||
    reservation.state !== 'reserved' ||
    !surface ||
    !matchesModelArtifactReference('model_surface', surface.canonicalJson, surfaceRef) ||
    record(surfacePayload.schema).name !== 'kite.model-surface' ||
    record(surfacePayload.schema).canonicalizerVersion !== 'kite.model-surface.canonical-json.v1' ||
    record(surfacePayload.schema).surfaceFormatVersion !== 1 ||
    surfacePayload.purpose !== 'primary_agent' ||
    !currentTurnSurfaceWithinCeiling(request.tools, grantCeiling) ||
    exactFrameCount !== 1 ||
    body === null ||
    input.modelAdmissionId !== input.reservationId ||
    event.type !== 'agent.followup_routed' ||
    event.route !== 'current_turn' ||
    event.submissionId !== input.submissionId ||
    event.targetAgentId !== input.targetSessionId ||
    event.taskId !== input.taskId ||
    event.invocationId !== input.invocationId ||
    event.modelAdmissionId !== input.modelAdmissionId ||
    event.reservationId !== input.reservationId ||
    event.fundingRunId !== outbox.source_run_id ||
    event.sequence !== inbox.sequence ||
    prepared.type !== 'agent.mail_input_prepared' ||
    prepared.targetAgentId !== input.targetSessionId ||
    prepared.invocationId !== input.invocationId ||
    prepared.modelAdmissionId !== input.modelAdmissionId ||
    prepared.fromSequence !== priorThrough ||
    prepared.throughSequence !== inbox.sequence ||
    !sameCanonicalValue(prepared.messageIds, [input.messageId])
  )
    invalid();
  const changed = database
    .query(`UPDATE agent_mail_inbox SET
    prepared_invocation_id=?,prepared_model_admission_id=?
    WHERE target_session_id=? AND message_id=? AND source_session_id=?
      AND target_run_id=? AND prepared_invocation_id IS NULL
      AND prepared_model_admission_id IS NULL`)
    .run(
      input.invocationId,
      input.modelAdmissionId,
      input.targetSessionId,
      input.messageId,
      input.sourceSessionId,
      input.targetRunId,
    ).changes;
  if (changed !== 1) conflict();
  const receipt: CrossSessionFollowupRouteReceipt = Object.freeze({
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    messageId: input.messageId,
    submissionId: input.submissionId,
    route: 'current_turn',
    targetRunId: input.targetRunId,
    taskId: input.taskId,
    invocationId: input.invocationId,
    modelAdmissionId: input.modelAdmissionId,
    reservationId: input.reservationId,
    routedRevision: input.routedRevision,
    createdAtMs: input.createdAtMs,
  });
  database
    .query(`INSERT INTO agent_followup_routes(target_session_id,source_session_id,message_id,
    submission_id,route,target_run_id,task_id,invocation_id,model_admission_id,
    reservation_id,routed_revision,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      receipt.targetSessionId,
      receipt.sourceSessionId,
      receipt.messageId,
      receipt.submissionId,
      receipt.route,
      receipt.targetRunId,
      receipt.taskId,
      receipt.invocationId,
      receipt.modelAdmissionId,
      receipt.reservationId,
      receipt.routedRevision,
      receipt.createdAtMs,
    );
  return receipt;
}

function routeIndependentCrossSessionFollowupInTransaction(
  database: Database,
  input: CrossSessionFollowupRouteIntent,
): CrossSessionFollowupRouteReceipt {
  const proof = readAcceptedIndependentFollowupSourcePolicyProof(
    database,
    input.targetSessionId,
    input.sourceSessionId,
    input.submissionId,
  );
  const activation = readIndependentCrossSessionFollowupActivation(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  const inbox = database
    .query<
      {
        source_session_id: string;
        target_run_id: string | null;
        sequence: number;
        prepared_invocation_id: string | null;
        prepared_model_admission_id: string | null;
      },
      [string, string]
    >(
      `SELECT source_session_id,target_run_id,sequence,prepared_invocation_id,
       prepared_model_admission_id FROM agent_mail_inbox WHERE target_session_id=? AND message_id=?`,
    )
    .get(input.targetSessionId, input.messageId);
  const row = database
    .query<{ revision: number; state_json: string }, [string]>(
      `SELECT s.revision,p.state_json FROM runtime_sessions s JOIN runtime_snapshots p
       ON p.session_id=s.session_id WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  const state = row ? parse(row.state_json) : {};
  const followup = record(state.activeFollowupTurn);
  const ledger = record(state.resourceBudget);
  const model = record(record(state.modelInvocations)[input.invocationId]);
  const local = record(record(ledger.reservations)[input.reservationId]);
  const grant = readCrossSessionFollowupGrant(
    database,
    String(record(followup.grantRef).artifactId),
  );
  const run = database
    .query<{ status: string; start_command_id: string }, [string, string]>(
      'SELECT status,start_command_id FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  const event = input.routedEvent;
  const prepared = input.preparedEvent;
  if (
    input.route !== 'new_turn' ||
    !proof ||
    !activation ||
    activation.targetSessionId !== input.targetSessionId ||
    activation.targetRunId !== input.targetRunId ||
    proof.admission.messageId !== input.messageId ||
    !inbox ||
    inbox.source_session_id !== input.sourceSessionId ||
    inbox.prepared_invocation_id !== null ||
    inbox.prepared_model_admission_id !== null ||
    !row ||
    row.revision !== input.routedRevision ||
    !sameCanonicalValue(state, input.targetSnapshot) ||
    !run ||
    !['running', 'waiting'].includes(run.status) ||
    run.start_command_id !== `followup:${input.submissionId}` ||
    !grant ||
    grant.ref.integrityIdentifier !== activation.grantDigest ||
    followup.grantDigest !== grant.ref.integrityIdentifier ||
    followup.sourceSessionId !== input.sourceSessionId ||
    followup.submissionId !== input.submissionId ||
    followup.targetRunId !== input.targetRunId ||
    followup.taskId !== input.taskId ||
    ledger.status !== 'active' ||
    ledger.runId !== input.targetRunId ||
    model.invocationId !== input.invocationId ||
    model.status !== 'prepared' ||
    model.attempts !== 0 ||
    record(model.budget).reservationId !== input.reservationId ||
    local.reservationId !== input.reservationId ||
    local.runId !== input.targetRunId ||
    local.resourceKind !== 'model' ||
    local.state !== 'reserved' ||
    local.invocationId !== `model-invocation:${input.invocationId}` ||
    input.modelAdmissionId !== input.reservationId ||
    event.type !== 'agent.followup_routed' ||
    event.route !== 'new_turn' ||
    event.submissionId !== input.submissionId ||
    event.targetAgentId !== input.targetSessionId ||
    event.taskId !== input.taskId ||
    event.invocationId !== input.invocationId ||
    event.modelAdmissionId !== input.modelAdmissionId ||
    event.reservationId !== input.reservationId ||
    event.fundingRunId !== proof.admission.fundingRunId ||
    event.sequence !== inbox.sequence ||
    prepared.type !== 'agent.mail_input_prepared' ||
    prepared.targetAgentId !== input.targetSessionId ||
    prepared.invocationId !== input.invocationId ||
    prepared.modelAdmissionId !== input.modelAdmissionId ||
    prepared.fromSequence !== inbox.sequence - 1 ||
    prepared.throughSequence !== inbox.sequence ||
    !sameCanonicalValue(prepared.messageIds, [input.messageId])
  )
    invalid();
  const checkpoint = readChildTerminalCheckpoint(database, input.targetSessionId);
  if (!checkpoint) unavailable();
  const changed = database
    .query(`UPDATE agent_mail_inbox SET
      target_run_id=?,prepared_invocation_id=?,prepared_model_admission_id=?
      WHERE target_session_id=? AND message_id=? AND source_session_id=?
        AND target_run_id IS ? AND prepared_invocation_id IS NULL
        AND prepared_model_admission_id IS NULL`)
    .run(
      input.targetRunId,
      input.invocationId,
      input.modelAdmissionId,
      input.targetSessionId,
      input.messageId,
      input.sourceSessionId,
      inbox.target_run_id,
    ).changes;
  if (changed !== 1) conflict();
  const receipt: CrossSessionFollowupRouteReceipt = Object.freeze({
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    messageId: input.messageId,
    submissionId: input.submissionId,
    route: 'new_turn',
    targetRunId: input.targetRunId,
    taskId: input.taskId,
    invocationId: input.invocationId,
    modelAdmissionId: input.modelAdmissionId,
    reservationId: input.reservationId,
    routedRevision: input.routedRevision,
    createdAtMs: input.createdAtMs,
  });
  database
    .query(`INSERT INTO agent_followup_routes(target_session_id,source_session_id,message_id,
      submission_id,route,target_run_id,task_id,invocation_id,model_admission_id,
      reservation_id,routed_revision,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      receipt.targetSessionId,
      receipt.sourceSessionId,
      receipt.messageId,
      receipt.submissionId,
      receipt.route,
      receipt.targetRunId,
      receipt.taskId,
      receipt.invocationId,
      receipt.modelAdmissionId,
      receipt.reservationId,
      receipt.routedRevision,
      receipt.createdAtMs,
    );
  return receipt;
}

/** The target owner writes one route receipt with its own Run and model budget decision. */
export function routeCrossSessionFollowupInTransaction(
  database: Database,
  input: CrossSessionFollowupRouteIntent,
): CrossSessionFollowupRouteReceipt {
  requireTransaction(database);
  const prior = readCrossSessionFollowupRoute(database, input.targetSessionId, input.submissionId);
  if (prior) {
    if (
      prior.sourceSessionId !== input.sourceSessionId ||
      prior.messageId !== input.messageId ||
      prior.route !== input.route ||
      prior.targetRunId !== input.targetRunId ||
      prior.taskId !== input.taskId ||
      prior.invocationId !== input.invocationId ||
      prior.modelAdmissionId !== input.modelAdmissionId ||
      prior.reservationId !== input.reservationId ||
      prior.routedRevision !== input.routedRevision
    )
      conflict();
    return prior;
  }
  if (
    !input.sourceSessionId ||
    !input.targetSessionId ||
    !input.messageId ||
    !input.submissionId ||
    !input.targetRunId ||
    !input.taskId ||
    !input.invocationId ||
    !input.modelAdmissionId ||
    !input.reservationId ||
    !Number.isSafeInteger(input.routedRevision) ||
    input.routedRevision < 1 ||
    !Number.isSafeInteger(input.createdAtMs) ||
    input.createdAtMs < 0
  )
    invalid();
  if (input.route === 'current_turn') return routeCurrentTurnFollowupInTransaction(database, input);
  const outbox = database
    .query<
      {
        target_session_id: string;
        mode: string;
        submission_id: string | null;
        source_run_id: string;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
      },
      [string, string]
    >(
      `SELECT target_session_id,mode,submission_id,source_run_id,
       followup_admission_artifact_id,followup_admission_digest FROM agent_mail_outbox
       WHERE source_session_id=? AND message_id=?`,
    )
    .get(input.sourceSessionId, input.messageId);
  const inbox = database
    .query<
      {
        source_session_id: string;
        target_run_id: string | null;
        sequence: number;
        prepared_invocation_id: string | null;
        prepared_model_admission_id: string | null;
      },
      [string, string]
    >(
      `SELECT source_session_id,target_run_id,sequence,prepared_invocation_id,
        prepared_model_admission_id FROM agent_mail_inbox WHERE target_session_id=? AND message_id=?`,
    )
    .get(input.targetSessionId, input.messageId);
  const target = database
    .query<
      { revision: number; parent_session_id: string | null; workspace_digest: string },
      [string]
    >('SELECT revision,parent_session_id,workspace_digest FROM runtime_sessions WHERE session_id=?')
    .get(input.targetSessionId);
  if (
    !outbox ||
    outbox.mode !== 'trigger_turn' ||
    outbox.target_session_id !== input.targetSessionId ||
    outbox.submission_id !== input.submissionId ||
    !outbox.followup_admission_artifact_id ||
    !outbox.followup_admission_digest ||
    !inbox ||
    inbox.source_session_id !== input.sourceSessionId ||
    !target ||
    target.parent_session_id !== input.sourceSessionId ||
    target.revision !== input.routedRevision
  )
    invalid();
  const artifactRow = database
    .query<{ integrity_identifier: string; byte_length: number; canonical_json: string }, [string]>(
      `SELECT integrity_identifier,byte_length,canonical_json FROM agent_followup_admission_artifacts
       WHERE artifact_id=?`,
    )
    .get(outbox.followup_admission_artifact_id);
  if (
    !artifactRow ||
    artifactRow.integrity_identifier !== outbox.followup_admission_digest ||
    `sha256:${createHash('sha256').update(artifactRow.canonical_json).digest('hex')}` !==
      outbox.followup_admission_digest ||
    artifactRow.byte_length !== Buffer.byteLength(artifactRow.canonical_json, 'utf8')
  )
    invalid();
  const payload = parse(artifactRow.canonical_json);
  if (payload.schema === 'kite.cross-session-followup-admission.v2') {
    return routeIndependentCrossSessionFollowupInTransaction(database, input);
  }
  const policy = record(payload.policy);
  const snapshot = input.targetSnapshot;
  const event = input.routedEvent;
  const funding = readCrossSessionFollowupFundingReceipt(
    database,
    input.sourceSessionId,
    input.submissionId,
  );
  const persistedModel = record(record(snapshot.modelInvocations)[input.invocationId]);
  const followupTurn = record(snapshot.activeFollowupTurn);
  const preparedBudget = record(persistedModel.budget);
  const preparedSurface = record(persistedModel.surfaceArtifact);
  const targetLedger = record(snapshot.resourceBudget);
  const localReservation = record(record(targetLedger.reservations)[input.reservationId]);
  const routeCounters = record(record(localReservation.executableUpperBound).counters);
  const targetBudgetDigest = `sha256:${createHash('sha256').update(JSON.stringify(targetLedger.budget)).digest('hex')}`;
  if (
    payload.schema !== 'kite.cross-session-followup-admission.v1' ||
    payload.submissionId !== input.submissionId ||
    payload.messageId !== input.messageId ||
    payload.sourceSessionId !== input.sourceSessionId ||
    payload.targetSessionId !== input.targetSessionId ||
    payload.fundingRunId !== outbox.source_run_id ||
    !Number.isSafeInteger(payload.deadlineAt) ||
    Number(payload.deadlineAt) <= input.createdAtMs ||
    policy.workspaceDigest !== target.workspace_digest ||
    policy.interactionMode !== snapshot.mode ||
    policy.workspaceAccess !== snapshot.workspaceAccess ||
    !funding ||
    funding.messageId !== input.messageId ||
    funding.targetSessionId !== input.targetSessionId ||
    funding.fundingRunId !== outbox.source_run_id ||
    funding.backupReservationId !== payload.backupReservationId ||
    funding.targetRunId !== input.targetRunId ||
    funding.modelInvocationId !== input.invocationId ||
    followupTurn.sourceSessionId !== input.sourceSessionId ||
    followupTurn.submissionId !== input.submissionId ||
    followupTurn.targetRunId !== input.targetRunId ||
    followupTurn.taskId !== input.taskId ||
    followupTurn.grantDigest !== record(followupTurn.grantRef).integrityIdentifier ||
    !readCrossSessionFollowupGrant(database, String(record(followupTurn.grantRef).artifactId)) ||
    funding.targetModelReservationId !== input.reservationId ||
    funding.targetBudgetDigest !== targetBudgetDigest ||
    input.modelAdmissionId !== input.reservationId ||
    preparedBudget.kind !== 'reservation' ||
    preparedBudget.reservationId !== funding.targetModelReservationId ||
    targetLedger.status !== 'active' ||
    targetLedger.runId !== input.targetRunId ||
    localReservation.reservationId !== input.reservationId ||
    localReservation.runId !== input.targetRunId ||
    localReservation.invocationId !== `model-invocation:${input.invocationId}` ||
    localReservation.resourceKind !== 'model' ||
    localReservation.state !== 'reserved' ||
    routeCounters.turns !== 0 ||
    routeCounters.modelRequests !== 1 ||
    routeCounters.toolInvocations !== 0 ||
    routeCounters.artifactBytes !== 0 ||
    !Number.isSafeInteger(routeCounters.inputTokens) ||
    Number(routeCounters.inputTokens) < funding.surfaceInputTokens ||
    Number(routeCounters.inputTokens) > funding.surfaceInputTokens * 2 ||
    !Number.isSafeInteger(routeCounters.outputTokens) ||
    Number(routeCounters.outputTokens) < 1 ||
    Number(routeCounters.outputTokens) > funding.surfaceMaxOutputTokens ||
    preparedSurface.artifactId !== funding.surfaceArtifactId ||
    preparedSurface.integrityIdentifier !== funding.surfaceDigest ||
    persistedModel.status !== 'prepared' ||
    persistedModel.invocationId !== input.invocationId ||
    !Number.isSafeInteger(persistedModel.estimatedInputTokens) ||
    persistedModel.estimatedInputTokens !== funding.surfaceInputTokens ||
    event.type !== 'agent.followup_routed' ||
    event.submissionId !== input.submissionId ||
    event.targetAgentId !== input.targetSessionId ||
    event.route !== input.route ||
    event.taskId !== input.taskId ||
    event.invocationId !== input.invocationId ||
    event.modelAdmissionId !== input.modelAdmissionId ||
    event.reservationId !== input.reservationId ||
    event.fundingRunId !== outbox.source_run_id ||
    event.sequence !== inbox.sequence ||
    input.preparedEvent.type !== 'agent.mail_input_prepared' ||
    input.preparedEvent.targetAgentId !== input.targetSessionId ||
    input.preparedEvent.invocationId !== input.invocationId ||
    input.preparedEvent.modelAdmissionId !== input.modelAdmissionId ||
    input.preparedEvent.fromSequence !== inbox.sequence - 1 ||
    input.preparedEvent.throughSequence !== inbox.sequence ||
    !sameCanonicalValue(input.preparedEvent.messageIds, [input.messageId]) ||
    inbox.prepared_invocation_id !== null ||
    inbox.prepared_model_admission_id !== null
  )
    invalid();
  const targetRun = database
    .query<{ status: string; start_command_id: string }, [string, string]>(
      'SELECT status,start_command_id FROM runtime_runs WHERE session_id=? AND run_id=?',
    )
    .get(input.targetSessionId, input.targetRunId);
  if (!targetRun || !['running', 'waiting'].includes(targetRun.status)) invalid();
  if (targetRun.start_command_id !== `followup:${input.submissionId}`) invalid();
  if (inbox.target_run_id) {
    const frozen = database
      .query<{ status: string }, [string, string]>(
        'SELECT status FROM runtime_runs WHERE session_id=? AND run_id=?',
      )
      .get(input.targetSessionId, inbox.target_run_id);
    if (!frozen || frozen.status !== 'completed') invalid();
  }
  const checkpoint = readChildTerminalCheckpoint(database, input.targetSessionId);
  if (
    !checkpoint ||
    (inbox.target_run_id && parse(checkpoint.canonicalJson).terminalRunId !== inbox.target_run_id)
  )
    unavailable();
  const changed = database
    .query(`UPDATE agent_mail_inbox SET
    target_run_id=?,prepared_invocation_id=?,prepared_model_admission_id=?
    WHERE target_session_id=? AND message_id=? AND source_session_id=?
      AND target_run_id IS ? AND prepared_invocation_id IS NULL
      AND prepared_model_admission_id IS NULL`)
    .run(
      input.targetRunId,
      input.invocationId,
      input.modelAdmissionId,
      input.targetSessionId,
      input.messageId,
      input.sourceSessionId,
      inbox.target_run_id,
    ).changes;
  if (changed !== 1) conflict();
  const receipt: CrossSessionFollowupRouteReceipt = Object.freeze({
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    messageId: input.messageId,
    submissionId: input.submissionId,
    route: input.route,
    targetRunId: input.targetRunId,
    taskId: input.taskId,
    invocationId: input.invocationId,
    modelAdmissionId: input.modelAdmissionId,
    reservationId: input.reservationId,
    routedRevision: input.routedRevision,
    createdAtMs: input.createdAtMs,
  });
  database
    .query(`INSERT INTO agent_followup_routes(target_session_id,source_session_id,message_id,
      submission_id,route,target_run_id,task_id,invocation_id,model_admission_id,
      reservation_id,routed_revision,created_at_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      receipt.targetSessionId,
      receipt.sourceSessionId,
      receipt.messageId,
      receipt.submissionId,
      receipt.route,
      receipt.targetRunId,
      receipt.taskId,
      receipt.invocationId,
      receipt.modelAdmissionId,
      receipt.reservationId,
      receipt.routedRevision,
      receipt.createdAtMs,
    );
  return receipt;
}

export function readCrossSessionFollowupRoute(
  database: Database,
  targetSessionId: string,
  submissionId: string,
): CrossSessionFollowupRouteReceipt | null {
  const row = database
    .query<
      {
        target_session_id: string;
        source_session_id: string;
        message_id: string;
        submission_id: string;
        route: 'current_turn' | 'new_turn';
        target_run_id: string;
        task_id: string;
        invocation_id: string;
        model_admission_id: string;
        reservation_id: string;
        routed_revision: number;
        created_at_ms: number;
      },
      [string, string]
    >(`SELECT * FROM agent_followup_routes WHERE target_session_id=? AND submission_id=?`)
    .get(targetSessionId, submissionId);
  return row
    ? Object.freeze({
        targetSessionId: row.target_session_id,
        sourceSessionId: row.source_session_id,
        messageId: row.message_id,
        submissionId: row.submission_id,
        route: row.route,
        targetRunId: row.target_run_id,
        taskId: row.task_id,
        invocationId: row.invocation_id,
        modelAdmissionId: row.model_admission_id,
        reservationId: row.reservation_id,
        routedRevision: row.routed_revision,
        createdAtMs: row.created_at_ms,
      })
    : null;
}

/** Called only inside the fenced source receipt transaction after Event and receipt persistence. */
export function acceptCrossSessionFollowupInTransaction(
  database: Database,
  input: CrossSessionFollowupSourceIntent,
): CrossSessionFollowupAcceptance {
  requireTransaction(database);
  const admission = input.admission;
  const canonicalDigest = `sha256:${createHash('sha256').update(admission.canonicalJson).digest('hex')}`;
  if (
    !input.submissionId ||
    !DIGEST.test(admission.digest) ||
    admission.digest !== canonicalDigest ||
    admission.ref.kind !== 'agent_followup_admission' ||
    admission.ref.artifactId !== `pa_${canonicalDigest.slice(7)}` ||
    !ARTIFACT_ID.test(admission.ref.artifactId) ||
    admission.ref.integrityIdentifier !== canonicalDigest ||
    admission.ref.byteLength !== Buffer.byteLength(admission.canonicalJson, 'utf8') ||
    !Number.isSafeInteger(admission.createdAt) ||
    admission.createdAt < 0
  )
    invalid();
  const prior = database
    .query<
      {
        mode: string;
        submission_id: string | null;
        followup_admission_artifact_id: string | null;
        followup_admission_digest: string | null;
      },
      [string, string]
    >(
      `SELECT mode,submission_id,followup_admission_artifact_id,followup_admission_digest
       FROM agent_mail_outbox WHERE source_session_id=? AND message_id=?`,
    )
    .get(input.sourceSessionId, input.messageId);
  if (prior) {
    const outbox = readCrossSessionMail(database, input.sourceSessionId, input.messageId);
    const bodyDigest = `sha256:${createHash('sha256').update(input.bodyText).digest('hex')}`;
    const receipt = database
      .query<{ request_digest: string; committed_revision: number }, [string, string]>(
        'SELECT request_digest,committed_revision FROM runtime_command_receipts WHERE scope_session_id=? AND command_id=?',
      )
      .get(input.sourceSessionId, input.commandId);
    if (
      prior.mode !== 'trigger_turn' ||
      prior.submission_id !== input.submissionId ||
      prior.followup_admission_artifact_id !== admission.ref.artifactId ||
      prior.followup_admission_digest !== admission.digest ||
      !outbox ||
      outbox.targetSessionId !== input.targetSessionId ||
      outbox.commandId !== input.commandId ||
      outbox.requestDigest !== input.requestDigest ||
      outbox.sourceRunId !== input.sourceRunId ||
      outbox.sourceTurnId !== input.sourceTurnId ||
      outbox.sourceModelInvocationId !== input.sourceModelInvocationId ||
      outbox.sourceToolCallId !== input.sourceToolCallId ||
      outbox.sourceEffectAttemptId !== input.sourceEffectAttemptId ||
      outbox.sourceTaskId !== (input.sourceTaskId ?? null) ||
      outbox.sourceGrantId !== (input.sourceGrantId ?? null) ||
      outbox.sourceGrantDigest !== (input.sourceGrantDigest ?? null) ||
      outbox.sourceSequence !== input.sourceSequence ||
      outbox.sourceRevision !== input.sourceRevision ||
      outbox.bodyRef.integrityIdentifier !== bodyDigest ||
      outbox.bodyRef.byteLength !== Buffer.byteLength(input.bodyText, 'utf8') ||
      receipt?.request_digest !== input.requestDigest ||
      receipt.committed_revision !== outbox.sourceRevision ||
      input.acceptedEvent.mode !== 'trigger_turn' ||
      input.acceptedEvent.submissionId !== input.submissionId ||
      input.acceptedEvent.followupAdmissionDigest !== admission.digest
    )
      conflict();
    const stored = createKiteHomeArtifactStore(database).readAgentFollowupAdmission(admission.ref);
    if (stored.canonicalJson !== admission.canonicalJson) conflict();
    const payload = parse(admission.canonicalJson);
    if (payload.backupReservationId !== record(input.reservationEvent.reservation).reservationId)
      conflict();
    return {
      outbox,
      submissionId: input.submissionId,
      admissionRef: admission.ref,
      backupReservationId: String(payload.backupReservationId),
    };
  }
  const payload = parse(admission.canonicalJson);
  const source = record(payload.source);
  const policy = record(payload.policy);
  const preparedTool = record(payload.preparedTool);
  const snapshot = input.sourceSnapshot;
  const session = record(snapshot.session);
  const turn = record(snapshot.turn);
  const capabilities = record(snapshot.capabilities);
  const calls = record(record(snapshot.tools).calls);
  const call = record(calls[input.sourceToolCallId]);
  const invocations = Object.values(record(capabilities.invocations)).filter((value) => {
    const invocation = record(value);
    return invocation.toolCallId === input.sourceToolCallId && invocation.status === 'running';
  });
  const invocation = record(invocations[0]);
  const budget = record(snapshot.resourceBudget);
  const reservations = record(budget.reservations);
  const reservationEvent = input.reservationEvent;
  const reservation = record(reservationEvent.reservation);
  const storedReservation = record(reservations[reservation.reservationId as string]);
  const upper = record(reservation.executableUpperBound);
  const counters = record(upper.counters);
  const gauges = record(upper.gauges);
  const deadlineAt = Date.parse(String(budget.deadlineAt));
  const isIndependentTurnProtocol = policy.executionMode === 'independent_turn_v2';
  const minimumWindow = isIndependentTurnProtocol
    ? 1
    : Math.max(60_000, Number(policy.firstAttemptTimeoutMs) + 5_000);
  const originalGrant = isIndependentTurnProtocol
    ? readChildSealedGrant(database, input.sourceSessionId, input.targetSessionId)
    : null;
  const bodyDigest = `sha256:${createHash('sha256').update(input.bodyText).digest('hex')}`;
  const accepted = input.acceptedEvent;
  const eventSource = record(accepted.source);
  const eventBodyRef = record(accepted.bodyRef);
  const eventAdmissionRef = record(accepted.followupAdmissionRef);
  if (
    payload.schema !==
      (isIndependentTurnProtocol
        ? 'kite.cross-session-followup-admission.v2'
        : 'kite.cross-session-followup-admission.v1') ||
    (isIndependentTurnProtocol &&
      (!originalGrant ||
        !['explore', 'plan', 'code', 'review'].includes(String(policy.targetRole)) ||
        policy.targetGrantDigest !== originalGrant.sealedGrantDigest ||
        parse(originalGrant.sealedGrantJson).role !== policy.targetRole ||
        upper.independentFollowupTurn !== true ||
        upper.unboundedToolInvocations !== true ||
        counters.toolInvocations !== 0 ||
        Number(counters.artifactBytes) < 1 ||
        gauges.elapsedRunMs !== FOLLOWUP_TURN_DURATION_MS ||
        gauges.activeToolInvocations !== 1 ||
        gauges.activeShellInvocations !== 1 ||
        gauges.activeWriters !== (policy.targetRole === 'code' ? 1 : 0))) ||
    (!isIndependentTurnProtocol &&
      (upper.independentFollowupTurn === true || upper.unboundedToolInvocations === true)) ||
    payload.submissionId !== input.submissionId ||
    payload.messageId !== input.messageId ||
    payload.sourceSessionId !== input.sourceSessionId ||
    payload.targetSessionId !== input.targetSessionId ||
    payload.sourceRunId !== input.sourceRunId ||
    payload.sourceTurnId !== input.sourceTurnId ||
    payload.sourceModelInvocationId !== input.sourceModelInvocationId ||
    payload.sourceToolCallId !== input.sourceToolCallId ||
    payload.sourceEffectAttemptId !== input.sourceEffectAttemptId ||
    source.runId !== input.sourceRunId ||
    source.turnId !== input.sourceTurnId ||
    source.modelInvocationId !== input.sourceModelInvocationId ||
    source.toolCallId !== input.sourceToolCallId ||
    source.effectAttemptId !== input.sourceEffectAttemptId ||
    !validPreparedFollowupTool(preparedTool, source, policy) ||
    preparedTool.invocationId !== invocation.invocationId ||
    preparedTool.capabilityRevision !== invocation.capabilityRevision ||
    preparedTool.argumentsDigest !== invocation.argumentsDigest ||
    preparedTool.modelMessageId !== call.modelMessageId ||
    source.sourceTaskId !== input.sourceTaskId ||
    payload.bodyDigest !== bodyDigest ||
    payload.fundingRunId !== input.sourceRunId ||
    !Number.isSafeInteger(payload.deadlineAt) ||
    payload.deadlineAt !== deadlineAt ||
    !Number.isSafeInteger(minimumWindow) ||
    deadlineAt - input.acceptedAtMs < minimumWindow ||
    policy.boundedContext !== true ||
    policy.workspaceDigest !== session.canonicalWorkspaceDigest ||
    policy.capabilityDigest !== capabilities.catalogRevision ||
    typeof policy.capabilityDigest !== 'string' ||
    policy.capabilityDigest.length === 0 ||
    policy.interactionMode !== snapshot.mode ||
    policy.interactionModeRevision !== snapshot.interactionModeRevision ||
    policy.workspaceAccess !== snapshot.workspaceAccess ||
    policy.authorizationDigest !== invocation.authorizationDigest ||
    policy.admissionDigest !== invocation.admissionDigest ||
    policy.effectiveEffectsDigest !== invocation.effectiveEffectsDigest ||
    typeof policy.policyRevision !== 'string' ||
    !policy.policyRevision ||
    !Number.isSafeInteger(policy.contextWindowTokens) ||
    !Number.isSafeInteger(policy.maxOutputTokens) ||
    Number(policy.contextWindowTokens) <= Number(policy.maxOutputTokens) ||
    !Number.isSafeInteger(policy.firstAttemptTimeoutMs) ||
    Number(policy.firstAttemptTimeoutMs) <= 0 ||
    turn.turnId !== input.sourceTurnId ||
    turn.status !== 'active' ||
    call.name !== 'followup_task' ||
    call.status !== 'running' ||
    call.modelInvocationId !== input.sourceModelInvocationId ||
    invocations.length !== 1 ||
    invocation.capabilityId !== 'builtin:followup_task' ||
    input.sourceEffectAttemptId !==
      `${invocation.invocationId}:attempt:${invocation.attemptsStarted}` ||
    budget.status !== 'active' ||
    budget.runId !== input.sourceRunId ||
    Object.values(reservations).some((item) => record(item).state === 'unknown') ||
    reservationEvent.type !== 'resource_budget.reserved' ||
    reservation.version !== 1 ||
    (reservation.state !== 'reserved' && reservation.state !== 'queued') ||
    reservation.resourceKind !== 'subagent' ||
    reservation.runId !== input.sourceRunId ||
    reservation.invocationId !== input.submissionId ||
    reservation.parentReservationId !== undefined ||
    reservation.reservationId !== payload.backupReservationId ||
    !sameCanonicalValue(reservation, storedReservation) ||
    !sameCanonicalValue(payload.executableUpperBound, upper) ||
    counters.turns !== 1 ||
    (isIndependentTurnProtocol
      ? Number(counters.modelRequests) < 1
      : counters.modelRequests !== 1) ||
    !Number.isSafeInteger(counters.inputTokens) ||
    Number(counters.inputTokens) < 1 ||
    (isIndependentTurnProtocol
      ? Number(counters.inputTokens) <
        2 * (Number(policy.contextWindowTokens) - Number(policy.maxOutputTokens))
      : Number(counters.inputTokens) >
        2 * (Number(policy.contextWindowTokens) - Number(policy.maxOutputTokens))) ||
    !Number.isSafeInteger(counters.outputTokens) ||
    Number(counters.outputTokens) < 1 ||
    (isIndependentTurnProtocol
      ? Number(counters.outputTokens) < Number(policy.maxOutputTokens)
      : Number(counters.outputTokens) > Number(policy.maxOutputTokens)) ||
    gauges.activeSubagents !== 1 ||
    accepted.type !== 'agent.mail_accepted' ||
    accepted.mode !== 'trigger_turn' ||
    accepted.messageId !== input.messageId ||
    accepted.submissionId !== input.submissionId ||
    accepted.senderAgentId !== input.sourceSessionId ||
    accepted.targetAgentId !== input.targetSessionId ||
    accepted.sequence !== input.sourceSequence ||
    accepted.bodyDigest !== bodyDigest ||
    eventBodyRef.artifactId !== `pa_${bodyDigest.slice(7)}` ||
    eventBodyRef.integrityIdentifier !== bodyDigest ||
    eventBodyRef.byteLength !== Buffer.byteLength(input.bodyText, 'utf8') ||
    accepted.followupAdmissionDigest !== admission.digest ||
    eventAdmissionRef.artifactId !== admission.ref.artifactId ||
    eventAdmissionRef.integrityIdentifier !== admission.ref.integrityIdentifier ||
    eventAdmissionRef.byteLength !== admission.ref.byteLength ||
    eventSource.runId !== input.sourceRunId ||
    eventSource.turnId !== input.sourceTurnId ||
    eventSource.modelInvocationId !== input.sourceModelInvocationId ||
    eventSource.toolCallId !== input.sourceToolCallId ||
    eventSource.effectAttemptId !== input.sourceEffectAttemptId ||
    eventSource.sourceTaskId !== input.sourceTaskId
  )
    invalid();
  if (reservation.state === 'queued') {
    const matching = database
      .query<{ event_json: string }, [string]>(
        'SELECT event_json FROM runtime_events WHERE session_id=? ORDER BY sequence',
      )
      .all(input.sourceSessionId)
      .filter((row) => sameCanonicalValue(parse(row.event_json), reservationEvent));
    if (matching.length !== 1) invalid();
  }
  const target = database
    .query<{ parent_session_id: string | null; status: string }, [string]>(
      `SELECT s.parent_session_id,n.status
       FROM runtime_sessions s JOIN agent_nodes n ON n.session_id=s.session_id AND n.agent_id=s.session_id
       WHERE s.session_id=?`,
    )
    .get(input.targetSessionId);
  if (
    target?.parent_session_id !== input.sourceSessionId ||
    target.status === 'context_unavailable'
  )
    unavailable();
  if (target.status === 'idle') assertTargetCheckpoint(database, input.targetSessionId);
  acceptCrossSessionQueueMailInTransaction(database, input);
  createKiteHomeArtifactStore(database).writeAgentFollowupAdmission({
    ref: admission.ref,
    artifactFormatVersion: 1,
    canonicalJson: admission.canonicalJson,
    createdAt: admission.createdAt,
  });
  const changed = database
    .query(`UPDATE agent_mail_outbox SET mode='trigger_turn',submission_id=?,
      followup_admission_artifact_id=?,followup_admission_digest=?
      WHERE source_session_id=? AND message_id=? AND mode='queue_only'`)
    .run(
      input.submissionId,
      admission.ref.artifactId,
      admission.digest,
      input.sourceSessionId,
      input.messageId,
    ).changes;
  if (changed !== 1) conflict();
  const queuedRun = database
    .query<{ run_id: string }, [string]>(
      `SELECT run_id FROM runtime_runs WHERE session_id=? AND status='queued'
       ORDER BY created_revision DESC LIMIT 1`,
    )
    .get(input.targetSessionId)?.run_id;
  if (
    queuedRun &&
    isAdmittedQueuedChildFollowupTarget(
      database,
      input.sourceSessionId,
      input.targetSessionId,
      queuedRun,
    )
  ) {
    const bound = database
      .query(`UPDATE agent_mail_outbox SET target_run_id=?
        WHERE source_session_id=? AND message_id=? AND mode='trigger_turn'
          AND target_run_id IS NULL`)
      .run(queuedRun, input.sourceSessionId, input.messageId).changes;
    if (bound !== 1) conflict();
  }
  const outbox = readCrossSessionMail(database, input.sourceSessionId, input.messageId);
  if (!outbox) invalid();
  return {
    outbox,
    submissionId: input.submissionId,
    admissionRef: admission.ref,
    backupReservationId: String(payload.backupReservationId),
  };
}

function parse(json: string): RecordValue {
  try {
    return record(JSON.parse(json));
  } catch {
    invalid();
  }
}

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(normalize)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, normalize(item)]),
          )
        : value;
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function boundedSumBy(left: RecordValue, right: RecordValue, upper: RecordValue): boolean {
  for (const group of ['counters', 'gauges']) {
    const leftGroup = record(left[group]);
    const rightGroup = record(right[group]);
    const upperGroup = record(upper[group]);
    if (
      !Object.keys(leftGroup).length ||
      !Object.keys(rightGroup).length ||
      !Object.keys(upperGroup).length
    )
      return false;
    for (const [key, limit] of Object.entries(upperGroup)) {
      const first = leftGroup[key];
      const second = rightGroup[key];
      if (
        !Number.isSafeInteger(first) ||
        !Number.isSafeInteger(second) ||
        !Number.isSafeInteger(limit) ||
        Number(first) < 0 ||
        Number(second) < 0 ||
        Number(first) + Number(second) > Number(limit)
      )
        return false;
    }
  }
  return true;
}

function sumUsage(left: RecordValue, right: RecordValue): RecordValue {
  const result: RecordValue = {};
  for (const group of ['counters', 'gauges']) {
    const first = record(left[group]);
    const second = record(right[group]);
    const combined: RecordValue = {};
    for (const key of new Set([...Object.keys(first), ...Object.keys(second)]))
      combined[key] = Number(first[key] ?? 0) + Number(second[key] ?? 0);
    result[group] = combined;
  }
  return result;
}

function boundedUsage(candidate: RecordValue, upper: RecordValue): boolean {
  for (const group of ['counters', 'gauges']) {
    const first = record(candidate[group]);
    const limit = record(upper[group]);
    for (const key of new Set([...Object.keys(first), ...Object.keys(limit)])) {
      if (
        group === 'counters' &&
        key === 'toolInvocations' &&
        upper.unboundedToolInvocations === true
      ) {
        if (!Number.isSafeInteger(first[key]) || Number(first[key]) < 0) return false;
        continue;
      }
      if (
        !Number.isSafeInteger(first[key]) ||
        !Number.isSafeInteger(limit[key]) ||
        Number(first[key]) < 0 ||
        Number(first[key]) > Number(limit[key])
      )
        return false;
    }
  }
  return true;
}

function boundedDelegatedBudget(budget: RecordValue, upper: RecordValue): boolean {
  const counters = record(upper.counters);
  const gauges = record(upper.gauges);
  const pairs: readonly [string, unknown][] = [
    ['maxTurns', counters.turns],
    ['maxModelRequests', counters.modelRequests],
    ['maxToolInvocations', counters.toolInvocations],
    ['maxRunInputTokens', counters.inputTokens],
    ['maxRunOutputTokens', counters.outputTokens],
    ['maxArtifactBytes', counters.artifactBytes],
    ['maxConcurrentSubagents', gauges.activeSubagents],
    ['maxConcurrentWriters', gauges.activeWriters],
    ['maxConcurrentToolInvocations', gauges.activeToolInvocations],
    ['maxConcurrentShellInvocations', gauges.activeShellInvocations],
  ];
  return (
    budget.version === 1 &&
    pairs.every(
      ([key, maximum]) =>
        Number.isSafeInteger(budget[key]) &&
        Number.isSafeInteger(maximum) &&
        Number(budget[key]) >= 0 &&
        Number(budget[key]) <= Number(maximum),
    ) &&
    budget.maxTurns === 1 &&
    budget.maxModelRequests === 1 &&
    budget.maxToolInvocations === 0 &&
    budget.maxArtifactBytes === 0 &&
    budget.maxConcurrentSubagents === 0 &&
    budget.maxConcurrentWriters === 0 &&
    budget.maxConcurrentToolInvocations === 0 &&
    budget.maxConcurrentShellInvocations === 0
  );
}

export function readChildTerminalCheckpoint(
  database: Database,
  targetSessionId: string,
): Readonly<{
  ref: {
    artifactId: string;
    kind: 'subagent_checkpoint';
    integrityIdentifier: string;
    byteLength: number;
  };
  canonicalJson: string;
  terminalRevision: number;
}> | null {
  const checkpoint = database
    .query<
      {
        artifact_id: string | null;
        integrity_identifier: string | null;
        byte_length: number | null;
      },
      [string]
    >(
      `SELECT latest_checkpoint_artifact_id AS artifact_id,
       latest_checkpoint_integrity_identifier AS integrity_identifier,
       latest_checkpoint_byte_length AS byte_length
       FROM agent_nodes WHERE session_id=? AND agent_id=session_id`,
    )
    .get(targetSessionId);
  if (
    !checkpoint?.artifact_id ||
    !checkpoint.integrity_identifier ||
    checkpoint.byte_length === null
  )
    return null;
  const ref = {
    artifactId: checkpoint.artifact_id,
    kind: 'subagent_checkpoint' as const,
    integrityIdentifier: checkpoint.integrity_identifier,
    byteLength: checkpoint.byte_length,
  };
  const stored = createKiteHomeArtifactStore(database).readSubagentCheckpoint(ref);
  if (stored.artifactFormatVersion !== 1) unavailable();
  const payload = parse(stored.canonicalJson);
  if (payload.childSessionId !== targetSessionId || !Number.isSafeInteger(payload.terminalRevision))
    unavailable();
  return Object.freeze({
    ref,
    canonicalJson: stored.canonicalJson,
    terminalRevision: Number(payload.terminalRevision),
  });
}

function assertTargetCheckpoint(database: Database, targetSessionId: string): void {
  if (!readChildTerminalCheckpoint(database, targetSessionId)) unavailable();
}

function requireTransaction(database: Database): void {
  if (!database.inTransaction) invalid();
}
function invalid(): never {
  throw new KiteCrossSessionFollowupError('invalid_source');
}
function conflict(): never {
  throw new KiteCrossSessionFollowupError('identity_conflict');
}
function unavailable(): never {
  throw new KiteCrossSessionFollowupError('target_unavailable');
}
