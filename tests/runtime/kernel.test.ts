import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBinding, descriptorRevision } from '../../src/core/capabilities/catalog';
import { McpProviderError } from '../../src/core/mcp';
import { createRemoteMcpEgressReceiptV1 } from '../../src/core/mcp/egress-permit';
import { McpConnectionManager } from '../../src/core/mcp/manager';
import { buildContextProjection } from '../../src/core/model/context-projection';
import { eventsForRunCancellation } from '../../src/core/runtime/actions';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { createRuntimeEffectExecutor } from '../../src/core/runtime/executor';
import { classifyFailure } from '../../src/core/runtime/failures';
import { AgentKernel, createAgentKernel } from '../../src/core/runtime/kernel';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import { runRuntimeLoop } from '../../src/core/runtime/runner';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  getActivePlanning,
  RUNTIME_STATE_FORMAT_EPOCH,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from '../../src/core/runtime/state';
import {
  createRuntimeStore,
  RemoteMcpEgressNonceConflictError,
  type RuntimeStore,
} from '../../src/core/runtime/store';
import { createToolRecoveryJournalV1 } from '../../src/core/runtime/tool-recovery-journal';
import { currentPlanDocument } from '../helpers/current-plan';

describe('AgentKernel durability', () => {
  test.each([
    ['missing', null],
    ['wrong', `${RUNTIME_STATE_FORMAT_EPOCH}-wrong`],
  ] as const)('rejects a current-schema snapshot with %s format epoch without rewriting the store', (_label, formatEpoch) => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-format-epoch-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = `format-${formatEpoch ?? 'missing'}`;
    try {
      const state = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const incompatible = structuredClone(state) as unknown as Record<string, unknown>;
      if (formatEpoch === null) delete incompatible.formatEpoch;
      else incompatible.formatEpoch = formatEpoch;
      const database = new Database(storePath);
      database.run(
        'UPDATE runtime_snapshots SET state_json = ?, schema_version = ? WHERE thread_id = ?',
        [JSON.stringify(incompatible), RUNTIME_STATE_SCHEMA_VERSION, threadId],
      );
      database.close();

      const digest = () => createHash('sha256').update(readFileSync(storePath)).digest('hex');
      const before = digest();
      expect(() =>
        createAgentKernel({
          threadId,
          userId: 'user',
          workspace: '/workspace',
          storePath,
        }),
      ).toThrow('Runtime format is incompatible');
      expect(digest()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a retired event in a current-format tail before scheduling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-retired-tail-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'retired-tail';
    try {
      const state = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const database = new Database(storePath);
      database
        .query(
          'INSERT INTO runtime_events (thread_id, event_json, event_id, revision, occurred_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          threadId,
          JSON.stringify({ type: 'tool.execution_ready', toolCallId: 'shell-unapproved' }),
          'retired-event',
          1,
          '2026-08-15T00:00:00.000Z',
        );
      database.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().recoveryState).toMatchObject({
        kind: 'corrupted',
        reason: expect.stringContaining('not part of the current format'),
      });
      expect(decideNextEffect(restored.getState())).toMatchObject({ type: 'recovery_blocked' });
      expect(restored.getState().tools.calls['shell-unapproved']).toBeUndefined();
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rejects a current event whose required payload fields are missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-malformed-tail-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'malformed-current-tail';
    try {
      const state = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const database = new Database(storePath);
      database
        .query(
          'INSERT INTO runtime_events (thread_id, event_json, event_id, revision, occurred_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          threadId,
          JSON.stringify({ type: 'tool.queued', toolCallId: 'malformed', args: {} }),
          'malformed-event',
          1,
          '2026-08-15T00:00:00.000Z',
        );
      database.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().recoveryState).toMatchObject({
        kind: 'corrupted',
        reason: expect.stringContaining('tool.queued requires name'),
      });
      expect(decideNextEffect(restored.getState())).toMatchObject({ type: 'recovery_blocked' });
      expect(restored.getState().tools.calls.malformed).toBeUndefined();
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails closed when a current snapshot omits the recovery journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-current-missing-recovery-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'v23-missing-recovery';
    try {
      const current = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      delete (current as Partial<RuntimeState>).toolRecovery;
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, current);
      store.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().recoveryState).toMatchObject({
        kind: 'corrupted',
        reason: expect.stringContaining('tool recovery journal schema must be v1'),
      });
      expect(decideNextEffect(restored.getState())).toMatchObject({ type: 'recovery_blocked' });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('fails closed before scheduling when a suspended child omits its recovery journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-child-journal-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'current-child-missing-recovery';
    try {
      const state = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      state.suspendedSubagents.task = {
        subagentId: 'child',
        role: 'code',
        task: 'Resume the current child safely.',
        messages: [],
        toolCallCount: 1,
        steps: [],
        blockedTool: {
          reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
          toolCallId: 'child-shell',
          toolName: 'shell_execute',
          args: { command: 'pwd' },
          command: 'pwd',
        },
      } as unknown as (typeof state.suspendedSubagents)[string];
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, state);
      store.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().recoveryState).toMatchObject({
        kind: 'corrupted',
        reason: expect.stringContaining('invalid recovery journal'),
      });
      expect(decideNextEffect(restored.getState())).toMatchObject({ type: 'recovery_blocked' });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restores a healthy completed child merge without rotating its recovery identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-child-merge-restart-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'child-merge-restart';
    try {
      const initial = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      initial.tools.calls['task-1'] = {
        toolCallId: 'task-1',
        modelMessageId: 'model-1',
        name: 'task',
        args: { subagent_type: 'explore', task: 'Inspect the workspace.' },
        status: 'running',
        createdAtTurnId: initial.turn.turnId,
      };
      const parentIdentity = initial.toolRecovery.identityKey;
      const store = createRuntimeStore(storePath);
      const kernel = new AgentKernel({
        store,
        initialState: initial,
        interactionMode: 'accept_edits',
      });
      kernel.processEvent({
        type: 'subagent.recovery_journal_merged',
        toolCallId: 'task-1',
        journal: createToolRecoveryJournalV1(parentIdentity),
      });
      kernel.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().toolRecovery.identityKey).toBe(parentIdentity);
      expect(restored.getState().toolRecovery.qualityGuard).toEqual({
        blocked: false,
        observedFailures: 0,
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('replays the context compaction crash matrix from snapshot plus event tail', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-compaction-crash-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'compaction-crash-matrix';
    try {
      const base = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      base.transcript.messages = [
        {
          kind: 'user',
          messageId: 'message-1',
          turnId: base.turn.turnId,
          ordinal: 0,
          createdAt: '2026-07-22T00:00:00.000Z',
          content: 'preserve this transcript',
        },
      ];
      const request: RuntimeEvent = {
        type: 'context.compaction_requested',
        compactionId: 'compact-crash',
        reason: 'manual',
        requestedAtRevision: 0,
        requestedAtTurnId: base.turn.turnId,
        force: false,
        estimate: {
          systemTokens: 10,
          toolSchemaTokens: 0,
          transcriptTokens: 3_000,
          summaryTokens: 0,
          dynamicRuntimeTokens: 0,
          framingTokens: 10,
          totalInputTokens: 3_020,
        },
      };
      const checkpoint = {
        compactionId: 'compact-crash',
        version: 1 as const,
        sourceRevision: 1,
        sourceDigest: 'sha256:crash',
        coveredThroughMessageId: 'message-1',
        coveredThroughTurnId: base.turn.turnId,
        summary: '# Restored\n\nContinue safely.',
        inputTokensBefore: 3_020,
        inputTokensAfter: 900,
        reason: 'manual' as const,
        createdAt: '2026-07-22T00:00:01.000Z',
      };
      const completed: RuntimeEvent = {
        type: 'context.compaction_completed',
        compactionId: checkpoint.compactionId,
        sourceRevision: 1,
        checkpoint,
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, base);
      store.appendEvents(
        threadId,
        [request],
        [{ eventId: 'request-1', revision: 1, occurredAt: '2026-07-22T00:00:01.000Z' }],
      );
      store.close();

      const afterRequest = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(afterRequest.getState().context.pendingCompaction?.compactionId).toBe('compact-crash');
      expect(afterRequest.getState().transcript.messages).toEqual(base.transcript.messages);
      afterRequest.close();

      const tailStore = createRuntimeStore(storePath);
      tailStore.appendEvents(
        threadId,
        [completed],
        [{ eventId: 'completed-1', revision: 2, occurredAt: '2026-07-22T00:00:02.000Z' }],
      );
      tailStore.close();
      const afterCompletedTail = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(afterCompletedTail.getState().context.pendingCompaction).toBeUndefined();
      expect(afterCompletedTail.getState().context.activeCheckpoint).toEqual(checkpoint);
      expect(afterCompletedTail.getState().context.history).toHaveLength(1);
      afterCompletedTail.runtimeStore.saveSnapshot(threadId, afterCompletedTail.getState());
      afterCompletedTail.close();

      const afterCompletedSnapshot = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(afterCompletedSnapshot.getState().context.activeCheckpoint).toEqual(checkpoint);
      expect(afterCompletedSnapshot.getState().context.history).toHaveLength(1);
      expect(afterCompletedSnapshot.getState().transcript.messages).toEqual(
        base.transcript.messages,
      );
      const restoredProjection = buildContextProjection({
        role: 'agent',
        state: afterCompletedSnapshot.getState(),
        serializedTools: [],
      });
      const serializedProjection = JSON.stringify(restoredProjection.providerMessages);
      expect(
        restoredProjection.providerMessages.filter(
          (message) =>
            typeof message.content === 'string' &&
            message.content.startsWith('<compacted_history>\n'),
        ),
      ).toHaveLength(1);
      expect(serializedProjection).toContain('Continue safely.');
      afterCompletedSnapshot.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restores a non-empty session-loaded capability set after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-loaded-capability-restart-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const state = createInitialRuntimeState({
        threadId: 'loaded-capability-restart',
        userId: 'user',
        workspace: '/workspace',
      });
      const loaded = {
        capabilityId: 'mcp:github/publish',
        capabilityRevision: 'revision-1',
        firstLoadedAtTurnId: state.turn.turnId,
      };
      const store = createRuntimeStore(storePath);
      const kernel = new AgentKernel({
        store,
        initialState: state,
        interactionMode: 'accept_edits',
      });
      kernel.processEvent({
        type: 'capability.bindings_issued',
        catalogRevision: 'catalog-r1',
        bindings: [
          {
            bindingId: 'binding-r1',
            capabilityId: loaded.capabilityId,
            capabilityRevision: loaded.capabilityRevision,
            exposedToolName: 'mcp__github__publish',
            schemaDigest: 'schema-r1',
            issuedForTurnId: state.turn.turnId,
          },
        ],
        disclosures: [
          {
            capabilityId: loaded.capabilityId,
            capabilityRevision: loaded.capabilityRevision,
            issuedForTurnId: state.turn.turnId,
          },
        ],
        loadedCapabilities: [loaded],
        searchId: 'search-r1',
      });
      expect(kernel.getState().capabilities.loadedCapabilities).toEqual({
        [loaded.capabilityId]: loaded,
      });
      kernel.close();

      const restored = createAgentKernel({
        threadId: state.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().capabilities.loadedCapabilities).toEqual({
        [loaded.capabilityId]: loaded,
      });
      expect(restored.getState().capabilities.bindings['binding-r1']).toMatchObject({
        capabilityId: loaded.capabilityId,
        capabilityRevision: loaded.capabilityRevision,
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists a snapshot with each processed event', () => {
    const store = createRuntimeStore(':memory:');
    const kernel = new AgentKernel({
      store,
      initialState: createInitialRuntimeState({
        threadId: 'kernel-durability',
        userId: 'user',
        workspace: '/workspace',
      }),
      interactionMode: 'accept_edits',
    });

    kernel.processEvent({
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'read_file',
      args: { path: 'README.md' },
    });

    const snapshot =
      store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>('kernel-durability');
    expect(snapshot?.tools.queue).toEqual(['call-1']);
    kernel.close();
  });

  test('marks a persisted invocation without a terminal result as unknown after restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-invocation-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const first = createAgentKernel({
        threadId: 'invocation-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      first.processEvent({
        type: 'capability.invocation_recorded',
        invocationId: 'invocation-1',
        toolCallId: 'tool-1',
        capabilityId: 'mcp:fixture/write',
        capabilityRevision: 'revision-1',
        argumentsDigest: 'arguments',
        authorizationDigest: 'authorization',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        recordedAt: '2026-07-14T00:00:00.000Z',
      });
      first.close();

      const restored = createAgentKernel({
        threadId: 'invocation-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().capabilities.invocations['invocation-1']).toMatchObject({
        status: 'unknown',
        error: expect.stringContaining('without a terminal result'),
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('persists reconciliation across a second restart without replaying the invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-reconcile-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const first = createAgentKernel({
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      first.processEvent({
        type: 'capability.invocation_recorded',
        invocationId: 'invocation-reconcile',
        toolCallId: 'tool-1',
        capabilityId: 'mcp:fixture/write',
        capabilityRevision: 'revision-1',
        argumentsDigest: 'arguments',
        authorizationDigest: 'authorization',
        effectiveEffectsDigest: 'effects',
        effectiveEffects: { filesystem: 'none', network: 'write', externalState: 'write' },
        recordedAt: '2026-07-14T00:00:00.000Z',
      });
      first.close();

      const recovered = createAgentKernel({
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      const action = recovered.applyAction({
        type: 'reconcile_invocation',
        invocationId: 'invocation-reconcile',
        decision: 'confirmed_success',
      });
      expect(action.status).toBe('applied');
      recovered.close();

      const restored = createAgentKernel({
        threadId: 'reconcile-recovery',
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().capabilities.invocations['invocation-reconcile']).toMatchObject({
        status: 'succeeded',
        reconciliation: 'confirmed_success',
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test('Kernel replay cannot complete a V2 plan while an external read awaits approval', () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'kernel-plan-approval-block',
    userId: 'u',
    workspace: '/workspace',
  });
  const document: import('../../src/protocol/events').PlanDocument = {
    planSchemaVersion: 2,
    planId: 'approval-plan',
    version: 2,
    title: 'Approval gated plan',
    bodyMarkdown: 'Finish the plan only after every pending approval has resolved.',
    steps: [{ id: 'finish', title: 'Finish after approval', status: 'pending' }],
    structuralDigest: '',
    createdAtTurnId: initial.turn.turnId,
    updatedAtTurnId: initial.turn.turnId,
    completionEvidence: {
      schemaVersion: 1,
      verification: [],
      execution: [],
      skipped: [],
      unresolved: [],
    },
  };
  document.structuralDigest = computePlanStructuralDigest(document);
  const planning = {
    kind: 'executing' as const,
    document,
    executionMode: 'auto' as const,
    approvedAtTurnId: initial.turn.turnId,
  };
  initial.activeTaskId = 'kernel-task';
  initial.tasks['kernel-task'] = {
    taskId: 'kernel-task',
    userGoal: 'Verify approval blocks Plan completion.',
    status: 'active',
    startedAtTurnId: initial.turn.turnId,
    sideEffectsStarted: false,
    planning,
    executionMode: 'auto',
    planHistory: [],
  };
  initial.tools.calls['external-read'] = {
    toolCallId: 'external-read',
    modelMessageId: 'external-read-model',
    name: 'read_file',
    args: { path: '/outside/workspace.txt' },
    status: 'awaiting_approval',
    sideEffect: false,
    createdAtTurnId: initial.turn.turnId,
  };
  initial.tools.queue.push('external-read');
  initial.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'external-read-approval',
    toolCallId: 'external-read',
    approval: {} as never,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });

  kernel.processEvent({
    type: 'plan.completed',
    toolCallId: 'forged-completion',
    taskId: 'kernel-task',
    planId: document.planId,
    version: document.version,
    structuralDigest: document.structuralDigest,
    plan: {
      name: document.title,
      description: document.bodyMarkdown,
      status: 'completed',
      steps: [{ id: 'finish', step: 'Finish after approval', status: 'completed' }],
    },
    completionEvidence: document.completionEvidence,
  });

  expect(getActivePlanning(kernel.getState()).kind).toBe('executing');
  expect(kernel.getState().interactions.kind).toBe('awaiting_tool_approval');
  kernel.close();
});

test('runRuntimeLoop resumes a matching input action and persists its facts', async () => {
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createInitialRuntimeState({ threadId: 'loop', userId: 'u', workspace: '/' }),
    interactionMode: 'accept_edits',
  });
  kernel.processEvents([
    { type: 'tool.queued', toolCallId: 'accept_edits', name: 'ask_user', args: {} },
    {
      type: 'user_input.requested',
      interactionId: 'input-1',
      toolCallId: 'accept_edits',
      request: { question: 'q', options: [], allow_free_text: true },
    },
  ]);
  const events = [] as string[];
  for await (const event of runRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({ type: 'input', interactionId: 'input-1', text: 'answer' }),
  }))
    events.push(event.type);
  expect(events).toEqual(['user_input.answered', 'tool.finished']);
  expect(kernel.getState().interactions.kind).toBe('idle');
  kernel.close();
});

test('runRuntimeLoop completes provider recovery on a fresh turn without replaying the tool', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'provider-recovery-loop',
    userId: 'u',
    workspace: '/',
  });
  const previousTurnId = initial.turn.turnId;
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  kernel.processEvents([
    {
      type: 'tool.queued',
      toolCallId: 'mcp-call',
      name: 'mcp__github__publish',
      args: { private: 'not-copied-to-provider-events' },
    },
    {
      type: 'tool.failed',
      toolCallId: 'mcp-call',
      failure: {
        kind: 'provider_auth_required',
        message: 'MCP provider authentication is required.',
        retryable: false,
        modelFixable: false,
        needsUserIntervention: true,
        terminatesTurn: false,
        journal: true,
      },
    },
    {
      type: 'provider.action_required',
      interactionId: 'provider-action',
      providerId: 'github',
      action: 'login',
      originatingToolCallId: 'mcp-call',
    },
  ]);

  const events: RuntimeEvent[] = [];
  for await (const event of runRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({
      type: 'provider_action_result',
      interactionId: 'provider-action',
      outcome: 'completed',
      providerDirectoryRevision: 'directory-r2',
    }),
  })) {
    events.push(event);
  }

  expect(events.map((event) => event.type)).toEqual([
    'provider.action_started',
    'provider.action_completed',
    'turn.started',
  ]);
  expect(kernel.getState().turn.turnId).not.toBe(previousTurnId);
  expect(kernel.getState().tools.calls['mcp-call']?.status).toBe('failed');
  expect(kernel.getState().tools.queue).toEqual([]);
  expect(kernel.getState().tools.active).toEqual([]);
  expect(JSON.stringify(events)).not.toContain('not-copied-to-provider-events');
  kernel.close();
});

test.each([
  ['awaiting_user_input', 'generic'],
  ['awaiting_tool_approval', 'generic'],
  ['awaiting_review', 'generic'],
  ['awaiting_review', 'structured'],
] as const)('runRuntimeLoop consumes %s cancellation via %s action without throwing', async (interactionKind, actionKind) => {
  const store = createRuntimeStore(':memory:');
  const toolCallId =
    interactionKind === 'awaiting_user_input'
      ? 'ask-1'
      : interactionKind === 'awaiting_tool_approval'
        ? 'approval-1'
        : 'plan-1';
  const initial = createInitialRuntimeState({
    threadId: `cancel-${interactionKind}`,
    userId: 'u',
    workspace: '/',
    phase: interactionKind === 'awaiting_review' ? 'planning' : 'building',
  });
  initial.tools.calls[toolCallId] = {
    toolCallId,
    modelMessageId: 'model-1',
    name:
      interactionKind === 'awaiting_user_input'
        ? 'ask_user'
        : interactionKind === 'awaiting_tool_approval'
          ? 'shell_execute'
          : 'write_plan',
    args: {},
    status:
      interactionKind === 'awaiting_user_input'
        ? 'awaiting_user_input'
        : interactionKind === 'awaiting_tool_approval'
          ? 'awaiting_approval'
          : 'awaiting_review',
    createdAtTurnId: initial.turn.turnId,
  };
  if (interactionKind === 'awaiting_user_input') {
    initial.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'interaction-1',
      toolCallId,
      request: { question: 'q', options: [], allow_free_text: true },
    };
  } else if (interactionKind === 'awaiting_tool_approval') {
    initial.interactions = {
      kind: 'awaiting_tool_approval',
      interactionId: 'interaction-1',
      toolCallId,
      approval: {
        scope: 'once',
        cwd: '/',
        threadId: initial.session.threadId,
        tool: 'shell_execute',
        command: 'pwd',
        risk: 'execute_code',
        approvalHash: 'approval-hash',
        summary: 'Run pwd',
        reason: 'Test approval cancellation.',
        expectedEffects: [],
        grantOptions: ['approve_once'],
        recommendedGrant: 'approve_once',
      },
    };
  } else {
    const document = currentPlanDocument({
      planId: 'plan-1',
      version: 1,
      title: 'Plan',
      bodyMarkdown: 'A plan to verify cancellation behavior.',
      steps: [{ id: 'step-1', title: 'Verify cancellation', status: 'pending' as const }],
      structuralDigest: 'digest-1',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    });
    initial.activeTaskId = 'plan-review-task';
    initial.tasks['plan-review-task'] = {
      taskId: 'plan-review-task',
      userGoal: 'Review the current Plan.',
      status: 'active',
      startedAtTurnId: initial.turn.turnId,
      sideEffectsStarted: false,
      planning: {
        kind: 'awaiting_review',
        document,
        interactionId: 'interaction-1',
        exitToolCallId: toolCallId,
      },
      planHistory: [],
    };
    initial.interactions = {
      kind: 'awaiting_review',
      interactionId: 'interaction-1',
      toolCallId,
      planId: document.planId,
      version: document.version,
      structuralDigest: document.structuralDigest,
      plan: {
        name: document.title,
        description: document.bodyMarkdown,
        status: 'pending',
        steps: [],
      },
      planSummary: document.title,
    };
  }

  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const events: string[] = [];
  const executedEffects: string[] = [];
  for await (const event of runRuntimeLoop(
    kernel,
    async (effect) => {
      executedEffects.push(effect.type);
      return [];
    },
    {
      requestAction: async () =>
        actionKind === 'structured' && initial.interactions.kind === 'awaiting_review'
          ? {
              type: 'plan_review_decision',
              interactionId: 'interaction-1',
              planId: initial.interactions.planId,
              version: initial.interactions.version,
              structuralDigest: initial.interactions.structuralDigest,
              decision: { kind: 'cancel' },
            }
          : { type: 'cancel', interactionId: 'interaction-1' },
    },
  )) {
    events.push(event.type);
  }

  if (interactionKind === 'awaiting_tool_approval') {
    expect(events).toEqual(['approval.rejected', 'turn.aborted']);
    expect(executedEffects).toEqual([]);
  } else if (interactionKind === 'awaiting_review') {
    expect(events).toEqual(['plan.review_cancelled', 'tool.cancelled', 'turn.aborted']);
    expect(executedEffects).toEqual([]);
  } else {
    expect(events).toContain('tool.finished');
    expect(executedEffects).toEqual(['call_model']);
  }
  expect(kernel.getState().interactions.kind).toBe('idle');
  kernel.close();
});

test('runRuntimeLoop closes a suspended subagent when its approval is cancelled', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'cancel-subagent-approval',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.calls['task-1'] = {
    toolCallId: 'task-1',
    modelMessageId: 'model-1',
    name: 'task',
    args: { task: 'Run a nested command.' },
    status: 'awaiting_approval',
    createdAtTurnId: initial.turn.turnId,
  };
  initial.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'approval-1',
    toolCallId: 'task-1',
    approval: {
      scope: 'once',
      cwd: '/',
      threadId: initial.session.threadId,
      tool: 'shell_execute',
      command: 'pwd',
      risk: 'execute_code',
      approvalHash: 'approval-hash',
      summary: 'Run pwd',
      reason: 'Nested command needs approval.',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
      subagentId: 'subagent-1',
    },
  };
  initial.suspendedSubagents['task-1'] = {
    subagentId: 'subagent-1',
    role: 'code',
    task: 'Run a nested command.',
    messages: [],
    toolCallCount: 1,
    steps: [],
    toolRecovery: JSON.parse(
      JSON.stringify(createToolRecoveryJournalV1(initial.toolRecovery.identityKey)),
    ),
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'nested-1',
      toolName: 'shell_execute',
      args: { command: 'pwd' },
      command: 'pwd',
    },
  };

  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const events: string[] = [];
  for await (const event of runRuntimeLoop(kernel, async () => [], {
    requestAction: async () => ({ type: 'cancel', interactionId: 'approval-1' }),
  })) {
    events.push(event.type);
  }

  expect(events).toEqual(['approval.rejected', 'turn.aborted']);
  expect(kernel.getState().interactions.kind).toBe('idle');
  expect(kernel.getState().suspendedSubagents).toEqual({});
  expect(kernel.getState().tools.calls['task-1']?.status).toBe('rejected');
  kernel.close();
});

