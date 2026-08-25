import { resolve } from 'node:path';
import { collectTestFiles, partitionTestFiles, runTestJob } from './test-suite';

const repositoryRoot = resolve(import.meta.dir, '..');
const workspaceRoot = resolve(process.cwd(), process.argv[2] ?? '.');
const partition = partitionTestFiles(collectTestFiles(resolve(workspaceRoot, 'test')));
const workspaceLabel = workspaceRoot.slice(repositoryRoot.length + 1).replaceAll('\\', '/');

const parallelExit = await runTestJob(repositoryRoot, {
  label: workspaceLabel + ':parallel',
  files: partition.parallel,
});
if (parallelExit !== 0) process.exit(parallelExit);

for (const file of partition.isolated) {
  const exitCode = await runTestJob(
    repositoryRoot,
    { label: workspaceLabel + ':isolated:' + file.split(/[\\/]/u).at(-1), files: [file] },
    { maxConcurrency: 1 },
  );
  if (exitCode !== 0) process.exit(exitCode);
}

console.log(
  '[test:' +
    workspaceLabel +
    '] passed parallel=' +
    partition.parallel.length +
    ' isolated=' +
    partition.isolated.length,
);
