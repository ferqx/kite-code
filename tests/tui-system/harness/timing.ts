const DEFAULT_CI_TIMEOUT_SCALE = 1.5;

function positiveNumber(value: string | undefined): number | undefined {
  if (value == null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Scale condition-wait budgets on shared CI runners without changing local
 * feedback speed. KITE_TUI_TEST_TIMEOUT_SCALE is intentionally bounded so a
 * broken condition still fails within the per-file hard timeout.
 */
export function tuiWaitTimeout(timeoutMs: number, env: NodeJS.ProcessEnv = process.env): number {
  const configuredScale = positiveNumber(env.KITE_TUI_TEST_TIMEOUT_SCALE);
  const scale = configuredScale ?? (env.CI ? DEFAULT_CI_TIMEOUT_SCALE : 1);
  return Math.ceil(timeoutMs * Math.min(scale, 3));
}

export function tuiPollInterval(intervalMs: number): number {
  return Math.max(10, Math.min(intervalMs, 250));
}
