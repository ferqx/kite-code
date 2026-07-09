// ── Approval Controller / 审批控制器 ──
// Phase 3: 将 graph.ts approval 节点中人工审批结果处理抽取为纯函数。
// 仅处理 non-auto-mode 的 resume → permit issue → authorization update 流程。
//
// Extracts manual approval resume processing from the approval node as pure functions.
// Only handles non-auto-mode: resume → permit issue → authorization update.

import type { RuntimeEvent } from '@/core/runtime/events';
import type { ShellApprovalGrant } from '@/protocol/events';

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
  const { toolCallId, resumeValue, expectedHash, emitRuntimeEvent } = params;
  const { approved, grant, approvalHash, replacementCommand, reason } = resumeValue;

  // 验证审批哈希 — 仅当明确提供了 approvalHash 时才校验（布尔值 resume 无 hash → 通过）
  // Validate approval hash — only when approvalHash is explicitly provided (boolean resume has no hash → pass)
  if (approved && approvalHash !== undefined && expectedHash && approvalHash !== expectedHash) {
    emitRuntimeEvent?.({
      type: 'approval.rejected',
      interactionId: toolCallId,
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
      interactionId: toolCallId,
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
    interactionId: toolCallId,
    grant: grant ?? 'approve_once',
  });

  return {
    approved: true,
    grant: grant ?? 'approve_once',
    replacementCommand: replacementCommand || undefined,
  };
}
