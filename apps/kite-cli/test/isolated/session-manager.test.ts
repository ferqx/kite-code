import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite-ai/agent-kernel';
import { aiMessage } from '@kite-ai/builtin-runtime/model';
import {
  type BuiltinPreparedShellExecutionInput,
  SandboxPreparationArtifactStore,
} from '@kite-ai/builtin-runtime/sandbox';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import {
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeCommand,
  type RuntimeCommandReceipt,
} from '@kite-ai/runtime-contract';
import type { RuntimeHostCoordinatorPort, RuntimeHostExecutionBridge } from '@kite-ai/runtime-host';
import {
  createRuntimeHostStateInitialState,
  getActivePlanning,
  type RuntimeState,
} from '@kite-ai/runtime-host/kernel-adapter';
import type { AgentConfig } from '#kite-cli/config';
import { reduceRuntimeState } from '#runtime-support/runtime-state-reducer';
import {
  assertSqliteRuntimeStorageCanOpen,
  createSqliteSessionTokenStats,
} from '../../../../packages/runtime-storage-sqlite/src';
import { restoreStateHostSessionHarness as restoreStateKernelCoordinator } from '../../../../scripts/support/runtime-host-state';
import {
  openStateStoreForTest,
  stateStorePathForTest,
} from '../../../../scripts/support/runtime-storage';
import { currentPlanDraftedEvent } from '../../../../tests/helpers/current-plan';
import { createMockModel } from '../../../../tests/helpers/mock-model';
import {
  runTestRuntimeAgent,
  testBuiltinToolCatalog,
  testModelInvocationRuntime,
  testRuntimeCapabilityExecutionPort,
} from '../../../../tests/helpers/runtime-model';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import type {
  RuntimeSessionCoordinator,
  RuntimeSessionCoordinatorAccess,
} from '../../src/bootstrap/runtime/RuntimeSessionCoordinator';
import { loadSession } from '../../src/bootstrap/runtime/session-persistence';
import { createTuiRuntimeClient } from '../../src/bootstrap/runtime/TuiRuntimeBridge';
import {
  isSilentCancellationMismatch,
  reconcileRuntimeInteractionMode,
  type SessionDeps,
  SessionManager,
  SessionRuntime,
} from '../../src/runtime/session';
import type { SessionUserAction } from '../../src/runtime/session/contracts';
import type { AppShellExecutor, AppShellRuntimeDecision } from '../../src/sandbox/composition';
import {
  APP_PREPARED_SHELL_EXECUTION_,
  projectAppHostShellResult,
} from '../../src/sandbox/prepared-tool-pipeline';
import {
  admitInteractionModeTarget,
  appSandboxBackendAvailable,
  fullModeUnavailableReason,
  resolveInteractionModeTarget,
} from '../../src/tui/interaction-mode';
import { TuiUserInputProvider } from '../../src/tui/provider';
import type { Action } from '../../src/tui/reducers/actions';
import type { StatusState } from '../../src/tui/types';

// ── Test-only structural access to private members (casts are erased at runtime) ──

type RuntimeWithPendingResolve = {
  _pendingResolve: {
    interactionId: string;
    generation?: number;
    resolve: (action: SessionUserAction) => void;
  } | null;
};
type RuntimeWithForegroundWake = { _foregroundWake: () => void };
type RuntimeWithForeground = { _foreground: boolean };
type RuntimeWithProxyProvider = {
  _proxyProvider: {
    requestAction: (payload: unknown) => Promise<unknown>;
    submitAction: (action: unknown) => void;
    reset: () => void;
  };
};
type RuntimeWithRuntimeAction = {
  _requestRuntimeAction: (effect: unknown, state: unknown) => Promise<unknown>;
};
type RuntimeWithRouteRuntimeEvent = {
  _routeRuntimeEvent: (event: unknown, dispatch: (action: unknown) => void) => void;
};
type RuntimeWithStateEventSink = {
  _runtimeStateEventSink: ((event: unknown) => void) | null;
};
type RuntimeWithPushToBuffer = { _pushToBuffer: (event: unknown) => void };
type ManagerWithTokenStatsCache = {
  tokenStatsService: {
    get(
      threadId: string,
    ): { cacheHitTokens: number; cacheMissTokens: number; totalTokens: number } | undefined;
    has(threadId: string): boolean;
  };
};

// ── Helpers ──

function emptyRuntimeHistory(): RuntimeHistoryClient {
  return {
    listSessions: async () => ({ entries: [], hasMore: false }),
    listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
    loadSession: async (sessionId) => {
      throw new Error(`No history fixture for ${sessionId}`);
    },
  };
}

function makeDeps(checkpointPath = ':memory:'): SessionDeps {
  const config: AgentConfig = {
    apiKey: 'unused',
    baseURL: 'https://example.invalid',
    modelName: 'test-model',
    providerName: 'deepseek',
    providerType: 'openai-compatible',
    features: {
      resourceBudget: true,
      boundedCancellation: true,
    },
    sandbox: { enabled: true },
  };
  const recoveryIdentities = new Map<string, string>();
  let recoveryIdentityOrdinal = 0;
  const allocateRecoveryIdentity = (): string =>
    createHash('sha256')
      .update(`session-manager-recovery:${recoveryIdentityOrdinal++}`)
      .digest('hex');
  const resolveRecoveryIdentity = (threadId: string): string => {
    const existing = recoveryIdentities.get(threadId);
    if (existing) return existing;
    if (checkpointPath !== ':memory:') {
      const store = openStateStoreForTest(stateStorePathForTest(checkpointPath));
      try {
        const snapshot = store.loadSnapshot<RuntimeState>(threadId);
        const snapshotIdentity = snapshot?.toolRecovery?.identityKey;
        if (typeof snapshotIdentity === 'string' && /^[a-f0-9]{64}$/u.test(snapshotIdentity)) {
          recoveryIdentities.set(threadId, snapshotIdentity);
          return snapshotIdentity;
        }
      } finally {
        store.close();
      }
    }
    const allocated = allocateRecoveryIdentity();
    recoveryIdentities.set(threadId, allocated);
    return allocated;
  };
  return {
    config,
    provider: {} as unknown as TuiUserInputProvider,
    skillManifests: [],
    skillOptions: null,
    mcpManager: null,
    checkpointPath,
    openStateRuntimeStorage: () => openStateStoreForTest(stateStorePathForTest(checkpointPath)),
    resolveRecoveryIdentity,
    allocateRecoveryIdentity,
    builtinToolCatalog: testBuiltinToolCatalog(),
    capabilityExecution: testRuntimeCapabilityExecutionPort(),
    tokenStatsStorage: createSqliteSessionTokenStats({
      databasePath: stateStorePathForTest(checkpointPath),
      journalMode: 'delete',
      assertCanOpen: assertSqliteRuntimeStorageCanOpen,
    }),
    modelInvocationRuntimeFactory: testModelInvocationRuntime,
  };
}

function makeManager() {
  return new SessionManager(makeDeps());
}

function makeRuntime(threadId = 't1', workspace = '/tmp/ws') {
  return new SessionRuntime(threadId, workspace, makeDeps());
}

function installTestOnlyRuntimeTurnAdapter(
  deps: SessionDeps,
  threadId: string,
): RuntimeSessionCoordinatorAccess {
  let interactionMode: RuntimeState['mode'] = deps.config.interactionMode ?? 'accept_edits';
  const modeState = (): Readonly<RuntimeState> =>
    ({
      mode: interactionMode,
      context: { pendingCompaction: undefined },
    }) as Readonly<RuntimeState>;
  const processModeEvent = (event: RuntimeEvent): void => {
    if (event.type === 'interaction_mode.changed') interactionMode = event.mode;
  };
  const unavailableState = (): never => {
    throw new Error('test-only State control is unavailable while no turn is active');
  };
  const coordinator = {
    sessionId: threadId,
    control: {
      getState: modeState,
      processEvent: processModeEvent,
      processEventBatch: (events) => {
        for (const event of events) processModeEvent(event);
        return events;
      },
      cancelRun: () => [],
    },
    session: {} as RuntimeSessionCoordinator['session'],
    recoveryChanged: false,
    lifecycle: 'idle' as const,
    getState: modeState,
    getStateRuntimeStorage: unavailableState,
    isTurnActive: () => false,
    beginTurn: () => undefined,
    endTurn: () => undefined,
    updateInteractionMode: () => undefined,
    getInteractionModeState: () => ({
      interactionMode,
      interactionModeRevision: 0,
    }),
    updateSandboxAvailable: () => undefined,
    getSandboxAvailable: () => undefined,
    setActiveCancelRun: () => undefined,
    clearActiveCancelRun: () => undefined,
    commitInteractionModeCommand: unavailableState,
    commitCancelTurnCommand: unavailableState,
    commitCloseSessionCommand: unavailableState,
    commitClearSessionCommandGrantsCommand: unavailableState,
    commitForkSessionCommand: unavailableState,
    commitStartTurnCommand: unavailableState,
    executeTurn: (input, provider) =>
      runTestRuntimeAgent(
        {
          ...input,
          openStateRuntimeStorage: deps.openStateRuntimeStorage,
        },
        provider,
      ),
    createRuntimeEffectPort: unavailableState,
    executePendingCompaction: unavailableState,
    waitForIdle: async () => undefined,
    close: async () => undefined,
  } satisfies RuntimeSessionCoordinator;
  return {
    ensure: () => coordinator,
    get: (sessionId) => (sessionId === threadId ? coordinator : undefined),
    release: async () => undefined,
    close: async () => undefined,
  };
}

function createDeferredShellExecutor() {
  let resolvePreparation!: (decision: AppShellRuntimeDecision) => void;
  const preparation = new Promise<AppShellRuntimeDecision>((resolve) => {
    resolvePreparation = resolve;
  });
  let prepareCalls = 0;
  let executionCalls = 0;

  const executor = (async (input: Parameters<AppShellExecutor>[0]) => {
    executionCalls += 1;
    return {
      ok: false,
      command: input.command,
      exitCode: -1,
      stdout: '',
      stderr: 'unexpected shell execution',
    };
  }) as AppShellExecutor;
  executor.prepare = () => {
    prepareCalls += 1;
    return preparation;
  };

  return {
    executor,
    resolvePreparation,
    prepareCalls: () => prepareCalls,
    executionCalls: () => executionCalls,
  };
}

function makeStatus(overrides: Partial<StatusState> = {}): StatusState {
  return {
    phase: 'building',
    plan: null,
    pendingPlan: null,
    workspaceAccess: 'write',
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRate: 0,
    totalTokens: 0,
    currentNode: null,
    modelProvider: '',
    modelName: '',
    thinkingMode: '',
    retryState: null,
    ...overrides,
  };
}

// ── SessionManager ──

describe('fullModeUnavailableReason', () => {
  test('keeps Full selectable even when no sandbox backend is available', () => {
    expect(fullModeUnavailableReason('full', 'none')).toBeNull();
  });

  test('allows development Full mode with the direct Windows restricted-token backend', () => {
    expect(appSandboxBackendAvailable('windows_restricted_token')).toBe(true);
    expect(fullModeUnavailableReason('full', 'windows_restricted_token')).toBeNull();
  });

  test('allows non-full modes without a sandbox', () => {
    expect(fullModeUnavailableReason('accept_edits', 'none')).toBeNull();
    expect(fullModeUnavailableReason('auto', 'none')).toBeNull();
  });

  test('allows full mode with a sandbox backend', () => {
    expect(fullModeUnavailableReason('full', 'seatbelt')).toBeNull();
    expect(fullModeUnavailableReason('full', 'bubblewrap')).toBeNull();
  });
});

describe('interaction mode admission', () => {
  test('requires an explicit mode; the TUI opens a selector for /permissions', () => {
    expect(resolveInteractionModeTarget(undefined)).toBeNull();
    expect(resolveInteractionModeTarget('f')).toBe('full');
    expect(resolveInteractionModeTarget('au')).toBe('auto');
  });

  test('does not downgrade Full admission when sandbox is unavailable', () => {
    const decision = admitInteractionModeTarget('full', 'none');
    expect(decision).toEqual({ allowed: true, mode: 'full', reason: null });
  });

  test('allows full admission for the direct Windows restricted-token backend', () => {
    expect(admitInteractionModeTarget('full', 'windows_restricted_token')).toEqual({
      allowed: true,
      mode: 'full',
      reason: null,
    });
  });

  test('allows full admission with sandbox backend', () => {
    expect(admitInteractionModeTarget('full', 'seatbelt')).toEqual({
      allowed: true,
      mode: 'full',
      reason: null,
    });
  });
});

describe('durable TUI approval action bridge', () => {
  test('sends exact approval actions once and emits identity-bound input/plan actions', async () => {
    const provider = new TuiUserInputProvider();
    const delivered: SessionUserAction[] = [];
    provider.setActionSink?.((action) => delivered.push(action));
    const approval = {
      scope: 'once' as const,
      cwd: '/tmp/ws',
      threadId: 'tui-bridge',
      tool: 'shell_execute',
      command: 'printf bridge',
      risk: 'execute_code' as const,
      approvalHash: 'bridge-hash',
      summary: 'Run bridge fixture',
      reason: 'test',
      expectedEffects: [],
      grantOptions: ['approve_once'] as const,
      recommendedGrant: 'approve_once' as const,
    };
    const approvalPromise = provider.requestAction({
      kind: 'approval',
      interactionId: 'approval-bridge',
      generation: 4,
      approval,
    });

    provider.submitAction({
      type: 'approve',
      interactionId: 'approval-bridge',
      generation: 3,
      grant: 'approve_once',
    });
    expect(provider.getPendingInterrupt()?.interactionId).toBe('approval-bridge');
    expect(delivered).toHaveLength(0);

    provider.submitAction({
      type: 'approve',
      interactionId: 'approval-bridge',
      generation: 4,
      grant: 'approve_once',
    });
    provider.submitAction({
      type: 'approve',
      interactionId: 'approval-bridge',
      generation: 4,
      grant: 'approve_once',
    });
    await expect(approvalPromise).resolves.toEqual({
      type: 'approve',
      interactionId: 'approval-bridge',
      generation: 4,
      grant: 'approve_once',
    });
    expect(provider.getPendingInterrupt()).toBeNull();
    expect(delivered).toEqual([
      {
        type: 'approve',
        interactionId: 'approval-bridge',
        generation: 4,
        grant: 'approve_once',
      },
    ]);

    const inputPromise = provider.requestAction({
      kind: 'input',
      interactionId: 'input-bridge',
      question: { question: 'Continue?', options: [], allow_free_text: true },
    });
    provider.submitAction({ type: 'input', text: 'yes' });
    await expect(inputPromise).resolves.toEqual({
      type: 'input',
      interactionId: 'input-bridge',
      text: 'yes',
    });

    const planPromise = provider.requestAction({
      kind: 'plan_review',
      interactionId: 'plan-bridge',
      plan: {
        name: 'Bridge plan',
        description: 'test',
        status: 'pending',
        steps: [],
      },
    });
    provider.submitAction({
      type: 'plan_review_decision',
      decision: { kind: 'cancel', reason: 'test' },
    });
    await expect(planPromise).resolves.toEqual({
      type: 'plan_review_decision',
      interactionId: 'plan-bridge',
      decision: { kind: 'cancel', reason: 'test' },
    });
    expect(delivered).toHaveLength(3);
  });
});

