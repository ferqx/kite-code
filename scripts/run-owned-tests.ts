import { relative, resolve, sep } from 'node:path';
import { planSuiteTests, runTestPlan } from './test-plan';
import { testParallelism } from './test-suite';

const repositoryRoot = resolve(import.meta.dir, '..');
const workspaceRoot = resolve(process.cwd(), process.argv[2] ?? '.');
const workspaceLabel = relative(repositoryRoot, workspaceRoot).split(sep).join('/');
const concurrency = testParallelism();
const plan = planSuiteTests(repositoryRoot, `${workspaceLabel}/test`, concurrency);
const exitCode = await runTestPlan(repositoryRoot, plan, concurrency);
if (exitCode !== 0) process.exit(exitCode);
console.log(
  `[test:${workspaceLabel}] passed parallel=${plan.counts.parallel} isolated=${plan.counts.isolated} exclusive=${plan.counts.exclusive}`,
);
