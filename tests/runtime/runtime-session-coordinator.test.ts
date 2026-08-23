import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextCompactionCheckpoint, RuntimeEvent } from '@kite/agent-kernel';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  BuiltinModelEffectCoordinator,
  buildContextProjection,
  type ContextProjectionEnvironment,
  createChatModel,
  expectedCompactionSourceDigest,
} from '@kite/builtin-runtime/model';
import { canonicalPathForComparison } from '@kite/builtin-runtime/sandbox';
import type { RuntimeHostExecutionServices } from '@kite/runtime-host';
import { createRuntimeHostStateInitialState, type RuntimeState } from '@kite/runtime-host';
import type { VerificationSpec } from '@kite/runtime-spi';
import { createBuiltinRuntimeModules, createBuiltinToolCatalogProjection } from '#builtin-runtime';
import { createRuntimeHostStateStorageBinding } from '#runtime-host';
import { createRuntimeModuleRegistry } from '#runtime-spi';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import type { InstalledKiteRuntimeComposition } from '../../apps/kite/src/bootstrap/model-runtime-composition';
import {
  createRuntimeSessionCoordinatorBinding,
  type RuntimeSessionCoordinatorIdentity,
} from '../../apps/kite/src/bootstrap/runtime/RuntimeSessionCoordinator';
import { createAppRuntimeEffectExecutor } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-coordinator';
import type { RuntimeExecutorDependencies } from '../../apps/kite/src/bootstrap/runtime/runtime-effect-dependencies';
import type { StateSessionStorage } from '../../apps/kite/src/bootstrap/runtime/state-runtime';
import { createRuntimeHostCapabilityExecutionPortFromSnapshot } from '../../packages/runtime-host/src/capability-execution';
import type { RuntimeSnapshotCodec } from '../../packages/runtime-host/src/storage';
import { createStateStorageForTest } from '../../scripts/support/runtime-storage';
import { createTestModelInvocationHarness } from '../helpers/model-invocation';
import { testProviderDataAdmission } from '../helpers/runtime-model';

const registry = createRuntimeModuleRegistry(createBuiltinRuntimeModules());
const snapshot = registry.snapshot();
const builtinToolCatalog = createBuiltinToolCatalogProjection(snapshot);
const capabilityExecution = createRuntimeHostCapabilityExecutionPortFromSnapshot(snapshot);

function projectIdentityForWorkspace(workspace: string) {
  return {
    projectId: 'project_retained_coordinator',
    canonicalWorkspaceDigest: `sha256:${createHash('sha256')
      .update(canonicalPathForComparison(workspace))
      .digest('hex')}` as const,
  };
}

