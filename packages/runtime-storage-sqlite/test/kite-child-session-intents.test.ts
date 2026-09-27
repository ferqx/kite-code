import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  childDelegatedUpperBoundDigest,
  createRuntimeStoredCommandReceipt,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import {
  assertChildRecoveryDiagnosticInTransaction,
  assertChildRuntimeActivationInTransaction,
  assertChildSessionIntent,
  assertChildUnknownTerminalSealInTransaction,
  listPendingChildSessionIntents,
  persistChildSessionIntentInTransaction,
  readChildSealedGrant,
  readChildSessionIntent,
  readPendingAfterTurnChildTerminalSeal,
  recordChildDispatchAckInTransaction,
  recordChildParentSettlementInTransaction,
  settleChildCreationFailureInTransaction,
} from '../src/kite-child-session-intents';
import { createKiteHomeRuntimeStorageForConnection } from '../src/kite-home-runtime-storage';
import {
  assertKiteSessionStoreSchema,
  initializeKiteSessionStoreIfNeeded,
} from '../src/kite-home-store';

const canonicalPath = '/workspace';
const workspaceHex = createHash('sha256').update(canonicalPath).digest('hex');
const projectId = `project_${workspaceHex}`;
const workspaceDigest = `sha256:${workspaceHex}`;
const workspaceIdentityDigest = `sha256:${createHash('sha256')
  .update(
    `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath, projectId, workspaceDigest })}`,
  )
  .digest('hex')}`;
const workspaceId = `workspace_${workspaceIdentityDigest.slice(7)}`;

const childThreadId = `child_${createHash('sha256')
  .update(JSON.stringify(['kite.child-session.v1', 'root', 'invocation', 'tool-call', 1]))
  .digest('hex')}`;
const task = 'Investigate the failing test';
const taskTextDigest = `sha256:${createHash('sha256').update(task, 'utf8').digest('hex')}`;
const taskJson = JSON.stringify({
  artifactFormatVersion: 1,
  owner: {
    childInvocationId: 'child-invocation',
    parentAttempt: 1,
    parentInvocationId: 'invocation',
    parentToolCallId: 'tool-call',
  },
  task,
  taskByteLength: Buffer.byteLength(task, 'utf8'),
  taskDigest: taskTextDigest,
});
// Reference produced by Builtin's subagent-tasks private Artifact derivation.
const taskArtifactDigest =
  'sha256:59e2c5f0fcf49aecbedbb556d1569235cfa5a6657e74306f571a571685984e79';
const taskArtifactRef = {
  artifactId: 'pa_0ada5f2a62b7b69bd41ec8caa92d034b4bd51e385194edfabbf89fcd7887553e',
  kind: 'subagent_task' as const,
  integrityIdentifier: taskArtifactDigest,
  byteLength: Buffer.byteLength(taskJson, 'utf8'),
};
const sealedGrant = sealChildGrantPayload({
  purpose: 'start',
  parentInvocationId: 'invocation',
  parentToolCallId: 'tool-call',
  parentAttempt: 1,
  childInvocationId: 'child-invocation',
  role: 'explore',
  taskArtifact: taskArtifactRef,
  taskDigest: taskTextDigest,
  seal: 'private-seal',
});
const upper = {
  counters: {
    turns: 3,
    modelRequests: 3,
    toolInvocations: 2,
    inputTokens: 100,
    outputTokens: 100,
    artifactBytes: 1000,
  },
  gauges: {
    elapsedRunMs: 10_000,
    activeSubagents: 1,
    activeWriters: 1,
    activeToolInvocations: 1,
    activeShellInvocations: 1,
  },
  source: 'versioned_upper_bound' as const,
  estimatorVersion: 'test',
};
const intent = {
  childThreadId,
  parentSessionId: 'root',
  parentInvocationId: 'invocation',
  originRunId: 'run',
  originTurnId: 'turn',
  originToolCallId: 'tool-call',
  attempt: 1,
  childInvocationId: 'child-invocation',
  grantDigest: sealedGrant.sealedGrantDigest,
  ...sealedGrant,
  taskArtifactRef,
  taskArtifactDigest,
  taskTextDigest,
  disposition: 'required' as const,
  role: 'explore' as const,
  fundingRunId: 'funding-run',
  delegatedReservationId: 'reservation',
  delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
  deadlineAt: '2026-09-24T00:00:10.000Z',
};
const reservation = {
  version: 1,
  reservationId: 'reservation',
  runId: 'funding-run',
  invocationId: `child-allotment:${childThreadId}`,
  resourceKind: 'subagent',
  executableUpperBound: upper,
  state: 'reserved',
};
const events = [
  {
    type: 'subagent.started',
    subagent: { id: 'child-invocation', role: 'explore', name: 'Child' },
  },
  {
    type: 'capability.subagent_dispatch_intent_recorded',
    invocationId: 'invocation',
    childInvocationId: 'child-invocation',
    attempt: 1,
    taskArtifact: taskArtifactRef,
  },
  { type: 'resource_budget.reserved', reservation },
  {
    type: 'subagent.child_session_intended',
    ...Object.fromEntries(
      Object.entries(intent).filter(
        ([key]) =>
          key !== 'sealedGrantJson' &&
          key !== 'sealedGrantByteLength' &&
          key !== 'sealedGrantDigest',
      ),
    ),
  },
  {
    type: 'tool.finished',
    toolCallId: 'tool-call',
    name: 'task',
    result: {
      ok: true,
      resultMeta: {
        taskId: 'child-invocation',
        taskStatus: 'running',
        taskDisposition: 'required',
      },
    },
  },
];
const metadata = events.map((_, index) => ({ eventId: `event-${index}`, revision: index + 1 }));
const snapshot = {
  resourceBudget: { status: 'active', runId: 'funding-run', deadlineAt: intent.deadlineAt },
  retainedResourceBudgets: {},
};
const transaction = { sessionId: 'root', events, metadata, snapshot, childSessionIntent: intent };

