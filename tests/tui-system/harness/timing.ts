const DEFAULT_CI_TIMEOUT_SCALE = 1.5;
const MINIMUM_TUI_FILE_TIMEOUT_MS = 16_000;

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

export function nestedTuiDeadlineBudget(input: {
  fileTimeoutMs: number;
  requestedBunTestTimeoutMs: number;
  requestedJourneyDeadlineMs: number;
  fileTeardownMarginMs: number;
  testTeardownMarginMs: number;
}): { bunTestTimeoutMs: number; journeyDeadlineMs: number } {
  if (!Number.isInteger(input.fileTimeoutMs) || input.fileTimeoutMs < MINIMUM_TUI_FILE_TIMEOUT_MS) {
    throw new Error(
      `TUI file timeout must be at least ${MINIMUM_TUI_FILE_TIMEOUT_MS}ms; received ${input.fileTimeoutMs}`,
    );
  }
  const bunTestTimeoutMs = Math.min(
    input.requestedBunTestTimeoutMs,
    input.fileTimeoutMs - input.fileTeardownMarginMs,
  );
  const journeyDeadlineMs = Math.min(
    input.requestedJourneyDeadlineMs,
    bunTestTimeoutMs - input.testTeardownMarginMs,
  );
  if (journeyDeadlineMs <= 0) {
    throw new Error('TUI deadline margins leave no positive journey budget.');
  }
  return { bunTestTimeoutMs, journeyDeadlineMs };
}
