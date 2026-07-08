// ── RuntimeEvent → AgentEvent 投影 / RuntimeEvent → AgentEvent projection ──
// 将运行时内核事件映射为 TUI 可消费的 AgentEvent 序列。
// 这是 RuntimeEvent 和 AgentEvent 之间的唯一桥梁，确保 TUI 状态来自单一来源。
//
// Phase 1 注意：tool.finished / tool.failed / tool.rejected 返回 []，
// 因为当前 toolResultSink 已负责 tool_done 的 AgentEvent 发射。
// 二者并行运行，RuntimeEvent 用于日志/追踪管道，不产生重复的 AgentEvent。
// 后续 Phase（toolResultSink 退役后）将启用 RuntimeEvent → tool_done 投影。

import type { AgentEvent } from '@/protocol/events.js';
import type { RuntimeEvent } from './events.js';

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
          },
        },
      ];

    case 'tool.started':
      return [];

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

    // Phase 1: tool_done 由 toolResultSink 负责，RuntimeEvent 仅供日志/追踪。
    // 后续 Phase 启用 RuntimeEvent → tool_done 投影以统一 TUI 状态来源。
    case 'tool.finished':
      return [];

    case 'tool.failed':
      return [];

    case 'tool.rejected':
      return [];

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

    // ── 默认：未知事件类型 ──
    default:
      return [];
  }
}
