// ── AgentState ↔ RuntimeState 双向桥接 / Bidirectional bridge ──
// Phase 2 完成: 将 LangGraph AgentState 和 Runtime Kernel RuntimeState 相互转换。
// 为 Phase 5 checkpoint 降级打基础——RuntimeState 成为唯一状态权威后，
// AgentState 仅作为 LangGraph engine 内部投影使用。
//
// Phase 2 completion: Bidirectional conversion between LangGraph AgentState
// and Runtime Kernel RuntimeState. Foundation for Phase 5 checkpoint demotion —
// once RuntimeState becomes the sole state authority, AgentState serves only
// as a LangGraph engine internal projection.

import type { CodeAgentState } from '@/core/harness/state';
import type { RuntimeState } from './state';
import { computePlanStructuralHash, createInitialRuntimeState } from './state';

// ── AgentState → RuntimeState / AgentState to RuntimeState ──

/**
 * 从 LangGraph AgentState 构建 RuntimeState。
 * Build RuntimeState from LangGraph AgentState.
 *
 * 用于从 checkpoint 恢复时重建 runtime 状态。
 * Used when restoring runtime state from a checkpoint.
 *
 * @param agentState - LangGraph checkpoint 中的 AgentState / AgentState from LangGraph checkpoint
 * @param threadId - 线程 ID / Thread id
 * @param userId - 用户 ID / User id
 * @param workspace - 工作目录 / Workspace path
 * @param turnIndex - 当前 turn 序号 / Current turn index
 * @returns 重建的 RuntimeState / Reconstructed RuntimeState
 */
export function agentStateToRuntimeState(
  agentState: CodeAgentState,
  threadId: string,
  userId: string,
  workspace: string,
  turnIndex: number,
): RuntimeState {
  const base = createInitialRuntimeState({
    threadId,
    userId,
    workspace,
    interactionMode: agentState.interactionMode,
    authorizationMode: agentState.authorization?.mode ?? 'default',
    workspaceAccess: agentState.workspaceAccess ?? 'write',
    phase: (agentState.phase as 'planning' | 'building') ?? 'planning',
  });

  // ── Turn / Turn ──
  base.turn.turnIndex = turnIndex;

  // ── Plan / Plan ──
  if (agentState.plan) {
    const hash = computePlanStructuralHash(agentState.plan);
    if (agentState.planReviewed) {
      base.plan = {
        kind: 'approved',
        planId: hash.slice(0, 16),
        version: 1,
        plan: agentState.plan,
        structuralHash: hash,
        approvedAtTurnId: base.turn.turnId,
        executionMode: agentState.interactionMode === 'auto' ? 'auto' : 'manual',
      };
    } else {
      base.plan = {
        kind: 'drafted',
        planId: hash.slice(0, 16),
        version: 1,
        draft: agentState.plan,
        structuralHash: hash,
      };
    }
  }

  // ── Authorization / Authorization ──
  if (agentState.authorization) {
    base.authorization = {
      mode: agentState.authorization.mode,
      commandGrants: agentState.authorization.commandGrants ?? {},
    };
  }

  // ── Auto-review / Auto-review ──
  if (agentState.autoReviewState) {
    base.autoReview = { ...agentState.autoReviewState };
  }

  // ── Doom-loop / Doom-loop ──
  if (agentState.doomLoopTracker) {
    base.doomLoop = { ...agentState.doomLoopTracker };
  }

  return base;
}

// ── RuntimeState → AgentState 投影 / RuntimeState to AgentState projection ──

/**
 * 将 RuntimeState 投影为 AgentState channel 的部分更新。
 * Project RuntimeState into a partial AgentState channel update.
 *
 * 仅包含可映射的字段，graph 节点使用此投影更新 LangGraph state。
 * Only includes mappable fields; graph nodes use this projection to update LangGraph state.
 *
 * @param runtimeState - 当前运行时状态 / Current runtime state
 * @returns AgentState 的部分更新 / Partial AgentState update
 */
export function runtimeStateToAgentStatePartial(
  runtimeState: RuntimeState,
): Partial<CodeAgentState> {
  const partial: Partial<CodeAgentState> = {};

  // ── Plan / Plan ──
  switch (runtimeState.plan.kind) {
    case 'none':
      partial.plan = null;
      partial.planReviewed = false;
      break;
    case 'drafted':
    case 'awaiting_review':
    case 'needs_revision':
      partial.plan = runtimeState.plan.draft;
      partial.planReviewed = false;
      break;
    case 'approved':
    case 'building':
    case 'completed':
      partial.plan = runtimeState.plan.plan;
      partial.planReviewed = true;
      break;
  }

  // ── Mode / Mode ──
  partial.interactionMode = runtimeState.mode;

  // ── Phase / Phase ──
  partial.phase = runtimeState.phase;

  // ── Workspace access / Workspace access ──
  partial.workspaceAccess = runtimeState.workspaceAccess;

  // ── Authorization / Authorization ──
  partial.authorization = {
    mode: runtimeState.authorization.mode,
    commandGrants: runtimeState.authorization.commandGrants,
  };

  // ── Auto-review / Auto-review ──
  partial.autoReviewState = { ...runtimeState.autoReview };

  // ── Doom-loop / Doom-loop ──
  partial.doomLoopTracker = { ...runtimeState.doomLoop };

  return partial;
}