test('runRuntimeLoop persists and yields a durable terminal output event', async () => {
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createInitialRuntimeState({ threadId: 'final', userId: 'u', workspace: '/' }),
    interactionMode: 'accept_edits',
  });
  const events = [] as string[];
  for await (const event of runRuntimeLoop(
    kernel,
    async () => [
      {
        type: 'model.responded' as const,
        messageId: 'answer',
        text: 'finished answer',
      },
    ],
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event.type);
  }

  expect(events).toEqual(['model.responded', 'run.completed', 'turn.completed']);
  expect(store.loadEventsStrict('final').at(-1)?.event).toEqual({
    type: 'turn.completed',
    turnId: kernel.getState().turn.turnId,
  });
  const recoveryPoints = store.listNamedSnapshots('final');
  expect(recoveryPoints).toHaveLength(1);
  expect(recoveryPoints[0]?.eventPosition).toBe(store.getLastEventPosition('final'));
  expect(
    store.loadNamedSnapshot<RuntimeState>('final', recoveryPoints[0]!.snapshotId)?.turn.status,
  ).toBe('completed');
  kernel.close();
});

test('runRuntimeLoop applies streamed tool events before the effect completes', async () => {
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createInitialRuntimeState({
      threadId: 'streamed-tool',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  kernel.processEvent({
    type: 'tool.queued',
    toolCallId: 'shell-1',
    name: 'shell_execute',
    args: { command: 'printf live' },
  });

  const events: RuntimeEvent[] = [];
  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, _state, emit) => {
      if (effect.type !== 'run_tools') return [];
      emit?.({ type: 'tool.started', toolCallId: 'shell-1' });
      emit?.({
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: 'live 1',
        stream: 'stdout',
      });
      emit?.({
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: 'live 2',
        stream: 'stdout',
      });
      return [
        {
          type: 'tool.finished',
          toolCallId: 'shell-1',
          name: 'shell_execute',
          result: {
            ok: true,
            command: 'printf live',
            exitCode: 0,
            stdout: 'live',
            stderr: '',
          },
        },
      ];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event);
    if (event.type === 'tool.progress') {
      expect(kernel.getState().tools.calls['shell-1']?.status).toBe('running');
    }
  }

  expect(events.slice(0, 3).map((event) => event.type)).toEqual([
    'tool.started',
    'tool.progress',
    'tool.finished',
  ]);
  expect(events.find((event) => event.type === 'tool.progress')).toEqual({
    type: 'tool.progress',
    toolCallId: 'shell-1',
    chunk: 'live 1\nlive 2',
    stream: 'stdout',
    lineCount: 2,
  });
  expect(
    store.loadEventsStrict('streamed-tool').some(({ event }) => event.type === 'tool.progress'),
  ).toBe(false);
  expect(
    store.loadEventsStrict('streamed-tool').some(({ event }) => event.type === 'tool.finished'),
  ).toBe(true);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  expect(kernel.getState().tools.queue).not.toContain('shell-1');
  expect(kernel.getState().tools.active).not.toContain('shell-1');
  kernel.close();
});

