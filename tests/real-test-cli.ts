import { buildRealTestCommand, buildRealTestEnv, parseRealTestArgs } from './real-test-options';

async function main(argv: string[]): Promise<number> {
  const options = parseRealTestArgs(argv);
  const command = buildRealTestCommand(options);
  const proc = Bun.spawn(command, {
    env: buildRealTestEnv(process.env, options),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return await proc.exited;
}

if (import.meta.main) {
  const exitCode = await main(process.argv.slice(2));
  process.exit(exitCode);
}
