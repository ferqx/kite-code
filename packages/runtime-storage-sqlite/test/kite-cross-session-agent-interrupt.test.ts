import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  acceptCrossSessionInterruptInTransaction,
  acknowledgeCrossSessionInterruptInTransaction,
  assertNoQueuedInterruptBeforeChildActivation,
  listPendingCrossSessionInterrupts,
  listPendingCrossSessionInterruptTargets,
  readCrossSessionInterruptIntent,
  readCrossSessionInterruptTarget,
  settleCrossSessionInterruptInTransaction,
  settleQueuedCrossSessionInterruptInTransaction,
} from '../src/kite-cross-session-agent-interrupt';
import { initializeKiteSessionStoreIfNeeded } from '../src/kite-home-store';

const requestDigest = 'a'.repeat(64);
const sourceState = {
  turn: { turnId: 'parent-run', status: 'active' },
  tools: {
    active: ['tool-1'],
    calls: {
      'tool-1': {
        name: 'interrupt_agent',
        args: { agent_id: 'child' },
        modelInvocationId: 'model-1',
        status: 'running',
        createdAtTurnId: 'parent-run',
      },
    },
  },
  capabilities: {
    invocations: {
      'inv-1': {
        invocationId: 'inv-1',
        toolCallId: 'tool-1',
        status: 'running',
        capabilityId: 'builtin:interrupt_agent',
        attemptsStarted: 1,
      },
    },
  },
};
const childState = {
  childSessionOrigin: { parentSessionId: 'parent', childInvocationId: 'task-1' },
  turn: { turnId: 'child-run', status: 'active' },
  activeTaskId: 'task-1',
};
const intent = {
  sourceSessionId: 'parent',
  commandId: 'interrupt-1',
  requestDigest,
  sourceRunId: 'parent-run',
  sourceTurnId: 'parent-run',
  sourceModelInvocationId: 'model-1',
  sourceToolCallId: 'tool-1',
  sourceEffectAttemptId: 'inv-1:attempt:1',
  sourceRevision: 2,
  targetSessionId: 'child',
  targetRunId: 'child-run',
  targetTaskId: 'task-1',
  targetOwnerGeneration: 2,
  targetRevision: 3,
  createdAtMs: 20,
} as const;

function snapshot(db: Database, sessionId: string, revision: number, state: object): void {
  db.query('UPDATE runtime_sessions SET revision=? WHERE session_id=?').run(revision, sessionId);
  db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,state_json,event_position,state_checksum,created_at)
    VALUES (?,27,'test',?,?,0,'test',1)
    ON CONFLICT(session_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json`).run(
    sessionId,
    revision,
    JSON.stringify(state),
  );
}
function fixture(): Database {
  const db = new Database(':memory:', { strict: true });
  initializeKiteSessionStoreIfNeeded(db);
  db.query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,display_name,created_at,updated_at)
    VALUES ('workspace','/workspace',?,'project','workspace-digest','',1,1)`).run(
    `sha256:${'b'.repeat(64)}`,
  );
  const insert =
    db.query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,name,updated_at,run_index_from_revision,parent_session_id)
    VALUES (?,'workspace','project','workspace-digest',27,'test',0,'',1,0,?)`);
  insert.run('parent', null);
  insert.run('child', 'parent');
  insert.run('sibling', 'parent');
  const run =
    db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,created_revision,last_revision,created_at_ms,started_at_ms)
    VALUES (?,?,?,'building','running',1,1,1,1)`);
  run.run('parent', 'parent-run', 'start-parent');
  run.run('child', 'child-run', 'start-child');
  snapshot(db, 'parent', 2, sourceState);
  snapshot(db, 'child', 3, childState);
  snapshot(db, 'sibling', 1, {
    ...childState,
    childSessionOrigin: { parentSessionId: 'parent', childInvocationId: 'sibling-task' },
    activeTaskId: 'sibling-task',
  });
  db.query(`INSERT INTO kite_meta(key,value) VALUES (?,?)`).run(
    'session_execution/child',
    JSON.stringify({ status: 'active', controllerGeneration: 2 }),
  );
  db.query(`INSERT INTO runtime_command_receipts(scope_session_id,command_id,workspace_id,project_id,workspace_digest,request_digest,target_session_id,original_receipt_json,committed_revision,committed_at)
    VALUES ('parent','interrupt-1','workspace','project','workspace-digest',?,'parent','{}',2,20)`).run(
    requestDigest,
  );
  return db;
}

