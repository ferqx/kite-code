import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRemoteMcpEgressReceiptV1 } from '../../src/core/mcp/egress-permit';
import { McpConnectionManager } from '../../src/core/mcp/manager';
import { buildContextProjection } from '../../src/core/model/context-projection';
import { eventsForRunCancellation } from '../../src/core/runtime/actions';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { createRuntimeEffectExecutor } from '../../src/core/runtime/executor';
import { classifyFailure } from '../../src/core/runtime/failures';
import { AgentKernel, createAgentKernel } from '../../src/core/runtime/kernel';
import { runRuntimeLoop } from '../../src/core/runtime/runner';
import { decideNextEffect } from '../../src/core/runtime/scheduler';
import {
  createInitialRuntimeState,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from '../../src/core/runtime/state';
import {
  createRuntimeStore,
  RemoteMcpEgressNonceConflictError,
  type RuntimeStore,
} from '../../src/core/runtime/store';

describe('AgentKernel durability', () => {
  test('normalizes legacy tool digest provenance in call records and transcript messages', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kite-runtime-result-provenance-'));
    const storePath = join(dir, 'runtime.db');
    try {
      const legacy = createInitialRuntimeState({
        threadId: 'result-provenance',
        userId: 'user',
        workspace: '/workspace',
      });
      legacy.tools.calls['read-legacy'] = {
        toolCallId: 'read-legacy',
        modelMessageId: 'assistant-legacy',
        name: 'read_file',
        args: { path: 'src/legacy.ts' },
        status: 'succeeded',
        createdAtTurnId: 'legacy-turn',
        result: {
          ok: true,
          summary: 'legacy read',
          resultMeta: { path: 'src/legacy.ts', contentDigest: 'a'.repeat(64) },
        },
      };
      legacy.tools.calls['read-trusted'] = {
        toolCallId: 'read-trusted',
        modelMessageId: 'assistant-trusted',
        name: 'read_file',
        args: { path: 'src/trusted.ts' },
        status: 'succeeded',
        createdAtTurnId: 'trusted-turn',
        result: {
          ok: true,
          summary: 'trusted read',
          resultMeta: {
            path: 'src/trusted.ts',
            rawResultDigest: 'b'.repeat(64),
            modelContentDigest: 'c'.repeat(64),
            digestScope: 'raw',
          },
        },
      };
      legacy.transcript.messages = [
        {
          kind: 'tool',
          messageId: 'tool-read-legacy',
          turnId: 'legacy-turn',
          ordinal: 0,
          createdAt: '2026-08-09T00:00:00.000Z',
          toolCallId: 'read-legacy',
          name: 'read_file',
          content: 'legacy output',
          ok: true,
          resultMeta: { path: 'src/legacy.ts', contentDigest: 'a'.repeat(64) },
        },
        {
          kind: 'tool',
          messageId: 'tool-read-trusted',
          turnId: 'trusted-turn',
          ordinal: 1,
          createdAt: '2026-08-09T00:00:01.000Z',
          toolCallId: 'read-trusted',
          name: 'read_file',
          content: 'trusted output',
          ok: true,
          resultMeta: {
            path: 'src/trusted.ts',
            rawResultDigest: 'b'.repeat(64),
            modelContentDigest: 'c'.repeat(64),
            digestScope: 'raw',
          },
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
      expect(restored.getState().tools.calls['read-legacy']?.result?.resultMeta?.digestScope).toBe(
        'legacy_unknown',
      );
      expect(restored.getState().transcript.messages[0]).toMatchObject({
        kind: 'tool',
        resultMeta: { digestScope: 'legacy_unknown' },
      });
      expect(restored.getState().tools.calls['read-trusted']?.result?.resultMeta).toMatchObject({
        rawResultDigest: 'b'.repeat(64),
        modelContentDigest: 'c'.repeat(64),
        digestScope: 'raw',
      });
      expect(restored.getState().transcript.messages[1]).toMatchObject({
        kind: 'tool',
        resultMeta: {
          rawResultDigest: 'b'.repeat(64),
          modelContentDigest: 'c'.repeat(64),
          digestScope: 'raw',
        },
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
    ['read-b', 'git status --short'],
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
  expect(entered).toEqual(['pwd', 'git status --short']);
  expect(emitted.filter((event) => event.type === 'tool.started')).toHaveLength(2);
  expect(emitted.filter((event) => event.type === 'tool.finished')).toHaveLength(0);
  expect(terminalEvents.filter((event) => event.type === 'tool.finished')).toHaveLength(2);
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
