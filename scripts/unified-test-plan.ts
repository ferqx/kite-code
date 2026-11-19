import { relative, resolve } from 'node:path';
import { planTestSuites, runTestPlan, type TestPlan } from './test-plan';
import { collectTestFiles, shardTestFiles, testParallelism } from './test-suite';

export const UNIFIED_RUNTIME_WORKSPACES = [
  'packages/trajectory',
  'packages/trace-extension-sdk',
  'packages/ai',
  'packages/agent',
  'packages/client',
  'packages/ui',
  'apps/service',
  'apps/cli',
  'apps/desktop',
  'apps/web',
] as const;

export const FINITE_ROOT_SCRIPT_TESTS = [
  'tests/integration/docs-structure.test.ts',
  'tests/integration/document-sync-skill.test.ts',
  'tests/integration/scripts/check-test-ownership.test.ts',
  'tests/integration/scripts/test-discovery.test.ts',
  'tests/integration/scripts/unified-workspaces.test.ts',
  'tests/integration/scripts/unified-default-plan.test.ts',
  'tests/integration/scripts/unified-ci.test.ts',
  'tests/isolated/scripts/agent-notes.test.ts',
  'tests/isolated/scripts/ci-logged-shell.test.ts',
  'tests/isolated/scripts/docs-impact-scopes.test.ts',
  'tests/isolated/scripts/docs-structure.test.ts',
  'tests/isolated/scripts/test-suite-runner.test.ts',
  'tests/isolated/scripts/unified-agent-boundary.test.ts',
] as const;

export const UNIFIED_TEST_SUITES = [
  ...UNIFIED_RUNTIME_WORKSPACES.map((workspace) => `${workspace}/test`),
  'tests/fixtures/extensions/mini-review/test',
  'tests/isolated/unified-agent',
  ...FINITE_ROOT_SCRIPT_TESTS,
] as const;

// These tests perform full artifact verification, installation or text I/O within their original budgets.
// Run their complete files after the other default jobs have drained.
export const UNIFIED_EXCLUSIVE_TEST_FILES = [
  'apps/cli/test/isolated/cli-caller-host.test.ts',
  'apps/cli/test/isolated/tui-export-host.test.ts',
  'tests/isolated/unified-agent/cli-registration-lifecycle.test.ts',
  'tests/isolated/unified-agent/native-cross-version.test.ts',
  'tests/isolated/unified-agent/native-install-lifecycle.test.ts',
  'tests/isolated/unified-agent/native-restore-interruption.test.ts',
  'tests/isolated/unified-agent/terminal-bundle.test.ts',
] as const;

export function unifiedTestInventory(root: string): string[] {
  return UNIFIED_TEST_SUITES.flatMap((suite) => collectTestFiles(resolve(root, suite)))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .sort();
}

export function unifiedTestPlan(root: string, concurrency: number): TestPlan {
  const plan = planTestSuites(root, UNIFIED_TEST_SUITES, concurrency);
  for (const file of UNIFIED_EXCLUSIVE_TEST_FILES) {
    const absolute = resolve(root, file);
    const index = plan.concurrent.findIndex((job) => job.files.includes(absolute));
    if (index < 0) {
      if (!plan.exclusive.some((job) => job.files.length === 1 && job.files[0] === absolute))
        throw new Error(`exclusive_test_unavailable:${file}`);
      continue;
    }
    const job = plan.concurrent[index]!;
    if (job.files.length !== 1) throw new Error(`exclusive_test_not_isolated:${file}`);
    plan.concurrent.splice(index, 1);
    plan.exclusive.push({ label: `exclusive:${file}`, files: job.files, maxConcurrency: 1 });
    plan.counts.isolated--;
    plan.counts.exclusive++;
  }
  plan.exclusive.sort((left, right) => left.label.localeCompare(right.label));
  return plan;
}

/** Partition exact files before selecting their original isolated/exclusive jobs. */
export function defaultShardFiles(files: string[], shard: string): string[] {
  if (!/^[0-7]\/8$/.test(shard)) throw Error('KITE_UNIT_SHARD must be 0/8 through 7/8');
  const selected = shardTestFiles(files, 8)[Number(shard[0])];
  if (!selected?.length) throw Error('default_test_shard_empty');
  return selected;
}

export function selectDefaultShard(plan: TestPlan, selected: ReadonlySet<string>): TestPlan {
  const jobs = (items: TestPlan['concurrent']) =>
    items.flatMap((job) => {
      const files = job.files.filter((file) => selected.has(file));
      return files.length ? [{ ...job, files }] : [];
    });
  const concurrent = jobs(plan.concurrent);
  const exclusive = jobs(plan.exclusive);
  const assigned = [...concurrent, ...exclusive].reduce(
    (count, job) => count + job.files.length,
    0,
  );
  if (assigned !== selected.size) throw Error('default_test_shard_membership_mismatch');
  const isolated = concurrent.filter((job) => job.drainOnFailure).length;
  const counts = {
    parallel: selected.size - isolated - exclusive.length,
    isolated,
    exclusive: exclusive.length,
  };
  return { concurrent, exclusive, counts };
}

export async function runUnifiedTests(root: string, args: readonly string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--list')) {
    console.error('usage: bun run scripts/run-default-tests.ts [--list]');
    return 2;
  }
  const shard = process.env.KITE_UNIT_SHARD;
  const inventory = unifiedTestInventory(root);
  const selected =
    shard === undefined
      ? undefined
      : defaultShardFiles(
          inventory.map((file) => resolve(root, file)),
          shard,
        );
  if (args[0] === '--list') {
    const files = selected?.map((file) => relative(root, file).replaceAll('\\', '/')) ?? inventory;
    console.log(JSON.stringify({ suites: UNIFIED_TEST_SUITES, files }));
    return 0;
  }
  const concurrency = testParallelism();
  const full = unifiedTestPlan(root, concurrency);
  const plan = selected ? selectDefaultShard(full, new Set(selected)) : full;
  console.log(
    `[unified-agent] parallelism=${concurrency} shard=${shard ?? 'all'} files=${selected?.length ?? inventory.length}`,
  );
  const code = await runTestPlan(root, plan, concurrency);
  if (code === 0)
    console.log(
      `[unified-agent] passed parallel=${plan.counts.parallel} isolated=${plan.counts.isolated} exclusive=${plan.counts.exclusive}`,
    );
  return code;
}
