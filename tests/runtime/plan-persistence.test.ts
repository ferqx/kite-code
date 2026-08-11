// ── Plan Mode v2 持久化测试 / Plan persistence tests ──
// 验证 plan 审批事件的原子持久化和跨进程恢复
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { createAgentKernel } from '../../src/core/runtime/kernel';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import {
  computePlanStructuralDigest,
  createInitialRuntimeState,
  RUNTIME_STATE_SCHEMA_VERSION,
  type RuntimeState,
} from '../../src/core/runtime/state';
import { createRuntimeStore, type RuntimeStore } from '../../src/core/runtime/store';
import type { AgentPlan } from '../../src/protocol/events';
import type { SuspendedSubagentSnapshot } from '../../src/protocol/subagent';

const TEST_DB = '/tmp/test-plan-persistence.runtime.db';

function makePlan(name = 'Test'): AgentPlan {
  return {
    name,
    description: 'A test plan for persistence testing.',
    status: 'pending',
    steps: [{ step: 'Step 1', status: 'pending' }],
  };
}

function makeDigestInput(plan: AgentPlan) {
  return {
    title: plan.name.slice(0, 120),
    bodyMarkdown: plan.description,
    steps: plan.steps.map((s, i) => ({
      id: `step-${i + 1}`,
      title: s.step.slice(0, 160),
      status: 'pending' as const,
    })),
  };
}

function makeSuspendedSubagentSnapshot(): SuspendedSubagentSnapshot {
  return {
    subagentId: 'subagent-persisted',
    role: 'code',
    task: 'Persist my approval state',
    messages: [],
    toolCallCount: 2,
    steps: [],
    blockedTool: {
      toolCallId: 'nested-tool-persisted',
      toolName: 'shell_execute',
      args: { command: 'pwd' },
      command: 'pwd',
    },
  };
}

function persistSchema22Batch(
  store: RuntimeStore,
  threadId: string,
  events: RuntimeEvent[],
  state: RuntimeState,
): void {
  const identity = store.loadPersistenceIdentity(threadId);
  const baseRevision = identity.observedHead.revision;
  store.appendEventsAndSnapshot(
    threadId,
    events,
    { ...state, revision: baseRevision + events.length },
    events.map((_, index) => ({
      eventId: `${threadId}-event-${baseRevision + index + 1}`,
      revision: baseRevision + index + 1,
      occurredAt: new Date(index).toISOString(),
    })),
    undefined,
    identity,
  );
}

describe('plan persistence', () => {
  beforeEach(() => {
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
  });

  afterEach(() => {
    try {
      unlinkSync(TEST_DB);
    } catch {
      /* ok */
    }
  });

  test('appendEventsAndSnapshot atomically writes events + snapshot', () => {
    const store = createRuntimeStore(TEST_DB);
    const state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
      phase: 'planning',
    });
    expect(state.schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);

    const plan = makePlan();
    const events: RuntimeEvent[] = [
      {
        type: 'plan.drafted',
        toolCallId: 'c1',
        planId: 'plan-persist',
        version: 1,
        plan,
        structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
      },
      {
        type: 'plan.review_requested',
        interactionId: 'inter-1',
        toolCallId: 'c2',
        plan,
        planSummary: 'Review',
      },
    ];

    const nextState = events.reduce(reduceRuntimeState, state);
    persistSchema22Batch(store, 't1', events, nextState);

    // Reload and verify
    const reloaded = store.loadSnapshot<typeof state>('t1');
    expect(reloaded).not.toBeNull();
    if (reloaded) {
      expect(reloaded.schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(reloaded.planning.kind).toBe('awaiting_review');
    }

    const loadedEvents = store.loadEvents('t1');
    expect(loadedEvents).toHaveLength(2);
    expect(loadedEvents[0]!.event.type).toBe('plan.drafted');
    expect(loadedEvents[1]!.event.type).toBe('plan.review_requested');

    store.close();
  });

  test('snapshot survives process restart simulation', () => {
    // Write
    {
      const store = createRuntimeStore(TEST_DB);
      const state = createInitialRuntimeState({
        threadId: 't2',
        userId: 'u1',
        workspace: '/tmp',
        phase: 'planning',
      });
      const plan = makePlan();
      const e1: RuntimeEvent = {
        type: 'plan.drafted',
        toolCallId: 'c1',
        planId: 'plan-survive',
        version: 1,
        plan,
        structuralHash: computePlanStructuralDigest(makeDigestInput(plan)),
      };
      const s1 = reduceRuntimeState(state, e1);
      const e2: RuntimeEvent = {
        type: 'plan.review_requested',
        interactionId: 'inter-2',
        toolCallId: 'c2',
        plan,
        planSummary: 'Review me',
      };
      const s2 = reduceRuntimeState(s1, e2);
      persistSchema22Batch(store, 't2', [e1, e2], s2);
      store.close();
    }

    // Read — simulating process restart
    {
      const store = createRuntimeStore(TEST_DB);
      const reloaded = store.loadSnapshot('t2');
      expect(reloaded).not.toBeNull();
      const r = reloaded as ReturnType<typeof createInitialRuntimeState> | null;
      if (r && r.planning.kind === 'awaiting_review') {
        expect(r.planning.interactionId).toBe('inter-2');
        expect(r.planning.document.title).toBe('Test');
      }
      store.close();
    }
  });

  test('suspended subagent snapshots survive persistence and reload', () => {
    const store = createRuntimeStore(TEST_DB);
    const snapshot = makeSuspendedSubagentSnapshot();
    const state = reduceRuntimeState(
      createInitialRuntimeState({
        threadId: 't-suspended',
        userId: 'u1',
        workspace: '/tmp',
      }),
      {
        type: 'tool.queued',
        toolCallId: 'task-persisted',
        name: 'task',
        args: { task: snapshot.task },
      },
    );
    const suspended = reduceRuntimeState(state, {
      type: 'subagent.suspended',
      toolCallId: 'task-persisted',
      snapshot,
    });

    persistSchema22Batch(store, 't-suspended', [], suspended);
    const reloaded = store.loadSnapshot('t-suspended');

    expect(reloaded).toMatchObject({
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      suspendedSubagents: { 'task-persisted': snapshot },
    });
    store.close();
  });

  test('restores a persisted schema-2 snapshot instead of discarding its runtime state', () => {
    const store = createRuntimeStore(TEST_DB);
    const state = createInitialRuntimeState({
      threadId: 't3',
      userId: 'u1',
      workspace: '/tmp',
    });
    const queued = reduceRuntimeState(state, {
      type: 'tool.queued',
      toolCallId: 'legacy-read',
      name: 'read_file',
      args: { path: 'legacy.txt' },
    });
    const {
      suspendedSubagents: _suspended,
      legacyUnrecoverableSubagentApproval: _marker,
      ...v2
    } = queued;
    store.saveSnapshot('t3', { ...v2, schemaVersion: 2 });
    store.close();

    const kernel = createAgentKernel({
      threadId: 't3',
      userId: 'u1',
      workspace: '/tmp',
      storePath: TEST_DB,
    });
    expect(kernel.getState().schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
    expect(kernel.getState().tools.queue).toEqual(['legacy-read']);
    expect(kernel.getState().tools.calls['legacy-read']?.status).toBe('queued');
    expect(kernel.getState().suspendedSubagents).toEqual({});
    kernel.close();
  });
});