function runtimeStoreView(
  services: RuntimeHostExecutionServices<RuntimeEvent, unknown>,
): StateSessionStorage {
  return {
    appendEvents: (sessionId, events, metadata) =>
      services.sessions.appendEvents(sessionId, events, metadata),
    appendEventsAndSnapshot: (
      sessionId,
      events,
      snapshotValue,
      metadata,
      snapshotMetadata,
      expectedRestoreBoundary,
      requiredEffectLease,
    ) => {
      const input = {
        sessionId,
        events,
        snapshot: snapshotValue,
        ...(metadata ? { metadata } : {}),
        ...(snapshotMetadata ? { snapshotMetadata } : {}),
        ...(expectedRestoreBoundary ? { expectedRestoreBoundary } : {}),
        ...(requiredEffectLease ? { requiredEffectLease } : {}),
      };
      services.transactions.commit(
        requiredEffectLease ? 'receipt_evidence' : 'decision',
        input,
        requiredEffectLease
          ? {
              sessionId,
              effectId: requiredEffectLease.effectId,
              ownerId: requiredEffectLease.ownerId,
            }
          : undefined,
      );
    },
    loadEventsStrict: (sessionId, since) => services.sessions.loadEventsStrict(sessionId, since),
    saveSnapshot: (sessionId, state) => services.sessions.saveSnapshot(sessionId, state),
    loadSnapshot: <T = unknown>(sessionId: string) => services.sessions.loadSnapshot<T>(sessionId),
    loadSnapshotRecord: <T = unknown>(sessionId: string) =>
      services.sessions.loadSnapshotRecord<T>(sessionId),
    saveNamedSnapshot: () => undefined,
    loadNamedSnapshot: () => null,
    getLastEventPosition: (sessionId) => services.sessions.getLastEventPosition(sessionId),
    listSessions: (query, limit) => services.sessions.listSessions(query, limit),
    setSessionName: (sessionId, name) => services.sessions.setSessionName(sessionId, name),
    getSessionModelRoute: (sessionId) => services.sessions.getSessionModelRoute(sessionId),
    setSessionModelRoute: (sessionId, route) =>
      services.sessions.setSessionModelRoute(sessionId, route),
    deleteSession: (sessionId) => services.sessions.deleteSession(sessionId),
    tryAcquireEffectLease: (sessionId, effectId, ownerId, expiresAtMs) =>
      services.leases.tryAcquire(sessionId, effectId, ownerId, expiresAtMs),
    renewEffectLease: (sessionId, effectId, ownerId, expiresAtMs) =>
      services.leases.renew(sessionId, effectId, ownerId, expiresAtMs),
    releaseEffectLease: (sessionId, effectId, ownerId) =>
      services.leases.release(sessionId, effectId, ownerId),
    listNamedSnapshots: () => [],
    restoreNamedSnapshot: () => false,
    forkSession: () => false,
    forkCurrentSession: () => false,
    getNamedSnapshotEntry: () => null,
    recordFilePreimage: () => undefined,
    recordFilePostimage: () => undefined,
    fileRestorePlan: () => [],
    close: () => undefined,
  };
}

function modelRuntime(workspace: string, state: RuntimeState): InstalledKiteRuntimeComposition {
  const runtime = createTestModelInvocationHarness({ workspace, state });
  const modelEffects = new BuiltinModelEffectCoordinator(runtime.gateway);
  return {
    status: 'available',
    gateway: runtime.gateway,
    modelEffects,
  } as unknown as InstalledKiteRuntimeComposition;
}

function identity(sessionId: string): RuntimeSessionCoordinatorIdentity {
  const workspace = '/tmp/retained-coordinator';
  return {
    sessionId,
    userId: 'tui-user',
    workspace,
    ...projectIdentityForWorkspace(workspace),
    interactionMode: 'accept_edits',
    recoveryIdentityKey: 'a'.repeat(64),
  };
}

function config() {
  return {
    apiKey: 'test',
    baseURL: 'http://localhost:1',
    modelName: 'test-model',
    providerName: 'deepseek',
    providerType: 'openai-compatible' as const,
    sandbox: { enabled: true },
  };
}

function requestedState(sessionId: string) {
  const state = createRuntimeHostStateInitialState({
    threadId: sessionId,
    userId: 'tui-user',
    workspace: '/tmp/retained-coordinator',
    ...projectIdentityForWorkspace('/tmp/retained-coordinator'),
    recoveryIdentityKey: 'a'.repeat(64),
  });
  state.transcript.messages = [
    {
      kind: 'user',
      messageId: 'historical-message',
      turnId: 'historical-turn',
      ordinal: 0,
      createdAt: '2026-08-21T00:00:00.000Z',
      content: 'Historical context '.repeat(200),
    },
    {
      kind: 'user',
      messageId: 'current-message',
      turnId: state.turn.turnId,
      ordinal: 1,
      createdAt: '2026-08-21T00:00:01.000Z',
      content: 'Current request',
    },
  ];
  return reduceRuntimeState(state, {
    type: 'context.compaction_requested',
    compactionId: 'retained-compaction-1',
    reason: 'manual',
    requestedAtRevision: state.revision,
    requestedAtTurnId: state.turn.turnId,
    force: false,
    estimate: {
      systemTokens: 10,
      toolSchemaTokens: 10,
      transcriptTokens: 400,
      summaryTokens: 0,
      dynamicRuntimeTokens: 10,
      framingTokens: 10,
      totalInputTokens: 440,
    },
  });
}