describe('Store13 exact cross-Session interrupt intent', () => {
  test('receipt, current direct-child Run and generation are fixed; target ack and cleanup settle once', () => {
    const db = fixture();
    try {
      expect(readCrossSessionInterruptTarget(db, 'parent', 'child')).toEqual({
        targetSessionId: 'child',
        status: 'active',
        targetRunId: 'child-run',
        targetTaskId: 'task-1',
        targetOwnerGeneration: 2,
        targetRevision: 3,
      });
      db.transaction(() => acceptCrossSessionInterruptInTransaction(db, intent))();
      expect(readCrossSessionInterruptIntent(db, 'parent', 'interrupt-1')?.status).toBe('pending');
      expect(listPendingCrossSessionInterrupts(db, 'child', 8)).toHaveLength(1);
      expect(listPendingCrossSessionInterruptTargets(db, 8)).toEqual(['child']);
      expect(listPendingCrossSessionInterruptTargets(db, 8, 'child')).toEqual([]);
      db.transaction(() => acceptCrossSessionInterruptInTransaction(db, intent))();
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionInterruptInTransaction(db, { ...intent, targetRunId: 'sibling-run' }),
        )(),
      ).toThrow();
      snapshot(db, 'child', 4, childState);
      db.transaction(() =>
        acknowledgeCrossSessionInterruptInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          commandId: 'interrupt-1',
          targetGeneration: 2,
          targetRevision: 4,
          event: {
            type: 'background_execution.stop_requested',
            commandId: 'interrupt-1',
            executionId: 'task-1',
            executionKind: 'subagent',
            ownerGeneration: 'child:2',
          },
        }),
      )();
      expect(readCrossSessionInterruptIntent(db, 'parent', 'interrupt-1')?.status).toBe('accepted');
      db.query(
        "UPDATE runtime_runs SET status='cancelled',finished_at_ms=21,terminal_json='{}' WHERE session_id='child' AND run_id='child-run'",
      ).run();
      snapshot(db, 'child', 5, {
        ...childState,
        turn: { turnId: 'child-run', status: 'completed' },
        activeTaskId: null,
      });
      db.transaction(() =>
        settleCrossSessionInterruptInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          commandId: 'interrupt-1',
          targetGeneration: 2,
          targetRevision: 5,
          event: {
            type: 'background_execution.stop_settled',
            commandId: 'interrupt-1',
            executionId: 'task-1',
            cleanupConfirmed: true,
          },
        }),
      )();
      expect(readCrossSessionInterruptIntent(db, 'parent', 'interrupt-1')?.status).toBe('settled');
      expect(listPendingCrossSessionInterrupts(db, 'child', 8)).toHaveLength(0);
      expect(listPendingCrossSessionInterruptTargets(db, 8)).toEqual([]);
    } finally {
      db.close();
    }
  });
  test('sibling, stale target and false cleanup fail closed; final race becomes idle', () => {
    const db = fixture();
    try {
      expect(readCrossSessionInterruptTarget(db, 'child', 'sibling')).toBeNull();
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionInterruptInTransaction(db, { ...intent, targetSessionId: 'sibling' }),
        )(),
      ).toThrow();
      expect(() =>
        db.transaction(() =>
          acceptCrossSessionInterruptInTransaction(db, { ...intent, targetRevision: 2 }),
        )(),
      ).toThrow();
      db.transaction(() => acceptCrossSessionInterruptInTransaction(db, intent))();
      expect(() =>
        acknowledgeCrossSessionInterruptInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          commandId: 'interrupt-1',
          targetGeneration: 3,
          targetRevision: 3,
          event: {
            type: 'background_execution.stop_requested',
            commandId: 'interrupt-1',
            executionId: 'task-1',
            executionKind: 'subagent',
            ownerGeneration: 'child:3',
          },
        }),
      ).toThrow();
      db.query(
        "UPDATE runtime_runs SET status='completed',finished_at_ms=22 WHERE session_id='child' AND run_id='child-run'",
      ).run();
      snapshot(db, 'child', 4, {
        ...childState,
        turn: { turnId: 'child-run', status: 'completed' },
        activeTaskId: null,
      });
      db.transaction(() =>
        acknowledgeCrossSessionInterruptInTransaction(db, {
          sourceSessionId: 'parent',
          targetSessionId: 'child',
          commandId: 'interrupt-1',
          targetGeneration: 2,
          targetRevision: 4,
          event: {
            type: 'background_execution.stop_unknown',
            commandId: 'interrupt-1',
            executionId: 'task-1',
            reason: 'target_already_idle',
          },
        }),
      )();
      expect(readCrossSessionInterruptIntent(db, 'parent', 'interrupt-1')?.status).toBe('idle');
    } finally {
      db.close();
    }
  });
});

