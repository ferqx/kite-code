// ── RuntimeEvent → AgentEvent 投影测试 / Projection tests ──
// 验证 projectRuntimeEventToAgentEvent 将所有 RuntimeEvent 类型正确映射为 AgentEvent

import { describe, expect, test } from 'bun:test';
import type { RuntimeEvent } from '../../src/core/runtime/events';
import { projectRuntimeEventToAgentEvent } from '../../src/core/runtime/projection';
import type {
  NeedPlanReviewPayload,
  ToolCallPayload,
  ToolProgressPayload,
  ToolResultPayload,
  ToolStartedPayload,
} from '../../src/protocol/events';

// ── 工具生命周期投影 / Tool lifecycle projection ──

describe('projectRuntimeEventToAgentEvent — tool lifecycle', () => {
  // 验证 tool.queued 投影为 queued tool_call
  test('tool.queued projects to queued tool_call', () => {
    const event: RuntimeEvent = {
      type: 'tool.queued',
      toolCallId: 'call-1',
      name: 'shell_execute',
      args: { command: 'ls', cwd: '/tmp' },
    };

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('tool_call');
    expect((result[0]!.data as ToolCallPayload).call_id).toBe('call-1');
    expect((result[0]!.data as ToolCallPayload).name).toBe('shell_execute');
    expect((result[0]!.data as ToolCallPayload).args).toEqual({ command: 'ls', cwd: '/tmp' });
    expect((result[0]!.data as ToolCallPayload).status).toBe('queued');
  });

  // 验证 tool.started 投影为 tool_started
  test('tool.started projects to tool_started', () => {
    const event: RuntimeEvent = {
      type: 'tool.started',
      toolCallId: 'call-1',
    };

    const result = projectRuntimeEventToAgentEvent(event);
    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('tool_started');
    expect((result[0]!.data as ToolStartedPayload).call_id).toBe('call-1');
  });

  // 验证 tool.progress 投影为 tool_progress
  test('tool.progress projects to tool_progress', () => {
    const event: RuntimeEvent = {
      type: 'tool.progress',
      toolCallId: 'call-2',
      chunk: 'line of output\n',
      stream: 'stdout',
    };

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('tool_progress');
    expect((result[0]!.data as ToolProgressPayload).call_id).toBe('call-2');
    expect((result[0]!.data as ToolProgressPayload).chunk).toBe('line of output\n');
    expect((result[0]!.data as ToolProgressPayload).stream).toBe('stdout');
  });

  // 验证 tool.finished 投影为 tool_done (ok: true)
  test('tool.finished projects to tool_done with ok: true', () => {
    const event: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'call-3',
      name: 'shell_execute',
      result: {
        ok: true,
        command: 'echo hello',
        exitCode: 0,
        stdout: 'hello\n',
        stderr: '',
        totalLines: 0,
      },
    };

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('tool_done');
    expect((result[0]!.data as ToolResultPayload).call_id).toBe('call-3');
    expect((result[0]!.data as ToolResultPayload).name).toBe('shell_execute');
    expect((result[0]!.data as ToolResultPayload).ok).toBe(true);
    expect((result[0]!.data as ToolResultPayload).exitCode).toBe(0);
    expect((result[0]!.data as ToolResultPayload).totalLines).toBe(0);
  });

  // 验证 tool.finished 投影包含 exitCode (非 null)
  test('tool.finished projection includes status field when present', () => {
    const event: RuntimeEvent = {
      type: 'tool.finished',
      toolCallId: 'call-status',
      name: 'shell_execute',
      result: {
        ok: false,
        command: 'bad-command',
        exitCode: 1,
        stdout: '',
        stderr: 'error output',
        status: 'error' as const,
      },
    };

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('tool_done');
    expect((result[0]!.data as ToolResultPayload).ok).toBe(false);
    expect((result[0]!.data as ToolResultPayload).exitCode).toBe(1);
    expect((result[0]!.data as ToolResultPayload).status).toBe('error');
  });

  // 验证 tool.failed 投影为 tool_done (ok: false)
  test('tool.failed projects to tool_done with ok: false', () => {
    const event: RuntimeEvent = {
      type: 'tool.failed',
      toolCallId: 'call-4',
      error: 'command not found: xyz',
    };

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('tool_done');
    expect((result[0]!.data as ToolResultPayload).call_id).toBe('call-4');
    expect((result[0]!.data as ToolResultPayload).ok).toBe(false);
    expect((result[0]!.data as ToolResultPayload).summary).toBe('command not found: xyz');
  });

  // 验证 tool.rejected 投影为 tool_done (ok: false)
  test('tool.rejected projects to tool_done with ok: false', () => {
    const event: RuntimeEvent = {
      type: 'tool.rejected',
      toolCallId: 'call-5',
      reason: 'destructive operation denied by policy',
    };

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('tool_done');
    expect((result[0]!.data as ToolResultPayload).call_id).toBe('call-5');
    expect((result[0]!.data as ToolResultPayload).ok).toBe(false);
    expect((result[0]!.data as ToolResultPayload).summary).toBe(
      'destructive operation denied by policy',
    );
  });
});