function candidate(path = ':memory:'): Database {
  const db = new Database(path, { strict: true });
  initializeKiteSessionStoreIfNeeded(db);
  db.query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,project_id,workspace_digest,display_name,created_at,updated_at)
    VALUES (?,?,?,?,?,'',1,1)`).run(
    workspaceId,
    canonicalPath,
    workspaceIdentityDigest,
    projectId,
    workspaceDigest,
  );
  db.query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,updated_at)
    VALUES ('root',?,?,?,27,'state',0,1)`).run(workspaceId, projectId, workspaceDigest);
  db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,created_revision,last_revision,created_at_ms,started_at_ms)
    VALUES ('root','run','start-run','building','running',0,0,1,1)`).run();
  db.query(`INSERT INTO subagent_task_artifacts(artifact_id,kind,integrity_identifier,artifact_format_version,canonical_json,byte_length,created_at)
    VALUES (?,'subagent_task',?,1,?,?,1)`).run(
    taskArtifactRef.artifactId,
    taskArtifactDigest,
    taskJson,
    taskArtifactRef.byteLength,
  );
  return db;
}

function childState() {
  return {
    revision: 0,
    recoveryIdentity: 'e'.repeat(64),
    session: { projectId, canonicalWorkspaceDigest: workspaceDigest },
    childSessionOrigin: {
      parentSessionId: intent.parentSessionId,
      parentInvocationId: intent.parentInvocationId,
      parentToolCallId: intent.originToolCallId,
      attempt: intent.attempt,
      childInvocationId: intent.childInvocationId,
      grantDigest: intent.grantDigest,
      role: intent.role,
      taskArtifactRef,
      taskArtifactDigest: intent.taskArtifactDigest,
      taskTextDigest: intent.taskTextDigest,
      fundingRunId: intent.fundingRunId,
      delegatedReservationId: intent.delegatedReservationId,
      delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
      deadlineAt: intent.deadlineAt,
    },
    resourceBudget: { status: 'unconfigured', reservations: {} },
  };
}

const codec = {
  encodeEvent: JSON.stringify,
  decodeEvent: (json: string) => JSON.parse(json) as { type: string },
  encodeState: JSON.stringify,
  decodeState: (json: string) => JSON.parse(json),
  snapshotMetadata: (state: ReturnType<typeof childState>) => ({
    stateRevision: state.revision,
    schemaVersion: 27,
  }),
  sessionIdentity: (state: ReturnType<typeof childState>) => state.session,
  recoveryIdentity: (state: ReturnType<typeof childState>) => state.recoveryIdentity,
  rebindForkState: (state: ReturnType<typeof childState>) => state,
};

function recordParentIntent(db: Database) {
  db.run('BEGIN IMMEDIATE');
  persistChildSessionIntentInTransaction(db, 'receipt_evidence', transaction);
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES ('root','event-4',5,27,'{"type":"tool.finished"}',1)`).run();
  db.run('COMMIT');
}