test('queued child has no fabricated Run or generation and settles only from parent task-control facts', () => {
  const db = fixture();
  try {
    db.query("DELETE FROM runtime_runs WHERE session_id='child'").run();
    snapshot(db, 'child', 0, { ...childState, activeTaskId: null });
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
      delegated_upper_bound_digest,delegated_upper_bound_json,deadline_at)
      VALUES ('child','parent','parent-inv','parent-run','parent-run',
        'tool-1',1,'task-1','grant','{}',2,'sealed','task','text',
        ?,2,'required','code','queued-event',1,'parent-run','reservation',
        'budget','{}','2099-01-01T00:00:00.000Z')`).run(`pa_${'1'.repeat(64)}`);
    expect(readCrossSessionInterruptTarget(db, 'parent', 'child')).toMatchObject({
      status: 'queued',
      targetRunId: null,
      targetTaskId: 'task-1',
      targetOwnerGeneration: null,
      queuedIntentEventId: 'queued-event',
      targetRevision: 0,
    });
    snapshot(db, 'child', 0, {
      ...childState,
      activeTaskId: null,
      childSessionOrigin: { parentSessionId: 'parent', childInvocationId: 'wrong-task' },
    });
    expect(readCrossSessionInterruptTarget(db, 'parent', 'child')).toMatchObject({
      status: 'unavailable',
    });
    snapshot(db, 'child', 0, { ...childState, activeTaskId: null });
    db.run(
      "UPDATE child_session_intents SET dispatch_ack_event_id='ack' WHERE child_thread_id='child'",
    );
    expect(readCrossSessionInterruptTarget(db, 'parent', 'child')).toMatchObject({
      status: 'unavailable',
    });
    db.run(
      "UPDATE child_session_intents SET dispatch_ack_event_id=NULL WHERE child_thread_id='child'",
    );
    const queued = {
      ...intent,
      targetRunId: null,
      targetOwnerGeneration: null,
      targetRevision: 0,
      queuedIntentEventId: 'queued-event',
    };
    db.transaction(() => acceptCrossSessionInterruptInTransaction(db, queued))();
    expect(() => assertNoQueuedInterruptBeforeChildActivation(db, 'child')).toThrow();
    expect(() => assertNoQueuedInterruptBeforeChildActivation(db, 'sibling')).not.toThrow();
    expect(readCrossSessionInterruptIntent(db, 'parent', 'interrupt-1')?.status).toBe('pending');
    expect(() =>
      settleQueuedCrossSessionInterruptInTransaction(db, {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        commandId: 'interrupt-1',
        sourceRevision: 2,
        event: {
          type: 'background_execution.stop_settled',
          commandId: 'interrupt-1',
          executionId: 'task-1',
          cleanupConfirmed: true,
        },
      }),
    ).toThrow();
    db.query(
      "UPDATE child_session_intents SET failure_receipt_digest='failure' WHERE child_thread_id='child'",
    ).run();
    snapshot(db, 'parent', 3, sourceState);
    db.transaction(() =>
      settleQueuedCrossSessionInterruptInTransaction(db, {
        sourceSessionId: 'parent',
        targetSessionId: 'child',
        commandId: 'interrupt-1',
        sourceRevision: 3,
        event: {
          type: 'background_execution.stop_settled',
          commandId: 'interrupt-1',
          executionId: 'task-1',
          cleanupConfirmed: true,
        },
      }),
    )();
    expect(readCrossSessionInterruptIntent(db, 'parent', 'interrupt-1')?.status).toBe('settled');
    expect(listPendingCrossSessionInterruptTargets(db, 8)).toEqual([]);
  } finally {
    db.close();
  }
});
