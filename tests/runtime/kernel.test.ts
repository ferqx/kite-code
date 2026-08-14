import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  eventsForInvalidModelToolCalls,
  invokeRuntimeModel,
  resolveContextProjectionEnvironment,
} from '../../src/core/controllers/model-controller';
import { executeRuntimeTools } from '../../src/core/controllers/tool-controller';
import { createRemoteMcpEgressReceiptV1 } from '../../src/core/mcp/egress-permit';
import { McpConnectionManager } from '../../src/core/mcp/manager';
import { aiMessage } from '../../src/core/messages';
import { buildContextProjection } from '../../src/core/model/context-projection';
import { eventsForRunCancellation } from '../../src/core/runtime/actions';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { createRuntimeEffectExecutor } from '../../src/core/runtime/executor';
import { classifyFailure } from '../../src/core/runtime/failures';
import { AgentKernel, createAgentKernel } from '../../src/core/runtime/kernel';
import { runRuntimeLoop } from '../../src/core/runtime/runner';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from '../../src/core/runtime/state';
import {
  createRuntimeStore,
  RemoteMcpEgressNonceConflictError,
  type RuntimeStore,
} from '../../src/core/runtime/store';
import { createToolRecoveryJournalV1 } from '../../src/core/runtime/tool-recovery-journal';
import { createMockModel } from '../mock-model';