test('recovery diagnostic keeps exact pending child intent and rejects a live owner', () => {
  using db = candidate();
  recordParentIntent(db);
  const event = {
    type: 'subagent.child_recovery_required',
    parentSessionId: intent.parentSessionId,
    parentInvocationId: intent.parentInvocationId,
    childInvocationId: intent.childInvocationId,
    childThreadId,
    originToolCallId: intent.originToolCallId,
    attempt: intent.attempt,
    grantDigest: intent.grantDigest,
    diagnosticCode: 'recovery_blocked',
    observedAt: '2026-09-24T00:00:00.000Z',
  };
  const pending = {
    sessionId: 'root',
    events: [event],
    snapshot: {
      capabilities: {
        invocations: {
          [intent.parentInvocationId]: {
            subagentProviderLifecycle: {
              childSession: {
                childThreadId,
                recoveryDiagnostic: {
                  diagnosticCode: event.diagnosticCode,
                  observedAt: event.observedAt,
                },
              },
            },
          },
        },
      },
    },
  };
  expect(() =>
    assertChildRecoveryDiagnosticInTransaction(db, 'receipt_evidence', pending),
  ).not.toThrow();
  expect(readChildSessionIntent(db, childThreadId)?.parentClaimSettledEventId).toBeNull();
  expect(() => assertChildRecoveryDiagnosticInTransaction(db, 'decision', pending)).toThrow();
  expect(() =>
    assertChildRecoveryDiagnosticInTransaction(db, 'receipt_evidence', {
      ...pending,
      events: [{ ...event, attempt: 2 }],
    }),
  ).toThrow('pending exact intent');
  insertUnactivatedChild(db, 'active');
  expect(() => assertChildRecoveryDiagnosticInTransaction(db, 'receipt_evidence', pending)).toThrow(
    'live child owner',
  );
  db.query('UPDATE kite_meta SET value=? WHERE key=?').run(
    JSON.stringify({ status: 'idle' }),
    `session_execution/${childThreadId}`,
  );
  expect(() =>
    assertChildRecoveryDiagnosticInTransaction(db, 'receipt_evidence', pending),
  ).not.toThrow();
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES (?, 'sealed-diagnostic-test', 1, 27, '{"type":"subagent.child_terminal_sealed"}', 1)`).run(
    childThreadId,
  );
  expect(() => assertChildRecoveryDiagnosticInTransaction(db, 'receipt_evidence', pending)).toThrow(
    'sealed child terminal',
  );
});

function insertUnactivatedChild(db: Database, status: 'active' | 'idle') {
  db.query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,updated_at,parent_session_id)
    VALUES (?,?,?,?,27,'state',0,1,'root')`).run(
    childThreadId,
    workspaceId,
    projectId,
    workspaceDigest,
  );
  db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,state_json,event_position,state_checksum,created_at)
    VALUES (?,27,'state',0,'{}',0,'checksum',1)`).run(childThreadId);
  const authority = {
    schema: 'kite.session-execution-authority.v1',
    sessionId: childThreadId,
    status,
    controllerGeneration: status === 'idle' ? 2 : 1,
    hostInstanceId: status === 'idle' ? null : 'host',
    clientId: null,
    connectionGeneration: status === 'idle' ? 0 : 1,
    interactionGeneration: 0,
    leaseUntilMs: status === 'idle' ? null : Date.now() + 60_000,
    cleanupConfirmed: status === 'idle',
    updatedAt: 1,
    revision: 1,
  };
  db.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run(
    `session_execution/${childThreadId}`,
    JSON.stringify(authority),
  );
}

function failureTransaction(mode: 'absent_child' | 'created_unactivated' | 'activated_no_ack') {
  const failureReceiptDigest = `sha256:${'f'.repeat(64)}`;
  return {
    sessionId: 'root',
    snapshot: {},
    childCreationFailure: { parentSessionId: 'root', childThreadId, failureReceiptDigest, mode },
    events: [
      { type: 'resource_budget.released', reservationId: intent.delegatedReservationId },
      {
        type: 'subagent.child_creation_failed',
        parentInvocationId: intent.parentInvocationId,
        childInvocationId: intent.childInvocationId,
        childThreadId,
        failureReceiptDigest,
        mode,
        resultRef: { artifactId: 'artifact', integrityIdentifier: failureReceiptDigest },
      },
      {
        type: 'subagent.background_result_persisted',
        taskId: intent.childInvocationId,
        artifactIntegrityIdentifier: failureReceiptDigest,
        originRunId: intent.originRunId,
        originTurnId: intent.originTurnId,
        originToolCallId: intent.originToolCallId,
        attempt: intent.attempt,
        childTerminalStatus: 'failed',
      },
    ],
  };
}

function insertActivatedChild(db: Database) {
  insertUnactivatedChild(db, 'idle');
  db.query('UPDATE runtime_sessions SET revision=5 WHERE session_id=?').run(childThreadId);
  db.query('UPDATE runtime_snapshots SET revision=5,event_position=5 WHERE session_id=?').run(
    childThreadId,
  );
  const activationEvents = [
    {
      type: 'subagent.child_session_adopted',
      parentSessionId: 'root',
      parentInvocationId: intent.parentInvocationId,
      parentToolCallId: intent.originToolCallId,
      attempt: intent.attempt,
      childInvocationId: intent.childInvocationId,
      grantDigest: intent.grantDigest,
      fundingRunId: intent.fundingRunId,
      delegatedReservationId: intent.delegatedReservationId,
      delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
      deadlineAt: intent.deadlineAt,
    },
    {
      type: 'subagent.child_task_input_admitted',
      childInvocationId: intent.childInvocationId,
      taskArtifactRef,
      taskDigest: intent.taskArtifactDigest,
      taskTextDigest: intent.taskTextDigest,
      grantDigest: intent.grantDigest,
    },
    { type: 'resource_budget.configured', runId: 'child-run' },
    { type: 'turn.started', turnId: 'child-run' },
    {
      type: 'task.started',
      taskId: intent.childInvocationId,
      turnId: 'child-run',
      userGoal: 'Complete the delegated task.',
    },
  ];
  const insert =
    db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES (?,?,?,27,?,1)`);
  for (const [index, event] of activationEvents.entries())
    insert.run(childThreadId, `child-event-${index + 1}`, index + 1, JSON.stringify(event));
  db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,created_revision,last_revision,created_at_ms)
    VALUES (?,'child-run','child-start','building','queued',5,5,1)`).run(childThreadId);
  db.query(`UPDATE child_session_intents SET child_budget_activated_run_id='child-run',
    child_budget_activated_event_id='child-event-3',child_budget_activated_revision=3
    WHERE child_thread_id=?`).run(childThreadId);
}

test('parent intent accepts exact Tool terminal, delegated reservation and immutable child ceiling', () => {
  using db = candidate();
  recordParentIntent(db);
  const { sealedGrantJson: _privateGrant, ...metadataIntent } = intent;
  expect(readChildSessionIntent(db, childThreadId)).toMatchObject({
    ...metadataIntent,
    toolEventId: 'event-4',
    toolEventRevision: 5,
  });
  expect(listPendingChildSessionIntents(db, 'root', 1).entries).toMatchObject([
    { childThreadId, childSessionCreated: false, taskTextDigest },
  ]);
  expect(JSON.stringify(readChildSessionIntent(db, childThreadId))).not.toContain(
    'sealedGrantJson',
  );
  expect(JSON.stringify(listPendingChildSessionIntents(db, 'root', 1))).not.toContain(
    'private-seal',
  );
  expect(readChildSealedGrant(db, 'root', childThreadId)).toEqual(sealedGrant);
  expect(readChildSealedGrant(db, 'another-parent', childThreadId)).toBeNull();
  expect(listPendingChildSessionIntents(db, 'root', 1, childThreadId).entries).toEqual([]);
  expect(() => assertChildSessionIntent(db, intent, childState())).not.toThrow();
  expect(() =>
    assertChildSessionIntent(db, intent, {
      ...childState(),
      resourceBudget: { status: 'active', deadlineAt: intent.deadlineAt },
    }),
  ).toThrow('not exact');
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', transaction),
  ).not.toThrow();
  expect(() =>
    assertChildSessionIntent(
      db,
      { ...intent, grantDigest: `sha256:${'c'.repeat(64)}` },
      childState(),
    ),
  ).toThrow('exact');
});

test('child creation and exact replay use one Session/controller/recovery transaction', () => {
  using db = candidate();
  recordParentIntent(db);
  const owner = createKiteHomeRuntimeStorageForConnection({
    database: db,
    assertStoreSchema: assertKiteSessionStoreSchema,
    codec,
    stateSchemaVersion: 27,
    formatEpoch: 'state',
  });
  const input = {
    childSessionIntent: intent,
    runtime: {
      sessionId: childThreadId,
      events: [],
      snapshot: childState(),
      commandReceipt: createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: childThreadId,
          commandId: 'create-child',
          requestDigest: 'c'.repeat(64),
          targetSessionId: childThreadId,
          committedAt: Date.now(),
        },
        0,
      ),
    },
    controller: {
      sessionId: childThreadId,
      requestId: 'controller-child',
      requestDigest: 'c'.repeat(64),
      clientId: 'client',
      connectionGeneration: 1,
      workerInstanceId: 'host',
      resumeSecret: Buffer.from(
        Uint8Array.from({ length: 32 }, (_, index) => (7 + index * 37) % 256),
      ).toString('base64url'),
      resumeExpiresAtMs: Date.now() + 60_000,
      executionLeaseUntilMs: Date.now() + 60_000,
    },
    recoveryIdentity: 'e'.repeat(64),
  } as const;
  const creation = owner.sessionCreationForWorkspace(workspaceId);
  expect(() =>
    creation.create({
      ...input,
      runtime: { ...input.runtime, snapshot: { ...childState(), childSessionOrigin: undefined } },
    }),
  ).toThrow();
  expect(owner.readSessionLineage(childThreadId)).toBeNull();
  expect(creation.create(input).status).toBe('applied');
  expect(owner.readSessionLineage(childThreadId)).toEqual({ parentSessionId: 'root' });
  expect(listPendingChildSessionIntents(db, 'root', 1).entries[0]?.childSessionCreated).toBe(true);
  expect(creation.create(input).status).toBe('replay');
  expect(() =>
    creation.create({
      ...input,
      childSessionIntent: { ...intent, grantDigest: `sha256:${'d'.repeat(64)}` },
    }),
  ).toThrow();
  expect(
    db
      .query<{ count: number }, [string]>(
        'SELECT count(*) AS count FROM runtime_sessions WHERE parent_session_id = ?',
      )
      .get(childThreadId)?.count ?? 0,
  ).toBe(0);
  owner.close();
});

test('missing or conflicting receipt evidence never writes a child intent', () => {
  using db = candidate();
  expect(() => persistChildSessionIntentInTransaction(db, 'decision', transaction)).toThrow();
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...transaction,
      childSessionIntent: { ...intent, disposition: 'after_turn' },
    }),
  ).toThrow();
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...transaction,
      childSessionIntent: { ...intent, role: 'code' },
    }),
  ).toThrow();
  const wrongTextDigest = `sha256:${'d'.repeat(64)}`;
  const wrongSealed = sealChildGrantPayload({
    ...JSON.parse(intent.sealedGrantJson),
    taskDigest: wrongTextDigest,
  });
  const wrongTextIntent = {
    ...intent,
    taskTextDigest: wrongTextDigest,
    grantDigest: wrongSealed.sealedGrantDigest,
    ...wrongSealed,
  };
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...transaction,
      childSessionIntent: wrongTextIntent,
      events: events.map((event) =>
        event.type === 'subagent.child_session_intended' ? { ...event, ...wrongTextIntent } : event,
      ),
    }),
  ).toThrow('Task Artifact owner or task digest');
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...transaction,
      childSessionIntent: { ...intent, sealedGrantByteLength: intent.sealedGrantByteLength + 1 },
    }),
  ).toThrow('sealed grant');
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...transaction,
      childSessionIntent: { ...intent, sealedGrantJson: '{"purpose":"start"}' },
    }),
  ).toThrow('sealed grant');
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...transaction,
      childSessionIntent: {
        ...intent,
        sealedGrantJson: JSON.stringify({ extra: 'x'.repeat(128 * 1024) }),
      },
    }),
  ).toThrow();
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...transaction,
      events: events.filter((event) => event.type !== 'resource_budget.reserved'),
    }),
  ).toThrow();
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...transaction,
      events: events.map((event) =>
        event.type === 'tool.finished'
          ? {
              ...event,
              result: {
                ok: true,
                resultMeta: {
                  taskId: 'child-invocation',
                  taskStatus: 'completed',
                  taskDisposition: 'required',
                },
              },
            }
          : event,
      ),
    }),
  ).toThrow();
  expect(readChildSessionIntent(db, childThreadId)).toBeNull();
});

test('after_turn intent requires an exact report reserve and ACKs from a completed funding Run', () => {
  const deadlineAt = '2099-01-01T00:00:00.000Z';
  const afterTurnIntent = { ...intent, disposition: 'after_turn' as const, deadlineAt };
  const report = {
    ...reservation,
    reservationId: 'after-turn-report',
    invocationId: `model-invocation:after-turn:${intent.childInvocationId}`,
    resourceKind: 'model',
    executableUpperBound: {
      ...upper,
      counters: { ...upper.counters, modelRequests: 1, inputTokens: 10, outputTokens: 10 },
      gauges: { ...upper.gauges, activeSubagents: 0, activeWriters: 0 },
    },
  };
  const receiptEvents = [
    ...events.slice(0, 3),
    { type: 'resource_budget.reserved', reservation: report },
    {
      ...events[3]!,
      disposition: 'after_turn',
      deadlineAt,
    },
    {
      ...events[4]!,
      result: {
        ok: true,
        resultMeta: {
          taskId: intent.childInvocationId,
          taskStatus: 'running',
          taskDisposition: 'after_turn',
        },
      },
    },
  ];
  const receipt = {
    ...transaction,
    events: receiptEvents,
    metadata: receiptEvents.map((_, index) => ({
      eventId: `after-event-${index}`,
      revision: index + 1,
    })),
    childSessionIntent: afterTurnIntent,
    snapshot: {
      resourceBudget: {
        status: 'active',
        runId: intent.fundingRunId,
        deadlineAt,
        reservations: {
          [intent.delegatedReservationId]: reservation,
          [report.reservationId]: report,
        },
      },
      retainedResourceBudgets: {},
    },
  };
  using db = candidate();
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...receipt,
      events: receiptEvents.filter((event) => event !== receiptEvents[3]),
    }),
  ).toThrow('incomplete or ambiguous');
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...receipt,
      events: receiptEvents.map((event, index) =>
        index === 3
          ? { ...event, reservation: { ...report, invocationId: 'model-invocation:other' } }
          : event,
      ),
    }),
  ).toThrow('incomplete or ambiguous');
  expect(() =>
    persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
      ...receipt,
      events: receiptEvents.map((event, index) =>
        index === 5
          ? { ...event, result: { ok: true, resultMeta: { taskDisposition: 'required' } } }
          : event,
      ),
    }),
  ).toThrow('does not match');
  persistChildSessionIntentInTransaction(db, 'receipt_evidence', receipt);
  expect(readChildSessionIntent(db, childThreadId)?.disposition).toBe('after_turn');
  db.query(
    "UPDATE runtime_runs SET status='completed',finished_at_ms=2,terminal_json='{}' WHERE session_id='root' AND run_id='run'",
  ).run();
  const ack = {
    parentSessionId: 'root',
    childThreadId,
    originRunId: 'run',
    originToolCallId: 'tool-call',
    delegatedReservationId: intent.delegatedReservationId,
  };
  const ackTransaction = {
    sessionId: 'root',
    events: [
      { type: 'resource_budget.dispatch_started', reservationId: intent.delegatedReservationId },
    ],
    metadata: [{ eventId: 'after-ack', revision: 7 }],
    childDispatchAck: ack,
    snapshot: {
      resourceBudget: { status: 'unconfigured' },
      retainedResourceBudgets: {
        [intent.fundingRunId]: {
          status: 'active',
          runId: intent.fundingRunId,
          deadlineAt,
          reservations: {
            [intent.delegatedReservationId]: { ...reservation, state: 'dispatch_started' },
            [report.reservationId]: report,
          },
        },
      },
    },
  };
  expect(() =>
    recordChildDispatchAckInTransaction(db, 'receipt_evidence', {
      ...ackTransaction,
      snapshot: {
        ...ackTransaction.snapshot,
        retainedResourceBudgets: {
          [intent.fundingRunId]: {
            ...ackTransaction.snapshot.retainedResourceBudgets[intent.fundingRunId],
            deadlineAt: '2000-01-01T00:00:00.000Z',
          },
        },
      },
    }),
  ).toThrow('exact delegated reservation');
  recordChildDispatchAckInTransaction(db, 'receipt_evidence', ackTransaction);
  expect(readChildSessionIntent(db, childThreadId)?.dispatchAckEventId).toBe('after-ack');
  expect(readPendingAfterTurnChildTerminalSeal(db, 'root', childThreadId)).toBeNull();
  insertUnactivatedChild(db, 'idle');
  db.query(`UPDATE child_session_intents SET child_budget_activated_run_id='child-run'
    WHERE child_thread_id=?`).run(childThreadId);
  const seal = {
    type: 'subagent.child_terminal_sealed',
    status: 'unknown',
    cleanupConfirmed: false,
    terminalReceiptId: 'terminal-receipt',
    resultRef: taskArtifactRef,
  };
  const sealedStateJson = JSON.stringify({
    childSessionOrigin: {
      parentSessionId: 'root',
      parentInvocationId: intent.parentInvocationId,
      childInvocationId: intent.childInvocationId,
      taskInputAdmitted: true,
      fundingRunId: intent.fundingRunId,
      delegatedReservationId: intent.delegatedReservationId,
      terminal: seal,
    },
    terminalOutcome: { status: 'unknown', knownExternalEffects: 'unknown' },
    resourceBudget: { status: 'active' },
    turn: { status: 'aborted' },
  });
  db.query('UPDATE runtime_snapshots SET state_json=? WHERE session_id=?').run(
    sealedStateJson,
    childThreadId,
  );
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES (?,'sealed-after-turn',8,27,?,1)`).run(childThreadId, JSON.stringify(seal));
  expect(readPendingAfterTurnChildTerminalSeal(db, 'root', childThreadId)).toMatchObject({
    childThreadId,
    parentInvocationId: 'invocation',
    childInvocationId: 'child-invocation',
    status: 'unknown',
    sealEventId: 'sealed-after-turn',
    sealRevision: 8,
  });
  expect(readPendingAfterTurnChildTerminalSeal(db, 'wrong-parent', childThreadId)).toBeNull();
  db.query('UPDATE runtime_snapshots SET state_json=? WHERE session_id=?').run('{}', childThreadId);
  expect(() => readPendingAfterTurnChildTerminalSeal(db, 'root', childThreadId)).toThrow(
    'terminal seal is invalid',
  );
  db.query('UPDATE runtime_snapshots SET state_json=? WHERE session_id=?').run(
    sealedStateJson,
    childThreadId,
  );
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES (?,'duplicate-seal',9,27,?,1)`).run(childThreadId, JSON.stringify(seal));
  expect(() => readPendingAfterTurnChildTerminalSeal(db, 'root', childThreadId)).toThrow(
    'ambiguous terminal seals',
  );
  db.query("DELETE FROM runtime_events WHERE session_id=? AND event_id='duplicate-seal'").run(
    childThreadId,
  );
  db.query(
    "UPDATE runtime_runs SET status='cancelled' WHERE session_id='root' AND run_id='run'",
  ).run();
  expect(() => recordChildDispatchAckInTransaction(db, 'receipt_evidence', ackTransaction)).toThrow(
    'eligible parent Run',
  );
  db.query(
    "UPDATE runtime_runs SET status='completed' WHERE session_id='root' AND run_id='run'",
  ).run();
  db.query('UPDATE child_session_intents SET deadline_at=? WHERE child_thread_id=?').run(
    '2000-01-01T00:00:00.000Z',
    childThreadId,
  );
  expect(() =>
    recordChildDispatchAckInTransaction(db, 'receipt_evidence', {
      ...ackTransaction,
      snapshot: {
        ...ackTransaction.snapshot,
        retainedResourceBudgets: {
          [intent.fundingRunId]: {
            ...ackTransaction.snapshot.retainedResourceBudgets[intent.fundingRunId],
            deadlineAt: '2000-01-01T00:00:00.000Z',
          },
        },
      },
    }),
  ).toThrow('exact delegated reservation');
});

test('private sealed grant read rejects byte corruption after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-child-grant-'));
  const path = join(directory, 'candidate.sqlite');
  try {
    const writer = candidate(path);
    recordParentIntent(writer);
    writer.close();
    using reopened = new Database(path, { strict: true });
    assertKiteSessionStoreSchema(reopened);
    expect(readChildSealedGrant(reopened, 'root', childThreadId)).toEqual(sealedGrant);
    reopened
      .query('UPDATE child_session_intents SET sealed_grant_digest=? WHERE child_thread_id=?')
      .run(`sha256:${'0'.repeat(64)}`, childThreadId);
    expect(() => readChildSealedGrant(reopened, 'root', childThreadId)).toThrow('byte integrity');
    expect(JSON.stringify(readChildSessionIntent(reopened, childThreadId))).not.toContain(
      'private-seal',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('permanent child creation failure CAS rejects any created child and exact replay conflicts', () => {
  using db = candidate();
  recordParentIntent(db);
  const failure = {
    parentSessionId: 'root',
    childThreadId,
    failureReceiptDigest: `sha256:${'f'.repeat(64)}`,
    mode: 'absent_child' as const,
  };
  const failedEvent = {
    type: 'subagent.child_creation_failed',
    parentInvocationId: intent.parentInvocationId,
    childInvocationId: intent.childInvocationId,
    childThreadId,
    failureReceiptDigest: failure.failureReceiptDigest,
    mode: failure.mode,
    resultRef: { artifactId: 'artifact', integrityIdentifier: `sha256:${'f'.repeat(64)}` },
  };
  const commit = {
    sessionId: 'root',
    events: [
      { type: 'resource_budget.released', reservationId: intent.delegatedReservationId },
      failedEvent,
      {
        type: 'subagent.background_result_persisted',
        taskId: intent.childInvocationId,
        artifactIntegrityIdentifier: failure.failureReceiptDigest,
        originRunId: intent.originRunId,
        originTurnId: intent.originTurnId,
        originToolCallId: intent.originToolCallId,
        attempt: intent.attempt,
        childTerminalStatus: 'failed',
      },
    ],
    snapshot: {},
    childCreationFailure: failure,
  };
  settleChildCreationFailureInTransaction(db, 'receipt_evidence', commit);
  expect(readChildSessionIntent(db, childThreadId)?.failureReceiptDigest).toBe(
    failure.failureReceiptDigest,
  );
  expect(listPendingChildSessionIntents(db, 'root', 1).entries).toEqual([]);
  expect(() => assertChildSessionIntent(db, intent, childState())).toThrow('failed durably');
  expect(() =>
    settleChildCreationFailureInTransaction(db, 'receipt_evidence', commit),
  ).not.toThrow();
  expect(() =>
    settleChildCreationFailureInTransaction(db, 'receipt_evidence', {
      ...commit,
      childCreationFailure: { ...failure, failureReceiptDigest: `sha256:${'e'.repeat(64)}` },
    }),
  ).toThrow();
  using created = candidate();
  recordParentIntent(created);
  created
    .query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,updated_at,parent_session_id)
    VALUES (?,?,?,?,27,'state',0,1,'root')`)
    .run(childThreadId, workspaceId, projectId, workspaceDigest);
  expect(() =>
    settleChildCreationFailureInTransaction(created, 'receipt_evidence', commit),
  ).toThrow('created');
});

