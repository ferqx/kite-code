import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialAgentState } from '@kite-ai/agent-kernel';
import {
  canonicalModelJson,
  derivePrivateImmutableArtifactReference,
} from '@kite-ai/builtin-runtime/model';
import { SubagentGrantAuthority, subagentTaskDigest } from '@kite-ai/builtin-runtime/subagent';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import { createZeroResourceUsage } from '@kite-ai/runtime-host/kernel-adapter';
import {
  childDelegatedUpperBoundDigest,
  createRuntimeStoredCommandReceipt,
  type RuntimeChildSessionIntentMutation,
  sealChildGrantPayload,
} from '@kite-ai/runtime-host/storage';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { persistChildSessionIntentInTransaction } from '../../../../packages/runtime-storage-sqlite/src/kite-child-session-intents';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';

test('private Service child creation requires exact committed parent intent and remains hidden after restart', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-child-creation-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const parentSessionId = 'creation-parent';
  const parentInvocationId = 'parent-invocation';
  const originToolCallId = 'origin-tool';
  const childThreadId = `child_${createHash('sha256')
    .update(
      JSON.stringify([
        'kite.child-session.v1',
        parentSessionId,
        parentInvocationId,
        originToolCallId,
        1,
      ]),
    )
    .digest('hex')}`;
  const deadlineAt = new Date(Date.now() + 60_000).toISOString();
  const task = 'Inspect child creation.';
  const taskTextDigest = subagentTaskDigest(task);
  const taskArtifactJson = canonicalModelJson({
    artifactFormatVersion: 1,
    owner: {
      parentInvocationId,
      parentAttempt: 1,
      parentToolCallId: originToolCallId,
      childInvocationId: 'child-invocation',
    },
    task,
    taskDigest: taskTextDigest,
    taskByteLength: Buffer.byteLength(task, 'utf8'),
  });
  const taskArtifactRef = derivePrivateImmutableArtifactReference(
    'subagent-tasks',
    'subagent_task',
    Buffer.from(taskArtifactJson, 'utf8'),
  );
  const grant = new SubagentGrantAuthority({ idSource: () => 'creation-grant' }).issueStart({
    parentInvocationId,
    parentToolCallId: originToolCallId,
    parentAttempt: 1,
    capabilityRevision: '1'.repeat(64),
    admissionDigest: '2'.repeat(64),
    effectiveEffectsDigest: '3'.repeat(64),
    childInvocationId: 'child-invocation',
    role: 'review',
    taskArtifact: taskArtifactRef,
    taskDigest: taskTextDigest,
    capabilityCeiling: {
      allowedTools: ['read_file'],
      bindingIds: [],
      bindingRevision: '4'.repeat(64),
      ceilingDigest: '5'.repeat(64),
    },
    authorization: {
      authorizationDigest: '6'.repeat(64),
      interactionMode: 'accept_edits',
      phase: 'building',
      workspaceAccess: 'write',
    },
    executionBoundary: {
      canonicalWorkspace: workspace,
      executionBoundaryDigest: `sha256:${'7'.repeat(64)}`,
    },
    resource: { parentReservationId: null, budgetDigest: '8'.repeat(64) },
    cancellationCorrelation: originToolCallId,
    model: { parentModelInvocationId: 'parent-model', parentToolCallId: originToolCallId },
  });
  const sealedGrant = sealChildGrantPayload(grant);
  const upper = {
    counters: {
      turns: 3,
      modelRequests: 3,
      toolInvocations: 2,
      inputTokens: 100,
      outputTokens: 100,
      artifactBytes: 1_000,
    },
    gauges: {
      elapsedRunMs: 10_000,
      activeSubagents: 1,
      activeWriters: 1,
      activeToolInvocations: 1,
      activeShellInvocations: 1,
    },
    source: 'versioned_upper_bound' as const,
    estimatorVersion: 'service-child-creation-test',
  };
  const intent: RuntimeChildSessionIntentMutation = {
    childThreadId,
    parentSessionId,
    parentInvocationId,
    originRunId: 'origin-run',
    originTurnId: 'origin-turn',
    originToolCallId,
    attempt: 1,
    childInvocationId: 'child-invocation',
    grantDigest: sealedGrant.sealedGrantDigest,
    ...sealedGrant,
    taskArtifactRef,
    taskArtifactDigest: taskArtifactRef.integrityIdentifier,
    taskTextDigest,
    disposition: 'required',
    role: 'review',
    fundingRunId: 'funding-run',
    delegatedReservationId: 'delegated-reservation',
    delegatedUpperBoundDigest: childDelegatedUpperBoundDigest(upper),
    deadlineAt,
  };
  const model = createMockModelServer();
  let storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'child-creation-host-1',
  });
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [
      {
        userId: 'child-creation-user',
        workspace,
        config: {
          providerName: 'fixture',
          providerType: 'openai-compatible' as const,
          apiKey: 'fixture-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          modelKwargs: { maxOutputTokens: 64 },
          modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
          sandbox: { enabled: false },
        },
        shellExecutor: async ({ command }: { command: string }) => ({
          ok: true as const,
          command,
          exitCode: 0,
          stdout: '',
          stderr: '',
        }),
        interactionMode: 'accept_edits' as const,
        sandboxBackend: 'none' as const,
        skillOptions: {
          userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
          userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
          projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
          projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
        },
        initialSkillActivations: [],
      },
    ],
  });
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = server.open({ admission });
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  const client = new RuntimeClient({
    transport,
    clientInfo: { name: 'child-creation-test', version: '1', instanceId: 'client' },
  });
  try {
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-parent',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    expect(created.status).toBe('applied');
    const parentState = storage.loadCurrentSnapshot(parentSessionId);
    if (!parentState?.session.projectId || !parentState.session.canonicalWorkspaceDigest)
      throw new Error('Parent workspace identity is unavailable.');
    const childRecovery = 'e'.repeat(64);
    const childBudget = {
      version: 1 as const,
      maxRunDurationMs: 10_000,
      maxTurns: 3,
      maxModelRequests: 3,
      maxToolInvocations: 2,
      maxRunInputTokens: 100,
      maxRunOutputTokens: 100,
      maxConcurrentSubagents: 1,
      maxConcurrentWriters: 1,
      maxConcurrentToolInvocations: 1,
      maxConcurrentShellInvocations: 1,
      maxConcurrencyWaitMs: 10_000,
      maxArtifactBytes: 1_000,
    };
    const childState = {
      ...createInitialAgentState({
        threadId: childThreadId,
        userId: parentState.session.userId,
        workspace,
        projectId: parentState.session.projectId,
        canonicalWorkspaceDigest: parentState.session.canonicalWorkspaceDigest,
        turnId: 'child-turn',
        recoveryIdentityKey: childRecovery,
      }),
      childSessionOrigin: {
        parentSessionId: intent.parentSessionId,
        parentInvocationId: intent.parentInvocationId,
        parentToolCallId: intent.originToolCallId,
        attempt: intent.attempt,
        childInvocationId: intent.childInvocationId,
        grantDigest: intent.grantDigest,
        taskArtifactRef,
        taskArtifactDigest: intent.taskArtifactDigest,
        taskTextDigest: intent.taskTextDigest,
        role: intent.role,
        fundingRunId: intent.fundingRunId,
        delegatedReservationId: intent.delegatedReservationId,
        delegatedUpperBoundDigest: intent.delegatedUpperBoundDigest,
        deadlineAt: intent.deadlineAt,
      },
    };
    const creation = {
      childSessionIntent: intent,
      runtime: {
        sessionId: childThreadId,
        events: [],
        snapshot: childState,
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
        requestId: 'create-child-controller',
        requestDigest: 'c'.repeat(64),
        clientId: 'internal-child',
        connectionGeneration: 1,
        workerInstanceId: 'child-creation-host-1',
        resumeSecret: Buffer.alloc(32, 7).toString('base64url'),
        resumeExpiresAtMs: Date.now() + 60_000,
        executionLeaseUntilMs: Date.now() + 60_000,
      },
      recoveryIdentity: childRecovery,
    };
    expect(() => storage.createChildSession(creation)).toThrow();
    expect(storage.readSessionLineage(childThreadId)).toBeNull();

    // The parent receipt fixture follows the same Store transaction validator as Host.
    // It supplies only the committed Tool terminal and delegation facts needed to admit a child.
    const reservation = {
      version: 1,
      reservationId: intent.delegatedReservationId,
      runId: intent.fundingRunId,
      invocationId: `child-allotment:${childThreadId}`,
      resourceKind: 'subagent',
      executableUpperBound: upper,
      state: 'reserved',
    };
    const events = [
      { type: 'subagent.started', subagent: { id: intent.childInvocationId, role: intent.role } },
      {
        type: 'capability.subagent_dispatch_intent_recorded',
        invocationId: intent.parentInvocationId,
        childInvocationId: intent.childInvocationId,
        attempt: intent.attempt,
        taskArtifact: taskArtifactRef,
      },
      { type: 'resource_budget.reserved', reservation },
      { type: 'subagent.child_session_intended', ...intent },
      {
        type: 'tool.finished',
        toolCallId: intent.originToolCallId,
        name: 'task',
        result: {
          ok: true,
          resultMeta: {
            taskId: intent.childInvocationId,
            taskStatus: 'running',
            taskDisposition: 'required',
          },
        },
      },
    ];
    const metadata = events.map((_, index) => ({
      eventId: `parent-event-${index}`,
      revision: index === events.length - 1 ? 1 : index + 1,
    }));
    storage.runWithSessionExecution(parentSessionId, () =>
      storage.artifactStore.writeSubagentTask({
        ref: taskArtifactRef,
        artifactFormatVersion: 1,
        canonicalJson: taskArtifactJson,
        createdAt: Date.now(),
      }),
    );
    const db = new Database(databasePath);
    try {
      db.run('PRAGMA foreign_keys=ON');
      db.run('BEGIN IMMEDIATE');
      persistChildSessionIntentInTransaction(db, 'receipt_evidence', {
        sessionId: parentSessionId,
        events,
        metadata,
        snapshot: {
          resourceBudget: { status: 'active', runId: intent.fundingRunId, deadlineAt },
          retainedResourceBudgets: {},
        },
        childSessionIntent: intent,
      });
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES (?,?,?,?,?,?)`).run(
        parentSessionId,
        `parent-event-${events.length - 1}`,
        1,
        27,
        JSON.stringify(events.at(-1)),
        Date.now(),
      );
      db.run('COMMIT');
    } catch (error) {
      try {
        db.run('ROLLBACK');
      } catch {
        /* Store may already have rolled back. */
      }
      throw error;
    } finally {
      db.close(false);
    }
    const applied = storage.createChildSession(creation);
    expect(applied).toMatchObject({
      status: 'applied',
      runtimeReceipt: { committedRevision: 0 },
      controller: {
        status: 'applied',
        lease: { sessionId: childThreadId, controllerGeneration: 1 },
      },
    });
    expect(storage.readSessionLineage(childThreadId)).toEqual({ parentSessionId });
    expect(storage.loadCurrentSnapshot(childThreadId)?.revision).toBe(0);
    expect(storage.loadCurrentSnapshot(parentSessionId)?.revision).toBe(parentState.revision);
    const authorityDb = new Database(databasePath);
    try {
      const rows = authorityDb
        .query<{ key: string }, [string, string]>(
          'SELECT key FROM kite_meta WHERE key IN (?, ?) ORDER BY key',
        )
        .all(`session_execution/${parentSessionId}`, `session_execution/${childThreadId}`);
      expect(rows.map((row) => row.key)).toEqual([
        `session_execution/${childThreadId}`,
        `session_execution/${parentSessionId}`,
      ]);
    } finally {
      authorityDb.close(false);
    }
    expect(storage.createChildSession(creation).status).toBe('replay');
    expect(() =>
      storage.createChildSession({
        ...creation,
        childSessionIntent: { ...intent, grantDigest: `sha256:${'d'.repeat(64)}` },
      }),
    ).toThrow();
    expect(() =>
      storage.createChildSession({
        ...creation,
        runtime: {
          ...creation.runtime,
          snapshot: {
            ...childState,
            childSessionOrigin: {
              ...childState.childSessionOrigin,
              parentSessionId: 'other-parent',
            },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      storage.createChildSession({
        ...creation,
        runtime: {
          ...creation.runtime,
          snapshot: {
            ...childState,
            resourceBudget: {
              status: 'active' as const,
              runId: intent.fundingRunId,
              startedAt: new Date().toISOString(),
              deadlineAt,
              budget: { ...childBudget, maxTurns: 4 },
              reconciledUsage: createZeroResourceUsage(),
              reservations: {},
              waiters: {},
              nextWaiterSequence: 0,
            },
          },
        },
      }),
    ).toThrow();
    expect(storage.listCurrentSessions('', 10).map((entry) => entry.threadId)).not.toContain(
      childThreadId,
    );
    expect(
      storage.directory.listSessions({ limit: 10 }).entries.map((entry) => entry.sessionId),
    ).not.toContain(childThreadId);
    await client.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'child-creation-host-2',
    });
    expect(storage.readSessionLineage(childThreadId)).toEqual({ parentSessionId });
    expect(storage.createChildSession(creation).status).toBe('replay');
    expect(storage.listCurrentSessions('', 10).map((entry) => entry.threadId)).not.toContain(
      childThreadId,
    );
    expect(
      storage.directory.listSessions({ limit: 10 }).entries.map((entry) => entry.sessionId),
    ).not.toContain(childThreadId);
  } finally {
    await Promise.resolve(client.close()).catch(() => undefined);
    await Promise.resolve(server[Symbol.asyncDispose]()).catch(() => undefined);
    storage.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
