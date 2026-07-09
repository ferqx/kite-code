// ── Approval Controller / 审批控制器 ──
// Phase 3: 将 graph.ts approval 节点中人工审批结果处理抽取为纯函数。
// 仅处理 non-auto-mode 的 resume → permit issue → authorization update 流程。
//
// Extracts manual approval resume processing from the approval node as pure functions.
// Only handles non-auto-mode: resume → permit issue → authorization update.

import { ToolMessage } from '@langchain/core/messages';
import type { AutoReviewResult } from '@/core/controllers/auto-review-controller';
import type { AutoReviewState, RejectionEntry } from '@/core/execution/circuit-breaker';
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  evaluateCircuitBreaker,
} from '@/core/execution/circuit-breaker';
import type { DoomLoopTrackerEntry } from '@/core/execution/doom-loop';
import { updateDoomLoopTracker } from '@/core/execution/doom-loop';
import { issuePermit, type PermitBatch } from '@/core/execution/permit';
import type { ToolApprovalPayload } from '@/core/harness/tool-policy';
import type { PendingToolRequest } from '@/core/harness/tool-requests';
import type { RuntimeEvent } from '@/core/runtime/events';
import { genInteractionId } from '@/core/runtime/ids';
import type { ShellApprovalGrant, ShellGrantUsed } from '@/protocol/events';

// ── 类型定义 / Type definitions ──

/** 审批 resume 值的规范化结果 / Normalized approval resume value */
export interface ApprovalResumeValue {
  approved: boolean;
  grant?: ShellApprovalGrant;
  approvalHash?: string;
  replacementCommand?: string;
  reason?: string;
}

/** 审批结果处理参数 / Approval result handling parameters */
export interface HandleApprovalParams {
  /** 工具调用 ID / Tool call ID */
  toolCallId: string;
  /** 用户审批结果 / User approval result */
  resumeValue: ApprovalResumeValue;
  /** 期望的审批哈希 / Expected approval hash */
  expectedHash?: string;
  /** 运行时事件回调 — 唯一 TUI 通知路径 */
  emitRuntimeEvent?: (event: RuntimeEvent) => void;
  /** 交互 ID（由调用方 graph.ts 传入，或自动生成） */
  interactionId?: string;
}

/** 审批结果 / Approval result */
export interface HandleApprovalResult {
  /** 是否已批准 / Whether approved */
  approved: boolean;
  /** 授权类型 / Grant type */
  grant?: ShellApprovalGrant;
  /** 替换后的命令（如有）/ Replacement command (if any) */
  replacementCommand?: string;
  /** 拒绝原因（如未批准）/ Rejection reason (if not approved) */
  reason?: string;
}

// ── 辅助函数 / Helpers ──

/**
 * 规范化审批 resume 值 — graph.ts 的 interrupt() 可能返回 boolean 或对象。
 * Normalize approval resume — graph.ts interrupt() may return boolean or object.
 */
export function normalizeApprovalResume(
  resume: boolean | Record<string, unknown> | undefined,
): ApprovalResumeValue {
  if (resume === true) {
    return { approved: true };
  }
  if (typeof resume === 'object' && resume !== null) {
    const grant = resume.grant as ShellApprovalGrant | undefined;
    // 兼容旧行为：无显式 approved 但有有效 grant → 视为已批准
    // Backward compat: no explicit approved but valid grant → treat as approved
    const hasValidGrant =
      grant === 'approve_once' || grant === 'same_command' || grant === 'full_access';
    return {
      approved: resume.approved === true || (resume.approved === undefined && hasValidGrant),
      grant,
      approvalHash: resume.approvalHash as string | undefined,
      replacementCommand: resume.replacementCommand as string | undefined,
      reason: resume.reason as string | undefined,
    };
  }
  return { approved: false };
}

// ── Controller / 控制器 ──