test('pre-dispatch cancellation records only a cancelled child result', () => {
  const receipt = failureTransaction('absent_child');
  const digest = receipt.childCreationFailure.failureReceiptDigest;
  const transaction = {
    ...receipt,
    events: [
      receipt.events[0],
      {
        type: 'subagent.child_pre_dispatch_cancelled',
        parentInvocationId: intent.parentInvocationId,
        childInvocationId: intent.childInvocationId,
        childThreadId,
        mode: 'absent_child',
        terminalReceiptDigest: digest,
        resultRef: { artifactId: 'artifact', integrityIdentifier: digest },
      },
      { ...receipt.events[2], childTerminalStatus: 'cancelled' },
    ],
  };
  using db = candidate();
  recordParentIntent(db);
  expect(() =>
    settleChildCreationFailureInTransaction(db, 'receipt_evidence', transaction),
  ).not.toThrow();
  expect(readChildSessionIntent(db, childThreadId)?.failureReceiptDigest).toBe(digest);

  using mismatched = candidate();
  recordParentIntent(mismatched);
  expect(() =>
    settleChildCreationFailureInTransaction(mismatched, 'receipt_evidence', {
      ...transaction,
      events: [transaction.events[0], transaction.events[1], receipt.events[2]],
    }),
  ).toThrow('does not match its result import');
  expect(readChildSessionIntent(mismatched, childThreadId)?.failureReceiptDigest).toBeNull();
});

