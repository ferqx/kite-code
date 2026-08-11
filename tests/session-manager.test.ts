import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppShellExecutorV1, AppShellRuntimeDecisionV1 } from '../src/app/sandbox/composition';
import { sandboxSupportsFullModeV1 } from '../src/app/tui/interaction-mode';
import { TuiUserInputProvider } from '../src/app/tui/provider';
import type { Action } from '../src/app/tui/reducers/actions';
import {
  admitInteractionModeTarget,
  fullModeUnavailableReason,
  isSilentCancellationMismatch,
  resolveInteractionModeTarget,
  type SessionDeps,
  SessionManager,
  SessionRuntime,
} from '../src/app/tui/session-manager';
import type { StatusState } from '../src/app/tui/types';
import type { AgentConfig } from '../src/core/config';
import { aiMessage } from '../src/core/messages';
import { loadSession } from '../src/core/persistence/sessions';
import type { RuntimeEvent } from '../src/core/runtime/events';
import { createAgentKernel } from '../src/core/runtime/kernel';
import { reduceRuntimeState } from '../src/core/runtime/reducer';
import { createInitialRuntimeState } from '../src/core/runtime/state';
import { createRuntimeStore, runtimeStorePathFor } from '../src/core/runtime/store';
import type { UserAction } from '../src/protocol/actions';
import { createMockModel } from './mock-model';
import { createMockModelServer } from './tui-system/harness/fixtures';

// ── Test-only structural access to private members (casts are erased at runtime) ──

