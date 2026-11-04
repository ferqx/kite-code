const stages = ['shell_runtime', 'configuration', 'store', 'runtime', 'http'] as const;
declare const __KITE_SERVICE_STARTUP_TIMING__: boolean;
const enabled =
  typeof __KITE_SERVICE_STARTUP_TIMING__ !== 'undefined' && __KITE_SERVICE_STARTUP_TIMING__;
export type ServiceStartupTiming = Readonly<{
  code: 'service_startup_timing';
  stage: (typeof stages)[number];
  status: 'started' | 'completed' | 'failed';
  durationMs: number;
}>;

/** Only closed stage names and durations may leave private Service stderr. */
export function parseServiceStartupTiming(line: string): ServiceStartupTiming | undefined {
  if (line.length > 256) return;
  try {
    const value = JSON.parse(line);
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'code,durationMs,stage,status' ||
      value.code !== 'service_startup_timing' ||
      !stages.includes(value.stage) ||
      !['started', 'completed', 'failed'].includes(value.status) ||
      !Number.isSafeInteger(value.durationMs) ||
      value.durationMs < 0
    )
      return;
    return Object.freeze(value);
  } catch {
    return;
  }
}

export async function measureServiceStartup<T>(
  stage: ServiceStartupTiming['stage'],
  work: () => T,
) {
  if (!enabled) return await work();
  const startedAt = performance.now();
  const report = (status: ServiceStartupTiming['status']) => {
    try {
      process.stderr.write(
        `${JSON.stringify({ code: 'service_startup_timing', stage, status, durationMs: Math.round(performance.now() - startedAt) })}\n`,
      );
    } catch {
      // Timing observation cannot change startup or cleanup ownership.
    }
  };
  report('started');
  try {
    const result = await work();
    report('completed');
    return result;
  } catch (error) {
    report('failed');
    throw error;
  }
}
