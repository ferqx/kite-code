import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentState,
  createInitialAgentState,
  type KernelEvent,
  RUNTIME_STATE_SCHEMA_VERSION,
} from '@kite-ai/agent-kernel';
import { createRuntimeHostStateStorageBinding } from '@kite-ai/runtime-host';
import { createRuntimeHostStateSession } from '@kite-ai/runtime-host/kernel-adapter';
import {
  createRuntimeRunStartResourceResult,
  createRuntimeStoredCommandReceipt,
} from '@kite-ai/runtime-host/storage';
import {
  openKiteSessionRuntimeStorage,
  openKiteSessionStoreDatabase,
  SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
} from '@kite-ai/runtime-storage-sqlite';
import { EffectSupervisor } from '../../../../packages/runtime-host/src/lifecycle/effect-supervisor';
import { checksum } from '../../../../packages/runtime-storage-sqlite/src/preflight';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';

test('Host source acceptance survives restart into AppServer target receipt and model input', async () => {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-cross-mail-host-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const path = join(root, 'kite-session.sqlite');
  const codec = createRuntimeHostStateStorageBinding().codec;
  const pathDigest = createHash('sha256').update(workspace).digest('hex');
  const projectId = `project_${pathDigest}`;
  const workspaceDigest = `sha256:${pathDigest}` as const;
  if (!/^sha256:[a-f0-9]{64}$/u.test(workspaceDigest))
    throw new Error('Fixture Workspace digest is invalid.');
  const identityDigest = createHash('sha256')
    .update(
      `kite.workspace-identity.v1\0${JSON.stringify({
        canonicalPath: workspace,
        projectId,
        workspaceDigest,
      })}`,
    )
    .digest('hex');
  const workspaceId = `workspace_${identityDigest}`;
  const parentState = {
    ...createInitialAgentState({
      threadId: 'parent',
      userId: 'test',
      workspace,
      projectId,
      canonicalWorkspaceDigest: workspaceDigest,
      turnId: 'parent-turn',
      recoveryIdentityKey: 'a'.repeat(64),
    }),
    revision: 1,
  };
  const childState = {
    ...createInitialAgentState({
      threadId: 'child',
      userId: 'test',
      workspace,
      projectId,
      canonicalWorkspaceDigest: workspaceDigest,
      turnId: 'child-turn',
      recoveryIdentityKey: 'b'.repeat(64),
    }),
    revision: 1,
  };
  const db = openKiteSessionStoreDatabase(path);
  try {
    db.query(`INSERT INTO workspaces(workspace_id,canonical_path,workspace_identity_digest,
      project_id,workspace_digest,display_name,created_at,updated_at)
      VALUES (?,?,?, ?,?,'Workspace',1,1)`).run(
      workspaceId,
      workspace,
      `sha256:${identityDigest}`,
      projectId,
      workspaceDigest,
    );
    for (const [sessionId, state, parent] of [
      ['parent', parentState, null],
      ['child', childState, 'parent'],
    ] as const) {
      db.query(`INSERT INTO runtime_sessions(session_id,workspace_id,project_id,workspace_digest,
        state_schema,format_epoch,revision,name,updated_at,run_index_from_revision,parent_session_id)
        VALUES (?,?,?,?,?, ?,1,'',1,0,?)`).run(
        sessionId,
        workspaceId,
        projectId,
        workspaceDigest,
        RUNTIME_STATE_SCHEMA_VERSION,
        SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
        parent,
      );
      const json = codec.encodeState(state);
      db.query(`INSERT INTO runtime_snapshots(session_id,schema_version,format_epoch,revision,
        state_json,event_position,state_checksum,created_at) VALUES (?,?,?,1,?,1,?,1)`).run(
        sessionId,
        RUNTIME_STATE_SCHEMA_VERSION,
        SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
        json,
        checksum(json),
      );
      db.query(`INSERT INTO runtime_events(session_id,event_id,sequence,schema_version,event_json,created_at)
        VALUES (?,?,1,?, ?,1)`).run(
        sessionId,
        `seed-${sessionId}`,
        RUNTIME_STATE_SCHEMA_VERSION,
        codec.encodeEvent({
          type: 'user.message_appended',
          messageId: `seed-${sessionId}`,
          content: 'seed',
        }),
      );
    }
    db.query(`INSERT INTO agent_nodes(session_id,agent_id,current_task_id,status,turn_ordinal,created_at_ms)
      VALUES ('parent','parent','parent-run','active',1,1),
             ('child','child','child-run','active',1,1)`).run();
    db.query(`INSERT INTO runtime_runs(session_id,run_id,start_command_id,phase,status,
      created_revision,last_revision,created_at_ms,started_at_ms)
      VALUES ('parent','parent-run','start-parent','building','running',1,1,1,1),
             ('child','child-run','start-child','building','running',1,1,1,1)`).run();
    for (const [sessionId, runId, commandId] of [
      ['parent', 'parent-run', 'start-parent'],
      ['child', 'child-run', 'start-child'],
    ] as const) {
      const run = {
        sessionId,
        runId,
        startCommandId: commandId,
        phase: 'building' as const,
        status: 'running' as const,
        createdRevision: 1,
        lastRevision: 1,
        createdAtMs: 1,
        startedAtMs: 1,
      };
      const receipt = createRuntimeStoredCommandReceipt(
        {
          scopeSessionId: sessionId,
          targetSessionId: sessionId,
          commandId,
          requestDigest: 'f'.repeat(64),
          committedAt: 1,
          resourceResult: createRuntimeRunStartResourceResult(run),
        },
        1,
      );
      db.query(`INSERT INTO runtime_command_receipts(scope_session_id,command_id,workspace_id,
        project_id,workspace_digest,request_digest,target_session_id,original_receipt_json,
        committed_revision,committed_at,result_schema,result_json,result_digest)
        VALUES (?,? ,?,?,?,?,?,?,?,?,?,?,?)`).run(
        receipt.scopeSessionId,
        receipt.commandId,
        workspaceId,
        projectId,
        workspaceDigest,
        receipt.requestDigest,
        receipt.targetSessionId,
        receipt.originalReceiptJson,
        receipt.committedRevision,
        receipt.committedAt,
        receipt.resourceResult!.schema,
        receipt.resourceResult!.json,
        receipt.resourceResult!.digest,
      );
    }
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
      child_budget_activated_run_id,child_budget_activated_event_id,
      child_budget_activated_revision,dispatch_ack_event_id,dispatch_ack_revision)
      VALUES ('child','parent','parent-invocation','parent-run','parent-turn',
      'spawn-tool',1,'child-invocation','grant','{}',2,'sealed','task-digest','text-digest',
      ?,2,'required','code','tool-event',1,'parent-run','reservation',
      'budget-digest','{}','2099-01-01T00:00:00.000Z',
      'child-run','activation-event',1,'dispatch-ack',1)`).run(`pa_${'1'.repeat(64)}`);
  } finally {
    db.close(false);
  }
  let owner = openKiteSessionRuntimeStorage({
    databasePath: path,
    codec,
    stateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
    formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
  });
  try {
    const acquire = (sessionId: string) => {
      const current = owner.authority.read(sessionId);
      const result = owner.authority.acquire({
        sessionId,
        expectedRevision: current.revision,
        hostInstanceId: 'test-host',
        clientId: 'test-client',
        connectionGeneration: 1,
        leaseUntilMs: Date.now() + 60_000,
      });
      if (result.status !== 'acquired') throw new Error('Session owner unavailable.');
      return owner.bindExecution(result.authority);
    };
    const parentHandle = acquire('parent');
    let childHandle = acquire('child');
    let supervisor = new EffectSupervisor(owner.storage);
    const session = (state: AgentState) =>
      createRuntimeHostStateSession({
        state,
        services: supervisor.services,
        clock: () => '2026-09-25T00:00:00.000Z',
        id: (kind) => `${kind}-${Math.random()}`,
        sandboxAvailable: true,
      });
    const sourceState: AgentState = {
      ...parentState,
      tools: {
        ...parentState.tools,
        active: ['send'],
        calls: {
          send: {
            toolCallId: 'send',
            name: 'send_message',
            modelMessageId: 'assistant',
            args: {},
            modelInvocationId: 'model',
            createdAtTurnId: 'parent-turn',
            status: 'running',
          },
        },
      },
      transcript: {
        messages: [
          {
            kind: 'assistant',
            messageId: 'assistant',
            turnId: 'parent-turn',
            ordinal: 0,
            createdAt: '2026-09-25T00:00:00.000Z',
            modelInvocationId: 'model',
            toolCalls: [{ id: 'send', name: 'send_message', args: {} }],
          },
        ],
      },
      capabilities: {
        ...parentState.capabilities,
        invocations: {
          invocation: {
            invocationId: 'invocation',
            toolCallId: 'send',
            capabilityId: 'builtin:send_message',
            capabilityRevision: 'revision',
            argumentsDigest: 'arguments',
            authorizationDigest: 'authorization',
            effectiveEffectsDigest: 'effects',
            status: 'running',
            recordedAt: '2026-09-25T00:00:00.000Z',
            attemptsStarted: 1,
          },
        },
      },
    };
    const parent = session(sourceState);
    let child = session(childState);
    const text = 'hello';
    const digest = createHash('sha256').update(text).digest('hex');
    const event = {
      type: 'agent.mail_accepted',
      messageId: 'mail-1',
      senderAgentId: 'parent',
      targetAgentId: 'child',
      mode: 'queue_only',
      source: {
        runId: 'parent-run',
        turnId: 'parent-turn',
        modelInvocationId: 'model',
        toolCallId: 'send',
        effectAttemptId: 'invocation:attempt:1',
      },
      bodyRef: {
        artifactId: `pa_${digest}`,
        kind: 'agent_mail',
        integrityIdentifier: `sha256:${digest}`,
        byteLength: Buffer.byteLength(text),
      },
      bodyDigest: `sha256:${digest}`,
      sequence: 1,
    } as const;
    const mutation = {
      kind: 'accept_queue',
      messageId: event.messageId,
      targetSessionId: event.targetAgentId,
      commandId: event.messageId,
      requestDigest: 'd'.repeat(64),
      sourceRunId: event.source.runId,
      sourceTurnId: event.source.turnId,
      sourceModelInvocationId: event.source.modelInvocationId,
      sourceToolCallId: event.source.toolCallId,
      sourceEffectAttemptId: event.source.effectAttemptId,
      sourceSequence: 1,
      bodyText: text,
      acceptedAtMs: 1,
    } as const;
    owner.runWithExecution(parentHandle, () => {
      const lease = parent.beginEffect({ type: 'run_tools', toolCallIds: ['send'] });
      expect(
        supervisor.services.leases.tryAcquire(
          'parent',
          'mail-effect',
          'owner',
          Date.now() + 30_000,
        ),
      ).toBe(true);
      parent.commitCrossSessionQueueMailCommand(
        lease,
        event,
        mutation,
        {
          scopeSessionId: 'parent',
          targetSessionId: 'parent',
          commandId: event.messageId,
          requestDigest: mutation.requestDigest,
          committedAt: 1,
        },
        { sessionId: 'parent', effectId: 'mail-effect', ownerId: 'owner' },
      );
      expect(owner.crossSessionQueueMail.readOutbox('parent', 'mail-1')).toMatchObject({
        targetSessionId: 'child',
        bodyRef: { artifactId: `pa_${digest}` },
      });
    });
    expect(owner.listPendingCrossSessionQueueMailSources(10)).toEqual(['parent']);
    expect(owner.storage.sessions.loadEventsStrict('child')).toHaveLength(1);
    owner.runWithExecution(parentHandle, () =>
      supervisor.services.leases.release('parent', 'mail-effect', 'owner'),
    );
    for (const sessionId of ['parent', 'child']) {
      const authority = owner.authority.read(sessionId);
      owner.authority.release({
        sessionId,
        expectedRevision: authority.revision,
        controllerGeneration: authority.controllerGeneration,
        hostInstanceId: 'test-host',
        cleanupConfirmed: true,
      });
    }
    owner.close();
    const appStorage = await createKiteSessionAppServerStorageComposition({
      databasePath: path,
      hostInstanceId: 'mail-recovery-host',
    });
    appStorage.admitWorkspace({ canonicalPath: workspace, projectId, workspaceDigest });
    const appServer = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: path,
      storageOwner: appStorage,
      workspaces: [
        {
          userId: 'test',
          workspace,
          config: {
            providerName: 'mail-recovery-test',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: 'http://127.0.0.1:1/v1',
            modelName: 'mock-model',
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
    try {
      await appServer.recoverPendingAgentMail();
      await appServer.recoverPendingAgentMail();
      expect(
        appStorage.storage.sessions
          .loadEventsStrict('child')
          .filter(({ event }) => event.type === 'agent.mail_accepted'),
      ).toHaveLength(1);
      appStorage.runWithSessionExecution('child', () => {
        expect(
          appStorage.storage.crossSessionQueueMail.readInboxReceipt('child', 'mail-1'),
        ).toMatchObject({
          targetRunId: 'child-run',
          sequence: 1,
        });
      });
      expect(appStorage.listPendingCrossSessionQueueMailSources(10)).toEqual([]);
    } finally {
      await appServer[Symbol.asyncDispose]();
      appStorage.disposeStorage();
    }
    owner = openKiteSessionRuntimeStorage({
      databasePath: path,
      codec,
      stateSchemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      formatEpoch: SQLITE_RUNTIME_RUN_FORMAT_EPOCH,
    });
    supervisor = new EffectSupervisor(owner.storage);
    childHandle = acquire('child');
    child = session(owner.storage.sessions.loadSnapshot<AgentState>('child')!);
    owner.runWithExecution(childHandle, () => {
      expect(() =>
        child.commitCrossSessionQueueMailReceive(
          { ...event, targetAgentId: 'child', senderAgentId: 'wrong' },
          {
            kind: 'receive_queue',
            sourceSessionId: 'parent',
            messageId: 'mail-1',
            receivedAtMs: 2,
          },
        ),
      ).toThrow();
      expect(child.getState().revision).toBe(2);
      expect(owner.crossSessionQueueMail.readInboxReceipt('child', 'mail-1')).toMatchObject({
        targetRunId: 'child-run',
        sequence: 1,
      });
      const modelLease = child.beginEffect({ type: 'call_model' });
      const surface = {
        kind: 'model_surface' as const,
        artifactId: `pa_${'e'.repeat(64)}`,
        integrityIdentifier: `sha256:${'e'.repeat(64)}`,
        byteLength: 1,
      };
      const prepared = {
        type: 'model.invocation_prepared',
        invocationId: 'target-model',
        purpose: 'primary_agent',
        surfaceArtifact: surface,
        surfaceIntegrityIdentifier: surface.integrityIdentifier,
        routeFingerprint: `sha256:${'f'.repeat(64)}`,
        budget: { kind: 'no_budget', reason: 'resource_budget_disabled' },
        limits: { maxAttempts: 1, perAttemptTimeoutMs: 1_000, totalTimeBudgetMs: 1_000 },
        preparedStateRevision: child.getState().revision,
        parentInvocationId: null,
        parentToolCallId: null,
      } as const;
      const mailPrepared: Extract<KernelEvent, { type: 'agent.mail_input_prepared' }> = {
        type: 'agent.mail_input_prepared',
        targetAgentId: 'child',
        invocationId: 'target-model',
        modelAdmissionId: 'target-model',
        fromSequence: 0,
        throughSequence: 1,
        messageIds: ['mail-1'],
      };
      const modelMutation = {
        kind: 'prepare_queue_input',
        modelInvocationId: 'target-model',
        modelAdmissionId: 'target-model',
        currentRunId: 'child-run',
        fromSequence: 0,
        throughSequence: 1,
        messageIds: ['mail-1'],
      } as const;
      expect(() =>
        child.commitCrossSessionQueueMailModelInput(modelLease, [prepared, mailPrepared], {
          ...modelMutation,
          currentRunId: 'later-run',
        }),
      ).toThrow();
      expect(child.getState().revision).toBe(2);
      expect(owner.crossSessionQueueMail.listQueuedInbox('child', 'child-run', 8)).toHaveLength(1);
      child.commitCrossSessionQueueMailModelInput(
        modelLease,
        [prepared, mailPrepared],
        modelMutation,
      );
      expect(owner.crossSessionQueueMail.listQueuedInbox('child', 'child-run', 8)).toEqual([]);
    });
    const inspect = openKiteSessionStoreDatabase(path);
    try {
      expect(
        inspect
          .query<{ source_session_id: string; body_text: string }, []>(
            `SELECT session_id AS source_session_id,body_text FROM agent_mail_bodies`,
          )
          .all(),
      ).toEqual([{ source_session_id: 'parent', body_text: text }]);
    } finally {
      inspect.close(false);
    }
  } finally {
    owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});
