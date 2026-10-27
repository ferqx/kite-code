import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import {
  inspectProcess,
  readDaemonReservation,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from '@kite-ai/service/daemon';
import { verifyTerminalBundle } from '../../../apps/cli/host/terminal-artifact';

const repository = resolve(import.meta.dir, '../../..');
type Verified = ReturnType<typeof verifyTerminalBundle>;
export async function buildOriginalDaemonCandidate() {
  const root = realpathSync(
    mkdtempSync(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'kite-original-daemon-'),
    ),
  );
  const directory = join(root, 'candidate');
  const child = Bun.spawn(
    [
      process.execPath,
      join(repository, 'scripts/release/terminal.ts'),
      'build',
      '--directory',
      directory,
    ],
    { cwd: repository, stdout: 'pipe', stderr: 'pipe' },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [code, stdout, stderr] = await Promise.race([
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error('original_daemon_candidate_build_timeout')), 60_000);
      }),
    ]);
    if (code !== 0) throw Error(`original_daemon_candidate_build_failed:${stdout}\n${stderr}`);
    const selected = verifyTerminalBundle(directory);
    return {
      root,
      selected,
      cleanup() {
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
    rmSync(root, { recursive: true, force: true });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Original daemon journey uses the actual new CLI parser/host, verified candidate,
 * private bootstrap and authenticated Client. It never loads the retired backend. */
export function createOriginalDaemonHost(input: {
  candidate: Verified;
  endpointRoot: string;
  home: string;
  workspace: string;
}) {
  const dataRoot = join(input.home, '.kite-code');
  const selected = selectProfile({ dataRoot, profile: 'development' });
  const profile = {
    dataRoot: selected.dataRoot,
    name: selected.profile,
    accessKey: selected.profileAccessKey,
  };
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\kite-daemon-${crypto.randomUUID()}`
      : join(input.endpointRoot, `d-${crypto.randomUUID()}.sock`);
  mkdirSync(input.endpointRoot, { recursive: true, mode: 0o700 });
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.accessKey,
    explicitSocket: socket,
  });
  const births = new Map<string, { pid: number; start: string }>();
  let exitConfirmed = false;
  const bootstrap = async () => {
    const current = await requestDaemonBootstrap(endpoint, profile);
    births.set(current.instanceId, { pid: current.pid, start: current.processStartIdentity });
    return current;
  };
  const call = async (action: 'start' | 'status' | 'stop' | 'restart', cancel = false) => {
    const argv = ['server', action, '--data-root', dataRoot, '--server', socket];
    if (action === 'start') argv.push('--workspace', input.workspace);
    if (cancel) argv.push('--cancel');
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, 'original-daemon-command.ts')],
      {
        cwd: repository,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: input.home,
          ...(process.platform === 'win32' ? { USERPROFILE: input.home } : {}),
        },
      },
    );
    child.stdin.write(
      JSON.stringify({
        argv,
        dataRoot,
        workspace: input.workspace,
        artifact: input.candidate.artifact,
      }),
    );
    child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw Error(`original_daemon_command_failed:${stderr}`);
    const lines = stdout.trim().split('\n');
    if (action === 'stop') return;
    const status = JSON.parse(lines.at(-1)!) as {
      state: string;
      instanceId?: string;
      endpoint: string;
      workspace?: string;
    };
    if (status.state === 'accepting') await bootstrap();
    return status;
  };
  return {
    get exitConfirmed() {
      return exitConfirmed;
    },
    endpoint: { socket, kind: process.platform === 'win32' ? 'pipe' : 'unix' },
    profile,
    bootstrap,
    async connect() {
      const actual = await bootstrap();
      const client = createClient({
        endpoint: actual.httpEndpoint,
        token: actual.token,
        expected: {
          profile,
          instanceId: actual.instanceId,
          buildId: input.candidate.buildId,
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'history'],
        },
      });
      try {
        const info = await client.connect();
        return { client, info, close: () => client.disposeNetwork() };
      } catch (error) {
        client.disposeNetwork();
        throw error;
      }
    },
    start: () => call('start'),
    status: () => call('status'),
    restart: (cancel = false) => call('restart', cancel),
    async verifyAuthentication() {
      const actual = await bootstrap();
      const unauthorized = await fetch(new URL('/v1/server', actual.httpEndpoint));
      if (unauthorized.status !== 401) throw Error('original_daemon_unauthenticated_admitted');
      await unauthorized.body?.cancel();
      const client = createClient({
        endpoint: actual.httpEndpoint,
        token: actual.token,
        expected: {
          profile,
          instanceId: actual.instanceId,
          buildId: input.candidate.buildId,
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'history'],
        },
      });
      try {
        return await client.connect();
      } finally {
        client.disposeNetwork();
      }
    },
    async stop() {
      const saved = readDaemonReservation(endpoint);
      if (saved) {
        if (
          saved.profile.dataRoot !== profile.dataRoot ||
          saved.profile.name !== profile.name ||
          saved.profile.accessKey !== profile.accessKey
        )
          throw Error('original_daemon_cleanup_identity_mismatch');
        births.set(saved.instanceId, { pid: saved.pid, start: saved.processStartIdentity });
      }
      await call('stop');
      for (const birth of births.values())
        if (inspectProcess(birth.pid, birth.start) !== 'dead')
          throw Error('original_daemon_exit_unconfirmed');
      const status = await call('status');
      if (status?.state !== 'absent') throw Error('original_daemon_endpoint_not_absent');
      exitConfirmed = true;
      console.log(
        '  original daemon lifecycle:',
        JSON.stringify({
          profile: profile.name,
          instances: births.size,
          ownBirthsExited: true,
          endpointAbsent: true,
        }),
      );
    },
  };
}

/** Release the isolated candidate and Profile only after every daemon birth stopped. */
export function releaseOriginalDaemonFixture(input: {
  candidate: Awaited<ReturnType<typeof buildOriginalDaemonCandidate>>;
  daemon: ReturnType<typeof createOriginalDaemonHost>;
  workspace: { cleanup(): void };
}) {
  if (!input.daemon.exitConfirmed) throw Error('original_daemon_fixture_cleanup_unconfirmed');
  input.workspace.cleanup();
  input.candidate.cleanup();
}
