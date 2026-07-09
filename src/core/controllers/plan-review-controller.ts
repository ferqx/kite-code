import { ToolMessage } from '@langchain/core/messages';
import type { RuntimeEvent } from '@/core/runtime/events';
import { genInteractionId } from '@/core/runtime/ids';
import type { ThreadAuthorizationState } from '@/core/types';
import type { AgentPlan, InteractionMode, PlanStatus } from '@/protocol/events';
import { InteractionMode as IM } from '@/protocol/events';

/** 方案审核参数 / Plan review parameters */
export interface PlanReviewParams {
  /** 工具请求（来自 AIMessage.tool_calls 中的 update_plan 调用） */
  request: { id?: string; args: Record<string, unknown> };
  /** 从 interrupt() 返回的 resume 值 / Resume value returned from interrupt() */
  resume: boolean | Record<string, unknown>;
  /** 当前状态快照（仅方案审核所需字段） */
  state: {
    plan: AgentPlan | null;
    planReviewed: boolean;
    authorization: ThreadAuthorizationState;
  };
  /** 运行时事件回调 — RuntimeEvent 是唯一 TUI 通知路径 */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /** 交互 ID（由调用方 graph.ts 传入，或自动生成） */
  interactionId?: string;
}

/** 方案审核结果 / Plan review result */
export interface PlanReviewResult {
  messages: ToolMessage[];
  plan: AgentPlan | null;
  planReviewed: boolean;
  phase: 'planning' | 'building';
  interactionMode: InteractionMode;
  authorization: ThreadAuthorizationState;
}

/**
 * 纯函数：处理方案审核恢复逻辑 / Pure function: handle plan review resume logic.
 *
 * 将 graph.ts planReview 节点中 interrupt() 之后的 approve / supplement / reject
 * 三路分支抽取为不依赖 LangGraph 的纯函数。调用方负责在 LangGraph 节点中调用
 * interrupt() 并将 resume 值传入本函数。
 *
 * Extracts the three-way branching (approve / supplement / reject) from the
 * graph.ts planReview node into a pure function with no LangGraph dependency.
 * The caller is responsible for calling interrupt() in the LangGraph node and
 * passing the resume value here.
 *
 * RuntimeEvent 是唯一 TUI 通知路径 — 不再使用 toolResultSink 双写。
 * RuntimeEvent is the sole TUI notification path — no more toolResultSink dual-write.
 */
export function handlePlanReview(params: PlanReviewParams): PlanReviewResult {
  const { request, resume, state, emitRuntimeEvent, interactionId } = params;
  const iid = interactionId ?? genInteractionId();

  // 规范化 resume — graph.ts 的 interrupt() 可能返回 boolean true/false 或对象
  // Normalize resume — graph.ts interrupt() may return boolean true/false or an object
  const resumeObj: Record<string, unknown> =
    typeof resume === 'boolean' ? { planApproved: resume } : resume;

  // 从 tool_calls args 中提取方案 / Extract plan from tool_calls args
  const planArgs = request.args as {
    name: string;
    description: string;
    status: string;
    steps: { step: string; status: string }[];
  };
  const plan: AgentPlan = {
    name: planArgs.name,
    description: planArgs.description,
    status: (planArgs.status as PlanStatus) ?? 'pending',
    steps: (planArgs.steps ?? []).map((s) => ({
      step: s.step,
      status: (s.status as PlanStatus) ?? 'pending',
    })),
  };

  // 格式化方案摘要 — 方案数据已在 AIMessage.tool_calls.args 中，ToolMessage 只需简短摘要
  // Format plan summary — plan data already in AIMessage.tool_calls.args; ToolMessage only needs brief summary
  const stepsText = plan.steps.map((s, i) => `${i + 1}. ${s.step}`).join('\n');
  const planSummary = `${plan.description}\n\nSteps:\n${stepsText}`;

  // ── 批准分支 / Approve branch ──
  const approved = resumeObj.planApproved === true;

  if (approved) {
    const executionMode = resumeObj.executionMode as string | undefined;
    const interactionMode = executionMode === 'auto' ? IM.Auto : IM.Ask;

    // RuntimeEvent 是唯一 TUI 通知路径 / RuntimeEvent is the sole TUI notification path
    emitRuntimeEvent?.({
      type: 'plan.approved',
      interactionId: iid,
      executionMode: executionMode === 'auto' ? 'auto' : 'manual',
    });
    emitRuntimeEvent?.({
      type: 'phase.changed',
      phase: 'building',
    });
    emitRuntimeEvent?.({
      type: 'tool.finished',
      toolCallId: request.id ?? '',
      name: 'update_plan',
      result: {
        ok: true,
        command: '',
        exitCode: 0,
        stdout: planSummary.slice(0, 200),
        stderr: '',
      },
    });

    return {
      messages: [
        new ToolMessage({
          content: JSON.stringify({ ok: true, stdout: planSummary.slice(0, 200) }),
          tool_call_id: request.id ?? 'missing-tool-call-id',
          name: 'update_plan',
          status: 'success',
        }),
      ],
      plan,
      planReviewed: true,
      phase: 'building' as const,
      interactionMode,
      // 首次方案审批重置授权为 default；执行中修订方案保留现有授权（如 full_access）
      // First plan approval resets authorization to default; plan revision preserves existing
      authorization: state.planReviewed
        ? state.authorization
        : { ...state.authorization, mode: 'default' as const },
    };
  }

  // ── 补充/修订分支 / Supplement branch ──
  const supplement = resumeObj.planSupplement;
  if (typeof supplement === 'string' && supplement.length > 0) {
    emitRuntimeEvent?.({
      type: 'plan.revision_requested',
      interactionId: iid,
      feedback: supplement,
    });

    return {
      ...rejectedToolMessage(request, `Plan needs revision. User feedback: ${supplement}`),
      plan: state.plan,
      planReviewed: state.planReviewed,
      phase: 'planning' as const,
      interactionMode: IM.Ask,
      authorization: state.authorization,
    };
  }

  // ── 拒绝分支 / Reject branch ──
  emitRuntimeEvent?.({
    type: 'plan.rejected',
    interactionId: iid,
    reason: 'plan rejected by user',
  });

  return {
    ...rejectedToolMessage(request, 'plan rejected by user'),
    plan: state.plan,
    planReviewed: state.planReviewed,
    phase: 'planning' as const,
    interactionMode: IM.Ask,
    authorization: state.authorization,
  };
}

/**
 * 创建拒绝工具消息 / Create rejected tool message.
 *
 * 与 graph.ts 中的 rejectedToolMessage 相同：构建一个 ok=false + rejected=true
 * 的 ToolMessage，让模型看到被拒原因并调整行为。
 *
 * Same as rejectedToolMessage in graph.ts: builds a ToolMessage with ok=false
 * and rejected=true so the model sees the rejection reason and adapts.
 */
function rejectedToolMessage(
  request: { id?: string },
  reason: string,
): { messages: ToolMessage[] } {
  return {
    messages: [
      new ToolMessage({
        content: JSON.stringify({
          ok: false,
          rejected: true,
          reason,
        }),
        tool_call_id: request.id ?? 'missing-tool-call-id',
        name: 'update_plan',
        status: 'error',
      }),
    ],
  };
}