// ── 用户输入交互投影 / User input interaction projection ──

describe('projectRuntimeEventToAgentEvent — user input', () => {
  // 验证 user_input.requested 投影为 need_input
  test('user_input.requested projects to need_input', () => {
    const requestPayload = {
      question: 'Which file should I edit?',
      options: [
        { id: '1', label: 'file-a.ts' },
        { id: '2', label: 'file-b.ts' },
      ],
      allow_free_text: true,
    };
    const event: RuntimeEvent = {
      type: 'user_input.requested',
      interactionId: 'inter-1',
      toolCallId: 'ask-1',
      request: requestPayload,
    };

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('need_input');
    expect(result[0]!.data).toBe(requestPayload);
  });

  // 验证 user_input.answered 投影为空数组
  test('user_input.answered projects to []', () => {
    const event: RuntimeEvent = {
      type: 'user_input.answered',
      interactionId: 'inter-1',
      answer: 'file-a.ts',
    };

    const result = projectRuntimeEventToAgentEvent(event);
    expect(result).toEqual([]);
  });
});

// ── 方案审核交互投影 / Plan review interaction projection ──

describe('projectRuntimeEventToAgentEvent — plan review', () => {
  // 验证 plan.review_requested 投影为 need_plan_review
  test('plan.review_requested projects to need_plan_review', () => {
    const plan = {
      name: 'Test Plan',
      description: 'A test plan',
      status: 'pending' as const,
      steps: [
        { step: 'Step 1', status: 'pending' as const },
        { step: 'Step 2', status: 'pending' as const },
      ],
    };
    const event: RuntimeEvent = {
      type: 'plan.review_requested',
      interactionId: 'inter-2',
      toolCallId: 'plan-tool-1',
      plan,
      planSummary: 'A plan with 2 steps',
    };

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('need_plan_review');
    expect((result[0]!.data as NeedPlanReviewPayload).plan).toBe(plan);
  });

  // 验证 plan.approved 投影为空数组
  test('plan.approved projects to []', () => {
    const event: RuntimeEvent = {
      type: 'plan.approved',
      interactionId: 'inter-2',
      executionMode: 'auto',
    };

    const result = projectRuntimeEventToAgentEvent(event);
    expect(result).toEqual([]);
  });

  // 验证 plan.revision_requested 投影为空数组
  test('plan.revision_requested projects to []', () => {
    const event: RuntimeEvent = {
      type: 'plan.revision_requested',
      interactionId: 'inter-2',
      feedback: 'Please add more detail',
    };

    const result = projectRuntimeEventToAgentEvent(event);
    expect(result).toEqual([]);
  });

  // 验证 plan.rejected 投影为空数组
  test('plan.rejected projects to []', () => {
    const event: RuntimeEvent = {
      type: 'plan.rejected',
      interactionId: 'inter-2',
      reason: 'Not what I wanted',
    };

    const result = projectRuntimeEventToAgentEvent(event);
    expect(result).toEqual([]);
  });
});

// ── 工具审批交互投影 / Approval interaction projection ──

describe('projectRuntimeEventToAgentEvent — approval', () => {
  // 验证 approval.requested 投影为 need_approval
  test('approval.requested projects to need_approval', () => {
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

    const result = projectRuntimeEventToAgentEvent(event);

    expect(result.length).toBe(1);
    expect(result[0]!.type).toBe('need_approval');
    expect(result[0]!.data).toBe(approvalPayload);
  });

  // 验证 approval.granted 投影为空数组
  test('approval.granted projects to []', () => {
    const event: RuntimeEvent = {
      type: 'approval.granted',
      interactionId: 'approval-1',
      grant: 'approve_once',
    };

    const result = projectRuntimeEventToAgentEvent(event);
    expect(result).toEqual([]);
  });

  // 验证 approval.rejected 投影为空数组
  test('approval.rejected projects to []', () => {
    const event: RuntimeEvent = {
      type: 'approval.rejected',
      interactionId: 'approval-1',
      reason: 'too dangerous',
    };

    const result = projectRuntimeEventToAgentEvent(event);
    expect(result).toEqual([]);
  });
});