/**
 * 处理人工审批结果。不调用 interrupt()——由调用方（graph.ts）负责。
 * Handle manual approval result. Does NOT call interrupt() — caller (graph.ts) is responsible.
 *
 * 处理流程 / Processing flow:
 * 1. 验证审批哈希 / Validate approval hash
 * 2. 检查替换命令 / Check replacement command
 * 3. 发出 approval.granted / approval.rejected RuntimeEvent
 *
 * 不处理（留在 graph.ts）：
 * - permit issue + full_access 批量传播 / permit issue + full_access propagation
 * - 授权状态更新 / authorization state update
 * - same_command grant 记录 / same_command grant recording
 * - doom-loop / circuit breaker / auto-review
 */
export function handleApprovalResume(params: HandleApprovalParams): HandleApprovalResult {
  const { resumeValue, expectedHash, emitRuntimeEvent, interactionId } = params;
  const iid = interactionId ?? genInteractionId();
  const { approved, grant, approvalHash, replacementCommand, reason } = resumeValue;

  // 验证审批哈希 — 仅当明确提供了 approvalHash 时才校验（布尔值 resume 无 hash → 通过）
  // Validate approval hash — only when approvalHash is explicitly provided (boolean resume has no hash → pass)
  if (approved && approvalHash !== undefined && expectedHash && approvalHash !== expectedHash) {
    emitRuntimeEvent?.({
      type: 'approval.rejected',
      interactionId: iid,
      reason: 'Approval hash mismatch — command may have changed since approval was requested.',
    });
    return {
      approved: false,
      reason: 'Approval hash mismatch — command may have changed since approval was requested.',
    };
  }

  // 用户拒绝 / User rejected
  if (!approved) {
    emitRuntimeEvent?.({
      type: 'approval.rejected',
      interactionId: iid,
      reason: reason ?? 'User rejected the request.',
    });
    return {
      approved: false,
      reason: reason ?? 'User rejected the request.',
    };
  }

  // 替换命令 / Replacement command
  if (replacementCommand && replacementCommand.length > 0) {
    // 替换命令已由调用方验证，此处仅记录 / Replacement already validated by caller
  }

  // 批准 / Approved
  emitRuntimeEvent?.({
    type: 'approval.granted',
    interactionId: iid,
    grant: grant ?? 'approve_once',
  });

  return {
    approved: true,
    grant: grant ?? 'approve_once',
    replacementCommand: replacementCommand || undefined,
  };
}

// ── Permit 发放 / Permit Issuing ──

/** 最终审批发放输入 / Finalize approval input */
export interface FinalizeApprovalInput {
  /** 已批准的工具请求 / Approved tool request */
  request: PendingToolRequest;
  /** 授权类型 / Grant type */
  grant: ShellApprovalGrant;
  /** 当前 permit 批处理 / Current permit batch */
  batch: PermitBatch;
  /** 工作区路径 / Workspace path */
  workspace: string;
  /** 线程 ID / Thread ID */
  threadId: string;
  /** 所有待处理的工具请求（用于 full_access 批量传播）/ All pending tool requests (for full_access propagation) */
  allPending: PendingToolRequest[];
}

/** 最终审批发放结果 / Finalize approval result */
export interface FinalizeApprovalResult {
  /** 更新后的 permit 批处理（包含已发放的 permit）/ Updated batch with issued permits */
  batch: PermitBatch;
  /** 是否进行了 full_access 批量传播 / Whether full_access was propagated */
  fullAccessPropagated: boolean;
}

/**
 * 完成审批发放 — 为已批准的工具发放 permit，若为 full_access 则传播到其余待处理工具。
 * Finalize approval — issue permit for the approved tool and propagate full_access if granted.
 *
 * 纯函数，无 LangGraph 依赖。调用方传入 batch 并接收更新后的 batch。
 * Pure function, no LangGraph dependency. Caller passes batch and receives updated batch.
 *
 * 处理流程 / Processing flow:
 * 1. 为已批准的工具调用 issuePermit / Issue permit for the approved tool
 * 2. 若 grant === 'full_access'，将 full_access 传播到所有剩余待处理工具
 *    / If grant === 'full_access', propagate to all remaining pending tools
 */