describe('SessionManager', () => {
  test('clears only the exact Session grants through one replayable event without changing mode', () => {
    const grant = (threadId: string) => ({
      grant: 'same_command' as const,
      grantKey: `grant:${threadId}`,
      sessionId: threadId,
      threadId,
      workspace: `/tmp/${threadId}`,
      canonicalWorkspaceIdentity: `workspace:${threadId}`,
      cwd: `/tmp/${threadId}`,
      executor: 'shell_execute',
      environment: 'env:test',
      scope: 'scope:workspace-write',
      effects: 'effects:filesystem-write',
      parserRevision: 'parser:v1',
      commandDigest: `command:${threadId}`,
      createdAt: '2026-08-25T00:00:00.000Z',
      generation: 0,
    });
    const initialState = (threadId: string, mode: RuntimeState['mode']) => {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: createHash('sha256').update(`clear:${threadId}`).digest('hex'),
        threadId,
        userId: 'tui',
        workspace: `/tmp/${threadId}`,
        projectId: `project_${threadId}`,
        canonicalWorkspaceDigest: `sha256:${createHash('sha256').update(threadId).digest('hex')}`,
      });
      state.mode = mode;
      (state.sessionCommandGrants as Map<string, ReturnType<typeof grant>>).set(
        `grant:${threadId}`,
        grant(threadId),
      );
      return state;
    };
    const coordinators = new Map<string, RuntimeSessionCoordinator>();
    const persisted = new Map<string, RuntimeEvent[]>();
    const install = (threadId: string, mode: RuntimeState['mode']) => {
      let state = initialState(threadId, mode);
      const applied: RuntimeEvent[] = [];
      const coordinator = {
        sessionId: threadId,
        getState: () => state,
        control: {
          getState: () => state,
          processEvent: (event: RuntimeEvent) => {
            const before = state;
            state = reduceRuntimeState(state, event);
            if (state !== before) applied.push(event);
          },
          processEventBatch: (events: readonly RuntimeEvent[]) => {
            const accepted: RuntimeEvent[] = [];
            for (const event of events) {
              const before = state;
              state = reduceRuntimeState(state, event);
              if (state !== before) {
                accepted.push(event);
                applied.push(event);
              }
            }
            return accepted;
          },
          cancelRun: () => [],
        },
      } as unknown as RuntimeSessionCoordinator;
      coordinators.set(threadId, coordinator);
      persisted.set(threadId, applied);
      return { coordinator, getState: () => state };
    };

    const sessionA = install('session-a', 'auto');
    const sessionB = install('session-b', 'full');
    const deps = makeDeps();
    deps.runtimeSessionCoordinator = {
      ensure: () => {
        throw new Error('unused');
      },
      get: (sessionId) => coordinators.get(sessionId),
      release: async () => undefined,
      close: async () => undefined,
    };
    const manager = new SessionManager(deps);

    expect(manager.listSessionCommandGrants('session-a')).toHaveLength(1);
    expect(manager.listSessionCommandGrants('session-b')).toHaveLength(1);
    const cleared = manager.clearSessionCommandGrants('session-a');
    expect(cleared).toHaveLength(1);
    expect(cleared?.[0]).toMatchObject({
      type: 'approval.session_grants_cleared',
      sessionId: 'session-a',
      sessionRevision: 0,
      generation: 1,
    });
    expect(manager.listSessionCommandGrants('session-a')).toHaveLength(0);
    expect(manager.listSessionCommandGrants('session-b')).toHaveLength(1);
    expect(sessionA.getState().mode).toBe('auto');
    expect(sessionB.getState().mode).toBe('full');

    let replayed = initialState('session-a', 'auto');
    for (const event of persisted.get('session-a') ?? []) {
      replayed = reduceRuntimeState(replayed, event);
    }
    expect(replayed.sessionCommandGrants.size).toBe(0);
    expect(replayed.mode).toBe('auto');
    expect(replayed.approvalGeneration).toBe(1);
  });

  test('reconciles a mutable TUI interaction mode before Host recovery re-ensures identity', async () => {
    const deps = makeDeps();
    deps.config = { ...deps.config, interactionMode: 'accept_edits' };
    let retainedMode: SessionRuntime['interactionMode'] = 'accept_edits';
    const readRetainedMode = (): SessionRuntime['interactionMode'] => retainedMode;
    let registered = false;
    const coordinatorState = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'mode-recovery',
      userId: 'tui-user',
      workspace: '/tmp/ws',
    });
    const unavailable = (): never => {
      throw new Error('unused test coordinator operation');
    };
    const coordinator = {
      sessionId: '',
      control: {
        getState: () => coordinatorState,
        processEvent: unavailable,
        processEventBatch: (events: RuntimeEvent[]) => events,
        cancelRun: () => [],
      },
      session: {} as RuntimeSessionCoordinator['session'],
      recoveryChanged: false,
      lifecycle: 'idle' as const,
      getState: () => coordinatorState,
      getStateRuntimeStorage: unavailable,
      isTurnActive: () => false,
      beginTurn: () => undefined,
      endTurn: () => undefined,
      updateInteractionMode: (mode: SessionRuntime['interactionMode']) => {
        retainedMode = mode;
      },
      getInteractionModeState: () => ({
        interactionMode: retainedMode,
        interactionModeRevision: 0,
      }),
      updateSandboxAvailable: () => undefined,
      getSandboxAvailable: () => undefined,
      setActiveCancelRun: () => undefined,
      clearActiveCancelRun: () => undefined,
      commitInteractionModeCommand: unavailable,
      commitCancelTurnCommand: unavailable,
      commitCloseSessionCommand: unavailable,
      commitClearSessionCommandGrantsCommand: unavailable,
      commitForkSessionCommand: unavailable,
      commitStartTurnCommand: unavailable,
      executeTurn: unavailable,
      createRuntimeEffectPort: unavailable,
      executePendingCompaction: unavailable,
      waitForIdle: async () => undefined,
      close: async () => undefined,
    } satisfies RuntimeSessionCoordinator;
    deps.runtimeSessionCoordinator = {
      ensure: (identity) => {
        registered = true;
        retainedMode = identity.interactionMode;
        return coordinator;
      },
      get: () => (registered ? coordinator : undefined),
      release: async () => undefined,
      close: async () => undefined,
    };
    const workspace = '/tmp/ws';
    const manager = new SessionManager(deps);
    const threadId = manager.createSession(workspace, {
      projectId: 'project_test',
      canonicalWorkspaceDigest: `sha256:${createHash('sha256').update(workspace).digest('hex')}`,
    });

    manager.getRuntime(threadId)!.interactionMode = 'auto';

    expect(await manager.recoverRuntimeState(threadId)).toBe(false);
    expect(readRetainedMode()).toBe('auto');
  });

  test('does not restore an approval resolved after the rolling snapshot', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-resolved-approval-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const threadId = 'resolved-approval';
    const store = openStateStoreForTest(stateStorePathForTest(checkpointPath));
    try {
      let state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
        projectId: 'project_resolved_approval',
        canonicalWorkspaceDigest: `sha256:${'2'.repeat(64)}`,
      });
      state = reduceRuntimeState(state, {
        type: 'tool.queued',
        toolCallId: 'shell-1',
        name: 'shell_execute',
        args: { command: 'git status --short' },
      });
      state = reduceRuntimeState(state, {
        type: 'approval.requested',
        interactionId: 'approval-1',
        toolCallId: 'shell-1',
        fullModeBypassEligible: false,
        fullModePolicyBypassAllowed: false,
        approval: {
          scope: 'once',
          cwd: '/tmp/ws',
          threadId,
          tool: 'shell_execute',
          command: 'git status --short',
          risk: 'execute_code',
          approvalHash: 'hash',
          summary: 'Check status',
          reason: 'Inspect the workspace.',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      });
      store.saveSnapshot(threadId, state);
      store.appendEvents(
        threadId,
        [
          {
            type: 'approval.granted',
            interactionId: 'approval-1',
            toolCallId: 'shell-1',
            grant: 'approve_once',
            receiptId: 'receipt-approval-1',
            generation: 0,
          },
        ],
        [
          {
            eventId: 'approval-granted-1',
            revision: state.revision + 1,
            occurredAt: '2026-08-15T00:00:00.000Z',
          },
        ],
      );
      store.setSessionModelRoute(threadId, {
        provider: 'ollama',
        name: 'qwen2.5-coder:7b',
      });
    } finally {
      store.close();
    }

    try {
      const restored = await loadSession(
        () => openStateStoreForTest(stateStorePathForTest(checkpointPath)),
        threadId,
        '0'.repeat(64),
      );
      expect(restored?.interrupt).toBeNull();
      expect(restored?.modelProvider).toBe('ollama');
      expect(restored?.modelName).toBe('qwen2.5-coder:7b');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps model configurations isolated per session while updating new-session default', () => {
    const deps = makeDeps();
    deps.config = {
      ...deps.config,
      providerName: 'deepseek',
      modelName: 'deepseek-v4-flash',
    };
    const mgr = new SessionManager(deps);
    const firstId = mgr.createSession('/tmp/ws');
    const selected = {
      ...deps.config,
      providerName: 'ollama',
      modelName: 'qwen2.5-coder:7b',
    };
    expect(mgr.setSessionConfig(firstId, selected, { asDefault: true })).toBe(true);

    const secondId = mgr.createSession('/tmp/ws');
    const secondOnly = {
      ...deps.config,
      providerName: 'opencode_go',
      modelName: 'deepseek-v4-pro',
    };
    expect(mgr.setSessionConfig(secondId, secondOnly)).toBe(true);

    expect(mgr.getRuntime(firstId)?.config).toMatchObject({
      providerName: 'ollama',
      modelName: 'qwen2.5-coder:7b',
    });
    expect(mgr.getRuntime(secondId)?.config).toMatchObject({
      providerName: 'opencode_go',
      modelName: 'deepseek-v4-pro',
    });
    expect(mgr.getDefaultConfig()).toMatchObject({
      providerName: 'ollama',
      modelName: 'qwen2.5-coder:7b',
    });
  });

  test('queues manual compaction through a live Kernel control plane', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
    });
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input',
      toolCallId: 'ask',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
    const persisted: unknown[] = [];
    runtime.authorizedExecutionControl = {
      getState: () => state,
      processEvent: (event) => {
        persisted.push(event);
      },
      processEventBatch: (events) => {
        persisted.push(...events);
        return events;
      },
      cancelRun: () => [],
    };

    const result = await mgr.handleContextCompaction(threadId);
    expect(persisted[0]).toMatchObject({
      type: 'user.command_invoked',
      command: '/compact',
    });
    expect(persisted[1]).toMatchObject({
      type: 'context.compaction_requested',
      reason: 'manual',
      force: false,
    });
    expect(result.text).toContain('queued');
  });

  test('retries manual compaction after a terminal run releases its live control', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
    });
    state.turn = { ...state.turn, status: 'completed' };
    const control = {
      getState: () => state,
      processEvent: () => undefined,
      processEventBatch: (events: RuntimeEvent[]) => events,
      cancelRun: () => [],
    };
    runtime.authorizedExecutionControl = control;
    const completion = Promise.resolve().then(() => {
      runtime.authorizedExecutionControl = null;
    });
    Reflect.set(runtime, '_runCompletion', completion);

    const result = await mgr.handleContextCompaction(threadId);
    expect(result.events).toEqual([]);
    expect(result.failureCode).toBe('runtime_control_unavailable');
    expect(result.isError).toBe(true);
  });

  test('fails closed when an idle session has no Runtime execution control', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const result = await mgr.handleContextCompaction(threadId);
    expect(result.events).toEqual([]);
    expect(result.text).toBe('Context compaction requires an active Runtime execution control.');
    expect(result.failureCode).toBe('runtime_control_unavailable');
    expect(result.isError).toBe(true);
  });

  test('Host compaction entrypoint also fails closed without a live control', async () => {
    const deps = makeDeps();
    deps.config = {
      ...deps.config,
      features: { ...deps.config.features, contextCompactionManual: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');

    const result = await mgr.executeHostCompaction(threadId);

    expect(result).toEqual({
      events: [],
      text: 'Context compaction requires an active Runtime execution control.',
      isError: true,
      failureCode: 'runtime_control_unavailable',
    });
  });

  test('does not open a standalone coordinator for an idle settled turn', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-compact-small-'));
    const deps = makeDeps(join(root, 'checkpoints.sqlite'));
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };
    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
      });
      state.transcript.messages = [
        {
          kind: 'user',
          messageId: 'user-1',
          turnId: 'turn-1',
          ordinal: 0,
          createdAt: '2026-08-08T00:00:00.000Z',
          content: 'Hello',
        },
        {
          kind: 'assistant',
          messageId: 'assistant-1',
          turnId: 'turn-1',
          ordinal: 1,
          createdAt: '2026-08-08T00:00:01.000Z',
          content: 'Hello!',
          toolCalls: [],
        },
      ];
      const store = openStateStoreForTest(stateStorePathForTest(deps.checkpointPath));
      try {
        store.saveSnapshot(threadId, state);
      } finally {
        store.close();
      }

      const result = await mgr.handleContextCompaction(threadId);

      expect(result.events).toEqual([]);
      expect(result.failureCode).toBe('runtime_control_unavailable');
      expect(result.isError).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('Host-recovered idle /compact uses the runtime coordinator exactly once', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-retained-manager-'));
    const deps = makeDeps(join(root, 'checkpoints.sqlite'));
    deps.config = {
      ...deps.config,
      features: { ...deps.config.features, contextCompactionManual: true },
    };
    const cachedModelRuntime = deps.modelInvocationRuntimeFactory('/tmp/ws');
    deps.modelInvocationRuntimeFactory = () => cachedModelRuntime;
    let openStoreCalls = 0;
    const openStore = deps.openStateRuntimeStorage;
    deps.openStateRuntimeStorage = (threadId) => {
      openStoreCalls += 1;
      return openStore(threadId);
    };
    const retainedStore = deps.openStateRuntimeStorage('retained-manager-test');
    const threadId = 'retained-manager-test';
    const runtimeState = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'tui-user',
      workspace: '/tmp/ws',
      projectId: 'project_retained_manager_test',
      canonicalWorkspaceDigest: `sha256:${'1'.repeat(64)}`,
    });
    runtimeState.transcript.messages = [
      {
        kind: 'user',
        messageId: 'historical',
        turnId: 'historical-turn',
        ordinal: 0,
        createdAt: '2026-08-21T00:00:00.000Z',
        content: 'Historical context '.repeat(200),
      },
      {
        kind: 'user',
        messageId: 'current',
        turnId: runtimeState.turn.turnId,
        ordinal: 1,
        createdAt: '2026-08-21T00:00:01.000Z',
        content: 'Current request',
      },
    ];
    let state = reduceRuntimeState(runtimeState, {
      type: 'context.compaction_requested',
      compactionId: 'retained-manager-compaction',
      reason: 'manual',
      requestedAtRevision: runtimeState.revision,
      requestedAtTurnId: runtimeState.turn.turnId,
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
    retainedStore.sessions.saveSnapshot(threadId, state);
    expect(retainedStore.sessions.loadSnapshot<RuntimeState>(threadId)?.session.projectId).toBe(
      'project_retained_manager_test',
    );
    const control = {
      getState: () => state,
      processEvent: (event: RuntimeEvent) => {
        state = reduceRuntimeState(state, event);
      },
      processEventBatch: (events: RuntimeEvent[]) => {
        state = events.reduce((current, event) => reduceRuntimeState(current, event), state);
        return events;
      },
      cancelRun: () => [],
    };
    let ensureCalls = 0;
    let executeCalls = 0;
    const runtimeCoordinator = {
      sessionId: threadId,
      control,
      session: {} as RuntimeSessionCoordinator['session'],
      recoveryChanged: false,
      lifecycle: 'idle' as const,
      getState: () => state,
      getStateRuntimeStorage: () => retainedStore,
      isTurnActive: () => false,
      beginTurn: () => undefined,
      endTurn: () => undefined,
      updateInteractionMode: () => undefined,
      getInteractionModeState: () => ({
        interactionMode: state.mode,
        interactionModeRevision: state.interactionModeRevision,
      }),
      updateSandboxAvailable: () => undefined,
      getSandboxAvailable: () => undefined,
      setActiveCancelRun: () => undefined,
      clearActiveCancelRun: () => undefined,
      commitInteractionModeCommand: () => {
        throw new Error('not used');
      },
      commitCancelTurnCommand: () => {
        throw new Error('not used');
      },
      commitCloseSessionCommand: () => {
        throw new Error('not used');
      },
      commitClearSessionCommandGrantsCommand: () => {
        throw new Error('not used');
      },
      commitForkSessionCommand: () => {
        throw new Error('not used');
      },
      commitStartTurnCommand: () => {
        throw new Error('not used');
      },
      executeTurn: () => {
        throw new Error('not used');
      },
      createRuntimeEffectPort: () => {
        throw new Error('not used');
      },
      executePendingCompaction: async ({ dependencies }: { dependencies: unknown }) => {
        executeCalls += 1;
        expect((dependencies as { capabilityExecution?: unknown }).capabilityExecution).toBe(
          deps.capabilityExecution,
        );
        const terminal: RuntimeEvent = {
          type: 'context.compaction_completed',
          compactionId: 'retained-manager-compaction',
          sourceRevision: state.revision,
          checkpoint: {
            compactionId: 'retained-manager-compaction',
            version: 1,
            sourceRevision: state.revision,
            sourceDigest: 'sha256:test',
            coveredThroughMessageId: 'current',
            coveredThroughTurnId: state.turn.turnId,
            summary: 'retained summary',
            inputTokensBefore: 100,
            inputTokensAfter: 10,
            reason: 'manual',
            createdAt: '2026-08-21T00:00:02.000Z',
          },
        };
        control.processEvent(terminal);
        state = {
          ...state,
          context: {
            ...state.context,
            pendingCompaction: undefined,
            activeCheckpoint: terminal.checkpoint,
          },
        };
        return [terminal];
      },
      waitForIdle: async () => undefined,
      close: async () => undefined,
    } satisfies Partial<RuntimeSessionCoordinator> as RuntimeSessionCoordinator;
    deps.runtimeSessionCoordinator = {
      ensure: () => {
        ensureCalls += 1;
        return runtimeCoordinator;
      },
      get: (id) => (id === threadId ? runtimeCoordinator : undefined),
      release: async () => undefined,
      close: async () => undefined,
    };
    openStoreCalls = 0;
    const mgr = new SessionManager(deps);
    try {
      mgr.registerSession(threadId, '/tmp/ws');
      openStoreCalls = 0;
      expect(await mgr.recoverRuntimeState(threadId)).toBe(false);
      expect(ensureCalls).toBe(2);
      const first = await mgr.executeHostCompaction(threadId);
      expect(
        first.events.filter(
          (event) => event.type === 'context.compaction' && event.status === 'completed',
        ),
      ).toHaveLength(1);
      expect(executeCalls).toBe(1);
      // The recovered projection now verifies its retained snapshot through
      // the Store once before dispatching the coordinator-owned compaction.
      expect(openStoreCalls).toBe(1);
      const second = await mgr.executeHostCompaction(threadId);
      expect(executeCalls).toBe(1);
      expect(
        second.events.filter(
          (event) => event.type === 'context.compaction' && event.status === 'completed',
        ),
      ).toHaveLength(0);
    } finally {
      retainedStore.close();
      deps.tokenStatsStorage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed without projecting a command when the control is unavailable', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const projected: RuntimeEvent[] = [];

    const result = await mgr.handleContextCompaction(threadId, undefined, undefined, (event) => {
      projected.push(event);
    });

    expect(result.text).toBe('Context compaction requires an active Runtime execution control.');
    expect(result.failureCode).toBe('runtime_control_unavailable');
    expect(result.isError).toBe(true);
    expect(projected).toEqual([]);
  });

  test('leaves historical manual compaction pending when no live control exists', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-compact-recovery-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const deps = makeDeps(checkpointPath);
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };

    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      const kernel = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
        store: openStateStoreForTest(stateStorePathForTest(checkpointPath)),
        interactionMode: 'accept_edits',
        phase: 'building',
      });
      try {
        const state = kernel.getState();
        kernel.processEvent({
          type: 'context.compaction_requested',
          compactionId: 'stuck-manual-request',
          reason: 'manual',
          requestedAtRevision: state.revision,
          requestedAtTurnId: state.turn.turnId,
          force: false,
          estimate: {
            systemTokens: 0,
            toolSchemaTokens: 0,
            transcriptTokens: 0,
            summaryTokens: 0,
            dynamicRuntimeTokens: 0,
            framingTokens: 0,
            totalInputTokens: 0,
          },
        });
      } finally {
        kernel.close();
      }

      const result = await mgr.handleContextCompaction(threadId);
      expect(result.events).toEqual([]);
      expect(result.failureCode).toBe('runtime_control_unavailable');
      expect(result.isError).toBe(true);

      const store = openStateStoreForTest(stateStorePathForTest(checkpointPath));
      try {
        const state =
          store.loadSnapshot<ReturnType<typeof createRuntimeHostStateInitialState>>(threadId);
        expect(state?.context.pendingCompaction?.compactionId).toBe('stuck-manual-request');
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a second consecutive /compact returns a non-error no-new-messages result', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
    });
    state.transcript.messages = Array.from({ length: 3 }, (_, index) => ({
      kind: 'user' as const,
      messageId: `msg-${index}`,
      turnId: `turn-${index}`,
      ordinal: index,
      createdAt: `2026-07-20T00:0${index}:00.000Z`,
      content: `message ${index}`,
    }));
    state = reduceRuntimeState(state, {
      type: 'context.compaction_requested',
      compactionId: 'existing',
      reason: 'manual',
      requestedAtRevision: state.revision,
      requestedAtTurnId: state.turn.turnId,
      force: false,
      estimate: {
        systemTokens: 0,
        toolSchemaTokens: 0,
        transcriptTokens: 4_000,
        summaryTokens: 0,
        dynamicRuntimeTokens: 0,
        framingTokens: 0,
        totalInputTokens: 4_000,
      },
    });
    state = reduceRuntimeState(state, {
      type: 'context.compaction_completed',
      compactionId: 'existing',
      sourceRevision: state.revision,
      checkpoint: {
        compactionId: 'existing',
        version: 1,
        sourceRevision: state.revision,
        sourceDigest: 'digest',
        coveredThroughMessageId: 'msg-2',
        coveredThroughTurnId: 'turn-2',
        summary: 'Existing summary.',
        inputTokensBefore: 4_000,
        inputTokensAfter: 1_000,
        reason: 'manual',
        createdAt: '2026-07-20T00:03:00.000Z',
      },
      durationMs: 10,
    });
    const persisted: unknown[] = [];
    runtime.authorizedExecutionControl = {
      getState: () => state,
      processEvent: (event) => persisted.push(event),
      processEventBatch: (events) => {
        persisted.push(...events);
        return events;
      },
      cancelRun: () => [],
    };

    const result = await mgr.handleContextCompaction(threadId);

    expect(persisted.map((event) => (event as { type: string }).type)).toEqual([
      'context.compaction_requested',
      'context.compaction_failed',
    ]);
    expect(persisted.at(-1)).toMatchObject({
      type: 'context.compaction_failed',
      errorKind: 'unsafe_boundary',
      retryable: false,
      message: 'No new messages to compact.',
    });
    expect(result.text).toBe('No new messages to compact.');
    expect(result.isError).toBeUndefined();
  });

  test('custom instructions do not rework a fully covered checkpoint without new source', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
    });
    state.transcript.messages = [
      {
        kind: 'user',
        messageId: 'msg-0',
        turnId: 'turn-0',
        ordinal: 0,
        createdAt: '2026-07-20T00:00:00.000Z',
        content: 'message 0',
      },
    ];
    state.context.activeCheckpoint = {
      compactionId: 'existing',
      version: 1,
      sourceRevision: 0,
      sourceDigest: 'digest',
      coveredThroughMessageId: 'msg-0',
      coveredThroughTurnId: 'turn-0',
      summary: 'Existing summary.',
      inputTokensBefore: 4_000,
      inputTokensAfter: 1_000,
      reason: 'manual',
      createdAt: '2026-07-20T00:01:00.000Z',
    };
    const persisted: unknown[] = [];
    runtime.authorizedExecutionControl = {
      getState: () => state,
      processEvent: (event) => persisted.push(event),
      processEventBatch: (events) => {
        persisted.push(...events);
        return events;
      },
      cancelRun: () => [],
    };

    const result = await mgr.handleContextCompaction(threadId, 'focus on unfinished work');

    expect(persisted).toContainEqual(
      expect.objectContaining({
        type: 'context.compaction_failed',
        message: 'No new messages to compact.',
      }),
    );
    expect(result.text).toBe('No new messages to compact.');
  });

  test('rebuilds context status from the restored checkpoint when entering a session', () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
    });
    state.transcript.messages = [
      {
        kind: 'user',
        messageId: 'covered',
        turnId: 'turn-covered',
        ordinal: 0,
        createdAt: '2026-07-20T00:00:00.000Z',
        content: 'old history '.repeat(2_000),
      },
      {
        kind: 'user',
        messageId: 'live',
        turnId: 'turn-live',
        ordinal: 1,
        createdAt: '2026-07-20T00:01:00.000Z',
        content: 'new work',
      },
    ];
    state.context.activeCheckpoint = {
      compactionId: 'restored-checkpoint',
      version: 1,
      sourceRevision: 0,
      sourceDigest: 'digest',
      coveredThroughMessageId: 'covered',
      coveredThroughTurnId: 'turn-covered',
      summary: 'Condensed old history.',
      inputTokensBefore: 20_000,
      inputTokensAfter: 2_000,
      reason: 'manual',
      createdAt: '2026-07-20T00:02:00.000Z',
    };
    runtime.authorizedExecutionControl = {
      getState: () => state,
      processEvent: () => {},
      processEventBatch: (events) => events,
      cancelRun: () => [],
    };

    const snapshot = mgr.buildContextStatusSnapshot(threadId);

    expect(snapshot).toMatchObject({
      activeCheckpointId: 'restored-checkpoint',
      inputTokensBefore: 20_000,
      inputTokensAfter: 2_000,
    });
    expect(snapshot!.estimate.summaryTokens).toBeGreaterThan(0);
    expect(snapshot!.estimate.transcriptTokens).toBeLessThan(1_000);
  });

  test('does not persist an idle fail-closed /compact for replay or the model transcript', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-compact-replay-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const deps = makeDeps(checkpointPath);
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
    };

    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      await mgr.handleContextCompaction(threadId, 'focus on auth changes');

      const store = openStateStoreForTest(stateStorePathForTest(checkpointPath));
      try {
        const events = store.loadEventsStrict(threadId).map((entry) => entry.event);
        expect(events).not.toContainEqual(
          expect.objectContaining({ type: 'user.command_invoked' }),
        );
        const state =
          store.loadSnapshot<ReturnType<typeof createRuntimeHostStateInitialState>>(threadId);
        expect(state).toBeNull();
      } finally {
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('queues compaction with enough messages while a live interaction is pending', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
      compaction: {},
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
    });
    // Add transcript messages spanning several turns
    state.transcript.messages = Array.from({ length: 6 }, (_, i) => ({
      kind: 'user' as const,
      messageId: `msg-${i}`,
      turnId: `turn-${i}`,
      ordinal: i,
      createdAt: `2026-07-20T00:0${i}:00.000Z`,
      content: `message ${i}`,
    }));
    state.turn.turnIndex = 6;
    state.turn.turnId = 'turn-5';
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input',
      toolCallId: 'ask',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
    const persisted: unknown[] = [];
    runtime.authorizedExecutionControl = {
      getState: () => state,
      processEvent: (event) => {
        persisted.push(event);
      },
      processEventBatch: (events) => {
        persisted.push(...events);
        return events;
      },
      cancelRun: () => [],
    };

    const result = await mgr.handleContextCompaction(threadId);
    expect(persisted[0]).toMatchObject({
      type: 'user.command_invoked',
      command: '/compact',
    });
    expect(persisted[1]).toMatchObject({
      type: 'context.compaction_requested',
      reason: 'manual',
      force: false,
    });
    expect(result.text).toContain('queued');
  });

  test('fails closed instead of executing standalone manual compaction', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-compact-success-'));
    const server = createMockModelServer();
    const deps = makeDeps(join(root, 'checkpoints.sqlite'));
    deps.config = {
      apiKey: 'test',
      baseURL: server.baseURL,
      modelName: 'mock-model',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
      compaction: { maxSummaryTokens: 200, maxNarrativeTokens: 200 },
    };
    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
      });
      state.transcript.messages = Array.from({ length: 3 }, (_, index) => ({
        kind: 'user' as const,
        messageId: `message-${index}`,
        turnId: `turn-${index}`,
        ordinal: index,
        createdAt: `2026-08-08T00:0${index}:00.000Z`,
        content: `Historical goal ${index}: ${'important context '.repeat(1_000)}`,
      }));
      const store = openStateStoreForTest(stateStorePathForTest(deps.checkpointPath));
      try {
        store.saveSnapshot(threadId, state);
      } finally {
        store.close();
      }

      const result = await mgr.handleContextCompaction(threadId);

      expect(server.getRequestCount()).toBe(0);
      expect(result.events).toEqual([]);
      expect(result.failureCode).toBe('runtime_control_unavailable');
      expect(result.isError).toBe(true);
      const restored = openStateStoreForTest(stateStorePathForTest(deps.checkpointPath));
      try {
        expect(
          restored.loadSnapshot<ReturnType<typeof createRuntimeHostStateInitialState>>(threadId)
            ?.context.activeCheckpoint,
        ).toBeUndefined();
      } finally {
        restored.close();
      }
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('idle compaction fails closed before Provider data admission or dispatch', async () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-compact-policy-'));
    const server = createMockModelServer();
    const deps = makeDeps(join(root, 'checkpoints.sqlite'));
    deps.config = {
      apiKey: 'test',
      baseURL: server.baseURL,
      modelName: 'unapproved-model',
      providerName: 'unapproved-provider',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManual: true },
      compaction: { maxSummaryTokens: 200, maxNarrativeTokens: 200 },
    };

    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
      });
      state.transcript.messages = Array.from({ length: 3 }, (_, index) => ({
        kind: 'user' as const,
        messageId: `message-${index}`,
        turnId: `turn-${index}`,
        ordinal: index,
        createdAt: `2026-08-08T00:0${index}:00.000Z`,
        content: `Historical goal ${index}: ${'important context '.repeat(1_000)}`,
      }));
      const store = openStateStoreForTest(stateStorePathForTest(deps.checkpointPath));
      try {
        store.saveSnapshot(threadId, state);
      } finally {
        store.close();
      }

      const result = await mgr.handleContextCompaction(threadId);

      expect(server.getRequestCount()).toBe(0);
      expect(result.events).toEqual([]);
      expect(result.failureCode).toBe('runtime_control_unavailable');
      expect(result.isError).toBe(true);
      const restored = openStateStoreForTest(stateStorePathForTest(deps.checkpointPath));
      try {
        expect(
          restored.loadSnapshot<ReturnType<typeof createRuntimeHostStateInitialState>>(threadId)
            ?.context.pendingCompaction,
        ).toBeUndefined();
      } finally {
        restored.close();
      }
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── createSession ──

  test('createSession returns unique threadId', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    expect(id1).not.toBe(id2);
    expect(id1).toStartWith('tui-');
  });

  test('createSession adds snapshot with correct fields', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    const snapshots = mgr.getSnapshot();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]!.threadId).toBe(id);
    expect(snapshots[0]!.active).toBe(true);
    expect(snapshots[0]!.running).toBe(false);
    expect(snapshots[0]!.workspace).toBe('/tmp/ws');
  });

  test('createSession backgrounds the previous active session without clearing its interrupt', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;
    // Set up a pending interrupt on the old session
    (rt1 as unknown as RuntimeWithPendingResolve)._pendingResolve = {
      interactionId: 'backgrounded-interaction',
      resolve: () => {},
    };
    rt1.pendingInterrupt = true;

    // Create new session — should deactivate old one
    mgr.createSession('/tmp/ws');

    const snapshots = mgr.getSnapshot();
    const s1 = snapshots.find((s) => s.threadId === id1)!;
    expect(s1.active).toBe(false);
    expect(rt1.pendingInterrupt).toBe(true);
    // The old session's interrupt should have been cancelled
    // (via resolveInterrupt in createSession)
  });

  test('createSession sets notifyInterrupt callback on new runtime', () => {
    const mgr = makeManager();
    mgr.setSnapshotCallback(() => {});
    const id = mgr.createSession('/tmp/ws');
    const rt = mgr.getRuntime(id)!;
    expect(rt.notifyInterrupt).toBeDefined();
  });

  test('exitPlanningMode reconciles a completed planning Task to building', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-plan-exit-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const deps = makeDeps(checkpointPath);
    const mgr = new SessionManager(deps);
    let kernel: ReturnType<typeof restoreStateKernelCoordinator> | undefined;
    try {
      const threadId = mgr.createSession('/tmp/ws');
      const runtime = mgr.getRuntime(threadId)!;
      kernel = restoreStateKernelCoordinator({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
        store: openStateStoreForTest(stateStorePathForTest(checkpointPath)),
        phase: 'building',
      });
      runtime.authorizedExecutionControl = {
        getState: () => kernel!.getState(),
        processEvent: (event) => {
          kernel!.processEvent(event);
        },
        processEventBatch: (events) => kernel!.processEventBatch(events),
        cancelRun: () => [],
      };
      expect(mgr.enterPlanningMode(threadId).map((event) => event.type)).toEqual([
        'task.started',
        'planning.entered',
      ]);
      const taskId = kernel.getState().activeTaskId!;
      const draftPlan = {
        name: 'Exit planning safely',
        description: 'Complete the plan lifecycle before exiting plan mode.',
        status: 'pending' as const,
        steps: [{ id: 'complete', step: 'Complete the plan', status: 'pending' as const }],
      };
      const drafted = currentPlanDraftedEvent({
        toolCallId: 'draft-plan',
        taskId,
        planId: 'exit-plan',
        version: 1,
        plan: draftPlan,
      });
      kernel.processEvent(drafted);
      kernel.processEvent({
        type: 'tool.queued',
        toolCallId: 'submit-plan',
        taskId,
        name: 'write_plan',
        args: {},
      });
      kernel.processEvent({
        type: 'plan.review_requested',
        interactionId: 'exit-review',
        toolCallId: 'submit-plan',
        taskId,
        planId: 'exit-plan',
        version: 1,
        structuralDigest: drafted.structuralHash,
        artifact: drafted.artifact,
        planSummary: 'Complete the plan lifecycle before exiting plan mode.',
        plan: draftPlan,
      });
      kernel.processEvent({
        type: 'plan.approved',
        interactionId: 'exit-review',
        toolCallId: 'submit-plan',
        planId: 'exit-plan',
        version: 1,
        structuralDigest: drafted.structuralHash,
        executionMode: 'accept_edits',
      });
      kernel.processEvent({
        type: 'tool.finished',
        toolCallId: 'submit-plan',
        name: 'write_plan',
        result: {
          ok: true,
          command: '',
          exitCode: 0,
          stdout: 'approved',
          stderr: '',
        },
      });
      const completedPlan = {
        name: 'Exit planning safely',
        description: 'Complete the plan lifecycle before exiting plan mode.',
        status: 'completed' as const,
        steps: [{ id: 'complete', step: 'Complete the plan', status: 'completed' as const }],
      };
      const executing = getActivePlanning(kernel.getState());
      if (executing.kind !== 'executing') throw new Error('expected executing Plan');
      const completionIdentity = {
        taskId,
        planId: executing.document.planId,
        version: executing.document.version,
        structuralDigest: executing.document.structuralDigest,
        completionEvidence: executing.document.completionEvidence,
      };
      kernel.processEvent({
        type: 'plan.progress_updated',
        toolCallId: 'complete-plan',
        plan: completedPlan,
        ...completionIdentity,
      });
      kernel.processEvent({
        type: 'plan.completed',
        toolCallId: 'complete-plan',
        plan: completedPlan,
        ...completionIdentity,
      });
      expect(getActivePlanning(kernel.getState()).kind).toBe('completed');
      kernel.processEvent({
        type: 'run.completed',
        turnId: kernel.getState().turn.turnId,
        output: 'Planning conversation completed.',
      });
      expect(mgr.exitPlanningMode(threadId)).toEqual({
        events: [],
        phase: 'building',
      });
    } finally {
      kernel?.close();
      mgr.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('routes plan-mode changes through the live Kernel without a second writer', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-plan-live-kernel-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const mgr = new SessionManager(makeDeps(checkpointPath));
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const kernel = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
      store: openStateStoreForTest(stateStorePathForTest(checkpointPath)),
      phase: 'building',
    });
    try {
      kernel.processEvent({
        type: 'task.started',
        taskId: 'live-task',
        userGoal: 'Keep the active run on one Kernel writer.',
        turnId: kernel.getState().turn.turnId,
      });
      runtime.authorizedExecutionControl = {
        getState: () => kernel.getState(),
        processEvent: (event) => {
          kernel.processEvent(event);
        },
        processEventBatch: (events) => kernel.processEventBatch(events),
        cancelRun: () => [],
      };

      expect(mgr.enterPlanningMode(threadId).map((event) => event.type)).toEqual([
        'planning.entered',
      ]);
      expect(getActivePlanning(kernel.getState()).kind).toBe('planning_empty');
      expect(() =>
        kernel.processEvent({
          type: 'interaction_mode.changed',
          mode: 'auto',
          source: 'user',
          changedAt: '2026-08-15T00:00:00.000Z',
        }),
      ).not.toThrow();

      expect(mgr.exitPlanningMode(threadId)).toEqual({
        events: [
          expect.objectContaining({ type: 'planning.exited', taskId: 'live-task' }),
          expect.objectContaining({ type: 'task.cancelled', taskId: 'live-task' }),
        ],
        phase: 'building',
      });
      expect(kernel.getState().activeTaskId).toBeNull();
      expect(getActivePlanning(kernel.getState()).kind).toBe('building_without_plan');
    } finally {
      runtime.authorizedExecutionControl = null;
      kernel.close();
      mgr.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── switchSession ──

  test('switchSession toggles active flag and updates activeId', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    mgr.switchSession(id1, id2);
    const snapshots = mgr.getSnapshot();
    const s1 = snapshots.find((s) => s.threadId === id1)!;
    const s2 = snapshots.find((s) => s.threadId === id2)!;
    expect(s1.active).toBe(false);
    expect(s2.active).toBe(true);
    expect(mgr.getActiveId()).toBe(id2);
  });

  test('switchSession restores the target foreground state for load rollback', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;

    mgr.switchSession(id2, id1);
    expect((rt1 as unknown as RuntimeWithForeground)._foreground).toBe(true);
    mgr.switchSession(id1, id2);
    expect((rt1 as unknown as RuntimeWithForeground)._foreground).toBe(false);
    mgr.switchSession(id2, id1);
    expect((rt1 as unknown as RuntimeWithForeground)._foreground).toBe(true);
  });

  test('switchSession preserves a pending interrupt on the outgoing session', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;
    rt1.pendingInterrupt = true;
    (rt1 as unknown as RuntimeWithPendingResolve)._pendingResolve = {
      interactionId: 'switch-interaction',
      resolve: () => {},
    };

    mgr.switchSession(id1, id2);

    // Navigation alone must not manufacture a cancellation decision.
    expect(rt1.pendingInterrupt).toBe(true);
  });

  test('switchSession retains pendingInterrupt on outgoing session', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;
    rt1.pendingInterrupt = true;

    mgr.switchSession(id1, id2);

    expect(rt1.pendingInterrupt).toBe(true);
  });

  test('switchSession backgrounds an active TUI turn without cancelling it', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    mgr.switchSession(id2, id1);
    const rt1 = mgr.getRuntime(id1)!;
    rt1.agentLoopActive = true;
    let abortCalls = 0;
    rt1.abort = () => {
      abortCalls += 1;
      rt1.agentLoopActive = false;
    };

    mgr.switchSession(id1, id2);

    expect(abortCalls).toBe(0);
    expect(mgr.getActiveId()).toBe(id2);
  });

  // ── removeRuntime ──

  test('removeRuntime aborts running session and removes from map', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    const rt = mgr.getRuntime(id)!;
    const ac = new AbortController();
    rt.agentLoopActive = true;
    rt.abortController = ac;

    mgr.removeRuntime(id);

    expect(ac.signal.aborted).toBe(true);
    expect(rt.agentLoopActive).toBe(false);
    expect(mgr.getRuntime(id)).toBeUndefined();
  });

  test('removeRuntime clears activeId when removing active session', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    expect(mgr.getActiveId()).toBe(id);

    mgr.removeRuntime(id);

    expect(mgr.getActiveId()).toBe('');
  });

  test('removeRuntime does not clear activeId when removing inactive session', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    mgr.switchSession(id1, id2);

    mgr.removeRuntime(id1); // remove inactive session

    expect(mgr.getActiveId()).toBe(id2);
  });

  test('removeRuntime clears event buffer', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    const rt = mgr.getRuntime(id)!;
    rt.eventBuffer.push({
      type: 'model.responded',
      requestId: 'm1',
      messageId: 'm1',
      toolCallCount: 0,
      summary: 'hello',
    });

    mgr.removeRuntime(id);

    expect(rt.eventBuffer.length).toBe(0);
  });

  // ── registerSession ──

  test('registerSession creates a runtime for external threadId', () => {
    const mgr = makeManager();
    const tid = 'ext-thread-1';
    mgr.registerSession(tid, '/tmp/ws');

    const rt = mgr.getRuntime(tid);
    expect(rt).toBeDefined();
    expect(rt?.threadId).toBe(tid);
    expect(mgr.hasRuntime(tid)).toBe(true);
  });

  test('registered session appears in snapshot', () => {
    const mgr = makeManager();
    mgr.registerSession('ext-1', '/tmp/ws');
    const snapshots = mgr.getSnapshot();
    expect(snapshots.length).toBe(1);
    expect(snapshots[0]!.active).toBe(false); // not active by default
  });

  test('registerSession restores the persisted workspace identity across checkouts', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-session-workspace-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const threadId = 'persisted-workspace-session';
    const historicalWorkspace = join(root, 'historical-workspace');
    const currentWorkspace = join(root, 'current-worktree');
    const digest = createHash('sha256').update(historicalWorkspace).digest('hex');
    const deps = makeDeps(checkpointPath);
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: 'a'.repeat(64),
        threadId,
        userId: 'tui-user',
        workspace: historicalWorkspace,
        projectId: `project_${digest}`,
        canonicalWorkspaceDigest: `sha256:${digest}`,
      });
      const store = deps.openStateRuntimeStorage(threadId);
      try {
        store.sessions.saveSnapshot(threadId, state);
      } finally {
        store.close();
      }
      const coordinatorAccess = installTestOnlyRuntimeTurnAdapter(deps, threadId);
      let admittedWorkspace: string | undefined;
      deps.runtimeSessionCoordinator = {
        ...coordinatorAccess,
        ensure: (identity) => {
          admittedWorkspace = identity.workspace;
          return coordinatorAccess.ensure(identity);
        },
      };

      const manager = new SessionManager(deps);
      const runtime = manager.registerSession(threadId, currentWorkspace);

      expect(runtime.workspace).toBe(historicalWorkspace);
      expect(admittedWorkspace).toBe(historicalWorkspace);
      expect(manager.hasRuntime(threadId)).toBe(true);
    } finally {
      deps.tokenStatsStorage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('registerSession leaves no ghost runtime when coordinator admission fails', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-session-register-failure-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const threadId = 'failed-register-session';
    const workspace = join(root, 'workspace');
    const digest = createHash('sha256').update(workspace).digest('hex');
    const deps = makeDeps(checkpointPath);
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: 'b'.repeat(64),
        threadId,
        userId: 'tui-user',
        workspace,
        projectId: `project_${digest}`,
        canonicalWorkspaceDigest: `sha256:${digest}`,
      });
      const store = deps.openStateRuntimeStorage(threadId);
      try {
        store.sessions.saveSnapshot(threadId, state);
      } finally {
        store.close();
      }
      deps.runtimeSessionCoordinator = {
        ensure: () => {
          throw new Error('coordinator admission rejected');
        },
        get: () => undefined,
        release: async () => undefined,
        close: async () => undefined,
      };

      const manager = new SessionManager(deps);
      expect(() => manager.registerSession(threadId, workspace)).toThrow(
        'coordinator admission rejected',
      );
      expect(manager.hasRuntime(threadId)).toBe(false);
    } finally {
      deps.tokenStatsStorage.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  // ── getSnapshot ──

  test('getSnapshot reflects running state', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    const rt = mgr.getRuntime(id)!;
    rt.agentLoopActive = true;
    const snapshots = mgr.getSnapshot();
    expect(snapshots[0]!.running).toBe(true);
  });

  test('getSnapshot includes pendingInterrupt from runtime', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    const rt = mgr.getRuntime(id)!;
    rt.pendingInterrupt = true;
    const snapshots = mgr.getSnapshot();
    expect(snapshots[0]!.pendingInterrupt).toBe(true);
  });

  test('getSnapshot includes name field', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    const rt = mgr.getRuntime(id)!;
    rt.name = 'Test Session';
    const snapshots = mgr.getSnapshot();
    expect(snapshots[0]!.name).toBe('Test Session');
  });

  test('getSnapshot returns empty array when no runtimes', () => {
    const mgr = makeManager();
    expect(mgr.getSnapshot()).toEqual([]);
  });

  test('getSnapshot does not initialize token stats in an incompatible StateRuntimeStorage', () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-stats-incompatible-'));
    const checkpointPath = join(dir, 'checkpoints.sqlite');
    const storePath = stateStorePathForTest(checkpointPath);
    try {
      const legacy = new Database(storePath);
      legacy.run(
        'CREATE TABLE runtime_events (id INTEGER PRIMARY KEY, thread_id TEXT, event_json TEXT)',
      );
      legacy.close();
      const digest = () => createHash('sha256').update(readFileSync(storePath)).digest('hex');
      const before = digest();
      const manager = new SessionManager(makeDeps(checkpointPath));

      expect(manager.getSnapshot()).toEqual([]);
      expect(digest()).toBe(before);
      const verify = new Database(storePath, { readonly: true });
      expect(
        verify
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'session_stats'",
          )
          .get()?.count,
      ).toBe(0);
      verify.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('loadSession rejects a retired event before TUI replay', async () => {
    const dir = mkdtempSync(join(process.cwd(), '.kite-session-retired-tail-'));
    const checkpointPath = join(dir, 'checkpoints.sqlite');
    const storePath = stateStorePathForTest(checkpointPath);
    const threadId = 'retired-session-tail';
    try {
      const state = createRuntimeHostStateInitialState({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId,
        userId: 'u',
        workspace: '/workspace',
      });
      const store = openStateStoreForTest(storePath);
      store.saveSnapshot(threadId, state);
      store.close();
      const database = new Database(storePath);
      database
        .query(
          'INSERT INTO runtime_events (session_id, event_id, sequence, schema_version, event_json, occurred_at, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())',
        )
        .run(
          threadId,
          'retired-tail',
          1,
          26,
          JSON.stringify({ type: 'tool.execution_ready', toolCallId: 'shell' }),
          '2026-08-15T00:00:00.000Z',
        );
      database.close();

      await expect(
        loadSession(
          () => openStateStoreForTest(stateStorePathForTest(checkpointPath)),
          threadId,
          '0'.repeat(64),
        ),
      ).rejects.toThrow('Runtime session retired-session-tail is unavailable: corrupted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── abortAll ──

  test('abortAll aborts all running sessions', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;
    const rt2 = mgr.getRuntime(id2)!;
    const ac1 = new AbortController();
    const ac2 = new AbortController();
    rt1.agentLoopActive = true;
    rt1.abortController = ac1;
    rt2.agentLoopActive = true;
    rt2.abortController = ac2;

    mgr.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(ac2.signal.aborted).toBe(true);
    expect(rt1.agentLoopActive).toBe(false);
    expect(rt2.agentLoopActive).toBe(false);
  });

  test('abortAll skips non-running sessions', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;
    const rt2 = mgr.getRuntime(id2)!;
    const ac1 = new AbortController();
    rt1.agentLoopActive = true;
    rt1.abortController = ac1;

    mgr.abortAll();

    expect(ac1.signal.aborted).toBe(true);
    expect(rt1.agentLoopActive).toBe(false);
    expect(rt2.agentLoopActive).toBe(false);
    expect(rt2.abortController).toBeNull();
  });

  // ── Misc ──

  test('snapshotCallback fires on status change', () => {
    const mgr = makeManager();
    const calls: string[] = [];
    mgr.setSnapshotCallback((threadId) => calls.push(threadId));
    const id = mgr.createSession('/tmp/ws');
    mgr.onStatusChange(id);
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(id);
  });

  test('getRuntime returns undefined for unknown threadId', () => {
    const mgr = makeManager();
    expect(mgr.getRuntime('nonexistent')).toBeUndefined();
  });

  test('setName updates runtime name', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    mgr.setName(id, 'New Name');
    const snapshots = mgr.getSnapshot();
    expect(snapshots[0]!.name).toBe('New Name');
  });

  test('hasRuntime checks runtime existence', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    expect(mgr.hasRuntime(id)).toBe(true);
    expect(mgr.hasRuntime('nonexistent')).toBe(false);
  });

  // ── registerSession does NOT set activeId (caller must call switchSession) ──

  test('registerSession does not change activeId', () => {
    const mgr = makeManager();
    const activeId = mgr.createSession('/tmp/ws');
    expect(mgr.getActiveId()).toBe(activeId);

    // registerSession adds a runtime but leaves activeId unchanged
    mgr.registerSession('ext-1', '/tmp/ws');
    expect(mgr.getActiveId()).toBe(activeId); // still the original session
  });

  // ── saveTokenStats ──

  test('saveTokenStats stores stats in memory cache', () => {
    const mgr = makeManager();
    const tid = mgr.createSession('/tmp/ws');
    mgr.saveTokenStats(
      tid,
      makeStatus({
        cacheHitTokens: 10,
        cacheMissTokens: 5,
        totalTokens: 15,
        cacheHitRate: 66.7,
      }),
    );

    const snapshots = mgr.getSnapshot();
    const snap = snapshots.find((s) => s.threadId === tid)!;
    expect(snap.status).toBeDefined();
    expect(snap.status.cacheHitTokens).toBe(10);
    expect(snap.status.totalTokens).toBe(15);
  });

  test('saveTokenStats with immediate=true persists to DB synchronously', () => {
    const mgr = makeManager();
    const tid = mgr.createSession('/tmp/ws');
    mgr.saveTokenStats(
      tid,
      makeStatus({
        cacheHitTokens: 100,
        cacheMissTokens: 200,
        totalTokens: 300,
        cacheHitRate: 33.3,
      }),
      true,
    );
    const snapshots = mgr.getSnapshot();
    const snap = snapshots.find((s) => s.threadId === tid)!;
    expect(snap.status.cacheHitTokens).toBe(100);
  });

  test('shares one journal mode between the long-lived stats connection and StateRuntimeStorage', () => {
    const root = mkdtempSync(join(process.cwd(), '.kite-session-journal-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const mgr = new SessionManager(makeDeps(checkpointPath));
    try {
      mgr.saveTokenStats(
        'dual-connection',
        makeStatus({ cacheHitTokens: 1, cacheMissTokens: 2, totalTokens: 3 }),
        true,
      );

      const store = openStateStoreForTest(stateStorePathForTest(checkpointPath));
      store.appendEvents('dual-connection', []);
      store.close();
    } finally {
      mgr.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('saveTokenStats skips DB write when all stats are zero', () => {
    const mgr = makeManager();
    const tid = mgr.createSession('/tmp/ws');
    mgr.saveTokenStats(
      tid,
      makeStatus({
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        totalTokens: 0,
        cacheHitRate: 0,
      }),
      true,
    );
    const snapshots = mgr.getSnapshot();
    const snap = snapshots.find((s) => s.threadId === tid)!;
    expect(snap.status.totalTokens).toBe(0);
  });

  // ── createSession does NOT automatically save stats ──

  test('createSession does not persist stats of outgoing session (caller must save)', () => {
    const mgr = makeManager();
    const oldId = mgr.createSession('/tmp/ws');
    // Simulate stats accumulation on old session
    mgr.saveTokenStats(
      oldId,
      makeStatus({
        cacheHitTokens: 50,
        cacheMissTokens: 25,
        totalTokens: 75,
        cacheHitRate: 66.7,
      }),
      true,
    );

    // Create new session — createSession does NOT internally call saveTokenStats
    const newId = mgr.createSession('/tmp/ws');

    // Old session's stats are still in the cache (we saved explicitly before)
    const oldStats = (mgr as unknown as ManagerWithTokenStatsCache).tokenStatsService.get(oldId)!;
    expect(oldStats).toBeDefined();
    expect(oldStats.totalTokens).toBe(75);

    // New session is active
    expect(mgr.getActiveId()).toBe(newId);
  });

  // ── removeRuntime does NOT save stats (caller must save first) ──

  test('removeRuntime does not persist stats (stats are lost if not saved beforehand)', () => {
    const mgr = makeManager();
    const id = mgr.createSession('/tmp/ws');
    mgr.saveTokenStats(
      id,
      makeStatus({
        cacheHitTokens: 88,
        cacheMissTokens: 22,
        totalTokens: 110,
        cacheHitRate: 80,
      }),
      true,
    );

    // Verify stats exist before removal
    expect((mgr as unknown as ManagerWithTokenStatsCache).tokenStatsService.has(id)).toBe(true);

    // removeRuntime clears the runtime but does NOT save stats
    mgr.removeRuntime(id);

    // Runtime is gone but stats cache entry still exists (lazy-loaded on next getSnapshot)
    // The caller is responsible for saving before removeRuntime
    expect(mgr.getRuntime(id)).toBeUndefined();
  });

  // ── Concurrent session creation guard (simulates double /new) ──

  test('rapid consecutive createSession calls produce unique active sessions', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');

    // Both sessions exist
    expect(mgr.hasRuntime(id1)).toBe(true);
    expect(mgr.hasRuntime(id2)).toBe(true);
    // Only the last one is active
    expect(mgr.getActiveId()).toBe(id2);
    // Snapshot reflects deactivation of id1
    const snapshots = mgr.getSnapshot();
    const snap1 = snapshots.find((s) => s.threadId === id1)!;
    const snap2 = snapshots.find((s) => s.threadId === id2)!;
    expect(snap1.active).toBe(false);
    expect(snap2.active).toBe(true);
  });
});

describe('TUI Runtime cancellation bridge', () => {
  function hostFixture(
    cancelReceipt: (
      command: Extract<RuntimeCommand, { type: 'cancel_turn' }>,
      attempt: number,
    ) => RuntimeCommandReceipt,
  ): {
    host: RuntimeHostCoordinatorPort;
    cancelCommands: Array<Extract<RuntimeCommand, { type: 'cancel_turn' }>>;
    firstCancel: Promise<void>;
  } {
    const cancelCommands: Array<Extract<RuntimeCommand, { type: 'cancel_turn' }>> = [];
    let observeFirstCancel!: () => void;
    const firstCancel = new Promise<void>((resolve) => {
      observeFirstCancel = resolve;
    });
    const host = {
      command: async (command: RuntimeCommand): Promise<RuntimeCommandReceipt> => {
        if (command.type === 'create_session') {
          return {
            status: 'applied',
            commandId: command.commandId,
            sessionId: command.bootstrapSessionId!,
            revision: 0,
          };
        }
        if (command.type === 'cancel_turn') {
          cancelCommands.push(command);
          if (cancelCommands.length === 1) observeFirstCancel();
          return cancelReceipt(command, cancelCommands.length);
        }
        throw new Error(`Unexpected Runtime command in cancellation fixture: ${command.type}`);
      },
      query: async () => ({
        status: 'rejected' as const,
        queryType: 'get_session_projection' as const,
        code: 'unsupported' as const,
      }),
      subscribe: () =>
        (async function* emptyNotifications() {
          yield* [];
        })(),
      cancelSession: async () => undefined,
      cancelAllSessions: async () => undefined,
      waitForSessionIdle: async () => undefined,
      isSessionOperationActive: () => false,
      removeSessionProjection: () => false,
      history: emptyRuntimeHistory(),
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies RuntimeHostCoordinatorPort & { readonly history: RuntimeHistoryClient };
    return { host, cancelCommands, firstCancel };
  }

  function clientWithHost(host: RuntimeHostCoordinatorPort) {
    return createTuiRuntimeClient(
      { ...makeDeps(), workspace: '/tmp/tui-cancel' },
      () => host,
      () => ({
        projectId: 'project_tui-cancel-test',
        revision: 0,
        workspaceDigest: `sha256:${'1'.repeat(64)}`,
      }),
    );
  }

  test('leaves lifecycle cancellation to Host and reconciles a revision-conflicted durable receipt', async () => {
    const fixture = hostFixture((command, attempt) =>
      attempt === 1
        ? {
            status: 'conflict',
            commandId: command.commandId,
            code: 'revision_conflict',
            currentRevision: 4,
          }
        : {
            status: 'applied',
            commandId: command.commandId,
            sessionId: command.sessionId,
            revision: 5,
          },
    );
    const manager = clientWithHost(fixture.host);
    const sessionId = manager.createSession('/tmp/tui-cancel');
    const runtime = manager.getRuntime(sessionId)!;
    const controller = new AbortController();
    (runtime as unknown as { abortController: AbortController | null }).abortController =
      controller;

    runtime.abort();

    // The Client submits only the durable command. This fake Host records the
    // request but intentionally has no lifecycle supervisor, so local Runtime
    // execution must remain untouched.
    expect(controller.signal.aborted).toBe(false);
    await fixture.firstCancel;
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.cancelCommands).toHaveLength(2);
    expect(fixture.cancelCommands.map((command) => command.expectedRevision)).toEqual([0, 4]);
    expect(fixture.cancelCommands[1]!.commandId).not.toBe(fixture.cancelCommands[0]!.commandId);
  });

  test('surfaces a durable cancellation rejection after the Runtime is stopped', async () => {
    const fixture = hostFixture((command) => ({
      status: 'rejected',
      commandId: command.commandId,
      code: 'invalid_command',
    }));
    const manager = clientWithHost(fixture.host);
    const sessionId = manager.createSession('/tmp/tui-cancel-rejected');
    const runtime = manager.getRuntime(sessionId)!;

    runtime.abort();

    await fixture.firstCancel;
    await Promise.resolve();
    await Promise.resolve();
    expect(runtime.eventBuffer).toContainEqual({
      type: 'run.failure',
      runId: 'runtime-run',
      code: 'runtime_error',
      retryable: false,
      recoveryEntry: 'new_run',
    });
  });

  function cleanupHostFixture(
    deps: SessionDeps = makeDeps(
      join(mkdtempSync(join(realpathSync(tmpdir()), 'kite-tui-cleanup-')), 'state.sqlite'),
    ),
  ) {
    let bridge!: RuntimeHostExecutionBridge;
    const coordinators = new Map<string, RuntimeSessionCoordinator>();
    deps.runtimeSessionCoordinator = {
      ensure: (identity) => {
        const existing = coordinators.get(identity.sessionId);
        if (existing) return existing;
        let revision = 0;
        const receipt = (evidence: {
          targetSessionId: string;
          commandId: string;
          scopeSessionId: string;
          requestDigest: string;
          committedAt: number;
        }) => ({
          ...evidence,
          committedRevision: revision,
          originalReceiptJson: JSON.stringify({
            status: 'applied',
            commandId: evidence.commandId,
            sessionId: evidence.targetSessionId,
            revision,
          }),
        });
        const coordinator = {
          sessionId: identity.sessionId,
          session: { commitCommandSnapshot: receipt },
          recoveryChanged: false,
          lifecycle: 'idle',
          control: {
            getState: () => ({ revision }),
            processEvent: () => undefined,
            processEventBatch: () => [],
            cancelRun: () => [],
          },
          getState: () => ({ revision }),
          getStateRuntimeStorage: () => {
            throw new Error('unused test coordinator storage');
          },
          isTurnActive: () => false,
          beginTurn: () => undefined,
          endTurn: () => undefined,
          updateInteractionMode: () => undefined,
          getInteractionModeState: () => ({
            interactionMode: 'accept_edits' as const,
            interactionModeRevision: 0,
          }),
          updateSandboxAvailable: () => undefined,
          getSandboxAvailable: () => undefined,
          setActiveCancelRun: () => undefined,
          clearActiveCancelRun: () => undefined,
          commitInteractionModeCommand: () => ({
            receipt: receipt({
              targetSessionId: identity.sessionId,
              commandId: 'unused',
              scopeSessionId: identity.sessionId,
              requestDigest: '0'.repeat(64),
              committedAt: 0,
            }),
            events: [],
          }),
          commitCancelTurnCommand: () => ({
            receipt: receipt({
              targetSessionId: identity.sessionId,
              commandId: 'unused',
              scopeSessionId: identity.sessionId,
              requestDigest: '0'.repeat(64),
              committedAt: 0,
            }),
            events: [],
          }),
          commitCloseSessionCommand: (
            _command: unknown,
            evidence: Parameters<RuntimeSessionCoordinator['commitCloseSessionCommand']>[1],
          ) => {
            if (operationActive) {
              manager
                .getRuntime(identity.sessionId)
                ?.authorizedExecutionControl?.cancelRun('Runtime session closed.');
              revision += 1;
            }
            return { receipt: receipt(evidence), events: [], wasActive: operationActive };
          },
          commitForkSessionCommand: () => {
            throw new Error('unused test coordinator fork');
          },
          commitStartTurnCommand: () => {
            throw new Error('unused test coordinator turn');
          },
          executeTurn: () => {
            throw new Error('unused test coordinator turn');
          },
          createRuntimeEffectPort: () => {
            throw new Error('unused test coordinator effects');
          },
          executePendingCompaction: async () => [],
          waitForIdle: async () => undefined,
          close: async () => undefined,
        } as unknown as RuntimeSessionCoordinator;
        coordinators.set(identity.sessionId, coordinator);
        return coordinator;
      },
      get: (sessionId) => coordinators.get(sessionId),
      release: async (sessionId) => {
        coordinators.delete(sessionId);
      },
      close: async () => undefined,
    };
    let operationActive = false;
    let rejectNextReadiness = false;
    const commands: RuntimeCommand[] = [];
    const receipts = new Map<string, RuntimeCommandReceipt>();
    const host = {
      command: async (command: RuntimeCommand): Promise<RuntimeCommandReceipt> => {
        commands.push(command);
        if (
          (command.type === 'create_session' || command.type === 'resume_session') &&
          rejectNextReadiness
        ) {
          rejectNextReadiness = false;
          throw new Error('readiness failed');
        }
        const targetSessionId =
          command.type === 'create_session'
            ? command.bootstrapSessionId!
            : command.type === 'fork_session'
              ? command.sourceSessionId
              : command.sessionId;
        const inspected = await bridge.inspectCommand(command, { targetSessionId });
        if (inspected.kind === 'terminal') {
          receipts.set(command.commandId, inspected.receipt);
          return inspected.receipt;
        }
        const committed = await inspected.decision.commit({
          scopeSessionId: targetSessionId,
          commandId: command.commandId,
          requestDigest: '0'.repeat(64),
          targetSessionId,
          committedAt: 0,
        });
        await committed.activation?.(() => undefined);
        receipts.set(command.commandId, committed.receipt);
        if (command.type === 'close_session') operationActive = false;
        return committed.receipt;
      },
      query: async (query: Parameters<RuntimeHostCoordinatorPort['query']>[0]) => ({
        status: 'rejected' as const,
        queryType: query.type,
        code: 'unsupported' as const,
      }),
      subscribe: () =>
        (async function* emptyNotifications() {
          yield* [];
        })(),
      cancelSession: async (sessionId: string, reason?: string) => {
        await bridge.shutdownSession(sessionId, reason ?? 'test cancellation', () => undefined);
        manager
          .getRuntime(sessionId)
          ?.authorizedExecutionControl?.cancelRun(reason ?? 'test cancellation');
        operationActive = false;
      },
      cancelAllSessions: async () => undefined,
      waitForSessionIdle: async () => undefined,
      isSessionOperationActive: () => operationActive,
      removeSessionProjection: () => false,
      history: emptyRuntimeHistory(),
      [Symbol.asyncDispose]: async () => undefined,
    } satisfies RuntimeHostCoordinatorPort & { readonly history: RuntimeHistoryClient };
    const manager = createTuiRuntimeClient(
      { ...deps, workspace: '/tmp/tui-cleanup' },
      (createdBridge) => {
        bridge = createdBridge;
        return host;
      },
      () => ({
        projectId: 'project_tui-cleanup-test',
        revision: 0,
        workspaceDigest: `sha256:${'2'.repeat(64)}`,
      }),
    );
    return {
      bridge,
      commands,
      host,
      manager,
      receipts,
      rejectNextReadiness: () => {
        rejectNextReadiness = true;
      },
      setOperationActive: (active: boolean) => {
        operationActive = active;
      },
      registerPersistedSession: (sessionId: string, workspace: string) => {
        const store = deps.openStateRuntimeStorage(sessionId);
        try {
          store.sessions.saveSnapshot(
            sessionId,
            createRuntimeHostStateInitialState({
              recoveryIdentityKey: createHash('sha256')
                .update(`tui-cleanup:${sessionId}`)
                .digest('hex'),
              threadId: sessionId,
              userId: 'tui-user',
              workspace,
              projectId: `project_${sessionId}`,
              canonicalWorkspaceDigest: `sha256:${createHash('sha256')
                .update(workspace)
                .digest('hex')}`,
            }),
          );
        } finally {
          store.close();
        }
        return manager.registerSession(sessionId, workspace);
      },
    };
  }

  function installCancellationCounter(runtime: SessionRuntime) {
    let calls = 0;
    runtime.authorizedExecutionControl = {
      getState: () => ({ context: { pendingCompaction: undefined } }) as unknown as RuntimeState,
      processEvent: () => undefined,
      processEventBatch: () => [],
      cancelRun: () => {
        calls += 1;
        return [];
      },
    };
    return () => calls;
  }

  test('admission-only target cleanup leaves the old active session and target revision/events untouched', async () => {
    const fixture = cleanupHostFixture();
    const oldId = fixture.manager.createSession('/tmp/old-active');
    const oldRuntime = fixture.manager.getRuntime(oldId)!;
    const oldCancelCalls = installCancellationCounter(oldRuntime);
    const targetId = 'historical-target-cleanup';
    const targetRuntime = fixture.registerPersistedSession(targetId, '/tmp/historical-target');
    const targetCancelCalls = installCancellationCounter(targetRuntime);

    await fixture.manager.removeRuntime(targetId);

    expect(fixture.manager.getActiveId()).toBe(oldId);
    expect(fixture.manager.getRuntime(oldId)).toBeDefined();
    expect(fixture.manager.getRuntime(targetId)).toBeUndefined();
    expect(oldCancelCalls()).toBe(0);
    expect(targetCancelCalls()).toBe(0);
    expect(targetRuntime.eventBuffer).toEqual([]);

    const admissionClose = fixture.commands.find(
      (command): command is Extract<RuntimeCommand, { type: 'close_session' }> =>
        command.type === 'close_session' && command.sessionId === targetId,
    );
    expect(admissionClose).toBeDefined();
    expect(fixture.receipts.get(admissionClose!.commandId)).toMatchObject({
      status: 'applied',
      revision: 0,
    });
    await expect(
      fixture.bridge.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' }),
    ).resolves.toMatchObject({
      status: 'ok',
      sessions: [expect.objectContaining({ sessionId: oldId, lifecycle: 'open', revision: 0 })],
    });
  });

  test('readiness rejection still removes the target and allows a later resume retry', async () => {
    const fixture = cleanupHostFixture();
    const sessionId = 'readiness-retry-target';
    fixture.rejectNextReadiness();
    fixture.registerPersistedSession(sessionId, '/tmp/readiness-retry');

    await expect(fixture.manager.removeRuntime(sessionId)).rejects.toThrow('readiness failed');

    expect(fixture.manager.getRuntime(sessionId)).toBeUndefined();
    expect(
      fixture.commands.filter(
        (command) => command.type === 'close_session' && command.sessionId === sessionId,
      ),
    ).toHaveLength(0);

    fixture.registerPersistedSession(sessionId, '/tmp/readiness-retry');
    await fixture.manager.removeRuntime(sessionId);
    expect(fixture.manager.getRuntime(sessionId)).toBeUndefined();
    expect(
      fixture.commands.filter(
        (command) => command.type === 'close_session' && command.sessionId === sessionId,
      ),
    ).toHaveLength(1);
  });

  test('release failure still removes the manager runtime and preserves the primary readiness error', async () => {
    const deps = makeDeps();
    const coordinatorAccess = installTestOnlyRuntimeTurnAdapter(
      deps,
      'release-failure-coordinator',
    );
    deps.runtimeSessionCoordinator = {
      ...coordinatorAccess,
      release: async () => {
        throw new Error('coordinator release failed');
      },
    };
    const fixture = cleanupHostFixture(deps);
    fixture.rejectNextReadiness();
    const sessionId = fixture.manager.createSession('/tmp/release-failure');

    await expect(fixture.manager.removeRuntime(sessionId)).rejects.toThrow('readiness failed');
    expect(fixture.manager.getRuntime(sessionId)).toBeUndefined();
  });

  test('an active operation is cancelled once across cancellation and final runtime cleanup', async () => {
    const fixture = cleanupHostFixture();
    const sessionId = 'active-target-cleanup';
    const runtime = fixture.registerPersistedSession(sessionId, '/tmp/active-target');
    const cancellationCalls = installCancellationCounter(runtime);
    fixture.setOperationActive(true);

    await fixture.manager.cancelRuntimeOperations(sessionId);
    await fixture.manager.removeRuntime(sessionId);

    expect(cancellationCalls()).toBe(1);
    expect(fixture.manager.getRuntime(sessionId)).toBeUndefined();
    const closeCommand = fixture.commands.find(
      (command): command is Extract<RuntimeCommand, { type: 'close_session' }> =>
        command.type === 'close_session' && command.sessionId === sessionId,
    );
    expect(closeCommand).toBeDefined();
    // This fixture exposes an owner-active operation without a client work
    // projection. The close remains the only receipt in that synthetic case.
    expect(fixture.receipts.get(closeCommand!.commandId)).toMatchObject({
      status: 'applied',
      revision: 1,
    });
  });

  test('direct cleanup of an active operation persists one canonical cancellation before draining', async () => {
    const fixture = cleanupHostFixture();
    const sessionId = 'direct-active-cleanup';
    const runtime = fixture.registerPersistedSession(sessionId, '/tmp/direct-active');
    const cancellationCalls = installCancellationCounter(runtime);
    fixture.setOperationActive(true);

    await fixture.manager.removeRuntime(sessionId);

    expect(cancellationCalls()).toBe(1);
    const closeCommand = fixture.commands.find(
      (command): command is Extract<RuntimeCommand, { type: 'close_session' }> =>
        command.type === 'close_session' && command.sessionId === sessionId,
    );
    expect(closeCommand).toBeDefined();
    expect(fixture.receipts.get(closeCommand!.commandId)).toMatchObject({
      status: 'applied',
      revision: 1,
    });
  });
});

// ── SessionRuntime ──

describe('SessionRuntime', () => {
  test('keeps an approved plan lifecycle orthogonal to the live interaction mode', () => {
    const rt = makeRuntime();

    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      {
        type: 'plan.approved',
        interactionId: 'review-1',
        toolCallId: 'plan-call',
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'sha256:plan-1',
        executionMode: 'auto',
      },
      () => {},
    );

    expect(rt.interactionMode).toBe('accept_edits');
  });

  test('persists an interaction-mode change to a live Kernel control', () => {
    const rt = makeRuntime();
    const kernel = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: rt.threadId,
      userId: 'tui',
      workspace: rt.workspace,
      store: openStateStoreForTest(':memory:'),
      sandboxAvailable: true,
    });
    try {
      rt.authorizedExecutionControl = {
        getState: () => kernel.getState(),
        processEvent: (event) => {
          kernel.processEvent(event);
        },
        processEventBatch: (events) => kernel.processEventBatch(events),
        cancelRun: () => [],
      };

      rt.setInteractionMode('full');

      expect(rt.interactionMode).toBe('full');
      expect(kernel.getState().mode).toBe('full');
      expect(kernel.getState()).not.toHaveProperty('authorization');
      expect(kernel.getState().interactionModeRevision).toBe(1);
    } finally {
      kernel.close();
    }
  });

  test('reconciles a restored Kernel mode before the next turn uses its governance state', () => {
    const kernel = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 'restored-mode-reconciliation',
      userId: 'tui',
      workspace: '/tmp/ws',
      store: openStateStoreForTest(':memory:'),
      interactionMode: 'accept_edits',
      sandboxAvailable: true,
    });
    const control = {
      getState: () => kernel.getState(),
      processEvent: (event: RuntimeEvent) => {
        kernel.processEvent(event);
      },
      processEventBatch: (events: RuntimeEvent[]) => kernel.processEventBatch(events),
      cancelRun: () => [],
    };
    try {
      const revision = kernel.getState().revision;

      expect(reconcileRuntimeInteractionMode(control, 'auto', '2026-08-24T00:00:00.000Z')).toBe(
        true,
      );
      expect(kernel.getState().mode).toBe('auto');
      expect(kernel.getState().revision).toBe(revision + 1);
      expect(reconcileRuntimeInteractionMode(control, 'auto', '2026-08-24T00:00:01.000Z')).toBe(
        false,
      );
      expect(kernel.getState().revision).toBe(revision + 1);
    } finally {
      kernel.close();
    }
  });

  test('does not advance retained identity when the durable mode event is rejected', () => {
    const rt = makeRuntime();
    let mirroredMode: SessionRuntime['interactionMode'] = 'accept_edits';
    const retainedControl = {
      getState: () => {
        throw new Error('unused');
      },
      processEvent: () => {
        throw new Error('mode persistence rejected');
      },
      processEventBatch: () => [],
      cancelRun: () => [],
    };
    (
      rt as unknown as {
        _runtimeSessionCoordinator: {
          get: () => {
            control: typeof retainedControl;
            updateInteractionMode: (mode: SessionRuntime['interactionMode']) => void;
          };
        };
      }
    )._runtimeSessionCoordinator = {
      get: () => ({
        control: retainedControl,
        updateInteractionMode: (mode) => {
          mirroredMode = mode;
        },
      }),
    };
    rt.authorizedExecutionControl = retainedControl;

    expect(() => rt.setInteractionMode('full')).toThrow('mode persistence rejected');
    expect(rt.interactionMode).toBe('accept_edits');
    expect(mirroredMode).toBe('accept_edits');
  });

  test('keeps a live Full mode change without a Full-qualified sandbox', () => {
    const rt = makeRuntime();
    const kernel = restoreStateKernelCoordinator({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: rt.threadId,
      userId: 'tui',
      workspace: rt.workspace,
      store: openStateStoreForTest(':memory:'),
      sandboxAvailable: false,
    });
    try {
      rt.authorizedExecutionControl = {
        getState: () => kernel.getState(),
        processEvent: (event) => {
          kernel.processEvent(event);
        },
        processEventBatch: (events) => kernel.processEventBatch(events),
        cancelRun: () => [],
      };

      expect(() => rt.setInteractionMode('full')).not.toThrow();
      expect(rt.interactionMode).toBe('full');
      expect(kernel.getState().mode).toBe('full');
      expect(kernel.getState()).not.toHaveProperty('authorization');
    } finally {
      kernel.close();
    }
  });

  test('serializes manual compaction operations for one session', async () => {
    const runtime = makeRuntime();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = runtime.runManualCompactionExclusive(async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = runtime.runManualCompactionExclusive(async () => {
      order.push('second:start');
      order.push('second:end');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  test('closing a session aborts the active compaction and rejects queued writers', async () => {
    const runtime = makeRuntime();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let queuedRan = false;
    const first = runtime.runManualCompactionExclusive(async (signal) => {
      markStarted();
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
    });
    const queued = runtime.runManualCompactionExclusive(async () => {
      queuedRan = true;
    });
    const queuedResult = queued.then(
      () => undefined,
      (error: unknown) => error,
    );

    await started;
    await runtime.cancelManualCompaction(true);
    await first;

    const error = await queuedResult;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
    expect(queuedRan).toBe(false);
  });

  test('suppresses the stale cancellation mismatch from user-visible runtime events', () => {
    expect(
      isSilentCancellationMismatch({
        type: 'run.error',
        message: 'Runtime action does not match the active interaction.',
        recoverable: false,
      }),
    ).toBe(true);
    expect(
      isSilentCancellationMismatch({
        type: 'run.error',
        message: 'network failed',
        recoverable: true,
      }),
    ).toBe(false);
  });

  test.each([
    'request_user_input',
    'request_tool_approval',
    'request_plan_review',
  ] as const)('binds a raw UI cancel to the active %s interaction id', async (effectType) => {
    const rt = makeRuntime();
    let state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't1',
      userId: 'u',
      workspace: '/tmp/ws',
    });
    const interactionId = `${effectType}-interaction`;
    const toolCallId = `${effectType}-tool`;

    if (effectType === 'request_user_input') {
      state.interactions = {
        kind: 'awaiting_user_input',
        interactionId,
        toolCallId,
        request: { question: 'q', options: [], allow_free_text: true },
      };
    } else if (effectType === 'request_tool_approval') {
      state.interactions = {
        kind: 'awaiting_tool_approval',
        interactionId,
        toolCallId,
        approval: {
          scope: 'once',
          cwd: '/tmp/ws',
          threadId: 't1',
          tool: 'shell_execute',
          command: 'pwd',
          risk: 'execute_code',
          approvalHash: 'hash',
          summary: 'Run pwd',
          reason: 'test',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      };
    } else {
      state.interactions = {
        kind: 'awaiting_review',
        interactionId,
        toolCallId,
        planId: 'plan-1',
        version: 1,
        structuralDigest: 'digest',
        plan: { name: 'Plan', description: '', status: 'pending', steps: [] },
        planSummary: 'Plan',
      };
    }

    if (effectType === 'request_tool_approval') {
      state = reduceRuntimeState(state, {
        type: 'approval.requested',
        interactionId,
        toolCallId,
        fullModeBypassEligible: false,
        fullModePolicyBypassAllowed: false,
        approval:
          state.interactions.kind === 'awaiting_tool_approval'
            ? state.interactions.approval
            : {
                scope: 'once',
                cwd: '/tmp/ws',
                threadId: 't1',
                tool: 'shell_execute',
                command: 'pwd',
                risk: 'execute_code',
                approvalHash: 'hash',
                summary: 'Run pwd',
                reason: 'test',
                expectedEffects: [],
                grantOptions: ['approve_once'],
                recommendedGrant: 'approve_once',
              },
      });
    }

    const actionPromise = (rt as unknown as RuntimeWithRuntimeAction)._requestRuntimeAction(
      { type: effectType, interactionId, toolCallId },
      state,
    );
    rt.resolveInterrupt({ type: 'cancel', interactionId });

    await expect(actionPromise).resolves.toEqual({
      type: 'cancel',
      interactionId,
    });
  });

  test('maps the verification decision prompt to an explicit user waiver', async () => {
    const rt = makeRuntime();
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't1',
      userId: 'u',
      workspace: '/tmp/ws',
    });
    state.verification.records.verification = {
      verificationId: 'verification',
      mode: 'required',
      status: 'budget_exhausted',
      spec: {
        schemaVersion: 1,
        verificationId: 'verification',
        subject: 'release result',
        checks: [
          {
            checkId: 'receipt',
            type: 'receipt',
            description: 'check release receipt',
            invocationId: 'release-invocation',
          },
        ],
        repair: { maxAttempts: 0 },
      },
      requestedAt: '2026-07-15T00:00:00.000Z',
      attempts: 1,
      repairAttempts: 0,
      checkResults: {},
    };
    const actionPromise = (rt as unknown as RuntimeWithRuntimeAction)._requestRuntimeAction(
      {
        type: 'request_verification_decision',
        interactionId: 'verification',
        verificationId: 'verification',
      },
      state,
    );
    rt.resolveInterrupt({
      type: 'input',
      interactionId: 'verification',
      text: 'waive: accepted by user',
    });
    expect(await actionPromise).toEqual({
      type: 'waive_verification',
      verificationId: 'verification',
      reason: 'accepted by user',
    });
  });

  test('runs an MCP provider recovery action and returns the refreshed directory revision', async () => {
    const rt = makeRuntime();
    rt.mcpRecoveryController = {
      recover: async () => ({
        outcome: 'completed',
        providerDirectoryRevision: 'directory-r2',
        providerStatus: 'ready',
      }),
    };
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't1',
      userId: 'u',
      workspace: '/tmp/ws',
    });
    const actionPromise = (rt as unknown as RuntimeWithRuntimeAction)._requestRuntimeAction(
      {
        type: 'request_provider_action',
        interactionId: 'provider-action',
        providerId: 'github',
        action: 'login',
        originatingToolCallId: 'mcp-call',
      },
      state,
    );
    rt.resolveInterrupt({ type: 'input', interactionId: 'provider-action', text: 'Run login' });
    await expect(actionPromise).resolves.toEqual({
      type: 'provider_action_result',
      interactionId: 'provider-action',
      outcome: 'completed',
      providerDirectoryRevision: 'directory-r2',
    });
  });

  test('maps required-provider Session Waive without calling the recovery controller', async () => {
    const rt = makeRuntime();
    let recovered = false;
    rt.mcpRecoveryController = {
      recover: async () => {
        recovered = true;
        return {
          outcome: 'failed',
          providerDirectoryRevision: 'directory-r1',
          providerStatus: 'login_required',
        };
      },
    };
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: 't1',
      userId: 'u',
      workspace: '/tmp/ws',
    });
    const actionPromise = (rt as unknown as RuntimeWithRuntimeAction)._requestRuntimeAction(
      {
        type: 'request_provider_admission',
        interactionId: 'provider-admission',
        providerId: 'github',
        providerStatus: 'login_required',
        retryable: false,
      },
      state,
    );
    rt.resolveInterrupt({
      type: 'input',
      interactionId: 'provider-admission',
      text: 'Session Waive',
    });
    await expect(actionPromise).resolves.toEqual({
      type: 'provider_admission_decision',
      interactionId: 'provider-admission',
      decision: { kind: 'waive' },
    });
    expect(recovered).toBe(false);
  });

  // ── abort ──

  test('claims one run while sandbox preparation is pending', async () => {
    const deferred = createDeferredShellExecutor();
    const deps = makeDeps();
    deps.shellExecutor = deferred.executor;
    const rt = new SessionRuntime('prepare-single-flight', '/tmp/ws', deps);
    const actions: Action[] = [];
    const runDeps = {
      dispatch: (action: Action) => actions.push(action),
      provider: deps.provider,
      config: deps.config,
    };

    const first = rt.runTask('first task', runDeps);
    expect(rt.agentLoopActive).toBe(true);
    expect(rt.abortController).not.toBeNull();
    expect(deferred.prepareCalls()).toBe(1);

    let secondSettled = false;
    const second = rt.runTask('second task', runDeps).then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(true);
    expect(deferred.prepareCalls()).toBe(1);
    expect(deferred.executionCalls()).toBe(0);

    rt.abort();
    deferred.resolvePreparation({
      mode: 'sandbox',
      backend: 'seatbelt',
    });
    await Promise.all([first, second]);
    expect(rt.agentLoopActive).toBe(false);
    expect(Reflect.get(rt, '_runCompletion')).toBeNull();
  });

  test('abort during sandbox preparation prevents the agent from starting', async () => {
    const deferred = createDeferredShellExecutor();
    const deps = makeDeps();
    deps.shellExecutor = deferred.executor;
    const rt = new SessionRuntime('prepare-abort', '/tmp/ws', deps);
    const actions: Action[] = [];
    let modelTouched = false;
    const model = new Proxy(
      {},
      {
        get() {
          modelTouched = true;
          throw new Error('agent must not inspect the model after prepare was aborted');
        },
      },
    ) as import('@kite-ai/builtin-runtime/model').SupportedChatModel;

    const run = rt.runTask('must not start', {
      dispatch: (action) => actions.push(action),
      provider: deps.provider,
      config: deps.config,
      model,
    });
    const controller = rt.abortController!;
    expect(controller.signal.aborted).toBe(false);
    expect(rt.agentLoopActive).toBe(true);

    rt.abort();
    expect(controller.signal.aborted).toBe(true);
    deferred.resolvePreparation({
      mode: 'sandbox',
      backend: 'seatbelt',
    });
    await run;

    expect(modelTouched).toBe(false);
    expect(actions).toEqual([]);
    expect(deferred.executionCalls()).toBe(0);
    expect(rt.generator).toBeNull();
    expect(rt.agentLoopActive).toBe(false);
    expect(Reflect.get(rt, '_runCompletion')).toBeNull();
  });

  test('abort during sandbox preparation cancels the executor preflight', async () => {
    let rejectPreparation!: (error: Error) => void;
    const preparation = new Promise<AppShellRuntimeDecision>((_resolve, reject) => {
      rejectPreparation = reject;
    });
    let abortPreparationCalls = 0;
    const executor = (async (input: Parameters<AppShellExecutor>[0]) => ({
      ok: false,
      command: input.command,
      exitCode: -1,
      stdout: '',
      stderr: 'unexpected shell execution',
    })) as AppShellExecutor;
    executor.prepare = () => preparation;
    executor.abortPreparation = () => {
      abortPreparationCalls += 1;
      rejectPreparation(new Error('sandbox_preparation_aborted'));
    };
    const deps = makeDeps();
    deps.shellExecutor = executor;
    const rt = new SessionRuntime('prepare-preflight-abort', '/tmp/ws', deps);

    const run = rt.runTask('must stop preparing', {
      dispatch: () => {},
      provider: deps.provider,
      config: deps.config,
    });
    rt.abort();
    await run;

    expect(abortPreparationCalls).toBe(1);
    expect(rt.agentLoopActive).toBe(false);
    expect(Reflect.get(rt, '_runCompletion')).toBeNull();
  });

  test('abort resolves pending interrupt and signals AbortController', () => {
    const deps = makeDeps();
    deps.runtimeSessionCoordinator = {
      get: () => ({
        getState: () => ({
          activeApprovalId: 'abort-interaction',
          pendingApprovals: new Map([['abort-interaction', { generation: 0 }]]),
        }),
      }),
    } as unknown as RuntimeSessionCoordinatorAccess;
    const rt = new SessionRuntime('abort-interaction', '/tmp/ws', deps);
    const ac = new AbortController();
    rt.agentLoopActive = true;
    rt.abortController = ac;

    let resolved = false;
    (rt as unknown as RuntimeWithPendingResolve)._pendingResolve = {
      interactionId: 'abort-interaction',
      generation: 0,
      resolve: () => {
        resolved = true;
      },
    };

    rt.abort();

    expect(ac.signal.aborted).toBe(true);
    expect(rt.agentLoopActive).toBe(false);
    expect(rt.abortController).toBeNull();
    expect(rt.generator).toBeNull();
    expect(resolved).toBe(true);
  });

  test('abort persists and projects cancellation facts before signalling the controller', () => {
    const rt = makeRuntime();
    const ac = new AbortController();
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
      threadId: rt.threadId,
      userId: 'tui',
      workspace: rt.workspace,
    });
    const order: string[] = [];
    const projected: string[] = [];
    rt.agentLoopActive = true;
    rt.abortController = ac;
    rt.authorizedExecutionControl = {
      getState: () => state,
      processEvent: () => {},
      processEventBatch: (events) => events,
      cancelRun: () => {
        order.push(ac.signal.aborted ? 'signal-first' : 'persist-first');
        return [
          {
            type: 'tool.cancelled',
            toolCallId: 'shell-1',
            reason: 'Cancelled by user.',
          },
          {
            type: 'turn.aborted',
            turnId: state.turn.turnId,
            reason: 'Cancelled by user.',
            cause: 'user',
          },
        ];
      },
    };
    Reflect.set(rt, '_activeDispatch', (action: Action) => {
      if (action.type === 'RUNTIME_EVENT') projected.push(action.event.type);
    });

    rt.abort();

    expect(order).toEqual(['persist-first']);
    expect(projected).toEqual(['tool.cancelled', 'turn.terminal']);
    expect(ac.signal.aborted).toBe(true);
  });

  test('abort wakes foregroundWake promise', () => {
    const rt = makeRuntime();
    let woken = false;
    (rt as unknown as { _foregroundWake: () => void })._foregroundWake = () => {
      woken = true;
    };

    rt.abort();

    expect(woken).toBe(true);
    expect((rt as unknown as { _foregroundWake: () => void })._foregroundWake).toBeNull();
  });

  test('abort is safe to call when no AbortController', () => {
    const rt = makeRuntime();
    rt.abort();
    expect(rt.agentLoopActive).toBe(false);
  });

  test('abort is safe to call twice', () => {
    const rt = makeRuntime();
    const ac = new AbortController();
    rt.abortController = ac;
    rt.agentLoopActive = true;

    rt.abort();
    // Second call should be safe
    rt.abort();

    expect(rt.agentLoopActive).toBe(false);
  });

  test('runs a successor prompt after cancelling an in-flight shell turn', async () => {
    const home = mkdtempSync(join(process.cwd(), '.kite-session-successor-home-'));
    const workspace = mkdtempSync(join(process.cwd(), '.kite-session-successor-workspace-'));
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = home;
    const model = createMockModel([
      {
        message: aiMessage({
          content: '好的，继续测试网络请求',
          tool_calls: [
            {
              id: 'cancel-shell',
              name: 'shell_execute',
              args: { command: 'pwd' },
            },
          ],
        }),
      },
      { message: aiMessage({ content: '继续测试已完成。' }) },
    ]);
    let reportShellStarted!: () => void;
    const shellStarted = new Promise<void>((resolve) => {
      reportShellStarted = resolve;
    });
    const shellExecutor = (async (input: Parameters<AppShellExecutor>[0]) => {
      reportShellStarted();
      await new Promise<void>((resolve) => {
        const finish = () => resolve();
        if (input.signal?.aborted) finish();
        else input.signal?.addEventListener('abort', finish, { once: true });
      });
      return {
        ok: false,
        command: input.command,
        exitCode: 130,
        stdout: '',
        stderr: 'cancelled',
      };
    }) as AppShellExecutor;
    Object.defineProperty(shellExecutor, APP_PREPARED_SHELL_EXECUTION_, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Object.freeze({
        execute: async (input: BuiltinPreparedShellExecutionInput) =>
          projectAppHostShellResult(
            await shellExecutor({
              workspace: input.workspace,
              command: input.command,
              ...(input.signal ? { signal: input.signal } : {}),
              ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
              ...(input.onProgress ? { onProgress: input.onProgress } : {}),
              ...(input.networkMode ? { networkMode: input.networkMode } : {}),
              ...(input.filesystemMode ? { filesystemMode: input.filesystemMode } : {}),
              ...(input.executionTrust ? { executionTrust: input.executionTrust } : {}),
              sandboxInvocationIdentity: input.identity,
            }),
          ),
      }),
    });
    shellExecutor.prepare = async () => ({
      mode: 'sandbox',
      backend: 'seatbelt',
    });
    const deps: SessionDeps = {
      ...makeDeps(),
      config: {
        apiKey: 'test',
        baseURL: 'http://localhost:1',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible' as const,
        interactionMode: 'full' as const,
        sandbox: { enabled: true },
      },
      provider: new TuiUserInputProvider(),
      shellExecutor,
      modelInvocationRuntimeFactory: (runtimeWorkspace) => ({
        ...testModelInvocationRuntime(runtimeWorkspace),
        sandboxPreparationArtifacts: new SandboxPreparationArtifactStore({
          root: join(runtimeWorkspace, '.kite-test', 'sandbox-preparations'),
        }),
      }),
    };
    deps.runtimeSessionCoordinator = installTestOnlyRuntimeTurnAdapter(deps, 'session-successor');
    const rt = new SessionRuntime('session-successor', workspace, deps);
    const actions: Action[] = [];
    const runDeps = {
      dispatch: (action: Action) => actions.push(action),
      provider: deps.provider,
      config: deps.config,
      model: model as any,
    };

    try {
      const first = rt.runTask('先运行一个 shell', runDeps);
      const startup = await Promise.race([
        shellStarted.then(() => 'shell_started' as const),
        first.then(() => 'run_finished' as const),
      ]);
      if (startup === 'run_finished') {
        const error = actions.find(
          (action) =>
            action.type === 'RUNTIME_EVENT' &&
            action.event.type === 'run.terminal' &&
            action.event.status === 'failed',
        );
        throw new Error(`Successor fixture ended before shell start: ${JSON.stringify(error)}`);
      }
      rt.abort();
      const successor = rt.runTask('继续测试', runDeps);
      await Promise.all([first, successor]);
      expect(model.callCount.count).toBe(2);
      expect(actions.filter((action) => action.type === 'SET_EXITED')).toHaveLength(1);
      expect(actions).toContainEqual(
        expect.objectContaining({
          type: 'RUNTIME_EVENT',
          event: expect.objectContaining({
            type: 'model.responded',
          }),
        }),
      );
      expect(rt.agentLoopActive).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 30_000);
  test('waits for the TUI presentation flush before routing text after reasoning', async () => {
    const home = mkdtempSync(join(process.cwd(), '.kite-session-presentation-home-'));
    const workspace = mkdtempSync(join(process.cwd(), '.kite-session-presentation-workspace-'));
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = home;

    let reportFlushStarted!: () => void;
    const flushStarted = new Promise<void>((resolve) => {
      reportFlushStarted = resolve;
    });
    let releaseFlush!: () => void;
    const flushReleased = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const eventOrder: string[] = [];

    const streamingModel = {
      specificationVersion: 'v4' as const,
      provider: 'mock',
      modelId: 'presentation-boundary',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('presentation-boundary fixture requires streaming');
      },
      async doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'reasoning-start',
                id: 'reasoning-1',
              });
              controller.enqueue({
                type: 'reasoning-delta',
                id: 'reasoning-1',
                delta: 'Checking lifecycle.',
              });
              controller.enqueue({ type: 'reasoning-end', id: 'reasoning-1' });
              controller.enqueue({ type: 'text-start', id: 'text-1' });
              controller.enqueue({
                type: 'text-delta',
                id: 'text-1',
                delta: 'Final answer.',
              });
              controller.enqueue({ type: 'text-end', id: 'text-1' });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                  inputTokens: { total: 1, noCache: 1 },
                  outputTokens: { total: 1 },
                  totalTokens: 2,
                },
              });
              controller.close();
            },
          }),
        };
      },
    };
    const model = {
      model: streamingModel,
      capabilityMetadata: { streaming: true },
    } as import('@kite-ai/builtin-runtime/model').SupportedChatModel;
    const deps: SessionDeps = {
      ...makeDeps(),
      config: {
        apiKey: 'test',
        baseURL: 'http://localhost:1',
        modelName: 'test',
        providerName: 'test',
        providerType: 'openai-compatible' as const,
        interactionMode: 'auto' as const,
        sandbox: { enabled: false },
      },
      provider: new TuiUserInputProvider(),
      flushPresentation: async () => {
        eventOrder.push('flush-started');
        reportFlushStarted();
        await flushReleased;
        eventOrder.push('flush-finished');
      },
    };
    deps.runtimeSessionCoordinator = installTestOnlyRuntimeTurnAdapter(
      deps,
      'presentation-boundary',
    );
    const rt = new SessionRuntime('presentation-boundary', workspace, deps);
    const actions: Action[] = [];

    try {
      const run = rt.runTask('answer quickly', {
        dispatch: (action) => {
          actions.push(action);
          if (action.type === 'RUNTIME_EVENT') eventOrder.push(action.event.type);
        },
        provider: deps.provider,
        config: deps.config,
        model,
      });

      const startup = await Promise.race([
        flushStarted.then(() => 'flush_started' as const),
        run.then(() => 'run_finished' as const),
      ]);
      if (startup === 'run_finished') {
        const error = actions.find(
          (action) =>
            action.type === 'RUNTIME_EVENT' &&
            action.event.type === 'run.terminal' &&
            action.event.status === 'failed',
        );
        throw new Error(`Presentation fixture ended before flush: ${JSON.stringify(error)}`);
      }
      expect(eventOrder).not.toContain('model.reasoning_completed');
      expect(eventOrder).not.toContain('model.text_delta');
      expect(eventOrder).not.toContain('model.responded');

      releaseFlush();
      await run;

      expect(eventOrder.indexOf('flush-finished')).toBeLessThan(
        eventOrder.indexOf('model.text_delta'),
      );
      expect(eventOrder).toContain('model.responded');
    } finally {
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 15_000);
  test('accepts one successor prompt while cancelled cleanup is still unwinding', () => {
    const rt = makeRuntime();
    const ac = new AbortController();
    rt.agentLoopActive = true;
    rt.abortController = ac;
    Reflect.set(rt, '_runCompletion', new Promise<void>(() => {}));

    rt.abort();

    expect(rt.tryReservePrompt()).toBe(true);
    expect(rt.tryReservePrompt()).toBe(false);
    expect(rt.agentLoopActive).toBe(false);
  });

  test('a successor run waits until the aborted generator finishes cleanup', async () => {
    const rt = makeRuntime();
    const ac = new AbortController();
    let releasePreviousRun!: () => void;
    const previousRun = new Promise<void>((resolve) => {
      releasePreviousRun = resolve;
    });
    rt.agentLoopActive = true;
    rt.abortController = ac;
    Reflect.set(rt, '_runCompletion', previousRun);

    rt.abort();
    expect(rt.agentLoopActive).toBe(false);

    const actions: Action[] = [];
    const successor = rt.runTask('next task', {
      dispatch: (action) => actions.push(action),
      provider: makeDeps().provider,
      config: makeDeps().config,
    });
    await Promise.resolve();
    expect(actions).toEqual([]);

    // Simulate a competing waiter claiming the session as soon as cleanup
    // completes. This waiter must return instead of opening a second loop.
    rt.agentLoopActive = true;
    releasePreviousRun();
    await successor;
    expect(actions).toEqual([]);
  });

  // ── setForeground ──

  test('setForeground(true) wakes foregroundWake promise', () => {
    const rt = makeRuntime();
    let woken = false;
    (rt as unknown as { _foregroundWake: () => void })._foregroundWake = () => {
      woken = true;
    };
    (rt as unknown as { _foreground: boolean })._foreground = false;

    rt.setForeground(true);

    expect(woken).toBe(true);
    expect((rt as unknown as { _foregroundWake: () => void })._foregroundWake).toBeNull();
    expect((rt as unknown as { _foreground: boolean })._foreground).toBe(true);
  });

  test('setForeground(false) only changes flag', () => {
    const rt = makeRuntime();
    (rt as unknown as { _foreground: boolean })._foreground = true;
    rt.setForeground(false);
    expect((rt as unknown as { _foreground: boolean })._foreground).toBe(false);
  });

  // ── clearBuffer ──

  test('clearBuffer empties event buffer, history, and interrupt flag', () => {
    const rt = makeRuntime();
    rt.eventBuffer.push({
      type: 'model.responded',
      requestId: 'm1',
      messageId: 'm1',
      toolCallCount: 0,
      summary: 'hello',
    });
    rt.conversationHistory = ['cmd1', 'cmd2'];
    rt.pendingInterrupt = true;

    rt.clearBuffer();

    expect(rt.eventBuffer.length).toBe(0);
    expect(rt.conversationHistory.length).toBe(0);
    expect(rt.pendingInterrupt).toBe(false);
  });

  // ── resolveInterrupt ──

  test('resolveInterrupt resolves the pending promise with action', () => {
    const rt = makeRuntime();
    let resolvedAction: unknown = null;
    (rt as unknown as RuntimeWithPendingResolve)._pendingResolve = {
      interactionId: 'pending-approval',
      generation: 0,
      resolve: (action) => {
        resolvedAction = action;
      },
    };

    rt.resolveInterrupt({
      type: 'approve',
      interactionId: 'pending-approval',
      generation: 0,
      grant: 'approve_once',
    });

    expect(resolvedAction).toEqual({
      type: 'approve',
      interactionId: 'pending-approval',
      generation: 0,
      grant: 'approve_once',
    });
    expect((rt as unknown as RuntimeWithPendingResolve)._pendingResolve).toBeNull();
  });

  test('resolveInterrupt is no-op when no pending resolve or durable interaction', () => {
    const rt = makeRuntime();
    // should not throw
    rt.resolveInterrupt({ type: 'cancel', interactionId: 'no-active-interaction' });
  });

  test('queues an early UI decision until the Runtime interaction waiter attaches', async () => {
    const deps = makeDeps();
    deps.runtimeSessionCoordinator = {
      get: () => ({
        getState: () => ({
          activeApprovalId: 'approval-race-1',
          pendingApprovals: new Map([['approval-race-1', { generation: 0 }]]),
          interactions: {
            kind: 'awaiting_tool_approval',
            interactionId: 'approval-race-1',
          },
        }),
      }),
    } as unknown as RuntimeSessionCoordinatorAccess;
    const rt = new SessionRuntime('approval-race', '/tmp/ws', deps);
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;

    rt.resolveInterrupt({
      type: 'approve',
      interactionId: 'approval-race-1',
      generation: 0,
      grant: 'approve_once',
    });

    await expect(
      proxy.requestAction({
        kind: 'approval',
        interactionId: 'approval-race-1',
        generation: 0,
        approval: {},
      }),
    ).resolves.toEqual({
      type: 'approve',
      interactionId: 'approval-race-1',
      generation: 0,
      grant: 'approve_once',
    });
  });

  test('queues an early Escape cancellation until the Runtime interaction waiter attaches', async () => {
    const deps = makeDeps();
    deps.runtimeSessionCoordinator = {
      get: () => ({
        getState: () => ({
          activeApprovalId: 'approval-race-escape',
          pendingApprovals: new Map([['approval-race-escape', { generation: 0 }]]),
          interactions: {
            kind: 'awaiting_tool_approval',
            interactionId: 'approval-race-escape',
          },
        }),
      }),
    } as unknown as RuntimeSessionCoordinatorAccess;
    const rt = new SessionRuntime('approval-race-escape', '/tmp/ws', deps);
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;

    rt.resolveInterrupt({ type: 'cancel', interactionId: 'approval-race-escape' });

    await expect(
      proxy.requestAction({
        kind: 'approval',
        interactionId: 'approval-race-escape',
        generation: 0,
        approval: {},
      }),
    ).resolves.toEqual({ type: 'cancel', interactionId: 'approval-race-escape' });
  });

  test('does not carry an early UI decision into a different Runtime interaction', async () => {
    const deps = makeDeps();
    let interactionId = 'approval-race-1';
    deps.runtimeSessionCoordinator = {
      get: () => ({
        getState: () => ({
          activeApprovalId: interactionId,
          pendingApprovals: new Map([[interactionId, { generation: 0 }]]),
          interactions: {
            kind: 'awaiting_tool_approval',
            interactionId,
          },
        }),
      }),
    } as unknown as RuntimeSessionCoordinatorAccess;
    const rt = new SessionRuntime('approval-race', '/tmp/ws', deps);
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;

    rt.resolveInterrupt({ type: 'cancel', interactionId: 'approval-race-1' });
    interactionId = 'approval-race-2';
    const waiting = proxy.requestAction({
      kind: 'approval',
      interactionId: 'approval-race-2',
      generation: 0,
      approval: {},
    });
    await Bun.sleep(0);
    rt.resolveInterrupt({
      type: 'approve',
      interactionId: 'approval-race-2',
      generation: 0,
      grant: 'approve_once',
    });

    await expect(waiting).resolves.toEqual({
      type: 'approve',
      interactionId: 'approval-race-2',
      generation: 0,
      grant: 'approve_once',
    });
  });

  // ── _pushToBuffer (via private access) ──

  test('pushToBuffer adds event to buffer', () => {
    const rt = makeRuntime();
    (rt as unknown as RuntimeWithPushToBuffer)._pushToBuffer({
      type: 'model.responded',
      messageId: 'm1',
      text: 'hello',
    });
    expect(rt.eventBuffer.length).toBe(1);
  });

  test('pushToBuffer drops incoming progress when the soft limit contains only durable events', () => {
    const rt = makeRuntime();
    const MAX = (SessionRuntime as unknown as { MAX_BUFFER: number }).MAX_BUFFER;
    for (let i = 0; i < MAX; i++) {
      rt.eventBuffer.push({
        type: 'model.responded',
        requestId: `m${i}`,
        messageId: `m${i}`,
        toolCallCount: 0,
        summary: `msg${i}`,
      });
    }
    (rt as unknown as RuntimeWithPushToBuffer)._pushToBuffer({
      type: 'tool.progress',
      toolCallId: 'overflow',
      chunk: 'disposable',
      stream: 'stdout',
    });

    expect(rt.eventBuffer.length).toBe(MAX);
    expect(rt.eventBuffer.some((event) => event.type === 'tool.progress')).toBe(false);
  });

  test('pushToBuffer evicts buffered progress before admitting a terminal event', () => {
    const rt = makeRuntime();
    const MAX = (SessionRuntime as any).MAX_BUFFER;
    rt.eventBuffer.push({
      type: 'tool.progress',
      toolId: 'shell-old',
      summary: 'Tool output updated.',
      stream: 'stdout',
    });
    for (let i = 1; i < MAX; i++) {
      rt.eventBuffer.push({
        type: 'model.responded',
        requestId: `m${i}`,
        messageId: `m${i}`,
        toolCallCount: 0,
      });
    }
    (rt as any)._pushToBuffer({
      type: 'tool.finished',
      toolCallId: 'shell-new',
      name: 'shell_execute',
      result: {
        ok: true,
        command: 'echo',
        exitCode: 0,
        stdout: '',
        stderr: '',
      },
    });

    expect(rt.eventBuffer.length).toBe(MAX);
    expect(rt.eventBuffer.some((event) => event.type === 'tool.progress')).toBe(false);
    expect(
      rt.eventBuffer.some(
        (event) => event.type === 'tool.finished' && event.toolId === 'shell-new',
      ),
    ).toBe(true);
  });

  test('pushToBuffer preserves durable events when the soft limit has no disposable entries', () => {
    const rt = makeRuntime();
    const MAX = (SessionRuntime as unknown as { MAX_BUFFER: number }).MAX_BUFFER;
    // Fill buffer with non-disposable events (tool_call, tool_done are not in DISPOSABLE_EVENT_TYPES)
    for (let i = 0; i < MAX; i++) {
      rt.eventBuffer.push({
        type: 'tool.finished',
        toolId: `c${i}`,
        presentation: 'exploration',
        result: { ok: true, exitCode: 0, stdout: '', stderr: '' },
        summary: 'Tool finished.',
      });
    }
    (rt as unknown as RuntimeWithPushToBuffer)._pushToBuffer({
      type: 'tool.finished',
      toolCallId: 'c_new',
      name: 'read_file',
      result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
    });
    expect(rt.eventBuffer.length).toBe(MAX + 1);
    expect(rt.eventBuffer[0]?.type).toBe('tool.finished');
    expect(
      rt.eventBuffer.some((event) => event.type === 'tool.finished' && event.toolId === 'c_new'),
    ).toBe(true);
  });

  test('coalesces cumulative model deltas to the latest value per frame', async () => {
    const rt = makeRuntime();
    const actions: unknown[] = [];
    const dispatch = (action: unknown) => actions.push(action);

    (
      rt as unknown as {
        _routeRuntimeEvent: (event: unknown, dispatch: (action: unknown) => void) => void;
      }
    )._routeRuntimeEvent(
      { type: 'model.text_delta', requestId: 'request-coalesced', text: 'a' },
      dispatch,
    );
    (
      rt as unknown as {
        _routeRuntimeEvent: (event: unknown, dispatch: (action: unknown) => void) => void;
      }
    )._routeRuntimeEvent(
      { type: 'model.text_delta', requestId: 'request-coalesced', text: 'answer' },
      dispatch,
    );
    (
      rt as unknown as {
        _routeRuntimeEvent: (event: unknown, dispatch: (action: unknown) => void) => void;
      }
    )._routeRuntimeEvent(
      {
        type: 'model.reasoning_delta',
        requestId: 'request-coalesced',
        segmentId: 'reasoning-1',
        text: 'r',
      },
      dispatch,
    );
    (
      rt as unknown as {
        _routeRuntimeEvent: (event: unknown, dispatch: (action: unknown) => void) => void;
      }
    )._routeRuntimeEvent(
      {
        type: 'model.reasoning_delta',
        requestId: 'request-coalesced',
        segmentId: 'reasoning-1',
        text: 'reasoning',
      },
      dispatch,
    );
    expect(actions).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(actions.map((action) => (action as { event: unknown }).event)).toEqual([
      {
        type: 'reasoning.activity',
        requestId: 'request-coalesced',
        state: 'streaming',
        segmentId: 'reasoning-1',
        text: 'reasoning',
      },
      { type: 'model.text_delta', requestId: 'request-coalesced', text: 'answer' },
    ]);
  });

  test('flushes buffered deltas before a non-delta event', () => {
    const rt = makeRuntime();
    const events: unknown[] = [];
    const dispatch = (action: unknown) => events.push((action as { event: unknown }).event);

    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.text_delta', requestId: 'final', text: 'answer' },
      dispatch,
    );
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.responded', messageId: 'final', text: 'answer' },
      dispatch,
    );

    expect(events).toEqual([
      { type: 'model.text_delta', requestId: 'final', text: 'answer' },
      {
        type: 'model.responded',
        requestId: 'final',
        messageId: 'final',
        toolCallCount: 0,
        summary: 'answer',
      },
    ]);
  });

  test('coalesces tool progress per call and stream before dispatch', async () => {
    const rt = makeRuntime();
    const events: any[] = [];
    const dispatch = (action: any) => events.push(action.event);

    (rt as any)._routeRuntimeEvent(
      {
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: 'one',
        stream: 'stdout',
      },
      dispatch,
    );
    (rt as any)._routeRuntimeEvent(
      {
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: 'two',
        stream: 'stdout',
      },
      dispatch,
    );
    expect(events).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(events).toEqual([
      {
        type: 'tool.progress',
        toolId: 'shell-1',
        summary: 'one\ntwo',
        stream: 'stdout',
        lineCount: 2,
      },
    ]);
  });

  test('bounds one oversized progress line without changing its logical line count', async () => {
    const rt = makeRuntime();
    const events: any[] = [];
    const dispatch = (action: any) => events.push(action.event);

    (rt as any)._routeRuntimeEvent(
      {
        type: 'tool.progress',
        toolCallId: 'shell-large',
        chunk: 'x'.repeat(32 * 1024),
        stream: 'stdout',
      },
      dispatch,
    );

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(events).toHaveLength(1);
    expect(events[0].summary).toContain('… progress truncated …');
    expect(events[0].summary.length).toBeLessThanOrEqual(8_193);
    expect(events[0].lineCount).toBe(1);
  });

  test('flushes tool progress before its terminal event', () => {
    const rt = makeRuntime();
    const events: any[] = [];
    const dispatch = (action: any) => events.push(action.event);

    (rt as any)._routeRuntimeEvent(
      {
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: 'tail',
        stream: 'stdout',
      },
      dispatch,
    );
    (rt as any)._routeRuntimeEvent(
      {
        type: 'tool.finished',
        toolCallId: 'shell-1',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'echo tail',
          exitCode: 0,
          stdout: 'tail',
          stderr: '',
        },
      },
      dispatch,
    );

    expect(events.map((event) => event.type)).toEqual(['tool.progress', 'tool.finished']);
  });

  test('background progress stays coalesced and never displaces a terminal event', () => {
    const rt = makeRuntime();
    rt.setForeground(false);
    for (let i = 0; i < 100; i++) {
      (rt as any)._routeRuntimeEvent(
        {
          type: 'tool.progress',
          toolCallId: 'shell-1',
          chunk: `line-${i}`,
          stream: 'stdout',
        },
        () => {},
      );
    }
    (rt as any)._routeRuntimeEvent(
      {
        type: 'tool.finished',
        toolCallId: 'shell-1',
        name: 'shell_execute',
        result: {
          ok: true,
          command: 'echo',
          exitCode: 0,
          stdout: 'done',
          stderr: '',
        },
      },
      () => {},
    );

    expect(rt.eventBuffer).toHaveLength(2);
    expect(rt.eventBuffer[0]?.type).toBe('tool.progress');
    expect(rt.eventBuffer[1]?.type).toBe('tool.finished');
    const progress = rt.eventBuffer[0];
    expect(progress).toEqual({
      type: 'tool.progress',
      toolId: 'shell-1',
      summary: Array.from({ length: 100 }, (_, index) => `line-${index}`).join('\n'),
      stream: 'stdout',
      lineCount: 100,
    });
  });

  test('flushes a reasoning delta before its explicit segment completion event', () => {
    const rt = makeRuntime();
    const events: unknown[] = [];
    const dispatch = (action: unknown) => events.push((action as { event: unknown }).event);

    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      {
        type: 'model.reasoning_delta',
        requestId: 'request-r1',
        segmentId: 'r1',
        text: 'complete reasoning',
      },
      dispatch,
    );
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      {
        type: 'model.reasoning_completed',
        requestId: 'request-r1',
        segmentId: 'r1',
        text: 'complete reasoning',
      },
      dispatch,
    );

    expect(events).toEqual([
      {
        type: 'reasoning.activity',
        requestId: 'request-r1',
        state: 'streaming',
        segmentId: 'r1',
        text: 'complete reasoning',
      },
      {
        type: 'reasoning.activity',
        requestId: 'request-r1',
        state: 'completed',
        segmentId: 'r1',
        text: 'complete reasoning',
      },
    ]);
  });

  test('keeps reasoning lifecycle events on the ephemeral presentation route with a server sink', () => {
    const rt = makeRuntime();
    const durableStateEvents: unknown[] = [];
    const presentationEvents: unknown[] = [];
    (rt as unknown as RuntimeWithStateEventSink)._runtimeStateEventSink = (event) => {
      durableStateEvents.push(event);
    };
    const dispatch = (action: unknown) =>
      presentationEvents.push((action as { event: unknown }).event);

    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      {
        type: 'model.reasoning_delta',
        requestId: 'request-server-reasoning-1',
        segmentId: 'server-reasoning-1',
        text: 'Inspecting the runtime.',
      },
      dispatch,
    );
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      {
        type: 'model.reasoning_completed',
        requestId: 'request-server-reasoning-1',
        segmentId: 'server-reasoning-1',
        text: 'Inspecting the runtime.',
      },
      dispatch,
    );

    expect(durableStateEvents).toEqual([]);
    expect(presentationEvents).toEqual([
      {
        type: 'reasoning.activity',
        requestId: 'request-server-reasoning-1',
        state: 'streaming',
        segmentId: 'server-reasoning-1',
        text: 'Inspecting the runtime.',
      },
      {
        type: 'reasoning.activity',
        requestId: 'request-server-reasoning-1',
        state: 'completed',
        segmentId: 'server-reasoning-1',
        text: 'Inspecting the runtime.',
      },
    ]);
  });

  test('clearBuffer cancels a pending delta frame', async () => {
    const rt = makeRuntime();
    const actions: unknown[] = [];
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.text_delta', requestId: 'request-discarded', text: 'discarded' },
      (action: unknown) => actions.push(action),
    );

    rt.clearBuffer();
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(actions).toEqual([]);
    expect(rt.eventBuffer).toEqual([]);
  });

  test('abort flushes the latest delta before cancelling the run', () => {
    const rt = makeRuntime();
    const events: unknown[] = [];
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.text_delta', requestId: 'request-partial', text: 'partial answer' },
      (action: unknown) => events.push((action as { event: unknown }).event),
    );

    rt.abort();
    expect(events).toEqual([
      { type: 'model.text_delta', requestId: 'request-partial', text: 'partial answer' },
    ]);
  });

  test('switching to background flushes a pending foreground delta first', () => {
    const rt = makeRuntime();
    const events: unknown[] = [];
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.text_delta', requestId: 'request-before-switch', text: 'before switch' },
      (action: unknown) => events.push((action as { event: unknown }).event),
    );

    rt.setForeground(false);
    expect(events).toEqual([
      {
        type: 'model.text_delta',
        requestId: 'request-before-switch',
        text: 'before switch',
      },
    ]);
    expect(rt.eventBuffer).toEqual([]);
  });

  test('switching to foreground preserves a background delta for replay', () => {
    const rt = makeRuntime();
    rt.setForeground(false);
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      {
        type: 'model.text_delta',
        requestId: 'request-background-update',
        text: 'background update',
      },
      () => {
        throw new Error('background delta must not dispatch directly');
      },
    );

    rt.setForeground(true);
    expect(rt.eventBuffer).toEqual([
      {
        type: 'model.text_delta',
        requestId: 'request-background-update',
        text: 'background update',
      },
    ]);
  });

  // ── _createProxyProvider (via private access) ──

  test('proxy requestAction auto-cancels input in background', async () => {
    const rt = makeRuntime();
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;
    (rt as unknown as RuntimeWithForeground)._foreground = false;

    const result = await proxy.requestAction({
      kind: 'input',
      prompt: 'question?',
    });
    expect(result).toEqual({ type: 'cancel' });
  });

  test('proxy requestAction waits on foregroundWake in background for tool_approval', async () => {
    const rt = makeRuntime();
    let notified = false;
    rt.notifyInterrupt = () => {
      notified = true;
    };
    // Set a non-null abortController so the proxy continues past the cancel guard
    rt.abortController = new AbortController();
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;
    (rt as unknown as RuntimeWithForeground)._foreground = false;

    // Start the requestAction — it will block on _foregroundWake
    proxy.requestAction({ kind: 'tool_approval', toolRequests: [] });

    expect(rt.pendingInterrupt).toBe(true);
    expect(notified).toBe(true);
    expect((rt as unknown as RuntimeWithForegroundWake)._foregroundWake).toBeDefined();

    // Resolve the foreground wake
    (rt as unknown as RuntimeWithForegroundWake)._foregroundWake();

    // After wake, pendingInterrupt should be cleared (line 252 in session-manager.ts)
    // Then the proxy continues to the foreground path which waits on _pendingResolve
    // pendingInterrupt should be false at this point
    await Bun.sleep(0); // let the promise microtask process
    expect(rt.pendingInterrupt).toBe(false);
  });

  test('proxy submitAction delegates to resolveInterrupt', () => {
    const rt = makeRuntime();
    let resolved: unknown = null;
    (rt as unknown as RuntimeWithPendingResolve)._pendingResolve = {
      interactionId: 'proxy-interaction',
      resolve: (action) => {
        resolved = action;
      },
    };
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;

    proxy.submitAction({ type: 'cancel', interactionId: 'proxy-interaction' });
    expect(resolved).toEqual({ type: 'cancel', interactionId: 'proxy-interaction' });
  });

  test('proxy reset cancels any pending interrupt', () => {
    const rt = makeRuntime();
    let resolved: unknown = null;
    (rt as unknown as RuntimeWithPendingResolve)._pendingResolve = {
      interactionId: 'reset-interaction',
      resolve: (action) => {
        resolved = action;
      },
    };
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;

    proxy.reset();
    expect(resolved).toEqual({ type: 'cancel', interactionId: 'reset-interaction' });
  });
});
