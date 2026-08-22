// ── Plan Mode v2 持久化测试 / Plan persistence tests ──
// 验证 plan 审批事件的原子持久化和跨进程恢复
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RuntimeEvent } from '@kite/agent-kernel';
import type { AgentPlan } from '@kite/runtime-contract';
import {
  createRuntimeHostState25InitialStateV1,
  getActivePlanning,
  RUNTIME_STATE_SCHEMA_VERSION,
} from '@kite/runtime-host';
import type { DurableSuspendedSubagentV1 } from '@kite/runtime-spi';
import { reduceRuntimeState } from '#runtime-support/runtime-state25-reducer';
import { openState25Store4ForTestV1 } from '../../scripts/support/runtime-storage';
import { currentPlanDraftedEvent } from '../helpers/current-plan';

let testRoot: string;
let testDbPath: string;

function makePlan(name = 'Test'): AgentPlan {
  return {
    name,
    description: 'A test plan for persistence testing.',
    status: 'pending',
    steps: [{ id: 'step-1', step: 'Step 1', status: 'pending' }],
  };
}

function makeSuspendedSubagentSnapshot(): DurableSuspendedSubagentV1 {
  return {
    storage: 'private_artifact_v1',
    subagentId: 'subagent-persisted',
    role: 'code',
    continuationId: `continuation-${'a'.repeat(64)}`,
    modelInvocationOrdinal: 0,
    continuationArtifact: {
      artifactId: `pa_${'b'.repeat(64)}`,
      kind: 'subagent_continuation',
      integrityIdentifier: `hmac-sha256:${'c'.repeat(64)}`,
      byteLength: 1,
    },
    parentInvocationId: 'parent-invocation-persisted',
    parentAttempt: 1,
    blockedTool: {
      reasonCode: 'SUBAGENT_TOOL_REQUIRES_APPROVAL',
      toolCallId: 'nested-tool-persisted',
      toolName: 'shell_execute',
    },
  };
}

describe('plan persistence', () => {
  beforeEach(() => {
    testRoot = mkdtempSync(join(process.cwd(), '.kite-plan-persistence-'));
    testDbPath = join(testRoot, 'runtime.db');
  });

  afterEach(() => {
    rmSync(testRoot, { recursive: true, force: true });
  });

  test('appendEventsAndSnapshot atomically writes events + snapshot', () => {
    const store = openState25Store4ForTestV1(testDbPath);
    let state = createRuntimeHostState25InitialStateV1({
      recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      {
        type: 'tool.queued',
        toolCallId: 'c1',
        name: 'write_plan',
        args: { title: plan.name },
      },
      drafted,
      {
        type: 'plan.review_requested',
        interactionId: 'inter-1',
        toolCallId: 'c1',
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
    expect(loadedEvents).toHaveLength(3);
    expect(loadedEvents[0]!.event.type).toBe('tool.queued');
    expect(loadedEvents[1]!.event.type).toBe('plan.drafted');
    expect(loadedEvents[2]!.event.type).toBe('plan.review_requested');

    store.close();
  });

  test('snapshot survives process restart simulation', () => {
    // Write
    {
      const store = openState25Store4ForTestV1(testDbPath);
      let state = createRuntimeHostState25InitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
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
      const queued: RuntimeEvent = {
        type: 'tool.queued',
        toolCallId: 'c1',
        name: 'write_plan',
        args: { title: 'Test' },
      };
      state = reduceRuntimeState(state, queued);
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
        toolCallId: 'c1',
        taskId: 'survive-task',
        plan,
        planSummary: 'Review me',
        planId: e1.planId,
        version: e1.version,
        structuralDigest: e1.structuralHash,
        artifact: e1.artifact,
      };
      const s2 = reduceRuntimeState(s1, e2);
      store.appendEventsAndSnapshot('t2', [queued, e1, e2], s2);
      store.close();
    }

    // Read — simulating process restart
    {
      const store = openState25Store4ForTestV1(testDbPath);
      const reloaded = store.loadSnapshot('t2');
      expect(reloaded).not.toBeNull();
      const r = reloaded as ReturnType<typeof createRuntimeHostState25InitialStateV1> | null;
      const planning = r ? getActivePlanning(r) : null;
      if (planning?.kind === 'awaiting_review') {
        expect(planning.interactionId).toBe('inter-2');
        expect(planning.document.title).toBe('Test');
      }
      store.close();
    }
  });

  test('suspended subagent snapshots survive persistence and reload', () => {
    const store = openState25Store4ForTestV1(testDbPath);
    const snapshot = makeSuspendedSubagentSnapshot();
    const state = reduceRuntimeState(
      createRuntimeHostState25InitialStateV1({
        recoveryIdentityKey: '0000000000000000000000000000000000000000000000000000000000000000',
        threadId: 't-suspended',
        userId: 'u1',
        workspace: '/tmp',
      }),
      {
        type: 'tool.queued',
        toolCallId: 'task-persisted',
        name: 'task',
        args: { task: 'Persist my approval state' },
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