describe('AgentKernel durability', () => {
  test('fails closed when a current v23 snapshot omits the recovery journal', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-v23-missing-recovery-'));
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
      expect(restored.getState().toolRecovery.qualityGuard).toMatchObject({
        blocked: true,
        reasonCode: 'journal_invalid',
      });
      expect(decideNextEffect(restored.getState())).toMatchObject({ type: 'recovery_blocked' });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('initializes a missing recovery journal only while migrating a pre-v23 snapshot', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-v22-missing-recovery-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'v22-missing-recovery';
    try {
      const legacy = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      legacy.schemaVersion = 22;
      delete (legacy as Partial<RuntimeState>).toolRecovery;
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, legacy);
      store.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(restored.getState().toolRecovery.qualityGuard).toEqual({
        blocked: false,
        observedFailures: 0,
      });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrates every legacy suspended child into the parent recovery domain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-v22-suspended-recovery-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'v22-suspended-recovery';
    try {
      const legacy = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      legacy.schemaVersion = 22;
      delete (legacy as Partial<RuntimeState>).toolRecovery;
      legacy.suspendedSubagents['task-1'] = {
        subagentId: 'child-1',
        role: 'explore',
        task: 'Inspect the workspace.',
        messages: [],
        toolCallCount: 1,
        steps: [],
        blockedTool: {
          toolCallId: 'nested-1',
          toolName: 'read_file',
          args: { path: 'README.md' },
          command: 'README.md',
        },
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(threadId, legacy);
      store.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      const child = restored.getState().suspendedSubagents['task-1'];
      expect(child?.toolRecovery).toMatchObject({
        identityKey: restored.getState().toolRecovery.identityKey,
        qualityGuard: { blocked: false },
      });
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
      afterCompletedTail.saveSnapshot();
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

  test('migrates v14 snapshots with an empty context checkpoint runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-pr6-migration-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const legacy = createInitialRuntimeState({
        threadId: 'pr6-migration',
        userId: 'user',
        workspace: '/workspace',
      });
      legacy.schemaVersion = 14;
      delete (legacy as Partial<RuntimeState>).context;
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(legacy.session.threadId, legacy);
      store.close();

      const restored = createAgentKernel({
        threadId: legacy.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(restored.getState().context).toMatchObject({ history: [] });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrates a v16 snapshot by recovering its persisted terminal turn event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-turn-lifecycle-migration-'));
    const storePath = join(dir, 'runtime.db');
    const threadId = 'turn-lifecycle-migration';
    try {
      const legacy = createInitialRuntimeState({
        threadId,
        userId: 'user',
        workspace: '/workspace',
      });
      legacy.schemaVersion = 16;
      delete (legacy.turn as Partial<RuntimeState['turn']>).status;
      legacy.revision = 1;
      legacy.lastAppliedEventId = 'abort-v16';
      legacy.appliedEventIds = ['abort-v16'];

      const store = createRuntimeStore(storePath);
      store.appendEvents(
        threadId,
        [
          {
            type: 'turn.aborted',
            turnId: legacy.turn.turnId,
            reason: 'Plan execution confirmation cancelled by user.',
            cause: 'user',
          },
        ],
        [
          {
            eventId: 'abort-v16',
            revision: 1,
            occurredAt: '2026-07-29T00:00:00.000Z',
          },
        ],
      );
      store.saveSnapshot(threadId, legacy);
      store.close();

      const restored = createAgentKernel({
        threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(restored.getState().turn).toMatchObject({
        status: 'aborted',
        abortCause: 'user',
      });
      expect(decideNextEffect(restored.getState())).toEqual({ type: 'stop' });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrates v13 transcript identities without synthetic legacy turns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-pr3-migration-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const legacy = createInitialRuntimeState({
        threadId: 'pr3-migration',
        userId: 'user',
        workspace: '/workspace',
      }) as RuntimeState;
      legacy.schemaVersion = 13;
      legacy.transcript.messages = [
        { kind: 'user', messageId: 'user-1', content: 'hello' },
        {
          kind: 'tool',
          toolCallId: 'tool-1',
          name: 'read_file',
          content: 'legacy content',
          ok: true,
        },
      ];
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(legacy.session.threadId, legacy);
      store.close();

      const restored = createAgentKernel({
        threadId: legacy.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      const restoredMessages = restored.getState().transcript.messages;
      const restoredTurnId = restoredMessages[0]?.turnId;
      expect(restoredMessages).toEqual([
        expect.objectContaining({
          messageId: 'user-1',
          turnId: restoredTurnId,
          ordinal: 0,
          createdAt: '1970-01-01T00:00:00.000Z',
        }),
        expect.objectContaining({
          messageId: 'tool-tool-1',
          turnId: restoredTurnId,
          ordinal: 1,
          createdAt: '1970-01-01T00:00:00.000Z',
        }),
      ]);
      restored.close();
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

  test('migrates schema 12 snapshots with an empty session-loaded capability set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-loaded-capability-migration-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const state = createInitialRuntimeState({
        threadId: 'loaded-capability-migration',
        userId: 'user',
        workspace: '/workspace',
      });
      const { loadedCapabilities: _loaded, ...legacyCapabilities } = state.capabilities;
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(state.session.threadId, {
        ...state,
        schemaVersion: 12,
        capabilities: legacyCapabilities,
      });
      store.close();

      const restored = createAgentKernel({
        threadId: state.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(restored.getState().capabilities.loadedCapabilities).toEqual({});
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrates schema 11 snapshots with an empty required-provider admission state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-provider-admission-migration-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const state = createInitialRuntimeState({
        threadId: 'provider-admission-migration',
        userId: 'user',
        workspace: '/workspace',
      });
      const { providerAdmission: _admission, ...schema11 } = state;
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(state.session.threadId, { ...schema11, schemaVersion: 11 });
      store.close();

      const restored = createAgentKernel({
        threadId: state.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(restored.getState().providerAdmission).toEqual({ pending: [], waivers: {} });
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('migrates and resumes a persisted provider action interaction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-provider-action-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const state = createInitialRuntimeState({
        threadId: 'provider-action-restart',
        userId: 'user',
        workspace: '/workspace',
      });
      state.schemaVersion = 10;
      state.tools.calls.mcp = {
        toolCallId: 'mcp',
        modelMessageId: 'model',
        name: 'mcp__github__publish',
        args: {},
        status: 'failed',
        createdAtTurnId: state.turn.turnId,
      };
      state.interactions = {
        kind: 'awaiting_provider_action',
        interactionId: 'provider-action',
        providerId: 'github',
        action: 'login',
        originatingToolCallId: 'mcp',
        status: 'started',
      };
      const store = createRuntimeStore(storePath);
      store.saveSnapshot(state.session.threadId, state);
      store.close();

      const restored = createAgentKernel({
        threadId: state.session.threadId,
        userId: 'user',
        workspace: '/workspace',
        storePath,
      });
      expect(restored.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(restored.getState().interactions).toMatchObject({
        kind: 'awaiting_provider_action',
        interactionId: 'provider-action',
        status: 'started',
      });
      expect(decideNextEffect(restored.getState()).type).toBe('request_provider_action');
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

test('runRuntimeLoop rechecks legacy V1 plan continuation after effect preparation', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'legacy-plan-loop',
    userId: 'u',
    workspace: '/',
  });
  initial.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  let dispatched = false;
  const eventTypes: string[] = [];

  for await (const event of runRuntimeLoop(
    kernel,
    async () => {
      dispatched = true;
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'none' }) },
    2,
    async () => ({ type: 'call_model' }),
  )) {
    eventTypes.push(event.type);
  }

  expect(dispatched).toBe(false);
  expect(eventTypes).toEqual(['turn.aborted', 'run.error']);
  expect(kernel.getState().turn.status).toBe('aborted');
  kernel.close();
});

test.each([
  'awaiting_input',
  'unknown_invocation',
  'completion_correction',
] as const)('post-prepare legacy guard rejects a canonical barrier replacement: %s', async (barrier) => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: `legacy-prepare-barrier-${barrier}`,
    userId: 'u',
    workspace: '/',
  });
  initial.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: initial.turn.turnId,
  };
  if (barrier === 'awaiting_input') {
    initial.tools.calls['input-tool'] = {
      toolCallId: 'input-tool',
      modelMessageId: 'input-model',
      name: 'ask_user',
      args: {},
      status: 'awaiting_user_input',
      createdAtTurnId: initial.turn.turnId,
    };
    initial.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input-interaction',
      toolCallId: 'input-tool',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
  } else if (barrier === 'unknown_invocation') {
    initial.capabilities.invocations.unknown = {
      invocationId: 'unknown',
      toolCallId: 'external-tool',
      capabilityId: 'mcp:fixture/write',
      capabilityRevision: 'revision',
      argumentsDigest: 'args',
      authorizationDigest: 'authorization',
      effectiveEffectsDigest: 'effects',
      status: 'unknown',
      recordedAt: '2026-08-10T00:00:00.000Z',
    };
    initial.tools.calls['prepared-read'] = {
      toolCallId: 'prepared-read',
      modelMessageId: 'prepared-model',
      name: 'read_plan',
      args: {},
      status: 'queued',
      createdAtTurnId: initial.turn.turnId,
    };
    initial.tools.queue.push('prepared-read');
  } else {
    initial.transcript.messages.push({
      kind: 'assistant',
      messageId: 'failed-recovery',
      turnId: initial.turn.turnId,
      ordinal: 0,
      createdAt: '2026-08-10T00:00:00.000Z',
      content: 'Done without a V2 save.',
      toolCalls: [],
      toolSurface: 'legacy_plan_recovery',
    });
    initial.transcript.final = 'Done without a V2 save.';
  }
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  let dispatched = false;
  const eventTypes: string[] = [];

  for await (const event of runRuntimeLoop(
    kernel,
    async () => {
      dispatched = true;
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'input-interaction' }) },
    2,
    async () =>
      barrier === 'unknown_invocation'
        ? { type: 'run_tools', toolCallIds: ['prepared-read'] }
        : { type: 'call_model', toolSurface: 'legacy_plan_recovery' },
  )) {
    eventTypes.push(event.type);
  }

  expect(dispatched).toBe(false);
  expect(eventTypes).toEqual(['turn.aborted', 'run.error']);
  kernel.close();
});

test('a legacy V1 snapshot reaches restricted model recovery and saves a V2 replan', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'legacy-recovery-model',
    userId: 'u',
    workspace: '/workspace',
  });
  initial.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  const seenEffects: string[] = [];
  const artifactStore = {
    write(taskId: string, plan: import('../../src/protocol/events').PlanDocument) {
      return {
        artifactId: `${plan.planId}:v${plan.version}`,
        taskId,
        planId: plan.planId,
        version: plan.version,
        fileName: `v${plan.version}.md`,
        relativePath: `plans/${taskId}/${plan.planId}/v${plan.version}.md`,
        displayPath: `/plans/${taskId}/${plan.planId}/v${plan.version}.md`,
        structuralDigest: plan.structuralDigest,
        byteLength: 100,
      };
    },
  };

  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, state) => {
      seenEffects.push(effect.type);
      if (effect.type === 'call_model') {
        expect((effect as typeof effect & { toolSurface?: string }).toolSurface).toBe(
          'legacy_plan_recovery',
        );
        const args = {
          action: 'save' as const,
          plan_id: 'legacy-plan',
          version: 1,
          structural_digest: 'legacy-digest',
          title: 'Recovered Plan V2',
          body_markdown: 'Replace the legacy execution with a validated V2 recovery plan.',
          steps: [{ id: 'recover-plan', title: 'Continue from the recovered V2 plan' }],
          replan_reason: 'legacy_schema_upgrade',
        };
        return [
          {
            type: 'model.responded',
            messageId: 'legacy-recovery-response',
            toolCalls: [{ id: 'legacy-replan', name: 'write_plan', args }],
          },
          {
            type: 'tool.queued',
            toolCallId: 'legacy-replan',
            name: 'write_plan',
            args,
            modelMessageId: 'legacy-recovery-response',
            ordinal: 0,
            effectClass: 'plan_only',
            sideEffect: false,
            createdAtTurnId: state.turn.turnId,
          },
        ];
      }
      if (effect.type === 'run_tools') {
        return executeRuntimeTools({
          state: state as RuntimeState,
          toolCallIds: effect.toolCallIds,
          planArtifactStore: artifactStore as never,
        });
      }
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    2,
  )) {
    if (event.type === 'plan.drafted') break;
  }

  expect(seenEffects).toEqual(['call_model', 'run_tools']);
  expect(kernel.getState().planning).toMatchObject({
    kind: 'replanning_draft',
    document: {
      planSchemaVersion: 2,
      planId: 'legacy-plan',
      version: 2,
    },
  });
  kernel.close();
});

