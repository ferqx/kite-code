import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED,
  childDelegatedUpperBoundDigest,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import {
  decideChildApprovalProxyInTransaction,
  followupChildApprovalParentToolCallId,
  markChildApprovalAppliedInTransaction,
  openChildApprovalProxyInTransaction,
  validateChildApprovalProxyContinuity,
} from '../src/kite-child-approval-proxy';
import {
  acceptCrossSessionFollowupTerminalReplyInTransaction,
  listUnrepliedSettledFollowupTerminalSources,
  receiveCrossSessionQueueMailInTransaction,
} from '../src/kite-cross-session-agent-mail';
import {
  acceptCrossSessionFollowupInTransaction,
  activateCrossSessionFollowupFundingInTransaction,
  activateIndependentCrossSessionFollowupTurnInTransaction,
  assertCrossSessionFollowupRunStartInTransaction,
  isAdmittedQueuedChildFollowupTarget,
  KiteCrossSessionFollowupError,
  listPendingCrossSessionFollowupFunding,
  listPendingCrossSessionFollowupSources,
  readAcceptedIndependentFollowupSourcePolicyProof,
  readCrossSessionCurrentTurnBackupReleaseForTarget,
  readCrossSessionCurrentTurnPreparedNoAttemptProof,
  readCrossSessionFollowupActivationReceipt,
  readCrossSessionFollowupAdmissionBySubmissionForTarget,
  readCrossSessionFollowupDeliveryForTarget,
  readCrossSessionFollowupFundingReceipt,
  readCrossSessionFollowupGrant,
  readCrossSessionFollowupRoute,
  readCrossSessionFollowupTerminalReceipt,
  readCurrentTurnDispatchedChildProofForSource,
  readCurrentTurnRoutedNoAttemptChildProofForSource,
  readDirectChildFollowupOutcomeWatermark,
  readDirectChildFollowupReleaseWatermark,
  readIndependentCrossSessionFollowupActivation,
  readLastFollowupOutcomeForDirectChild,
  readLastReleasedFollowupForDirectChild,
  readPreparedCrossSessionFollowupRecoveryProof,
  readTargetSnapshotEvidence,
  readUnroutedCrossSessionFollowupMessage,
  receiveCrossSessionFollowupInTransaction,
  releaseAcceptedCrossSessionFollowupBackupInTransaction,
  releaseCrossSessionCurrentTurnBackupInTransaction,
  replaceCrossSessionFollowupBackupInTransaction,
  routeCrossSessionFollowupInTransaction,
  sealChildTerminalCheckpointInTransaction,
  settleCancelledAcceptedFollowupsInTransaction,
  settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction,
  settleCrossSessionFollowupFundingInTransaction,
  settleIndependentCrossSessionFollowupFundingInTransaction,
  verifyCompletedChildFollowupModelWork,
} from '../src/kite-cross-session-followup';
import { readProvenUnfundedExpiredFollowupRelease } from '../src/kite-cross-session-followup-proof';
import { createKiteHomeArtifactStore } from '../src/kite-home-artifacts';
import { initializeKiteSessionStoreIfNeeded } from '../src/kite-home-store';

function usage(
  turns: number,
  modelRequests: number,
  inputTokens: number,
  outputTokens: number,
  activeSubagents: number,
) {
  return {
    counters: {
      turns,
      modelRequests,
      toolInvocations: 0,
      inputTokens,
      outputTokens,
      artifactBytes: 0,
    },
    gauges: {
      elapsedRunMs: 0,
      activeSubagents,
      activeWriters: 0,
      activeToolInvocations: 0,
      activeShellInvocations: 0,
    },
  };
}

function modelRef<Kind extends 'model_surface' | 'model_response'>(
  kind: Kind,
  canonicalJson: string,
) {
  const byteLength = Buffer.byteLength(canonicalJson, 'utf8');
  const contentDigest = createHash('sha256').update(canonicalJson).digest('hex');
  const material = `model-artifacts\0${kind}\0${contentDigest}`;
  const artifactId = `pa_${createHash('sha256')
    .update('kite.private-immutable-artifact.id.v1\0')
    .update(material)
    .digest('hex')}`;
  return {
    artifactId,
    kind,
    integrityIdentifier: `sha256:${createHash('sha256')
      .update('kite.private-immutable-artifact.integrity.v1\0')
      .update(material)
      .update('\0')
      .update(artifactId)
      .update('\0')
      .update(String(byteLength))
      .digest('hex')}`,
    byteLength,
  };
}

function childBudget() {
  return {
    version: 1,
    maxRunDurationMs: 60_000,
    maxTurns: 1,
    maxModelRequests: 1,
    maxToolInvocations: 0,
    maxRunInputTokens: 80,
    maxRunOutputTokens: 10,
    maxConcurrentSubagents: 0,
    maxConcurrentWriters: 0,
    maxConcurrentToolInvocations: 0,
    maxConcurrentShellInvocations: 0,
    maxConcurrencyWaitMs: 0,
    maxArtifactBytes: 0,
  };
}

function fixture(path = ':memory:') {
  const db = new Database(path, { strict: true });
  initializeKiteSessionStoreIfNeeded(db);
  db.query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,
    project_id,workspace_digest,display_name,created_at,updated_at)
    VALUES ('workspace','/workspace',?,'project',?,'Workspace',1,1)`).run(
    `sha256:${'a'.repeat(64)}`,
    `sha256:${'b'.repeat(64)}`,
  );
  const session = db.query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,
    workspace_digest,state_schema,format_epoch,revision,name,updated_at,run_index_from_revision,
    parent_session_id) VALUES (?,'workspace','project',?,27,'test',1,'',1,0,?)`);
  session.run('parent', `sha256:${'b'.repeat(64)}`, null);
  session.run('child', `sha256:${'b'.repeat(64)}`, 'parent');
  const agent = db.query(`INSERT INTO agent_nodes(session_id,agent_id,current_task_id,status,
    turn_ordinal,created_at_ms) VALUES (?,?,?,'active',1,1)`);
  agent.run('parent', 'parent', 'run-1');
  agent.run('child', 'child', 'child-run');
  db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
    created_revision,last_revision,created_at_ms,started_at_ms)
    VALUES ('parent','run-1','start-parent','building','running',1,1,1,1),
           ('child','child-run','start-child','building','running',1,1,1,1)`).run();
  db.query(`INSERT INTO runtime_command_receipts(scope_session_id,command_id,workspace_id,
    project_id,workspace_digest,request_digest,target_session_id,original_receipt_json,
    committed_revision,committed_at) VALUES ('parent','mail-1','workspace','project',?,
    ?,'parent','{}',1,10)`).run(`sha256:${'b'.repeat(64)}`, 'c'.repeat(64));
  const bodyText = 'hello child';
  const bodyHex = createHash('sha256').update(bodyText).digest('hex');
  const bodyDigest = `sha256:${bodyHex}`;
  const upper = usage(1, 1, 100, 10, 1);
  const reservation = {
    version: 1,
    reservationId: 'backup-1',
    runId: 'run-1',
    invocationId: 'submission-1',
    resourceKind: 'subagent',
    executableUpperBound: upper,
    state: 'reserved',
  };
  const policy = {
    boundedContext: true,
    phaseCeiling: 'building',
    workspaceDigest: `sha256:${'b'.repeat(64)}`,
    capabilityDigest: 'catalog-1',
    interactionMode: 'accept_edits',
    interactionModeRevision: 1,
    workspaceAccess: 'workspace_only',
    authorizationDigest: 'auth-1',
    admissionDigest: 'admission-1',
    effectiveEffectsDigest: 'effects-1',
    policyRevision: 'policy-1',
    contextWindowTokens: 200,
    maxOutputTokens: 10,
    firstAttemptTimeoutMs: 1_000,
  };
  const source = {
    runId: 'run-1',
    turnId: 'turn-1',
    modelInvocationId: 'model-1',
    toolCallId: 'tool-1',
    effectAttemptId: 'invocation-1:attempt:1',
  };
  const deadlineAt = 90_000;
  const canonicalJson = JSON.stringify({
    schema: 'kite.cross-session-followup-admission.v1',
    submissionId: 'submission-1',
    messageId: 'mail-1',
    sourceSessionId: 'parent',
    targetSessionId: 'child',
    sourceRunId: source.runId,
    sourceTurnId: source.turnId,
    sourceModelInvocationId: source.modelInvocationId,
    sourceToolCallId: source.toolCallId,
    sourceEffectAttemptId: source.effectAttemptId,
    preparedTool: {
      invocationId: 'invocation-1',
      operationId: 'builtin:followup_task',
      capabilityId: 'builtin:followup_task',
      capabilityRevision: 'capability-1',
      bindingId: null,
      toolCallId: source.toolCallId,
      attemptId: source.effectAttemptId,
      modelMessageId: 'message-1',
      turnId: source.turnId,
      policyEffects: {},
      effectiveEffects: {},
      sandboxScope: null,
      authorizationKind: 'policy_allow',
      grantUsed: 'none',
      interactionMode: 'accept_edits',
      argumentsDigest: 'd'.repeat(64),
      schemaDigest: 'e'.repeat(64),
      effectiveEffectsDigest: 'effects-1',
      authorizationDigest: 'auth-1',
      admissionDigest: 'admission-1',
      policyRevision: 'policy-1',
    },
    bodyDigest,
    backupReservationId: reservation.reservationId,
    fundingRunId: source.runId,
    deadlineAt,
    executableUpperBound: upper,
    source,
    policy,
  });
  const admissionHex = createHash('sha256').update(canonicalJson).digest('hex');
  const admissionDigest = `sha256:${admissionHex}`;
  const admissionRef = {
    artifactId: `pa_${admissionHex}`,
    kind: 'agent_followup_admission' as const,
    integrityIdentifier: admissionDigest,
    byteLength: Buffer.byteLength(canonicalJson),
  };
  const input = {
    sourceSessionId: 'parent',
    targetSessionId: 'child',
    messageId: 'mail-1',
    commandId: 'mail-1',
    requestDigest: 'c'.repeat(64),
    sourceRunId: source.runId,
    sourceTurnId: source.turnId,
    sourceModelInvocationId: source.modelInvocationId,
    sourceToolCallId: source.toolCallId,
    sourceEffectAttemptId: source.effectAttemptId,
    sourceSequence: 1,
    sourceRevision: 1,
    bodyText,
    acceptedAtMs: 10,
    submissionId: 'submission-1',
    acceptedEvent: {
      type: 'agent.mail_accepted',
      messageId: 'mail-1',
      submissionId: 'submission-1',
      senderAgentId: 'parent',
      targetAgentId: 'child',
      mode: 'trigger_turn',
      source,
      bodyRef: {
        artifactId: `pa_${bodyHex}`,
        kind: 'agent_mail',
        integrityIdentifier: bodyDigest,
        byteLength: Buffer.byteLength(bodyText),
      },
      bodyDigest,
      followupAdmissionRef: admissionRef,
      followupAdmissionDigest: admissionDigest,
      sequence: 1,
    },
    reservationEvent: { type: 'resource_budget.reserved', reservation },
    admission: { ref: admissionRef, digest: admissionDigest, canonicalJson, createdAt: 10 },
    sourceSnapshot: {
      session: { canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}` },
      turn: { turnId: 'turn-1', status: 'active' },
      mode: 'accept_edits',
      interactionModeRevision: 1,
      workspaceAccess: 'workspace_only',
      tools: {
        calls: {
          'tool-1': {
            name: 'followup_task',
            status: 'running',
            modelInvocationId: 'model-1',
            modelMessageId: 'message-1',
          },
        },
      },
      capabilities: {
        catalogRevision: 'catalog-1',
        bindings: {},
        invocations: {
          'invocation-1': {
            invocationId: 'invocation-1',
            toolCallId: 'tool-1',
            status: 'running',
            capabilityId: 'builtin:followup_task',
            capabilityRevision: 'capability-1',
            argumentsDigest: 'd'.repeat(64),
            attemptsStarted: 1,
            authorizationDigest: 'auth-1',
            admissionDigest: 'admission-1',
            effectiveEffectsDigest: 'effects-1',
          },
        },
      },
      resourceBudget: {
        status: 'active',
        runId: 'run-1',
        deadlineAt: new Date(deadlineAt).toISOString(),
        reservations: { 'backup-1': reservation },
      },
    },
  };
  return { db, input };
}

