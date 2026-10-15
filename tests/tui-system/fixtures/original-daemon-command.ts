import type { CLIServiceArtifact } from '../../../apps/cli/host';
import { runSelectedDaemon } from '../../../apps/cli/host/daemon';
import { parseCLIArguments } from '../../../apps/cli/src/arguments';

const input = (await Bun.stdin.json()) as {
  argv: string[];
  dataRoot: string;
  workspace: string;
  artifact: CLIServiceArtifact;
};
const args = parseCLIArguments(input.argv);
if (args.kind !== 'server') throw Error('original_daemon_wrong_arguments');
process.exitCode = await runSelectedDaemon({
  arguments: args,
  dataRoot: input.dataRoot,
  profile: 'development',
  cwd: input.workspace,
  artifact: input.artifact,
  write: (line) => process.stdout.write(`${line}\n`),
});