test('legacy recovery final text gets one correction then aborts through CompletionGuard V1', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'legacy-recovery-final-ceiling',
    userId: 'u',
    workspace: '/workspace',
  });
  initial.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  let modelCalls = 0;
  const events: RuntimeEvent[] = [];

  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, _state, _emit, context) => {
      expect(effect).toMatchObject({ type: 'call_model', toolSurface: 'legacy_plan_recovery' });
      modelCalls += 1;
      await context?.persistEvent({
        type: 'model.responded',
        messageId: `legacy-final-${modelCalls}`,
        text: 'Done without saving a V2 plan.',
      });
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    8,
  )) {
    events.push(event);
  }

  expect(modelCalls).toBe(2);
  expect(events.map((event) => event.type)).toEqual([
    'model.responded',
    'completion.blocked',
    'model.responded',
    'completion.blocked',
    'turn.aborted',
    'run.error',
  ]);
  expect(events.some((event) => event.type === 'run.completed')).toBe(false);
  expect(kernel.getState().completionGuard?.correctionAttempts).toBe(2);
  expect(
    kernel
      .getState()
      .transcript.messages.filter((message) => message.kind === 'assistant')
      .every((message) => message.toolSurface === 'legacy_plan_recovery'),
  ).toBe(true);
  kernel.close();
});

