// ── Plan Mode v2 持久化测试 / Plan persistence tests ──
// 验证 plan 审批事件的原子持久化和跨进程恢复
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import {
  createInitialRuntimeState,
  getActivePlanning,
  RUNTIME_STATE_SCHEMA_VERSION,
} from '../../src/core/runtime/state';
import { createRuntimeStore } from '../../src/core/runtime/store';
import { createToolRecoveryJournalV1 } from '../../src/core/runtime/tool-recovery-journal';
import type { AgentPlan } from '../../src/protocol/events';
import type { SuspendedSubagentSnapshot } from '../../src/protocol/subagent';
import { currentPlanDraftedEvent } from '../helpers/current-plan';

const TEST_DB = '/tmp/test-plan-persistence.runtime.db';

function makePlan(name = 'Test'): AgentPlan {
  return {
    name,
    description: 'A test plan for persistence testing.',
    status: 'pending',
    steps: [{ id: 'step-1', step: 'Step 1', status: 'pending' }],
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
    toolRecovery: JSON.parse(JSON.stringify(createToolRecoveryJournalV1())),
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'nested-tool-persisted',
      toolName: 'shell_execute',
      args: { command: 'pwd' },
      command: 'pwd',
    },
  };
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
    let state = createInitialRuntimeState({
      threadId: 't1',
      userId: 'u1',
      workspace: '/tmp',
    });
    state = reduceRuntimeState(state, {
      type: 'task.started',
      taskId: 'persist-task',
      userGoal: 'Persist the current Plan state.',
      turnId: state.turn.turnId,
    });
    state = reduceRuntimeState(state, {
      type: 'planning.entered',
      taskId: 'persist-task',
      source: 'user_command',
    });
    expect(state.schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);

    const plan = makePlan();
    const drafted = currentPlanDraftedEvent({
      toolCallId: 'c1',
      planId: 'plan-persist',
      version: 1,
      plan,
      taskId: 'persist-task',
    });
    const events: RuntimeEvent[] = [
      drafted,
      {
        type: 'plan.review_requested',
        interactionId: 'inter-1',
        toolCallId: 'c2',
        taskId: 'persist-task',
        plan,
        planSummary: 'Review',
        planId: drafted.planId,
        version: drafted.version,
        structuralDigest: drafted.structuralHash,
        artifact: drafted.artifact,
      },
    ];

    const nextState = events.reduce(reduceRuntimeState, state);
    store.appendEventsAndSnapshot('t1', events, nextState);

    // Reload and verify
    const reloaded = store.loadSnapshot<typeof state>('t1');
    expect(reloaded).not.toBeNull();
    if (reloaded) {
      expect(reloaded.schemaVersion).toBe(RUNTIME_STATE_SCHEMA_VERSION);
      expect(getActivePlanning(reloaded).kind).toBe('awaiting_review');
    }

    const loadedEvents = store.loadEventsStrict('t1');
    expect(loadedEvents).toHaveLength(2);
    expect(loadedEvents[0]!.event.type).toBe('plan.drafted');
    expect(loadedEvents[1]!.event.type).toBe('plan.review_requested');

    store.close();
  });

  test('snapshot survives process restart simulation', () => {
    // Write
    {
      const store = createRuntimeStore(TEST_DB);
      let state = createInitialRuntimeState({
        threadId: 't2',
        userId: 'u1',
        workspace: '/tmp',
      });
      state = reduceRuntimeState(state, {
        type: 'task.started',
        taskId: 'survive-task',
        userGoal: 'Persist the current Plan across restart.',
        turnId: state.turn.turnId,
      });
      state = reduceRuntimeState(state, {
        type: 'planning.entered',
        taskId: 'survive-task',
        source: 'user_command',
      });
      const plan = makePlan();
      const e1 = currentPlanDraftedEvent({
        toolCallId: 'c1',
        planId: 'plan-survive',
        version: 1,
        plan,
        taskId: 'survive-task',
      });
      const s1 = reduceRuntimeState(state, e1);
      const e2: RuntimeEvent = {
        type: 'plan.review_requested',
        interactionId: 'inter-2',
        toolCallId: 'c2',
        taskId: 'survive-task',
        plan,
        planSummary: 'Review me',
        planId: e1.planId,
        version: e1.version,
        structuralDigest: e1.structuralHash,
        artifact: e1.artifact,
      };
      const s2 = reduceRuntimeState(s1, e2);
      store.appendEventsAndSnapshot('t2', [e1, e2], s2);
      store.close();
    }

    // Read — simulating process restart
    {
      const store = createRuntimeStore(TEST_DB);
      const reloaded = store.loadSnapshot('t2');
      expect(reloaded).not.toBeNull();
      const r = reloaded as ReturnType<typeof createInitialRuntimeState> | null;
      const planning = r ? getActivePlanning(r) : null;
      if (planning?.kind === 'awaiting_review') {
        expect(planning.interactionId).toBe('inter-2');
        expect(planning.document.title).toBe('Test');
      }
      store.close();
    }
  });

  test('suspended subagent snapshots survive persistence and reload', () => {
    const store = createRuntimeStore(TEST_DB);
    const snapshot = makeSuspendedSubagentSnapshot();
    const state = reduceRuntimeState(
      createInitialRuntimeState({ threadId: 't-suspended', userId: 'u1', workspace: '/tmp' }),
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

    store.appendEventsAndSnapshot('t-suspended', [], suspended);
    const reloaded = store.loadSnapshot('t-suspended');

    expect(reloaded).toMatchObject({
      schemaVersion: RUNTIME_STATE_SCHEMA_VERSION,
      suspendedSubagents: { 'task-persisted': snapshot },
    });
    store.close();
  });
});
