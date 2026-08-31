import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../..');
const webRoot = resolve(repositoryRoot, 'apps/kite-web');

await run([process.execPath, 'run', '--cwd', webRoot, 'build']);
await run([process.execPath, 'run', 'agent', 'web', ...process.argv.slice(2)]);

async function run(command: readonly string[]): Promise<void> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
}
