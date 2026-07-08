import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { reduceRuntimeState } from '../../src/core/runtime/reducer';
import type { RuntimeState } from '../../src/core/runtime/state';
import { computePlanStructuralHash, createInitialRuntimeState } from '../../src/core/runtime/state';
import type { AgentPlan, AgentPlanStep } from '../../src/protocol/events';

// ── 测试辅助函数 / Test helpers ──

function makePlan(name: string = 'Test Plan', steps: string[] = ['step 1', 'step 2']): AgentPlan {
  const planSteps: AgentPlanStep[] = steps.map((step) => ({
    step,
    status: 'pending' as const,
  }));
  return {
    name,
    description: 'A test plan for unit testing',
    status: 'pending',
    steps: planSteps,
  };
}

function makeInitialState(overrides?: Partial<RuntimeState>): RuntimeState {
  const base = createInitialRuntimeState({
    threadId: 'thread-1',
    userId: 'user-1',
    workspace: '/tmp/test',
  });
  if (!overrides) return base;
  return { ...base, ...overrides };
}

function uuidPattern() {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
}

// ── 方案生命周期 / Plan lifecycle ──

describe('reduceRuntimeState — plan lifecycle', () => {
  // 验证 plan.review_requested 从'none'状态创建 awaiting_review
  test('plan.review_requested creates awaiting_review from none', () => {
    const state = makeInitialState();
    const plan = makePlan('My Plan', ['do a', 'do b']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-1',
      toolCallId: 'call-1',
      plan,
      planSummary: 'A plan to do a then b',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.plan.kind).toBe('awaiting_review');
    if (next.plan.kind === 'awaiting_review') {
      expect(next.plan.planId).toMatch(uuidPattern());
      expect(next.plan.version).toBe(1);
      expect(next.plan.draft).toBe(plan);
      expect(next.plan.structuralHash).toBe(computePlanStructuralHash(plan));
      expect(next.plan.interactionId).toBe('inter-1');
      expect(next.plan.toolCallId).toBe('call-1');
    }
    expect(next.interactions.kind).toBe('awaiting_plan_review');
    if (next.interactions.kind === 'awaiting_plan_review') {
      expect(next.interactions.interactionId).toBe('inter-1');
      expect(next.interactions.toolCallId).toBe('call-1');
      expect(next.interactions.plan).toBe(plan);
      expect(next.interactions.planSummary).toBe('A plan to do a then b');
    }
  });

  // 验证 plan.review_requested 从 drafted 继承 planId 并递增 version
  test('plan.review_requested inherits planId and increments version from drafted', () => {
    const draftPlan = makePlan('Draft Plan', ['x', 'y']);
    const state: RuntimeState = {
      ...makeInitialState(),
      plan: {
        kind: 'drafted',
        planId: 'existing-plan-id',
        version: 3,
        draft: draftPlan,
        structuralHash: computePlanStructuralHash(draftPlan),
      },
    };
    const newPlan = makePlan('Draft Plan V2', ['x', 'y', 'z']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-2',
      toolCallId: 'call-2',
      plan: newPlan,
      planSummary: 'Updated plan',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.plan.kind).toBe('awaiting_review');
    if (next.plan.kind === 'awaiting_review') {
      expect(next.plan.planId).toBe('existing-plan-id');
      expect(next.plan.version).toBe(4);
      expect(next.plan.draft).toBe(newPlan);
    }
  });

  // 验证 plan.review_requested 从 needs_revision 继承 planId 并递增 version
  test('plan.review_requested inherits planId and increments version from needs_revision', () => {
    const revPlan = makePlan('Rev Plan', ['a']);
    const state: RuntimeState = {
      ...makeInitialState(),
      plan: {
        kind: 'needs_revision',
        planId: 'rev-plan-id',
        version: 5,
        draft: revPlan,
        reason: 'too vague',
      },
    };
    const newPlan = makePlan('Rev Plan V2', ['a', 'b']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-3',
      toolCallId: 'call-3',
      plan: newPlan,
      planSummary: 'Revised plan',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.plan.kind).toBe('awaiting_review');
    if (next.plan.kind === 'awaiting_review') {
      expect(next.plan.planId).toBe('rev-plan-id');
      expect(next.plan.version).toBe(6);
      expect(next.plan.draft).toBe(newPlan);
    }
  });

  // 验证 plan.approved 将 awaiting_review 转为 approved
  test('plan.approved transitions awaiting_review to approved', () => {
    const plan = makePlan('Approval Plan', ['step 1']);
    const structuralHash = computePlanStructuralHash(plan);
    const state: RuntimeState = {
      ...makeInitialState(),
      plan: {
        kind: 'awaiting_review',
        planId: 'plan-99',
        version: 2,
        draft: plan,
        structuralHash,
        interactionId: 'inter-99',
        toolCallId: 'call-99',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.approved',
      interactionId: 'inter-99',
      executionMode: 'auto',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.plan.kind).toBe('approved');
    if (next.plan.kind === 'approved') {
      expect(next.plan.planId).toBe('plan-99');
      expect(next.plan.version).toBe(2);
      expect(next.plan.plan).toBe(plan);
      expect(next.plan.structuralHash).toBe(structuralHash);
      expect(next.plan.approvedAtTurnId).toBe(state.turn.turnId);
      expect(next.plan.executionMode).toBe('auto');
    }
    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 plan.approved 在非 awaiting_review 状态时为 no-op（保留原有 plan）
  test('plan.approved is no-op when plan is not awaiting_review', () => {
    const state = makeInitialState(); // plan.kind === 'none'
    const event: RuntimeEvent = {
      type: 'plan.approved',
      interactionId: 'inter-99',
      executionMode: 'manual',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.plan.kind).toBe('none');
    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 plan.revision_requested 转为 needs_revision
  test('plan.revision_requested transitions to needs_revision', () => {
    const plan = makePlan('Needs Fix', ['bad step']);
    const structuralHash = computePlanStructuralHash(plan);
    const state: RuntimeState = {
      ...makeInitialState(),
      plan: {
        kind: 'awaiting_review',
        planId: 'plan-fix',
        version: 1,
        draft: plan,
        structuralHash,
        interactionId: 'inter-fix',
        toolCallId: 'call-fix',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.revision_requested',
      interactionId: 'inter-fix',
      feedback: 'Please add more detail to step 1',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.plan.kind).toBe('needs_revision');
    if (next.plan.kind === 'needs_revision') {
      expect(next.plan.planId).toBe('plan-fix');
      expect(next.plan.version).toBe(1);
      expect(next.plan.draft).toBe(plan);
      expect(next.plan.reason).toBe('Please add more detail to step 1');
    }
    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 plan.rejected 重置 plan 为 none
  test('plan.rejected resets plan to none and clears interactions', () => {
    const plan = makePlan('Rejected Plan', ['doom']);
    const state: RuntimeState = {
      ...makeInitialState(),
      plan: {
        kind: 'awaiting_review',
        planId: 'plan-doom',
        version: 1,
        draft: plan,
        structuralHash: computePlanStructuralHash(plan),
        interactionId: 'inter-doom',
        toolCallId: 'call-doom',
      },
    };
    const event: RuntimeEvent = {
      type: 'plan.rejected',
      interactionId: 'inter-doom',
      reason: 'Not what I want',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.plan.kind).toBe('none');
    expect(next.interactions.kind).toBe('idle');
  });
});

// ── 工具生命周期 / Tool lifecycle ──

describe('reduceRuntimeState — tool lifecycle', () => {
  // 验证 tool.queued 将工具入队
  test('tool.queued adds tool call to queue with queued status', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'tool.queued',
      toolCallId: 'tool-1',
      name: 'shell_execute',
      args: { command: 'echo hello' },
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual(['tool-1']);
    expect(next.tools.calls['tool-1']).toBeDefined();
    const call = next.tools.calls['tool-1']!;
    expect(call.toolCallId).toBe('tool-1');
    expect(call.name).toBe('shell_execute');
    expect(call.args).toEqual({ command: 'echo hello' });
    expect(call.status).toBe('queued');
    expect(call.createdAtTurnId).toBe(state.turn.turnId);
  });

  // 验证 tool.started 从队列移到活跃列表并设为 running
  test('tool.started moves tool from queue to active with running status', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'tool-1': {
            toolCallId: 'tool-1',
            modelMessageId: '',
            name: 'shell_execute',
            args: { command: 'ls' },
            status: 'queued',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: ['tool-1'],
        active: [],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.started',
      toolCallId: 'tool-1',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual([]);
    expect(next.tools.active).toEqual(['tool-1']);
    expect(next.tools.calls['tool-1']!.status).toBe('running');
  });

  // 验证 tool.started 对不存在的 toolCallId 静默忽略
  test('tool.started is no-op for unknown toolCallId', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'tool.started',
      toolCallId: 'nonexistent',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual([]);
    expect(next.tools.active).toEqual([]);
    expect(next.tools.calls).toEqual({});
    // 不可变：应该返回原引用（因为没有修改）
    expect(next.tools).toBe(state.tools);
  });

  // 验证 tool.finished 设置 succeeded 并移除活跃
  test('tool.finished sets succeeded status and removes from active', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'tool-2': {
            toolCallId: 'tool-2',
            modelMessageId: '',
            name: 'shell_execute',
            args: { command: 'pwd' },
            status: 'running',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: [],
        active: ['tool-2'],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'tool-2',
      result: {
        ok: true,
        command: 'pwd',
        exitCode: 0,
        stdout: '/home/user\n',
        stderr: '',
      },
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.active).toEqual([]);
    const call = next.tools.calls['tool-2']!;
    expect(call.status).toBe('succeeded');
    expect(call.result).toBeDefined();
    expect(call.result!.ok).toBe(true);
    expect(call.result!.exitCode).toBe(0);
    expect(call.result!.summary).toContain('pwd');
  });

  // 验证 tool.finished 对不存在的 toolCallId 静默忽略
  test('tool.finished is no-op for unknown toolCallId', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'nonexistent',
      result: { ok: false, command: 'x', exitCode: 1, stdout: '', stderr: 'err' },
    };

    const next = reduceRuntimeState(state, event);

    expect(next).toEqual(state);
  });

  // 验证 tool.failed 设置 failed 状态和错误信息
  test('tool.failed sets failed status with error message', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'tool-3': {
            toolCallId: 'tool-3',
            modelMessageId: '',
            name: 'shell_execute',
            args: { command: 'rm -rf /' },
            status: 'running',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: [],
        active: ['tool-3'],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.failed',
      toolCallId: 'tool-3',
      error: 'permission denied',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.active).toEqual([]);
    expect(next.tools.calls['tool-3']!.status).toBe('failed');
    expect(next.tools.calls['tool-3']!.error).toBe('permission denied');
    expect(next.tools.calls['tool-3']!.result).toBeUndefined();
  });

  // 验证 tool.rejected 移除队列和活跃列表，设置 rejected 状态
  test('tool.rejected removes from queue/active and sets rejected status', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {
          'tool-4': {
            toolCallId: 'tool-4',
            modelMessageId: '',
            name: 'shell_execute',
            args: { command: 'sudo rm -rf /' },
            status: 'queued',
            createdAtTurnId: 'turn-0',
          },
          'tool-5': {
            toolCallId: 'tool-5',
            modelMessageId: '',
            name: 'write_file',
            args: { path: '/etc/hosts', content: 'x' },
            status: 'queued',
            createdAtTurnId: 'turn-0',
          },
        },
        queue: ['tool-4', 'tool-5'],
        active: [],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.rejected',
      toolCallId: 'tool-4',
      reason: 'destructive operation denied',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual(['tool-5']);
    expect(next.tools.active).toEqual([]);
    expect(next.tools.calls['tool-4']!.status).toBe('rejected');
    expect(next.tools.calls['tool-5']!.status).toBe('queued'); // 其他工具不受影响
  });

  // 验证 tool.rejected 对不存在记录的工具也能从队列中移除
  test('tool.rejected removes from queue even when call record is absent', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      tools: {
        calls: {},
        queue: ['ghost-tool'],
        active: [],
      },
    };
    const event: RuntimeEvent = {
      type: 'tool.rejected',
      toolCallId: 'ghost-tool',
      reason: 'blocked by policy',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.tools.queue).toEqual([]);
    expect(next.tools.calls).toEqual({});
  });

  // 验证 tool.progress 不修改 state
  test('tool.progress does not modify state', () => {
    const state = makeInitialState();
    const event: RuntimeEvent = {
      type: 'tool.progress',
      toolCallId: 'tool-1',
      chunk: 'hello\n',
      stream: 'stdout',
    };

    const next = reduceRuntimeState(state, event);

    expect(next).toEqual(state);
  });
});

