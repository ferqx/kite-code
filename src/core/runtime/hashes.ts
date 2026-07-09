// ── 哈希工具 / Hash utilities ──
// 方案结构化哈希 + 审批哈希 / Plan structural hash + approval hash

import { createHash } from 'node:crypto';
import type { AgentPlan } from '@/protocol/events';

/**
 * 计算方案的结构化哈希值，用于判断方案内容是否发生了结构性变更。
 * Computes the structural hash of a plan, used to detect structural changes.
 *
 * 哈希计算内容：plan.name + steps.length + 每个 step 的 step 文本。
 * Hash input: plan.name + steps.length + each step's step text.
 */
export function computePlanStructuralHash(plan: AgentPlan): string {
  const stepsText = plan.steps.map((s) => s.step).join('');
  const input = plan.name + plan.steps.length + stepsText;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 计算审批哈希，用于验证审批请求与当前工具调用是否一致。
 * Computes approval hash for validating approval requests match current tool calls.
 *
 * 哈希计算内容：toolName + command + workspace + threadId。
 * Hash input: toolName + command + workspace + threadId.
 */
export function computeApprovalHash(params: {
  toolName: string;
  command: string;
  workspace: string;
  threadId: string;
}): string {
  const input = `${params.toolName}\n${params.command}\n${params.workspace}\n${params.threadId}`;
  return createHash('sha256').update(input).digest('hex');
}
