import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dir, '../..');
const webRoot = resolve(repositoryRoot, 'apps/kite-web');
const args = process.argv.slice(2);

await run([process.execPath, 'run', '--cwd', webRoot, 'build']);
await run([
  process.execPath,
  'run',
  'agent',
  'server',
  'start',
  ...args.filter((arg) => arg !== '--json'),
]);
await run([process.execPath, 'run', 'agent', 'web', ...withoutValueOption(args, '--workspace')]);

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

function withoutValueOption(args: readonly string[], option: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === option) {
      index += 1;
      continue;
    }
    result.push(args[index]!);
  }
  return result;
}