test('runRuntimeLoop rejects persistEvent when durable persistence throws instead of hanging', async () => {
  const durableStore = createRuntimeStore(':memory:');
  const store: RuntimeStore = {
    ...durableStore,
    appendEventsAndSnapshot(threadId, events, nextState, metadata, snapshotMetadata) {
      if (events.some((event) => event.type === 'mcp.egress_decided')) {
        throw new RemoteMcpEgressNonceConflictError();
      }
      durableStore.appendEventsAndSnapshot(threadId, events, nextState, metadata, snapshotMetadata);
    },
  };
  const initialState = createInitialRuntimeState({
    threadId: 'streamed-persistence-rejection',
    userId: 'u',
    workspace: '/',
  });
  initialState.tools.queue.push('shell-1');
  initialState.tools.calls['shell-1'] = {
    toolCallId: 'shell-1',
    modelMessageId: 'model-1',
    name: 'shell_execute',
    args: { command: 'printf safe' },
    status: 'queued',
    createdAtTurnId: initialState.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState, interactionMode: 'accept_edits' });
  const decision = createRemoteMcpEgressReceiptV1({
    enabled: true,
    request: {
      transport: 'http',
      serverIdentity: 'docs',
      endpointRevision: 'endpoint-v1',
      toolRevision: 'tool-v1',
      invocationId: 'invocation-1',
      toolCallId: 'shell-1',
      argumentDigest: 'redacted-digest',
      content: { dataClassifications: ['confidential'], payloadKinds: ['user_prompt'] },
    },
    reason: 'permit_consumed',
  });
  let persistenceRejected = false;
  const stream = runRuntimeLoop(
    kernel,
    async (effect, _state, _emit, context) => {
      if (effect.type !== 'run_tools') return [];
      try {
        await context?.persistEvent({
          type: 'mcp.egress_decided',
          toolCallId: 'shell-1',
          decision,
        });
      } catch (error) {
        persistenceRejected = error instanceof RemoteMcpEgressNonceConflictError;
      }
      return [
        {
          type: 'tool.failed',
          toolCallId: 'shell-1',
          failure: classifyFailure('persistence_unavailable', 'fixture persistence failure'),
        },
      ];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const first = await Promise.race([
    stream.next(),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 1_000);
    }),
  ]);
  if (timer) clearTimeout(timer);

  expect(first).not.toBe('timeout');
  expect(persistenceRejected).toBe(true);
  if (first !== 'timeout') expect(first.value).toMatchObject({ type: 'tool.failed' });
  await stream.return(undefined);
  kernel.close();
});

