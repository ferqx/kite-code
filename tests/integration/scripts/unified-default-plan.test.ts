import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTestSuites } from '../../../scripts/test-plan';
import {
  FINITE_ROOT_SCRIPT_TESTS,
  UNIFIED_FIRST_TEST_FILES,
  UNIFIED_RUNTIME_WORKSPACES,
  UNIFIED_TEST_SUITES,
  unifiedTestInventory,
} from '../../../scripts/unified-test-plan';

const root = join(import.meta.dir, '../../..');

test('default selection covers current public safety and formal lifecycle files exactly once', () => {
  const files = unifiedTestInventory(root);
  expect(new Set(files).size).toBe(files.length);
  const plan = planTestSuites(root, UNIFIED_TEST_SUITES, 4);
  expect(plan.counts.parallel + plan.counts.isolated + plan.counts.exclusive).toBe(files.length);
  for (const file of [
    'apps/service/test/isolated/default-after-turn.test.ts',
    'apps/service/test/isolated/task-packaged-default.test.ts',
    'apps/desktop/test/isolated/native-electron.test.ts',
    'apps/cli/test/isolated/file-recovery-crash.test.ts',
    'apps/cli/test/isolated/tui-file-recovery-crash.test.ts',
    'tests/isolated/unified-agent/dispatch-recovery.test.ts',
    'packages/agent/test/isolated/jobs/confined-shell.test.ts',
    'tests/isolated/unified-agent/formal-terminal-entrypoints.test.ts',
    'tests/isolated/unified-agent/native-install-lifecycle.test.ts',
  ])
    expect(files).toContain(file);
  for (const file of FINITE_ROOT_SCRIPT_TESTS) expect(files).toContain(file);
  expect(UNIFIED_FIRST_TEST_FILES).toEqual([
    'tests/isolated/unified-agent/cli-registration-lifecycle.test.ts',
  ]);
  for (const file of UNIFIED_FIRST_TEST_FILES) expect(files).toContain(file);
  expect(UNIFIED_RUNTIME_WORKSPACES).toHaveLength(8);
  expect(
    files.some((file) => file.startsWith('apps/kite-') || file.startsWith('packages/runtime-')),
  ).toBe(false);
  expect(UNIFIED_TEST_SUITES).not.toContain('tests/integration');
  expect(UNIFIED_TEST_SUITES).not.toContain('tests/isolated');
});

test('selection uses owned paths, preserving negative legacy strings without discovering old writers', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'kite-unified-plan-'));
  try {
    const current = 'apps/service/test/negative.test.ts';
    const old = 'apps/kite-service/test/writer.test.ts';
    for (const file of [current, old]) {
      mkdirSync(join(fixture, file, '..'), { recursive: true });
      writeFileSync(
        join(fixture, file),
        file === current
          ? "const forbidden = '@kite-ai/runtime-host';\n"
          : "throw Error('old writer');\n",
      );
    }
    expect(unifiedTestInventory(fixture)).toEqual([current]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