type RuntimeWithPendingResolve = {
  _pendingResolve: ((action: unknown) => void) | null;
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
type RuntimeWithPushToBuffer = { _pushToBuffer: (event: unknown) => void };
type ManagerWithTokenStatsCache = {
  tokenStatsCache: Map<
    string,
    { cacheHitTokens: number; cacheMissTokens: number; totalTokens: number }
  >;
};

// ── Helpers ──

function makeDeps(): SessionDeps {
  const config: AgentConfig = {
    apiKey: 'unused',
    baseURL: 'https://example.invalid',
    modelName: 'test-model',
    providerName: 'deepseek',
    providerType: 'openai-compatible',
    features: {
      resourceBudgetV1: true,
      boundedCancellationV1: true,
    },
    sandbox: { enabled: true },
  };
  return {
    config,
    provider: {} as unknown as TuiUserInputProvider,
    skillManifests: [],
    skillOptions: null,
    mcpManager: null,
    checkpointPath: ':memory:',
  };
}

function seedSettledRuntimeMessages(input: {
  storePath: string;
  threadId: string;
  count: number;
  content(index: number): string;
}): void {
  const kernel = createAgentKernel({
    threadId: input.threadId,
    userId: 'tui',
    workspace: '/tmp/ws',
    storePath: input.storePath,
  });
  try {
    for (let index = 0; index < input.count; index++) {
      if (index > 0) {
        kernel.processEvent({ type: 'turn.started', turnId: `turn-${index}` });
      }
      kernel.processEvent({
        type: 'user.message_appended',
        messageId: `message-${index}`,
        content: input.content(index),
      });
      kernel.processEvent({ type: 'turn.completed', turnId: kernel.getState().turn.turnId });
    }
  } finally {
    kernel.close();
  }
}

function makeManager() {
  return new SessionManager(makeDeps());
}

function makeRuntime(threadId = 't1', workspace = '/tmp/ws') {
  return new SessionRuntime(threadId, workspace, makeDeps());
}

function createDeferredShellExecutor() {
  let resolvePreparation!: (decision: AppShellRuntimeDecisionV1) => void;
  const preparation = new Promise<AppShellRuntimeDecisionV1>((resolve) => {
    resolvePreparation = resolve;
  });
  let prepareCalls = 0;
  let executionCalls = 0;

  const executor = (async (input: Parameters<AppShellExecutorV1>[0]) => {
    executionCalls += 1;
    return {
      ok: false,
      command: input.command,
      exitCode: -1,
      stdout: '',
      stderr: 'unexpected shell execution',
    };
  }) as AppShellExecutorV1;
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
    authorization: 'default',
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
  test('rejects full mode when no sandbox backend is available', () => {
    expect(fullModeUnavailableReason('full', 'none')).toBe('非沙箱环境无法开启full');
  });

  test('keeps full mode unavailable with the direct Windows restricted-token backend', () => {
    expect(sandboxSupportsFullModeV1('windows_restricted_token')).toBe(false);
    expect(fullModeUnavailableReason('full', 'windows_restricted_token')).toBe(
      fullModeUnavailableReason('full', 'none'),
    );
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

  test('rejects full admission before dispatch when sandbox is unavailable', () => {
    const decision = admitInteractionModeTarget('full', 'none');
    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe('accept_edits');
    expect(decision.reason).toBe('非沙箱环境无法开启full');
  });

  test('rejects full admission for the direct Windows restricted-token backend', () => {
    expect(admitInteractionModeTarget('full', 'windows_restricted_token')).toEqual({
      allowed: false,
      mode: 'accept_edits',
      reason: fullModeUnavailableReason('full', 'none'),
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

describe('SessionManager', () => {
  test('does not restore an approval resolved after the rolling snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-resolved-approval-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const threadId = 'resolved-approval';
    const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
    try {
      const state = createInitialRuntimeState({
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
      });
      state.interactions = {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-1',
        toolCallId: 'shell-1',
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
      };
      store.saveSnapshot(threadId, { ...state, schemaVersion: 23 });
      store.appendEvents(threadId, [
        {
          type: 'approval.granted',
          interactionId: 'approval-1',
          toolCallId: 'shell-1',
          grant: 'approve_once',
        },
      ]);
      store.setSessionModelRoute(threadId, {
        provider: 'ollama',
        name: 'qwen2.5-coder:7b',
      });
    } finally {
      store.close();
    }

    try {
      const restored = await loadSession(checkpointPath, threadId);
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
      features: { contextCompactionManualV1: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createInitialRuntimeState({
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
    });
    state.transcript.messages = Array.from({ length: 3 }, (_, index) => ({
      kind: 'user' as const,
      messageId: `live-${index}`,
      turnId: `turn-${index}`,
      ordinal: index,
      createdAt: `2026-08-08T00:0${index}:00.000Z`,
      content: `message ${index}`,
    }));
    state.revision = 1;
    state.lastAppliedEventId = 'a'.repeat(64);
    state.context.lastTranscriptProducingEventCutV1 = {
      revision: 1,
      eventId: 'a'.repeat(64),
    };
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input',
      toolCallId: 'ask',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
    const persisted: unknown[] = [];
    runtime.runtimeControl = {
      getState: () => state,
      processEvent: (event) => {
        persisted.push(event);
      },
      cancelRun: () => [],
    };

    const result = await mgr.handleContextCompaction(threadId);
    expect(persisted[0]).toMatchObject({
      type: 'user.command_invoked',
      command: '/compact',
    });
    expect(persisted).toHaveLength(1);
    expect(result.text).toBe('No safe messages to compact.');
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
      features: { contextCompactionManualV1: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createInitialRuntimeState({
      threadId,
      userId: 'tui',
      workspace: '/tmp/ws',
    });
    state.turn = { ...state.turn, status: 'completed' };
    const control = {
      getState: () => state,
      processEvent: () => undefined,
      cancelRun: () => [],
    };
    runtime.runtimeControl = control;
    const completion = Promise.resolve().then(() => {
      runtime.runtimeControl = null;
    });
    Reflect.set(runtime, '_runCompletion', completion);

    const result = await mgr.handleContextCompaction(threadId);
    expect(result.text).not.toContain('queued');
    expect(result.text).toBe('Not enough messages to compact.');
  });

  test('returns "not enough messages" when session has no transcript', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManualV1: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const result = await mgr.handleContextCompaction(threadId);
    expect(result.events.map((event) => event.type)).toEqual([
      'context.compaction_requested',
      'context.compaction_failed',
    ]);
    expect(result.text).toBe('Not enough messages to compact.');
  });

  test('does not compact a single settled turn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-compact-small-'));
    const deps = makeDeps();
    deps.checkpointPath = join(root, 'checkpoints.sqlite');
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManualV1: true },
    };
    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      seedSettledRuntimeMessages({
        storePath: runtimeStorePathFor(deps.checkpointPath),
        threadId,
        count: 1,
        content: () => 'Hello',
      });

      const result = await mgr.handleContextCompaction(threadId);

      expect(result.text).toContain('Not enough reducible context');
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: 'context.summary_failed_v1',
          errorKind: 'insufficient_reduction',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('projects the durable compact command once as it is persisted', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManualV1: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const projected: RuntimeEvent[] = [];

    await mgr.handleContextCompaction(threadId, undefined, undefined, (event) => {
      projected.push(event);
    });

    expect(projected).toEqual([
      expect.objectContaining({ type: 'user.command_invoked', command: '/compact' }),
    ]);
  });

  test('recovers a historical manual compaction pending instead of leaving it forever', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-compact-recovery-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const deps = makeDeps();
    deps.checkpointPath = checkpointPath;
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManualV1: true },
    };

    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      const kernel = createAgentKernel({
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
        storePath: runtimeStorePathFor(checkpointPath),
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
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: 'context.compaction_failed',
          compactionId: 'stuck-manual-request',
        }),
      );

      const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
      try {
        const state = store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>(threadId);
        expect(state?.context.pendingCompaction).toBeUndefined();
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
      features: { contextCompactionManualV1: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    let state = createInitialRuntimeState({
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
    runtime.runtimeControl = {
      getState: () => state,
      processEvent: (event) => persisted.push(event),
      cancelRun: () => [],
    };

    const result = await mgr.handleContextCompaction(threadId);

    expect(persisted.map((event) => (event as { type: string }).type)).toEqual([
      'user.command_invoked',
    ]);
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
      features: { contextCompactionManualV1: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createInitialRuntimeState({
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
    runtime.runtimeControl = {
      getState: () => state,
      processEvent: (event) => persisted.push(event),
      cancelRun: () => [],
    };

    const result = await mgr.handleContextCompaction(threadId, 'focus on unfinished work');

    expect(persisted).toEqual([expect.objectContaining({ type: 'user.command_invoked' })]);
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
      features: { contextCompactionManualV1: true },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createInitialRuntimeState({
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
    runtime.runtimeControl = {
      getState: () => state,
      processEvent: () => {},
      cancelRun: () => [],
    };

    const snapshot = mgr.buildContextStatusSnapshot(threadId);

    expect(snapshot).toMatchObject({
      activeCheckpointId: 'restored-checkpoint',
      inputTokensBefore: 20_000,
      inputTokensAfter: 2_000,
    });
    expect(snapshot!.estimate.summaryTokens).toBe(0);
    expect(snapshot!.estimate.transcriptTokens).toBeGreaterThan(1_000);
  });

  test('persists /compact for replay without adding it to the model transcript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-compact-replay-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const deps = makeDeps();
    deps.checkpointPath = checkpointPath;
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManualV1: true },
    };

    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      await mgr.handleContextCompaction(threadId, 'focus on auth changes');

      const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
      try {
        const events = store.loadEvents(threadId).map((entry) => entry.event);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: 'user.command_invoked',
            command: '/compact focus on auth changes',
          }),
        );
        const state = store.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>(threadId);
        expect(state?.transcript.messages).toHaveLength(0);
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
      features: { contextCompactionManualV1: true },
      compaction: {},
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createInitialRuntimeState({
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
    state.revision = 1;
    state.lastAppliedEventId = 'b'.repeat(64);
    state.context.lastTranscriptProducingEventCutV1 = {
      revision: 1,
      eventId: 'b'.repeat(64),
    };
    state.interactions = {
      kind: 'awaiting_user_input',
      interactionId: 'input',
      toolCallId: 'ask',
      request: { question: 'Continue?', options: [], allow_free_text: true },
    };
    const persisted: unknown[] = [];
    runtime.runtimeControl = {
      getState: () => state,
      processEvent: (event) => {
        persisted.push(event);
      },
      cancelRun: () => [],
    };

    const result = await mgr.handleContextCompaction(threadId);
    expect(persisted[0]).toMatchObject({
      type: 'user.command_invoked',
      command: '/compact',
    });
    expect(persisted).toHaveLength(1);
    expect(result.text).toBe('No safe messages to compact.');
  });

  test('executes standalone manual compaction and persists the completed checkpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-compact-success-'));
    const server = createMockModelServer();
    const deps = makeDeps();
    deps.checkpointPath = join(root, 'checkpoints.sqlite');
    deps.config = {
      apiKey: 'test',
      baseURL: server.baseURL,
      modelName: 'mock-model',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManualV1: true },
      compaction: { maxSummaryTokens: 200, maxNarrativeTokens: 200 },
    };
    server.setResponses([
      {
        message: { content: 'Preserve the user goals, completed work, and pending verification.' },
      },
    ]);

    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      seedSettledRuntimeMessages({
        storePath: runtimeStorePathFor(deps.checkpointPath),
        threadId,
        count: 8,
        content: (index) => `Historical goal ${index}: ${'important context '.repeat(300)}`,
      });

      const result = await mgr.handleContextCompaction(threadId);

      expect(server.getRequestCount()).toBe(1);
      expect(result.events).toContainEqual(
        expect.objectContaining({ type: 'context.summary_completed_v1' }),
      );
      expect(result.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'resource_budget.reserved',
          'resource_budget.dispatch_started',
          'context.summary_dispatch_started_v1',
          'resource_budget.unknown',
        ]),
      );
      const restored = createRuntimeStore(runtimeStorePathFor(deps.checkpointPath));
      try {
        expect(
          restored.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>(threadId)?.context
            .activeCheckpoint,
        ).toMatchObject({
          version: 3,
          source: { coveredThroughMessageId: 'message-7' },
        });
      } finally {
        restored.close();
      }
      server.assertComplete();
    } finally {
      server.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('standalone compaction fails closed through Provider data admission', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-compact-policy-'));
    const server = createMockModelServer();
    const deps = makeDeps();
    deps.checkpointPath = join(root, 'checkpoints.sqlite');
    deps.config = {
      apiKey: 'test',
      baseURL: server.baseURL,
      modelName: 'unapproved-model',
      providerName: 'unapproved-provider',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManualV1: true, providerDataPolicyV1: true },
      compaction: { maxSummaryTokens: 200, maxNarrativeTokens: 200 },
    };

    try {
      const mgr = new SessionManager(deps);
      const threadId = mgr.createSession('/tmp/ws');
      seedSettledRuntimeMessages({
        storePath: runtimeStorePathFor(deps.checkpointPath),
        threadId,
        count: 8,
        content: (index) => `Historical goal ${index}: ${'important context '.repeat(300)}`,
      });

      const result = await mgr.handleContextCompaction(threadId);

      expect(server.getRequestCount()).toBe(0);
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: 'context.summary_failed_v1',
          errorKind: 'provider_admission_denied',
        }),
      );
      expect(result.events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          'resource_budget.reserved',
          'resource_budget.dispatch_started',
          'context.summary_dispatch_started_v1',
          'resource_budget.released',
        ]),
      );
      expect(result.isError).toBe(true);
      const restored = createRuntimeStore(runtimeStorePathFor(deps.checkpointPath));
      try {
        expect(
          restored.loadSnapshot<ReturnType<typeof createInitialRuntimeState>>(threadId)?.context
            .summaryLifecycle,
        ).toEqual({ kind: 'idle' });
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

  test('createSession deactivates previous active session', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;
    // Set up a pending interrupt on the old session
    (rt1 as unknown as { _pendingResolve: ((a: unknown) => void) | null })._pendingResolve = (
      _action: unknown,
    ) => {};
    rt1.pendingInterrupt = true;

    // Create new session — should deactivate old one
    mgr.createSession('/tmp/ws');

    const snapshots = mgr.getSnapshot();
    const s1 = snapshots.find((s) => s.threadId === id1)!;
    expect(s1.active).toBe(false);
    expect(rt1.pendingInterrupt).toBe(false);
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
    const root = mkdtempSync(join(tmpdir(), 'kite-plan-exit-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const deps = { ...makeDeps(), checkpointPath };
    const mgr = new SessionManager(deps);
    try {
      const threadId = mgr.createSession('/tmp/ws');
      expect(mgr.enterPlanningMode(threadId).map((event) => event.type)).toEqual([
        'task.started',
        'planning.entered',
      ]);

      const kernel = createAgentKernel({
        threadId,
        userId: 'tui',
        workspace: '/tmp/ws',
        storePath: runtimeStorePathFor(checkpointPath),
        phase: 'building',
      });
      kernel.processEvent({
        type: 'run.completed',
        turnId: kernel.getState().turn.turnId,
        output: 'Planning conversation completed.',
      });
      kernel.close();

      expect(mgr.exitPlanningMode(threadId)).toEqual({
        events: [],
        phase: 'building',
      });
    } finally {
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

  test('switchSession resolves pending interrupt on outgoing session', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;
    (rt1 as unknown as { _pendingResolve: ((a: unknown) => void) | null })._pendingResolve = (
      _action: unknown,
    ) => {};

    mgr.switchSession(id1, id2);

    // The outgoing session's interrupt should be resolved with cancel
    // Note: resolveInterrupt clears _pendingResolve, so it won't fire again
    expect(rt1.pendingInterrupt).toBe(false);
  });

  test('switchSession clears pendingInterrupt on outgoing session', () => {
    const mgr = makeManager();
    const id1 = mgr.createSession('/tmp/ws');
    const id2 = mgr.createSession('/tmp/ws');
    const rt1 = mgr.getRuntime(id1)!;
    rt1.pendingInterrupt = true;

    mgr.switchSession(id1, id2);

    expect(rt1.pendingInterrupt).toBe(false);
  });

  test('switchSession cancels an active TUI turn before changing the visible session', () => {
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

    expect(abortCalls).toBe(1);
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
      messageId: 'm1',
      text: 'hello',
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

  test('shares one journal mode between the long-lived stats connection and RuntimeStore', () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-session-journal-'));
    const checkpointPath = join(root, 'checkpoints.sqlite');
    const mgr = new SessionManager({ ...makeDeps(), checkpointPath });
    try {
      mgr.saveTokenStats(
        'dual-connection',
        makeStatus({ cacheHitTokens: 1, cacheMissTokens: 2, totalTokens: 3 }),
        true,
      );

      const store = createRuntimeStore(runtimeStorePathFor(checkpointPath));
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
    const oldStats = (mgr as unknown as ManagerWithTokenStatsCache).tokenStatsCache.get(oldId)!;
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
    expect((mgr as unknown as ManagerWithTokenStatsCache).tokenStatsCache.has(id)).toBe(true);

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

// ── SessionRuntime ──

describe('SessionRuntime', () => {
  test('persists an interaction-mode change to a live Kernel control', () => {
    const rt = makeRuntime();
    const kernel = createAgentKernel({
      threadId: rt.threadId,
      userId: 'tui',
      workspace: rt.workspace,
      storePath: ':memory:',
      sandboxAvailable: true,
    });
    try {
      rt.runtimeControl = {
        getState: () => kernel.getState(),
        processEvent: (event) => {
          kernel.processEvent(event);
        },
        cancelRun: () => [],
      };

      rt.setInteractionMode('full');

      expect(rt.interactionMode).toBe('full');
      expect(kernel.getState().mode).toBe('full');
      expect(kernel.getState().authorization).toMatchObject({
        mode: 'full_access',
        modeSource: 'user',
      });
      expect(Date.parse(kernel.getState().authorization.modeGrantedAt ?? '')).toBeFinite();
    } finally {
      kernel.close();
    }
  });

  test('rejects a live Full mode change without a Full-qualified sandbox', () => {
    const rt = makeRuntime();
    const kernel = createAgentKernel({
      threadId: rt.threadId,
      userId: 'tui',
      workspace: rt.workspace,
      storePath: ':memory:',
      sandboxAvailable: false,
    });
    try {
      rt.runtimeControl = {
        getState: () => kernel.getState(),
        processEvent: (event) => {
          kernel.processEvent(event);
        },
        cancelRun: () => [],
      };

      expect(() => rt.setInteractionMode('full')).toThrow(
        'full_access requires an available workspace sandbox',
      );
      expect(rt.interactionMode).toBe('accept_edits');
      expect(kernel.getState().mode).toBe('accept_edits');
      expect(kernel.getState().authorization.mode).toBe('default');
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
    const state = createInitialRuntimeState({
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

    const actionPromise = (rt as unknown as RuntimeWithRuntimeAction)._requestRuntimeAction(
      { type: effectType, interactionId, toolCallId },
      state,
    );
    rt.resolveInterrupt({ type: 'cancel' });

    await expect(actionPromise).resolves.toEqual({
      type: 'cancel',
      interactionId,
    });
  });

  test('maps the verification decision prompt to an explicit user waiver', async () => {
    const rt = makeRuntime();
    const state = createInitialRuntimeState({
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
            checkId: 'review',
            type: 'reviewer',
            description: 'review evidence',
            instructions: 'verify release',
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
    rt.resolveInterrupt({ type: 'input', text: 'waive: accepted by user' });
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
    const state = createInitialRuntimeState({
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
    rt.resolveInterrupt({ type: 'input', text: 'Run login' });
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
    const state = createInitialRuntimeState({
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
    rt.resolveInterrupt({ type: 'input', text: 'Session Waive' });
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
    ) as import('../src/core/model/factory').SupportedChatModel;

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
    const preparation = new Promise<AppShellRuntimeDecisionV1>((_resolve, reject) => {
      rejectPreparation = reject;
    });
    let abortPreparationCalls = 0;
    const executor = (async (input: Parameters<AppShellExecutorV1>[0]) => ({
      ok: false,
      command: input.command,
      exitCode: -1,
      stdout: '',
      stderr: 'unexpected shell execution',
    })) as AppShellExecutorV1;
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
    const rt = makeRuntime();
    const ac = new AbortController();
    rt.agentLoopActive = true;
    rt.abortController = ac;

    let resolved = false;
    (rt as unknown as { _pendingResolve: ((a: unknown) => void) | null })._pendingResolve = () => {
      resolved = true;
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
    const state = createInitialRuntimeState({
      threadId: rt.threadId,
      userId: 'tui',
      workspace: rt.workspace,
    });
    const order: string[] = [];
    const projected: string[] = [];
    rt.agentLoopActive = true;
    rt.abortController = ac;
    rt.runtimeControl = {
      getState: () => state,
      processEvent: () => {},
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
    expect(projected).toEqual(['tool.cancelled', 'turn.aborted']);
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
    const home = mkdtempSync(join(tmpdir(), 'kite-session-successor-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'kite-session-successor-workspace-'));
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
    const shellExecutor = (async (input: Parameters<AppShellExecutorV1>[0]) => {
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
    }) as AppShellExecutorV1;
    shellExecutor.prepare = async () => ({
      mode: 'host_shell',
      backend: 'none',
    });
    const deps = {
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
      shellExecutor,
    };
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
      await shellStarted;
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
            text: '继续测试已完成。',
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
    const home = mkdtempSync(join(tmpdir(), 'kite-session-presentation-home-'));
    const workspace = mkdtempSync(join(tmpdir(), 'kite-session-presentation-workspace-'));
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
      setRetryListener: () => {},
    } as import('../src/core/model/factory').SupportedChatModel;
    const deps = {
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

      await flushStarted;
      expect(eventOrder).toContain('model.reasoning_completed');
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
      messageId: 'm1',
      text: 'hello',
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
    (rt as unknown as { _pendingResolve: ((a: unknown) => void) | null })._pendingResolve = (
      action: unknown,
    ) => {
      resolvedAction = action;
    };

    rt.resolveInterrupt({ type: 'approve' } as unknown as UserAction);

    expect(resolvedAction).toEqual({ type: 'approve' });
    expect(
      (rt as unknown as { _pendingResolve: ((a: unknown) => void) | null })._pendingResolve,
    ).toBeNull();
  });

  test('resolveInterrupt is no-op when no pending resolve', () => {
    const rt = makeRuntime();
    // should not throw
    rt.resolveInterrupt({ type: 'cancel' } as unknown as UserAction);
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
        messageId: `m${i}`,
        text: `msg${i}`,
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
      toolCallId: 'shell-old',
      chunk: 'old progress',
      stream: 'stdout',
    });
    for (let i = 1; i < MAX; i++) {
      rt.eventBuffer.push({
        type: 'model.responded',
        messageId: `m${i}`,
        text: `msg${i}`,
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
        (event) => event.type === 'tool.finished' && event.toolCallId === 'shell-new',
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
        toolCallId: `c${i}`,
        name: 'read_file',
        result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
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
      rt.eventBuffer.some(
        (event) => event.type === 'tool.finished' && event.toolCallId === 'c_new',
      ),
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
    )._routeRuntimeEvent({ type: 'model.text_delta', text: 'a' }, dispatch);
    (
      rt as unknown as {
        _routeRuntimeEvent: (event: unknown, dispatch: (action: unknown) => void) => void;
      }
    )._routeRuntimeEvent({ type: 'model.text_delta', text: 'answer' }, dispatch);
    (
      rt as unknown as {
        _routeRuntimeEvent: (event: unknown, dispatch: (action: unknown) => void) => void;
      }
    )._routeRuntimeEvent({ type: 'model.reasoning_delta', text: 'r' }, dispatch);
    (
      rt as unknown as {
        _routeRuntimeEvent: (event: unknown, dispatch: (action: unknown) => void) => void;
      }
    )._routeRuntimeEvent({ type: 'model.reasoning_delta', text: 'reasoning' }, dispatch);
    expect(actions).toEqual([]);

    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(actions.map((action) => (action as { event: unknown }).event)).toEqual([
      { type: 'model.reasoning_delta', text: 'reasoning' },
      { type: 'model.text_delta', text: 'answer' },
    ]);
  });

  test('flushes buffered deltas before a non-delta event', () => {
    const rt = makeRuntime();
    const events: unknown[] = [];
    const dispatch = (action: unknown) => events.push((action as { event: unknown }).event);

    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.text_delta', text: 'answer' },
      dispatch,
    );
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.responded', messageId: 'final', text: 'answer' },
      dispatch,
    );

    expect(events).toEqual([
      { type: 'model.text_delta', text: 'answer' },
      { type: 'model.responded', messageId: 'final', text: 'answer' },
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
        toolCallId: 'shell-1',
        chunk: 'one\ntwo',
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
    expect(events[0].chunk.length).toBeLessThanOrEqual(16 * 1024);
    expect(events[0].chunk).toStartWith('… progress truncated … ');
    expect(events[0].chunk).not.toContain('\n');
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
      (rt as any)._pushToBuffer({
        type: 'tool.progress',
        toolCallId: 'shell-1',
        chunk: `line-${i}`,
        stream: 'stdout',
      });
    }
    (rt as any)._pushToBuffer({
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
    });

    expect(rt.eventBuffer).toHaveLength(2);
    expect(rt.eventBuffer[0]?.type).toBe('tool.progress');
    expect(rt.eventBuffer[1]?.type).toBe('tool.finished');
    const progress = rt.eventBuffer[0];
    expect(progress?.type === 'tool.progress' ? progress.chunk : '').toContain('line-99');
  });

  test('flushes a reasoning delta before its explicit segment completion event', () => {
    const rt = makeRuntime();
    const events: unknown[] = [];
    const dispatch = (action: unknown) => events.push((action as { event: unknown }).event);

    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      {
        type: 'model.reasoning_delta',
        segmentId: 'r1',
        text: 'complete reasoning',
      },
      dispatch,
    );
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      {
        type: 'model.reasoning_completed',
        segmentId: 'r1',
        text: 'complete reasoning',
      },
      dispatch,
    );

    expect(events).toEqual([
      {
        type: 'model.reasoning_delta',
        segmentId: 'r1',
        text: 'complete reasoning',
      },
      {
        type: 'model.reasoning_completed',
        segmentId: 'r1',
        text: 'complete reasoning',
      },
    ]);
  });

  test('clearBuffer cancels a pending delta frame', async () => {
    const rt = makeRuntime();
    const actions: unknown[] = [];
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.text_delta', text: 'discarded' },
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
      { type: 'model.text_delta', text: 'partial answer' },
      (action: unknown) => events.push((action as { event: unknown }).event),
    );

    rt.abort();
    expect(events).toEqual([{ type: 'model.text_delta', text: 'partial answer' }]);
  });

  test('switching to background flushes a pending foreground delta first', () => {
    const rt = makeRuntime();
    const events: unknown[] = [];
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.text_delta', text: 'before switch' },
      (action: unknown) => events.push((action as { event: unknown }).event),
    );

    rt.setForeground(false);
    expect(events).toEqual([{ type: 'model.text_delta', text: 'before switch' }]);
    expect(rt.eventBuffer).toEqual([]);
  });

  test('switching to foreground preserves a background delta for replay', () => {
    const rt = makeRuntime();
    rt.setForeground(false);
    (rt as unknown as RuntimeWithRouteRuntimeEvent)._routeRuntimeEvent(
      { type: 'model.text_delta', text: 'background update' },
      () => {
        throw new Error('background delta must not dispatch directly');
      },
    );

    rt.setForeground(true);
    expect(rt.eventBuffer).toEqual([{ type: 'model.text_delta', text: 'background update' }]);
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
    (rt as unknown as RuntimeWithPendingResolve)._pendingResolve = (action: unknown) => {
      resolved = action;
    };
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;

    proxy.submitAction({ type: 'cancel' });
    expect(resolved).toEqual({ type: 'cancel' });
  });

  test('proxy reset cancels any pending interrupt', () => {
    const rt = makeRuntime();
    let resolved: unknown = null;
    (rt as unknown as RuntimeWithPendingResolve)._pendingResolve = (action: unknown) => {
      resolved = action;
    };
    const proxy = (rt as unknown as RuntimeWithProxyProvider)._proxyProvider;

    proxy.reset();
    expect(resolved).toEqual({ type: 'cancel' });
  });
});