export function finalizeApproval(input: FinalizeApprovalInput): FinalizeApprovalResult {
  const { request, grant, batch, workspace, threadId, allPending } = input;

  let updatedBatch = { ...batch };

  // 1. 为已批准的工具发放 permit / Issue permit for the approved tool
  updatedBatch = issuePermit({
    batch: updatedBatch,
    workspace,
    threadId,
    request,
    grant: grant as ShellGrantUsed,
  });

  // 2. full_access 批量传播 / full_access propagation
  let fullAccessPropagated = false;
  if (grant === 'full_access') {
    for (const r of allPending) {
      if (r.id && !updatedBatch[r.id]) {
        updatedBatch = issuePermit({
          batch: updatedBatch,
          workspace,
          threadId,
          request: r,
          grant: 'full_access',
        });
        fullAccessPropagated = true;
      }
    }
  }

  return { batch: updatedBatch, fullAccessPropagated };
}

// ── Full-Access 自动批准 / Full-Access Auto-Approve ──

/** full_access 自动批准所有待处理工具的参数 / Parameters for auto-approving all pending tools with full_access */
export interface AutoApproveAllParams {
  batch: PermitBatch;
  allPending: PendingToolRequest[];
  workspace: string;
  threadId: string;
}

/**
 * 为所有待处理工具发放 full_access permit，在原地更新 batch。
 * Issue full_access permits for all pending tools, mutating batch in place.
 *
 * 纯函数，无 LangGraph 依赖。Pure function, no LangGraph dependency.
 */
export function autoApproveAllWithFullAccess(params: AutoApproveAllParams): PermitBatch {
  const { batch, allPending, workspace, threadId } = params;
  for (const r of allPending) {
    Object.assign(
      batch,
      issuePermit({
        batch,
        workspace,
        threadId,
        request: r,
        grant: 'full_access',
      }),
    );
  }
  return batch;
}

// ── Auto-Review 结果处理 / Auto-Review Result Handling ──

/** 审批值（已批准的 partial）/ Approved value shape returned from auto-review result handling */
export interface AutoReviewApprovedValue {
  approved: true;
  grant: ShellApprovalGrant;
  approvalHash: string;
  reason?: string;
}

/** handleAutoReviewResult 的参数 / Parameters for handleAutoReviewResult */
export interface HandleAutoReviewResultParams {
  autoReviewResult: AutoReviewResult;
  autoReviewState: AutoReviewState;
  doomLoopTracker: Record<string, DoomLoopTrackerEntry>;
  request: PendingToolRequest;
  approvalPayload: ToolApprovalPayload;
  config: {
    autoReview?: {
      failOpen?: boolean;
      circuitBreakerMaxRejections?: number;
      circuitBreakerWindowMs?: number;
    };
  };
  /** 待处理的子 agent 审批（如有）/ Pending sub-agent approval (if any) */
  pendingSubagent: { request: PendingToolRequest } | null | undefined;
  doomFingerprint: string | undefined;
  batch: PermitBatch;
  workspace: string;
  threadId: string;
  planReviewed: boolean;
}

/**
 * auto-review 结果处理的分支类型 / Discriminated union for auto-review outcome:
 * - 'return': 调用方应立即返回此状态更新 / Caller should immediately return this state update
 * - 'approved': 工具已获批，调用方应继续审批流程 / Tool approved, caller should continue the approval flow
 */
export type AutoReviewOutcome =
  | { kind: 'return'; stateUpdate: Record<string, unknown> }
  | {
      kind: 'approved';
      approved: AutoReviewApprovedValue;
      autoReviewFailureReason: string | null;
      autoReviewRejectionRecord: AutoReviewState | null;
      doomLoopTrackerNext: Record<string, DoomLoopTrackerEntry>;
    };

/** 为子 agent 工具构建拒绝状态更新 / Build a rejection state update for a sub-agent tool */
function buildSubagentRejection(
  batch: PermitBatch,
  pendingSubagent: { request: PendingToolRequest },
  workspace: string,
  threadId: string,
  doomLoopNext: Record<string, DoomLoopTrackerEntry>,
  autoReviewState: AutoReviewState,
  planReviewed: boolean,
): Record<string, unknown> {
  Object.assign(
    batch,
    issuePermit({
      batch,
      workspace,
      threadId,
      request: pendingSubagent.request,
      grant: 'none',
    }),
  );
  return {
    approvedBatch: batch,
    doomLoopTracker: doomLoopNext,
    autoReviewState,
    planReviewed,
  };
}

