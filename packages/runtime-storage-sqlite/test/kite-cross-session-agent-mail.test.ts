import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CROSS_SESSION_FOLLOWUP_PRE_DISPATCH_EXPIRED,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import {
  acceptCrossSessionAcceptedReleaseNoticeInTransaction,
  acceptCrossSessionFollowupTerminalReplyInTransaction,
  acceptCrossSessionQueueMailInTransaction,
  confirmCrossSessionQueueMailInTransaction,
  KiteCrossSessionAgentMailError,
  listPendingCrossSessionQueueMail,
  listPendingCrossSessionQueueMailSources,
  listQueuedCrossSessionInbox,
  listUnnotifiedAcceptedFollowupReleases,
  listUnrepliedSettledFollowupTerminalSources,
  nextCrossSessionTargetSequence,
  prepareCrossSessionQueueMailInputInTransaction,
  readCrossSessionInboxReceipt,
  readCrossSessionPreparedThrough,
  readDirectChildInboxWatermark,
  readReceivedCrossSessionMailBody,
  readUnreadDirectChildMail,
  receiveCrossSessionQueueMailInTransaction,
} from '../src/kite-cross-session-agent-mail';
import { initializeKiteSessionStoreIfNeeded } from '../src/kite-home-store';

const digest = 'a'.repeat(64);
const intent = {
  sourceSessionId: 'parent',
  targetSessionId: 'child',
  messageId: 'message-1',
  commandId: 'send-1',
  requestDigest: digest,
  sourceRunId: 'run-1',
  sourceTurnId: 'turn-1',
  sourceModelInvocationId: 'model-invocation-1',
  sourceToolCallId: 'tool-1',
  sourceEffectAttemptId: 'effect-1',
  sourceTaskId: 'task-1',
  sourceSequence: 1,
  sourceRevision: 1,
  bodyText: 'hello child',
  acceptedAtMs: 10,
} as const;

function fixture(): Database {
  const db = new Database(':memory:', { strict: true });
  initializeKiteSessionStoreIfNeeded(db);
  db.query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,display_name,created_at,updated_at)
    VALUES ('workspace-1','/workspace',?, 'project-1','digest-1','Workspace',1,1)`).run(
    `sha256:${'1'.repeat(64)}`,
  );
  const session =
    db.query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,name,updated_at,run_index_from_revision,parent_session_id)
    VALUES (?,'workspace-1','project-1','digest-1',27,'test',1,'',1,0,?)`);
  session.run('parent', null);
  session.run('child', 'parent');
  session.run('other-root', null);
  session.run('other-child', 'other-root');
  const agent =
    db.query(`INSERT INTO agent_nodes(session_id,agent_id,current_task_id,status,turn_ordinal,created_at_ms)
    VALUES (?,?,?, ?,1,1)`);
  agent.run('parent', 'parent', 'run-1', 'active');
  agent.run('child', 'child', 'child-run', 'active');
  agent.run('other-root', 'other-root', 'other-run', 'active');
  agent.run('other-child', 'other-child', null, 'idle');
  db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,created_revision,last_revision,created_at_ms,started_at_ms)
    VALUES ('parent','run-1','start-1','building','running',1,1,1,1)`).run();
  db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,created_revision,last_revision,created_at_ms,started_at_ms)
    VALUES ('child','child-run','child-start','building','running',1,1,1,1)`).run();
  db.query(`INSERT INTO runtime_command_receipts(scope_session_id,command_id,workspace_id,project_id,workspace_digest,request_digest,target_session_id,original_receipt_json,committed_revision,committed_at)
    VALUES ('parent','send-1','workspace-1','project-1','digest-1',?,'parent','{}',1,10)`).run(
    digest,
  );
  return db;
}