test('legacy recovery forged tools get one correction then abort through CompletionGuard V1', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'legacy-recovery-tool-ceiling',
    userId: 'u',
    workspace: '/workspace',
  });
  initial.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  let modelCalls = 0;
  const events: RuntimeEvent[] = [];

  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, state) => {
      expect(effect).toMatchObject({ type: 'call_model', toolSurface: 'legacy_plan_recovery' });
      modelCalls += 1;
      const toolCallId = `forged-shell-${modelCalls}`;
      const messageId = `legacy-forged-${modelCalls}`;
      return [
        {
          type: 'model.responded',
          messageId,
          toolCalls: [{ id: toolCallId, name: 'shell_execute', args: { command: 'pwd' } }],
        },
        {
          type: 'tool.queued',
          toolCallId,
          name: 'shell_execute',
          args: { command: 'pwd' },
          modelMessageId: messageId,
          ordinal: 0,
          effectClass: 'read_only',
          sideEffect: false,
          createdAtTurnId: state.turn.turnId,
        },
        {
          type: 'tool.rejected',
          toolCallId,
          reason: 'legacy_plan_replan_required',
          failure: classifyFailure('mandatory_policy_unavailable', 'legacy_plan_replan_required'),
        },
      ];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    8,
  )) {
    events.push(event);
  }

  expect(modelCalls).toBe(2);
  expect(events.filter((event) => event.type === 'tool.rejected')).toHaveLength(2);
  expect(events.filter((event) => event.type === 'completion.blocked')).toHaveLength(2);
  expect(events.slice(-2).map((event) => event.type)).toEqual(['turn.aborted', 'run.error']);
  expect(events.some((event) => event.type === 'run.completed')).toBe(false);
  expect(
    kernel
      .getState()
      .transcript.messages.filter((message) => message.kind === 'assistant')
      .every((message) => message.toolSurface === 'legacy_plan_recovery'),
  ).toBe(true);
  kernel.close();
});