function autoReviewState(
  sessionId: string,
  options: { toolName?: string; subagentId?: string } = {},
) {
  const toolName = options.toolName ?? 'shell_execute';
  let state = createRuntimeHostStateInitialState({
    threadId: sessionId,
    userId: 'tui-user',
    workspace: '/tmp/retained-coordinator',
    ...projectIdentityForWorkspace('/tmp/retained-coordinator'),
    recoveryIdentityKey: 'a'.repeat(64),
  });
  state = reduceRuntimeState(state, {
    type: 'tool.queued',
    toolCallId: 'reviewed-shell',
    name: toolName,
    args: { command: 'printf retained' },
  });
  return reduceRuntimeState(state, {
    type: 'auto_review.requested',
    reviewId: 'retained-review-1',
    toolCallId: 'reviewed-shell',
    toolName,
    reason: 'Requires App review.',
    approval: {
      scope: 'once',
      cwd: '/tmp/retained-coordinator',
      threadId: sessionId,
      tool: toolName,
      command: 'printf retained',
      risk: 'execute_code',
      approvalHash: 'retained-review-hash',
      summary: 'Run a retained fixture command.',
      reason: 'Requires App review.',
      expectedEffects: [],
      grantOptions: ['approve_once'],
      recommendedGrant: 'approve_once',
      ...(options.subagentId ? { subagentId: options.subagentId } : {}),
    },
  });
}

function verificationState(sessionId: string) {
  const state = createRuntimeHostStateInitialState({
    threadId: sessionId,
    userId: 'tui-user',
    workspace: '/tmp/retained-coordinator',
    ...projectIdentityForWorkspace('/tmp/retained-coordinator'),
    recoveryIdentityKey: 'a'.repeat(64),
  });
  state.activeTaskId = 'verification-task';
  state.tasks['verification-task'] = {
    taskId: 'verification-task',
    userGoal: 'Verify the runtime coordinator cutover.',
    status: 'active',
    startedAtTurnId: state.turn.turnId,
    sideEffectsStarted: true,
    planning: { kind: 'building_without_plan' },
    planHistory: [],
  };
  state.transcript.final = 'ready for verification';
  const spec: VerificationSpec = {
    schemaVersion: 1,
    verificationId: 'retained-verification-1',
    taskId: 'verification-task',
    subject: 'retained verification reviewer route',
    checks: [
      {
        checkId: 'reviewer',
        type: 'reviewer',
        description: 'Review the retained verification evidence.',
        instructions: 'Confirm the retained verification route.',
      },
    ],
    repair: { maxAttempts: 1 },
  };
  return reduceRuntimeState(state, {
    type: 'verification.requested',
    verificationId: spec.verificationId,
    taskId: 'verification-task',
    mode: 'required',
    spec,
    requestedAt: '2026-08-21T00:00:00.000Z',
  });
}

function checkpointFor(
  state: ReturnType<typeof requestedState>,
  sourceRevision: number,
  environment?: ContextProjectionEnvironment,
): ContextCompactionCheckpoint {
  const before = buildContextProjection({
    role: 'agent',
    state,
    serializedTools: environment?.serializedTools,
    activeSkillInstructions: environment?.activeSkillInstructions,
    workflowSkills: environment?.workflowSkills,
  }).estimate.totalInputTokens;
  const source = state.transcript.messages[0]!;
  return {
    compactionId: 'retained-compaction-1',
    version: 1,
    sourceRevision,
    sourceDigest: expectedCompactionSourceDigest(undefined, [source]),
    coveredThroughMessageId: source.messageId,
    coveredThroughTurnId: source.turnId,
    summary: 'One runtime coordinator summary.',
    inputTokensBefore: before,
    inputTokensAfter: 0,
    reason: 'manual',
    createdAt: '2026-08-21T00:00:02.000Z',
  };
}

