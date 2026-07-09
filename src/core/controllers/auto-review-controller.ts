// ── Auto-Review Controller / 自动审查控制器 ──
// Phase 3+4: 将 graph.ts approval 节点中的 reviewer 模型调用事件化。
// 仅包装 reviewToolApproval 调用 + RuntimeEvent 发射，不处理 graph-specific 逻辑。
//
// Wraps the reviewer model call from the approval node with RuntimeEvent emission.
// Only handles reviewToolApproval + event emission; graph-specific logic stays in graph.ts.

import type { BaseMessage } from '@langchain/core/messages';
import type { AgentConfig } from '@/core/config/index';
import {
  createAutoReviewModel,
  type ReviewContext,
  reviewToolApproval,
} from '@/core/execution/reviewer';
import type { ToolApprovalPayload } from '@/core/harness/tool-policy';
import type { PendingToolRequest } from '@/core/harness/tool-requests';
import type { SupportedChatModel } from '@/core/model/factory';
import type { RuntimeEvent } from '@/core/runtime/events';

// ── 类型定义 / Type definitions ──

/** Auto-review 控制器输入 / Auto-review controller input */
export interface AutoReviewParams {
  /** 工具审批负载 / Tool approval payload */
  payload: ToolApprovalPayload;
  /** 待审批的工具请求 / Pending tool request */
  request: PendingToolRequest;
  /** 审查上下文 / Review context */
  context: ReviewContext;
  /** Agent 配置（含 autoReview 子配置）/ Agent config (includes autoReview sub-config) */
  config: AgentConfig;
  /** 唯一审查 ID / Unique review id */
  reviewId: string;
  /** 运行时事件回调 / RuntimeEvent callback */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /**
   * 可选：预创建的审查模型。传入后跳过 createAutoReviewModel。
   * 用于 graph.ts 中 auto-review config 未设置时回退到主 agent model。
   * Optional: pre-created review model. When provided, skips createAutoReviewModel.
   * Used when graph.ts falls back to the main agent model if no auto-review config is set.
   */
  model?: SupportedChatModel;
}

/** Auto-review 控制器结果 / Auto-review controller result */
export interface AutoReviewResult {
  /** 审查是否成功完成 / Whether the review completed successfully */
  ok: boolean;
  /** 是否批准 / Whether the tool is approved */
  approved: boolean;
  /** 授权类型 / Grant type */
  grant?: string;
  /** 拒绝原因（如未批准）/ Rejection reason (if not approved) */
  reason?: string;
  /** 失败类型（仅 ok=false 时）/ Failure type (only when ok=false) */
  failureType?: 'technical' | 'invalid_response';
  /** 审查模型名称（用于 TUI 展示）/ Reviewer model name (for TUI display) */
  reviewerModelName: string;
  /** 审核耗时（毫秒）/ Review duration (ms) */
  durationMs: number;
}

// ── Controller / 控制器 ──

/**
 * 执行 auto-review 并发出 RuntimeEvent。
 * Execute auto-review and emit RuntimeEvent.
 *
 * 不处理（留在 graph.ts）：
 * - doom-loop 检测 / doom-loop detection
 * - _safety fast-path / _safety fast-path routing
 * - circuit breaker 状态更新 / circuit breaker state update
 * - interrupt() 调用 / interrupt() call
 * - fail-open/fail-closed 分支 / fail-open/fail-closed branching
 *
 * 仅处理：调用 reviewer 模型 → 解析结果 → 发出 auto_review.completed 事件。
 * Only handles: call reviewer model → parse result → emit auto_review.completed event.
 */
export async function runAutoReview(params: AutoReviewParams): Promise<AutoReviewResult> {
  const { payload, request, context, config, reviewId, emitRuntimeEvent, model } = params;

  // 发出 auto_review.requested / Emit auto_review.requested
  emitRuntimeEvent?.({
    type: 'auto_review.requested',
    reviewId,
    toolCallId: request.id ?? '',
  });

  // 创建审查模型 — 优先使用预创建 model，否则从 config 创建
  // Create review model — prefer pre-created model, otherwise create from config
  const reviewModel = model ?? createAutoReviewModel(config);
  const reviewerModelName = model
    ? (config.modelName ?? 'unknown')
    : ((config.autoReview?.model as string) ?? config.modelName ?? 'unknown');

  const startedAt = Date.now();

  // 调用审查 / Run review
  const review = await reviewToolApproval({
    model: {
      invoke(
        messages: BaseMessage[],
        options?: { signal?: AbortSignal; [key: string]: unknown },
      ): Promise<unknown> {
        return reviewModel.invoke(messages, options ?? {});
      },
    },
    payload,
    request,
    context,
    timeoutMs: config.autoReview?.timeoutMs,
  });

  const durationMs = Date.now() - startedAt;

  // 发出 RuntimeEvent / Emit RuntimeEvent
  emitRuntimeEvent?.({
    type: 'auto_review.completed',
    reviewId,
    toolCallId: request.id ?? '',
    result: {
      ok: review.ok,
      approved: review.ok ? (review.suggestion?.approved ?? false) : false,
      grant: review.suggestion?.grant,
      reason: review.suggestion?.reason ?? review.reason,
      reviewerModelName,
      durationMs,
    },
  });

  return {
    ok: review.ok,
    approved: review.ok ? (review.suggestion?.approved ?? false) : false,
    grant: review.suggestion?.grant,
    reason: review.suggestion?.reason ?? review.reason,
    failureType: review.ok ? undefined : review.failureType,
    reviewerModelName,
    durationMs,
  };
}