/**
 * 处理 auto-review 结果 — 纯函数，不调用 interrupt()。
 * Handle auto-review result — pure function, never calls interrupt().
 *
 * 处理三种结果分支 / Handles three outcome branches:
 * 1. !ok（技术失败）：fail-open → 批准 / fail-closed → 直接拒绝
 * 2. !approved（审查者拒绝）：circuit breaker 评估 → 拒绝（含 ToolMessage）
 * 3. approved（审查者批准）：返回 approval 值，调用方继续流程
 */
export function handleAutoReviewResult(params: HandleAutoReviewResultParams): AutoReviewOutcome {
  const {
    autoReviewResult,
    autoReviewState,
    doomLoopTracker,
    request,
    approvalPayload,
    config,
    pendingSubagent,
    doomFingerprint,
    batch,
    workspace,
    threadId,
    planReviewed,
  } = params;

  const reviewModelName = autoReviewResult.reviewerModelName;

  // 分支 1：auto-review 技术失败 / Branch 1: auto-review technical failure
  if (!autoReviewResult.ok) {
    const failureReason = autoReviewResult.reason ?? 'auto review technical failure';
    const failOpen = config.autoReview?.failOpen === true;

    if (failOpen) {
      const autoReviewFailureReason = `auto-review (${reviewModelName}): ${failureReason}`;
      console.warn(`[auto-review] FAILED (fail-open): ${failureReason} — tool=${request.name}`);
      if (pendingSubagent) {
        return {
          kind: 'return',
          stateUpdate: buildSubagentRejection(
            batch,
            pendingSubagent,
            workspace,
            threadId,
            doomLoopTracker,
            {
              pendingWarnings: {},
              consecutiveRejects: 0,
              rejectionHistory: [],
              circuitBreakerTripped: true,
            },
            planReviewed,
          ),
        };
      }
      return {
        kind: 'approved',
        approved: {
          approved: true,
          grant: 'approve_once',
          approvalHash: approvalPayload.approvalHash,
          reason: `[auto-review failed] ${failureReason}`,
        },
        autoReviewFailureReason,
        autoReviewRejectionRecord: null,
        doomLoopTrackerNext: doomLoopTracker,
      };
    }

    // fail-closed
    const doomLoopTrackerNext = updateDoomLoopTracker(doomLoopTracker, doomFingerprint!);
    const autoReviewFailureReason = `auto-review (${reviewModelName}): ${failureReason} (fail-closed)`;
    console.warn(`[auto-review] FAILED (fail-closed): ${failureReason} — tool=${request.name}`);
    const pendingWarnings = {
      ...autoReviewState.pendingWarnings,
      ...(request.id ? { [request.id]: autoReviewFailureReason } : {}),
    };
    if (pendingSubagent) {
      return {
        kind: 'return',
        stateUpdate: buildSubagentRejection(
          batch,
          pendingSubagent,
          workspace,
          threadId,
          doomLoopTrackerNext,
          {
            pendingWarnings,
            consecutiveRejects: 0,
            rejectionHistory: [],
            circuitBreakerTripped: true,
          },
          planReviewed,
        ),
      };
    }
    return {
      kind: 'return',
      stateUpdate: {
        approvedBatch: batch,
        doomLoopTracker: doomLoopTrackerNext,
        autoReviewState: {
          pendingWarnings,
          consecutiveRejects: 0,
          rejectionHistory: [],
          circuitBreakerTripped: true,
        },
      },
    };
  }

  // 分支 2：审查者拒绝 / Branch 2: reviewer explicitly rejected
  if (!autoReviewResult.approved) {
    const doomLoopTrackerNext = updateDoomLoopTracker(doomLoopTracker, doomFingerprint!);
    const rejectionReason = autoReviewResult.reason || 'auto review rejected this action';
    console.warn(`[auto-review] rejected: ${rejectionReason} — tool=${request.name}`);

    const newEntry: RejectionEntry = {
      timestamp: Date.now(),
      toolName: request.name,
      reason: rejectionReason,
    };
    const cbConfig = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      maxRejections:
        config.autoReview?.circuitBreakerMaxRejections ??
        DEFAULT_CIRCUIT_BREAKER_CONFIG.maxRejections,
      windowMs:
        config.autoReview?.circuitBreakerWindowMs ?? DEFAULT_CIRCUIT_BREAKER_CONFIG.windowMs,
    };
    const cbResult = evaluateCircuitBreaker(
      autoReviewState.consecutiveRejects,
      autoReviewState.rejectionHistory.map((r) => ({
        timestamp: r.timestamp,
        toolName: r.toolName,
        reason: r.reason,
      })),
      cbConfig,
      true,
      newEntry,
    );
    if (cbResult.tripped) {
      console.warn(`[auto-review] CIRCUIT BREAKER TRIPPED: ${cbResult.reason}`);
      const pendingWarnings = {
        ...autoReviewState.pendingWarnings,
        ...(request.id ? { [request.id]: `auto-review rejected: ${rejectionReason}` } : {}),
      };
      if (pendingSubagent) {
        return {
          kind: 'return',
          stateUpdate: buildSubagentRejection(
            batch,
            pendingSubagent,
            workspace,
            threadId,
            doomLoopTrackerNext,
            {
              pendingWarnings,
              consecutiveRejects: cbResult.newConsecutiveRejects,
              rejectionHistory: cbResult.newRejectionHistory,
              circuitBreakerTripped: true,
            },
            planReviewed,
          ),
        };
      }
      return {
        kind: 'return',
        stateUpdate: {
          approvedBatch: batch,
          doomLoopTracker: doomLoopTrackerNext,
          autoReviewState: {
            pendingWarnings,
            consecutiveRejects: cbResult.newConsecutiveRejects,
            rejectionHistory: cbResult.newRejectionHistory,
            circuitBreakerTripped: true,
          },
        },
      };
    }

    // Circuit breaker NOT tripped — explicitly rejected
    if (pendingSubagent) {
      return {
        kind: 'return',
        stateUpdate: buildSubagentRejection(
          batch,
          pendingSubagent,
          workspace,
          threadId,
          doomLoopTrackerNext,
          {
            pendingWarnings: {},
            consecutiveRejects: cbResult.newConsecutiveRejects,
            rejectionHistory: cbResult.newRejectionHistory,
            circuitBreakerTripped: false,
          },
          planReviewed,
        ),
      };
    }
    return {
      kind: 'return',
      stateUpdate: {
        messages: [
          new ToolMessage({
            content: JSON.stringify({
              ok: false,
              rejected: true,
              reason: rejectionReason,
            }),
            tool_call_id: request.id ?? 'missing-tool-call-id',
            name: request.name,
            status: 'error',
          }),
        ],
        approvedBatch: batch,
        doomLoopTracker: doomLoopTrackerNext,
        autoReviewState: {
          pendingWarnings: {},
          consecutiveRejects: cbResult.newConsecutiveRejects,
          rejectionHistory: cbResult.newRejectionHistory,
          circuitBreakerTripped: false,
        },
      },
    };
  }

  // 分支 3：审查者批准 / Branch 3: reviewer approved
  return {
    kind: 'approved',
    approved: {
      approved: true,
      grant: (autoReviewResult.grant as ShellApprovalGrant) ?? 'approve_once',
      approvalHash: approvalPayload.approvalHash,
      reason: autoReviewResult.reason,
    },
    autoReviewFailureReason: null,
    autoReviewRejectionRecord: {
      pendingWarnings: {},
      consecutiveRejects: 0,
      rejectionHistory: autoReviewState.rejectionHistory,
      circuitBreakerTripped: false,
    },
    doomLoopTrackerNext: doomLoopTracker,
  };
}
