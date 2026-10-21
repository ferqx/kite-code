import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runTestJob } from '../../../scripts/test-suite';
import {
  FINITE_ROOT_SCRIPT_TESTS,
  UNIFIED_EXCLUSIVE_TEST_FILES,
  UNIFIED_RUNTIME_WORKSPACES,
  UNIFIED_TEST_SUITES,
  unifiedTestInventory,
  unifiedTestPlan,
} from '../../../scripts/unified-test-plan';

const root = join(import.meta.dir, '../../..');

test('default selection covers current public safety and formal lifecycle files exactly once', () => {
  const files = unifiedTestInventory(root);
  expect(new Set(files).size).toBe(files.length);
  const plan = unifiedTestPlan(root, 4);
  expect(plan.counts.parallel + plan.counts.isolated + plan.counts.exclusive).toBe(files.length);
  const plannedFiles = [...plan.concurrent, ...plan.exclusive].flatMap((job) =>
    job.files.map((file) => file.slice(root.length + 1).replaceAll('\\', '/')),
  );
  expect(plannedFiles.sort()).toEqual(files);
  expect(new Set(plannedFiles).size).toBe(files.length);
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
  expect(UNIFIED_EXCLUSIVE_TEST_FILES).toEqual([
    'apps/cli/test/isolated/cli-caller-host.test.ts',
    'apps/cli/test/isolated/tui-export-host.test.ts',
    'tests/isolated/unified-agent/cli-registration-lifecycle.test.ts',
    'tests/isolated/unified-agent/native-cross-version.test.ts',
    'tests/isolated/unified-agent/native-install-lifecycle.test.ts',
    'tests/isolated/unified-agent/native-restore-interruption.test.ts',
    'tests/isolated/unified-agent/terminal-bundle.test.ts',
  ]);
  for (const file of UNIFIED_EXCLUSIVE_TEST_FILES) {
    expect(files).toContain(file);
    const absolute = join(root, file);
    expect(plan.concurrent.some((job) => job.files.includes(absolute))).toBe(false);
    expect(plan.exclusive.filter((job) => job.files.includes(absolute))).toEqual([
      { label: `exclusive:${file}`, files: [absolute], maxConcurrency: 1 },
    ]);
  }
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

test('default jobs run only their explicit planned files despite ignored archived same-name tests', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'kite-unified-exact-plan-'));
  const planned = 'apps/service/test/isolated/only.test.ts';
  const archived = `dist/unified-evidence/original-paths/snapshot/${planned}`;
  try {
    for (const file of [planned, archived])
      mkdirSync(join(fixture, file, '..'), { recursive: true });
    writeFileSync(join(fixture, '.gitignore'), 'dist/\n');
    writeFileSync(
      join(fixture, planned),
      "import {expect,test} from 'bun:test';test('original planned file',()=>expect(true).toBe(true));\n",
    );
    writeFileSync(
      join(fixture, archived),
      "import './deliberately-unavailable-archived-fixture';\n",
    );
    for (const file of UNIFIED_EXCLUSIVE_TEST_FILES) {
      mkdirSync(join(fixture, file, '..'), { recursive: true });
      writeFileSync(
        join(fixture, file),
        "import {test} from 'bun:test';test('listed fixture',()=>{});\n",
      );
    }
    const inventory = unifiedTestInventory(fixture),
      plan = unifiedTestPlan(fixture, 2);
    const jobs = [...plan.concurrent, ...plan.exclusive];
    expect(inventory).toEqual([planned, ...UNIFIED_EXCLUSIVE_TEST_FILES].sort());
    expect(jobs).toHaveLength(1 + UNIFIED_EXCLUSIVE_TEST_FILES.length);
    const target = jobs.find((job) => job.files.includes(join(fixture, planned)))!;
    expect(target.files).toEqual([join(fixture, planned)]);
    const before = JSON.stringify(plan);
    expect(await runTestJob(fixture, target)).toBe(0);
    expect(JSON.stringify(plan)).toBe(before);
    expect(unifiedTestInventory(fixture)).toEqual(inventory);
    expect(unifiedTestPlan(fixture, 2)).toEqual(plan);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