describe('Store13 cross-Session TriggerTurn source', () => {
  test.each([
    0, 1,
  ])('accepts a versioned independent-turn backup with Tool/Shell gauge %p', (heldGauge) => {
    const { db, input } = fixture();
    try {
      const sealed = sealChildGrantPayload({
        role: 'explore',
        capabilityCeiling: { allowedTools: ['read_file'], bindingIds: [] },
      });
      db.query(`INSERT INTO subagent_task_artifacts(artifact_id,kind,integrity_identifier,
        artifact_format_version,canonical_json,byte_length,created_at)
        VALUES (?,'subagent_task',?,1,'{}',2,1)`).run(
        `pa_${'1'.repeat(64)}`,
        `sha256:${'1'.repeat(64)}`,
      );
      db.query(`INSERT INTO child_session_intents(child_thread_id,parent_session_id,parent_invocation_id,
        origin_run_id,origin_turn_id,origin_tool_call_id,attempt,child_invocation_id,
        grant_digest,sealed_grant_json,sealed_grant_byte_length,sealed_grant_digest,
        task_artifact_digest,task_text_digest,task_artifact_id,task_artifact_byte_length,
        disposition,role,tool_event_id,tool_event_revision,funding_run_id,
        delegated_reservation_id,delegated_upper_bound_digest,delegated_upper_bound_json,deadline_at)
        VALUES ('child','parent','origin-inv','run-1','turn-1','spawn-tool',1,'child-task',
        ?,?,?,?,'task','text',?,2,'required','explore','event',1,
        'run-1','delegated','upper','{}','2099-01-01T00:00:00.000Z')`).run(
        'original-grant',
        sealed.sealedGrantJson,
        sealed.sealedGrantByteLength,
        sealed.sealedGrantDigest,
        `pa_${'1'.repeat(64)}`,
      );
      const v2 = structuredClone(input);
      const backupId = `backup_${'a'.repeat(64)}`;
      const upper = {
        source: 'versioned_upper_bound' as const,
        estimatorVersion: 'cross-session-followup-backup-v2',
        independentFollowupTurn: true as const,
        unboundedToolInvocations: true as const,
        counters: {
          turns: 1,
          modelRequests: 3,
          toolInvocations: 0,
          inputTokens: 500,
          outputTokens: 60,
          artifactBytes: 4096,
        },
        gauges: {
          elapsedRunMs: 30 * 60_000,
          activeSubagents: 1,
          activeWriters: 0,
          activeToolInvocations: heldGauge,
          activeShellInvocations: heldGauge,
        },
      };
      Object.assign(v2.reservationEvent.reservation, {
        reservationId: backupId,
        executableUpperBound: upper,
      });
      const sourceReservations = v2.sourceSnapshot.resourceBudget.reservations as Record<
        string,
        typeof v2.reservationEvent.reservation
      >;
      delete sourceReservations['backup-1'];
      sourceReservations[backupId] = v2.reservationEvent.reservation;
      const admission = JSON.parse(v2.admission.canonicalJson);
      admission.schema = 'kite.cross-session-followup-admission.v2';
      admission.backupReservationId = backupId;
      admission.executableUpperBound = upper;
      admission.policy = {
        ...admission.policy,
        executionMode: 'independent_turn_v2',
        targetRole: 'explore',
        targetGrantDigest: sealed.sealedGrantDigest,
      };
      const canonicalJson = JSON.stringify(admission);
      const digest = `sha256:${createHash('sha256').update(canonicalJson).digest('hex')}`;
      Object.assign(v2.admission, {
        canonicalJson,
        digest,
        ref: {
          artifactId: `pa_${digest.slice(7)}`,
          kind: 'agent_followup_admission',
          integrityIdentifier: digest,
          byteLength: Buffer.byteLength(canonicalJson),
        },
      });
      v2.acceptedEvent.followupAdmissionRef = v2.admission.ref;
      v2.acceptedEvent.followupAdmissionDigest = digest;
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','v2-backup',0,27,?,10),('parent','v2-accepted',1,27,?,10)`).run(
        JSON.stringify(v2.reservationEvent),
        JSON.stringify(v2.acceptedEvent),
      );
      db.transaction(() => acceptCrossSessionFollowupInTransaction(db, v2))();
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM agent_mail_inbox WHERE target_session_id='child'",
          )
          .get()?.count,
      ).toBe(0);
      expect(
        readAcceptedIndependentFollowupSourcePolicyProof(db, 'child', 'parent', 'submission-1')
          ?.policy,
      ).toMatchObject({ executionMode: 'independent_turn_v2' });
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='child'");
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          messageId: 'mail-1',
          targetRevision: 2,
          receivedAtMs: 20,
        }),
      )();
      const proof = readAcceptedIndependentFollowupSourcePolicyProof(
        db,
        'child',
        'parent',
        'submission-1',
      );
      expect(proof?.policy).toMatchObject({
        executionMode: 'independent_turn_v2',
        targetRole: 'explore',
        targetGrantDigest: sealed.sealedGrantDigest,
      });
      const oldCheckpointJson = JSON.stringify({
        artifactFormatVersion: 1,
        childSessionId: 'child',
        terminalRunId: 'child-run',
        terminalTaskId: 'old-task',
        terminalRevision: 2,
        terminalStatus: 'completed',
        stateDigest: 'old',
        transcriptDigest: 'old',
        transcript: { messages: [] },
      });
      const oldCheckpointHex = createHash('sha256').update(oldCheckpointJson).digest('hex');
      const oldCheckpointRef = {
        artifactId: `pa_${oldCheckpointHex}`,
        kind: 'subagent_checkpoint' as const,
        integrityIdentifier: `sha256:${oldCheckpointHex}`,
        byteLength: Buffer.byteLength(oldCheckpointJson),
      };
      createKiteHomeArtifactStore(db).writeSubagentCheckpoint({
        ref: oldCheckpointRef,
        artifactFormatVersion: 1,
        canonicalJson: oldCheckpointJson,
        createdAt: 21,
      });
      db.query(`UPDATE agent_nodes SET latest_checkpoint_artifact_id=?,
        latest_checkpoint_integrity_identifier=?,latest_checkpoint_byte_length=?
        WHERE session_id='child'`).run(
        oldCheckpointRef.artifactId,
        oldCheckpointRef.integrityIdentifier,
        oldCheckpointRef.byteLength,
      );
      db.run(
        "UPDATE runtime_runs SET status='completed',finished_at_ms=21,last_revision=2 WHERE session_id='child'",
      );
      db.run("UPDATE runtime_sessions SET revision=3 WHERE session_id='child'");
      db.run(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms)
        VALUES ('child','followup-run','followup:submission-1','building','queued',3,3,30)`);
      const grantBudget = {
        version: 1,
        maxRunDurationMs: 30 * 60_000,
        maxTurns: 1,
        maxModelRequests: 3,
        maxToolInvocations: 0,
        unboundedToolInvocations: true,
        maxRunInputTokens: 500,
        maxRunOutputTokens: 60,
        maxArtifactBytes: 4096,
        maxConcurrentSubagents: 0,
        maxConcurrentWriters: 0,
        maxConcurrentToolInvocations: 1,
        maxConcurrentShellInvocations: 1,
        maxConcurrencyWaitMs: 15_000,
        deadlineAt: new Date(30_000 + 30 * 60_000).toISOString(),
      };
      const grantJson = JSON.stringify({
        schema: 'kite.child-followup-grant.v2',
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        submissionId: 'submission-1',
        targetRunId: 'followup-run',
        taskId: 'followup-task',
        checkpointRef: oldCheckpointRef,
        originRole: 'explore',
        workspaceDigest: `sha256:${'b'.repeat(64)}`,
        interactionModeRevision: 1,
        capabilityDigest: 'catalog-1',
        phaseCeiling: 'building',
        sourceAdmissionRef: v2.admission.ref,
        sourceAdmissionDigest: v2.admission.digest,
        sourceBackupUpperDigest: childDelegatedUpperBoundDigest(upper),
        denyTools: false,
        allowedTools: ['read_file'],
        budget: grantBudget,
        firstAttemptTimeoutMs: 1000,
      });
      const grantHex = createHash('sha256').update(grantJson).digest('hex');
      const grantRef = {
        artifactId: `pa_${grantHex}`,
        kind: 'agent_followup_grant' as const,
        integrityIdentifier: `sha256:${grantHex}`,
        byteLength: Buffer.byteLength(grantJson),
      };
      const preparedEvent = {
        type: 'agent.followup_turn_prepared',
        sourceSessionId: 'parent',
        submissionId: 'submission-1',
        targetRunId: 'followup-run',
        taskId: 'followup-task',
        checkpointRef: oldCheckpointRef,
        grantRef,
        grantDigest: grantRef.integrityIdentifier,
      };
      const targetState = {
        session: { canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}` },
        childSessionOrigin: {
          role: 'explore',
          parentSessionId: 'parent',
          grantDigest: sealed.sealedGrantDigest,
          terminal: { status: 'completed' },
        },
        activeFollowupTurn: {
          sourceSessionId: 'parent',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          taskId: 'followup-task',
          checkpointRef: oldCheckpointRef,
          grantRef,
          grantDigest: grantRef.integrityIdentifier,
        },
        interactionModeRevision: 1,
        capabilities: { catalogRevision: 'catalog-1' },
        mode: 'accept_edits',
        workspaceAccess: 'workspace_only',
        activeTaskId: 'followup-task',
        turn: { turnId: 'followup-run', status: 'active' },
        resourceBudget: {
          status: 'active',
          runId: 'followup-run',
          startedAt: new Date(30_000).toISOString(),
          deadlineAt: grantBudget.deadlineAt,
          budget: grantBudget,
          reservations: {},
        },
      };
      const parentState = structuredClone(v2.sourceSnapshot);
      const parentReservations = parentState.resourceBudget.reservations as Record<
        string,
        typeof v2.reservationEvent.reservation & { actual?: unknown }
      >;
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('parent',27,'test',1,?,1,'checksum',10),
               ('child',27,'test',3,?,3,'checksum',30)`).run(
        JSON.stringify(parentState),
        JSON.stringify(targetState),
      );
      expect(readTargetSnapshotEvidence(db, 'child', 3)).toEqual({
        revision: 3,
        digest: `sha256:${createHash('sha256').update(JSON.stringify(targetState)).digest('hex')}`,
      });
      expect(readTargetSnapshotEvidence(db, 'child', 2)).toBeNull();
      db.query("UPDATE child_session_intents SET grant_digest=? WHERE child_thread_id='child'").run(
        'different-new-grant',
      );
      const mutation = {
        sourceSessionId: 'parent',
        submissionId: 'submission-1',
        targetRunId: 'followup-run',
        taskId: 'followup-task',
        phase: 'building' as const,
        checkpointRef: oldCheckpointRef,
        grantDigest: grantRef.integrityIdentifier,
        grant: { ref: grantRef, canonicalJson: grantJson, createdAt: 30 },
      };
      db.transaction(() =>
        assertCrossSessionFollowupRunStartInTransaction(db, {
          targetSessionId: 'child',
          mutation,
          preparedEvent,
        }),
      )();
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child','v2-run-prepared',3,27,?,30)`).run(JSON.stringify(preparedEvent));
      db.run('SAVEPOINT v2_pre_dispatch');
      const releasedSource = structuredClone(parentState);
      (releasedSource.resourceBudget.reservations as Record<string, { state: string }>)[
        backupId
      ]!.state = 'released';
      const failedTarget = {
        ...targetState,
        activeTaskId: null,
        turn: { turnId: 'followup-run', status: 'aborted' },
        terminalOutcome: { status: 'failed' },
      };
      const failedDigest = `sha256:${createHash('sha256')
        .update(JSON.stringify(failedTarget))
        .digest('hex')}`;
      const preRelease = {
        type: 'resource_budget.released',
        reservationId: backupId,
        proof: 'local_pre_dispatch_failure',
      };
      const failedSettlement = {
        type: 'agent.followup_turn_settled',
        sourceSessionId: 'parent',
        submissionId: 'submission-1',
        targetRunId: 'followup-run',
        taskId: 'followup-task',
        status: 'failed',
      };
      const failedAudit = {
        type: 'agent.followup_independent_settled',
        submissionId: 'submission-1',
        targetAgentId: 'child',
        targetRunId: 'followup-run',
        targetRevision: 4,
        disposition: 'pre_dispatch_released',
        evidenceDigest: failedDigest,
        createdAtMs: 31,
      };
      db.run("UPDATE runtime_sessions SET revision=3 WHERE session_id='parent'");
      db.query(
        "UPDATE runtime_snapshots SET revision=3,state_json=? WHERE session_id='parent'",
      ).run(JSON.stringify(releasedSource));
      db.run("UPDATE runtime_sessions SET revision=4 WHERE session_id='child'");
      db.query("UPDATE runtime_snapshots SET revision=4,state_json=? WHERE session_id='child'").run(
        JSON.stringify(failedTarget),
      );
      db.query(
        "UPDATE runtime_runs SET status='failed',started_at_ms=30,finished_at_ms=31,last_revision=4,terminal_json=? WHERE session_id='child' AND run_id='followup-run'",
      ).run(JSON.stringify({ status: 'failed' }));
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','v2-pre-release',2,27,?,31),
               ('parent','v2-pre-audit',3,27,?,31),
               ('child','v2-pre-settled',4,27,?,31)`).run(
        JSON.stringify(preRelease),
        JSON.stringify(failedAudit),
        JSON.stringify(failedSettlement),
      );
      db.transaction(() =>
        settleIndependentCrossSessionFollowupFundingInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          targetRevision: 4,
          disposition: 'pre_dispatch_released',
          sourceRevision: 3,
          createdAtMs: 31,
          sourceSnapshot: releasedSource,
          events: [preRelease, failedAudit],
        }),
      )();
      expect(readCrossSessionFollowupRoute(db, 'child', 'submission-1')).toBeNull();
      expect(
        db.transaction(() =>
          acceptCrossSessionFollowupTerminalReplyInTransaction(db, {
            childSessionId: 'child',
            parentSessionId: 'parent',
            submissionId: 'submission-1',
            acceptedAtMs: 32,
          }),
        )().mode,
      ).toBe('reply');
      db.run('ROLLBACK TO v2_pre_dispatch');
      db.run('RELEASE v2_pre_dispatch');
      parentState.tools.calls['tool-1'].status = 'succeeded';
      parentState.capabilities.invocations['invocation-1'].status = 'succeeded';
      parentReservations[backupId]!.state = 'dispatch_started';
      db.query(
        "UPDATE runtime_snapshots SET revision=2,state_json=? WHERE session_id='parent'",
      ).run(JSON.stringify(parentState));
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'");
      const dispatch = { type: 'resource_budget.dispatch_started', reservationId: backupId };
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','v2-dispatch',2,27,?,31)`).run(JSON.stringify(dispatch));
      db.transaction(() =>
        activateIndependentCrossSessionFollowupTurnInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          grantDigest: grantRef.integrityIdentifier,
          targetRevision: 3,
          sourceRevision: 2,
          createdAtMs: 31,
          sourceSnapshot: parentState,
          events: [dispatch],
        }),
      )();
      expect(
        readIndependentCrossSessionFollowupActivation(db, 'parent', 'submission-1'),
      ).toMatchObject({
        targetRunId: 'followup-run',
        backupReservationId: backupId,
      });
      db.run('SAVEPOINT v2_unknown');
      const unknownSource = structuredClone(parentState);
      (unknownSource.resourceBudget.reservations as Record<string, { state: string }>)[
        backupId
      ]!.state = 'unknown';
      const unknownTarget = {
        ...targetState,
        activeTaskId: null,
        turn: { turnId: 'followup-run', status: 'aborted' },
        terminalOutcome: { status: 'unknown' },
      };
      const unknownEvidenceDigest = `sha256:${createHash('sha256')
        .update(JSON.stringify(unknownTarget))
        .digest('hex')}`;
      const unknownBudget = { type: 'resource_budget.unknown', reservationId: backupId };
      const unknownAudit = {
        type: 'agent.followup_independent_settled',
        submissionId: 'submission-1',
        targetAgentId: 'child',
        targetRunId: 'followup-run',
        targetRevision: 4,
        disposition: 'unknown',
        evidenceDigest: unknownEvidenceDigest,
        createdAtMs: 32,
      };
      db.run("UPDATE runtime_sessions SET revision=4 WHERE session_id='parent'");
      db.query(
        "UPDATE runtime_snapshots SET revision=4,state_json=? WHERE session_id='parent'",
      ).run(JSON.stringify(unknownSource));
      db.run("UPDATE runtime_sessions SET revision=4 WHERE session_id='child'");
      db.query("UPDATE runtime_snapshots SET revision=4,state_json=? WHERE session_id='child'").run(
        JSON.stringify(unknownTarget),
      );
      db.query(
        "UPDATE runtime_runs SET status='unknown',started_at_ms=30,finished_at_ms=32,last_revision=4,terminal_json=? WHERE session_id='child' AND run_id='followup-run'",
      ).run(JSON.stringify({ status: 'unknown' }));
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','v2-source-unknown',3,27,?,32),
               ('parent','v2-unknown-audit',4,27,?,32),
               ('child','v2-unknown-settled',4,27,?,32)`).run(
        JSON.stringify(unknownBudget),
        JSON.stringify(unknownAudit),
        JSON.stringify({
          type: 'agent.followup_turn_settled',
          sourceSessionId: 'parent',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          taskId: 'followup-task',
          status: 'unknown',
        }),
      );
      db.transaction(() =>
        settleIndependentCrossSessionFollowupFundingInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          targetRevision: 4,
          disposition: 'unknown',
          sourceRevision: 4,
          createdAtMs: 32,
          sourceSnapshot: unknownSource,
          events: [unknownBudget, unknownAudit],
        }),
      )();
      expect(
        db.transaction(() =>
          settleIndependentCrossSessionFollowupFundingInTransaction(db, {
            sourceSessionId: 'parent',
            targetSessionId: 'child',
            submissionId: 'submission-1',
            targetRunId: 'followup-run',
            targetRevision: 4,
            disposition: 'unknown',
            sourceRevision: 4,
            createdAtMs: 32,
            sourceSnapshot: unknownSource,
            events: [unknownAudit],
          }),
        )().disposition,
      ).toBe('unknown');
      expect(readCrossSessionFollowupTerminalReceipt(db, 'parent', 'submission-1')).toMatchObject({
        disposition: 'unknown',
        evidenceDigest: unknownEvidenceDigest,
      });
      expect(listUnrepliedSettledFollowupTerminalSources(db, 10)).toEqual([]);
      db.run('ROLLBACK TO v2_unknown');
      db.run('RELEASE v2_unknown');
      const retainedState = {
        ...parentState,
        resourceBudget: { ...parentState.resourceBudget, runId: 'run-2', reservations: {} },
        retainedResourceBudgets: { 'run-1': parentState.resourceBudget },
      };
      db.run(
        "UPDATE runtime_runs SET status='completed',finished_at_ms=35,last_revision=3 WHERE session_id='parent' AND run_id='run-1'",
      );
      db.run(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms,started_at_ms)
        VALUES ('parent','run-2','next-turn','building','running',3,3,35,35)`);
      db.run("UPDATE runtime_sessions SET revision=3 WHERE session_id='parent'");
      db.query(
        "UPDATE runtime_snapshots SET revision=3,state_json=? WHERE session_id='parent'",
      ).run(JSON.stringify(retainedState));
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','parent-next-turn',3,27,?,35)`).run(
        JSON.stringify({ type: 'turn.completed', turnId: 'turn-1' }),
      );
      expect(
        readIndependentCrossSessionFollowupActivation(db, 'parent', 'submission-1'),
      ).toMatchObject({
        targetRunId: 'followup-run',
      });
      db.run('SAVEPOINT v2_approval_probe');
      try {
        db.query(`UPDATE child_session_intents SET dispatch_ack_event_id='original-ack',
          parent_claim_settled_event_id='original-settled',grant_digest=?
          WHERE child_thread_id='child'`).run(sealed.sealedGrantDigest);
        const approvalEvent = {
          type: 'approval.requested',
          interactionId: 'v2-approval',
          toolCallId: 'v2-approved-tool',
          owner: { kind: 'root_tool', toolCallId: 'v2-approved-tool' },
          approval: { tool: 'read_file', summary: 'Read outside workspace' },
        };
        const approvalJson = JSON.stringify(approvalEvent);
        const approvalDigest = `sha256:${createHash('sha256').update(approvalJson).digest('hex')}`;
        const approvalState = {
          ...targetState,
          revision: 4,
          session: { ...targetState.session, threadId: 'child' },
          childSessionOrigin: {
            ...targetState.childSessionOrigin,
            childInvocationId: 'child-task',
            terminal: { status: 'completed', cleanupConfirmed: true },
          },
          tools: {
            calls: {
              'v2-approved-tool': {
                toolCallId: 'v2-approved-tool',
                name: 'read_file',
                createdAtTurnId: 'followup-run',
                status: 'awaiting_approval',
              },
            },
          },
          pendingApprovals: new Map([
            [
              'v2-approval',
              {
                toolCallId: 'v2-approved-tool',
                generation: 1,
                route: 'user',
                status: 'awaiting_user',
              },
            ],
          ]),
        };
        db.run("UPDATE runtime_sessions SET revision=4 WHERE session_id='child'");
        db.query(
          "UPDATE runtime_snapshots SET revision=4,state_json=? WHERE session_id='child'",
        ).run(JSON.stringify(approvalState));
        db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
          VALUES ('child','v2-approval-request',4,27,?,36)`).run(approvalJson);
        const proxy = db.transaction(() =>
          openChildApprovalProxyInTransaction(db, {
            childThreadId: 'child',
            childInteractionId: 'v2-approval',
            childGeneration: 1,
            childRequestRevision: 4,
            childToolCallId: 'v2-approved-tool',
            approvalDigest,
            postState: approvalState,
          }),
        )();
        expect(proxy).toMatchObject({
          grantDigest: grantRef.integrityIdentifier,
          parentToolCallId: followupChildApprovalParentToolCallId({
            submissionId: 'submission-1',
            targetRunId: 'followup-run',
            sourceToolCallId: 'tool-1',
          }),
          status: 'pending',
        });
        expect(() =>
          openChildApprovalProxyInTransaction(db, {
            childThreadId: 'child',
            childInteractionId: 'v2-approval',
            childGeneration: 1,
            childRequestRevision: 4,
            childToolCallId: 'v2-approved-tool',
            approvalDigest,
            postState: {
              ...approvalState,
              activeFollowupTurn: {
                ...approvalState.activeFollowupTurn,
                grantDigest: `sha256:${'f'.repeat(64)}`,
              },
            },
          }),
        ).toThrow('source activation');
        db.query(`INSERT INTO runtime_command_receipts(scope_session_id,command_id,workspace_id,
          project_id,workspace_digest,request_digest,target_session_id,original_receipt_json,
          committed_revision,committed_at) VALUES ('parent','v2-approve','workspace','project',?,
          ?,'parent','{}',3,37)`).run(`sha256:${'b'.repeat(64)}`, 'a'.repeat(64));
        expect(
          db.transaction(() =>
            decideChildApprovalProxyInTransaction(db, {
              parentSessionId: 'parent',
              proxyInteractionId: proxy.proxyInteractionId,
              childRequestRevision: 4,
              childGeneration: 1,
              approvalDigest,
              decision: 'approve_once',
              parentCommandId: 'v2-approve',
              parentCommandDigest: 'a'.repeat(64),
              parentDecisionRevision: 3,
            }),
          )().status,
        ).toBe('decided');
        const granted = {
          type: 'approval.granted',
          interactionId: 'v2-approval',
          toolCallId: 'v2-approved-tool',
          generation: 1,
          grant: 'approve_once',
        };
        db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
          VALUES ('child','v2-approval-granted',5,27,?,38)`).run(JSON.stringify(granted));
        expect(
          db.transaction(() =>
            markChildApprovalAppliedInTransaction(db, {
              parentSessionId: 'parent',
              proxyInteractionId: proxy.proxyInteractionId,
              decision: 'approve_once',
              childAppliedRevision: 5,
            }),
          )().status,
        ).toBe('applied');
        const rejectionEvent = {
          ...approvalEvent,
          interactionId: 'v2-rejection',
          toolCallId: 'v2-rejected-tool',
          owner: { kind: 'root_tool', toolCallId: 'v2-rejected-tool' },
        };
        const rejectionJson = JSON.stringify(rejectionEvent);
        const rejectionDigest = `sha256:${createHash('sha256').update(rejectionJson).digest('hex')}`;
        const rejectionState = {
          ...approvalState,
          revision: 6,
          tools: {
            calls: {
              ...approvalState.tools.calls,
              'v2-rejected-tool': {
                toolCallId: 'v2-rejected-tool',
                name: 'read_file',
                createdAtTurnId: 'followup-run',
                status: 'awaiting_approval',
              },
            },
          },
          pendingApprovals: new Map([
            [
              'v2-rejection',
              {
                toolCallId: 'v2-rejected-tool',
                generation: 2,
                route: 'user',
                status: 'awaiting_user',
              },
            ],
          ]),
        };
        db.run("UPDATE runtime_sessions SET revision=6 WHERE session_id='child'");
        db.query(
          "UPDATE runtime_snapshots SET revision=6,state_json=? WHERE session_id='child'",
        ).run(JSON.stringify(rejectionState));
        db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
          VALUES ('child','v2-approval-rejection-request',6,27,?,39)`).run(rejectionJson);
        const rejectedProxy = db.transaction(() =>
          openChildApprovalProxyInTransaction(db, {
            childThreadId: 'child',
            childInteractionId: 'v2-rejection',
            childGeneration: 2,
            childRequestRevision: 6,
            childToolCallId: 'v2-rejected-tool',
            approvalDigest: rejectionDigest,
            postState: rejectionState,
          }),
        )();
        db.query(`INSERT INTO runtime_command_receipts(scope_session_id,command_id,workspace_id,
          project_id,workspace_digest,request_digest,target_session_id,original_receipt_json,
          committed_revision,committed_at) VALUES ('parent','v2-reject','workspace','project',?,
          ?,'parent','{}',3,40)`).run(`sha256:${'b'.repeat(64)}`, 'b'.repeat(64));
        expect(
          db.transaction(() =>
            decideChildApprovalProxyInTransaction(db, {
              parentSessionId: 'parent',
              proxyInteractionId: rejectedProxy.proxyInteractionId,
              childRequestRevision: 6,
              childGeneration: 2,
              approvalDigest: rejectionDigest,
              decision: 'reject',
              parentCommandId: 'v2-reject',
              parentCommandDigest: 'b'.repeat(64),
              parentDecisionRevision: 3,
            }),
          )().status,
        ).toBe('decided');
        db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
          VALUES ('child','v2-approval-rejected',7,27,?,41)`).run(
          JSON.stringify({
            type: 'approval.rejected',
            interactionId: 'v2-rejection',
            toolCallId: 'v2-rejected-tool',
            generation: 2,
          }),
        );
        expect(
          db.transaction(() =>
            markChildApprovalAppliedInTransaction(db, {
              parentSessionId: 'parent',
              proxyInteractionId: rejectedProxy.proxyInteractionId,
              decision: 'reject',
              childAppliedRevision: 7,
            }),
          )().status,
        ).toBe('applied');
        expect(() => validateChildApprovalProxyContinuity(db)).not.toThrow();
        db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
          created_revision,last_revision,created_at_ms,started_at_ms)
          VALUES ('child','later-run','later-command','building','running',8,8,42,42)`).run();
        expect(() => validateChildApprovalProxyContinuity(db)).not.toThrow();
      } finally {
        db.run('ROLLBACK TO v2_approval_probe');
        db.run('RELEASE v2_approval_probe');
      }
      const surfaceJson = JSON.stringify({ surface: 'v2-first' });
      const surfaceRef = modelRef('model_surface', surfaceJson);
      createKiteHomeArtifactStore(db).writeModel({
        ref: surfaceRef,
        artifactFormatVersion: 1,
        canonicalJson: surfaceJson,
        createdAt: 33,
      });
      const localModel = {
        reservationId: 'v2-model-1',
        runId: 'followup-run',
        invocationId: 'model-invocation:v2-model-1',
        resourceKind: 'model',
        state: 'reserved',
        executableUpperBound: usage(0, 1, 100, 30, 0),
      };
      const workingState = {
        ...targetState,
        modelInvocations: {
          'v2-model-1': {
            invocationId: 'v2-model-1',
            status: 'prepared',
            purpose: 'primary_agent',
            attempts: 0,
            estimatedInputTokens: 40,
            budget: { kind: 'reservation', reservationId: 'v2-model-1' },
            surfaceArtifact: surfaceRef,
            surfaceIntegrityIdentifier: surfaceRef.integrityIdentifier,
          },
        },
        resourceBudget: {
          ...targetState.resourceBudget,
          reservations: { 'v2-model-1': localModel },
        },
      };
      db.run(
        "UPDATE runtime_runs SET status='running',started_at_ms=32,last_revision=4 WHERE session_id='child' AND run_id='followup-run'",
      );
      db.run("UPDATE runtime_sessions SET revision=4 WHERE session_id='child'");
      db.query("UPDATE runtime_snapshots SET revision=4,state_json=? WHERE session_id='child'").run(
        JSON.stringify(workingState),
      );
      expect(
        verifyCompletedChildFollowupModelWork(db, {
          sessionId: 'child',
          snapshot: workingState,
          events: [
            {
              type: 'model.invocation_prepared',
              invocationId: 'v2-model-1',
              purpose: 'primary_agent',
            },
          ],
        } as unknown as Parameters<typeof verifyCompletedChildFollowupModelWork>[1]),
      ).toBe(true);
      const routeEvent = {
        type: 'agent.followup_routed',
        submissionId: 'submission-1',
        targetAgentId: 'child',
        route: 'new_turn',
        taskId: 'followup-task',
        invocationId: 'v2-model-1',
        modelAdmissionId: 'v2-model-1',
        reservationId: 'v2-model-1',
        fundingRunId: 'run-1',
        sequence: 1,
      };
      db.transaction(() =>
        routeCrossSessionFollowupInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          messageId: 'mail-1',
          submissionId: 'submission-1',
          route: 'new_turn',
          targetRunId: 'followup-run',
          taskId: 'followup-task',
          invocationId: 'v2-model-1',
          modelAdmissionId: 'v2-model-1',
          reservationId: 'v2-model-1',
          routedRevision: 4,
          createdAtMs: 34,
          routedEvent: routeEvent,
          preparedEvent: {
            type: 'agent.mail_input_prepared',
            targetAgentId: 'child',
            invocationId: 'v2-model-1',
            modelAdmissionId: 'v2-model-1',
            fromSequence: 0,
            throughSequence: 1,
            messageIds: ['mail-1'],
          },
          targetSnapshot: workingState,
        }),
      )();
      expect(readCrossSessionFollowupRoute(db, 'child', 'submission-1')?.route).toBe('new_turn');
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child','v2-first-model-prepared',4,27,?,34)`).run(
        JSON.stringify({
          type: 'model.invocation_prepared',
          invocationId: 'v2-model-1',
          purpose: 'primary_agent',
        }),
      );
      expect(
        readPreparedCrossSessionFollowupRecoveryProof(db, 'child', 'parent', 'submission-1'),
      ).toMatchObject({
        invocationId: 'v2-model-1',
        modelReservationId: 'v2-model-1',
        surfaceDigest: surfaceRef.integrityIdentifier,
        preparedStateRevision: 4,
      });
      db.run('SAVEPOINT v2_surface_tamper');
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify({
          ...workingState,
          modelInvocations: {
            'v2-model-1': {
              ...workingState.modelInvocations['v2-model-1'],
              surfaceArtifact: {
                ...surfaceRef,
                integrityIdentifier: `sha256:${'f'.repeat(64)}`,
              },
            },
          },
        }),
      );
      expect(
        readPreparedCrossSessionFollowupRecoveryProof(db, 'child', 'parent', 'submission-1'),
      ).toBeNull();
      db.run('ROLLBACK TO v2_surface_tamper');
      db.run('RELEASE v2_surface_tamper');
      db.run('SAVEPOINT v2_attempted_recovery');
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child','v2-first-attempt',5,27,?,35)`).run(
        JSON.stringify({ type: 'model.invocation_attempt_started', invocationId: 'v2-model-1' }),
      );
      expect(
        readPreparedCrossSessionFollowupRecoveryProof(db, 'child', 'parent', 'submission-1'),
      ).toBeNull();
      db.run('ROLLBACK TO v2_attempted_recovery');
      db.run('RELEASE v2_attempted_recovery');
      const attemptedState = structuredClone(workingState);
      attemptedState.modelInvocations['v2-model-1'].attempts = 1;
      attemptedState.resourceBudget.reservations['v2-model-1'].state = 'dispatch_started';
      expect(
        verifyCompletedChildFollowupModelWork(db, {
          sessionId: 'child',
          snapshot: attemptedState,
          events: [
            { type: 'resource_budget.dispatch_started', reservationId: 'v2-model-1' },
            { type: 'model.invocation_attempt_started', invocationId: 'v2-model-1' },
          ],
        } as unknown as Parameters<typeof verifyCompletedChildFollowupModelWork>[1]),
      ).toBe(true);
      const responseRef = modelRef('model_response', JSON.stringify({ response: 'read it' }));
      const toolState = {
        ...attemptedState,
        modelInvocations: {
          'v2-model-1': {
            ...attemptedState.modelInvocations['v2-model-1'],
            status: 'completed',
            responseArtifact: responseRef,
          },
        },
        resourceBudget: {
          ...attemptedState.resourceBudget,
          reservations: {
            'v2-model-1': {
              ...attemptedState.resourceBudget.reservations['v2-model-1'],
              state: 'reconciled',
            },
          },
        },
        tools: {
          calls: {
            'v2-tool': {
              toolCallId: 'v2-tool',
              name: 'read_file',
              taskId: 'followup-task',
              createdAtTurnId: 'followup-run',
              modelInvocationId: 'v2-model-1',
              modelMessageId: 'v2-message-1',
              status: 'running',
            },
          },
        },
      };
      expect(
        verifyCompletedChildFollowupModelWork(db, {
          sessionId: 'child',
          snapshot: toolState,
          events: [{ type: 'tool.started', toolCallId: 'v2-tool' }],
        } as unknown as Parameters<typeof verifyCompletedChildFollowupModelWork>[1]),
      ).toBe(true);
      expect(
        verifyCompletedChildFollowupModelWork(db, {
          sessionId: 'child',
          snapshot: {
            ...toolState,
            tools: { calls: { 'v2-tool': { ...toolState.tools.calls['v2-tool'], name: 'task' } } },
          },
          events: [{ type: 'tool.started', toolCallId: 'v2-tool' }],
        } as unknown as Parameters<typeof verifyCompletedChildFollowupModelWork>[1]),
      ).toBe(false);
      const nextSurfaceJson = JSON.stringify({ surface: 'v2-second' });
      const nextSurfaceRef = modelRef('model_surface', nextSurfaceJson);
      createKiteHomeArtifactStore(db).writeModel({
        ref: nextSurfaceRef,
        artifactFormatVersion: 1,
        canonicalJson: nextSurfaceJson,
        createdAt: 36,
      });
      const nextState = {
        ...toolState,
        modelInvocations: {
          ...toolState.modelInvocations,
          'v2-model-2': {
            invocationId: 'v2-model-2',
            status: 'prepared',
            attempts: 0,
            budget: { kind: 'reservation', reservationId: 'v2-model-2' },
            surfaceArtifact: nextSurfaceRef,
          },
        },
        resourceBudget: {
          ...toolState.resourceBudget,
          reservations: {
            ...toolState.resourceBudget.reservations,
            'v2-model-2': {
              reservationId: 'v2-model-2',
              runId: 'followup-run',
              invocationId: 'model-invocation:v2-model-2',
              resourceKind: 'model',
              state: 'reserved',
              executableUpperBound: usage(0, 1, 100, 30, 0),
            },
          },
        },
      };
      expect(
        verifyCompletedChildFollowupModelWork(db, {
          sessionId: 'child',
          snapshot: nextState,
          events: [
            {
              type: 'model.invocation_prepared',
              invocationId: 'v2-model-2',
              purpose: 'primary_agent',
            },
          ],
        } as unknown as Parameters<typeof verifyCompletedChildFollowupModelWork>[1]),
      ).toBe(true);
      const actual = {
        source: 'actual',
        estimatorVersion: 'v2-test',
        counters: {
          turns: 1,
          modelRequests: 2,
          toolInvocations: 14,
          inputTokens: 180,
          outputTokens: 40,
          artifactBytes: 100,
        },
        gauges: {
          elapsedRunMs: 12_000,
          activeSubagents: 1,
          activeWriters: 0,
          activeToolInvocations: heldGauge,
          activeShellInvocations: 0,
        },
      };
      const finishedState = {
        ...nextState,
        activeTaskId: null,
        turn: { turnId: 'followup-run', status: 'completed' },
        terminalOutcome: { status: 'completed' },
        resourceBudget: {
          ...nextState.resourceBudget,
          reconciledUsage: {
            ...actual,
            counters: { ...actual.counters, turns: 0 },
            gauges: { ...actual.gauges, activeSubagents: 0 },
          },
        },
      };
      const finishedJson = JSON.stringify(finishedState);
      const evidenceDigest = `sha256:${createHash('sha256').update(finishedJson).digest('hex')}`;
      const terminalCheckpointJson = JSON.stringify({
        artifactFormatVersion: 1,
        childSessionId: 'child',
        terminalRunId: 'followup-run',
        terminalTaskId: 'followup-task',
        submissionId: 'submission-1',
        terminalRevision: 5,
        terminalStatus: 'completed',
        stateDigest: evidenceDigest,
        transcriptDigest: 'transcript',
        transcript: { messages: [] },
      });
      const terminalHex = createHash('sha256').update(terminalCheckpointJson).digest('hex');
      const terminalRef = {
        artifactId: `pa_${terminalHex}`,
        kind: 'subagent_checkpoint' as const,
        integrityIdentifier: `sha256:${terminalHex}`,
        byteLength: Buffer.byteLength(terminalCheckpointJson),
      };
      createKiteHomeArtifactStore(db).writeSubagentCheckpoint({
        ref: terminalRef,
        artifactFormatVersion: 1,
        canonicalJson: terminalCheckpointJson,
        createdAt: 50,
      });
      db.query(`UPDATE agent_nodes SET latest_checkpoint_artifact_id=?,
        latest_checkpoint_integrity_identifier=?,latest_checkpoint_byte_length=?
        WHERE session_id='child'`).run(
        terminalRef.artifactId,
        terminalRef.integrityIdentifier,
        terminalRef.byteLength,
      );
      db.run(
        "UPDATE runtime_runs SET status='completed',finished_at_ms=50,last_revision=5 WHERE session_id='child' AND run_id='followup-run'",
      );
      db.run("UPDATE runtime_sessions SET revision=5 WHERE session_id='child'");
      db.query("UPDATE runtime_snapshots SET revision=5,state_json=? WHERE session_id='child'").run(
        finishedJson,
      );
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child','v2-turn-settled',5,27,?,50)`).run(
        JSON.stringify({
          type: 'agent.followup_turn_settled',
          sourceSessionId: 'parent',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          taskId: 'followup-task',
          status: 'completed',
        }),
      );
      parentReservations[backupId]!.state = 'reconciled';
      Object.assign(parentReservations[backupId]!, { actual });
      db.run("UPDATE runtime_sessions SET revision=5 WHERE session_id='parent'");
      db.query(
        "UPDATE runtime_snapshots SET revision=5,state_json=? WHERE session_id='parent'",
      ).run(JSON.stringify(retainedState));
      const reconciled = { type: 'resource_budget.reconciled', reservationId: backupId, actual };
      const audit = {
        type: 'agent.followup_independent_settled',
        submissionId: 'submission-1',
        targetAgentId: 'child',
        targetRunId: 'followup-run',
        targetRevision: 5,
        disposition: 'completed',
        evidenceDigest,
        createdAtMs: 60,
      };
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','v2-reconciled',4,27,?,60),('parent','v2-terminal',5,27,?,60)`).run(
        JSON.stringify(reconciled),
        JSON.stringify(audit),
      );
      db.transaction(() =>
        settleIndependentCrossSessionFollowupFundingInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          targetRevision: 5,
          disposition: 'completed',
          sourceRevision: 5,
          createdAtMs: 60,
          sourceSnapshot: retainedState,
          events: [reconciled, audit],
        }),
      )();
      expect(readCrossSessionFollowupTerminalReceipt(db, 'parent', 'submission-1')).toMatchObject({
        disposition: 'completed',
        evidenceDigest,
        sourceRevision: 5,
      });
      expect(readLastFollowupOutcomeForDirectChild(db, 'parent', 'run-1', 'child')).toMatchObject({
        status: 'completed',
        sourceRevision: 5,
        submissionId: 'submission-1',
      });
      expect(readDirectChildFollowupOutcomeWatermark(db, 'parent', 'run-1')).toEqual({
        count: 1,
        throughRevision: 5,
      });
      expect(listPendingCrossSessionFollowupFunding(db, 'parent', 10)).toEqual([]);
      expect(listUnrepliedSettledFollowupTerminalSources(db, 10)).toEqual([
        {
          childSessionId: 'child',
          parentSessionId: 'parent',
          submissionId: 'submission-1',
        },
      ]);
      expect(
        db.transaction(() =>
          acceptCrossSessionFollowupTerminalReplyInTransaction(db, {
            childSessionId: 'child',
            parentSessionId: 'parent',
            submissionId: 'submission-1',
            acceptedAtMs: 61,
          }),
        )().mode,
      ).toBe('reply');
      expect(listUnrepliedSettledFollowupTerminalSources(db, 10)).toEqual([]);
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify({ ...finishedState, activeFollowupTurn: { submissionId: 'later-turn' } }),
      );
      expect(readCrossSessionFollowupTerminalReceipt(db, 'parent', 'submission-1')).toMatchObject({
        disposition: 'completed',
        evidenceDigest,
      });
      expect(
        readIndependentCrossSessionFollowupActivation(db, 'parent', 'submission-1'),
      ).toBeNull();
      db.query(
        "UPDATE runtime_command_receipts SET request_digest=? WHERE command_id='mail-1'",
      ).run('f'.repeat(64));
      expect(
        readAcceptedIndependentFollowupSourcePolicyProof(db, 'child', 'parent', 'submission-1'),
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  test('accepts a queued backup and releases capacity timeout only after a proven full-slot wait', () => {
    const { db, input } = fixture();
    try {
      const queued = structuredClone(input);
      queued.reservationEvent.reservation.state = 'queued';
      queued.sourceSnapshot.resourceBudget.reservations['backup-1'].state = 'queued';
      expect(() =>
        db.transaction(() => acceptCrossSessionFollowupInTransaction(db, queued))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','queued-backup',0,27,?,10)`).run(JSON.stringify(queued.reservationEvent));
      db.transaction(() => acceptCrossSessionFollowupInTransaction(db, queued))();
      const source = JSON.parse(JSON.stringify(queued.sourceSnapshot));
      source.tools.calls['tool-1'].toolCallId = 'tool-1';
      source.resourceBudget.reservations['backup-1'].state = 'released';
      source.resourceBudget.reservations.busy = {
        version: 1,
        reservationId: 'busy',
        runId: 'run-1',
        invocationId: 'another-child',
        resourceKind: 'subagent',
        executableUpperBound: usage(0, 0, 0, 0, 1),
        state: 'reserved',
      };
      source.resourceBudget.budget = { maxConcurrencyWaitMs: 20, maxConcurrentSubagents: 1 };
      source.resourceBudget.reconciledUsage = usage(0, 0, 0, 0, 0);
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('parent',27,'test',2,?,0,'checksum',30)`).run(JSON.stringify(source));
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'");
      const release = {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        submissionId: 'submission-1',
        reason: 'capacity_timeout' as const,
        createdAtMs: 30,
        sourceRevision: 2,
        sourceSnapshot: source,
        releaseEvent: { type: 'resource_budget.released', reservationId: 'backup-1' },
      };
      expect(() =>
        db.transaction(() =>
          releaseAcceptedCrossSessionFollowupBackupInTransaction(db, {
            ...release,
            createdAtMs: 29,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','acquired',1,27,?,20)`).run(
        JSON.stringify({ type: 'resource_budget.child_slot_acquired', reservationId: 'backup-1' }),
      );
      expect(() =>
        db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("DELETE FROM runtime_events WHERE event_id='acquired'");
      const withoutSlot = structuredClone(source);
      delete withoutSlot.resourceBudget.reservations.busy;
      db.query(
        "UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent' AND revision=2",
      ).run(JSON.stringify(withoutSlot));
      expect(() =>
        db.transaction(() =>
          releaseAcceptedCrossSessionFollowupBackupInTransaction(db, {
            ...release,
            sourceSnapshot: withoutSlot,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query(
        "UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent' AND revision=2",
      ).run(JSON.stringify(source));
      db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms,started_at_ms)
        VALUES ('child','unexpected-followup','followup:submission-1','building','running',2,2,30,30)`).run();
      expect(() =>
        db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("DELETE FROM runtime_runs WHERE session_id='child' AND run_id='unexpected-followup'");
      db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))();
      db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))();
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'run-1', 'child')).toEqual({
        submissionId: 'submission-1',
        status: 'failed',
        reason: 'capacity_timeout',
        sourceRevision: 2,
      });
    } finally {
      db.close();
    }
  });
  test('stamps accepted-only source cancellation in the canonical release transaction', () => {
    const { db, input } = fixture();
    try {
      db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
      const source = structuredClone(input.sourceSnapshot);
      source.resourceBudget.reservations['backup-1'].state = 'released';
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('parent',27,'test',2,?,0,'checksum',2)`).run(JSON.stringify(source));
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'");
      db.query(`UPDATE runtime_runs SET status='cancelled',finished_at_ms=30,terminal_json='{}'
        WHERE session_id='parent' AND run_id='run-1'`).run();
      const events = [
        { type: 'resource_budget.released', reservationId: 'backup-1' },
        { type: 'turn.aborted', turnId: 'turn-1', cause: 'user', reason: 'stop' },
      ];
      const settle = (committed: typeof events) =>
        db.transaction(() =>
          settleCancelledAcceptedFollowupsInTransaction(db, {
            sourceSessionId: 'parent',
            sourceRevision: 2,
            sourceSnapshot: source,
            events: committed,
          }),
        )();
      expect(settle([events[1]!])).toEqual([]);
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'run-1', 'child')).toBeNull();
      expect(settle(events)).toEqual([{ submissionId: 'submission-1', targetSessionId: 'child' }]);
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'run-1', 'child')).toEqual({
        submissionId: 'submission-1',
        status: 'failed',
        reason: 'source_cancelled',
        sourceRevision: 2,
      });
      expect(listPendingCrossSessionFollowupFunding(db, 'parent', 10)).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('closes a started but unfunded prepared target only after exact unattempted expiry terminal', () => {
    const { db, input } = fixture();
    try {
      db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
      const source = structuredClone(input.sourceSnapshot);
      Object.assign(source.tools.calls['tool-1'], { toolCallId: 'tool-1' });
      source.resourceBudget.reservations['backup-1'].state = 'released';
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('parent',27,'test',2,?,0,'checksum',2)`).run(JSON.stringify(source));
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'");
      db.query(
        `UPDATE runtime_runs SET status='completed',finished_at_ms=20 WHERE session_id='child'`,
      ).run();
      db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms,started_at_ms,finished_at_ms,terminal_json)
        VALUES ('child','followup-run','followup:submission-1','building','failed',2,2,20,20,90000,'{}')`).run();
      const target = {
        turn: { turnId: 'followup-run', status: 'aborted', abortCause: 'error' },
        activeFollowupTurn: {
          sourceSessionId: 'parent',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          taskId: 'followup-task',
        },
        resourceBudget: {
          runId: 'followup-run',
          reservations: {
            'local-model': {
              reservationId: 'local-model',
              runId: 'followup-run',
              resourceKind: 'model',
              state: 'released',
            },
          },
        },
        modelInvocations: {
          'target-model': {
            invocationId: 'target-model',
            purpose: 'primary_agent',
            status: 'prepared',
            attempts: 0,
            budget: { kind: 'reservation', reservationId: 'local-model' },
          },
        },
      };
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('child',27,'test',2,?,0,'checksum',90000)`).run(JSON.stringify(target));
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='child'");
      const reason = CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED;
      const events = [
        {
          type: 'agent.followup_turn_prepared',
          sourceSessionId: 'parent',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          taskId: 'followup-task',
        },
        {
          type: 'model.invocation_prepared',
          invocationId: 'target-model',
          purpose: 'primary_agent',
          budget: { kind: 'reservation', reservationId: 'local-model' },
        },
        {
          type: 'resource_budget.released',
          reservationId: 'local-model',
          proof: 'local_pre_dispatch_failure',
        },
        { type: 'task.failed', taskId: 'followup-task', reason },
        { type: 'turn.aborted', turnId: 'followup-run', cause: 'error', reason },
        { type: 'run.error', turnId: 'followup-run', message: reason },
      ];
      const insert =
        db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child',?,?,27,?,90000)`);
      for (let i = 0; i < events.length; i++)
        insert.run(`expiry-${i}`, i, JSON.stringify(events[i]));
      const release = {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        submissionId: 'submission-1',
        reason: 'expired' as const,
        createdAtMs: 90000,
        sourceRevision: 2,
        sourceSnapshot: source,
        releaseEvent: { type: 'resource_budget.released', reservationId: 'backup-1' },
      };
      db.query("UPDATE runtime_events SET event_json=? WHERE event_id='expiry-5'").run(
        JSON.stringify({ type: 'run.error', turnId: 'followup-run', message: 'another error' }),
      );
      expect(() =>
        db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query("UPDATE runtime_events SET event_json=? WHERE event_id='expiry-5'").run(
        JSON.stringify(events[5]),
      );
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child','attempt',6,27,?,90000)`).run(
        JSON.stringify({ type: 'model.invocation_attempt_started', invocationId: 'target-model' }),
      );
      expect(() =>
        db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("DELETE FROM runtime_events WHERE event_id='attempt'");
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child','dispatch',6,27,?,90000)`).run(
        JSON.stringify({ type: 'resource_budget.dispatch_started', reservationId: 'local-model' }),
      );
      expect(() =>
        db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("DELETE FROM runtime_events WHERE event_id='dispatch'");
      db.run("UPDATE runtime_sessions SET parent_session_id=NULL WHERE session_id='child'");
      expect(() =>
        db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id='child'");
      db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, release))();
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('parent','backup-released',0,27,?,90000)`).run(
        JSON.stringify(release.releaseEvent),
      );
      expect(
        readProvenUnfundedExpiredFollowupRelease(db, 'parent', 'child', 'submission-1'),
      ).toEqual({ targetRunId: 'followup-run' });
      db.run(
        "INSERT INTO runtime_effect_leases(session_id,effect_id,owner_id,lease_revision,certainty,expires_at_ms,controller_generation,host_instance_id,connection_generation,state,updated_at) VALUES ('child','model-effect','owner',1,'certain',90001,1,'host',0,'prepared',90000)",
      );
      expect(
        readProvenUnfundedExpiredFollowupRelease(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.run("DELETE FROM runtime_effect_leases WHERE session_id='child'");
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('child','late-attempt',6,27,?,90000)`).run(
        JSON.stringify({ type: 'model.invocation_attempt_started', invocationId: 'target-model' }),
      );
      expect(
        readProvenUnfundedExpiredFollowupRelease(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.run("DELETE FROM runtime_events WHERE event_id='late-attempt'");
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'run-1', 'child')?.reason).toBe(
        'expired',
      );
      expect(listPendingCrossSessionFollowupFunding(db, 'parent', 10)).toEqual([]);
    } finally {
      db.close();
    }
  });
  test.each([
    ['expired', 90_000],
    ['context_unavailable', 30],
    ['authorization_changed', 30],
  ] as const)('settles accepted-only %s with a persisted reason and no target Run', (reason, at) => {
    const { db, input } = fixture();
    try {
      db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
      const source = structuredClone(input.sourceSnapshot);
      Object.assign(source.tools.calls['tool-1'], { toolCallId: 'tool-1' });
      source.resourceBudget.reservations['backup-1'].state = 'released';
      if (reason === 'authorization_changed') source.mode = 'auto';
      if (reason === 'context_unavailable')
        db.run("UPDATE agent_nodes SET status='context_unavailable' WHERE session_id='child'");
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('parent',27,'test',2,?,0,'checksum',2)`).run(JSON.stringify(source));
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'");
      const intent = {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        submissionId: 'submission-1',
        reason,
        createdAtMs: at,
        sourceRevision: 2,
        sourceSnapshot: source,
        releaseEvent: { type: 'resource_budget.released', reservationId: 'backup-1' },
      };
      expect(() =>
        db.transaction(() =>
          releaseAcceptedCrossSessionFollowupBackupInTransaction(db, {
            ...intent,
            createdAtMs: reason === 'expired' ? 30 : at,
            reason:
              reason === 'context_unavailable'
                ? 'authorization_changed'
                : reason === 'authorization_changed'
                  ? 'context_unavailable'
                  : reason,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, intent))();
      db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, intent))();
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'run-1', 'child')).toEqual({
        submissionId: 'submission-1',
        status: 'failed',
        reason,
        sourceRevision: 2,
      });
      expect(readLastFollowupOutcomeForDirectChild(db, 'parent', 'run-1', 'child')).toEqual({
        submissionId: 'submission-1',
        status: 'failed',
        reason,
        sourceRevision: 2,
      });
      expect(listPendingCrossSessionFollowupFunding(db, 'parent', 10)).toEqual([]);
      expect(
        db
          .query<{ count: number }, []>(
            "SELECT count(*) AS count FROM runtime_runs WHERE start_command_id='followup:submission-1'",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
  test('releases an accepted-only failed Tool backup once and closes target admission', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kite-followup-release-'));
    const path = join(directory, 'kite.sqlite');
    const initial = fixture(path);
    let db = initial.db;
    const input = initial.input;
    try {
      db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
      const failedSnapshot = {
        ...input.sourceSnapshot,
        tools: {
          calls: {
            'tool-1': {
              ...input.sourceSnapshot.tools.calls['tool-1'],
              toolCallId: 'tool-1',
              status: 'failed',
            },
          },
        },
        capabilities: {
          ...input.sourceSnapshot.capabilities,
          invocations: {
            'invocation-1': {
              ...input.sourceSnapshot.capabilities.invocations['invocation-1'],
              status: 'failed',
            },
          },
        },
        resourceBudget: {
          ...input.sourceSnapshot.resourceBudget,
          reservations: {
            'backup-1': {
              ...input.sourceSnapshot.resourceBudget.reservations['backup-1'],
              state: 'released',
            },
          },
        },
      };
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('parent',27,'test',2,?,0,'checksum',2)`).run(JSON.stringify(failedSnapshot));
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'");
      const intent = {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        submissionId: 'submission-1',
        reason: 'tool_failed' as const,
        createdAtMs: 30,
        sourceRevision: 2,
        sourceSnapshot: failedSnapshot,
        releaseEvent: { type: 'resource_budget.released', reservationId: 'backup-1' },
      };
      expect(() =>
        db.transaction(() =>
          releaseAcceptedCrossSessionFollowupBackupInTransaction(db, {
            ...intent,
            releaseEvent: { ...intent.releaseEvent, reservationId: 'wrong' },
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms,started_at_ms)
        VALUES ('child','followup-run','followup:submission-1','building','running',2,2,2,2)`).run();
      expect(() =>
        db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, intent))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("DELETE FROM runtime_runs WHERE run_id='followup-run'");
      expect(readDirectChildFollowupReleaseWatermark(db, 'parent', 'run-1')).toEqual({
        count: 0,
        throughRevision: 0,
      });
      db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, intent))();
      db.transaction(() => releaseAcceptedCrossSessionFollowupBackupInTransaction(db, intent))();
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'run-1', 'child')).toEqual({
        submissionId: 'submission-1',
        status: 'failed',
        reason: 'tool_failed',
        sourceRevision: 2,
      });
      expect(readDirectChildFollowupReleaseWatermark(db, 'parent', 'run-1')).toEqual({
        count: 1,
        throughRevision: 2,
      });
      expect(readLastFollowupOutcomeForDirectChild(db, 'parent', 'run-1', 'child')).toEqual({
        submissionId: 'submission-1',
        status: 'failed',
        reason: 'tool_failed',
        sourceRevision: 2,
      });
      expect(readDirectChildFollowupOutcomeWatermark(db, 'parent', 'run-1')).toEqual({
        count: 1,
        throughRevision: 2,
      });
      expect(
        readCrossSessionFollowupDeliveryForTarget(db, 'child', 'parent', 'submission-1'),
      ).toBeNull();
      expect(listPendingCrossSessionFollowupFunding(db, 'parent', 10)).toEqual([]);
      expect(listPendingCrossSessionFollowupSources(db, 10)).toEqual([]);
      expect(
        readCrossSessionFollowupAdmissionBySubmissionForTarget(
          db,
          'child',
          'parent',
          'submission-1',
        ),
      ).toBeNull();
      db.close();
      db = new Database(path, { strict: true });
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'run-1', 'child')).toEqual({
        submissionId: 'submission-1',
        status: 'failed',
        reason: 'tool_failed',
        sourceRevision: 2,
      });
      expect(listPendingCrossSessionFollowupFunding(db, 'parent', 10)).toEqual([]);
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'other-run', 'child')).toBeNull();
      db.run("UPDATE runtime_sessions SET parent_session_id=NULL WHERE session_id='child'");
      expect(readLastReleasedFollowupForDirectChild(db, 'parent', 'run-1', 'child')).toBeNull();
      expect(readDirectChildFollowupReleaseWatermark(db, 'parent', 'run-1')).toEqual({
        count: 0,
        throughRevision: 0,
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test('target receives the exact TriggerTurn outbox once without copying its body', () => {
    const { db, input } = fixture();
    try {
      db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
      const pending = readCrossSessionFollowupDeliveryForTarget(
        db,
        'child',
        'parent',
        'submission-1',
      );
      expect(pending).toMatchObject({
        status: 'pending',
        messageId: 'mail-1',
        sequence: 1,
        bodyDigest: input.acceptedEvent.bodyDigest,
        followupAdmissionDigest: input.admission.digest,
      });
      expect(JSON.stringify(pending)).not.toContain(input.bodyText);
      expect(readCrossSessionFollowupDeliveryForTarget(db, 'child', 'parent', 'wrong')).toBeNull();
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='child'");
      expect(() =>
        db.transaction(() =>
          receiveCrossSessionFollowupInTransaction(db, {
            targetSessionId: 'child',
            sourceSessionId: 'parent',
            messageId: 'mail-1',
            submissionId: 'wrong',
            targetRevision: 2,
            receivedAtMs: 20,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail_inbox').get()
          ?.count,
      ).toBe(0);
      const received = db.transaction(() =>
        receiveCrossSessionFollowupInTransaction(db, {
          targetSessionId: 'child',
          sourceSessionId: 'parent',
          messageId: 'mail-1',
          submissionId: 'submission-1',
          targetRevision: 2,
          receivedAtMs: 20,
        }),
      )();
      expect(received).toEqual({ sequence: 1, targetRevision: 2 });
      expect(
        readCrossSessionFollowupDeliveryForTarget(db, 'child', 'parent', 'submission-1'),
      ).toEqual({ status: 'received', messageId: 'mail-1', sequence: 1, targetRevision: 2 });
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail_inbox').get()
          ?.count,
      ).toBe(1);
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail_bodies').get()
          ?.count,
      ).toBe(1);
      expect(
        db.transaction(() =>
          receiveCrossSessionFollowupInTransaction(db, {
            targetSessionId: 'child',
            sourceSessionId: 'parent',
            messageId: 'mail-1',
            submissionId: 'submission-1',
            targetRevision: 3,
            receivedAtMs: 21,
          }),
        )(),
      ).toEqual(received);
      db.run("UPDATE runtime_sessions SET parent_session_id=NULL WHERE session_id='child'");
      expect(
        readCrossSessionFollowupDeliveryForTarget(db, 'child', 'parent', 'submission-1'),
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  test('accepts one Artifact, receipt and outbox identity; exact retry replays', () => {
    const { db, input } = fixture();
    try {
      const accepted = db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('parent',27,'test',1,?,0,'checksum',1)`).run(JSON.stringify(input.sourceSnapshot));
      expect(accepted.submissionId).toBe('submission-1');
      expect(listPendingCrossSessionFollowupSources(db, 100)).toEqual(['parent']);
      expect(listPendingCrossSessionFollowupFunding(db, 'parent', 100)).toEqual([
        {
          submissionId: 'submission-1',
          messageId: 'mail-1',
          targetSessionId: 'child',
          stage: 'accepted',
          fundingRunId: 'run-1',
          reservationIds: ['backup-1'],
          targetRunId: null,
          modelInvocationId: null,
          backupReservationId: 'backup-1',
          turnReservationId: null,
          modelReservationId: null,
        },
      ]);
      expect(accepted.backupReservationId).toBe('backup-1');
      expect(db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))()).toEqual(
        accepted,
      );
      db.run(
        "UPDATE runtime_runs SET status='completed',finished_at_ms=20 WHERE session_id='parent' AND run_id='run-1'",
      );
      expect(
        db.transaction(() =>
          acceptCrossSessionFollowupInTransaction(db, {
            ...input,
            sourceSnapshot: {},
          }),
        )(),
      ).toEqual(accepted);
      expect(
        db
          .query<{ mode: string; submission_id: string }, []>(
            'SELECT mode,submission_id FROM agent_mail_outbox',
          )
          .all(),
      ).toEqual([{ mode: 'trigger_turn', submission_id: 'submission-1' }]);
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail_bodies').get()
          ?.count,
      ).toBe(1);
      expect(
        db
          .query<{ count: number }, []>(
            'SELECT count(*) AS count FROM agent_followup_admission_artifacts',
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  test('rejects wrong budget, target lineage, receipt and fault rollback', () => {
    const { db, input } = fixture();
    try {
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionFollowupInTransaction(db, {
            ...input,
            sourceSnapshot: {
              ...input.sourceSnapshot,
              resourceBudget: {
                ...input.sourceSnapshot.resourceBudget,
                reservations: {
                  'backup-1': { ...input.reservationEvent.reservation, state: 'unknown' },
                },
              },
            },
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      expect(() =>
        db.transaction(() => {
          acceptCrossSessionFollowupInTransaction(db, input);
          throw new Error('crash');
        })(),
      ).toThrow('crash');
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail_outbox').get()
          ?.count,
      ).toBe(0);
      expect(
        db
          .query<{ count: number }, []>(
            'SELECT count(*) AS count FROM agent_followup_admission_artifacts',
          )
          .get()?.count,
      ).toBe(0);
      db.run("UPDATE runtime_sessions SET parent_session_id=NULL WHERE session_id='child'");
      expect(() =>
        db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))(),
      ).toThrow();
      db.run("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id='child'");
      db.run("UPDATE runtime_command_receipts SET request_digest='f' || substr(request_digest,2)");
      expect(() =>
        db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))(),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  test('rejects an admission without exact prepared Tool evidence', () => {
    for (const change of [
      (tool: Record<string, unknown>) => delete tool.argumentsDigest,
      (tool: Record<string, unknown>) => {
        tool.bindingId = 'forged-binding';
      },
      (tool: Record<string, unknown>) => {
        tool.capabilityId = 'mcp:forged-followup';
      },
      (tool: Record<string, unknown>) => {
        tool.authorizationKind = 'unverified';
      },
    ]) {
      const { db, input } = fixture();
      try {
        const payload = JSON.parse(input.admission.canonicalJson);
        change(payload.preparedTool);
        const canonicalJson = JSON.stringify(payload);
        const hex = createHash('sha256').update(canonicalJson).digest('hex');
        const ref = {
          ...input.admission.ref,
          artifactId: `pa_${hex}`,
          integrityIdentifier: `sha256:${hex}`,
          byteLength: Buffer.byteLength(canonicalJson),
        };
        expect(() =>
          db.transaction(() =>
            acceptCrossSessionFollowupInTransaction(db, {
              ...input,
              admission: {
                ...input.admission,
                ref,
                digest: ref.integrityIdentifier,
                canonicalJson,
              },
              acceptedEvent: {
                ...input.acceptedEvent,
                followupAdmissionRef: ref,
                followupAdmissionDigest: ref.integrityIdentifier,
              },
            }),
          )(),
        ).toThrow(KiteCrossSessionFollowupError);
        expect(
          db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail_outbox').get()
            ?.count,
        ).toBe(0);
      } finally {
        db.close();
      }
    }
  });
});

test('new child Run rejects old grant and replays committed funding after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-followup-restart-'));
  const path = join(directory, 'kite.sqlite');
  const initial = fixture(path);
  let db = initial.db;
  const input = initial.input;
  try {
    input.reservationEvent.reservation.state = 'queued';
    input.sourceSnapshot.resourceBudget.reservations['backup-1'].state = 'queued';
    db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES ('parent','queued-backup',0,27,?,10)`).run(JSON.stringify(input.reservationEvent));
    db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
    db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='child'");
    db.transaction(() =>
      receiveCrossSessionQueueMailInTransaction(db, {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        messageId: 'mail-1',
        targetRevision: 2,
        receivedAtMs: 20,
      }),
    )();
    expect(
      readCrossSessionFollowupAdmissionBySubmissionForTarget(db, 'child', 'parent', 'submission-1')
        ?.messageId,
    ).toBe('mail-1');
    expect(
      readUnroutedCrossSessionFollowupMessage(db, 'child', 'parent', 'submission-1', 'mail-1'),
    ).toMatchObject({
      bodyText: 'hello child',
      admissionDigest: input.admission.digest,
      oldTargetRunId: 'child-run',
      sequence: 1,
    });
    const checkpointJson = JSON.stringify({
      artifactFormatVersion: 1,
      childSessionId: 'child',
      terminalRunId: 'child-run',
      terminalTaskId: 'child-task-old',
      terminalRevision: 2,
      terminalStatus: 'completed',
      stateDigest: 'old',
      transcriptDigest: 'old',
      transcript: { messages: [], final: 'old' },
    });
    const checkpointHex = createHash('sha256').update(checkpointJson).digest('hex');
    const checkpointRef = {
      artifactId: `pa_${checkpointHex}`,
      kind: 'subagent_checkpoint' as const,
      integrityIdentifier: `sha256:${checkpointHex}`,
      byteLength: Buffer.byteLength(checkpointJson),
    };
    createKiteHomeArtifactStore(db).writeSubagentCheckpoint({
      ref: checkpointRef,
      artifactFormatVersion: 1,
      canonicalJson: checkpointJson,
      createdAt: 2,
    });
    db.query(`UPDATE agent_nodes SET status='active',current_task_id='followup-run',
      latest_checkpoint_artifact_id=?,latest_checkpoint_integrity_identifier=?,
      latest_checkpoint_byte_length=? WHERE session_id='child'`).run(
      checkpointRef.artifactId,
      checkpointRef.integrityIdentifier,
      checkpointRef.byteLength,
    );
    db.run(
      "UPDATE runtime_runs SET status='completed',finished_at_ms=21,last_revision=2 WHERE session_id='child'",
    );
    db.run("UPDATE runtime_sessions SET revision=3 WHERE session_id='child'");
    db.run(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
      created_revision,last_revision,created_at_ms)
      VALUES ('child','followup-run','followup:submission-1','building','queued',3,3,30)`);
    db.query(`INSERT INTO subagent_task_artifacts(artifact_id,kind,integrity_identifier,
      artifact_format_version,canonical_json,byte_length,created_at)
      VALUES (?,'subagent_task',?,1,'{}',2,1)`).run(
      `pa_${'1'.repeat(64)}`,
      `sha256:${'1'.repeat(64)}`,
    );
    db.query(`INSERT INTO child_session_intents(child_thread_id,parent_session_id,parent_invocation_id,
      origin_run_id,origin_turn_id,origin_tool_call_id,attempt,child_invocation_id,grant_digest,
      sealed_grant_json,sealed_grant_byte_length,sealed_grant_digest,task_artifact_digest,
      task_text_digest,task_artifact_id,task_artifact_byte_length,disposition,role,tool_event_id,
      tool_event_revision,funding_run_id,delegated_reservation_id,delegated_upper_bound_digest,
      delegated_upper_bound_json,deadline_at)
      VALUES ('child','parent','original-invocation','run-1','turn-1','spawn-tool',1,
      'child-task-old',?,'{}',2,'sealed','task','text',?,2,'required','code','event',1,
      'run-1','delegated','upper','{}','2099-01-01T00:00:00.000Z')`).run(
      'old-grant',
      `pa_${'1'.repeat(64)}`,
    );
    const budget = childBudget();
    const grantJson = JSON.stringify({
      schema: 'kite.child-followup-grant.v1',
      sourceSessionId: 'parent',
      targetSessionId: 'child',
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      taskId: 'followup-task',
      checkpointRef,
      originRole: 'code',
      workspaceDigest: `sha256:${'b'.repeat(64)}`,
      interactionModeRevision: 1,
      capabilityDigest: 'catalog-1',
      phaseCeiling: 'building',
      sourceAdmissionRef: input.admission.ref,
      sourceAdmissionDigest: input.admission.digest,
      denyTools: true,
      allowedTools: [],
      budget: { ...budget, deadlineAt: new Date(80_000).toISOString() },
      firstAttemptTimeoutMs: 1_000,
    });
    const grantHex = createHash('sha256').update(grantJson).digest('hex');
    const grantRef = {
      artifactId: `pa_${grantHex}`,
      kind: 'agent_followup_grant' as const,
      integrityIdentifier: `sha256:${grantHex}`,
      byteLength: Buffer.byteLength(grantJson),
    };
    const mutation = {
      sourceSessionId: 'parent',
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      phase: 'building' as const,
      taskId: 'followup-task',
      checkpointRef,
      grantDigest: grantRef.integrityIdentifier,
      grant: { ref: grantRef, canonicalJson: grantJson, createdAt: 30 },
    };
    const preparedEvent = {
      type: 'agent.followup_turn_prepared',
      sourceSessionId: 'parent',
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      taskId: 'followup-task',
      checkpointRef,
      grantRef,
      grantDigest: grantRef.integrityIdentifier,
    };
    const targetState = {
      revision: 3,
      session: { canonicalWorkspaceDigest: `sha256:${'b'.repeat(64)}` },
      childSessionOrigin: {
        role: 'code',
        parentSessionId: 'parent',
        childInvocationId: 'child-task-old',
        terminal: { status: 'completed' },
      },
      activeFollowupTurn: {
        sourceSessionId: 'parent',
        submissionId: 'submission-1',
        targetRunId: 'followup-run',
        taskId: 'followup-task',
        checkpointRef,
        grantRef,
        grantDigest: grantRef.integrityIdentifier,
      },
      interactionModeRevision: 1,
      capabilities: { catalogRevision: 'catalog-1' },
      mode: 'accept_edits',
      workspaceAccess: 'workspace_only',
      resourceBudget: { status: 'active', runId: 'followup-run', budget },
    };
    db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
      state_json,event_position,state_checksum,created_at)
      VALUES ('child',27,'test',3,?,0,'checksum',3)`).run(JSON.stringify(targetState));
    db.query("UPDATE child_session_intents SET grant_digest=? WHERE child_thread_id='child'").run(
      grantRef.integrityIdentifier,
    );
    expect(() =>
      db.transaction(() =>
        assertCrossSessionFollowupRunStartInTransaction(db, {
          targetSessionId: 'child',
          mutation,
          preparedEvent,
        }),
      )(),
    ).toThrow(KiteCrossSessionFollowupError);
    db.run(
      "UPDATE child_session_intents SET grant_digest='old-grant' WHERE child_thread_id='child'",
    );
    db.transaction(() =>
      assertCrossSessionFollowupRunStartInTransaction(db, {
        targetSessionId: 'child',
        mutation,
        preparedEvent,
      }),
    )();
    expect(readCrossSessionFollowupGrant(db, grantRef.artifactId)?.canonicalJson).toBe(grantJson);
    db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES ('child','followup-prepared',3,27,?,30)`).run(JSON.stringify(preparedEvent));
    db.run(
      "UPDATE runtime_runs SET status='running',started_at_ms=31,last_revision=4 WHERE session_id='child' AND run_id='followup-run'",
    );
    const modelSurfaceJson = JSON.stringify({ surface: 'followup' });
    const modelSurface = modelRef('model_surface', modelSurfaceJson);
    createKiteHomeArtifactStore(db).writeModel({
      ref: modelSurface,
      artifactFormatVersion: 1,
      canonicalJson: modelSurfaceJson,
      createdAt: 32,
    });
    const localReservation = {
      reservationId: 'local-model-next',
      runId: 'followup-run',
      invocationId: 'model-invocation:model-next',
      resourceKind: 'model',
      state: 'reserved',
      executableUpperBound: usage(0, 1, 80, 10, 0),
    };
    const preparedState = {
      ...targetState,
      revision: 5,
      modelInvocations: {
        'model-next': {
          invocationId: 'model-next',
          status: 'prepared',
          attempts: 0,
          estimatedInputTokens: 40,
          surfaceIntegrityIdentifier: modelSurface.integrityIdentifier,
          budget: {
            kind: 'reservation',
            reservationId: 'local-model-next',
            parentReservationId: null,
          },
          surfaceArtifact: modelSurface,
        },
      },
      resourceBudget: {
        ...targetState.resourceBudget,
        reservations: { 'local-model-next': localReservation },
      },
    };
    db.run("UPDATE runtime_sessions SET revision=5 WHERE session_id='child'");
    db.query("UPDATE runtime_snapshots SET revision=5,state_json=? WHERE session_id='child'").run(
      JSON.stringify(preparedState),
    );
    const backup = input.reservationEvent.reservation;
    const sourceTurnHeld = {
      version: 1,
      reservationId: 'source-turn',
      runId: 'run-1',
      invocationId: 'followup-turn:model-next',
      replacesReservationId: 'backup-1',
      resourceKind: 'subagent',
      executableUpperBound: usage(1, 0, 0, 0, 1),
      state: 'reserved',
    };
    const sourceModelHeld = {
      version: 1,
      reservationId: 'source-model',
      runId: 'run-1',
      invocationId: 'model-invocation:model-next',
      parentReservationId: 'source-turn',
      replacesReservationId: 'backup-1',
      resourceKind: 'model',
      executableUpperBound: usage(0, 1, 80, 10, 0),
      state: 'reserved',
    };
    const replacementInput = {
      sourceSessionId: 'parent',
      targetSessionId: 'child',
      messageId: 'mail-1',
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      modelInvocationId: 'model-next',
      targetRevision: 5,
      surfaceArtifact: modelSurface,
      surfaceInputTokens: 40,
      surfaceMaxOutputTokens: 10,
      sourceRevision: 1,
      createdAtMs: 33,
      replacementEvent: {
        type: 'resource_budget.bounded_replaced',
        reservationId: 'backup-1',
        turnReservation: sourceTurnHeld,
        replacement: sourceModelHeld,
      },
      sourceSnapshot: {
        resourceBudget: {
          status: 'active',
          runId: 'run-1',
          reservations: {
            'backup-1': { ...backup, state: 'released' },
            'source-turn': sourceTurnHeld,
            'source-model': sourceModelHeld,
          },
        },
      },
    };
    expect(() =>
      db.transaction(() => replaceCrossSessionFollowupBackupInTransaction(db, replacementInput))(),
    ).toThrow(KiteCrossSessionFollowupError);
    db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES ('parent','acquired-backup',1,27,?,32)`).run(
      JSON.stringify({ type: 'resource_budget.child_slot_acquired', reservationId: 'backup-1' }),
    );
    expect(() =>
      db.transaction(() => {
        replaceCrossSessionFollowupBackupInTransaction(db, replacementInput);
        throw new Error('crash before route');
      })(),
    ).toThrow('crash before route');
    expect(readCrossSessionFollowupFundingReceipt(db, 'parent', 'submission-1')).toBeNull();
    const funding = db.transaction(() =>
      replaceCrossSessionFollowupBackupInTransaction(db, replacementInput),
    )();
    expect(funding.targetModelReservationId).toBe('local-model-next');
    db.close(false);
    db = new Database(path, { strict: true });
    expect(readCrossSessionFollowupFundingReceipt(db, 'parent', 'submission-1')).toEqual(funding);
    const preparedMailEvent = {
      type: 'agent.mail_input_prepared',
      targetAgentId: 'child',
      invocationId: 'model-next',
      modelAdmissionId: 'local-model-next',
      fromSequence: 0,
      throughSequence: 1,
      messageIds: ['mail-1'],
    };
    db.run("UPDATE runtime_sessions SET revision=6 WHERE session_id='child'");
    const routed = db.transaction(() =>
      routeCrossSessionFollowupInTransaction(db, {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        messageId: 'mail-1',
        submissionId: 'submission-1',
        route: 'new_turn',
        targetRunId: 'followup-run',
        taskId: 'followup-task',
        invocationId: 'model-next',
        modelAdmissionId: 'local-model-next',
        reservationId: 'local-model-next',
        routedRevision: 6,
        createdAtMs: 35,
        targetSnapshot: preparedState,
        routedEvent: {
          type: 'agent.followup_routed',
          submissionId: 'submission-1',
          targetAgentId: 'child',
          route: 'new_turn',
          taskId: 'followup-task',
          invocationId: 'model-next',
          modelAdmissionId: 'local-model-next',
          reservationId: 'local-model-next',
          fundingRunId: 'run-1',
          sequence: 1,
        },
        preparedEvent: preparedMailEvent,
      }),
    )();
    expect(routed.route).toBe('new_turn');
    expect(
      readUnroutedCrossSessionFollowupMessage(db, 'child', 'parent', 'submission-1', 'mail-1'),
    ).toBeNull();
    expect(
      db
        .query<{ target_run_id: string; prepared_invocation_id: string }, []>(
          "SELECT target_run_id,prepared_invocation_id FROM agent_mail_inbox WHERE target_session_id='child'",
        )
        .get(),
    ).toEqual({ target_run_id: 'followup-run', prepared_invocation_id: 'model-next' });
    expect(
      readPreparedCrossSessionFollowupRecoveryProof(db, 'child', 'parent', 'submission-1'),
    ).toBeNull();
    const sourceTurn = {
      version: 1,
      reservationId: 'source-turn',
      runId: 'run-1',
      invocationId: 'followup-turn:model-next',
      resourceKind: 'subagent',
      executableUpperBound: usage(1, 0, 0, 0, 1),
      state: 'dispatch_started',
    };
    const sourceModel = {
      version: 1,
      reservationId: 'source-model',
      runId: 'run-1',
      invocationId: 'model-invocation:model-next',
      resourceKind: 'model',
      executableUpperBound: usage(0, 1, 80, 10, 0),
      state: 'dispatch_started',
    };
    db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'");
    const activated = db.transaction(() =>
      activateCrossSessionFollowupFundingInTransaction(db, {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        submissionId: 'submission-1',
        targetRunId: 'followup-run',
        modelInvocationId: 'model-next',
        sourceRevision: 2,
        createdAtMs: 37,
        events: [
          { type: 'resource_budget.dispatch_started', reservationId: 'source-turn' },
          { type: 'resource_budget.dispatch_started', reservationId: 'source-model' },
        ],
        sourceSnapshot: {
          resourceBudget: {
            status: 'active',
            runId: 'run-1',
            reservations: {
              'source-turn': sourceTurn,
              'source-model': sourceModel,
            },
          },
        },
      }),
    )();
    expect(activated.targetRunId).toBe('followup-run');
    expect(readCrossSessionFollowupActivationReceipt(db, 'parent', 'submission-1')).toEqual(
      activated,
    );
    const routedState = { ...preparedState, revision: 6 };
    db.query("UPDATE runtime_snapshots SET revision=6,state_json=? WHERE session_id='child'").run(
      JSON.stringify(routedState),
    );
    const proof = readPreparedCrossSessionFollowupRecoveryProof(
      db,
      'child',
      'parent',
      'submission-1',
    );
    expect(proof).toMatchObject({
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      invocationId: 'model-next',
      modelReservationId: 'local-model-next',
      preparedStateRevision: 6,
      surfaceDigest: modelSurface.integrityIdentifier,
      estimatedInputTokens: 40,
      activationSourceRevision: 2,
    });
    expect(
      readPreparedCrossSessionFollowupRecoveryProof(db, 'child', 'wrong-parent', 'submission-1'),
    ).toBeNull();
    db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES ('child','attempt-proof',99,27,?,38)`).run(
      JSON.stringify({ type: 'model.invocation_attempt_started', invocationId: 'model-next' }),
    );
    expect(
      readPreparedCrossSessionFollowupRecoveryProof(db, 'child', 'parent', 'submission-1'),
    ).toBeNull();
    db.run("DELETE FROM runtime_events WHERE event_id='attempt-proof'");
    db.query(`INSERT INTO runtime_effect_leases(session_id,effect_id,owner_id,lease_revision,
      certainty,expires_at_ms,controller_generation,host_instance_id,client_id,
      connection_generation,state,outcome,terminal_digest,updated_at)
      VALUES ('child','model-effect','owner',1,'certain',99,1,'host',NULL,1,'prepared',NULL,NULL,38)`).run();
    expect(
      readPreparedCrossSessionFollowupRecoveryProof(db, 'child', 'parent', 'submission-1'),
    ).toBeNull();
    db.run("DELETE FROM runtime_effect_leases WHERE session_id='child'");
    db.run(
      "UPDATE runtime_runs SET status='completed',finished_at_ms=40,last_revision=7 WHERE session_id='child' AND run_id='followup-run'",
    );
    db.run("UPDATE runtime_sessions SET revision=7 WHERE session_id='child'");
    db.run("UPDATE agent_nodes SET status='idle',current_task_id=NULL WHERE session_id='child'");
    const actual = usage(0, 1, 40, 8, 0);
    const turnActual = usage(1, 0, 0, 0, 1);
    const responseJson = JSON.stringify({ answer: 'new final' });
    const responseRef = modelRef('model_response', responseJson);
    createKiteHomeArtifactStore(db).writeModel({
      ref: responseRef,
      artifactFormatVersion: 1,
      canonicalJson: responseJson,
      createdAt: 40,
    });
    const transcript = {
      messages: [{ kind: 'assistant', modelInvocationId: 'model-next' }],
      final: 'new final',
    };
    const terminalState = {
      ...preparedState,
      revision: 7,
      activeFollowupTurn: undefined,
      terminalOutcome: { status: 'completed' },
      transcript,
      turn: { status: 'completed' },
      resourceBudget: {
        ...preparedState.resourceBudget,
        reservations: {
          'local-model-next': { ...localReservation, state: 'reconciled', actual },
        },
      },
      modelInvocations: {
        'model-next': {
          ...preparedState.modelInvocations['model-next'],
          status: 'completed',
          attempts: 1,
          responseArtifact: responseRef,
        },
      },
    };
    const stateJson = JSON.stringify(terminalState);
    db.query("UPDATE runtime_snapshots SET revision=7,state_json=? WHERE session_id='child'").run(
      stateJson,
    );
    const hash = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const nextCheckpointJson = JSON.stringify({
      artifactFormatVersion: 1,
      childSessionId: 'child',
      terminalRunId: 'followup-run',
      terminalTaskId: 'followup-task',
      submissionId: 'submission-1',
      terminalRevision: 7,
      terminalStatus: 'completed',
      stateDigest: hash(stateJson),
      transcriptDigest: hash(JSON.stringify(transcript)),
      transcript,
    });
    const nextHash = hash(nextCheckpointJson);
    const nextRef = {
      artifactId: `pa_${nextHash.slice(7)}`,
      kind: 'subagent_checkpoint' as const,
      integrityIdentifier: nextHash,
      byteLength: Buffer.byteLength(nextCheckpointJson),
    };
    const sealMutation = {
      ref: nextRef,
      canonicalJson: nextCheckpointJson,
      terminalRunId: 'followup-run',
      terminalTaskId: 'followup-task',
      submissionId: 'submission-1',
    };
    const sealEvent = {
      type: 'agent.followup_turn_settled',
      sourceSessionId: 'parent',
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      taskId: 'followup-task',
      status: 'completed',
    };
    const oldOnlyState = {
      ...terminalState,
      transcript: {
        messages: [{ kind: 'assistant', modelInvocationId: 'old-model' }],
        final: 'old final',
      },
      modelInvocations: {
        'model-next': {
          ...preparedState.modelInvocations['model-next'],
          status: 'prepared',
          attempts: 0,
        },
        'old-model': {
          invocationId: 'old-model',
          status: 'completed',
          attempts: 1,
          responseArtifact: responseRef,
        },
      },
    };
    const oldOnlyJson = JSON.stringify(oldOnlyState);
    const oldOnlyCheckpointJson = JSON.stringify({
      ...JSON.parse(nextCheckpointJson),
      stateDigest: hash(oldOnlyJson),
      transcriptDigest: hash(JSON.stringify(oldOnlyState.transcript)),
      transcript: oldOnlyState.transcript,
    });
    const oldOnlyHash = hash(oldOnlyCheckpointJson);
    db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(oldOnlyJson);
    expect(() =>
      db.transaction(() =>
        sealChildTerminalCheckpointInTransaction(db, {
          sessionId: 'child',
          revision: 7,
          mutation: {
            ...sealMutation,
            canonicalJson: oldOnlyCheckpointJson,
            ref: {
              artifactId: `pa_${oldOnlyHash.slice(7)}`,
              kind: 'subagent_checkpoint',
              integrityIdentifier: oldOnlyHash,
              byteLength: Buffer.byteLength(oldOnlyCheckpointJson),
            },
          },
          terminalEvent: sealEvent,
        }),
      )(),
    ).toThrow(KiteCrossSessionFollowupError);
    db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(stateJson);
    const staleJson = JSON.stringify({ childSessionId: 'child', terminalRevision: 2 });
    const staleHash = hash(staleJson);
    const staleRef = {
      artifactId: `pa_${staleHash.slice(7)}`,
      kind: 'subagent_checkpoint' as const,
      integrityIdentifier: staleHash,
      byteLength: Buffer.byteLength(staleJson),
    };
    createKiteHomeArtifactStore(db).writeSubagentCheckpoint({
      ref: staleRef,
      artifactFormatVersion: 1,
      canonicalJson: staleJson,
      createdAt: 2,
    });
    db.query(`UPDATE agent_nodes SET latest_checkpoint_artifact_id=?,
      latest_checkpoint_integrity_identifier=?,latest_checkpoint_byte_length=?
      WHERE session_id='child'`).run(
      staleRef.artifactId,
      staleRef.integrityIdentifier,
      staleRef.byteLength,
    );
    expect(() =>
      db.transaction(() =>
        sealChildTerminalCheckpointInTransaction(db, {
          sessionId: 'child',
          revision: 7,
          mutation: sealMutation,
          terminalEvent: sealEvent,
        }),
      )(),
    ).toThrow(KiteCrossSessionFollowupError);
    db.query(`UPDATE agent_nodes SET latest_checkpoint_artifact_id=?,
      latest_checkpoint_integrity_identifier=?,latest_checkpoint_byte_length=?
      WHERE session_id='child'`).run(
      checkpointRef.artifactId,
      checkpointRef.integrityIdentifier,
      checkpointRef.byteLength,
    );
    db.transaction(() =>
      sealChildTerminalCheckpointInTransaction(db, {
        sessionId: 'child',
        revision: 7,
        mutation: sealMutation,
        terminalEvent: sealEvent,
      }),
    )();
    expect(
      db
        .query<{ latest_checkpoint_artifact_id: string }, []>(
          "SELECT latest_checkpoint_artifact_id FROM agent_nodes WHERE session_id='child'",
        )
        .get()?.latest_checkpoint_artifact_id,
    ).toBe(nextRef.artifactId);
    expect(createKiteHomeArtifactStore(db).readSubagentCheckpoint(nextRef).canonicalJson).toBe(
      nextCheckpointJson,
    );
    db.run("UPDATE runtime_sessions SET revision=3 WHERE session_id='parent'");
    const settled = db.transaction(() =>
      settleCrossSessionFollowupFundingInTransaction(db, {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        submissionId: 'submission-1',
        targetRunId: 'followup-run',
        modelInvocationId: 'model-next',
        targetRevision: 7,
        disposition: 'completed',
        sourceRevision: 3,
        createdAtMs: 42,
        events: [
          { type: 'resource_budget.reconciled', reservationId: 'source-turn', actual: turnActual },
          { type: 'resource_budget.reconciled', reservationId: 'source-model', actual },
        ],
        sourceSnapshot: {
          resourceBudget: {
            status: 'active',
            runId: 'run-1',
            reservations: {
              'source-turn': { ...sourceTurn, state: 'reconciled', actual: turnActual },
              'source-model': { ...sourceModel, state: 'reconciled', actual },
            },
          },
        },
      }),
    )();
    expect(settled.disposition).toBe('completed');
    expect(readCrossSessionFollowupTerminalReceipt(db, 'parent', 'submission-1')).toEqual(settled);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function routedFixture(queuedBackup = false) {
  const { db, input } = fixture();
  if (queuedBackup) {
    input.reservationEvent.reservation.state = 'queued';
    input.sourceSnapshot.resourceBudget.reservations['backup-1'].state = 'queued';
    db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES ('parent','queued-backup',0,27,?,10)`).run(JSON.stringify(input.reservationEvent));
  }
  db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
  db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
    state_json,event_position,state_checksum,created_at)
    VALUES ('parent',27,'test',1,?,0,'checksum',1)`).run(JSON.stringify(input.sourceSnapshot));
  db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='child'");
  db.transaction(() =>
    receiveCrossSessionQueueMailInTransaction(db, {
      sourceSessionId: 'parent',
      targetSessionId: 'child',
      messageId: 'mail-1',
      targetRevision: 2,
      receivedAtMs: 20,
    }),
  )();
  db.run("UPDATE runtime_sessions SET revision=3 WHERE session_id='child'");
  const budget = childBudget();
  const budgetDigest = `sha256:${createHash('sha256').update(JSON.stringify(budget)).digest('hex')}`;
  db.query(`INSERT INTO agent_followup_funding_receipts(
    source_session_id,submission_id,target_session_id,message_id,funding_run_id,
    backup_reservation_id,turn_reservation_id,model_reservation_id,target_model_reservation_id,
    target_budget_digest,target_run_id,
    model_invocation_id,surface_artifact_id,surface_digest,surface_input_tokens,
    surface_max_output_tokens,target_revision,source_revision,created_at_ms)
    VALUES ('parent','submission-1','child','mail-1','run-1',
    'backup-1','turn-reserve-1','model-reserve-1','local-model-1',?,'child-run',
    'target-model',?,?,40,10,3,1,25)`).run(
    budgetDigest,
    `pa_${'1'.repeat(64)}`,
    `sha256:${'1'.repeat(64)}`,
  );
  const reservation = {
    version: 1,
    reservationId: 'local-model-1',
    runId: 'child-run',
    invocationId: 'model-invocation:target-model',
    resourceKind: 'model',
    state: 'reserved',
    executableUpperBound: {
      ...usage(0, 1, 80, 10, 0),
    },
  };
  const route = {
    sourceSessionId: 'parent',
    targetSessionId: 'child',
    messageId: 'mail-1',
    submissionId: 'submission-1',
    route: 'current_turn' as const,
    targetRunId: 'child-run',
    taskId: 'child-task',
    invocationId: 'target-model',
    modelAdmissionId: 'local-model-1',
    reservationId: 'local-model-1',
    routedRevision: 3,
    createdAtMs: 30,
    routedEvent: {
      type: 'agent.followup_routed',
      submissionId: 'submission-1',
      targetAgentId: 'child',
      route: 'current_turn',
      taskId: 'child-task',
      invocationId: 'target-model',
      modelAdmissionId: 'local-model-1',
      reservationId: 'local-model-1',
      fundingRunId: 'run-1',
      sequence: 1,
    },
    preparedEvent: {
      type: 'agent.mail_input_prepared',
      targetAgentId: 'child',
      invocationId: 'target-model',
      modelAdmissionId: 'local-model-1',
      fromSequence: 0,
      throughSequence: 1,
      messageIds: ['mail-1'],
    },
    targetSnapshot: {
      mode: 'accept_edits',
      workspaceAccess: 'workspace_only',
      modelInvocations: {
        'target-model': {
          invocationId: 'target-model',
          status: 'prepared',
          surfaceArtifact: {
            artifactId: `pa_${'1'.repeat(64)}`,
            kind: 'model_surface',
            integrityIdentifier: `sha256:${'1'.repeat(64)}`,
            byteLength: 1,
          },
          budget: {
            kind: 'reservation',
            reservationId: 'local-model-1',
            parentReservationId: null,
          },
        },
      },
      resourceBudget: {
        status: 'active',
        runId: 'child-run',
        budget,
        reservations: { 'local-model-1': reservation },
      },
    },
  };
  return { db, route };
}