function acceptedReleaseFixture(
  reason:
    | 'tool_failed'
    | 'expired'
    | 'context_unavailable'
    | 'authorization_changed'
    | 'source_cancelled',
): Database {
  const db = fixture();
  db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, intent))();
  const admissionJson = JSON.stringify({
    schema: 'kite.cross-session-followup-admission.v1',
    sourceSessionId: 'parent',
    targetSessionId: 'child',
    messageId: 'message-1',
    submissionId: 'submission-1',
    fundingRunId: 'run-1',
    backupReservationId: 'backup-1',
    deadlineAt: 20,
  });
  const admissionHash = createHash('sha256').update(admissionJson).digest('hex');
  db.query(`INSERT INTO agent_followup_admission_artifacts(artifact_id,integrity_identifier,
    artifact_format_version,canonical_json,byte_length,created_at) VALUES (?, ?,1,?,?,1)`).run(
    `pa_${admissionHash}`,
    `sha256:${admissionHash}`,
    admissionJson,
    Buffer.byteLength(admissionJson, 'utf8'),
  );
  db.query(`UPDATE agent_mail_outbox SET mode='trigger_turn',submission_id='submission-1',
    followup_admission_artifact_id=?,followup_admission_digest=?
    WHERE source_session_id='parent' AND message_id='message-1'`).run(
    `pa_${admissionHash}`,
    `sha256:${admissionHash}`,
  );
  const grant = sealChildGrantPayload({
    childInvocationId: 'child-invocation',
    grantId: 'grant-1',
  });
  db.query(`INSERT INTO subagent_task_artifacts(artifact_id,kind,integrity_identifier,
    artifact_format_version,canonical_json,byte_length,created_at)
    VALUES (?,'subagent_task',?,1,'{}',2,1)`).run(
    `pa_${'1'.repeat(64)}`,
    `sha256:${'1'.repeat(64)}`,
  );
  db.query(`INSERT INTO child_session_intents(
    child_thread_id,parent_session_id,parent_invocation_id,origin_run_id,origin_turn_id,
    origin_tool_call_id,attempt,child_invocation_id,grant_digest,sealed_grant_json,
    sealed_grant_byte_length,sealed_grant_digest,task_artifact_digest,task_text_digest,
    task_artifact_id,task_artifact_byte_length,disposition,role,tool_event_id,
    tool_event_revision,funding_run_id,delegated_reservation_id,
    delegated_upper_bound_digest,delegated_upper_bound_json,deadline_at,
    child_budget_activated_run_id,dispatch_ack_event_id,dispatch_ack_revision)
    VALUES ('child','parent','parent-invocation','run-1','turn-1','spawn-tool',1,
    'child-invocation',?,?,?,?,'task-digest','text-digest',?,2,'required','code',
    'tool-event',1,'run-1','reservation','budget-digest','{}',
    '2099-01-01T00:00:00.000Z','child-run','dispatch-ack',1)`).run(
    grant.sealedGrantDigest,
    grant.sealedGrantJson,
    grant.sealedGrantByteLength,
    grant.sealedGrantDigest,
    `pa_${'1'.repeat(64)}`,
  );
  db.query(`UPDATE runtime_runs SET status='completed',finished_at_ms=2
    WHERE session_id='child' AND run_id='child-run'`).run();
  db.query(
    "UPDATE agent_nodes SET status='idle',current_task_id=NULL WHERE session_id='child'",
  ).run();
  const sourceStateJson = '{}';
  const sourceStateDigest = `sha256:${createHash('sha256').update(sourceStateJson).digest('hex')}`;
  db.query("UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'").run();
  db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
    state_json,event_position,state_checksum,created_at)
    VALUES ('parent',27,'test',2,?,2,'checksum',2)`).run(sourceStateJson);
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,
    created_at) VALUES ('parent','release-event',2,27,?,2)`).run(
    JSON.stringify({ type: 'resource_budget.released', reservationId: 'backup-1' }),
  );
  db.query(`UPDATE agent_mail_outbox SET accepted_release_source_revision=2,
    accepted_release_reason=?,accepted_release_evidence_digest=?,accepted_released_at_ms=20
    WHERE source_session_id='parent' AND submission_id='submission-1'`).run(
    reason,
    sourceStateDigest,
  );
  if (reason === 'source_cancelled') {
    db.query(`UPDATE runtime_runs SET status='cancelled',finished_at_ms=2,terminal_json='{}'
      WHERE session_id='parent' AND run_id='run-1'`).run();
    db.query(
      "UPDATE agent_nodes SET status='idle',current_task_id=NULL WHERE session_id='parent'",
    ).run();
    db.query("UPDATE runtime_sessions SET revision=3 WHERE session_id='parent'").run();
    db.query(
      "UPDATE runtime_snapshots SET revision=3,event_position=3 WHERE session_id='parent'",
    ).run();
    db.query(`UPDATE agent_mail_outbox SET accepted_release_source_revision=3,
      accepted_released_at_ms=2 WHERE source_session_id='parent' AND submission_id='submission-1'`).run();
    db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,
      created_at) VALUES ('parent','user-aborted',3,27,?,1)`).run(
      JSON.stringify({
        type: 'turn.aborted',
        turnId: 'turn-1',
        cause: 'user',
        reason: 'Cancelled.',
      }),
    );
  }
  return db;
}

function preparedExpiredReleaseFixture(): Database {
  const db = acceptedReleaseFixture('expired');
  db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
    created_revision,last_revision,created_at_ms,started_at_ms,finished_at_ms,terminal_json)
    VALUES ('child','followup-run','followup:submission-1','building','failed',2,2,2,2,20,'{}')`).run();
  const targetState = {
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
    state_json,event_position,state_checksum,created_at) VALUES ('child',27,'test',2,?,0,'checksum',20)`).run(
    JSON.stringify(targetState),
  );
  db.query("UPDATE runtime_sessions SET revision=2 WHERE session_id='child'").run();
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
  const insert = db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,
    schema_version,event_json,created_at) VALUES ('child',?,?,27,?,20)`);
  for (let index = 0; index < events.length; index++)
    insert.run(`expired-${index}`, index, JSON.stringify(events[index]));
  return db;
}