test('runRuntimeLoop starts each approved shell while later sibling approval is pending', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'incremental-shell-approval',
    userId: 'u',
    workspace: '/',
  });
  for (const [ordinal, toolCallId] of ['shell-1', 'shell-2'].entries()) {
    initial.tools.queue.push(toolCallId);
    initial.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'parallel-shell-message',
      ordinal,
      name: 'shell_execute',
      args: { command: `node task-${ordinal + 1}.js` },
      status: 'queued',
      createdAtTurnId: initial.turn.turnId,
    };
  }
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reportBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    reportBothStarted = resolve;
  });
  const started: string[] = [];
  const approvalOrder: string[] = [];
  const events: RuntimeEvent[] = [];
  const run = (async () => {
    for await (const event of runRuntimeLoop(
      kernel,
      async (effect, state, emit) => {
        if (effect.type === 'call_model') {
          return [{ type: 'model.responded', messageId: 'done', text: 'done' }];
        }
        if (effect.type !== 'run_tools') return [];
        const toolCallId = effect.toolCallIds[0]!;
        const call = state.tools.calls[toolCallId]!;
        if (call.status === 'queued') {
          emit?.({
            type: 'approval.requested',
            interactionId: `approval-${toolCallId}`,
            toolCallId,
            approval: {
              scope: 'once',
              cwd: '/',
              threadId: state.session.threadId,
              tool: 'shell_execute',
              command: String((call.args as { command: string }).command),
              risk: 'execute_code',
              approvalHash: `hash-${toolCallId}`,
              summary: `Run ${toolCallId}`,
              reason: 'Test incremental approval.',
              expectedEffects: [],
              grantOptions: ['approve_once'],
              recommendedGrant: 'approve_once',
            },
          });
          return [];
        }
        emit?.({ type: 'tool.started', toolCallId });
        started.push(toolCallId);
        if (started.length === 2) reportBothStarted();
        await released;
        return [
          {
            type: 'tool.finished',
            toolCallId,
            name: 'shell_execute',
            result: {
              ok: true,
              command: String((call.args as { command: string }).command),
              exitCode: 0,
              stdout: toolCallId,
              stderr: '',
            },
          },
        ];
      },
      {
        requestAction: async (effect) => {
          if (effect.type !== 'request_tool_approval') {
            throw new Error(`Unexpected interaction: ${effect.type}`);
          }
          approvalOrder.push(effect.toolCallId);
          if (effect.toolCallId === 'shell-2') {
            expect(kernel.getState().tools.calls['shell-1']?.status).toBe('running');
          }
          return {
            type: 'approve',
            interactionId: effect.interactionId,
            grant: 'approve_once',
          };
        },
      },
    )) {
      events.push(event);
    }
  })();

  const overlapped = await Promise.race([
    bothStarted.then(() => true),
    Bun.sleep(250).then(() => false),
  ]);
  expect(overlapped).toBe(true);
  expect(approvalOrder).toEqual(['shell-1', 'shell-2']);
  expect(started).toEqual(['shell-1', 'shell-2']);

  release();
  await run;
  expect(events.filter((event) => event.type === 'tool.started')).toHaveLength(2);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  expect(kernel.getState().tools.calls['shell-2']?.status).toBe('succeeded');
  kernel.close();
});

