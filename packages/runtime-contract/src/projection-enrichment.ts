import type { RuntimeSessionProjection } from './projections';

/** Same-revision metadata is enriched by the Host without creating a message revision.
 * All stable Session fields still have to agree exactly.
 */
export function isRuntimeSessionProjectionEnrichment(
  current: RuntimeSessionProjection,
  next: RuntimeSessionProjection,
): boolean {
  if (current.sessionId !== next.sessionId || current.revision !== next.revision) return false;
  const { model: _currentModel, ...stableCurrent } = current;
  const { model: _nextModel, ...stableNext } = next;
  return (
    stableSerializeIgnoringUndefined(stableCurrent) ===
      stableSerializeIgnoringUndefined(stableNext) ||
    isExecutionLifecycleEnrichment(stableCurrent, stableNext)
  );
}

function isExecutionLifecycleEnrichment(
  current: RuntimeSessionProjection,
  next: RuntimeSessionProjection,
): boolean {
  const currentRun = current.currentRun;
  const nextRun = next.currentRun;
  if (!currentRun || !nextRun || currentRun.runId !== nextRun.runId) return false;
  const activation = currentRun.status === 'queued' && nextRun.status === 'running';
  const cleanup =
    ['queued', 'running', 'waiting'].includes(currentRun.status) &&
    ['completed', 'cancelled', 'failed'].includes(nextRun.status);
  const taskEnrichment =
    current.activeTask === undefined &&
    next.activeTask !== undefined &&
    currentRun.taskId === undefined &&
    nextRun.taskId === next.activeTask.taskId;
  if (!activation && !cleanup && !taskEnrichment) return false;
  if (
    currentRun.initialTurnId !== nextRun.initialTurnId ||
    currentRun.activeTurnId !== nextRun.activeTurnId ||
    currentRun.activeInteractionId !== nextRun.activeInteractionId ||
    currentRun.revision !== nextRun.revision ||
    (!taskEnrichment && currentRun.taskId !== nextRun.taskId) ||
    (!activation && !cleanup && currentRun.status !== nextRun.status) ||
    (!cleanup &&
      stableSerializeIgnoringUndefined(currentRun.outcome) !==
        stableSerializeIgnoringUndefined(nextRun.outcome))
  )
    return false;
  const expected: RuntimeSessionProjection = {
    ...current,
    ...(taskEnrichment ? { activeTask: next.activeTask } : {}),
    currentRun: nextRun,
  };
  return stableSerializeIgnoringUndefined(expected) === stableSerializeIgnoringUndefined(next);
}

function stableSerializeIgnoringUndefined(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerializeIgnoringUndefined).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerializeIgnoringUndefined(record[key])}`)
    .join(',')}}`;
}
