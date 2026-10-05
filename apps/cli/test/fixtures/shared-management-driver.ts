import { runCLIProcess } from '../../host/main';

try {
  process.exitCode = await runCLIProcess({
    argv: process.argv.slice(2),
    profile: 'owned',
    resolveArtifact() {
      throw Error('paired_asset_must_not_resolve');
    },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'fixture_failed'}\n`);
  process.exitCode = 1;
}