test('cancelling a later shell approval aborts the turn and cancels a running sibling', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'cancel-incremental-shell-approval',
    userId: 'u',
    workspace: '/',
  });
  for (const [ordinal, toolCallId] of ['shell-1', 'shell-2'].entries()) {
    initial.tools.queue.push(toolCallId);
    initial.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'parallel-shell-message',
      ordinal,
      name: 'shell_execute',
      args: { command: `node task-${ordinal + 1}.js` },
      status: 'queued',
      createdAtTurnId: initial.turn.turnId,
    };
  }
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });

  let releaseRunningShell!: () => void;
  const runningShellReleased = new Promise<void>((resolve) => {
    releaseRunningShell = resolve;
  });
  let reportRunningShellSettled!: () => void;
  const runningShellSettled = new Promise<void>((resolve) => {
    reportRunningShellSettled = resolve;
  });
  let modelCalls = 0;
  const events: RuntimeEvent[] = [];

  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, state, emit) => {
      if (effect.type === 'call_model') {
        modelCalls += 1;
        return [{ type: 'model.responded', messageId: 'unexpected', text: 'unexpected' }];
      }
      if (effect.type !== 'run_tools') return [];
      const toolCallId = effect.toolCallIds[0]!;
      const call = state.tools.calls[toolCallId]!;
      if (call.status === 'queued') {
        emit?.({
          type: 'approval.requested',
          interactionId: `approval-${toolCallId}`,
          toolCallId,
          approval: {
            scope: 'once',
            cwd: '/',
            threadId: state.session.threadId,
            tool: 'shell_execute',
            command: String((call.args as { command: string }).command),
            risk: 'execute_code',
            approvalHash: `hash-${toolCallId}`,
            summary: `Run ${toolCallId}`,
            reason: 'Test whole-turn approval cancellation.',
            expectedEffects: [],
            grantOptions: ['approve_once'],
            recommendedGrant: 'approve_once',
          },
        });
        return [];
      }
      emit?.({ type: 'tool.started', toolCallId });
      try {
        await runningShellReleased;
        return [
          {
            type: 'tool.finished',
            toolCallId,
            name: 'shell_execute',
            result: {
              ok: true,
              command: String((call.args as { command: string }).command),
              exitCode: 0,
              stdout: toolCallId,
              stderr: '',
            },
          },
        ];
      } finally {
        reportRunningShellSettled();
      }
    },
    {
      requestAction: async (effect) => {
        if (effect.type !== 'request_tool_approval') {
          throw new Error(`Unexpected interaction: ${effect.type}`);
        }
        return effect.toolCallId === 'shell-1'
          ? {
              type: 'approve',
              interactionId: effect.interactionId,
              grant: 'approve_once',
            }
          : {
              type: 'cancel',
              interactionId: effect.interactionId,
              reason: 'Cancelled second approval.',
            };
      },
    },
  )) {
    events.push(event);
  }

  expect(events.map((event) => event.type)).toEqual(
    expect.arrayContaining(['approval.rejected', 'tool.cancelled', 'turn.aborted']),
  );
  expect(modelCalls).toBe(0);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('cancelled');
  expect(kernel.getState().tools.calls['shell-2']?.status).toBe('rejected');
  expect(kernel.getState().interactions.kind).toBe('idle');

  releaseRunningShell();
  await runningShellSettled;
  kernel.close();
});