// ── 交互状态 / Interaction state ──

describe('reduceRuntimeState — interaction state', () => {
  // 验证 user_input.requested 设置 awaiting_user_input 交互
  test('user_input.requested sets awaiting_user_input interaction', () => {
    const state = makeInitialState();
    const requestPayload = {
      question: 'Which file should I edit?',
      options: [{ id: '1', label: 'file A' }],
      allow_free_text: true,
    };
    const event: RuntimeEvent = {
      type: 'user_input.requested',
      interactionId: 'ui-1',
      toolCallId: 'ask-1',
      request: requestPayload,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('awaiting_user_input');
    if (next.interactions.kind === 'awaiting_user_input') {
      expect(next.interactions.interactionId).toBe('ui-1');
      expect(next.interactions.toolCallId).toBe('ask-1');
      expect(next.interactions.request).toBe(requestPayload);
    }
  });

  // 验证 user_input.answered 清除交互回 idle
  test('user_input.answered clears interaction back to idle', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      interactions: {
        kind: 'awaiting_user_input',
        interactionId: 'ui-1',
        toolCallId: 'ask-1',
        request: {
          question: 'Q?',
          options: [],
          allow_free_text: true,
        },
      },
    };
    const event: RuntimeEvent = {
      type: 'user_input.answered',
      interactionId: 'ui-1',
      answer: 'file A',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 approval.requested 设置 awaiting_tool_approval 交互
  test('approval.requested sets awaiting_tool_approval interaction', () => {
    const state = makeInitialState();
    const approvalPayload = {
      scope: 'once' as const,
      cwd: '/tmp',
      threadId: 'thread-1',
      tool: 'shell_execute',
      command: 'npm install',
      risk: 'execute_code' as const,
      approvalHash: 'abc123',
      summary: 'Run npm install in /tmp',
      reason: 'Model wants to install dependencies',
      expectedEffects: ['Installs npm packages'],
      grantOptions: ['approve_once' as const],
      recommendedGrant: 'approve_once' as const,
    };
    const event: RuntimeEvent = {
      type: 'approval.requested',
      interactionId: 'approval-1',
      toolCallId: 'tool-10',
      approval: approvalPayload,
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('awaiting_tool_approval');
    if (next.interactions.kind === 'awaiting_tool_approval') {
      expect(next.interactions.interactionId).toBe('approval-1');
      expect(next.interactions.toolCallId).toBe('tool-10');
      expect(next.interactions.approval).toBe(approvalPayload);
    }
  });

  // 验证 approval.granted 清除交互回 idle
  test('approval.granted clears interaction back to idle', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-1',
        toolCallId: 'tool-10',
        approval: {
          scope: 'once',
          cwd: '/tmp',
          threadId: 'thread-1',
          tool: 'shell_execute',
          command: 'npm install',
          risk: 'execute_code' as const,
          approvalHash: 'abc',
          summary: 'install',
          reason: 'need deps',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      },
    };
    const event: RuntimeEvent = {
      type: 'approval.granted',
      interactionId: 'approval-1',
      grant: 'approve_once',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('idle');
  });

  // 验证 approval.rejected 清除交互回 idle
  test('approval.rejected clears interaction back to idle', () => {
    const state: RuntimeState = {
      ...makeInitialState(),
      interactions: {
        kind: 'awaiting_tool_approval',
        interactionId: 'approval-2',
        toolCallId: 'tool-11',
        approval: {
          scope: 'once',
          cwd: '/tmp',
          threadId: 'thread-1',
          tool: 'shell_execute',
          command: 'rm -rf /',
          risk: 'destructive' as const,
          approvalHash: 'xyz',
          summary: 'delete all',
          reason: 'cleanup',
          expectedEffects: [],
          grantOptions: ['approve_once'],
          recommendedGrant: 'approve_once',
        },
      },
    };
    const event: RuntimeEvent = {
      type: 'approval.rejected',
      interactionId: 'approval-2',
      reason: 'too dangerous',
    };

    const next = reduceRuntimeState(state, event);

    expect(next.interactions.kind).toBe('idle');
  });
});

// ── 不可变性 / Immutability ──

describe('reduceRuntimeState — immutability', () => {
  // 验证 reduce 不修改原始状态
  test('original state is unchanged after reduce', () => {
    const state = makeInitialState();
    const plan = makePlan('Immutable Plan', ['do x']);
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-imm',
      toolCallId: 'call-imm',
      plan,
      planSummary: 'Immutable plan summary',
    };

    const originalPlanKind = state.plan.kind;
    const originalInteractionKind = state.interactions.kind;

    reduceRuntimeState(state, event);

    expect(state.plan.kind).toBe(originalPlanKind);
    expect(state.interactions.kind).toBe(originalInteractionKind);
  });

  // 验证 tool 操作不修改原始 calls/queue/active 对象
  test('tool operations do not mutate original calls/queue/active', () => {
    const state = makeInitialState();
    const originalCalls = state.tools.calls;
    const originalQueue = state.tools.queue;
    const originalActive = state.tools.active;

    const queued: RuntimeEvent = {
      type: 'tool.queued',
      toolCallId: 'tool-mut',
      name: 'read_file',
      args: { path: 'test.txt' },
    };
    const s1 = reduceRuntimeState(state, queued);
    expect(state.tools.calls).toBe(originalCalls);
    expect(state.tools.queue).toBe(originalQueue);
    expect(Object.keys(state.tools.calls)).toHaveLength(0);
    expect(state.tools.queue).toHaveLength(0);

    const started: RuntimeEvent = {
      type: 'tool.started',
      toolCallId: 'tool-mut',
    };
    const callsBeforeStart = s1.tools.calls;
    const queueBeforeStart = s1.tools.queue;
    const s2 = reduceRuntimeState(s1, started);
    expect(s1.tools.calls).toBe(callsBeforeStart);
    expect(s1.tools.queue).toBe(queueBeforeStart);
    expect(s1.tools.calls['tool-mut']!.status).toBe('queued');

    const finished: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'tool-mut',
      result: { ok: true, command: 'cat test.txt', exitCode: 0, stdout: '', stderr: '' },
    };
    const activeBeforeFinish = s2.tools.active;
    const s3 = reduceRuntimeState(s2, finished);
    expect(s2.tools.active).toBe(activeBeforeFinish);
    expect(s2.tools.active).toContain('tool-mut');

    expect(state.tools.active).toBe(originalActive);
    expect(s3.tools.calls['tool-mut']!.status).toBe('succeeded');
  });

  // 验证多次 reduce 链的不可变性
  test('each reduce step returns a new state object', () => {
    const state = makeInitialState();

    const e1: RuntimeEvent = {
      type: 'user_input.requested',
      interactionId: 'chain-1',
      toolCallId: 'chain-tool',
      request: {
        question: 'Chain Q?',
        options: [],
        allow_free_text: true,
      },
    };
    const s1 = reduceRuntimeState(state, e1);
    expect(s1).not.toBe(state);
    expect(s1.interactions).not.toBe(state.interactions);
    expect(s1.plan).toBe(state.plan); // plan 未变，结构共享

    const e2: RuntimeEvent = {
      type: 'user_input.answered',
      interactionId: 'chain-1',
      answer: 'chain answer',
    };
    const s2 = reduceRuntimeState(s1, e2);
    expect(s2).not.toBe(s1);
    expect(s2.interactions).not.toBe(s1.interactions);
  });
});