function createFixture(
  sessionId: string,
  state = createRuntimeHostStateInitialState({
    threadId: sessionId,
    userId: 'tui-user',
    workspace: '/tmp/retained-coordinator',
    ...projectIdentityForWorkspace('/tmp/retained-coordinator'),
    recoveryIdentityKey: 'a'.repeat(64),
  }),
) {
  const root = mkdtempSync(join(process.cwd(), '.kite-retained-coordinator-'));
  const databasePath = join(root, 'runtime.db');
  const stateStorage = createRuntimeHostStateStorageBinding();
  const codec = stateStorage.codec as RuntimeSnapshotCodec<RuntimeEvent, unknown>;
  const storage = createStateStorageForTest<RuntimeEvent, unknown>({
    databasePath,
    codec,
    sessionId,
  });
  const services = {
    sessions: storage.sessions,
    transactions: {
      commit: (
        acknowledgement: 'decision' | 'receipt_evidence',
        input: Parameters<typeof storage.transactions.commitDecision>[0],
        requiredEffectLease?: Parameters<
          RuntimeHostExecutionServices<RuntimeEvent, unknown>['transactions']['commit']
        >[2],
      ) => {
        if (acknowledgement === 'receipt_evidence') {
          storage.transactions.commitReceiptEvidence(input);
        } else {
          storage.transactions.commitDecision(input);
        }
        void requiredEffectLease;
      },
    },
    leases: {
      tryAcquire: storage.effects.tryAcquireEffectLease,
      renew: storage.effects.renewEffectLease,
      release: storage.effects.releaseEffectLease,
      hasClaim: () => false,
    },
    checkpoints: {} as RuntimeHostExecutionServices<RuntimeEvent, unknown>['checkpoints'],
    recoveryIdentities: storage.recoveryIdentities,
  } as unknown as RuntimeHostExecutionServices<RuntimeEvent, unknown>;
  const store = runtimeStoreView(services);
  storage.transactions.commitDecision({
    sessionId,
    events: [],
    snapshot: state,
  });
  const runtime = modelRuntime('/tmp/retained-coordinator', state);
  const binding = createRuntimeSessionCoordinatorBinding();
  let factoryCalls = 0;
  const factory = (workspace: string) => {
    factoryCalls += 1;
    void workspace;
    return runtime;
  };
  binding.bind({
    services,
    capabilities: capabilityExecution,
    capabilityRegistrySnapshot: snapshot,
    builtinToolCatalog,
    modelRuntimeFactory: factory,
    store,
  });
  return {
    binding,
    store,
    runtime,
    services,
    factory,
    factoryCalls: () => factoryCalls,
    storage,
    root,
  };
}

function dependencies(
  store: StateSessionStorage,
  runtime: InstalledKiteRuntimeComposition,
  contextCompactor?: RuntimeExecutorDependencies['testContextCompactor'],
): RuntimeExecutorDependencies {
  if (runtime.status !== 'available') throw new Error('test model runtime unavailable');
  return {
    config: config(),
    model: createChatModel(config()),
    builtinToolCatalog,
    capabilityExecution,
    providerDataAdmission: testProviderDataAdmission,
    runtimeStore: store,
    modelInvocationGateway: runtime.gateway,
    modelEffectCoordinator: runtime.modelEffects,
    ...(contextCompactor ? { testContextCompactor: contextCompactor } : {}),
  };
}

