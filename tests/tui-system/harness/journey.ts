import { tuiWaitTimeout } from './timing';

export type TuiSystemJourneyStep = () => void | Promise<void>;

interface RegisteredJourneyStep {
  name: string;
  run: TuiSystemJourneyStep;
  timeoutMs: number;
}

export interface TuiSystemJourney {
  readonly step: (name: string, run: TuiSystemJourneyStep, timeoutMs?: number) => void;
  readonly run: (deadlineMs?: number) => Promise<void>;
  readonly size: () => number;
}

const DEFAULT_STEP_TIMEOUT_MS = 30_000;
const DEFAULT_JOURNEY_DEADLINE_MS = 165_000;

function defaultJourneyDeadlineMs(): number {
  const configured = Number(process.env.KITE_TUI_TEST_JOURNEY_DEADLINE_MS);
  if (Number.isInteger(configured) && configured > 0) return configured;
  return tuiWaitTimeout(DEFAULT_JOURNEY_DEADLINE_MS);
}

async function runWithTimeout(
  step: RegisteredJourneyStep,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(step.run),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Register named checkpoints inside one stateful PTY journey.
 *
 * A journey owns one TUI process, mock response queue and workspace. Its
 * checkpoints are deliberately not Bun test cases: later checkpoints may
 * consume state produced by earlier ones, so exposing them as independently
 * runnable tests would be false and would create cascading failures.
 */
export function createTuiSystemJourney(): TuiSystemJourney {
  const steps: RegisteredJourneyStep[] = [];
  let running = false;

  return {
    step(name, run, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) {
      if (running) throw new Error('cannot register a TUI system journey step after run() starts');
      if (!name.trim()) throw new Error('TUI system journey step name cannot be empty');
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
        throw new Error(`TUI system journey step timeout must be positive; received ${timeoutMs}`);
      }
      steps.push({ name, run, timeoutMs });
    },
    async run(deadlineMs = defaultJourneyDeadlineMs()) {
      if (running) throw new Error('TUI system journey can only run once');
      if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
        throw new Error(`TUI system journey deadline must be positive; received ${deadlineMs}`);
      }
      running = true;
      const startedAt = Date.now();
      for (const [index, step] of steps.entries()) {
        try {
          const remainingMs = deadlineMs - (Date.now() - startedAt);
          if (remainingMs <= 0) {
            throw new Error(`journey deadline of ${deadlineMs}ms was exhausted`);
          }
          const scaledStepTimeoutMs = tuiWaitTimeout(step.timeoutMs);
          const timeoutMs = Math.min(scaledStepTimeoutMs, remainingMs);
          const timeoutMessage =
            remainingMs <= scaledStepTimeoutMs
              ? `journey deadline of ${deadlineMs}ms was exhausted during this step`
              : `step timed out after ${scaledStepTimeoutMs}ms`;
          await runWithTimeout(step, timeoutMs, timeoutMessage);
        } catch (error) {
          throw new Error(
            `TUI system journey failed at step ${index + 1}/${steps.length}: ${step.name}`,
            { cause: error },
          );
        }
      }
    },
    size() {
      return steps.length;
    },
  };
}