test('a cancelled concurrent shell rejects its late terminal event', () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'cancel-concurrent-shell',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.queue.push('shell-1');
  initial.tools.calls['shell-1'] = {
    toolCallId: 'shell-1',
    modelMessageId: 'parallel-shell-message',
    name: 'shell_execute',
    args: { command: 'node long-running.js' },
    status: 'approved',
    approvalGrant: 'approve_once',
    createdAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const lease = kernel.beginEffect({ type: 'run_tools', toolCallIds: ['shell-1'] });

  expect(kernel.applyEffectEvent(lease, { type: 'tool.started', toolCallId: 'shell-1' })).toBe(
    true,
  );
  kernel.processEvent({
    type: 'tool.cancelled',
    toolCallId: 'shell-1',
    reason: 'Cancelled by user.',
  });
  expect(
    kernel.applyEffectEvent(lease, {
      type: 'tool.finished',
      toolCallId: 'shell-1',
      name: 'shell_execute',
      result: {
        ok: true,
        command: 'node long-running.js',
        exitCode: 0,
        stdout: 'late success',
        stderr: '',
      },
    }),
  ).toBe(false);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('cancelled');
  kernel.close();
});

test('a stale concurrent shell lease accepts one ordered started-to-finished result batch', () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'concurrent-shell-result-batch',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.queue.push('shell-1');
  initial.tools.calls['shell-1'] = {
    toolCallId: 'shell-1',
    modelMessageId: 'parallel-shell-message',
    name: 'shell_execute',
    args: { command: 'node task.js' },
    status: 'approved',
    approvalGrant: 'approve_once',
    createdAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const lease = kernel.beginEffect({ type: 'run_tools', toolCallIds: ['shell-1'] });
  kernel.processEvent({
    type: 'run.error',
    message: 'Unrelated diagnostic advanced the revision.',
    recoverable: true,
  });

  expect(
    kernel.applyEffectResult(lease, [
      { type: 'tool.started', toolCallId: 'shell-1' },
      {
        type: 'tool.finished',
        toolCallId: 'shell-1',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'node task.js',
          exitCode: 0,
          stdout: 'done',
          stderr: '',
        },
      },
    ]),
  ).toBe(true);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  kernel.close();
});

