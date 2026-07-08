import type { AgentPlan } from '@/protocol/events';

/**
 * 判断 update_plan 是否为纯进度更新。
 * 比较 name、description、步骤数量和每条步骤文本是否完全一致。
 * 若结构（文本）未变，则只可能是 status 字段变化 → 纯进度更新，无需触发 plan_review。
 *
 * 容错：模型在进度追踪调用中偶尔会省略 name / description 字段。
 * 缺失字段视为「与当前 plan 一致」，不触发误判。
 *
 * Checks whether an update_plan call is a progress-only update (only status fields changed).
 * If name, description, step count, and every step's text are identical to the current plan,
 * the only possible change is step status — no plan_review needed.
 *
 * Tolerance: the model sometimes omits name/description in progress-tracking calls.
 * Missing fields are treated as "unchanged from current plan" to avoid false positives.
 */
export function isPlanProgressOnlyUpdate(
  current: AgentPlan | null | undefined,
  next: AgentPlan,
): boolean {
  if (!current) return false;
  // 模型在进度追踪调用中可能省略 name/description → 视为未变化
  // Model may omit name/description in progress-tracking calls → treat as unchanged
  // 模型可能省略 name/description，也可能传空字符串（Zod 将缺失字段转为 ""）。
  // 缺失或空值 → 视为「与当前 plan 一致」，不触发误判。
  // Model may omit name/description or pass "" (Zod defaults missing strings to "").
  // Missing or empty → treated as "unchanged from current plan".
  if (next.name && current.name !== next.name) return false;
  if (next.description && current.description !== next.description) return false;
  if (current.steps.length !== next.steps.length) return false;
  return current.steps.every((step, index) => step.step === next.steps[index]?.step);
}

/**
 * 判断 update_plan 是否为同计划的追踪更新（已审批方案的重入，仅做进度/文本微调）。
 * 与 isPlanProgressOnlyUpdate 不同：本函数允许步骤文本变化（模型执行时常会扩充描述），
 * 仅检查计划名称和步骤数量是否一致，确保结构未发生根本变化。
 *
 * 多轮 plan 保护：当前计划状态为 completed 时视为该计划周期已结束，后续任何
 * update_plan 均视为新计划，必须重新走 plan_review，避免同名称、同步数的新计划被跳过。
 *
 * 容错：模型在进度追踪调用中偶尔会省略 name 字段。缺失字段视为「与当前 plan 一致」。
 *
 * Checks whether a re-entrant update_plan is a tracking update for an already-approved plan.
 * Unlike isPlanProgressOnlyUpdate, this ALLOWS step text changes (model often elaborates
 * during execution) and only guards against name changes or step count changes.
 *
 * Multi-cycle guard: when the current plan is completed, treat any subsequent update_plan
 * as a NEW plan requiring full review — prevents skipping review for a new plan that
 * happens to have the same name and step count as a completed previous plan.
 *
 * Tolerance: the model sometimes omits name in re-entrant calls. Missing fields are
 * treated as "unchanged from current plan" to avoid false positives.
 */
export function isSamePlanTrackingUpdate(
  current: AgentPlan | null | undefined,
  next: AgentPlan,
): boolean {
  if (!current) return false;
  // 上一轮计划已完成 → 视为新计划，必须走 plan_review
  // Previous plan completed → treat as new plan, must go through plan_review
  if (current.status === 'completed') return false;
  // 模型在进度追踪调用中可能省略 name → 视为未变化
  // Model may omit name in re-entrant calls → treat as unchanged
  if (next.name && current.name !== next.name) return false;
  if (current.steps.length !== next.steps.length) return false;
  return true;
}

/**
 * 分类 update_plan 调用的变更类型，综合 isPlanProgressOnlyUpdate 和 isSamePlanTrackingUpdate 的判断。
 *
 * - 'new'：当前没有 plan（首次创建），必须走 plan_review
 * - 'structural'：名称变化或步骤数量变化（结构性变更），必须走 plan_review
 * - 'progress'：仅 status 字段变化（纯进度更新），可直通 tools
 * - 'tracking'：同结构、同名称、同步数，但步骤文本可能变化（已审批方案的重入追踪），直通 tools
 *
 * Classifies the type of change in an update_plan call, combining the judgments of
 * isPlanProgressOnlyUpdate and isSamePlanTrackingUpdate.
 *
 * - 'new': No current plan (first creation) — must go through plan_review
 * - 'structural': Name or step count changed — must go through plan_review
 * - 'progress': Only status fields changed (progress-only) — can go directly to tools
 * - 'tracking': Same structure/name/step count, step text may differ (re-entrant tracking
 *   of an already-approved plan) — can go directly to tools
 */
export function classifyPlanUpdate(
  current: AgentPlan | null | undefined,
  next: AgentPlan,
): 'new' | 'structural' | 'progress' | 'tracking' {
  if (!current) return 'new';
  // 名称或步骤数量变化 → 结构性变更
  // Name or step count changed → structural
  if ((next.name && current.name !== next.name) || current.steps.length !== next.steps.length) {
    return 'structural';
  }
  // 同结构 + 文本未变 → 纯进度更新
  // Same structure + text unchanged → progress-only
  if (isPlanProgressOnlyUpdate(current, next)) {
    return 'progress';
  }
  // 同结构 + 文本变化 → 追踪更新（isSamePlanTrackingUpdate 校验 completed 守卫）
  // Same structure + text changed → tracking (isSamePlanTrackingUpdate guards completed)
  if (isSamePlanTrackingUpdate(current, next)) {
    return 'tracking';
  }
  // 理论上不可达：同结构下 isSamePlanTrackingUpdate 为 false 的条件是 current.status === 'completed'
  // Not reachable: within same structure, isSamePlanTrackingUpdate false only when current.status is 'completed'
  return 'structural';
}