describe('Store13 accepted-only followup release notice', () => {
  for (const reason of [
    'tool_failed',
    'expired',
    'context_unavailable',
    'authorization_changed',
  ] as const) {
    test(`durably notifies one ${reason} release without claiming a child result`, () => {
      const db = acceptedReleaseFixture(reason);
      try {
        const input = {
          childSessionId: 'child',
          parentSessionId: 'parent',
          submissionId: 'submission-1',
          acceptedAtMs: 21,
        };
        expect(listUnnotifiedAcceptedFollowupReleases(db, 8)).toEqual([
          { childSessionId: 'child', parentSessionId: 'parent', submissionId: 'submission-1' },
        ]);
        const accepted = db.transaction(() =>
          acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, input),
        )();
        expect(accepted).toMatchObject({ mode: 'reply', targetRunId: 'run-1' });
        expect(
          db.transaction(() => acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, input))(),
        ).toEqual(accepted);
        expect(listUnnotifiedAcceptedFollowupReleases(db, 8)).toEqual([]);
        db.transaction(() =>
          receiveCrossSessionQueueMailInTransaction(db, {
            sourceSessionId: 'child',
            targetSessionId: 'parent',
            messageId: accepted.messageId,
            targetRevision: 2,
            receivedAtMs: 22,
          }),
        )();
        const body = JSON.parse(
          readReceivedCrossSessionMailBody(db, 'parent', accepted.messageId)!,
        );
        expect(body).toEqual({
          kind: 'agent_followup_not_dispatched',
          submissionId: 'submission-1',
          status: 'failed',
          reason,
        });
        expect(listQueuedCrossSessionInbox(db, 'parent', 'run-1', 8)[0]?.messageId).toBe(
          accepted.messageId,
        );
      } finally {
        db.close();
      }
    });
  }

  test('missing release Event or later target route fails closed', () => {
    const db = acceptedReleaseFixture('tool_failed');
    try {
      const input = {
        childSessionId: 'child',
        parentSessionId: 'parent',
        submissionId: 'submission-1',
        acceptedAtMs: 21,
      };
      db.query(
        "DELETE FROM runtime_events WHERE session_id='parent' AND event_id='release-event'",
      ).run();
      expect(() =>
        db.transaction(() => acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, input))(),
      ).toThrow(KiteCrossSessionAgentMailError);
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('parent','release-event',2,27,?,2)`).run(
        JSON.stringify({ type: 'resource_budget.released', reservationId: 'backup-1' }),
      );
      db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms,started_at_ms)
        VALUES ('child','unexpected-followup','followup:submission-1','building','running',2,2,2,2)`).run();
      expect(() =>
        db.transaction(() => acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, input))(),
      ).toThrow(KiteCrossSessionAgentMailError);
    } finally {
      db.close();
    }
  });

  test('source user cancellation notifies cancelled rather than failed without a child result', () => {
    const db = acceptedReleaseFixture('source_cancelled');
    try {
      const input = {
        childSessionId: 'child',
        parentSessionId: 'parent',
        submissionId: 'submission-1',
        acceptedAtMs: 21,
      };
      const accepted = db.transaction(() =>
        acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, input),
      )();
      expect(accepted.targetRunId).toBeNull();
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'child',
          targetSessionId: 'parent',
          messageId: accepted.messageId,
          targetRevision: 3,
          receivedAtMs: 22,
        }),
      )();
      expect(
        JSON.parse(readReceivedCrossSessionMailBody(db, 'parent', accepted.messageId)!),
      ).toEqual({
        kind: 'agent_followup_not_dispatched',
        submissionId: 'submission-1',
        status: 'cancelled',
        reason: 'source_cancelled',
      });
      db.query(
        "DELETE FROM runtime_events WHERE session_id='parent' AND event_id='user-aborted'",
      ).run();
      expect(() =>
        db.transaction(() => acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, input))(),
      ).toThrow(KiteCrossSessionAgentMailError);
    } finally {
      db.close();
    }
  });

  test('prepared target expired without funding receives one non-dispatch notice', () => {
    const db = preparedExpiredReleaseFixture();
    try {
      const input = {
        childSessionId: 'child',
        parentSessionId: 'parent',
        submissionId: 'submission-1',
        acceptedAtMs: 21,
      };
      expect(listUnnotifiedAcceptedFollowupReleases(db, 8)).toEqual([
        { childSessionId: 'child', parentSessionId: 'parent', submissionId: 'submission-1' },
      ]);
      const accepted = db.transaction(() =>
        acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, input),
      )();
      expect(accepted).toMatchObject({ mode: 'reply', targetRunId: 'run-1' });
      expect(
        db.transaction(() => acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, input))(),
      ).toEqual(accepted);
      expect(listUnnotifiedAcceptedFollowupReleases(db, 8)).toEqual([]);
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'child',
          targetSessionId: 'parent',
          messageId: accepted.messageId,
          targetRevision: 2,
          receivedAtMs: 22,
        }),
      )();
      expect(
        JSON.parse(readReceivedCrossSessionMailBody(db, 'parent', accepted.messageId)!),
      ).toEqual({
        kind: 'agent_followup_not_dispatched',
        submissionId: 'submission-1',
        status: 'failed',
        reason: 'expired',
      });
    } finally {
      db.close();
    }
  });

  test('prepared target with an attempted Model cannot use the expiry notice', () => {
    const db = preparedExpiredReleaseFixture();
    try {
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('child','attempted',6,27,?,20)`).run(
        JSON.stringify({ type: 'model.invocation_attempt_started', invocationId: 'target-model' }),
      );
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionAcceptedReleaseNoticeInTransaction(db, {
            childSessionId: 'child',
            parentSessionId: 'parent',
            submissionId: 'submission-1',
            acceptedAtMs: 21,
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
    } finally {
      db.close();
    }
  });
});

function settledFollowupFixture(): Database {
  const db = fixture();
  db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, intent))();
  const admissionJson = '{}';
  const admissionHash = createHash('sha256').update(admissionJson).digest('hex');
  db.query(`INSERT INTO agent_followup_admission_artifacts(artifact_id,integrity_identifier,
    artifact_format_version,canonical_json,byte_length,created_at)
    VALUES (?, ?,1,?,2,1)`).run(`pa_${admissionHash}`, `sha256:${admissionHash}`, admissionJson);
  db.query(`UPDATE agent_mail_outbox SET mode='trigger_turn',submission_id='submission-1',
    followup_admission_artifact_id=?,followup_admission_digest=?
    WHERE source_session_id='parent' AND message_id='message-1'`).run(
    `pa_${admissionHash}`,
    `sha256:${admissionHash}`,
  );
  db.transaction(() =>
    receiveCrossSessionQueueMailInTransaction(db, {
      sourceSessionId: 'parent',
      targetSessionId: 'child',
      messageId: 'message-1',
      targetRevision: 1,
      receivedAtMs: 2,
    }),
  )();
  db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
    created_revision,last_revision,created_at_ms,started_at_ms,finished_at_ms,terminal_json)
    VALUES ('child','followup-run','followup:submission-1','building','completed',2,3,2,2,3,'{}')`).run();
  db.query(`INSERT INTO agent_followup_routes(target_session_id,source_session_id,message_id,
    submission_id,route,target_run_id,task_id,invocation_id,model_admission_id,
    reservation_id,routed_revision,created_at_ms) VALUES ('child','parent','message-1',
    'submission-1','new_turn','followup-run','followup-task','followup-model',
    'followup-admission','target-model-reservation',2,2)`).run();
  db.query(`UPDATE runtime_sessions SET revision=4 WHERE session_id='child'`).run();
  db.query(`UPDATE runtime_sessions SET revision=2 WHERE session_id='parent'`).run();
  const targetStateJson = JSON.stringify({ terminal: 'completed', submissionId: 'submission-1' });
  const targetStateDigest = `sha256:${createHash('sha256').update(targetStateJson).digest('hex')}`;
  db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,state_json,
    event_position,state_checksum,created_at) VALUES ('child',27,'test',4,?,4,'checksum',4)`).run(
    targetStateJson,
  );
  const checkpointJson = JSON.stringify({
    artifactFormatVersion: 1,
    childSessionId: 'child',
    submissionId: 'submission-1',
    terminalRunId: 'followup-run',
    terminalTaskId: 'followup-task',
    terminalRevision: 4,
    terminalStatus: 'completed',
    stateDigest: targetStateDigest,
  });
  const checkpointHash = createHash('sha256').update(checkpointJson).digest('hex');
  db.query(`INSERT INTO subagent_checkpoint_artifacts(artifact_id,integrity_identifier,
    artifact_format_version,canonical_json,byte_length,created_at) VALUES (?, ?,1,?,?,4)`).run(
    `pa_${checkpointHash}`,
    `sha256:${checkpointHash}`,
    checkpointJson,
    Buffer.byteLength(checkpointJson, 'utf8'),
  );
  db.query(`INSERT INTO agent_followup_funding_receipts(source_session_id,submission_id,
    target_session_id,message_id,funding_run_id,backup_reservation_id,turn_reservation_id,
    model_reservation_id,target_model_reservation_id,target_budget_digest,target_run_id,
    model_invocation_id,surface_artifact_id,surface_digest,surface_input_tokens,
    surface_max_output_tokens,target_revision,source_revision,created_at_ms,
    activated_source_revision,activated_at_ms,terminal_disposition,terminal_target_revision,
    terminal_source_revision,terminal_evidence_digest,terminal_at_ms) VALUES
    ('parent','submission-1','child','message-1','run-1','backup','turn-reservation',
    'model-reservation','target-model-reservation','budget-digest','followup-run',
    'followup-model','surface-id','surface-digest',1,1,2,1,2,2,2,'completed',4,2,?,4)`).run(
    targetStateDigest,
  );
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,
    created_at) VALUES ('child','followup-settled',4,27,?,4)`).run(
    JSON.stringify({
      type: 'agent.followup_turn_settled',
      sourceSessionId: 'parent',
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      taskId: 'followup-task',
      status: 'completed',
    }),
  );
  return db;
}