test('a stale concurrent shell lease forwards ephemeral progress without advancing revision', () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'concurrent-shell-progress',
    userId: 'u',
    workspace: '/',
  });
  initial.tools.queue.push('shell-1');
  initial.tools.calls['shell-1'] = {
    toolCallId: 'shell-1',
    modelMessageId: 'parallel-shell-message',
    name: 'shell_execute',
    args: { command: 'node task.js' },
    status: 'approved',
    approvalGrant: 'approve_once',
    createdAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const lease = kernel.beginEffect({ type: 'run_tools', toolCallIds: ['shell-1'] });
  expect(kernel.applyEffectEvent(lease, { type: 'tool.started', toolCallId: 'shell-1' })).toBe(
    true,
  );
  kernel.processEvent({
    type: 'run.error',
    message: 'A sibling advanced the revision.',
    recoverable: true,
  });
  const revisionBeforeProgress = kernel.getState().revision;
  const progress: RuntimeEvent = {
    type: 'tool.progress',
    toolCallId: 'shell-1',
    chunk: 'still running',
    stream: 'stdout',
  };

  expect(kernel.isEffectEventCurrent(lease, progress)).toBe(true);
  expect(kernel.getState().revision).toBe(revisionBeforeProgress);
  expect(store.loadEventsStrict('concurrent-shell-progress').at(-1)?.event.type).toBe('run.error');
  expect(
    kernel.applyEffectEvent(lease, {
      type: 'tool.finished',
      toolCallId: 'shell-1',
      name: 'shell_execute',
      result: {
        ok: true,
        command: 'node task.js',
        exitCode: 0,
        stdout: 'still running',
        stderr: '',
      },
    }),
  ).toBe(true);
  expect(kernel.getState().tools.calls['shell-1']?.status).toBe('succeeded');
  kernel.close();
});

test('production executor overlaps tools from a scheduler read batch', async () => {
  const state = createInitialRuntimeState({
    threadId: 'parallel-read-executor',
    userId: 'u',
    workspace: '/workspace',
  });
  for (const [toolCallId, command] of [
    ['read-a', 'pwd'],
    ['read-b', 'ls -la'],
  ] as const) {
    state.tools.queue.push(toolCallId);
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
  }

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reportBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    reportBothStarted = resolve;
  });
  const entered: string[] = [];
  const executor = createRuntimeEffectExecutor({
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: true },
    },
    model: {} as never,
    shellExecutor: async ({ command }) => {
      entered.push(command);
      if (entered.length === 2) reportBothStarted();
      await released;
      return { ok: true, command, exitCode: 0, stdout: command, stderr: '' };
    },
  });

  const emitted: RuntimeEvent[] = [];
  const execution = executor(
    { type: 'run_tools', toolCallIds: ['read-a', 'read-b'] },
    state,
    (event) => emitted.push(event),
  );
  const overlapped = await Promise.race([
    bothStarted.then(() => true),
    Bun.sleep(250).then(() => false),
  ]);
  release();
  const terminalEvents = await execution;

  expect(overlapped).toBe(true);
  expect(entered).toEqual(['pwd', 'ls -la']);
  expect(emitted.filter((event) => event.type === 'tool.started')).toHaveLength(2);
  expect(emitted.filter((event) => event.type === 'tool.finished')).toHaveLength(0);
  expect(terminalEvents.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
});

test('production executor all-settled waits for a sibling when another adapter throws', async () => {
  const state = createInitialRuntimeState({
    threadId: 'all-settled-production-executor',
    userId: 'u',
    workspace: '/workspace',
  });
  for (const [toolCallId, command] of [
    ['throwing', 'pwd'],
    ['slow', 'ls'],
  ] as const) {
    state.tools.queue.push(toolCallId);
    state.tools.calls[toolCallId] = {
      toolCallId,
      modelMessageId: 'model',
      name: 'shell_execute',
      args: { command },
      status: 'queued',
      effectClass: 'read_only',
      sideEffect: false,
      createdAtTurnId: state.turn.turnId,
    };
  }
  let slowFinished = false;
  const executor = createRuntimeEffectExecutor({
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: true },
    },
    model: {} as never,
    shellExecutor: async ({ command }) => {
      if (command === 'pwd') throw new Error('private adapter failure');
      await Bun.sleep(20);
      slowFinished = true;
      return { ok: true, command, exitCode: 0, stdout: '', stderr: '' };
    },
  });
  const terminal = await executor({ type: 'run_tools', toolCallIds: ['throwing', 'slow'] }, state);
  expect(slowFinished).toBe(true);
  expect(terminal.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
  expect(JSON.stringify(terminal)).not.toContain('private adapter failure');
});

test('production executor commits provider recovery after the originating tool failure', async () => {
  const state = createInitialRuntimeState({
    threadId: 'provider-action-order',
    userId: 'u',
    workspace: '/workspace',
  });
  state.authorization = { mode: 'full_access', commandGrants: {} };
  const descriptorWithoutRevision = {
    capabilityId: 'mcp:github/publish',
    kind: 'mcp_tool' as const,
    displayName: 'publish',
    description: 'Publish a fixture.',
    provider: { type: 'mcp' as const, id: 'github', provenance: 'user' as const },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    declaredEffects: {
      filesystem: 'none' as const,
      network: 'read' as const,
      externalState: 'read' as const,
    },
    effectiveEffects: {
      filesystem: 'none' as const,
      network: 'read' as const,
      externalState: 'read' as const,
    },
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' as const },
    availability: 'available' as const,
    diagnostics: [],
  };
  const descriptor = {
    ...descriptorWithoutRevision,
    revision: descriptorRevision(descriptorWithoutRevision),
  };
  const binding = createBinding({
    descriptor,
    exposedToolName: 'mcp__github__publish',
    turnId: state.turn.turnId,
  });
  state.capabilities.bindings[binding.bindingId] = binding;
  state.tools.calls.mcp = {
    toolCallId: 'mcp',
    modelMessageId: 'model',
    name: 'mcp__github__publish',
    args: {},
    status: 'queued',
    bindingId: binding.bindingId,
    capabilityId: descriptor.capabilityId,
    capabilityRevision: descriptor.revision,
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue.push('mcp');
  const manager = new McpConnectionManager();
  manager.findCapability = () => descriptor;
  manager.getProviderDirectorySnapshot = () => ({
    revision: 'directory',
    entries: [
      {
        providerId: 'github',
        status: 'login_required',
        required: false,
        source: 'user',
        lastKnownCapabilityNames: ['publish'],
        diagnosticCode: 'auth_required',
        retryable: false,
      },
    ],
  });
  const runtimeManager = manager as McpConnectionManager & {
    ensureProviderReady(providerId: string, timeoutMs?: number): Promise<void>;
  };
  runtimeManager.ensureProviderReady = async () => {
    throw new McpProviderError({
      providerId: 'github',
      kind: 'provider_auth_required',
      message: 'redacted fixture authorization required',
      recoveryAction: 'login',
      retryable: false,
    });
  };
  const executor = createRuntimeEffectExecutor({
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: false },
      features: {
        capabilityCatalogV1: true,
        mcpRuntimeBindingV1: true,
        mcpProviderActionV1: true,
      },
    },
    model: {} as never,
    mcpManager: runtimeManager,
  });
  const emitted: RuntimeEvent[] = [];
  let runtimeState = state;

  const terminalEvents = await executor(
    { type: 'run_tools', toolCallIds: ['mcp'] },
    state,
    (event) => emitted.push(event),
    {
      reservationIds: [],
      getState: () => runtimeState,
      persistEvent: async (event) => {
        runtimeState = reduceRuntimeState(runtimeState, event);
        return true;
      },
      persistEvents: async (events) => {
        for (const event of events) runtimeState = reduceRuntimeState(runtimeState, event);
        return true;
      },
    },
  );

  expect(emitted.some((event) => event.type === 'provider.action_required')).toBe(false);
  expect(terminalEvents.map((event) => event.type)).toEqual([
    'tool.failed',
    'provider.action_required',
  ]);
});

