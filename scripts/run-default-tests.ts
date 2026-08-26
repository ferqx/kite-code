import { resolve } from 'node:path';
import {
  collectTestFiles,
  partitionTestFiles,
  runTestJob,
  runTestJobs,
  shardTestFiles,
  type TestJob,
  testParallelism,
} from './test-suite';

const root = resolve(import.meta.dir, '..');
const workspaces = [
  'packages/runtime-contract',
  'packages/runtime-protocol',
  'packages/runtime-server',
  'packages/runtime-client',
  'packages/agent-kernel',
  'packages/runtime-spi',
  'packages/runtime-host',
  'packages/runtime-storage-sqlite',
  'packages/builtin-runtime',
  'apps/kite',
] as const;

const concurrency = testParallelism();
const workspaceJobs: TestJob[] = [];
const isolatedFiles: string[] = [];
for (const workspace of workspaces) {
  const partition = partitionTestFiles(collectTestFiles(resolve(root, workspace, 'test')));
  const shards = shardTestFiles(partition.parallel, workspace === 'apps/kite' ? concurrency : 1);
  for (const [index, files] of shards.entries()) {
    workspaceJobs.push({
      label: workspace + (shards.length > 1 ? `:shard-${index + 1}/${shards.length}` : ''),
      files,
    });
  }
  isolatedFiles.push(...partition.isolated);
}

const rootSuites = [
  'tests/integration',
  'tests/golden',
  'tests/release',
  'tests/e2e/local',
  'tests/tui-system/harness',
];
const integrationJobs: TestJob[] = [];
let integrationFileCount = 0;
for (const suite of rootSuites) {
  const partition = partitionTestFiles(collectTestFiles(resolve(root, suite)));
  isolatedFiles.push(...partition.isolated);
  const shards = shardTestFiles(
    partition.parallel,
    suite === 'tests/integration' ? concurrency : 1,
  );
  for (const [index, files] of shards.entries()) {
    integrationJobs.push({
      label: suite + (shards.length > 1 ? `:shard-${index + 1}/${shards.length}` : ''),
      files,
    });
    integrationFileCount += files.length;
  }
}
isolatedFiles.push(...collectTestFiles(resolve(root, 'tests/isolated')));

console.log(`[test] workspace parallelism=${concurrency}`);
const workspaceExit = await runTestJobs(root, workspaceJobs, concurrency);
if (workspaceExit !== 0) process.exit(workspaceExit);

const integrationExit = await runTestJobs(root, integrationJobs, concurrency);
if (integrationExit !== 0) process.exit(integrationExit);

for (const file of isolatedFiles.sort()) {
  const exitCode = await runTestJob(
    root,
    { label: `isolated:${file.split(/[\\/]/u).at(-1)}`, files: [file] },
    { maxConcurrency: 1 },
  );
  if (exitCode !== 0) process.exit(exitCode);
}

console.log(
  '\n[test] passed workspaceFiles=' +
    workspaceJobs.reduce((count, job) => count + job.files.length, 0) +
    ' integrationFiles=' +
    integrationFileCount +
    ' isolatedFiles=' +
    isolatedFiles.length,
);