function releasedFollowupFixture(status: 'failed' | 'cancelled'): Database {
  const db = settledFollowupFixture();
  const targetStateJson = JSON.stringify({ terminal: status, submissionId: 'submission-1' });
  const targetStateDigest = `sha256:${createHash('sha256').update(targetStateJson).digest('hex')}`;
  db.query(
    "UPDATE runtime_runs SET status=? WHERE session_id='child' AND run_id='followup-run'",
  ).run(status);
  db.query("UPDATE runtime_snapshots SET state_json=? WHERE session_id='child'").run(
    targetStateJson,
  );
  db.query(`UPDATE agent_followup_funding_receipts SET
    terminal_disposition='pre_dispatch_released',terminal_evidence_digest=?
    WHERE source_session_id='parent' AND submission_id='submission-1'`).run(targetStateDigest);
  db.query(
    "DELETE FROM subagent_checkpoint_artifacts WHERE json_extract(canonical_json,'$.submissionId')='submission-1'",
  ).run();
  db.query(`UPDATE runtime_events SET event_json=? WHERE session_id='child'
    AND event_id='followup-settled'`).run(
    JSON.stringify({
      type: 'agent.followup_turn_settled',
      sourceSessionId: 'parent',
      submissionId: 'submission-1',
      targetRunId: 'followup-run',
      taskId: 'followup-task',
      status,
    }),
  );
  const append = db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,
    schema_version,event_json,created_at) VALUES ('parent',?,?,27,?,4)`);
  append.run(
    'turn-release',
    1,
    JSON.stringify({
      type: 'resource_budget.released',
      reservationId: 'turn-reservation',
      proof: 'local_pre_dispatch_failure',
    }),
  );
  append.run(
    'model-release',
    2,
    JSON.stringify({
      type: 'resource_budget.released',
      reservationId: 'model-reservation',
      proof: 'local_pre_dispatch_failure',
    }),
  );
  return db;
}

describe('Store13 followup new Turn terminal replies', () => {
  for (const status of ['failed', 'cancelled'] as const) {
    test(`${status} pre-dispatch terminal ACK produces an exact failure reply`, () => {
      const db = releasedFollowupFixture(status);
      try {
        const input = {
          childSessionId: 'child',
          parentSessionId: 'parent',
          submissionId: 'submission-1',
          acceptedAtMs: 5,
        };
        expect(listUnrepliedSettledFollowupTerminalSources(db, 8)).toEqual([
          { childSessionId: 'child', parentSessionId: 'parent', submissionId: 'submission-1' },
        ]);
        const accepted = db.transaction(() =>
          acceptCrossSessionFollowupTerminalReplyInTransaction(db, input),
        )();
        expect(accepted.mode).toBe('reply');
        expect(accepted.sourceTaskId).toBe('followup-task');
        expect(
          db.transaction(() => acceptCrossSessionFollowupTerminalReplyInTransaction(db, input))(),
        ).toEqual(accepted);
        db.transaction(() =>
          receiveCrossSessionQueueMailInTransaction(db, {
            sourceSessionId: 'child',
            targetSessionId: 'parent',
            messageId: accepted.messageId,
            targetRevision: 2,
            receivedAtMs: 6,
          }),
        )();
        const body = JSON.parse(
          readReceivedCrossSessionMailBody(db, 'parent', accepted.messageId)!,
        );
        expect(body).toMatchObject({ taskId: 'followup-task', status });
        expect(body.resultRef).toBeUndefined();
      } finally {
        db.close();
      }
    });
  }

  test('pre-dispatch reply fails closed without exact source release and attempt absence', () => {
    const db = releasedFollowupFixture('failed');
    try {
      const input = {
        childSessionId: 'child',
        parentSessionId: 'parent',
        submissionId: 'submission-1',
        acceptedAtMs: 5,
      };
      db.query(
        "DELETE FROM runtime_events WHERE session_id='parent' AND event_id='model-release'",
      ).run();
      expect(listUnrepliedSettledFollowupTerminalSources(db, 8)).toEqual([]);
      expect(() =>
        db.transaction(() => acceptCrossSessionFollowupTerminalReplyInTransaction(db, input))(),
      ).toThrow(KiteCrossSessionAgentMailError);
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('parent','model-release',2,27,?,4)`).run(
        JSON.stringify({
          type: 'resource_budget.released',
          reservationId: 'model-reservation',
          proof: 'local_pre_dispatch_failure',
        }),
      );
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,
        event_json,created_at) VALUES ('child','attempt',3,27,?,4)`).run(
        JSON.stringify({
          type: 'model.invocation_attempt_started',
          invocationId: 'followup-model',
        }),
      );
      expect(listUnrepliedSettledFollowupTerminalSources(db, 8)).toEqual([]);
      expect(() =>
        db.transaction(() => acceptCrossSessionFollowupTerminalReplyInTransaction(db, input))(),
      ).toThrow(KiteCrossSessionAgentMailError);
    } finally {
      db.close();
    }
  });

  test('pre-dispatch ACK evidence must match the still-current target snapshot', () => {
    const db = releasedFollowupFixture('cancelled');
    try {
      db.query("UPDATE runtime_snapshots SET state_json='{}' WHERE session_id='child'").run();
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionFollowupTerminalReplyInTransaction(db, {
            childSessionId: 'child',
            parentSessionId: 'parent',
            submissionId: 'submission-1',
            acceptedAtMs: 5,
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
    } finally {
      db.close();
    }
  });
  test('exact settled route and source funding ACK create one parent-bound reply', () => {
    const db = settledFollowupFixture();
    try {
      const input = {
        childSessionId: 'child',
        parentSessionId: 'parent',
        submissionId: 'submission-1',
        acceptedAtMs: 5,
      };
      expect(listUnrepliedSettledFollowupTerminalSources(db, 8)).toEqual([
        { childSessionId: 'child', parentSessionId: 'parent', submissionId: 'submission-1' },
      ]);
      const accepted = db.transaction(() =>
        acceptCrossSessionFollowupTerminalReplyInTransaction(db, input),
      )();
      expect(accepted).toMatchObject({
        mode: 'reply',
        sourceRunId: 'followup-run',
        sourceTaskId: 'followup-task',
        targetRunId: 'run-1',
      });
      expect(
        db.transaction(() => acceptCrossSessionFollowupTerminalReplyInTransaction(db, input))(),
      ).toEqual(accepted);
      expect(listUnrepliedSettledFollowupTerminalSources(db, 8)).toEqual([]);
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'child',
          targetSessionId: 'parent',
          messageId: accepted.messageId,
          targetRevision: 2,
          receivedAtMs: 6,
        }),
      )();
      const body = JSON.parse(readReceivedCrossSessionMailBody(db, 'parent', accepted.messageId)!);
      expect(body).toMatchObject({ taskId: 'followup-task', status: 'completed' });
      expect(body.resultRef).toBeUndefined();
      expect(listQueuedCrossSessionInbox(db, 'parent', 'run-1', 8)[0]?.messageId).toBe(
        accepted.messageId,
      );
      expect(
        db
          .transaction(() =>
            prepareCrossSessionQueueMailInputInTransaction(db, {
              targetSessionId: 'parent',
              targetRevision: 2,
              currentRunId: 'run-1',
              modelInvocationId: 'parent-next-model',
              modelAdmissionId: 'parent-next-admission',
            }),
          )()
          .map((row) => row.messageId),
      ).toEqual([accepted.messageId]);
      expect(readCrossSessionPreparedThrough(db, 'parent', 'run-1')).toBe(1);
    } finally {
      db.close();
    }
  });

  test('completed followup reply accepted while parent idle remains outside later Run input', () => {
    const db = settledFollowupFixture();
    try {
      db.query(
        "UPDATE agent_nodes SET status='idle',current_task_id=NULL WHERE session_id='parent'",
      ).run();
      db.query(
        "UPDATE runtime_runs SET status='completed',finished_at_ms=3 WHERE session_id='parent'",
      ).run();
      const accepted = db.transaction(() =>
        acceptCrossSessionFollowupTerminalReplyInTransaction(db, {
          childSessionId: 'child',
          parentSessionId: 'parent',
          submissionId: 'submission-1',
          acceptedAtMs: 5,
        }),
      )();
      expect(accepted.targetRunId).toBeNull();
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'child',
          targetSessionId: 'parent',
          messageId: accepted.messageId,
          targetRevision: 2,
          receivedAtMs: 6,
        }),
      )();
      db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms,started_at_ms)
        VALUES ('parent','later-run','later-start','building','running',2,2,4,4)`).run();
      db.query(
        "UPDATE agent_nodes SET status='active',current_task_id='later-run' WHERE session_id='parent'",
      ).run();
      expect(listQueuedCrossSessionInbox(db, 'parent', 'later-run', 8)).toEqual([]);
      expect(
        db.transaction(() =>
          prepareCrossSessionQueueMailInputInTransaction(db, {
            targetSessionId: 'parent',
            targetRevision: 2,
            currentRunId: 'later-run',
            modelInvocationId: 'later-model',
            modelAdmissionId: 'later-admission',
          }),
        )(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('funding ACK, terminal status, and new Turn route are required', () => {
    const db = settledFollowupFixture();
    try {
      const input = {
        childSessionId: 'child',
        parentSessionId: 'parent',
        submissionId: 'submission-1',
        acceptedAtMs: 5,
      };
      db.query(`UPDATE agent_followup_funding_receipts SET terminal_disposition=NULL,
        terminal_target_revision=NULL,terminal_source_revision=NULL,
        terminal_evidence_digest=NULL,terminal_at_ms=NULL WHERE submission_id='submission-1'`).run();
      expect(listUnrepliedSettledFollowupTerminalSources(db, 8)).toEqual([]);
      expect(() =>
        db.transaction(() => acceptCrossSessionFollowupTerminalReplyInTransaction(db, input))(),
      ).toThrow(KiteCrossSessionAgentMailError);
      db.query(`UPDATE agent_followup_funding_receipts SET terminal_disposition='completed',
        terminal_target_revision=4,terminal_source_revision=2,
        terminal_evidence_digest=?,terminal_at_ms=4 WHERE submission_id='submission-1'`).run(
        `sha256:${createHash('sha256')
          .update(JSON.stringify({ terminal: 'completed', submissionId: 'submission-1' }))
          .digest('hex')}`,
      );
      db.query(
        "UPDATE agent_followup_routes SET route='current_turn' WHERE submission_id='submission-1'",
      ).run();
      expect(() =>
        db.transaction(() => acceptCrossSessionFollowupTerminalReplyInTransaction(db, input))(),
      ).toThrow(KiteCrossSessionAgentMailError);
      db.query(
        "UPDATE agent_followup_routes SET route='new_turn' WHERE submission_id='submission-1'",
      ).run();
      db.query(`UPDATE runtime_events SET event_json=? WHERE session_id='child'
        AND event_id='followup-settled'`).run(
        JSON.stringify({
          type: 'agent.followup_turn_settled',
          sourceSessionId: 'parent',
          submissionId: 'submission-1',
          targetRunId: 'followup-run',
          taskId: 'followup-task',
          status: 'unknown',
        }),
      );
      expect(() =>
        db.transaction(() => acceptCrossSessionFollowupTerminalReplyInTransaction(db, input))(),
      ).toThrow(KiteCrossSessionAgentMailError);
    } finally {
      db.close();
    }
  });
});

