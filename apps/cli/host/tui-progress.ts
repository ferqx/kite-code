import type { AgentClient, SessionView } from '@kite-ai/client';

export type TuiPlanProgressStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'compensated';
export type TuiProgress = {
  plan?: { title?: string; steps: { step: string; status: TuiPlanProgressStatus }[] };
  compactionPhase?: 'preparing' | 'summarizing' | 'validating';
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const identity = (value: Record<string, unknown>, current: Record<string, unknown>) =>
  ['planId', 'version', 'digest'].every((key) => value[key] === current[key]);

/** Optional, bounded public business projection. Missing facts never become invented progress. */
export async function readTuiProgress(
  client: Pick<AgentClient, 'queryExtension'>,
  view: SessionView,
  storeId: string,
  signal: AbortSignal,
): Promise<TuiProgress> {
  const active = view.runs.filter(
    (run) => run.isActive && run.sessionId === view.session.id && run.originStoreId === storeId,
  );
  if (view.storeId !== storeId || active.length > 1) return {};
  const run = active[0] ?? view.runs.at(-1);
  if (!run || run.sessionId !== view.session.id || run.originStoreId !== storeId) return {};
  const result: TuiProgress = {};
  const compression = view.compressionProgress;
  if (
    compression &&
    active[0]?.id === compression.runId &&
    compression.originStoreId === storeId &&
    ['preparing', 'summarizing', 'validating'].includes(compression.phase)
  )
    result.compactionPhase = compression.phase as NonNullable<TuiProgress['compactionPhase']>;
  try {
    signal.throwIfAborted();
    const parts = await client.queryExtension(
      view.session.id,
      'builtin.planning',
      'planning.progress.view',
      { runId: run.id },
      { signal },
    );
    signal.throwIfAborted();
    if (parts.length !== 1) return result;
    const part = parts[0]!;
    if (
      part.extensionId !== 'builtin.planning' ||
      part.contentType !== 'builtin.planning.record' ||
      part.contentVersion !== 1
    )
      return result;
    const body = record(part.payload),
      current = record(body?.current),
      plan = record(body?.plan),
      progress = record(body?.progress);
    if (
      !body ||
      body.runId !== run.id ||
      body.approvalStatus !== 'approved' ||
      body.originStoreId !== storeId ||
      !current ||
      !plan ||
      current.kind !== 'plan_current' ||
      plan.kind !== 'plan_document' ||
      typeof current.planId !== 'string' ||
      typeof current.digest !== 'string' ||
      !Number.isSafeInteger(current.version) ||
      !identity(plan, current) ||
      !Array.isArray(plan.steps) ||
      !plan.steps.length
    )
      return result;
    if (
      body.progress !== null &&
      (progress?.kind !== 'plan_progress' ||
        progress.runId !== run.id ||
        !identity(progress, current) ||
        !record(progress.steps))
    )
      return result;
    const states = progress ? record(progress.steps)! : {};
    const seen = new Set<string>();
    const steps: NonNullable<TuiProgress['plan']>['steps'] = [];
    for (const item of plan.steps) {
      const step = record(item);
      if (
        !step ||
        typeof step.id !== 'string' ||
        !step.id ||
        seen.has(step.id) ||
        typeof step.title !== 'string' ||
        !step.title.trim()
      )
        return result;
      seen.add(step.id);
      const state = record(states[step.id]);
      if (step.id in states && !state) return result;
      const status = state ? state.status : 'pending';
      if (
        !['pending', 'running', 'completed', 'failed', 'blocked', 'compensated'].includes(
          String(status),
        )
      )
        return result;
      steps.push({
        step: step.title,
        status: status === 'running' ? 'in_progress' : (status as TuiPlanProgressStatus),
      });
    }
    if (Object.keys(states).some((key) => !seen.has(key))) return result;
    return {
      ...result,
      plan: {
        ...(typeof plan.title === 'string' && plan.title.trim() ? { title: plan.title } : {}),
        steps,
      },
    };
  } catch {
    return result;
  }
}