test('already released child settles only with persisted user cancellation and no second release', () => {
  using db = candidate();
  recordParentIntent(db);
  insertUnactivatedChild(db, 'idle');
  db.query(
    'UPDATE child_session_intents SET funding_run_id = origin_run_id WHERE child_thread_id = ?',
  ).run(childThreadId);
  db.query(
    "UPDATE runtime_runs SET status = 'cancelled', finished_at_ms = 2, terminal_json = '{}' WHERE session_id = 'root' AND run_id = 'run'",
  ).run();
  const parentState = {
    turn: { turnId: 'run', status: 'aborted', abortCause: 'user' },
    resourceBudget: {
      status: 'active',
      runId: 'run',
      reservations: { reservation: { state: 'released' } },
    },
  };
  db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,state_json,event_position,state_checksum,created_at)
    VALUES ('root',27,'state',0,?,0,'checksum',1)`).run(JSON.stringify(parentState));
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES ('root','released-child',6,27,?,1)`).run(
    JSON.stringify({ type: 'resource_budget.released', reservationId: 'reservation' }),
  );
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES ('root','cancelled-parent',7,27,?,1)`).run(
    JSON.stringify({
      type: 'turn.aborted',
      turnId: 'run',
      reason: 'Cancelled by user.',
      cause: 'user',
    }),
  );
  const base = failureTransaction('created_unactivated');
  const failure = {
    ...base,
    events: [
      {
        ...base.events[1],
        type: 'subagent.child_pre_dispatch_cancelled',
        terminalReceiptDigest: base.childCreationFailure.failureReceiptDigest,
      },
      { ...base.events[2], childTerminalStatus: 'cancelled' },
    ],
  };
  db.query(
    "UPDATE runtime_events SET event_json = ? WHERE session_id = 'root' AND event_id = 'cancelled-parent'",
  ).run(
    JSON.stringify({
      type: 'turn.aborted',
      turnId: 'run',
      reason: 'Internal error.',
      cause: 'error',
    }),
  );
  expect(() => settleChildCreationFailureInTransaction(db, 'receipt_evidence', failure)).toThrow(
    'prior release proof',
  );
  db.query(
    "UPDATE runtime_events SET event_json = ? WHERE session_id = 'root' AND event_id = 'cancelled-parent'",
  ).run(
    JSON.stringify({
      type: 'turn.aborted',
      turnId: 'run',
      reason: 'Cancelled by user.',
      cause: 'user',
    }),
  );
  db.query("UPDATE runtime_snapshots SET state_json = ? WHERE session_id = 'root'").run(
    JSON.stringify({
      ...parentState,
      turn: { turnId: 'new-run', status: 'active' },
      resourceBudget: { status: 'active', runId: 'new-run', reservations: {} },
      retainedResourceBudgets: { run: parentState.resourceBudget },
    }),
  );
  expect(() =>
    settleChildCreationFailureInTransaction(db, 'receipt_evidence', failure),
  ).not.toThrow();
  expect(readChildSessionIntent(db, childThreadId)?.failureReceiptDigest).toBe(
    base.childCreationFailure.failureReceiptDigest,
  );
  db.query(
    "UPDATE runtime_runs SET status = 'failed' WHERE session_id = 'root' AND run_id = 'run'",
  ).run();
  expect(() => settleChildCreationFailureInTransaction(db, 'receipt_evidence', failure)).toThrow(
    'prior release proof',
  );
});

test('created child can be abandoned only after revision-zero owner cleanup', () => {
  using db = candidate();
  recordParentIntent(db);
  insertUnactivatedChild(db, 'active');
  const failure = failureTransaction('created_unactivated');
  expect(() => settleChildCreationFailureInTransaction(db, 'receipt_evidence', failure)).toThrow(
    'safely released',
  );
  expect(readChildSessionIntent(db, childThreadId)?.failureReceiptDigest).toBeNull();
  const idleAuthority = {
    schema: 'kite.session-execution-authority.v1',
    sessionId: childThreadId,
    status: 'idle',
    controllerGeneration: 2,
    hostInstanceId: null,
    clientId: null,
    connectionGeneration: 0,
    interactionGeneration: 0,
    leaseUntilMs: null,
    cleanupConfirmed: true,
    updatedAt: 2,
    revision: 2,
  };
  db.query('UPDATE kite_meta SET value=? WHERE key=?').run(
    JSON.stringify(idleAuthority),
    `session_execution/${childThreadId}`,
  );
  expect(() =>
    settleChildCreationFailureInTransaction(db, 'receipt_evidence', failure),
  ).not.toThrow();
  expect(readChildSessionIntent(db, childThreadId)).toMatchObject({
    failureMode: 'created_unactivated',
    failureReceiptDigest: failure.childCreationFailure.failureReceiptDigest,
    childSessionCreated: true,
  });
  expect(() =>
    settleChildCreationFailureInTransaction(db, 'receipt_evidence', failure),
  ).not.toThrow();
  expect(() =>
    settleChildCreationFailureInTransaction(
      db,
      'receipt_evidence',
      failureTransaction('absent_child'),
    ),
  ).toThrow('Absent-child');
});

test('created-child abandonment rejects activation, dispatch ACK, Run and effect evidence', () => {
  for (const blocked of ['activated', 'ack', 'run', 'effect', 'event', 'revision'] as const) {
    using db = candidate();
    recordParentIntent(db);
    insertUnactivatedChild(db, 'idle');
    if (blocked === 'activated')
      db.query(
        'UPDATE child_session_intents SET child_budget_activated_run_id=? WHERE child_thread_id=?',
      ).run('child-run', childThreadId);
    if (blocked === 'ack')
      db.query(
        'UPDATE child_session_intents SET dispatch_ack_event_id=? WHERE child_thread_id=?',
      ).run('ack', childThreadId);
    if (blocked === 'run')
      db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,created_revision,last_revision,created_at_ms)
      VALUES (?,'child-run','start','building','queued',0,0,1)`).run(childThreadId);
    if (blocked === 'effect')
      db.query(`INSERT INTO runtime_effect_leases(session_id,effect_id,owner_id,lease_revision,certainty,expires_at_ms,controller_generation,host_instance_id,connection_generation,state,updated_at)
      VALUES (?,'effect','host',1,'certain',100,1,'host',1,'prepared',1)`).run(childThreadId);
    if (blocked === 'event')
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
      VALUES (?,'event',1,27,'{}',1)`).run(childThreadId);
    if (blocked === 'revision')
      db.query('UPDATE runtime_sessions SET revision=1 WHERE session_id=?').run(childThreadId);
    expect(() =>
      settleChildCreationFailureInTransaction(
        db,
        'receipt_evidence',
        failureTransaction('created_unactivated'),
      ),
    ).toThrow();
    expect(readChildSessionIntent(db, childThreadId)?.failureReceiptDigest).toBeNull();
  }
});

test('activated child without dispatch ACK settles only with exact idle activation footprint', () => {
  using accepted = candidate();
  recordParentIntent(accepted);
  insertActivatedChild(accepted);
  const failure = failureTransaction('activated_no_ack');
  expect(() =>
    settleChildCreationFailureInTransaction(accepted, 'receipt_evidence', failure),
  ).not.toThrow();
  expect(readChildSessionIntent(accepted, childThreadId)).toMatchObject({
    failureMode: 'activated_no_ack',
    failureReceiptDigest: failure.childCreationFailure.failureReceiptDigest,
  });
  expect(() =>
    settleChildCreationFailureInTransaction(accepted, 'receipt_evidence', failure),
  ).not.toThrow();

  for (const blocked of [
    'owner',
    'ack',
    'extra-event',
    'run-start',
    'run-revision',
    'effect',
    'activation-event',
    'task-label',
  ] as const) {
    using db = candidate();
    recordParentIntent(db);
    insertActivatedChild(db);
    if (blocked === 'owner')
      db.query(`UPDATE kite_meta SET value=json_set(value,'$.status','active') WHERE key=?`).run(
        `session_execution/${childThreadId}`,
      );
    if (blocked === 'ack')
      db.query(
        'UPDATE child_session_intents SET dispatch_ack_event_id=? WHERE child_thread_id=?',
      ).run('ack', childThreadId);
    if (blocked === 'extra-event')
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES (?,'child-extra',6,27,'{"type":"model.invocation_prepared"}',1)`).run(childThreadId);
    if (blocked === 'run-start')
      db.query(`UPDATE runtime_runs SET status='running',started_at_ms=1 WHERE session_id=?`).run(
        childThreadId,
      );
    if (blocked === 'run-revision')
      db.query('UPDATE runtime_runs SET last_revision=6 WHERE session_id=?').run(childThreadId);
    if (blocked === 'effect')
      db.query(`INSERT INTO runtime_effect_leases(session_id,effect_id,owner_id,lease_revision,certainty,expires_at_ms,controller_generation,host_instance_id,connection_generation,state,updated_at)
        VALUES (?,'effect','host',1,'certain',100,1,'host',1,'prepared',1)`).run(childThreadId);
    if (blocked === 'activation-event')
      db.query(`UPDATE runtime_events SET event_json='{"type":"model.invocation_prepared"}'
        WHERE session_id=? AND sequence=2`).run(childThreadId);
    if (blocked === 'task-label')
      db.query(`UPDATE runtime_events SET event_json=json_set(event_json,'$.userGoal','private task body')
        WHERE session_id=? AND sequence=5`).run(childThreadId);
    expect(() =>
      settleChildCreationFailureInTransaction(db, 'receipt_evidence', failure),
    ).toThrow();
    expect(readChildSessionIntent(db, childThreadId)?.failureReceiptDigest).toBeNull();
  }
});

