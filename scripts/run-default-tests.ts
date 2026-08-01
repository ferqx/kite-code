/**
 * Default deterministic test boundary.
 *
 * Bun's non-isolated runner shares process.cwd() and process.env across test
 * files. A small legacy set intentionally mutates those globals to exercise
 * user/project path resolution, so those files must run in their own process.
 * Bun per-file isolation is not used because the current Ink/Yoga ESM stack
 * cannot initialize reliably under that mode.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROCESS_ISOLATED_TEST_FILES = [
  'tests/mcp-config-catalog.test.ts',
  'tests/mcp-config-repository.test.ts',
  'tests/mcp-project-approval.test.ts',
  'tests/runtime/capability-artifacts.test.ts',
  'tests/runtime/plan-artifacts.test.ts',
] as const;

const DEFAULT_IGNORES = [
  'tests/tui-system/scenarios/**',
  'tests/tui-system/smoke/**',
  'tests/pty-spike/**',
  'tests/sandbox-executor.test.ts',
  'tests/sandbox-bwrap-executor.test.ts',
  ...PROCESS_ISOLATED_TEST_FILES,
] as const;

async function runTestProcess(args: string[]): Promise<number> {
  const testHome = mkdtempSync(join(tmpdir(), 'openpx-default-test-home-'));
  try {
    const child = Bun.spawn([process.execPath, 'test', '--no-orphans', ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        KITE_CODE_HOME: testHome,
        ...(process.platform === 'win32' ? { USERPROFILE: testHome } : {}),
      },
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    return await child.exited;
  } finally {
    rmSync(testHome, { recursive: true, force: true });
  }
}

const mainExit = await runTestProcess([
  '--max-concurrency=1',
  '--only-failures',
  ...DEFAULT_IGNORES.map((pattern) => `--path-ignore-patterns=${pattern}`),
]);
if (mainExit !== 0) process.exit(mainExit);

for (const file of PROCESS_ISOLATED_TEST_FILES) {
  console.log(`\n[default-test] isolated process: ${file}`);
  const exitCode = await runTestProcess(['--max-concurrency=1', file]);
  if (exitCode !== 0) process.exit(exitCode);
}

console.log(
  `\n[default-test] passed main suite and ${PROCESS_ISOLATED_TEST_FILES.length} process-isolated files`,
);
