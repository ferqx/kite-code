import type { PublicView } from '@kite-ai/client';

const statuses = ['pending', 'running', 'completed', 'failed', 'blocked', 'compensated'] as const;
type StepStatus = (typeof statuses)[number];

export type NativePlanProgress = {
  planId: string;
  version: number;
  digest: string;
  title: string;
  reviewExecutionId: string;
  steps: readonly { id: string; title: string; status: StepStatus }[];
};

export type NativePlanProgressRequest = {
  method: 'planning.progress';
  generation: number;
  viewSelection: number;
  historyEpoch: number;
  runId: string;
  history: boolean;
};

export type NativePlanProgressResult = {
  kind: 'planning.progress';
  storeId: string;
  sessionId: string;
  runId: string;
  plans: readonly NativePlanProgress[];
};

export function nativePlanProgress(
  views: readonly PublicView[],
  scope: { storeId: string; sessionId: string; runId: string; history: boolean },
): NativePlanProgressResult {
  const invalid = (): never => {
    throw Error('planning_progress_unavailable');
  };
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : invalid();
  const string = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value : invalid();
  if (
    views.length !== 1 ||
    views[0]?.extensionId !== 'builtin.planning' ||
    views[0].contentType !== 'builtin.planning.record' ||
    views[0].contentVersion !== 1
  )
    return invalid();
  const payload = record(views[0].payload);
  if (
    payload.runId !== scope.runId ||
    payload.originStoreId !== scope.storeId ||
    !Array.isArray(payload.plans) ||
    (!scope.history && payload.plans.length > 1)
  )
    return invalid();
  const approvals = new Set<string>();
  const plans = payload.plans.map((value): NativePlanProgress => {
    const plan = record(value);
    const reviewExecutionId = string(plan.reviewExecutionId);
    if (
      approvals.has(reviewExecutionId) ||
      typeof plan.version !== 'number' ||
      !Number.isSafeInteger(plan.version) ||
      plan.version < 1 ||
      !Array.isArray(plan.steps) ||
      !plan.steps.length
    )
      return invalid();
    approvals.add(reviewExecutionId);
    const ids = new Set<string>();
    const steps = plan.steps.map((value) => {
      const step = record(value);
      const id = string(step.id);
      const status = statuses.find((value) => value === step.status);
      if (ids.has(id) || !status) return invalid();
      ids.add(id);
      return { id, title: string(step.title), status };
    });
    return {
      planId: string(plan.planId),
      version: plan.version,
      digest: string(plan.digest),
      title: string(plan.title),
      reviewExecutionId,
      steps,
    };
  });
  return {
    kind: 'planning.progress',
    storeId: scope.storeId,
    sessionId: scope.sessionId,
    runId: scope.runId,
    plans,
  };
}