test('abandonment rejection rolls back parent facts, and restart preserves one failure winner', () => {
  const directory = mkdtempSync(join(tmpdir(), 'kite-child-abandon-'));
  const path = join(directory, 'candidate.sqlite');
  try {
    const first = candidate(path);
    recordParentIntent(first);
    insertUnactivatedChild(first, 'active');
    first.run('BEGIN IMMEDIATE');
    try {
      first
        .query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES ('root','uncommitted-failure',6,27,'{}',1)`)
        .run();
      expect(() =>
        settleChildCreationFailureInTransaction(
          first,
          'receipt_evidence',
          failureTransaction('created_unactivated'),
        ),
      ).toThrow();
      first.run('ROLLBACK');
    } catch (error) {
      first.run('ROLLBACK');
      throw error;
    }
    expect(
      first
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM runtime_events WHERE event_id='uncommitted-failure'",
        )
        .get()?.count,
    ).toBe(0);
    const released = {
      schema: 'kite.session-execution-authority.v1',
      sessionId: childThreadId,
      status: 'idle',
      controllerGeneration: 2,
      hostInstanceId: null,
      clientId: null,
      connectionGeneration: 0,
      interactionGeneration: 0,
      leaseUntilMs: null,
      cleanupConfirmed: true,
      updatedAt: 2,
      revision: 2,
    };
    first
      .query('UPDATE kite_meta SET value=? WHERE key=?')
      .run(JSON.stringify(released), `session_execution/${childThreadId}`);
    const competing = new Database(path, { strict: true });
    competing.run('PRAGMA foreign_keys=ON');
    competing.run('PRAGMA busy_timeout=1');
    first.run('BEGIN IMMEDIATE');
    settleChildCreationFailureInTransaction(
      first,
      'receipt_evidence',
      failureTransaction('created_unactivated'),
    );
    expect(() => competing.run('BEGIN IMMEDIATE')).toThrow();
    first.run('COMMIT');
    competing.close();
    first.close();
    using reopened = new Database(path, { strict: true });
    assertKiteSessionStoreSchema(reopened);
    expect(readChildSessionIntent(reopened, childThreadId)).toMatchObject({
      failureMode: 'created_unactivated',
      childSessionCreated: true,
      failureReceiptDigest: `sha256:${'f'.repeat(64)}`,
    });
    expect(() =>
      settleChildCreationFailureInTransaction(
        reopened,
        'receipt_evidence',
        failureTransaction('created_unactivated'),
      ),
    ).not.toThrow();
    expect(() => assertChildSessionIntent(reopened, intent, childState())).toThrow(
      'failed durably',
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('child first-turn activation is bounded and Provider dispatch requires parent ACK', () => {
  using db = candidate();
  recordParentIntent(db);
  db.query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,state_schema,format_epoch,revision,updated_at,parent_session_id)
    VALUES (?,?,?,?,27,'state',0,1,'root')`).run(
    childThreadId,
    workspaceId,
    projectId,
    workspaceDigest,
  );
  const budget = {
    version: 1,
    maxRunDurationMs: 10_000,
    maxTurns: 3,
    maxModelRequests: 3,
    maxToolInvocations: 2,
    maxRunInputTokens: 100,
    maxRunOutputTokens: 100,
    maxConcurrentSubagents: 0,
    maxConcurrentWriters: 0,
    maxConcurrentToolInvocations: 1,
    maxConcurrentShellInvocations: 1,
    maxConcurrencyWaitMs: 1000,
    maxArtifactBytes: 1000,
  };
  const artifactRef = taskArtifactRef;
  const activation = {
    childThreadId,
    parentSessionId: 'root',
    parentInvocationId: 'invocation',
    childInvocationId: 'child-invocation',
    grantDigest: intent.grantDigest,
    taskArtifactRef: artifactRef,
    taskArtifactDigest: intent.taskArtifactDigest,
    taskTextDigest: intent.taskTextDigest,
    fundingRunId: 'funding-run',
    delegatedReservationId: 'reservation',
    delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
    childRunId: 'child-run',
    childMaySpawn: false,
    childMayWrite: false,
  };
  const activationEvents = [
    {
      type: 'subagent.child_session_adopted',
      parentSessionId: 'root',
      parentInvocationId: 'invocation',
      parentToolCallId: 'tool-call',
      attempt: 1,
      childInvocationId: 'child-invocation',
      grantDigest: intent.grantDigest,
      fundingRunId: intent.fundingRunId,
      delegatedReservationId: intent.delegatedReservationId,
      delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
      deadlineAt: intent.deadlineAt,
      taskArtifactRef: artifactRef,
      taskArtifactDigest: intent.taskArtifactDigest,
      taskTextDigest: intent.taskTextDigest,
    },
    {
      type: 'subagent.child_task_input_admitted',
      childInvocationId: 'child-invocation',
      taskArtifactRef: artifactRef,
      taskDigest: intent.taskArtifactDigest,
      taskTextDigest: intent.taskTextDigest,
      grantDigest: intent.grantDigest,
    },
    {
      type: 'resource_budget.configured',
      runId: 'child-run',
      startedAt: '2026-09-24T00:00:00.000Z',
      deadlineAt: intent.deadlineAt,
      budget,
    },
    { type: 'turn.started', turnId: 'child-run' },
    {
      type: 'task.started',
      taskId: intent.childInvocationId,
      turnId: 'child-run',
      userGoal: 'Complete the delegated task.',
    },
  ];
  const activeState = {
    ...childState(),
    activeTaskId: intent.childInvocationId,
    tasks: {
      [intent.childInvocationId]: {
        taskId: intent.childInvocationId,
        userGoal: 'Complete the delegated task.',
        status: 'active',
        startedAtTurnId: 'child-run',
      },
    },
    childSessionOrigin: { ...childState().childSessionOrigin, taskInputAdmitted: true },
    resourceBudget: { status: 'active', runId: 'child-run', deadlineAt: intent.deadlineAt, budget },
  };
  const activationTx = {
    sessionId: childThreadId,
    events: activationEvents,
    metadata: activationEvents.map((_, index) => ({
      eventId: `child-event-${index}`,
      revision: index + 1,
    })),
    snapshot: activeState,
    childBudgetActivation: activation,
    runMutation: {
      type: 'insert' as const,
      run: {
        sessionId: childThreadId,
        runId: 'child-run',
        originSessionId: intent.parentSessionId,
        originRunId: intent.originRunId,
        startCommandId: 'child-start',
        phase: 'building' as const,
        status: 'queued' as const,
        createdRevision: 5,
        lastRevision: 5,
        createdAtMs: 1,
      },
    },
  };
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'decision', {
      ...activationTx,
      events: activationEvents.filter(
        (event) => event.type !== 'subagent.child_task_input_admitted',
      ),
    }),
  ).toThrow();
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'decision', {
      ...activationTx,
      events: activationEvents.filter((event) => event.type !== 'task.started'),
    }),
  ).toThrow();
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'decision', {
      ...activationTx,
      events: activationEvents.map((event) =>
        event.type === 'task.started' ? { ...event, userGoal: task } : event,
      ),
    }),
  ).toThrow();
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'decision', {
      ...activationTx,
      childBudgetActivation: { ...activation, childMayWrite: true },
    }),
  ).toThrow();
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'decision', {
      ...activationTx,
      runMutation: {
        ...activationTx.runMutation,
        run: { ...activationTx.runMutation.run, originRunId: 'different-parent-run' },
      },
    }),
  ).toThrow();
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'decision', activationTx),
  ).not.toThrow();
  expect(readChildSessionIntent(db, childThreadId)?.childBudgetActivatedRunId).toBe('child-run');
  const childModel = {
    sessionId: childThreadId,
    events: [{ type: 'model.invocation_prepared' }],
    snapshot: activeState,
  };
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'receipt_evidence', childModel),
  ).toThrow('ACK');
  const ack = {
    parentSessionId: 'root',
    childThreadId,
    originRunId: 'run',
    originToolCallId: 'tool-call',
    delegatedReservationId: 'reservation',
  };
  const ackTx = {
    sessionId: 'root',
    events: [{ type: 'resource_budget.dispatch_started', reservationId: 'reservation' }],
    metadata: [{ eventId: 'ack-event', revision: 5 }],
    childDispatchAck: ack,
    snapshot: {
      resourceBudget: {
        status: 'active',
        runId: 'funding-run',
        reservations: { reservation: { ...reservation, state: 'dispatch_started' } },
      },
      retainedResourceBudgets: {},
    },
  };
  recordChildDispatchAckInTransaction(db, 'receipt_evidence', ackTx);
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'receipt_evidence', childModel),
  ).not.toThrow();
  recordChildParentSettlementInTransaction(db, 'receipt_evidence', {
    sessionId: 'root',
    events: [
      {
        type: 'subagent.child_terminal_imported',
        childThreadId,
        parentInvocationId: intent.parentInvocationId,
        childInvocationId: intent.childInvocationId,
        status: 'completed',
      },
      { type: 'subagent.background_result_persisted', childTerminalStatus: 'completed' },
    ],
    metadata: [
      { eventId: 'import-event', revision: 7 },
      { eventId: 'result-event', revision: 8 },
    ],
    snapshot: {},
  });
  expect(readChildSessionIntent(db, childThreadId)?.parentClaimSettledEventId).toBe('import-event');
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'receipt_evidence', childModel),
  ).toThrow('ACK');
  db.query(`UPDATE runtime_runs SET status='cancelled',finished_at_ms=2,terminal_json='{}'
    WHERE session_id='root' AND run_id='run'`).run();
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'receipt_evidence', childModel),
  ).toThrow('ACK');
});