// ── 信息性事件投影 / Informational event projection ──
// 这些事件不投影为任何 TUI 可见的 AgentEvent

describe('projectRuntimeEventToAgentEvent — informational events', () => {
  // 验证 authorization.changed 投影为空数组
  test('authorization.changed projects to []', () => {
    const event: RuntimeEvent = {
      type: 'authorization.changed',
      mode: 'full_access',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 phase.changed 投影为空数组
  test('phase.changed projects to []', () => {
    const event: RuntimeEvent = {
      type: 'phase.changed',
      phase: 'building',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 turn.started 投影为空数组
  test('turn.started projects to []', () => {
    const event: RuntimeEvent = {
      type: 'turn.started',
      turnId: 'turn-1',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 turn.completed 投影为空数组
  test('turn.completed projects to []', () => {
    const event: RuntimeEvent = {
      type: 'turn.completed',
      turnId: 'turn-1',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 turn.aborted 投影为空数组
  test('turn.aborted projects to []', () => {
    const event: RuntimeEvent = {
      type: 'turn.aborted',
      turnId: 'turn-1',
      reason: 'user cancelled',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 user.message_appended 投影为空数组
  test('user.message_appended projects to []', () => {
    const event: RuntimeEvent = {
      type: 'user.message_appended',
      messageId: 'msg-1',
      content: 'Hello',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 model.requested 投影为空数组
  test('model.requested projects to []', () => {
    const event: RuntimeEvent = {
      type: 'model.requested',
      requestId: 'req-1',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 model.responded 直接投影 assistant text，避免文本落后于后续工具事件
  test('model.responded with text projects to text event', () => {
    const event: RuntimeEvent = {
      type: 'model.responded',
      messageId: 'msg-2',
      text: 'Task completed successfully.',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([
      { type: 'text', data: { text: 'Task completed successfully.' } },
    ]);
  });

  test('model.responded with reasoning and text preserves model output order', () => {
    const event: RuntimeEvent = {
      type: 'model.responded',
      messageId: 'msg-reason',
      reasoningText: 'Thinking through the next step.',
      text: 'I will inspect the file.',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([
      { type: 'reason', data: { text: 'Thinking through the next step.' } },
      { type: 'text', data: { text: 'I will inspect the file.' } },
    ]);
  });

  // 验证 model.responded 仅投影文本；tool_call 仍由 tool.queued 生命周期事件负责
  test('model.responded with text and toolCalls projects text only', () => {
    const event: RuntimeEvent = {
      type: 'model.responded',
      messageId: 'msg-3',
      text: 'I will inspect the file.',
      toolCalls: [{ id: 'call-x', name: 'read_file', args: { path: 'test.txt' } }],
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([
      { type: 'text', data: { text: 'I will inspect the file.' } },
    ]);
  });

  // 验证 plan.drafted 投影为空数组
  test('plan.drafted projects to []', () => {
    const event: RuntimeEvent = {
      type: 'plan.drafted',
      toolCallId: 'call-draft',
      plan: {
        name: 'Draft',
        description: 'draft',
        status: 'pending',
        steps: [],
      },
      structuralHash: 'abc',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 plan.progress_updated 投影为空数组
  test('plan.progress_updated projects to []', () => {
    const event: RuntimeEvent = {
      type: 'plan.progress_updated',
      toolCallId: 'call-progress',
      plan: {
        name: 'Progress',
        description: 'progress',
        status: 'in_progress',
        steps: [],
      },
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 plan.completed 投影为空数组
  test('plan.completed projects to []', () => {
    const event: RuntimeEvent = {
      type: 'plan.completed',
      toolCallId: 'call-complete',
      plan: {
        name: 'Complete',
        description: 'complete',
        status: 'completed',
        steps: [],
      },
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 approval.command_replaced 投影为空数组
  test('approval.command_replaced projects to []', () => {
    const event: RuntimeEvent = {
      type: 'approval.command_replaced',
      interactionId: 'inter-cmd',
      command: 'npm test',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 auto_review.requested 投影为空数组
  test('auto_review.requested projects to []', () => {
    const event: RuntimeEvent = {
      type: 'auto_review.requested',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });

  // 验证 auto_review.completed 投影为空数组
  test('auto_review.completed projects to []', () => {
    const event: RuntimeEvent = {
      type: 'auto_review.completed',
      reviewId: 'rev-1',
      toolCallId: 'tool-99',
      result: {
        ok: true,
        approved: true,
        grant: 'approve_once',
        reason: 'safe command',
        reviewerModelName: 'haiku',
        durationMs: 1500,
      },
    };
    expect(projectRuntimeEventToAgentEvent(event)).toEqual([]);
  });
});