describe('Store11 cross-Session QueueOnly mail', () => {
  test('mixed inbox excludes TriggerTurn from QueueOnly model selection and watermark', () => {
    const db = fixture();
    try {
      db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, intent))();
      const admissionJson = '{}';
      const hex = createHash('sha256').update(admissionJson).digest('hex');
      db.query(`INSERT INTO agent_followup_admission_artifacts(artifact_id,integrity_identifier,
        artifact_format_version,canonical_json,byte_length,created_at) VALUES (?,?,1,?,2,1)`).run(
        `pa_${hex}`,
        `sha256:${hex}`,
        admissionJson,
      );
      db.query(`UPDATE agent_mail_outbox SET mode='trigger_turn',submission_id='trigger-1',
        followup_admission_artifact_id=?,followup_admission_digest=? WHERE message_id='message-1'`).run(
        `pa_${hex}`,
        `sha256:${hex}`,
      );
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          messageId: 'message-1',
          targetRevision: 1,
          receivedAtMs: 11,
        }),
      )();
      db.query(`INSERT INTO runtime_command_receipts(scope_session_id,command_id,workspace_id,
        project_id,workspace_digest,request_digest,target_session_id,original_receipt_json,
        committed_revision,committed_at)
        VALUES ('parent','send-2','workspace-1','project-1','digest-1',?,'parent','{}',1,12)`).run(
        'c'.repeat(64),
      );
      db.transaction(() =>
        acceptCrossSessionQueueMailInTransaction(db, {
          ...intent,
          messageId: 'message-2',
          commandId: 'send-2',
          requestDigest: 'c'.repeat(64),
          sourceSequence: 2,
          sourceModelInvocationId: 'model-invocation-2',
          sourceToolCallId: 'tool-2',
          sourceEffectAttemptId: 'effect-2',
        }),
      )();
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          messageId: 'message-2',
          targetRevision: 1,
          receivedAtMs: 12,
        }),
      )();
      expect(
        listQueuedCrossSessionInbox(db, 'child', 'child-run', 8).map((row) => row.messageId),
      ).toEqual(['message-2']);
      expect(
        db
          .transaction(() =>
            prepareCrossSessionQueueMailInputInTransaction(db, {
              targetSessionId: 'child',
              targetRevision: 1,
              currentRunId: 'child-run',
              modelInvocationId: 'model-prepare',
              modelAdmissionId: 'admission-prepare',
            }),
          )()
          .map((row) => row.messageId),
      ).toEqual(['message-2']);
      expect(readCrossSessionPreparedThrough(db, 'child', 'child-run')).toBe(2);
      expect(readCrossSessionInboxReceipt(db, 'child', 'message-1')?.messageId).toBe('message-1');
    } finally {
      db.close();
    }
  });
  test('child source requires its exact sealed grant, active origin and owner generation', () => {
    const db = fixture();
    try {
      const grant = sealChildGrantPayload({
        childInvocationId: 'child-invocation',
        grantId: 'grant-1',
      });
      db.query(`UPDATE runtime_runs SET origin_session_id='parent',origin_run_id='run-1'
        WHERE session_id='child' AND run_id='child-run'`).run();
      db.query(`INSERT INTO subagent_task_artifacts(artifact_id,kind,integrity_identifier,
        artifact_format_version,canonical_json,byte_length,created_at)
        VALUES (?,'subagent_task',?,1,'{}',2,1)`).run(
        `pa_${'1'.repeat(64)}`,
        `sha256:${'1'.repeat(64)}`,
      );
      db.query(`INSERT INTO child_session_intents(
        child_thread_id,parent_session_id,parent_invocation_id,origin_run_id,origin_turn_id,
        origin_tool_call_id,attempt,child_invocation_id,grant_digest,sealed_grant_json,
        sealed_grant_byte_length,sealed_grant_digest,task_artifact_digest,task_text_digest,
        task_artifact_id,task_artifact_byte_length,disposition,role,tool_event_id,
        tool_event_revision,funding_run_id,delegated_reservation_id,
        delegated_upper_bound_digest,delegated_upper_bound_json,deadline_at,
        child_budget_activated_run_id,dispatch_ack_event_id,dispatch_ack_revision)
        VALUES ('child','parent','parent-invocation','run-1','turn-1','spawn-tool',1,
        'child-invocation',?,?,?,?,'task-digest','text-digest',?,2,'required','code',
        'tool-event',1,'run-1','reservation','budget-digest','{}',
        '2099-01-01T00:00:00.000Z','child-run','dispatch-ack',1)`).run(
        grant.sealedGrantDigest,
        grant.sealedGrantJson,
        grant.sealedGrantByteLength,
        grant.sealedGrantDigest,
        `pa_${'1'.repeat(64)}`,
      );
      db.query(`INSERT INTO runtime_command_receipts(scope_session_id,command_id,workspace_id,
        project_id,workspace_digest,request_digest,target_session_id,original_receipt_json,
        committed_revision,committed_at)
        VALUES ('child','child-send','workspace-1','project-1','digest-1',?,'child','{}',1,10)`).run(
        'b'.repeat(64),
      );
      db.query("INSERT INTO kite_meta(key,value) VALUES ('session_execution/child',?)").run(
        JSON.stringify({ status: 'active', controllerGeneration: 1 }),
      );
      const childIntent = {
        ...intent,
        sourceSessionId: 'child',
        targetSessionId: 'parent',
        messageId: 'child-message',
        commandId: 'child-send',
        requestDigest: 'b'.repeat(64),
        sourceRunId: 'child-run',
        sourceTaskId: 'child-invocation',
        sourceOwnerGeneration: 1,
        sourceSnapshot: {
          activeTaskId: 'child-invocation',
          childSessionOrigin: {
            parentSessionId: 'parent',
            childInvocationId: 'child-invocation',
            grantDigest: grant.sealedGrantDigest,
            taskInputAdmitted: true,
          },
        },
      };
      expect(() =>
        db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, childIntent))(),
      ).toThrow(KiteCrossSessionAgentMailError);
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionQueueMailInTransaction(db, {
            ...childIntent,
            sourceGrantId: 'wrong',
            sourceGrantDigest: grant.sealedGrantDigest,
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionQueueMailInTransaction(db, {
            ...childIntent,
            sourceGrantId: 'grant-1',
            sourceGrantDigest: grant.sealedGrantDigest,
            sourceOwnerGeneration: 2,
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionQueueMailInTransaction(db, {
            ...childIntent,
            sourceGrantId: 'grant-1',
            sourceGrantDigest: grant.sealedGrantDigest,
            sourceSnapshot: { ...childIntent.sourceSnapshot, activeTaskId: 'other-task' },
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
      const accepted = db.transaction(() =>
        acceptCrossSessionQueueMailInTransaction(db, {
          ...childIntent,
          sourceGrantId: 'grant-1',
          sourceGrantDigest: grant.sealedGrantDigest,
        }),
      )();
      expect(accepted.sourceGrantId).toBe('grant-1');
      expect(accepted.targetRunId).toBe('run-1');
      expect(readUnreadDirectChildMail(db, 'parent', 'run-1', 'child')).toEqual({
        count: 0,
        throughSequence: 0,
      });
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'child',
          targetSessionId: 'parent',
          messageId: 'child-message',
          targetRevision: 1,
          receivedAtMs: 11,
        }),
      )();
      expect(readUnreadDirectChildMail(db, 'parent', 'run-1', 'child')).toEqual({
        count: 1,
        throughSequence: 1,
      });
      expect(readDirectChildInboxWatermark(db, 'parent', 'run-1')).toEqual({
        unreadCount: 1,
        throughSequence: 1,
      });
      expect(readUnreadDirectChildMail(db, 'parent', 'old-run', 'child').count).toBe(0);
      expect(() => readUnreadDirectChildMail(db, 'parent', 'run-1', 'other-child')).toThrow(
        KiteCrossSessionAgentMailError,
      );
      db.run(
        "UPDATE agent_mail_inbox SET prepared_invocation_id='model-1',prepared_model_admission_id='admission-1' WHERE target_session_id='parent'",
      );
      expect(readDirectChildInboxWatermark(db, 'parent', 'run-1').unreadCount).toBe(0);
    } finally {
      db.close();
    }
  });
  test('keeps idle-target mail outside the next Run model input', () => {
    const db = fixture();
    try {
      db.query(
        "UPDATE agent_nodes SET status='idle',current_task_id=NULL WHERE session_id='child'",
      ).run();
      const outbox = db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, intent))();
      expect(outbox.targetRunId).toBeNull();
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          messageId: 'message-1',
          targetRevision: 1,
          receivedAtMs: 11,
        }),
      )();
      expect(readCrossSessionInboxReceipt(db, 'child', 'message-1')?.targetRunId).toBeNull();
      db.query(
        "UPDATE agent_nodes SET status='active',current_task_id='child-run' WHERE session_id='child'",
      ).run();
      expect(listQueuedCrossSessionInbox(db, 'child', 'child-run', 8)).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('does not deliver an old Run binding to a successor Run', () => {
    const db = fixture();
    try {
      expect(
        db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, intent))().targetRunId,
      ).toBe('child-run');
      db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          messageId: 'message-1',
          targetRevision: 1,
          receivedAtMs: 11,
        }),
      )();
      db.query(
        "UPDATE runtime_runs SET status='completed',finished_at_ms=2,terminal_json='{}' WHERE session_id='child' AND run_id='child-run'",
      ).run();
      db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
        created_revision,last_revision,created_at_ms,started_at_ms)
        VALUES ('child','child-run-2','child-start-2','building','running',1,1,2,2)`).run();
      db.query(
        "UPDATE agent_nodes SET current_task_id='child-run-2' WHERE session_id='child'",
      ).run();
      expect(listQueuedCrossSessionInbox(db, 'child', 'child-run-2', 8)).toEqual([]);
      expect(() => listQueuedCrossSessionInbox(db, 'child', 'child-run', 8)).toThrow(
        KiteCrossSessionAgentMailError,
      );
    } finally {
      db.close();
    }
  });
  test('accepts one source artifact, idempotently receives, and recovers unconfirmed delivery', () => {
    const db = fixture();
    try {
      const first = db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, intent))();
      expect(first.bodyRef.byteLength).toBe(11);
      expect(first.sourceToolCallId).toBe('tool-1');
      expect(first.sourceTaskId).toBe('task-1');
      expect(first.targetRunId).toBe('child-run');
      expect(first.deliveredTargetRevision).toBeNull();
      expect(
        listPendingCrossSessionQueueMail(db, 'parent', 10).map((mail) => mail.messageId),
      ).toEqual(['message-1']);
      expect(listPendingCrossSessionQueueMailSources(db, 10)).toEqual(['parent']);
      expect(listPendingCrossSessionQueueMailSources(db, 10, 'parent')).toEqual([]);
      expect(db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, intent))()).toEqual(
        first,
      );
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionQueueMailInTransaction(db, {
            ...intent,
            sourceEffectAttemptId: 'different-attempt',
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail_bodies').get()
          ?.count,
      ).toBe(1);
      const receipt = db.transaction(() =>
        receiveCrossSessionQueueMailInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          messageId: 'message-1',
          targetRevision: 1,
          receivedAtMs: 11,
        }),
      )();
      expect(receipt).toEqual({ sequence: 1, targetRevision: 1 });
      expect(nextCrossSessionTargetSequence(db, 'child')).toBe(2);
      expect(readCrossSessionInboxReceipt(db, 'child', 'message-1')).toEqual({
        targetSessionId: 'child',
        sourceSessionId: 'parent',
        targetRunId: 'child-run',
        messageId: 'message-1',
        sequence: 1,
        targetRevision: 1,
        receivedAtMs: 11,
      });
      expect(readCrossSessionInboxReceipt(db, 'other-child', 'message-1')).toBeNull();
      expect(listQueuedCrossSessionInbox(db, 'child', 'child-run', 8)).toEqual([
        {
          messageId: 'message-1',
          sequence: 1,
          sourceSessionId: 'parent',
          targetRunId: 'child-run',
          sourceRunId: 'run-1',
          sourceTurnId: 'turn-1',
          sourceModelInvocationId: 'model-invocation-1',
          sourceToolCallId: 'tool-1',
          sourceEffectAttemptId: 'effect-1',
          sourceTaskId: 'task-1',
          bodyText: 'hello child',
        },
      ]);
      expect(
        db.transaction(() =>
          receiveCrossSessionQueueMailInTransaction(db, {
            sourceSessionId: 'parent',
            targetSessionId: 'child',
            messageId: 'message-1',
            targetRevision: 1,
            receivedAtMs: 12,
          }),
        )(),
      ).toEqual(receipt);
      expect(readReceivedCrossSessionMailBody(db, 'child', 'message-1')).toBe('hello child');
      expect(readCrossSessionPreparedThrough(db, 'child', 'child-run')).toBe(0);
      expect(readReceivedCrossSessionMailBody(db, 'other-child', 'message-1')).toBeNull();
      expect(
        db
          .query<{ prepared_invocation_id: string | null }, []>(
            'SELECT prepared_invocation_id FROM agent_mail_inbox',
          )
          .get()?.prepared_invocation_id,
      ).toBeNull();
      const prepared = db.transaction(() =>
        prepareCrossSessionQueueMailInputInTransaction(db, {
          targetSessionId: 'child',
          targetRevision: 1,
          currentRunId: 'child-run',
          modelInvocationId: 'model-1',
          modelAdmissionId: 'admission-1',
        }),
      )();
      expect(prepared).toEqual([
        {
          messageId: 'message-1',
          sequence: 1,
          sourceSessionId: 'parent',
          bodyText: 'hello child',
        },
      ]);
      expect(listQueuedCrossSessionInbox(db, 'child', 'child-run', 8)).toEqual([]);
      expect(readCrossSessionPreparedThrough(db, 'child', 'child-run')).toBe(1);
      expect(
        db.transaction(() =>
          prepareCrossSessionQueueMailInputInTransaction(db, {
            targetSessionId: 'child',
            targetRevision: 1,
            currentRunId: 'child-run',
            modelInvocationId: 'model-1',
            modelAdmissionId: 'admission-1',
          }),
        )(),
      ).toEqual(prepared);
      expect(
        db.transaction(() =>
          confirmCrossSessionQueueMailInTransaction(db, {
            sourceSessionId: 'parent',
            messageId: 'message-1',
          }),
        )().deliveredTargetRevision,
      ).toBe(1);
      expect(listPendingCrossSessionQueueMail(db, 'parent', 10)).toEqual([]);
      expect(listPendingCrossSessionQueueMailSources(db, 10)).toEqual([]);
      expect(
        db.query<{ count: number }, []>('SELECT count(*) AS count FROM agent_mail_inbox').get()
          ?.count,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  test('requires exact lineage, workspace, receipt, revision, and a live source', () => {
    const db = fixture();
    try {
      expect(() => acceptCrossSessionQueueMailInTransaction(db, intent)).toThrow(
        KiteCrossSessionAgentMailError,
      );
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionQueueMailInTransaction(db, {
            ...intent,
            targetSessionId: 'other-child',
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionQueueMailInTransaction(db, {
            ...intent,
            sourceRevision: 2,
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionQueueMailInTransaction(db, {
            ...intent,
            requestDigest: 'b'.repeat(64),
          }),
        )(),
      ).toThrow(KiteCrossSessionAgentMailError);
      db.query("UPDATE agent_nodes SET status='idle' WHERE session_id='parent'").run();
      expect(() =>
        db.transaction(() => acceptCrossSessionQueueMailInTransaction(db, intent))(),
      ).toThrow(KiteCrossSessionAgentMailError);
      expect(listPendingCrossSessionQueueMail(db, 'parent', 10)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
