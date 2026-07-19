// ── 哈希工具 / Hash utilities ──
// 方案结构化哈希 + 审批哈希 / Plan structural hash + approval hash

import { createHash } from 'node:crypto';
import type { PlanDocument } from '@/protocol/events';

/**
 * 计算 PlanDocument 的结构化摘要，用于判断方案内容是否发生了结构性变更。
 * Computes the structural digest of a PlanDocument, used to detect structural changes.
 *
 * 摘要计算内容：title + bodyMarkdown + steps.length + 每个 step 的 id + title。
 * 执行状态（step status）不进入 digest，避免状态更新被误判为结构变化。
 * Digest input: title + bodyMarkdown + steps.length + each step's id + title.
 * Execution status is excluded from the digest to prevent false structural-change detection.
 */
export function computePlanStructuralDigest(
  doc: Pick<PlanDocument, 'title' | 'bodyMarkdown' | 'steps'>,
): string {
  const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();
  const input = JSON.stringify({
    title: normalize(doc.title),
    bodyMarkdown: normalize(doc.bodyMarkdown),
    steps: doc.steps.map(({ id, title }) => ({ id, title: normalize(title) })),
  });
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