test.each([
  'submit_failed',
  'write_rejected',
  'invalid_args',
] as const)('legacy recovery consumes one correction for terminal write_plan outcome: %s', async (outcome) => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: `legacy-recovery-${outcome}`,
    userId: 'u',
    workspace: '/workspace',
  });
  initial.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: initial.turn.turnId,
  };
  const kernel = new AgentKernel({
    store,
    initialState: initial,
    interactionMode: 'accept_edits',
  });
  let modelCalls = 0;
  const events: RuntimeEvent[] = [];

  for await (const event of runRuntimeLoop(
    kernel,
    async (effect, state) => {
      if (effect.type === 'call_model') {
        modelCalls += 1;
        const toolCallId = `${outcome}-${modelCalls}`;
        const messageId = `message-${toolCallId}`;
        const args =
          outcome === 'invalid_args'
            ? { _parse_error: 'invalid write_plan JSON' }
            : {
                action: 'submit',
                plan_id: 'legacy-plan',
                version: 1,
                structural_digest: 'legacy-digest',
              };
        const responded: RuntimeEvent = {
          type: 'model.responded',
          messageId,
          toolCalls: [{ id: toolCallId, name: 'write_plan', args }],
        };
        if (outcome === 'write_rejected') {
          return [
            responded,
            {
              type: 'tool.queued',
              toolCallId,
              name: 'write_plan',
              args,
              modelMessageId: messageId,
              ordinal: 0,
            },
            {
              type: 'tool.rejected',
              toolCallId,
              reason: 'legacy submit is not a V2 replan save',
              failure: classifyFailure(
                'mandatory_policy_unavailable',
                'legacy submit is not a V2 replan save',
              ),
            },
          ];
        }
        if (outcome === 'invalid_args') {
          return [
            responded,
            ...eventsForInvalidModelToolCalls(
              [{ id: toolCallId, name: 'write_plan', args }],
              messageId,
              0,
              'legacy_plan_recovery',
            ),
          ];
        }
        return [
          responded,
          {
            type: 'tool.queued',
            toolCallId,
            name: 'write_plan',
            args,
            modelMessageId: messageId,
            ordinal: 0,
            effectClass: 'plan_only',
            sideEffect: false,
            createdAtTurnId: state.turn.turnId,
          },
        ];
      }
      if (effect.type === 'run_tools') {
        return effect.toolCallIds.map((toolCallId) => ({
          type: 'tool.failed' as const,
          toolCallId,
          failure: classifyFailure(
            'mandatory_policy_unavailable',
            'legacy submit is not a V2 replan save',
          ),
        }));
      }
      return [];
    },
    { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
    8,
  )) {
    events.push(event);
  }

  expect(modelCalls).toBe(2);
  expect(events.filter((event) => event.type === 'completion.blocked')).toHaveLength(2);
  expect(events.slice(-2).map((event) => event.type)).toEqual(['turn.aborted', 'run.error']);
  expect(events.some((event) => event.type === 'run.completed')).toBe(false);
  kernel.close();
});

