import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { verifyTerminalBundle } from '../../apps/cli/host/terminal-artifact';
import { windowsTerminalRuntimeArguments } from '../../apps/service/src/runtime-assets';
import { privateDirectory } from '../../packages/agent/src/platform/windows-path-security';

// A failed smoke keeps the original lease and private evidence until host exit.
const pendingSmokes = new Set<object>();

async function execute(command: string[], cwd: string, home: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env:
      process.platform === 'win32'
        ? {
            PATH: '',
            HOME: home,
            USERPROFILE: home,
            SystemRoot: process.env.SystemRoot,
            LANG: 'C.UTF-8',
          }
        : { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeoutMs = 20_000;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, timeoutMs);
  const forced = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (timedOut || code !== 0 || child.signalCode)
      throw new Error(timedOut ? 'release_smoke_child_timeout' : 'release_smoke_child_failed', {
        cause: new Error(stderr.slice(-512) || `exit_${code}`),
      });
    return stdout.trim();
  } finally {
    clearTimeout(timer);
    clearTimeout(forced);
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}

/** Source-free public entry and daemon/Gateway check; no model or external Provider is invoked. */
export async function smokeTerminalBundle(directory: string) {
  const lease = acquireArtifactAccess({ root: realpathSync(directory), mode: 'shared' });
  let scratch: string | undefined;
  let stopped = false;
  let cli: ((argv: string[]) => Promise<string>) | undefined;
  let socket: string | undefined;
  let failure: unknown;
  let failed = false;
  let outcome:
    | {
        candidateId: string;
        buildId: string;
        entry: boolean;
        daemon: boolean;
        web: boolean;
        cleanup: boolean;
        modelInvoked: boolean;
      }
    | undefined;
  try {
    const bundle = verifyTerminalBundle(directory);
    if (process.platform === 'win32') {
      scratch = join(realpathSync(tmpdir()), `kite-terminal-smoke-${randomUUID()}`);
      privateDirectory(scratch);
    } else scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-smoke-')));
    const home = join(scratch, 'home'),
      workspace = join(scratch, 'workspace');
    socket =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\kite-daemon-smoke-${randomUUID()}`
        : join(scratch, 'owned.sock');
    if (process.platform === 'win32') {
      privateDirectory(home);
      privateDirectory(workspace);
    } else {
      mkdirSync(home, { mode: 0o700 });
      mkdirSync(workspace, { mode: 0o700 });
    }
    const executable = join(bundle.root, bundle.manifest.entries.runtime),
      entry = join(bundle.root, bundle.manifest.entries.cli),
      scope = ['--server', socket, '--data-root', join(home, '.kite-code', 'unified-agent')];
    const runtimeArguments =
      process.platform === 'win32' ? windowsTerminalRuntimeArguments(bundle.root) : [];
    cli = (argv) => execute([executable, ...runtimeArguments, entry, ...argv], workspace, home);
    const help = await cli(['--help']),
      version = await cli(['--version']);
    if (!help.includes('kite run') || version !== 'kite unified-agent 0.1.0')
      throw Error('release_smoke_entry_mismatch');
    const start: unknown = JSON.parse(
      await cli(['server', 'start', '--workspace', workspace, ...scope]),
    );
    const status: unknown = JSON.parse(await cli(['server', 'status', ...scope]));
    if (
      !start ||
      typeof start !== 'object' ||
      !status ||
      typeof status !== 'object' ||
      !('state' in start) ||
      start.state !== 'accepting' ||
      !('state' in status) ||
      status.state !== 'accepting' ||
      !('instanceId' in start) ||
      !('instanceId' in status) ||
      start.instanceId !== status.instanceId ||
      !('runningBuildId' in status) ||
      status.runningBuildId !== bundle.buildId
    )
      throw Error('release_smoke_daemon_mismatch');
    const origin = await cli(['web', ...scope]);
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
      throw Error('release_smoke_web_identity_mismatch');
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (response.status !== 200 || !(await response.text()).includes('id="root"'))
      throw Error('release_smoke_web_unavailable');
    await cli(['server', 'stop', ...scope]);
    stopped = true;
    const absent: unknown = JSON.parse(await cli(['server', 'status', ...scope]));
    if (!absent || typeof absent !== 'object' || !('state' in absent) || absent.state !== 'absent')
      throw Error('release_smoke_cleanup_unconfirmed');
    if (verifyTerminalBundle(bundle.root).digest !== bundle.digest)
      throw Error('release_smoke_candidate_changed');
    outcome = {
      candidateId: bundle.candidateId,
      buildId: bundle.buildId,
      entry: true,
      daemon: true,
      web: true,
      cleanup: true,
      modelInvoked: false,
    };
  } catch (error) {
    failed = true;
    failure = error;
  }
  // Cleanup errors preserve the owned profile and evidence instead of deleting a live daemon's data.
  const cleanupErrors: unknown[] = [];
  try {
    if (cli && !stopped) {
      await cli([
        'server',
        'stop',
        '--server',
        socket!,
        '--data-root',
        join(scratch!, 'home/.kite-code/unified-agent'),
      ]);
      stopped = true;
    }
    if (scratch && stopped && !failed) rmSync(scratch, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (!failed && !cleanupErrors.length) {
    try {
      lease.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (failed || cleanupErrors.length) pendingSmokes.add({ lease, scratch, cli, socket });
  if (cleanupErrors.length)
    throw new AggregateError(
      [...(failed ? [failure] : []), ...cleanupErrors],
      'release_smoke_cleanup_unknown',
    );
  if (failed) throw failure;
  return outcome!;
}
