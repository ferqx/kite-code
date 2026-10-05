import { appendFileSync } from 'node:fs';
import { runSelectedCLI } from '../../host';
import { parseCLIArguments } from '../../src/arguments';

try {
  const base = process.env.STATUS_BASE!;
  const selected = process.env.STATUS_ARTIFACT;
  process.exitCode = await runSelectedCLI({
    arguments: parseCLIArguments(process.argv.slice(2)),
    dataRoot: `${base}/data`,
    profile: 'owned',
    cwd: process.env.STATUS_CWD ?? base,
    write: (line) => process.stdout.write(`${line}\n`),
    prompt: (line) => process.stderr.write(line),
    resolveArtifact() {
      appendFileSync(`${base}/asset-reads`, 'read\n');
      if (!selected) throw Error('paired_assets_forbidden');
      return JSON.parse(selected);
    },
    onLaunched(paired) {
      appendFileSync(`${base}/paired-pids`, `${paired.pid}\n`);
    },
    stdin: process.stdin,
  });
} catch (error) {
  process.stderr.write(
    `${error && typeof error === 'object' && 'code' in error ? error.code : 'status_driver_failed'}\n`,
  );
  process.exitCode = 1;
}