test('legacy plan model recovery discloses only plan read/save and rejects an undeclared tool', async () => {
  const state = createInitialRuntimeState({
    threadId: 'legacy-recovery-surface',
    userId: 'u',
    workspace: '/workspace',
  });
  state.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: state.turn.turnId,
      updatedAtTurnId: state.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: state.turn.turnId,
  };
  state.tools.calls['stale-write'] = {
    toolCallId: 'stale-write',
    modelMessageId: 'legacy-response',
    name: 'write_file',
    args: { path: 'forbidden', content: 'forbidden' },
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue.push('stale-write');
  const config = {
    providerName: 'fixture',
    providerType: 'openai-compatible' as const,
    apiKey: 'unused',
    baseURL: 'https://example.invalid',
    modelName: 'fixture-model',
    sandbox: { enabled: false },
    features: { promptContractV2: false },
  };
  const model = createMockModel([
    {
      message: aiMessage({
        content: '',
        tool_calls: [
          { id: 'bad-shell', name: 'shell_execute', args: { command: 'touch forbidden' } },
        ],
      }),
    },
  ]);
  const environment = resolveContextProjectionEnvironment({
    state,
    config,
    model,
    toolSurface: 'legacy_plan_recovery',
  });

  expect(environment.serializedTools.map((tool) => tool.name).sort()).toEqual([
    'read_plan',
    'write_plan',
  ]);
  expect(environment.promptContractVersion).toBe('legacy');
  const projection = buildContextProjection({
    role: 'agent',
    state,
    serializedTools: environment.serializedTools,
    workflowSkills: environment.workflowSkills,
    promptContractVersion: environment.promptContractVersion,
    sandboxBackend: environment.sandboxBackend,
    toolSurface: environment.toolSurface,
  });
  expect(JSON.stringify(projection.dynamicRuntimeMessages)).toContain(
    'structural_digest: legacy-digest',
  );
  expect(JSON.stringify(projection.dynamicRuntimeMessages)).toContain(
    'Legacy Plan recovery policy',
  );

  const events = await invokeRuntimeModel({
    state,
    config,
    model,
    toolSurface: 'legacy_plan_recovery',
  });
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'model.responded',
      toolSurface: 'legacy_plan_recovery',
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool.rejected',
      toolCallId: 'stale-write',
      reason: 'legacy_plan_replan_required',
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'tool.queued', toolCallId: 'bad-shell' }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'tool.rejected',
      toolCallId: 'bad-shell',
      reason: 'legacy_plan_replan_required',
    }),
  );
});

