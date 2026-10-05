import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { withCtrlC } from '../src';
import { parseCLIArguments } from '../src/arguments';
import { CLITraceError, runTrace } from '../src/trace';
import { runSelectedFileRecovery } from './file-recovery';
import {
  CLIHostError,
  type CLIServiceArtifact,
  parseCLIServiceArtifact,
  runSelectedCLI,
} from './index';
import { maintenanceHelp, runSelectedMaintenance } from './maintenance';
import { runSelectedManagement } from './management';

export async function runCLIProcess(
  input: {
    argv?: readonly string[];
    artifact?: CLIServiceArtifact;
    resolveArtifact?: () => CLIServiceArtifact;
    dataRoot?: string;
    profile?: string;
    cwd?: string;
  } = {},
): Promise<number> {
  const args = parseCLIArguments(input.argv ?? process.argv.slice(2));
  if (args.kind === 'help') {
    if (args.command === 'maintenance') {
      process.stdout.write(`${maintenanceHelp}\n`);
      return 0;
    }
    process.stdout.write(
      'kite run --execution-status|--release-status|--telemetry-status [--trust-workspace] [--server <local socket>]\n',
    );
    process.stdout.write(
      'kite run --task <text> [--thread <id>] [--workspace <path>] [--trust-workspace] [--ask|--auto|--full]\n',
    );
    process.stdout.write(
      'Development daemon: server start|status|stop|restart [--server <local socket>]; web [--json]. restart --cancel explicitly cancels owned work.\n',
    );
    process.stdout.write(
      'kite work <sessionId> --input <closed five-kind JSON>; caller list|lookup <sessionId> --input <original scope or complete intent JSON>\n',
    );
    process.stdout.write(
      'kite files checkpoints|detail <session> [point]; files restore <session> <point> --scope=session|code|both; files lookup|continue <session> --input <complete original intent JSON>\n',
    );
    process.stdout.write(`${maintenanceHelp}\n`);
    process.stdout.write(
      'kite resume --thread <id> --task <text>\n--ask selects Accept Edits; approvals require an explicit answer.\n',
    );
    process.stdout.write(
      'Development management: session rename|delete|fork <id> --input <closed JSON>; context read|rewind|include|compact|reset <id> --input <closed JSON> [--execution <id>]. Both support --server <local socket>.\nRepeat --skill <configured ID or discovered name> to select guidance; it does not grant tool permission.\nRepeat --activate-skill <compiled name or exact skillId> on run/resume to explicitly activate an enabled Workflow accepting empty input; flags and ordinary permissions still apply.\n',
    );
    process.stdout.write(
      'Development recovery: recovery run|interrupt <root-session> or recovery report <root-session> <original report Command ID> --input <closed JSON>; recovery lookup <root-session> --input <saved intent JSON>. Ctrl+C stops this wait. resume remains a new Work request.\n' +
        'Development recovery: job reconcile <root-session> --input <closed JSON> [--server <local socket>]. Explicitly queries the original Job; never starts it again.\n',
    );
    return 0;
  }
  if (args.kind === 'version') {
    process.stdout.write('kite unified-agent 0.1.0\n');
    return 0;
  }
  if (args.kind === 'maintenance')
    return withCtrlC((signal) =>
      runSelectedMaintenance({
        arguments: args,
        write: (line) => process.stdout.write(`${line}\n`),
        signal,
      }),
    );
  if (args.kind === 'trace') {
    try {
      return runTrace(args, readFileSync, (value) => process.stdout.write(`${value}\n`));
    } catch (error) {
      if (!(error instanceof CLITraceError)) throw error;
      process.stderr.write(
        `${error.code}${error.line === undefined ? '' : `: line ${error.line}`}\n`,
      );
      return 1;
    }
  }
  if (args.kind === 'server' || args.kind === 'web') {
    const { runSelectedDaemon } = await import('./daemon');
    return withCtrlC((signal) =>
      runSelectedDaemon({
        arguments: args,
        artifact: input.artifact,
        resolveArtifact:
          input.resolveArtifact ??
          (() => {
            try {
              return parseCLIServiceArtifact(
                JSON.parse(readFileSync(join(import.meta.dir, 'cli-assets.json'), 'utf8')),
              );
            } catch {
              throw new CLIHostError('daemon_artifact_unavailable');
            }
          }),
        dataRoot: input.dataRoot ?? join(homedir(), '.kite-code', 'unified-agent'),
        profile: input.profile,
        cwd: input.cwd,
        write: (line) => process.stdout.write(`${line}\n`),
        signal,
      }),
    );
  }
  if (
    !['run', 'resume', 'work', 'caller', 'session', 'context', 'job', 'recovery', 'files'].includes(
      args.kind,
    )
  )
    throw new CLIHostError('cli_command_unavailable');
  const resolveArtifact =
    input.resolveArtifact ??
    (() => {
      try {
        return parseCLIServiceArtifact(
          JSON.parse(readFileSync(join(import.meta.dir, 'cli-assets.json'), 'utf8')),
        );
      } catch {
        throw new CLIHostError('cli_artifact_unavailable');
      }
    });
  const hostExit = new AbortController();
  const stopHost = () => hostExit.abort(new CLIHostError('cli_host_exit_requested'));
  process.once('SIGTERM', stopHost);
  try {
    if (args.kind === 'files')
      return await withCtrlC((signal) =>
        runSelectedFileRecovery({
          arguments: args,
          artifact: input.artifact,
          resolveArtifact,
          dataRoot: input.dataRoot ?? join(homedir(), '.kite-code', 'unified-agent'),
          profile: input.profile,
          write: (line) => process.stdout.write(`${line}\n`),
          prompt: (line) => process.stderr.write(line),
          signal,
          exitSignal: hostExit.signal,
          stdin: process.stdin,
        }),
      );
    if (
      args.kind === 'session' ||
      args.kind === 'context' ||
      args.kind === 'job' ||
      args.kind === 'recovery'
    )
      return await withCtrlC((signal) =>
        runSelectedManagement({
          arguments: args,
          artifact: input.artifact,
          resolveArtifact,
          dataRoot: input.dataRoot ?? join(homedir(), '.kite-code', 'unified-agent'),
          ...(input.profile ? { profile: input.profile } : {}),
          write: (line) => process.stdout.write(`${line}\n`),
          prompt: (line) => process.stderr.write(line),
          signal,
          exitSignal: hostExit.signal,
        }),
      );
    return await withCtrlC((signal) =>
      runSelectedCLI({
        arguments: args,
        artifact: input.artifact,
        resolveArtifact,
        dataRoot: input.dataRoot ?? join(homedir(), '.kite-code', 'unified-agent'),
        ...(input.profile ? { profile: input.profile } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        write: (line) => {
          process.stdout.write(`${line}\n`);
        },
        prompt: (line) => {
          process.stderr.write(line);
        },
        signal,
        exitSignal: hostExit.signal,
      }),
    );
  } finally {
    process.removeListener('SIGTERM', stopHost);
  }
}
if (import.meta.main) {
  try {
    process.exitCode = await runCLIProcess();
  } catch (error) {
    const code =
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z][a-z0-9_]{0,80}$/.test(error.code)
        ? error.code
        : 'cli_host_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
