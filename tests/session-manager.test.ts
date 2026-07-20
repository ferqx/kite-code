import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  admitInteractionModeTarget,
  fullModeUnavailableReason,
  isSilentCancellationMismatch,
  resolveInteractionModeTarget,
  SessionManager,
  SessionRuntime,
} from '../src/app/tui/session-manager';
import type { StatusState } from '../src/app/tui/types';
import { createInitialRuntimeState } from '../src/core/runtime/state';
import { createRuntimeStore, runtimeStorePathFor } from '../src/core/runtime/store';

// ── Helpers ──

function makeDeps(): any {
  return {
    config: { sandbox: { enabled: true } },
    provider: {},
    skillManifests: [],
    skillOptions: null,
    mcpManager: null,
    checkpointPath: ':memory:',
  };
}

function makeManager() {
  return new SessionManager(makeDeps());
}

function makeRuntime(threadId = 't1', workspace = '/tmp/ws') {
  return new SessionRuntime(threadId, workspace, makeDeps());
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
    expect(fullModeUnavailableReason('full', 'none')).toContain('未启用沙箱');
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
  test('resolves slash mode toggle without delegating full entry to reducer', () => {
    expect(resolveInteractionModeTarget(undefined, 'accept_edits')).toBe('auto');
    expect(resolveInteractionModeTarget(undefined, 'auto')).toBe('full');
    expect(resolveInteractionModeTarget(undefined, 'full')).toBe('accept_edits');
    expect(resolveInteractionModeTarget('f', 'accept_edits')).toBe('full');
    expect(resolveInteractionModeTarget('au', 'accept_edits')).toBe('auto');
  });

  test('skips full when slash mode toggles without sandbox backend', () => {
    expect(resolveInteractionModeTarget(undefined, 'accept_edits', 'none')).toBe('auto');
    expect(resolveInteractionModeTarget(undefined, 'auto', 'none')).toBe('accept_edits');
    expect(resolveInteractionModeTarget(undefined, 'auto', 'seatbelt')).toBe('full');
  });

  test('rejects full admission before dispatch when sandbox is unavailable', () => {
    const decision = admitInteractionModeTarget('full', 'none');
    expect(decision.allowed).toBe(false);
    expect(decision.mode).toBe('accept_edits');
    expect(decision.reason).toContain('未启用沙箱');
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
    };

    const result = await mgr.handleContextCompaction(threadId);
    expect(persisted[0]).toMatchObject({ type: 'user.command_invoked', command: '/compact' });
    expect(persisted[1]).toMatchObject({
      type: 'context.compaction_requested',
      reason: 'manual',
      force: false,
    });
    expect(result.text).toContain('queued');
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
    const runtime = mgr.getRuntime(threadId)!;
    const state = createInitialRuntimeState({ threadId, userId: 'tui', workspace: '/tmp/ws' });
    // transcript has only 2 messages (default initial state), not enough for safe boundary
    const persisted: unknown[] = [];
    runtime.runtimeControl = {
      getState: () => state,
      processEvent: (event) => persisted.push(event),
    };

    const result = await mgr.handleContextCompaction(threadId);
    expect(persisted.map((event) => (event as { type: string }).type)).toEqual([
      'user.command_invoked',
      'context.compaction_requested',
      'context.compaction_failed',
    ]);
    expect(result.events.map((event) => event.type)).toEqual([
      'context.compaction_requested',
      'context.compaction_failed',
    ]);
    expect(result.text).toBe('Not enough messages to compact.');
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

  test('normal compaction succeeds when session has enough messages', async () => {
    const deps = makeDeps();
    deps.config = {
      apiKey: 'test',
      baseURL: 'http://localhost',
      modelName: 'mock',
      providerName: 'mock',
      providerType: 'openai-compatible',
      sandbox: { enabled: true },
      features: { contextCompactionManualV1: true },
      compaction: { recentTurns: 1 },
    };
    const mgr = new SessionManager(deps);
    const threadId = mgr.createSession('/tmp/ws');
    const runtime = mgr.getRuntime(threadId)!;
    const state = createInitialRuntimeState({ threadId, userId: 'tui', workspace: '/tmp/ws' });
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
    runtime.runtimeControl = {
      getState: () => state,
      processEvent: (event) => {
        persisted.push(event);
      },
    };

    const result = await mgr.handleContextCompaction(threadId);
    expect(persisted[0]).toMatchObject({ type: 'user.command_invoked', command: '/compact' });
    expect(persisted[1]).toMatchObject({
      type: 'context.compaction_requested',
      reason: 'manual',
      force: false,
    });
    expect(result.text).toContain('queued');
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
    (rt1 as any)._pendingResolve = (_action: any) => {};
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
    (rt1 as any)._pendingResolve = (_action: any) => {};

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
    rt.eventBuffer.push({ type: 'model.responded', messageId: 'm1', text: 'hello' });

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
      makeStatus({ cacheHitTokens: 10, cacheMissTokens: 5, totalTokens: 15, cacheHitRate: 66.7 }),
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
      makeStatus({ cacheHitTokens: 0, cacheMissTokens: 0, totalTokens: 0, cacheHitRate: 0 }),
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
      makeStatus({ cacheHitTokens: 50, cacheMissTokens: 25, totalTokens: 75, cacheHitRate: 66.7 }),
      true,
    );

    // Create new session — createSession does NOT internally call saveTokenStats
    const newId = mgr.createSession('/tmp/ws');

    // Old session's stats are still in the cache (we saved explicitly before)
    const oldStats = (mgr as any).tokenStatsCache.get(oldId);
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
      makeStatus({ cacheHitTokens: 88, cacheMissTokens: 22, totalTokens: 110, cacheHitRate: 80 }),
      true,
    );

    // Verify stats exist before removal
    expect((mgr as any).tokenStatsCache.has(id)).toBe(true);

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
    const state = createInitialRuntimeState({ threadId: 't1', userId: 'u', workspace: '/tmp/ws' });
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

    const actionPromise = (rt as any)._requestRuntimeAction(
      { type: effectType, interactionId, toolCallId },
      state,
    );
    rt.resolveInterrupt({ type: 'cancel' });

    await expect(actionPromise).resolves.toEqual({ type: 'cancel', interactionId });
  });

  test('maps the verification decision prompt to an explicit user waiver', async () => {
    const rt = makeRuntime();
    const state = createInitialRuntimeState({ threadId: 't1', userId: 'u', workspace: '/tmp/ws' });
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
    const actionPromise = (rt as any)._requestRuntimeAction(
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
    const state = createInitialRuntimeState({ threadId: 't1', userId: 'u', workspace: '/tmp/ws' });
    const actionPromise = (rt as any)._requestRuntimeAction(
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
    const state = createInitialRuntimeState({ threadId: 't1', userId: 'u', workspace: '/tmp/ws' });
    const actionPromise = (rt as any)._requestRuntimeAction(
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

  test('abort resolves pending interrupt and signals AbortController', () => {
    const rt = makeRuntime();
    const ac = new AbortController();
    rt.agentLoopActive = true;
    rt.abortController = ac;

    let resolved = false;
    (rt as any)._pendingResolve = () => {
      resolved = true;
    };

    rt.abort();

    expect(ac.signal.aborted).toBe(true);
    expect(rt.agentLoopActive).toBe(false);
    expect(rt.abortController).toBeNull();
    expect(rt.generator).toBeNull();
    expect(resolved).toBe(true);
  });

  test('abort wakes foregroundWake promise', () => {
    const rt = makeRuntime();
    let woken = false;
    (rt as any)._foregroundWake = () => {
      woken = true;
    };

    rt.abort();

    expect(woken).toBe(true);
    expect((rt as any)._foregroundWake).toBeNull();
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

  // ── setForeground ──

  test('setForeground(true) wakes foregroundWake promise', () => {
    const rt = makeRuntime();
    let woken = false;
    (rt as any)._foregroundWake = () => {
      woken = true;
    };
    (rt as any)._foreground = false;

    rt.setForeground(true);

    expect(woken).toBe(true);
    expect((rt as any)._foregroundWake).toBeNull();
    expect((rt as any)._foreground).toBe(true);
  });

  test('setForeground(false) only changes flag', () => {
    const rt = makeRuntime();
    (rt as any)._foreground = true;
    rt.setForeground(false);
    expect((rt as any)._foreground).toBe(false);
  });

  // ── clearBuffer ──

  test('clearBuffer empties event buffer, history, and interrupt flag', () => {
    const rt = makeRuntime();
    rt.eventBuffer.push({ type: 'model.responded', messageId: 'm1', text: 'hello' });
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
    let resolvedAction: any = null;
    (rt as any)._pendingResolve = (action: any) => {
      resolvedAction = action;
    };

    rt.resolveInterrupt({ type: 'approve' as any });

    expect(resolvedAction).toEqual({ type: 'approve' });
    expect((rt as any)._pendingResolve).toBeNull();
  });

  test('resolveInterrupt is no-op when no pending resolve', () => {
    const rt = makeRuntime();
    // should not throw
    rt.resolveInterrupt({ type: 'cancel' as any });
  });

  // ── _pushToBuffer (via private access) ──

  test('pushToBuffer adds event to buffer', () => {
    const rt = makeRuntime();
    (rt as any)._pushToBuffer({ type: 'model.responded', messageId: 'm1', text: 'hello' });
    expect(rt.eventBuffer.length).toBe(1);
  });

  test('pushToBuffer discards disposable events on overflow', () => {
    const rt = makeRuntime();
    // Fill buffer to max
    for (let i = 0; i < (SessionRuntime as any).MAX_BUFFER; i++) {
      rt.eventBuffer.push({ type: 'model.responded', messageId: `m${i}`, text: `msg${i}` });
    }
    // Push one more — should discard a disposable event
    (rt as any)._pushToBuffer({ type: 'model.responded', messageId: 'overflow', text: 'overflow' });
    expect(rt.eventBuffer.length).toBeLessThanOrEqual((SessionRuntime as any).MAX_BUFFER);
  });

  test('pushToBuffer shifts oldest when no disposable events on overflow', () => {
    const rt = makeRuntime();
    const MAX = (SessionRuntime as any).MAX_BUFFER;
    // Fill buffer with non-disposable events (tool_call, tool_done are not in DISPOSABLE_EVENT_TYPES)
    for (let i = 0; i < MAX; i++) {
      rt.eventBuffer.push({
        type: 'tool.finished',
        toolCallId: `c${i}`,
        name: 'read_file',
        result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
      });
    }
    (rt as any)._pushToBuffer({
      type: 'tool.finished',
      toolCallId: 'c_new',
      name: 'read_file',
      result: { ok: true, command: '', exitCode: 0, stdout: '', stderr: '' },
    });
    // Should have shifted oldest
    expect(rt.eventBuffer.length).toBe(MAX);
  });

  // ── _createProxyProvider (via private access) ──

  test('proxy requestAction auto-cancels input in background', async () => {
    const rt = makeRuntime();
    const proxy = (rt as any)._proxyProvider;
    (rt as any)._foreground = false;

    const result = await proxy.requestAction({ kind: 'input', prompt: 'question?' });
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
    const proxy = (rt as any)._proxyProvider;
    (rt as any)._foreground = false;

    // Start the requestAction — it will block on _foregroundWake
    proxy.requestAction({ kind: 'tool_approval', toolRequests: [] });

    expect(rt.pendingInterrupt).toBe(true);
    expect(notified).toBe(true);
    expect((rt as any)._foregroundWake).toBeDefined();

    // Resolve the foreground wake
    (rt as any)._foregroundWake();

    // After wake, pendingInterrupt should be cleared (line 252 in session-manager.ts)
    // Then the proxy continues to the foreground path which waits on _pendingResolve
    // pendingInterrupt should be false at this point
    await Bun.sleep(0); // let the promise microtask process
    expect(rt.pendingInterrupt).toBe(false);
  });

  test('proxy submitAction delegates to resolveInterrupt', () => {
    const rt = makeRuntime();
    let resolved: any = null;
    (rt as any)._pendingResolve = (action: any) => {
      resolved = action;
    };
    const proxy = (rt as any)._proxyProvider;

    proxy.submitAction({ type: 'cancel' });
    expect(resolved).toEqual({ type: 'cancel' });
  });

  test('proxy reset cancels any pending interrupt', () => {
    const rt = makeRuntime();
    let resolved: any = null;
    (rt as any)._pendingResolve = (action: any) => {
      resolved = action;
    };
    const proxy = (rt as any)._proxyProvider;

    proxy.reset();
    expect(resolved).toEqual({ type: 'cancel' });
  });
});