test('legacy queued non-plan tools are rejected before a failing Provider dispatch', async () => {
  const store = createRuntimeStore(':memory:');
  const initial = createInitialRuntimeState({
    threadId: 'legacy-pre-provider-rejection',
    userId: 'u',
    workspace: '/workspace',
  });
  initial.planning = {
    kind: 'executing',
    document: {
      planId: 'legacy-plan',
      version: 1,
      title: 'Legacy Plan',
      bodyMarkdown: 'A legacy plan restored from a V1 snapshot.',
      steps: [{ id: 'legacy-step', title: 'Legacy step', status: 'pending' }],
      structuralDigest: 'legacy-digest',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    },
    executionMode: 'auto',
    approvedAtTurnId: initial.turn.turnId,
  };
  initial.tools.calls['stale-write'] = {
    toolCallId: 'stale-write',
    modelMessageId: 'legacy-model',
    name: 'write_file',
    args: { path: 'stale.txt', content: 'stale' },
    status: 'queued',
    createdAtTurnId: initial.turn.turnId,
  };
  initial.tools.queue.push('stale-write');
  const kernel = new AgentKernel({ store, initialState: initial, interactionMode: 'accept_edits' });
  const yielded: RuntimeEvent[] = [];

  await expect(
    (async () => {
      for await (const event of runRuntimeLoop(
        kernel,
        async (effect, state) => {
          if (effect.type === 'run_tools') {
            return executeRuntimeTools({
              state: state as RuntimeState,
              toolCallIds: effect.toolCallIds,
            });
          }
          throw new Error('Provider dispatch failed');
        },
        { requestAction: async () => ({ type: 'cancel', interactionId: 'unused' }) },
        3,
      )) {
        yielded.push(event);
      }
    })(),
  ).rejects.toThrow('Provider dispatch failed');

  expect(yielded).toContainEqual(
    expect.objectContaining({
      type: 'tool.rejected',
      toolCallId: 'stale-write',
      reason: 'legacy_plan_replan_required',
    }),
  );
  expect(kernel.getState().tools.calls['stale-write']?.status).toBe('rejected');
  kernel.close();
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
  initial.planning = {
    kind: 'executing',
    document,
    executionMode: 'auto',
    approvedAtTurnId: initial.turn.turnId,
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

  expect(kernel.getState().planning.kind).toBe('executing');
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
    const document = {
      planId: 'plan-1',
      version: 1,
      title: 'Plan',
      bodyMarkdown: 'A plan to verify cancellation behavior.',
      steps: [{ id: 'step-1', title: 'Verify cancellation', status: 'pending' as const }],
      structuralDigest: 'digest-1',
      createdAtTurnId: initial.turn.turnId,
      updatedAtTurnId: initial.turn.turnId,
    };
    initial.planning = {
      kind: 'awaiting_review',
      document,
      interactionId: 'interaction-1',
      exitToolCallId: toolCallId,
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
    blockedTool: {
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
  expect(store.loadEvents('final').at(-1)?.event).toEqual({
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
    store.loadEvents('streamed-tool').some(({ event }) => event.type === 'tool.progress'),
  ).toBe(false);
  expect(
    store.loadEvents('streamed-tool').some(({ event }) => event.type === 'tool.finished'),
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
  expect(store.loadEvents('concurrent-shell-progress').at(-1)?.event.type).toBe('run.error');
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
  state.capabilities.bindings.binding = {
    bindingId: 'binding',
    capabilityId: 'mcp:github/publish',
    capabilityRevision: 'stale-revision',
    exposedToolName: 'mcp__github__publish',
    schemaDigest: 'schema',
    issuedForTurnId: state.turn.turnId,
  };
  state.tools.calls.mcp = {
    toolCallId: 'mcp',
    modelMessageId: 'model',
    name: 'mcp__github__publish',
    args: {},
    status: 'queued',
    bindingId: 'binding',
    capabilityId: 'mcp:github/publish',
    capabilityRevision: 'stale-revision',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue.push('mcp');
  const manager = new McpConnectionManager();
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
    mcpManager: manager,
  });
  const emitted: RuntimeEvent[] = [];

  const terminalEvents = await executor(
    { type: 'run_tools', toolCallIds: ['mcp'] },
    state,
    (event) => emitted.push(event),
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
      .loadEvents('ephemeral-model-deltas')
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

function legacySubagentApprovalState(threadId: string): RuntimeState {
  const state = createInitialRuntimeState({ threadId, userId: 'u', workspace: '/workspace' });
  state.tools.calls['task-call'] = {
    toolCallId: 'task-call',
    modelMessageId: 'message-1',
    name: 'task',
    args: { task: 'legacy task' },
    status: 'awaiting_approval',
    createdAtTurnId: state.turn.turnId,
  };
  state.interactions = {
    kind: 'awaiting_tool_approval',
    interactionId: 'approval-1',
    toolCallId: 'task-call',
    approval: {
      scope: 'once',
      cwd: '/workspace',
      threadId,
      tool: 'shell_execute',
      command: 'rm -rf generated',
      risk: 'destructive',
      approvalHash: 'legacy-approval',
      summary: 'Run legacy task command',
      reason: 'Approval required',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
      subagentId: 'subagent-legacy',
    },
  };
  state.transcript.final = 'resume complete';
  return state;
}

function createRecoveryExecutor() {
  return createRuntimeEffectExecutor({
    config: {
      providerName: 'test',
      providerType: 'openai-compatible',
      apiKey: 'test',
      baseURL: 'http://localhost:1',
      modelName: 'test',
      sandbox: { enabled: true },
    },
    model: {} as never,
  });
}

function recoveryUnavailableState(threadId: string): RuntimeState {
  return {
    ...legacySubagentApprovalState(threadId),
    legacyUnrecoverableSubagentApproval: {
      toolCallId: 'task-call',
      subagentId: 'subagent-legacy',
      reason: 'A legacy sub-agent approval cannot be resumed after recovery.',
    },
  };
}

function createBatchTrackingStore() {
  const store = createRuntimeStore(':memory:');
  const batches: RuntimeEvent[][] = [];
  const appendEventsAndSnapshot = store.appendEventsAndSnapshot.bind(store);
  store.appendEventsAndSnapshot = (threadId, events, state) => {
    batches.push(events);
    appendEventsAndSnapshot(threadId, events, state);
  };
  return { store, batches };
}

test('AgentKernel.run persists legacy recovery failure events as one atomic batch', async () => {
  const { store, batches } = createBatchTrackingStore();
  const kernel = new AgentKernel({
    store,
    initialState: recoveryUnavailableState('atomic-kernel'),
    interactionMode: 'accept_edits',
  });

  await kernel.run(createRecoveryExecutor());

  expect(batches.map((events) => events.map((event) => event.type))).toEqual([
    ['subagent.failed', 'tool.finished'],
  ]);
  kernel.close();
});

test('migrates a persisted v2 subagent approval and fails it without requesting approval again', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-v2-recovery-'));
  const storePath = join(workspace, 'runtime.db');
  const threadId = 'legacy-recovery';
  try {
    const store = createRuntimeStore(storePath);
    const legacy = legacySubagentApprovalState(threadId);
    const {
      suspendedSubagents: _suspended,
      legacyUnrecoverableSubagentApproval: _marker,
      ...v2
    } = legacy;
    store.saveSnapshot(threadId, { ...v2, schemaVersion: 2 });
    store.close();

    const kernel = createAgentKernel({ threadId, userId: 'u', workspace, storePath });
    expect(kernel.getState().suspendedSubagents).toEqual({});
    expect(kernel.getState().legacyUnrecoverableSubagentApproval).toMatchObject({
      toolCallId: 'task-call',
      subagentId: 'subagent-legacy',
    });
    expect(decideNextEffect(kernel.getState())).toMatchObject({
      type: 'subagent.recovery_unavailable',
      toolCallId: 'task-call',
      subagentId: 'subagent-legacy',
    });

    expect((await kernel.run(createRecoveryExecutor())).type).toBe('emit_final');
    const recoveryEvents = kernel.loadEvents(threadId).map(({ event }) => event);
    expect(recoveryEvents).toMatchObject([
      {
        type: 'subagent.failed',
        subagent: { id: 'subagent-legacy', error: expect.stringContaining('cannot be resumed') },
      },
      {
        type: 'tool.finished',
        toolCallId: 'task-call',
        name: 'task',
        result: { ok: false, status: 'error' },
      },
    ]);
    expect(kernel.getState().interactions).toEqual({ kind: 'idle' });
    expect(decideNextEffect(kernel.getState()).type).toBe('emit_final');
    kernel.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('runRuntimeLoop executes legacy recovery without asking the action provider', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'kite-runtime-v2-loop-'));
  const storePath = join(workspace, 'runtime.db');
  const threadId = 'legacy-loop';
  try {
    const store = createRuntimeStore(storePath);
    const legacy = legacySubagentApprovalState(threadId);
    const {
      suspendedSubagents: _suspended,
      legacyUnrecoverableSubagentApproval: _marker,
      ...v2
    } = legacy;
    store.saveSnapshot(threadId, { ...v2, schemaVersion: 2 });
    store.close();

    const kernel = createAgentKernel({ threadId, userId: 'u', workspace, storePath });
    const emitted: string[] = [];
    for await (const event of runRuntimeLoop(kernel, createRecoveryExecutor(), {
      requestAction: async () => {
        throw new Error('legacy recovery must not request user action');
      },
    })) {
      emitted.push(event.type);
    }

    expect(emitted).toEqual([
      'subagent.failed',
      'tool.finished',
      'run.completed',
      'turn.completed',
    ]);
    expect(kernel.getState().interactions).toEqual({ kind: 'idle' });
    kernel.close();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('runRuntimeLoop persists legacy recovery failure events as one atomic batch', async () => {
  const { store, batches } = createBatchTrackingStore();
  const kernel = new AgentKernel({
    store,
    initialState: recoveryUnavailableState('atomic-runner'),
    interactionMode: 'accept_edits',
  });

  for await (const _event of runRuntimeLoop(kernel, createRecoveryExecutor(), {
    requestAction: async () => {
      throw new Error('legacy recovery must not request user action');
    },
  })) {
    // Consume the generated events so the loop reaches its terminal effect.
  }

  expect(batches.map((events) => events.map((event) => event.type))).toEqual([
    ['subagent.failed', 'tool.finished'],
    ['run.completed', 'turn.completed'],
  ]);
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
    kernel
      .loadEvents('cancel-run')
      .slice(-3)
      .map(({ event }) => event),
  ).toMatchObject([
    { type: 'tool.cancelled', toolCallId: 'shell-1' },
    { type: 'tool.cancelled', toolCallId: 'read-1' },
    { type: 'turn.aborted', cause: 'user' },
  ]);
  kernel.close();
});
