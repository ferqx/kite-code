import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireArtifactAccess } from '@kite-ai/agent/artifact-access';
import { verifyTerminalBundle } from '../../apps/cli/host/terminal-artifact';

async function execute(command: string[], cwd: string, home: string): Promise<string> {
  const child = Bun.spawn(command, {
    cwd,
    env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
  const forced = setTimeout(() => child.kill('SIGKILL'), 25000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code) throw Error(`release_smoke_child_failed:${stderr.slice(-512)}`);
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
  try {
    const bundle = verifyTerminalBundle(directory);
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'kite-terminal-smoke-')));
    const home = join(scratch, 'home'),
      workspace = join(scratch, 'workspace'),
      socket = join(scratch, 'owned.sock');
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(workspace, { mode: 0o700 });
    const executable = join(bundle.root, bundle.manifest.entries.runtime),
      entry = join(bundle.root, bundle.manifest.entries.cli),
      scope = ['--server', socket, '--data-root', join(home, '.kite-code', 'unified-agent')];
    cli = (argv) => execute([executable, entry, ...argv], workspace, home);
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
    return {
      candidateId: bundle.candidateId,
      buildId: bundle.buildId,
      entry: true,
      daemon: true,
      web: true,
      cleanup: true,
      modelInvoked: false,
    };
  } finally {
    // Cleanup errors preserve the owned profile and evidence instead of deleting a live daemon's data.
    try {
      if (cli && !stopped) {
        await cli([
          'server',
          'stop',
          '--server',
          join(scratch!, 'owned.sock'),
          '--data-root',
          join(scratch!, 'home/.kite-code/unified-agent'),
        ]);
        stopped = true;
      }
      if (scratch && stopped) rmSync(scratch, { recursive: true, force: true });
    } finally {
      lease.release();
    }
  }
}
