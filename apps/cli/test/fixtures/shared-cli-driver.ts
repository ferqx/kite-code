import { runCLIProcess } from '../../host/main';

try {
  process.exitCode = await runCLIProcess({
    argv: process.argv.slice(2),
    profile: 'owned',
    dataRoot: process.env.OWNED_DATA_ROOT,
  });
} catch (error) {
  process.stderr.write(
    `${error && typeof error === 'object' && 'code' in error ? error.code : 'shared_cli_failed'}\n`,
  );
  process.exitCode = 1;
}
