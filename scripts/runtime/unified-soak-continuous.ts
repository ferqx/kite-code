/** Closed diagnostic workload evidence. Formal thresholds cannot be caller overrides. */
export const CONTINUOUS_MINIMUM_BUSY_MS = 450_000;
export const CONTINUOUS_OPERATION_MS = 180_000;
export interface ContinuousEvidence {
  version: 1;
  mode: 'diagnostic' | 'formal';
  status: 'passed' | 'failed';
  storeId: string;
  serviceInstanceIds: string[];
  sessionIds: string[];
  commandIds: string[];
  childExecutionIds: string[];
  synchronousEffects: number;
  childCalls: number;
  slowEntered: boolean;
  peerEvents: number;
  reconnects: number;
  completedCycles: number;
  wallDurationMs: number;
  activeWorkloadDurationMs: number;
  busyIntervals: [number, number][];
  operationDurationMs: number[];
  admissionLatencyMs: number[];
  cleanupConfirmed: boolean;
  missing: string[];
}
export function unionBusyIntervals(intervals: readonly (readonly [number, number])[]) {
  const ordered = [...intervals].sort((a, b) => a[0] - b[0]);
  const union: [number, number][] = [];
  for (const [start, end] of ordered) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start)
      throw Error('invalid_work_interval');
    const last = union.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else union.push([start, end]);
  }
  return union;
}
export function busyDuration(intervals: readonly (readonly [number, number])[]) {
  return unionBusyIntervals(intervals).reduce((sum, [start, end]) => sum + end - start, 0);
}
export function verifyContinuousEvidence(value: ContinuousEvidence, formal: boolean) {
  const expected = [
    'version',
    'mode',
    'status',
    'storeId',
    'serviceInstanceIds',
    'sessionIds',
    'commandIds',
    'childExecutionIds',
    'synchronousEffects',
    'childCalls',
    'slowEntered',
    'peerEvents',
    'reconnects',
    'completedCycles',
    'wallDurationMs',
    'activeWorkloadDurationMs',
    'busyIntervals',
    'operationDurationMs',
    'admissionLatencyMs',
    'cleanupConfirmed',
    'missing',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).length !== expected.length ||
    !expected.every((key) => Object.hasOwn(value, key))
  )
    return ['continuous_structure_invalid'];
  const ids = (values: unknown, count?: number): values is string[] =>
    Array.isArray(values) &&
    (count === undefined || values.length === count) &&
    new Set(values).size === values.length &&
    values.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id));
  if (
    value.version !== 1 ||
    !['diagnostic', 'formal'].includes(value.mode) ||
    value.status !== 'passed' ||
    !ids([value.storeId], 1) ||
    !ids(value.serviceInstanceIds, 2) ||
    !ids(value.sessionIds, 20) ||
    !ids(value.commandIds) ||
    !ids(value.childExecutionIds) ||
    !Number.isSafeInteger(value.completedCycles) ||
    value.completedCycles < 2 ||
    value.commandIds.length !== 20 * value.completedCycles ||
    value.synchronousEffects !== value.commandIds.length ||
    value.childCalls !== value.commandIds.length ||
    value.childExecutionIds.length !== value.commandIds.length ||
    value.slowEntered !== true ||
    !Number.isSafeInteger(value.peerEvents) ||
    value.peerEvents <= 0 ||
    value.reconnects !== value.completedCycles ||
    value.cleanupConfirmed !== true ||
    !Array.isArray(value.missing) ||
    !value.missing.every((item) => typeof item === 'string')
  )
    return ['continuous_workload_invalid'];
  if (
    !Number.isFinite(value.wallDurationMs) ||
    value.wallDurationMs < 0 ||
    !Number.isFinite(value.activeWorkloadDurationMs) ||
    value.activeWorkloadDurationMs <= 0 ||
    value.activeWorkloadDurationMs > value.wallDurationMs ||
    !Array.isArray(value.busyIntervals) ||
    value.busyIntervals.length !== value.commandIds.length ||
    !value.busyIntervals.every(
      (interval) =>
        Array.isArray(interval) &&
        interval.length === 2 &&
        interval.every((part) => typeof part === 'number'),
    ) ||
    !Array.isArray(value.operationDurationMs) ||
    value.operationDurationMs.length !== value.commandIds.length ||
    value.operationDurationMs.some(
      (duration) =>
        !Number.isFinite(duration) || duration < 0 || duration > CONTINUOUS_OPERATION_MS,
    ) ||
    !Array.isArray(value.admissionLatencyMs) ||
    value.admissionLatencyMs.length !== value.commandIds.length ||
    value.admissionLatencyMs.some(
      (duration) =>
        !Number.isFinite(duration) || duration < 0 || duration > CONTINUOUS_OPERATION_MS,
    )
  )
    return ['continuous_timing_invalid'];
  try {
    if (
      value.busyIntervals.some(([, end]) => end > value.wallDurationMs) ||
      value.busyIntervals.some(
        ([start, end], index) => Math.abs(end - start - value.operationDurationMs[index]!) > 0.001,
      ) ||
      Math.abs(busyDuration(value.busyIntervals) - value.activeWorkloadDurationMs) > 0.001
    )
      return ['continuous_busy_union_invalid'];
  } catch {
    return ['continuous_busy_union_invalid'];
  }
  if (
    formal &&
    (value.mode !== 'formal' ||
      value.missing.length ||
      value.activeWorkloadDurationMs < CONTINUOUS_MINIMUM_BUSY_MS)
  )
    return ['continuous_formal_unqualified'];
  if (formal) return ['continuous_background_shell_unqualified'];
  return [];
}