describe('Store13 cross-Session TriggerTurn target route', () => {
  test('admits only an activated and acknowledged queued zero-Tool first child Run', () => {
    const { db, input } = fixture();
    try {
      const grant = sealChildGrantPayload({
        purpose: 'start',
        capabilityCeiling: { allowedTools: [], bindingIds: [] },
      });
      db.query(`INSERT INTO subagent_task_artifacts(artifact_id,kind,integrity_identifier,
        artifact_format_version,canonical_json,byte_length,created_at)
        VALUES (?,'subagent_task',?,1,'{}',2,1)`).run(
        `pa_${'2'.repeat(64)}`,
        `sha256:${'2'.repeat(64)}`,
      );
      db.query(`INSERT INTO child_session_intents(child_thread_id,parent_session_id,parent_invocation_id,
        origin_run_id,origin_turn_id,origin_tool_call_id,attempt,child_invocation_id,
        grant_digest,sealed_grant_json,sealed_grant_byte_length,sealed_grant_digest,
        task_artifact_digest,task_text_digest,task_artifact_id,task_artifact_byte_length,
        disposition,role,tool_event_id,tool_event_revision,funding_run_id,
        delegated_reservation_id,delegated_upper_bound_digest,delegated_upper_bound_json,deadline_at,
        child_budget_activated_run_id,dispatch_ack_event_id)
        VALUES ('child','parent','origin-inv','run-1','turn-1','spawn-tool',1,'child-task',
        ?,?,?,?,'task','text',?,2,'required','explore','event',1,'run-1','delegated',
        'upper','{}','2099-01-01T00:00:00.000Z','child-run','dispatch-ack')`).run(
        grant.sealedGrantDigest,
        grant.sealedGrantJson,
        grant.sealedGrantByteLength,
        grant.sealedGrantDigest,
        `pa_${'2'.repeat(64)}`,
      );
      db.query(`UPDATE runtime_runs SET status='queued',started_at_ms=NULL,
        origin_session_id='parent',origin_run_id='run-1'
        WHERE session_id='child' AND run_id='child-run'`).run();
      const state = {
        childSessionOrigin: {
          parentSessionId: 'parent',
          childInvocationId: 'child-task',
          grantDigest: grant.sealedGrantDigest,
        },
        activeTaskId: 'child-task',
        turn: { turnId: 'child-run', status: 'active' },
        resourceBudget: { status: 'active', runId: 'child-run' },
        modelInvocations: {},
      };
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('child',27,'test',1,?,0,'checksum',1)`).run(JSON.stringify(state));
      const admitted = () =>
        isAdmittedQueuedChildFollowupTarget(db, 'parent', 'child', 'child-run');
      expect(admitted()).toBe(true);
      const readGrant = sealChildGrantPayload({
        purpose: 'start',
        role: 'explore',
        capabilityCeiling: { allowedTools: ['read_file'], bindingIds: [] },
        authorization: { workspaceAccess: 'read' },
      });
      db.query(`UPDATE child_session_intents SET grant_digest=?,sealed_grant_json=?,
        sealed_grant_byte_length=?,sealed_grant_digest=? WHERE child_thread_id='child'`).run(
        readGrant.sealedGrantDigest,
        readGrant.sealedGrantJson,
        readGrant.sealedGrantByteLength,
        readGrant.sealedGrantDigest,
      );
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify({
          ...state,
          childSessionOrigin: {
            ...state.childSessionOrigin,
            grantDigest: readGrant.sealedGrantDigest,
          },
        }),
      );
      expect(admitted()).toBe(true);
      db.query(`UPDATE child_session_intents SET grant_digest=?,sealed_grant_json=?,
        sealed_grant_byte_length=?,sealed_grant_digest=? WHERE child_thread_id='child'`).run(
        grant.sealedGrantDigest,
        grant.sealedGrantJson,
        grant.sealedGrantByteLength,
        grant.sealedGrantDigest,
      );
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(state),
      );
      expect(isAdmittedQueuedChildFollowupTarget(db, 'parent', 'child', 'other-run')).toBe(false);
      const accepted = db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
      expect(accepted.outbox.targetRunId).toBe('child-run');
      db.transaction(() =>
        receiveCrossSessionFollowupInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          messageId: 'mail-1',
          submissionId: 'submission-1',
          targetRevision: 1,
          receivedAtMs: 11,
        }),
      )();
      expect(
        db
          .query<{ target_run_id: string }, []>(
            "SELECT target_run_id FROM agent_mail_inbox WHERE target_session_id='child' AND message_id='mail-1'",
          )
          .get()?.target_run_id,
      ).toBe('child-run');
      expect(isAdmittedQueuedChildFollowupTarget(db, 'other', 'child', 'child-run')).toBe(false);
      db.run(
        "UPDATE child_session_intents SET dispatch_ack_event_id=NULL WHERE child_thread_id='child'",
      );
      expect(admitted()).toBe(false);
      db.run(
        "UPDATE child_session_intents SET dispatch_ack_event_id='dispatch-ack' WHERE child_thread_id='child'",
      );
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('child','attempt',0,27,?,1)`).run(
        JSON.stringify({ type: 'model.invocation_attempt_started', invocationId: 'attempted' }),
      );
      expect(admitted()).toBe(false);
      db.run("DELETE FROM runtime_events WHERE session_id='child'");
      db.run("UPDATE runtime_runs SET status='running',started_at_ms=1 WHERE session_id='child'");
      expect(admitted()).toBe(false);
    } finally {
      db.close();
    }
  });
  test('routes a queued backup to a granted read_file old-Run Surface and releases it', () => {
    const { db, route } = routedFixture(true);
    try {
      db.run("DELETE FROM agent_followup_funding_receipts WHERE source_session_id='parent'");
      db.query(`INSERT INTO subagent_task_artifacts(artifact_id,kind,integrity_identifier,
        artifact_format_version,canonical_json,byte_length,created_at)
        VALUES (?,'subagent_task',?,1,'{}',2,1)`).run(
        `pa_${'2'.repeat(64)}`,
        `sha256:${'2'.repeat(64)}`,
      );
      const sealed = sealChildGrantPayload({
        purpose: 'start',
        role: 'explore',
        capabilityCeiling: { allowedTools: ['read_file'], bindingIds: [] },
        authorization: {
          interactionMode: 'accept_edits',
          workspaceAccess: 'read',
          phase: 'building',
        },
      });
      db.query(`INSERT INTO child_session_intents(child_thread_id,parent_session_id,parent_invocation_id,
        origin_run_id,origin_turn_id,origin_tool_call_id,attempt,child_invocation_id,
        grant_digest,sealed_grant_json,sealed_grant_byte_length,sealed_grant_digest,
        task_artifact_digest,task_text_digest,task_artifact_id,task_artifact_byte_length,
        disposition,role,tool_event_id,tool_event_revision,funding_run_id,
        delegated_reservation_id,delegated_upper_bound_digest,delegated_upper_bound_json,deadline_at)
        VALUES ('child','parent','origin-inv','run-1','turn-1','spawn-tool',1,'child-task',
        ?,?,?,?,'task','text',?,2,'required','explore','event',1,'run-1','delegated',
        'upper','{}','2099-01-01T00:00:00.000Z')`).run(
        sealed.sealedGrantDigest,
        sealed.sealedGrantJson,
        sealed.sealedGrantByteLength,
        sealed.sealedGrantDigest,
        `pa_${'2'.repeat(64)}`,
      );
      const frame =
        '<agent_message message_id="mail-1" sender_agent_id="parent">\nhello child\n</agent_message>';
      const surfaceJson = JSON.stringify({
        schema: {
          name: 'kite.model-surface',
          canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
          surfaceFormatVersion: 1,
        },
        purpose: 'primary_agent',
        request: {
          messages: [{ role: 'user', content: [{ type: 'text', text: frame }] }],
          tools: [{ name: 'read_file', description: 'Read a workspace file', inputSchema: {} }],
        },
      });
      const surfaceRef = modelRef('model_surface', surfaceJson);
      createKiteHomeArtifactStore(db).writeModel({
        ref: surfaceRef,
        artifactFormatVersion: 1,
        canonicalJson: surfaceJson,
        createdAt: 24,
      });
      const targetSnapshot = {
        ...route.targetSnapshot,
        revision: 3,
        interactionModeRevision: 0,
        activeTaskId: 'child-task',
        turn: { turnId: 'child-run', status: 'active' },
        childSessionOrigin: { parentSessionId: 'parent', grantDigest: sealed.sealedGrantDigest },
        modelInvocations: {
          'target-model': {
            ...route.targetSnapshot.modelInvocations['target-model'],
            purpose: 'primary_agent',
            attempts: 0,
            estimatedInputTokens: 40,
            surfaceArtifact: surfaceRef,
            surfaceIntegrityIdentifier: surfaceRef.integrityIdentifier,
          },
        },
      };
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at)
        VALUES ('child',27,'test',3,?,0,'checksum',3)`).run(JSON.stringify(targetSnapshot));
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('child','prepared',0,27,?,3)`).run(
        JSON.stringify({ type: 'model.invocation_prepared', invocationId: 'target-model' }),
      );
      const candidate = { ...route, targetSnapshot };
      expect(() =>
        db.transaction(() =>
          routeCrossSessionFollowupInTransaction(db, {
            ...candidate,
            targetSnapshot: { ...targetSnapshot, activeTaskId: 'wrong' },
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      const badGrant = sealChildGrantPayload({
        purpose: 'start',
        capabilityCeiling: { allowedTools: ['shell'], bindingIds: [] },
        authorization: {
          interactionMode: 'accept_edits',
          workspaceAccess: 'read',
          phase: 'building',
        },
      });
      db.query(`UPDATE child_session_intents SET grant_digest=?,sealed_grant_json=?,
        sealed_grant_byte_length=?,sealed_grant_digest=? WHERE child_thread_id='child'`).run(
        badGrant.sealedGrantDigest,
        badGrant.sealedGrantJson,
        badGrant.sealedGrantByteLength,
        badGrant.sealedGrantDigest,
      );
      const badGrantState = {
        ...targetSnapshot,
        childSessionOrigin: {
          ...targetSnapshot.childSessionOrigin,
          grantDigest: badGrant.sealedGrantDigest,
        },
      };
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(badGrantState),
      );
      expect(() =>
        db.transaction(() =>
          routeCrossSessionFollowupInTransaction(db, {
            ...candidate,
            targetSnapshot: badGrantState,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query(`UPDATE child_session_intents SET grant_digest=?,sealed_grant_json=?,
        sealed_grant_byte_length=?,sealed_grant_digest=? WHERE child_thread_id='child'`).run(
        sealed.sealedGrantDigest,
        sealed.sealedGrantJson,
        sealed.sealedGrantByteLength,
        sealed.sealedGrantDigest,
      );
      const wrongSurfaceJson = JSON.stringify({
        schema: {
          name: 'kite.model-surface',
          canonicalizerVersion: 'kite.model-surface.canonical-json.v1',
          surfaceFormatVersion: 1,
        },
        purpose: 'primary_agent',
        request: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'old Surface without mail' }] },
          ],
          tools: [],
        },
      });
      const wrongSurfaceRef = modelRef('model_surface', wrongSurfaceJson);
      createKiteHomeArtifactStore(db).writeModel({
        ref: wrongSurfaceRef,
        artifactFormatVersion: 1,
        canonicalJson: wrongSurfaceJson,
        createdAt: 25,
      });
      const wrongSurfaceState = {
        ...targetSnapshot,
        modelInvocations: {
          'target-model': {
            ...targetSnapshot.modelInvocations['target-model'],
            surfaceArtifact: wrongSurfaceRef,
            surfaceIntegrityIdentifier: wrongSurfaceRef.integrityIdentifier,
          },
        },
      };
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(wrongSurfaceState),
      );
      expect(() =>
        db.transaction(() =>
          routeCrossSessionFollowupInTransaction(db, {
            ...candidate,
            targetSnapshot: wrongSurfaceState,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(targetSnapshot),
      );
      const wrongPurposeJson = JSON.stringify({
        ...JSON.parse(surfaceJson),
        purpose: 'subagent',
      });
      const wrongPurposeRef = modelRef('model_surface', wrongPurposeJson);
      createKiteHomeArtifactStore(db).writeModel({
        ref: wrongPurposeRef,
        artifactFormatVersion: 1,
        canonicalJson: wrongPurposeJson,
        createdAt: 26,
      });
      const wrongPurposeState = {
        ...targetSnapshot,
        modelInvocations: {
          'target-model': {
            ...targetSnapshot.modelInvocations['target-model'],
            surfaceArtifact: wrongPurposeRef,
            surfaceIntegrityIdentifier: wrongPurposeRef.integrityIdentifier,
          },
        },
      };
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(wrongPurposeState),
      );
      expect(() =>
        db.transaction(() =>
          routeCrossSessionFollowupInTransaction(db, {
            ...candidate,
            targetSnapshot: wrongPurposeState,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(targetSnapshot),
      );
      expect(readCrossSessionFollowupRoute(db, 'child', 'submission-1')).toBeNull();
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('child','mail-prepared',1,27,?,3)`).run(
        JSON.stringify(candidate.preparedEvent),
      );
      const changedTargetMode = { ...targetSnapshot, interactionModeRevision: 1 };
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(changedTargetMode),
      );
      expect(() =>
        db.transaction(() =>
          routeCrossSessionFollowupInTransaction(db, {
            ...candidate,
            targetSnapshot: changedTargetMode,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(targetSnapshot),
      );
      for (const toolName of ['edit_file', 'shell_execute']) {
        const alteredSurface = JSON.parse(surfaceJson);
        alteredSurface.request.tools = [
          { name: toolName, description: 'Unproven Tool', inputSchema: {} },
        ];
        const alteredJson = JSON.stringify(alteredSurface);
        const alteredRef = modelRef('model_surface', alteredJson);
        createKiteHomeArtifactStore(db).writeModel({
          ref: alteredRef,
          artifactFormatVersion: 1,
          canonicalJson: alteredJson,
          createdAt: 27,
        });
        const alteredState = {
          ...targetSnapshot,
          modelInvocations: {
            'target-model': {
              ...targetSnapshot.modelInvocations['target-model'],
              surfaceArtifact: alteredRef,
              surfaceIntegrityIdentifier: alteredRef.integrityIdentifier,
            },
          },
        };
        db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
          JSON.stringify(alteredState),
        );
        expect(() =>
          db.transaction(() =>
            routeCrossSessionFollowupInTransaction(db, {
              ...candidate,
              targetSnapshot: alteredState,
            }),
          )(),
        ).toThrow(KiteCrossSessionFollowupError);
      }
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(targetSnapshot),
      );
      const originalSourceState = db
        .query<{ state_json: string }, []>(
          "SELECT state_json FROM runtime_snapshots WHERE session_id='parent'",
        )
        .get()!.state_json;
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
        JSON.stringify({ ...JSON.parse(originalSourceState), interactionModeRevision: 2 }),
      );
      expect(() =>
        db.transaction(() => routeCrossSessionFollowupInTransaction(db, candidate))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
        originalSourceState,
      );
      db.run("UPDATE child_session_intents SET role='code' WHERE child_thread_id='child'");
      expect(() =>
        db.transaction(() => routeCrossSessionFollowupInTransaction(db, candidate))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("UPDATE child_session_intents SET role='explore' WHERE child_thread_id='child'");
      const receipt = db.transaction(() => routeCrossSessionFollowupInTransaction(db, candidate))();
      expect(receipt.route).toBe('current_turn');
      expect(db.transaction(() => routeCrossSessionFollowupInTransaction(db, candidate))()).toEqual(
        receipt,
      );
      expect(readCrossSessionFollowupRoute(db, 'child', 'submission-1')).toEqual(receipt);
      expect(
        db
          .query<{ prepared_invocation_id: string }, []>(
            "SELECT prepared_invocation_id FROM agent_mail_inbox WHERE target_session_id='child'",
          )
          .get()?.prepared_invocation_id,
      ).toBe('target-model');
      const sourceState = JSON.parse(
        db
          .query<{ state_json: string }, []>(
            "SELECT state_json FROM runtime_snapshots WHERE session_id='parent'",
          )
          .get()!.state_json,
      );
      const dispatchedSource = {
        ...sourceState,
        tools: {
          ...sourceState.tools,
          calls: {
            ...sourceState.tools.calls,
            'spawn-tool': { status: 'succeeded' },
          },
        },
        capabilities: {
          ...sourceState.capabilities,
          invocations: {
            ...sourceState.capabilities.invocations,
            'origin-inv': {
              toolCallId: 'spawn-tool',
              status: 'succeeded',
              subagentProviderLifecycle: {
                childInvocationId: 'child-task',
                childSession: {
                  childThreadId: 'child',
                  delegatedReservationId: 'child-allotment:child',
                },
              },
            },
          },
        },
        resourceBudget: {
          ...sourceState.resourceBudget,
          reservations: {
            ...sourceState.resourceBudget.reservations,
            'child-allotment:child': {
              version: 1,
              reservationId: 'child-allotment:child',
              runId: 'run-1',
              invocationId: 'child-allotment:child',
              resourceKind: 'subagent',
              state: 'dispatch_started',
            },
          },
        },
      };
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
        JSON.stringify(dispatchedSource),
      );
      db.query(`UPDATE child_session_intents SET delegated_reservation_id='child-allotment:child',
        child_budget_activated_run_id='child-run',dispatch_ack_event_id='child-dispatch-ack'
        WHERE child_thread_id='child'`).run();
      const routedProof = readCurrentTurnRoutedNoAttemptChildProofForSource(
        db,
        'parent',
        'child',
        'submission-1',
      );
      expect(routedProof).toMatchObject({
        stage: 'routed',
        releaseSourceRevision: null,
        sourceRevision: 1,
        routedTargetRevision: 3,
        targetRunId: 'child-run',
        modelInvocationId: 'target-model',
      });
      db.run("UPDATE child_session_intents SET role='code' WHERE child_thread_id='child'");
      expect(
        readCurrentTurnRoutedNoAttemptChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.run("UPDATE child_session_intents SET role='explore' WHERE child_thread_id='child'");
      expect(
        readCurrentTurnDispatchedChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.run(
        "UPDATE child_session_intents SET dispatch_ack_event_id=NULL WHERE child_thread_id='child'",
      );
      expect(
        readCurrentTurnRoutedNoAttemptChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.run(
        "UPDATE child_session_intents SET dispatch_ack_event_id='child-dispatch-ack' WHERE child_thread_id='child'",
      );
      const unknownBackupSource = {
        ...dispatchedSource,
        resourceBudget: {
          ...dispatchedSource.resourceBudget,
          reservations: {
            ...dispatchedSource.resourceBudget.reservations,
            'backup-1': {
              ...dispatchedSource.resourceBudget.reservations['backup-1'],
              state: 'unknown',
            },
          },
        },
      };
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
        JSON.stringify(unknownBackupSource),
      );
      expect(
        readCurrentTurnRoutedNoAttemptChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
        JSON.stringify(dispatchedSource),
      );
      db.query("UPDATE runtime_sessions SET workspace_digest=? WHERE session_id='child'").run(
        `sha256:${'f'.repeat(64)}`,
      );
      expect(() =>
        readCurrentTurnRoutedNoAttemptChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toThrow();
      db.query("UPDATE runtime_sessions SET workspace_digest=? WHERE session_id='child'").run(
        `sha256:${'b'.repeat(64)}`,
      );
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('child','early-attempt',2,27,?,3)`).run(
        JSON.stringify({ type: 'model.invocation_attempt_started', invocationId: 'target-model' }),
      );
      expect(
        readCurrentTurnRoutedNoAttemptChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.run("DELETE FROM runtime_events WHERE session_id='child' AND event_id='early-attempt'");
      db.run(
        "INSERT INTO runtime_effect_leases(session_id,effect_id,owner_id,lease_revision,certainty,expires_at_ms,controller_generation,host_instance_id,connection_generation,state,updated_at) VALUES ('child','model-effect','owner',1,'certain',100,1,'host',0,'prepared',1)",
      );
      expect(
        readCurrentTurnRoutedNoAttemptChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.run("DELETE FROM runtime_effect_leases WHERE session_id='child'");
      const finalTarget = {
        ...targetSnapshot,
        turn: { ...targetSnapshot.turn, status: 'completed' },
      };
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(finalTarget),
      );
      expect(
        readCurrentTurnRoutedNoAttemptChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
        JSON.stringify(targetSnapshot),
      );
      const releasedSource = {
        ...dispatchedSource,
        tools: {
          ...dispatchedSource.tools,
          calls: {
            ...dispatchedSource.tools.calls,
            'tool-1': { ...dispatchedSource.tools.calls['tool-1'], status: 'succeeded' },
          },
        },
        capabilities: {
          ...dispatchedSource.capabilities,
          invocations: {
            ...dispatchedSource.capabilities.invocations,
            'invocation-1': {
              ...dispatchedSource.capabilities.invocations['invocation-1'],
              status: 'succeeded',
            },
          },
        },
        resourceBudget: {
          ...dispatchedSource.resourceBudget,
          reservations: {
            ...dispatchedSource.resourceBudget.reservations,
            'backup-1': {
              ...dispatchedSource.resourceBudget.reservations['backup-1'],
              state: 'released',
            },
          },
        },
      };
      db.query(
        "UPDATE runtime_snapshots SET revision=2,state_json=? WHERE session_id='parent'",
      ).run(JSON.stringify(releasedSource));
      db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'");
      const release = {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        submissionId: 'submission-1',
        targetRunId: 'child-run',
        invocationId: 'target-model',
        modelAdmissionId: 'local-model-1',
        reservationId: 'local-model-1',
        targetRevision: 3,
        sourceRevision: 2,
        createdAtMs: 40,
        sourceSnapshot: releasedSource,
        releaseEvent: { type: 'resource_budget.released', reservationId: 'backup-1' },
      };
      expect(
        readCrossSessionCurrentTurnBackupReleaseForTarget(db, 'child', 'parent', 'submission-1'),
      ).toBeNull();
      expect(
        readCrossSessionCurrentTurnPreparedNoAttemptProof(db, 'child', 'parent', 'submission-1'),
      ).toBeNull();
      expect(() =>
        db.transaction(() =>
          releaseCrossSessionCurrentTurnBackupInTransaction(db, {
            ...release,
            invocationId: 'wrong',
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('parent','unexpected-slot',1,27,?,4)`).run(
        JSON.stringify({ type: 'resource_budget.child_slot_acquired', reservationId: 'backup-1' }),
      );
      expect(() =>
        db.transaction(() => releaseCrossSessionCurrentTurnBackupInTransaction(db, release))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("DELETE FROM runtime_events WHERE session_id='parent' AND event_id='unexpected-slot'");
      const driftedSource = { ...releasedSource, interactionModeRevision: 2 };
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
        JSON.stringify(driftedSource),
      );
      expect(() =>
        db.transaction(() =>
          releaseCrossSessionCurrentTurnBackupInTransaction(db, {
            ...release,
            sourceSnapshot: driftedSource,
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
        JSON.stringify(releasedSource),
      );
      db.run("UPDATE child_session_intents SET role='code' WHERE child_thread_id='child'");
      expect(() =>
        db.transaction(() => releaseCrossSessionCurrentTurnBackupInTransaction(db, release))(),
      ).toThrow(KiteCrossSessionFollowupError);
      db.run("UPDATE child_session_intents SET role='explore' WHERE child_thread_id='child'");
      const releaseReceipt = db.transaction(() =>
        releaseCrossSessionCurrentTurnBackupInTransaction(db, release),
      )();
      expect(
        db.transaction(() => releaseCrossSessionCurrentTurnBackupInTransaction(db, release))(),
      ).toEqual(releaseReceipt);
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('parent','backup-released',1,27,?,4)`).run(
        JSON.stringify(release.releaseEvent),
      );
      expect(
        readCrossSessionCurrentTurnBackupReleaseForTarget(db, 'child', 'parent', 'submission-1'),
      ).toEqual(releaseReceipt);
      const recoveryProof = readCrossSessionCurrentTurnPreparedNoAttemptProof(
        db,
        'child',
        'parent',
        'submission-1',
      );
      expect(recoveryProof).toMatchObject({
        submissionId: 'submission-1',
        targetRunId: 'child-run',
        invocationId: 'target-model',
        modelReservationId: 'local-model-1',
        releaseSourceRevision: 2,
        surfaceDigest: surfaceRef.integrityIdentifier,
      });
      expect(listPendingCrossSessionFollowupFunding(db, 'parent', 10)).toEqual([]);
      expect(
        readCurrentTurnDispatchedChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toMatchObject({
        stage: 'released',
        releaseSourceRevision: 2,
        routedTargetRevision: 3,
        delegatedReservationId: 'child-allotment:child',
      });
      expect(
        readCurrentTurnRoutedNoAttemptChildProofForSource(db, 'parent', 'child', 'submission-1'),
      ).toBeNull();
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('child','model-attempt',2,27,?,5)`).run(
        JSON.stringify({ type: 'model.invocation_attempt_started', invocationId: 'target-model' }),
      );
      expect(
        readCrossSessionCurrentTurnPreparedNoAttemptProof(db, 'child', 'parent', 'submission-1'),
      ).toBeNull();
    } finally {
      db.close();
    }
  });
  test('keeps current-turn routing closed until old-Run budget and source release are proven', () => {
    const { db, route } = routedFixture();
    try {
      expect(() =>
        db.transaction(() => routeCrossSessionFollowupInTransaction(db, route))(),
      ).toThrow(KiteCrossSessionFollowupError);
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_followup_routes').get()
          ?.count,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test('rejects stale Run, changed budget and route identity without a receipt', () => {
    const { db, route } = routedFixture();
    try {
      expect(() =>
        db.transaction(() =>
          routeCrossSessionFollowupInTransaction(db, {
            ...route,
            targetRunId: 'old-run',
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      expect(() =>
        db.transaction(() =>
          routeCrossSessionFollowupInTransaction(db, {
            ...route,
            targetSnapshot: {
              ...route.targetSnapshot,
              modelInvocations: {},
            },
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      expect(() =>
        db.transaction(() =>
          routeCrossSessionFollowupInTransaction(db, {
            ...route,
            route: 'new_turn',
          }),
        )(),
      ).toThrow(KiteCrossSessionFollowupError);
      expect(readCrossSessionFollowupRoute(db, 'child', 'submission-1')).toBeNull();
    } finally {
      db.close();
    }
  });
});

test('source records one ACK after generic recovery already made both followup budgets unknown', () => {
  const { db, input } = fixture();
  try {
    db.transaction(() => acceptCrossSessionFollowupInTransaction(db, input))();
    db.run("UPDATE runtime_sessions SET revision=2 WHERE session_id='child'");
    db.transaction(() =>
      receiveCrossSessionFollowupInTransaction(db, {
        targetSessionId: 'child',
        sourceSessionId: 'parent',
        messageId: 'mail-1',
        submissionId: 'submission-1',
        targetRevision: 2,
        receivedAtMs: 20,
      }),
    )();
    db.query(`INSERT INTO agent_followup_funding_receipts(
      source_session_id,submission_id,target_session_id,message_id,funding_run_id,
      backup_reservation_id,turn_reservation_id,model_reservation_id,target_model_reservation_id,
      target_budget_digest,target_run_id,model_invocation_id,surface_artifact_id,surface_digest,
      surface_input_tokens,surface_max_output_tokens,target_revision,source_revision,created_at_ms,
      activated_source_revision,activated_at_ms)
      VALUES ('parent','submission-1','child','mail-1','run-1',
      'backup-1','source-turn','source-model','local-model',?,'child-run','target-model',?,?,
      40,10,3,2,25,4,30)`).run(
      `sha256:${'a'.repeat(64)}`,
      `pa_${'1'.repeat(64)}`,
      `sha256:${'1'.repeat(64)}`,
    );
    db.query(`INSERT INTO agent_followup_routes(target_session_id,source_session_id,message_id,
      submission_id,route,target_run_id,task_id,invocation_id,model_admission_id,
      reservation_id,routed_revision,created_at_ms)
      VALUES ('child','parent','mail-1','submission-1','new_turn','child-run','child-task',
      'target-model','local-model','local-model',4,28)`).run();
    const sourceSnapshot = {
      ...input.sourceSnapshot,
      resourceBudget: {
        ...input.sourceSnapshot.resourceBudget,
        reservations: {
          'backup-1': {
            ...input.sourceSnapshot.resourceBudget.reservations['backup-1'],
            state: 'released',
          },
          'source-turn': {
            reservationId: 'source-turn',
            runId: 'run-1',
            resourceKind: 'subagent',
            state: 'unknown',
          },
          'source-model': {
            reservationId: 'source-model',
            runId: 'run-1',
            resourceKind: 'model',
            state: 'unknown',
          },
        },
      },
    };
    const targetSnapshot = {
      turn: { turnId: 'child-run', status: 'aborted' },
      terminalOutcome: { status: 'unknown' },
      resourceBudget: {
        status: 'active',
        runId: 'child-run',
        reservations: {
          'local-model': { reservationId: 'local-model', runId: 'child-run', state: 'unknown' },
        },
      },
      modelInvocations: {
        'target-model': {
          invocationId: 'target-model',
          status: 'interrupted',
          attempts: 1,
          surfaceArtifact: { artifactId: `pa_${'1'.repeat(64)}`, kind: 'model_surface' },
          budget: { kind: 'reservation', reservationId: 'local-model' },
        },
      },
    };
    db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
      state_json,event_position,state_checksum,created_at) VALUES
      ('parent',27,'test',5,?,0,'checksum',5),('child',27,'test',7,?,0,'checksum',7)`).run(
      JSON.stringify(sourceSnapshot),
      JSON.stringify(targetSnapshot),
    );
    db.run("UPDATE runtime_sessions SET revision=5 WHERE session_id='parent'");
    db.run("UPDATE runtime_sessions SET revision=7 WHERE session_id='child'");
    db.run(
      "UPDATE runtime_runs SET status='unknown',finished_at_ms=7,terminal_json='{}',start_command_id='followup:submission-1' WHERE session_id='child' AND run_id='child-run'",
    );
    const append = db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
      event_json,created_at) VALUES (?,?,?,27,?,1)`);
    [
      { type: 'resource_budget.unknown', reservationId: 'source-turn' },
      { type: 'resource_budget.unknown', reservationId: 'source-model' },
    ].forEach((event, index) => {
      append.run('parent', `parent-${index}`, index, JSON.stringify(event));
    });
    [
      { type: 'model.invocation_attempt_started', invocationId: 'target-model' },
      { type: 'model.invocation_interrupted', invocationId: 'target-model' },
      { type: 'task.failed', taskId: 'child-task', reason: 'provider_unknown' },
      {
        type: 'agent.followup_turn_settled',
        sourceSessionId: 'parent',
        submissionId: 'submission-1',
        targetRunId: 'child-run',
        taskId: 'child-task',
        status: 'unknown',
      },
    ].forEach((event, index) => {
      append.run('child', `child-${index}`, index, JSON.stringify(event));
    });
    const ack = {
      sourceSessionId: 'parent',
      targetSessionId: 'child',
      submissionId: 'submission-1',
      targetRunId: 'child-run',
      modelInvocationId: 'target-model',
      targetRevision: 7,
      sourceRevision: 5,
      createdAtMs: 40,
      sourceSnapshot,
    };
    db.run("DELETE FROM runtime_events WHERE session_id='child' AND event_id='child-2'");
    expect(() =>
      db.transaction(() =>
        settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction(db, ack),
      )(),
    ).toThrow(KiteCrossSessionFollowupError);
    append.run(
      'child',
      'child-2',
      2,
      JSON.stringify({ type: 'task.failed', taskId: 'child-task', reason: 'provider_unknown' }),
    );
    db.run("UPDATE runtime_sessions SET parent_session_id=NULL WHERE session_id='child'");
    expect(() =>
      db.transaction(() =>
        settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction(db, ack),
      )(),
    ).toThrow(KiteCrossSessionFollowupError);
    db.run("UPDATE runtime_sessions SET parent_session_id='parent' WHERE session_id='child'");
    const mixedSource = {
      ...sourceSnapshot,
      resourceBudget: {
        ...sourceSnapshot.resourceBudget,
        reservations: {
          ...sourceSnapshot.resourceBudget.reservations,
          'source-model': {
            ...sourceSnapshot.resourceBudget.reservations['source-model'],
            state: 'dispatch_started',
          },
        },
      },
    };
    db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
      JSON.stringify(mixedSource),
    );
    expect(() =>
      db.transaction(() =>
        settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction(db, {
          ...ack,
          sourceSnapshot: mixedSource,
        }),
      )(),
    ).toThrow(KiteCrossSessionFollowupError);
    db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='parent'").run(
      JSON.stringify(sourceSnapshot),
    );
    expect(() =>
      db.transaction(() =>
        settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction(db, {
          ...ack,
          targetRevision: 6,
        }),
      )(),
    ).toThrow(KiteCrossSessionFollowupError);
    expect(readCrossSessionFollowupTerminalReceipt(db, 'parent', 'submission-1')).toBeNull();
    const receipt = db.transaction(() =>
      settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction(db, ack),
    )();
    expect(receipt.disposition).toBe('unknown');
    expect(
      db.transaction(() =>
        settleCrossSessionFollowupFundingAfterUnknownRecoveryInTransaction(db, ack),
      )(),
    ).toEqual(receipt);
    expect(readCrossSessionFollowupTerminalReceipt(db, 'parent', 'submission-1')).toEqual(receipt);
    expect(readLastFollowupOutcomeForDirectChild(db, 'parent', 'run-1', 'child')).toEqual({
      submissionId: 'submission-1',
      status: 'unknown',
      taskId: 'child-task',
      sourceRevision: 5,
    });
    expect(readDirectChildFollowupOutcomeWatermark(db, 'parent', 'run-1')).toEqual({
      count: 1,
      throughRevision: 5,
    });
  } finally {
    db.close();
  }
});
