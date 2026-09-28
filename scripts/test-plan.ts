import { statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import {
  collectTestFiles,
  partitionTestFiles,
  runTestJob,
  runTestJobs,
  shardTestFiles,
  type TestJob,
} from './test-suite';

export interface TestPlan {
  concurrent: TestJob[];
  exclusive: TestJob[];
  counts: { parallel: number; isolated: number; exclusive: number };
}

export function planSuiteTests(
  repositoryRoot: string,
  suiteRelativePath: string,
  concurrency: number,
): TestPlan {
  const partition = partitionTestFiles(
    collectTestFiles(resolve(repositoryRoot, suiteRelativePath)),
  );
  const label = suiteRelativePath.replaceAll('\\', '/').replace(/\/test$/u, '');
  const shardCount = partition.parallel.length >= 16 ? concurrency : 1;
  const shards = shardTestFiles(partition.parallel, shardCount);
  const concurrent: TestJob[] = shards.map((files, index) => ({
    label: label + (shards.length > 1 ? `:shard-${index + 1}/${shards.length}` : ''),
    files,
  }));
  const exclusiveFiles = [...partition.exclusive];
  for (const file of partition.isolated) {
    if (process.platform === 'win32') {
      exclusiveFiles.push(file);
    } else {
      concurrent.push({
        label: `isolated:${relative(repositoryRoot, file).split(sep).join('/')}`,
        files: [file],
        maxConcurrency: 1,
        drainOnFailure: true,
      });
    }
  }
  const exclusive = exclusiveFiles.sort().map((file) => ({
    label: `exclusive:${relative(repositoryRoot, file).split(sep).join('/')}`,
    files: [file],
    maxConcurrency: 1,
  }));
  return {
    concurrent,
    exclusive,
    counts: {
      parallel: partition.parallel.length,
      isolated: process.platform === 'win32' ? 0 : partition.isolated.length,
      exclusive: exclusive.length,
    },
  };
}

export function planTestSuites(
  repositoryRoot: string,
  suiteRelativePaths: readonly string[],
  concurrency: number,
): TestPlan {
  const combined: TestPlan = {
    concurrent: [],
    exclusive: [],
    counts: { parallel: 0, isolated: 0, exclusive: 0 },
  };
  for (const path of suiteRelativePaths) {
    const suite = planSuiteTests(repositoryRoot, path, concurrency);
    combined.concurrent.push(...suite.concurrent);
    combined.exclusive.push(...suite.exclusive);
    combined.counts.parallel += suite.counts.parallel;
    combined.counts.isolated += suite.counts.isolated;
    combined.counts.exclusive += suite.counts.exclusive;
  }
  return combined;
}

export async function runTestPlan(
  repositoryRoot: string,
  plan: TestPlan,
  concurrency: number,
): Promise<number> {
  const ordered = [...plan.concurrent].sort((left, right) => {
    const weight = (job: TestJob): number =>
      job.files.reduce((total, file) => total + statSync(file).size, 0);
    return weight(right) - weight(left) || left.label.localeCompare(right.label);
  });
  const parallelExit = await runTestJobs(repositoryRoot, ordered, concurrency);
  if (parallelExit !== 0) return parallelExit;
  for (const job of plan.exclusive) {
    const exitCode = await runTestJob(repositoryRoot, job);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}