test('batch run completion persists a named rewind recovery point', () => {
  const store = createRuntimeStore(':memory:');
  const initialState = createInitialRuntimeState({
    threadId: 'batch-completion-rewind',
    userId: 'u',
    workspace: '/workspace',
  });
  const kernel = new AgentKernel({
    store,
    initialState,
    interactionMode: 'accept_edits',
  });

  kernel.processEventBatch([
    {
      type: 'run.completed',
      turnId: initialState.turn.turnId,
      output: 'done',
    },
    {
      type: 'turn.completed',
      turnId: initialState.turn.turnId,
    },
  ]);

  expect(store.listNamedSnapshots(initialState.session.threadId)).toEqual([
    expect.objectContaining({
      snapshotId: expect.stringContaining(`turn-${initialState.turn.turnId}-`),
      eventPosition: 2,
    }),
  ]);
  kernel.close();
});

test('runRuntimeLoop yields model deltas without persisting or reducing them', async () => {
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createInitialRuntimeState({
      threadId: 'ephemeral-model-deltas',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  const revisionBeforeDelta = kernel.getState().revision;
  const events: RuntimeEvent[] = [];

  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, _state, emit) => {
      if (effect.type !== 'call_model') return [];
      emit?.({ type: 'model.reasoning_delta', text: 'thinking' });
      emit?.({ type: 'model.text_delta', text: 'partial' });
      expect(kernel.getState().revision).toBe(revisionBeforeDelta);
      return [{ type: 'model.responded', messageId: 'answer', text: 'complete' }];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
  )) {
    events.push(event);
  }

  expect(events.slice(0, 3).map((event) => event.type)).toEqual([
    'model.reasoning_delta',
    'model.text_delta',
    'model.responded',
  ]);
  expect(
    store
      .loadEventsStrict('ephemeral-model-deltas')
      .map(({ event }) => event.type)
      .filter((type) => type.endsWith('_delta')),
  ).toEqual([]);
  expect(kernel.getState().transcript.final).toBe('complete');
  kernel.close();
});

test('runRuntimeLoop drops ephemeral model deltas from a stale effect lease', async () => {
  const store = createRuntimeStore(':memory:');
  const kernel = new AgentKernel({
    store,
    initialState: createInitialRuntimeState({
      threadId: 'stale-ephemeral-model-delta',
      userId: 'u',
      workspace: '/',
    }),
    interactionMode: 'accept_edits',
  });
  const events: RuntimeEvent[] = [];
  let calls = 0;

  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, _state, emit) => {
      if (effect.type !== 'call_model') return [];
      calls += 1;
      if (calls === 1) {
        kernel.processEvent({
          type: 'model.retry',
          attempt: 1,
          maxAttempts: 5,
          error: 'external revision change',
          delayMs: 0,
        });
        emit?.({ type: 'model.text_delta', text: 'stale text' });
        return [{ type: 'model.responded', messageId: 'stale', text: 'stale text' }];
      }
      return [{ type: 'model.responded', messageId: 'fresh', text: 'fresh text' }];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    4,
  )) {
    events.push(event);
  }

  expect(events.some((event) => event.type === 'model.text_delta')).toBe(false);
  expect(kernel.getState().transcript.final).toBe('fresh text');
  kernel.close();
});

test('run cancellation atomically settles running and queued tools while keeping the task resumable', () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'cancel-run',
    userId: 'u',
    workspace: '/workspace',
  });
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  kernel.processEvents([
    {
      type: 'user.message_appended',
      messageId: 'user-1',
      content: 'inspect the runtime',
    },
    {
      type: 'model.responded',
      messageId: 'model-1',
      toolCalls: [
        { id: 'shell-1', name: 'shell_execute', args: { command: 'bun test' } },
        { id: 'read-1', name: 'read_file', args: { path: 'src/core/runtime/agent.ts' } },
      ],
    },
    {
      type: 'tool.queued',
      toolCallId: 'shell-1',
      modelMessageId: 'model-1',
      ordinal: 0,
      name: 'shell_execute',
      args: { command: 'bun test' },
    },
    {
      type: 'tool.queued',
      toolCallId: 'read-1',
      modelMessageId: 'model-1',
      ordinal: 1,
      name: 'read_file',
      args: { path: 'src/core/runtime/agent.ts' },
    },
    { type: 'tool.started', toolCallId: 'shell-1' },
  ]);
  const activeTaskId = kernel.getState().activeTaskId;

  const events = eventsForRunCancellation(kernel.getState());
  kernel.processEventBatch(events);

  expect(events.map((event) => event.type)).toEqual([
    'tool.cancelled',
    'tool.cancelled',
    'turn.aborted',
  ]);
  expect(kernel.getState().tools.queue).toEqual([]);
  expect(kernel.getState().tools.active).toEqual([]);
  expect(kernel.getState().tools.calls['shell-1']!.status).toBe('cancelled');
  expect(kernel.getState().tools.calls['read-1']!.status).toBe('cancelled');
  expect(kernel.getState().activeTaskId).toBe(activeTaskId);
  expect(
    kernel
      .getState()
      .transcript.messages.filter((message) => message.kind === 'tool')
      .map((message) => message.toolCallId),
  ).toEqual(['shell-1', 'read-1']);
  expect(
    kernel.runtimeStore
      .loadEventsStrict('cancel-run')
      .slice(-3)
      .map(({ event }) => event),
  ).toMatchObject([
    { type: 'tool.cancelled', toolCallId: 'shell-1' },
    { type: 'tool.cancelled', toolCallId: 'read-1' },
    { type: 'turn.aborted', cause: 'user' },
  ]);
  kernel.close();
});
