import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  terminateOwnedProcessTree,
  verifiedOwnedProcessGroupId,
} from '../tests/tui-system/harness/pty-process';
import { nestedTuiDeadlineBudget, tuiWaitTimeout } from '../tests/tui-system/harness/timing';

const DEFAULT_FILE_TIMEOUT_MS = 240_000;
const DEFAULT_BUN_TEST_TIMEOUT_MS = 170_000;
const DEFAULT_JOURNEY_DEADLINE_MS = 165_000;
const FILE_TEARDOWN_MARGIN_MS = 10_000;
const TEST_TEARDOWN_MARGIN_MS = 5_000;
export const TUI_LIFECYCLE_HARNESS_FLAG = '--with-lifecycle-harness';
const harnessDir = join(process.cwd(), 'tests', 'tui-system', 'harness');
const scenariosDir = join(process.cwd(), 'tests', 'tui-system', 'scenarios');
const faultSoakRepeatCount = positiveInteger(process.env.KITE_FAULT_SOAK_REPEAT_COUNT, 1);
const faultSoakProcessGroupId =
  process.platform !== 'win32' && process.env.KITE_FAULT_SOAK_PROCESS_NONCE
    ? verifiedOwnedProcessGroupId(process.pid)
    : undefined;

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export interface TuiSystemTestSelection {
  harnessFiles: string[];
  scenarioFiles: string[];
}

export function selectTuiSystemTestFiles(args: readonly string[]): TuiSystemTestSelection {
  const available = readdirSync(scenariosDir)
    .filter((name) => name.endsWith('.test.ts'))
    .sort();
  const includeLifecycleHarness = args.includes(TUI_LIFECYCLE_HARNESS_FLAG);
  const requested = args.filter((argument) => argument !== TUI_LIFECYCLE_HARNESS_FLAG);
  const selected =
    requested.length === 0
      ? available
      : available.filter((name) =>
          requested.some((query) => name === query || name === `${query}.test.ts`),
        );
  if (selected.length === 0) {
    throw new Error(`No TUI system scenarios matched: ${requested.join(', ')}`);
  }
  return {
    harnessFiles: includeLifecycleHarness
      ? [join(harnessDir, 'tui-lifecycle-resource.test.ts')]
      : [],
    scenarioFiles: selected.map((name) => join(scenariosDir, name)),
  };
}

async function runFile(file: string, timeoutMs: number): Promise<number> {
  console.log(`\n[tui-system] ${file}`);
  const { bunTestTimeoutMs, journeyDeadlineMs } = nestedTuiDeadlineBudget({
    fileTimeoutMs: timeoutMs,
    requestedBunTestTimeoutMs: tuiWaitTimeout(DEFAULT_BUN_TEST_TIMEOUT_MS),
    requestedJourneyDeadlineMs: tuiWaitTimeout(DEFAULT_JOURNEY_DEADLINE_MS),
    fileTeardownMarginMs: FILE_TEARDOWN_MARGIN_MS,
    testTeardownMarginMs: TEST_TEARDOWN_MARGIN_MS,
  });
  const inheritsFaultSoakProcessGroup = faultSoakProcessGroupId !== undefined;
  const proc = Bun.spawn(
    [
      process.execPath,
      'test',
      '--parallel=1',
      '--max-concurrency=1',
      '--timeout',
      String(bunTestTimeoutMs),
      file,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        KITE_FAULT_SOAK_REPEAT_COUNT: String(faultSoakRepeatCount),
        KITE_TUI_TEST_JOURNEY_DEADLINE_MS: String(journeyDeadlineMs),
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
      detached: process.platform !== 'win32' && !inheritsFaultSoakProcessGroup,
    },
  );
  const processGroupId =
    process.platform !== 'win32' && !inheritsFaultSoakProcessGroup
      ? verifiedOwnedProcessGroupId(proc.pid)
      : undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([proc.exited, timeout]);
  if (timer) clearTimeout(timer);

  if (result === 'timeout') {
    console.error(`[tui-system] timed out after ${timeoutMs}ms: ${file}`);
    if (inheritsFaultSoakProcessGroup && process.platform !== 'win32') {
      // The fault-soak probe owns this entire process group. Killing it also
      // reaps per-file and lifecycle children when `ps` inspection is absent.
      process.kill(-faultSoakProcessGroupId, 'SIGKILL');
    } else {
      await terminateOwnedProcessTree(proc, processGroupId).catch(() => {});
    }
    return 124;
  }
  if (process.platform === 'win32' || processGroupId !== undefined) {
    await terminateOwnedProcessTree(proc, processGroupId).catch(() => {});
  }
  return result;
}

async function main(): Promise<void> {
  const timeoutMs = positiveInteger(
    process.env.KITE_TUI_TEST_FILE_TIMEOUT_MS,
    tuiWaitTimeout(DEFAULT_FILE_TIMEOUT_MS),
  );
  const selection = selectTuiSystemTestFiles(process.argv.slice(2));

  for (const file of [...selection.harnessFiles, ...selection.scenarioFiles]) {
    const exitCode = await runFile(file, timeoutMs);
    if (exitCode !== 0) {
      console.error(`[tui-system] failed with exit code ${exitCode}: ${file}`);
      process.exit(exitCode);
    }
  }

  console.log(
    `\n[tui-system] passed ${selection.harnessFiles.length} explicit harness files and ${selection.scenarioFiles.length} isolated PTY scenario files`,
  );
}

if (import.meta.main) await main();
