// ── RuntimeEvent → AgentEvent 投影 / RuntimeEvent → AgentEvent projection ──
// 将运行时内核事件映射为 TUI 可消费的 AgentEvent 序列。
// 这是 RuntimeEvent 和 AgentEvent 之间的唯一桥梁，确保 TUI 状态来自单一来源。
//
// tool.finished / tool.failed / tool.rejected 正确投影为 tool_done，
// RuntimeEvent 是 tool_call / tool_done 的唯一事件来源（单管道）。
// TUI reducer 对重复 tool_done 是幂等的。

import type { AgentEvent } from '@/protocol/events.js';
import type { RuntimeEvent } from './events.js';

/** 从 ToolFinishedEvent.result 构建 tool_done 的 summary 字段。
 *  与 runner.ts parseToolResultEvents 保持一致的摘要提取逻辑。 */
function buildToolDoneSummary(
  toolName: string,
  result: { ok: boolean; stdout: string; stderr: string; command: string },
): string {
  if (result.ok) {
    const raw = result.stdout || result.stderr || '';
    // ask_user: stdout 是 JSON，需要提取 answer 字段做人类可读展示
    if (toolName === 'ask_user') {
      try {
        const p = JSON.parse(raw);
        if (p && typeof p === 'object') {
          const answer = p.answer as string | undefined;
          const answers = p.answers as Record<string, string> | undefined;
          if (answers && Object.keys(answers).length > 0) {
            return Object.entries(answers)
              .map(([k, v]) => `${k}: ${v}`)
              .join('\n');
          }
          if (typeof answer === 'string') return answer || '(no answer)';
        }
      } catch {
        /* not JSON, fall through */
      }
    }
    return raw.slice(0, 200);
  }
  return (result.stderr || result.stdout || '').slice(0, 200);
}

/**
 * 将单个 RuntimeEvent 投影为 0 个或多个 AgentEvent。
 * 大部分 RuntimeEvent 类型映射为 1 个 AgentEvent，不需要 TUI 表示的类型返回空数组。
 */
export function projectRuntimeEventToAgentEvent(event: RuntimeEvent): AgentEvent[] {
  switch (event.type) {
    // ── 工具生命周期 / Tool lifecycle ──
    case 'tool.queued':
      return [
        {
          type: 'tool_call' as const,
          data: {
            call_id: event.toolCallId,
            name: event.name,
            args: event.args as Record<string, unknown>,
            status: 'queued' as const,
          },
        },
      ];

    case 'tool.started':
      return [
        {
          type: 'tool_started' as const,
          data: {
            call_id: event.toolCallId,
          },
        },
      ];

    case 'tool.progress':
      return [
        {
          type: 'tool_progress' as const,
          data: {
            call_id: event.toolCallId,
            name: '',
            chunk: event.chunk,
            stream: event.stream,
          },
        },
      ];

    case 'tool.finished':
      return [
        {
          type: 'tool_done' as const,
          data: {
            call_id: event.toolCallId,
            name: event.name,
            ok: event.result.ok,
            summary: buildToolDoneSummary(event.name, event.result),
            ...(event.result.exitCode != null ? { exitCode: event.result.exitCode } : {}),
            ...(event.result.totalLines != null ? { totalLines: event.result.totalLines } : {}),
            ...(event.result.status ? { status: event.result.status } : {}),
            ...(event.result.toolTokenCount != null && event.result.toolTokenCount > 0
              ? { toolTokenCount: event.result.toolTokenCount }
              : {}),
          },
        },
      ];

    case 'tool.failed':
      return [
        {
          type: 'tool_done' as const,
          data: {
            call_id: event.toolCallId,
            name: '',
            ok: false,
            summary: event.error.slice(0, 200),
          },
        },
      ];

    case 'tool.rejected':
      return [
        {
          type: 'tool_done' as const,
          data: {
            call_id: event.toolCallId,
            name: '',
            ok: false,
            summary: event.reason.slice(0, 200),
          },
        },
      ];

    // ── 用户输入交互 / User input interaction ──
    case 'user_input.requested':
      return [
        {
          type: 'need_input' as const,
          data: event.request,
        },
      ];

    case 'user_input.answered':
      return [];

    // ── 方案审核交互 / Plan review interaction ──
    case 'plan.review_requested':
      return [
        {
          type: 'need_plan_review' as const,
          data: { plan: event.plan },
        },
      ];

    case 'plan.approved':
      return [];

    case 'plan.revision_requested':
      return [];

    case 'plan.rejected':
      return [];

    // ── 工具审批交互 / Approval interaction ──
    case 'approval.requested':
      return [
        {
          type: 'need_approval' as const,
          data: event.approval,
        },
      ];

    case 'approval.granted':
      return [];

    case 'approval.rejected':
      return [];

    // ── 运行时环境事件（仅内核内部消费，不投影为 AgentEvent）──
    case 'authorization.changed':
      return [];

    case 'phase.changed':
      return [];

    // ── Turn 生命周期（信息性，暂不投影为 TUI 事件）──
    case 'turn.started':
      return [];
    case 'turn.completed':
      return [];
    case 'turn.aborted':
      return [];

    // ── 用户消息（信息性，暂不投影）──
    case 'user.message_appended':
      return [];

    // ── 模型交互 / Model interaction ──
    case 'model.requested':
      return [];
    case 'model.responded': {
      const events: AgentEvent[] = [];
      if (event.reasoningText && event.reasoningText.length > 0) {
        events.push({ type: 'reason' as const, data: { text: event.reasoningText } });
      }
      if (event.text && event.text.length > 0) {
        events.push({ type: 'text' as const, data: { text: event.text } });
      }
      return events;
    }

    // ── Plan 生命周期补充（信息性，由 need_plan_review/tool_done 各自投影）──
    case 'plan.drafted':
      return [];
    case 'plan.progress_updated':
      return [];
    case 'plan.completed':
      return [];

    // ── Approval 补充（信息性，审批结果通过 need_approval/tool_done 各自投影）──
    case 'approval.command_replaced':
      return [];

    // ── Auto-review 事件（信息性，审批结果通过 need_approval/tool_done 各自投影）──
    case 'auto_review.requested':
      return [];
    case 'auto_review.completed':
      return [];
    default:
      return [];
  }
}