describe('retained TUI session coordinator', () => {
  test('Host recovery ensures one Kernel/composition identity and fails closed on drift or double bind', async () => {
    const sessionId = 'retained-identity';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    try {
      const hostRecover = () => access.ensure(identity(sessionId));
      const first = hostRecover();
      const second = hostRecover();
      expect(second).toBe(first);
      expect(second.session).toBe(first.session);
      expect(first.getStateSessionStorage()).toBe(fixture.store);
      expect(fixture.factoryCalls()).toBe(1);
      expect(() => access.ensure({ ...identity(sessionId), userId: 'different-user' })).toThrow(
        'identity drifted',
      );
      expect(() =>
        first.createRuntimeEffectPort(dependencies(fixture.store, fixture.runtime, undefined)),
      ).toBeFunction();
      expect(() =>
        first.createRuntimeEffectPort({
          ...dependencies(fixture.store, fixture.runtime),
          capabilityExecution: Object.freeze({ invoke: async () => ({}) }),
        } as unknown as RuntimeExecutorDependencies),
      ).toThrow('capability execution port identity mismatch');
      expect(() =>
        fixture.binding.bind({
          services: fixture.services,
          capabilities: capabilityExecution,
          capabilityRegistrySnapshot: snapshot,
          builtinToolCatalog,
          modelRuntimeFactory: fixture.factory,
          store: fixture.store,
        }),
      ).toThrow('already bound');
    } finally {
      await access.close();
      expect(fixture.store.getLastEventPosition(sessionId)).toBe(0);
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('releases one runtime coordinator and preserves Host storage ownership', async () => {
    const sessionId = 'retained-release';
    const fixture = createFixture(sessionId);
    const access = fixture.binding.access();
    const coordinator = access.ensure(identity(sessionId));
    coordinator.beginTurn();
    const closing = coordinator.close();
    expect(coordinator.lifecycle).toBe('closing');
    expect(() => coordinator.beginTurn()).toThrow('closing');
    coordinator.endTurn();
    await closing;
    expect(coordinator.lifecycle).toBe('closed');
    expect(() => coordinator.getState()).toThrow('closed');
    expect(fixture.store.getLastEventPosition(sessionId)).toBe(0);
    await access.release(sessionId);
    expect(access.get(sessionId)).toBeUndefined();
    fixture.storage.close();
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test('cleans up after identity failure and accepts exactly one compaction terminal', async () => {
    const sessionId = 'retained-compaction';
    const state = requestedState(sessionId);
    const fixture = createFixture(sessionId, state);
    const access = fixture.binding.access();
    const coordinator = access.ensure(identity(sessionId));
    const compactor = async ({
      state: current,
      sourceRevision,
      projectionEnvironment,
    }: Parameters<NonNullable<RuntimeExecutorDependencies['testContextCompactor']>>[0]) =>
      checkpointFor(current, sourceRevision, projectionEnvironment);
    try {
      expect(coordinator.getState().context.pendingCompaction?.compactionId).toBe(
        'retained-compaction-1',
      );
      const goodDependencies = dependencies(fixture.store, fixture.runtime, compactor);
      (fixture.runtime as unknown as { status: 'available' | 'unavailable' }).status =
        'unavailable';
      await expect(
        coordinator.executePendingCompaction({
          dependencies: goodDependencies,
        }),
      ).rejects.toThrow('Model composition is unavailable');
      expect(coordinator.lifecycle).toBe('idle');
      (fixture.runtime as unknown as { status: 'available' | 'unavailable' }).status = 'available';
      await expect(
        coordinator.executePendingCompaction({
          dependencies: {
            ...goodDependencies,
            capabilityExecution: Object.freeze({ invoke: async () => ({}) }),
          } as unknown as RuntimeExecutorDependencies,
        }),
      ).rejects.toThrow('capability execution port identity mismatch');
      expect(coordinator.lifecycle).toBe('idle');
      const terminals = await coordinator.executePendingCompaction({
        dependencies: goodDependencies,
      });
      expect(
        terminals.filter(
          (event) =>
            event.type === 'context.compaction_completed' ||
            event.type === 'context.compaction_failed',
        ),
      ).toHaveLength(1);
      expect(coordinator.getState().context.pendingCompaction).toBeUndefined();
      expect(
        await coordinator.executePendingCompaction({
          dependencies: goodDependencies,
        }),
      ).toEqual([]);
      expect(
        fixture.store
          .loadEventsStrict(sessionId)
          .filter(
            (event) =>
              event.event.type === 'context.compaction_completed' ||
              event.event.type === 'context.compaction_failed',
          ),
      ).toHaveLength(1);
    } finally {
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('retained compaction fails before Builtin coordinator or Provider without persistence context', async () => {
    const sessionId = 'retained-compaction-no-context';
    const fixture = createFixture(sessionId, requestedState(sessionId));
    const access = fixture.binding.access();
    const coordinator = access.ensure(identity(sessionId));
    if (fixture.runtime.status !== 'available') {
      throw new Error('test model runtime unavailable');
    }
    const runtime = fixture.runtime;
    const modelEffects = runtime.modelEffects as unknown as {
      createContextCompactor: (...args: never[]) => unknown;
    };
    const gateway = runtime.gateway as unknown as {
      invoke: (...args: never[]) => Promise<unknown>;
    };
    const originalCreateContextCompactor = modelEffects.createContextCompactor;
    const originalInvoke = gateway.invoke;
    let coordinatorCalls = 0;
    let providerCalls = 0;
    modelEffects.createContextCompactor = () => {
      coordinatorCalls += 1;
      throw new Error('Builtin compactor must not be created without persistence.');
    };
    gateway.invoke = function (...args: never[]) {
      providerCalls += 1;
      return originalInvoke.apply(this, args);
    };
    try {
      const executor = coordinator.createRuntimeEffectPort(dependencies(fixture.store, runtime));
      await expect(
        executor(
          { type: 'compact_context', compactionId: 'retained-compaction-1' },
          coordinator.getState(),
        ),
      ).rejects.toThrow('Model effect persistence context is unavailable.');
      expect(coordinatorCalls).toBe(0);
      expect(providerCalls).toBe(0);
    } finally {
      modelEffects.createContextCompactor = originalCreateContextCompactor;
      gateway.invoke = originalInvoke;
      await access.close();
      fixture.storage.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('routes primary and compaction model effects through the App coordinator once', async () => {
    const primarySessionId = 'retained-primary-route';
    const primaryFixture = createFixture(primarySessionId);
    const primaryAccess = primaryFixture.binding.access();
    const primaryCoordinator = primaryAccess.ensure(identity(primarySessionId));
    if (primaryFixture.runtime.status !== 'available') {
      throw new Error('test model runtime unavailable');
    }
    const modelEffects = primaryFixture.runtime.modelEffects as unknown as {
      executePrimaryModelEffect: (...args: never[]) => Promise<unknown>;
    };
    const originalPrimaryEffect = modelEffects.executePrimaryModelEffect;
    let primaryCalls = 0;
    modelEffects.executePrimaryModelEffect = async () => {
      primaryCalls += 1;
      return { kind: 'completed', value: [] };
    };
    try {
      const primaryDependencies = dependencies(primaryFixture.store, primaryFixture.runtime);
      await expect(
        createAppRuntimeEffectExecutor({
          ...primaryDependencies,
          modelEffectCoordinator: undefined,
        })({ type: 'call_model' }, primaryCoordinator.getState(), undefined, {
          reservationIds: [],
          persistEvent: async () => true,
          persistEvents: async () => true,
        }),
      ).rejects.toThrow('Model effect coordinator is unavailable');
      expect(primaryCalls).toBe(0);
      const retainedExecutor = primaryCoordinator.createRuntimeEffectPort(primaryDependencies);
      const executionContext = {
        reservationIds: [],
        persistEvent: async () => true,
        persistEvents: async () => true,
      };
      await expect(
        retainedExecutor(
          { type: 'call_model' },
          primaryCoordinator.getState(),
          undefined,
          executionContext,
        ),
      ).resolves.toEqual([]);
      expect(primaryCalls).toBe(1);

      modelEffects.executePrimaryModelEffect = originalPrimaryEffect;
      await expect(
        retainedExecutor({ type: 'call_model' }, primaryCoordinator.getState()),
      ).rejects.toThrow('execution context is unavailable');
      expect(primaryCalls).toBe(1);
      modelEffects.executePrimaryModelEffect = async () => {
        primaryCalls += 1;
        return { kind: 'completed', value: [] };
      };

      expect(primaryCalls).toBe(1);
    } finally {
      modelEffects.executePrimaryModelEffect = originalPrimaryEffect;
      await primaryAccess.close();
      primaryFixture.storage.close();
      rmSync(primaryFixture.root, { recursive: true, force: true });
    }

    const remainingSessionId = 'retained-remaining-route';
    const remainingFixture = createFixture(remainingSessionId, requestedState(remainingSessionId));
    const remainingAccess = remainingFixture.binding.access();
    const remainingCoordinator = remainingAccess.ensure(identity(remainingSessionId));
    if (remainingFixture.runtime.status !== 'available') {
      throw new Error('test model runtime unavailable');
    }
    const remainingModelEffects = remainingFixture.runtime.modelEffects as unknown as {
      executePrimaryModelEffect: (...args: never[]) => Promise<unknown>;
    };
    const originalRemainingPrimary = remainingModelEffects.executePrimaryModelEffect;
    let remainingPrimaryCalls = 0;
    remainingModelEffects.executePrimaryModelEffect = async () => {
      remainingPrimaryCalls += 1;
      return { kind: 'completed', value: [] };
    };
    try {
      const compactor = async ({
        state: current,
        sourceRevision,
        projectionEnvironment,
      }: Parameters<NonNullable<RuntimeExecutorDependencies['testContextCompactor']>>[0]) =>
        checkpointFor(current, sourceRevision, projectionEnvironment);
      const events = await remainingCoordinator.executePendingCompaction({
        dependencies: dependencies(remainingFixture.store, remainingFixture.runtime, compactor),
      });
      expect(
        events.some(
          (event) =>
            event.type === 'context.compaction_completed' ||
            event.type === 'context.compaction_failed',
        ),
      ).toBe(true);
      expect(remainingPrimaryCalls).toBe(0);
    } finally {
      remainingModelEffects.executePrimaryModelEffect = originalRemainingPrimary;
      await remainingAccess.close();
      remainingFixture.storage.close();
      rmSync(remainingFixture.root, { recursive: true, force: true });
    }
  });

  test('owns auto-review in the App coordinator', async () => {
    const state = autoReviewState('retained-auto-review-owner');
    let gatewayCalls = 0;
    const model = createChatModel(config());
    const harness = createTestModelInvocationHarness({
      workspace: state.session.workspace,
      state,
      transport: async () => ({
        message: {
          role: 'assistant' as const,
          content: [
            {
              type: 'text' as const,
              text: '{"approved":true,"grant":"approve_once","reason":"retained reviewer accepted"}',
            },
          ],
        },
        finishReason: 'stop' as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
        providerMetadata: { responseId: 'retained-review-response' },
      }),
      operationExecution: {
        execute: async (attempt) => {
          gatewayCalls += 1;
          expect(attempt.operationId).toBe(BUILTIN_MODEL_OPERATION_BY_PURPOSE_.auto_review);
          expect(attempt.purpose).toBe('auto_review');
          return attempt.attempt();
        },
      },
    });
    const modelEffectCoordinator = new BuiltinModelEffectCoordinator(harness.gateway);
    const dependencies: RuntimeExecutorDependencies = {
      config: config(),
      model,
      modelInvocationGateway: harness.gateway,
      modelEffectCoordinator,
      builtinToolCatalog,
      capabilityExecution,
      providerDataAdmission: testProviderDataAdmission,
    };
    const retainedExecutor = createAppRuntimeEffectExecutor(dependencies);
    const events = await retainedExecutor(
      { type: 'run_auto_review', reviewId: 'retained-review-1', toolCallId: 'reviewed-shell' },
      state,
      undefined,
      {
        reservationIds: [],
        getState: harness.persistence.getState,
        persistEvent: async (event) => harness.persistence.persistEvents([event]),
        persistEvents: harness.persistence.persistEvents,
      },
    );

    expect(gatewayCalls).toBe(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'auto_review.completed',
        result: expect.objectContaining({ approved: true, grant: 'approve_once' }),
      }),
    ]);

    expect(gatewayCalls).toBe(1);
  });

  test('owns verification reviewer dispatch once', async () => {
    const state = verificationState('retained-verification-owner');
    let gatewayCalls = 0;
    let responseSourceCalls = 0;
    const harness = createTestModelInvocationHarness({
      workspace: state.session.workspace,
      state,
      transport: async () => {
        responseSourceCalls += 1;
        return {
          message: {
            role: 'assistant' as const,
            content: [
              {
                type: 'text' as const,
                text: '{"outcome":"passed","summary":"retained verification passed"}',
              },
            ],
          },
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: null },
          providerMetadata: { responseId: 'retained-verification-response' },
        };
      },
      operationExecution: {
        execute: async (attempt) => {
          gatewayCalls += 1;
          expect(attempt.operationId).toBe(BUILTIN_MODEL_OPERATION_BY_PURPOSE_.verification_review);
          expect(attempt.purpose).toBe('verification_review');
          return attempt.attempt();
        },
      },
    });
    const modelEffectCoordinator = new BuiltinModelEffectCoordinator(harness.gateway);
    const dependencies: RuntimeExecutorDependencies = {
      config: config(),
      model: createChatModel(config()),
      modelInvocationGateway: harness.gateway,
      modelEffectCoordinator,
      builtinToolCatalog,
      capabilityExecution,
      providerDataAdmission: testProviderDataAdmission,
    };
    const retainedExecutor = createAppRuntimeEffectExecutor(dependencies);
    const effect = {
      type: 'run_verification' as const,
      verificationId: 'retained-verification-1',
    };
    const events = await retainedExecutor(effect, state, undefined, {
      reservationIds: [],
      getState: harness.persistence.getState,
      persistEvent: async (event) => harness.persistence.persistEvents([event]),
      persistEvents: harness.persistence.persistEvents,
    });

    expect(gatewayCalls).toBe(1);
    expect(responseSourceCalls).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'verification.check_completed',
        result: expect.objectContaining({ outcome: 'passed' }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'verification.completed', outcome: 'passed' }),
    );

    expect(gatewayCalls).toBe(1);
    expect(responseSourceCalls).toBe(1);
  });

  test.each([
    ['missing child continuation', { subagentId: 'missing-child' }],
    ['invalid builtin tool', { toolName: 'unknown_builtin' }],
  ] as const)('rejects %s before reviewer or Host dispatch', async (_label, options) => {
    const state = autoReviewState(`retained-auto-review-${_label}`, options);
    let reviewerCalls = 0;
    let gatewayCalls = 0;
    const dependencies: RuntimeExecutorDependencies = {
      config: config(),
      model: createChatModel(config()),
      modelInvocationGateway: {
        invoke: async () => {
          gatewayCalls += 1;
          throw new Error('invalid review input must not reach the Gateway');
        },
      } as unknown as NonNullable<RuntimeExecutorDependencies['modelInvocationGateway']>,
      modelEffectCoordinator: {
        reviewToolApproval: async () => {
          reviewerCalls += 1;
          throw new Error('invalid review input must not reach the reviewer');
        },
      } as unknown as NonNullable<RuntimeExecutorDependencies['modelEffectCoordinator']>,
      builtinToolCatalog,
      capabilityExecution,
    };

    const events = await createAppRuntimeEffectExecutor(dependencies)(
      { type: 'run_auto_review', reviewId: 'retained-review-1', toolCallId: 'reviewed-shell' },
      state,
    );

    expect(reviewerCalls).toBe(0);
    expect(gatewayCalls).toBe(0);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'auto_review.completed',
        result: expect.objectContaining({ approved: false }),
      }),
    ]);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
  });
});
