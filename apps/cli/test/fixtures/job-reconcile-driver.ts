import { readFileSync } from 'node:fs';
import { runCLIProcess } from '../../host/main';

try {
  const file = process.argv[2]!;
  process.exitCode = await runCLIProcess({
    profile: 'owned',
    argv: process.argv.slice(3),
    resolveArtifact() {
      if (file === '-') throw Error('shared_must_not_resolve_paired_assets');
      return JSON.parse(readFileSync(file, 'utf8'));
    },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'fixture_failed'}\n`);
  process.exitCode = 1;
}
