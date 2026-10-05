import { relative, resolve } from 'node:path';
import { planTestSuites, runTestPlan } from './test-plan';
import { collectTestFiles, testParallelism } from './test-suite';

export const UNIFIED_RUNTIME_WORKSPACES = [
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
  'tests/isolated/scripts/check-pre-release-architecture-policy.test.ts',
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

export function unifiedTestInventory(root: string): string[] {
  return UNIFIED_TEST_SUITES.flatMap((suite) => collectTestFiles(resolve(root, suite)))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .sort();
}

export async function runUnifiedTests(root: string, args: readonly string[]): Promise<number> {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--list')) {
    console.error('usage: bun run scripts/run-default-tests.ts [--list]');
    return 2;
  }
  if (args[0] === '--list') {
    console.log(JSON.stringify({ suites: UNIFIED_TEST_SUITES, files: unifiedTestInventory(root) }));
    return 0;
  }
  const concurrency = testParallelism();
  const plan = planTestSuites(root, UNIFIED_TEST_SUITES, concurrency);
  console.log(`[unified-agent] parallelism=${concurrency}`);
  const code = await runTestPlan(root, plan, concurrency);
  if (code === 0)
    console.log(
      `[unified-agent] passed parallel=${plan.counts.parallel} isolated=${plan.counts.isolated} exclusive=${plan.counts.exclusive}`,
    );
  return code;
}
