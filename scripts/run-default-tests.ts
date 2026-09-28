import { resolve } from 'node:path';
import { planTestSuites, runTestPlan } from './test-plan';
import { collectTestFiles, testParallelism } from './test-suite';

const root = resolve(import.meta.dir, '..');
const workspaces = [
  'packages/agent-api-contract',
  'packages/agent-api-client',
  'packages/runtime-contract',
  'packages/runtime-protocol',
  'packages/runtime-server',
  'packages/runtime-client',
  'packages/kite-app-contract',
  'packages/kite-local-runtime',
  'packages/agent-kernel',
  'packages/runtime-spi',
  'packages/runtime-host',
  'packages/runtime-storage-sqlite',
  'packages/builtin-runtime',
  'apps/kite-cli',
  'apps/kite-service',
  'packages/kite-client-ui',
  'apps/kite-desktop',
] as const;
const rootSuites = [
  'tests/integration',
  'tests/golden',
  'tests/release',
  'tests/e2e/local',
  'tests/tui-system/harness',
  'tests/isolated',
] as const;

const concurrency = testParallelism();
const workspacePlan = planTestSuites(
  root,
  workspaces.map((workspace) => `${workspace}/test`),
  concurrency,
);
const rootPlan = planTestSuites(root, rootSuites, concurrency);
const plan = {
  concurrent: [
    ...workspacePlan.concurrent,
    ...rootPlan.concurrent,
    {
      label: 'apps/kite-web',
      files: collectTestFiles(resolve(root, 'apps/kite-web/test')),
      command: [process.execPath, 'run', '--cwd', 'apps/kite-web', 'test'],
    },
  ],
  exclusive: [...workspacePlan.exclusive, ...rootPlan.exclusive],
  counts: {
    parallel: workspacePlan.counts.parallel + rootPlan.counts.parallel,
    isolated: workspacePlan.counts.isolated + rootPlan.counts.isolated,
    exclusive: workspacePlan.counts.exclusive + rootPlan.counts.exclusive,
  },
};

console.log(`[test] parallelism=${concurrency}`);
const exitCode = await runTestPlan(root, plan, concurrency);
if (exitCode !== 0) process.exit(exitCode);
console.log(
  `\n[test] passed parallelFiles=${plan.counts.parallel} isolatedFiles=${plan.counts.isolated} exclusiveFiles=${plan.counts.exclusive} web=vitest`,
);