test('unknown child terminal needs fenced recovery attempt and remains unclean at parent import', () => {
  using db = candidate();
  recordParentIntent(db);
  insertActivatedChild(db);
  db.query(`UPDATE child_session_intents SET dispatch_ack_event_id='ack',dispatch_ack_revision=6
    WHERE child_thread_id=?`).run(childThreadId);
  db.query(`UPDATE runtime_runs SET status='unknown',started_at_ms=1,finished_at_ms=2,
    terminal_json='{}' WHERE session_id=? AND run_id='child-run'`).run(childThreadId);
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES (?,'attempt',6,27,'{"type":"model.invocation_attempt_started"}',1)`).run(childThreadId);
  const resultRef = {
    artifactId: `pa_${'f'.repeat(64)}`,
    kind: 'subagent_task',
    integrityIdentifier: `sha256:${'f'.repeat(64)}`,
    byteLength: 10,
  };
  const seal = {
    type: 'subagent.child_terminal_sealed',
    status: 'unknown',
    cleanupConfirmed: false,
    resultRef,
  };
  const unknownTransaction = {
    sessionId: childThreadId,
    events: [seal],
    snapshot: {
      childSessionOrigin: {
        parentSessionId: 'root',
        childInvocationId: intent.childInvocationId,
        fundingRunId: intent.fundingRunId,
        delegatedReservationId: intent.delegatedReservationId,
        terminal: seal,
      },
      terminalOutcome: { status: 'unknown', knownExternalEffects: 'unknown' },
    },
  };
  expect(() =>
    assertChildUnknownTerminalSealInTransaction(db, 'terminal_recovery', unknownTransaction, false),
  ).toThrow('fenced Run');
  expect(() =>
    assertChildUnknownTerminalSealInTransaction(db, 'terminal_recovery', unknownTransaction, true),
  ).not.toThrow();
  expect(() =>
    assertChildRuntimeActivationInTransaction(db, 'attempt_start', {
      sessionId: childThreadId,
      events: [{ type: 'model.invocation_attempt_started' }],
      snapshot: unknownTransaction.snapshot,
    }),
  ).toThrow('Sealed child Session cannot start external work');
  db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
    VALUES (?,'unknown-seal',7,27,?,1)`).run(childThreadId, JSON.stringify(seal));
  const imported = {
    sessionId: 'root',
    events: [
      {
        type: 'resource_budget.unknown',
        reservationId: intent.delegatedReservationId,
      },
      {
        type: 'subagent.child_terminal_imported',
        status: 'unknown',
        childThreadId,
        parentInvocationId: intent.parentInvocationId,
        childInvocationId: intent.childInvocationId,
        resultRef,
      },
      { type: 'subagent.background_result_persisted', childTerminalStatus: 'unknown' },
    ],
    metadata: [
      { eventId: 'unknown-budget', revision: 6 },
      { eventId: 'unknown-import', revision: 7 },
      { eventId: 'unknown-result', revision: 8 },
    ],
    snapshot: {},
  };
  expect(() => recordChildParentSettlementInTransaction(db, 'receipt_evidence', imported)).toThrow(
    'fenced terminal evidence',
  );
  const current = db
    .query<{ value: string }, [string]>('SELECT value FROM kite_meta WHERE key=?')
    .get(`session_execution/${childThreadId}`)!;
  db.query('UPDATE kite_meta SET value=? WHERE key=?').run(
    JSON.stringify({
      ...JSON.parse(current.value),
      status: 'recovery_required',
      cleanupConfirmed: false,
      hostInstanceId: null,
      leaseUntilMs: null,
    }),
    `session_execution/${childThreadId}`,
  );
  expect(() =>
    recordChildParentSettlementInTransaction(db, 'receipt_evidence', imported),
  ).not.toThrow();
  expect(readChildSessionIntent(db, childThreadId)?.parentClaimSettledEventId).toBe(
    'unknown-import',
  );
});
