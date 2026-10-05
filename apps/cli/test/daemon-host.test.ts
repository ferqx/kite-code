import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import {
  type DaemonBootstrap,
  inspectProcess,
  readDaemonReservation,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from '@kite-ai/service/daemon';
import type { CLIServiceArtifact } from '../host';
import { runSelectedDaemon } from '../host/daemon';
import type { CLIArguments } from '../src/arguments';
import { buildOwnedDaemon } from './fixtures/daemon-host-build';

let root: string;
let entrypoint: string;
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
beforeAll(async () => {
  root = mkdtempSync('/private/tmp/kite-cli-daemon-host-');
  entrypoint = await buildOwnedDaemon(join(root, 'artifact'));
}, 60000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function fixture(absent = false, defaultEndpoint = false) {
  const base = join(root, randomUUID());
  if (!absent) mkdirSync(base, { mode: 0o700 });
  const dataRoot = join(base, 'data');
  const profile = selectProfile({ dataRoot, profile: 'owned' });
  const identity = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    ...(defaultEndpoint ? {} : { explicitSocket: join(base, 'd.sock') }),
  });
  const lines: string[] = [];
  const owned = new Map<number, string>();
  const call = (
    arguments_: Extract<CLIArguments, { kind: 'server' | 'web' }>,
    artifact?: CLIServiceArtifact,
    cwd = base,
    resolveArtifact?: () => CLIServiceArtifact,
  ) =>
    runSelectedDaemon({
      arguments: arguments_,
      dataRoot,
      profile: 'owned',
      cwd,
      artifact,
      resolveArtifact,
      write: (line) => lines.push(line),
    });
  const server = (action: 'start' | 'status' | 'stop' | 'restart', extra = {}) => ({
    kind: 'server' as const,
    action,
    ...(defaultEndpoint ? {} : { server: endpoint.socket }),
    json: false,
    cancel: false,
    ...extra,
  });
  const native = async () => {
    const bootstrap = await requestDaemonBootstrap(endpoint, identity);
    owned.set(bootstrap.pid, bootstrap.processStartIdentity);
    return bootstrap;
  };
  const cleanup = async () => {
    const record = readDaemonReservation(endpoint);
    if (record && record.profile.accessKey === identity.accessKey)
      owned.set(record.pid, record.processStartIdentity);
    try {
      await call(server('stop'));
    } catch {
      /* Cleanup below is limited to this fixture's original identities. */
    }
    for (const [pid, start] of owned) {
      if (inspectProcess(pid, start) === 'alive') {
        process.kill(pid, 'SIGTERM');
        const end = Date.now() + 3000;
        while (inspectProcess(pid, start) === 'alive' && Date.now() < end) await Bun.sleep(10);
        if (inspectProcess(pid, start) === 'alive') process.kill(pid, 'SIGKILL');
      }
    }
  };
  return { base, dataRoot, profile, identity, endpoint, lines, call, server, native, cleanup };
}
function artifact(value: ReturnType<typeof fixture>): CLIServiceArtifact {
  const directory = join(value.base, 'web');
  mkdirSync(directory);
  const manifest = [
    ['/index.html', 'text/html; charset=utf-8', '<!doctype html><title>Owned CLI daemon</title>'],
    ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned = true;'],
    ['/app.css', 'text/css; charset=utf-8', 'body { color: black; }'],
  ].map(([path, mediaType, content]) => {
    writeFileSync(join(directory, path!.slice(1)), content!);
    return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
  });
  const raw = JSON.stringify(manifest);
  writeFileSync(join(directory, 'manifest.json'), raw);
  const executable = realpathSync(process.execPath);
  return {
    entrypoint,
    entrypointSha256: hash(readFileSync(entrypoint)),
    executable,
    executableSha256: hash(readFileSync(executable)),
    apiMajor: 1,
    buildId: 'compiled-cli-daemon',
    daemon: {
      entrypoint,
      entrypointSha256: hash(readFileSync(entrypoint)),
      web: { directory, manifestSha256: hash(raw) },
    },
  };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > end) throw Error('cli_daemon_fixture_timeout');
    await Bun.sleep(5);
  }
}
function client(bootstrap: DaemonBootstrap) {
  return createClient({
    endpoint: bootstrap.httpEndpoint,
    token: bootstrap.token,
    expected: {
      profile: bootstrap.profile,
      instanceId: bootstrap.instanceId,
      buildId: bootstrap.buildId,
      apiMajor: 1,
      requiredCapabilities: [],
    },
  });
}
nativeTest(
  'status/stop/web absent require no artifact and create no profile or endpoint directories',
  async () => {
    const value = fixture(true);
    expect(await value.call(value.server('status'))).toBe(0);
    expect(JSON.parse(value.lines.at(-1)!)).toMatchObject({ state: 'absent', targetBuildId: null });
    expect(await value.call(value.server('stop'))).toBe(0);
    await expect(
      value.call({ kind: 'web', server: value.endpoint.socket, json: true }),
    ).rejects.toMatchObject({ code: 'daemon_web_unavailable' });
    expect(existsSync(value.base)).toBe(false);
    expect(existsSync(value.dataRoot)).toBe(false);
    expect(existsSync(value.endpoint.root)).toBe(false);
  },
);
nativeTest(
  'start/reuse keeps original instance/workspace; web only observes and stop cleans owned process',
  async () => {
    const value = fixture();
    const build = artifact(value);
    const second = join(value.base, 'different-workspace');
    mkdirSync(second);
    try {
      expect(await value.call(value.server('start'), build)).toBe(0);
      const first = await value.native();
      expect(JSON.parse(value.lines.at(-1)!)).toMatchObject({
        reused: false,
        workspace: value.base,
        instanceId: first.instanceId,
      });
      expect(await value.call(value.server('start'), undefined, second)).toBe(0);
      const reused = await value.native();
      expect(reused.pid).toBe(first.pid);
      expect(reused.instanceId).toBe(first.instanceId);
      expect(reused.workspace).toBe(value.base);
      expect(JSON.parse(value.lines.at(-1)!)).toMatchObject({
        reused: true,
        workspace: value.base,
      });
      await expect(
        value.call(value.server('start', { workspace: second }), build),
      ).rejects.toMatchObject({ code: 'workspace_identity_mismatch' });
      expect(await value.call({ kind: 'web', server: value.endpoint.socket, json: true })).toBe(0);
      expect(JSON.parse(value.lines.at(-1)!)).toMatchObject({
        url: first.webOrigin,
        instanceId: first.instanceId,
        workspace: value.base,
      });
      expect((await value.native()).pid).toBe(first.pid);
      expect(existsSync(join(value.base, 'models'))).toBe(false);
      const shell = await fetch(first.webOrigin, { signal: AbortSignal.timeout(5000) });
      expect(shell.status).toBe(200);
      expect(await shell.text()).not.toContain(first.token);
      expect(await value.call(value.server('stop'))).toBe(0);
      expect(inspectProcess(first.pid, first.processStartIdentity)).toBe('dead');
      expect(readDaemonReservation(value.endpoint)).toBeUndefined();
      expect(existsSync(value.endpoint.socket)).toBe(false);
      expect(existsSync(value.endpoint.record)).toBe(false);
    } finally {
      await value.cleanup();
    }
  },
  30000,
);
nativeTest(
  'restart invalid asset and if_idle busy preserve original daemon; explicit cancel replaces original PID and instance',
  async () => {
    const value = fixture();
    const build = artifact(value);
    let network: ReturnType<typeof client> | undefined;
    try {
      await value.call(value.server('start'), build);
      const original = await value.native();
      const before = readFileSync(value.profile.databasePath);
      const configured = readFileSync(join(value.base, 'configured'), 'utf8');
      const bad = {
        ...build,
        daemon: { ...build.daemon!, web: { ...build.daemon!.web, manifestSha256: '0'.repeat(64) } },
      };
      await expect(value.call(value.server('restart'), bad)).rejects.toThrow();
      expect((await value.native()).instanceId).toBe(original.instanceId);
      expect(readFileSync(value.profile.databasePath)).toEqual(before);
      expect(readFileSync(join(value.base, 'configured'), 'utf8')).toBe(configured);
      expect(existsSync(join(value.base, 'models'))).toBe(false);
      network = client(original);
      const info = await network.connect();
      const storeId = info.storeId!;
      await network.createWorkspace({
        expectedStoreId: storeId,
        id: 'workspace',
        rootUri: `file://${value.base}`,
        name: 'Owned',
      });
      await network.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 'session',
        workspaceId: 'workspace',
        title: 'Held',
      });
      await network.startRun('session', {
        expectedStoreId: storeId,
        commandId: 'held',
        kind: 'run.start',
        content: 'owned cancellation gate',
      });
      await until(() => existsSync(join(value.base, 'entered')));
      const execution = readFileSync(join(value.base, 'entered'), 'utf8');
      await expect(value.call(value.server('restart'), build)).rejects.toMatchObject({
        code: 'lifecycle_busy',
      });
      const still = await value.native();
      expect(still.pid).toBe(original.pid);
      expect(still.instanceId).toBe(original.instanceId);
      expect(existsSync(join(value.base, 'cancelled'))).toBe(false);
      expect(await value.call(value.server('restart', { cancel: true }), build)).toBe(0);
      const replacement = await value.native();
      expect(replacement.pid).not.toBe(original.pid);
      expect(replacement.instanceId).not.toBe(original.instanceId);
      expect(replacement.workspace).toBe(original.workspace);
      expect(inspectProcess(original.pid, original.processStartIdentity)).toBe('dead');
      expect(readFileSync(join(value.base, 'cancelled'), 'utf8')).toBe(execution);
      expect(readFileSync(join(value.base, 'models'), 'utf8')).toBe('call\n');
      expect(JSON.parse(value.lines.at(-1)!)).toMatchObject({
        reused: false,
        instanceId: replacement.instanceId,
      });
    } finally {
      network?.disposeNetwork();
      await value.cleanup();
    }
  },
  40000,
);

nativeTest(
  'default endpoint stays absent without paths; lazy artifact selection only launches once and exact default bootstrap/stop work',
  async () => {
    const value = fixture(false, true);
    const build = artifact(value);
    let resolutions = 0;
    const lazy = () => {
      resolutions++;
      return build;
    };
    const call = (args: Extract<CLIArguments, { kind: 'server' | 'web' }>) =>
      value.call(args, undefined, value.base, lazy);
    try {
      expect(value.endpoint.record).toBe(join(value.endpoint.root, 'owner.json'));
      expect(await call(value.server('status'))).toBe(0);
      expect(JSON.parse(value.lines.at(-1)!)).toMatchObject({ state: 'absent' });
      expect(await call(value.server('stop'))).toBe(0);
      await expect(call({ kind: 'web', json: false })).rejects.toMatchObject({
        code: 'daemon_web_unavailable',
      });
      expect(resolutions).toBe(0);
      expect(existsSync(value.dataRoot)).toBe(false);
      expect(existsSync(value.endpoint.root)).toBe(false);
      expect(await call(value.server('start'))).toBe(0);
      expect(resolutions).toBe(1);
      const original = await value.native();
      expect(original.workspace).toBe(value.base);
      expect(readDaemonReservation(value.endpoint)).toMatchObject({
        instanceId: original.instanceId,
        pid: original.pid,
      });
      expect(existsSync(value.endpoint.record)).toBe(true);
      expect(existsSync(value.endpoint.socket)).toBe(true);
      expect(await call(value.server('status'))).toBe(0);
      expect(await call({ kind: 'web', json: false })).toBe(0);
      expect(value.lines.at(-1)).toBe(original.webOrigin);
      expect(await call(value.server('start'))).toBe(0);
      expect(JSON.parse(value.lines.at(-1)!)).toMatchObject({
        reused: true,
        instanceId: original.instanceId,
      });
      expect((await value.native()).pid).toBe(original.pid);
      expect(resolutions).toBe(1);
      expect(existsSync(join(value.base, 'models'))).toBe(false);
      expect(await call(value.server('stop'))).toBe(0);
      expect(resolutions).toBe(1);
      expect(inspectProcess(original.pid, original.processStartIdentity)).toBe('dead');
      expect(readDaemonReservation(value.endpoint)).toBeUndefined();
      expect(existsSync(value.endpoint.record)).toBe(false);
      expect(existsSync(value.endpoint.socket)).toBe(false);
    } finally {
      await value.cleanup();
      // This unique profile's default leaf only; shared default parent directories remain owned by the host.
      if (!readDaemonReservation(value.endpoint))
        rmSync(value.endpoint.root, { recursive: true, force: true });
    }
  },
  30000,
);

nativeTest(
  'start with corrupt Store exposes original diagnostic identity without replacement data; restart preflight preserves it',
  async () => {
    const value = fixture();
    const build = artifact(value);
    const corrupt = Buffer.from('owned deliberately invalid SQLite Store\0bytes');
    mkdirSync(value.profile.profilePath, { recursive: true, mode: 0o700 });
    writeFileSync(value.profile.databasePath, corrupt, { mode: 0o600 });
    try {
      expect(await value.call(value.server('start'), build)).toBe(0);
      const original = await value.native();
      const request = (path: string) =>
        fetch(original.httpEndpoint + path, {
          headers: { authorization: `Bearer ${original.token}` },
          signal: AbortSignal.timeout(5000),
        });
      expect(await value.call(value.server('status'))).toBe(0);
      expect(JSON.parse(value.lines.at(-1)!)).toMatchObject({
        state: 'accepting',
        instanceId: original.instanceId,
        dataAvailability: 'unavailable',
        busy: false,
      });
      const infoResponse = await request('/v1/server');
      expect(infoResponse.status).toBe(200);
      const info = await infoResponse.json();
      expect(info).toMatchObject({
        instanceId: original.instanceId,
        buildId: original.buildId,
        profile: value.identity,
        dataAvailability: 'unavailable',
      });
      expect(info.storeId).toBeUndefined();
      const lifecycleResponse = await request('/v1/lifecycle');
      expect(lifecycleResponse.status).toBe(200);
      expect(await lifecycleResponse.json()).toMatchObject({
        instanceId: original.instanceId,
        profile: value.identity,
        state: 'accepting',
        dataAvailability: 'unavailable',
      });
      const business = await request('/v1/workspaces');
      expect(business.status).toBe(503);
      expect(await business.json()).toMatchObject({ code: 'data_unavailable' });
      expect(readFileSync(value.profile.databasePath)).toEqual(corrupt);
      expect(existsSync(join(value.profile.profilePath, 'profile.json'))).toBe(false);
      expect(existsSync(join(value.base, 'models'))).toBe(false);
      const configured = readFileSync(join(value.base, 'configured'), 'utf8');
      await expect(value.call(value.server('restart'), build)).rejects.toThrow();
      const retained = await value.native();
      expect(retained.instanceId).toBe(original.instanceId);
      expect(retained.pid).toBe(original.pid);
      expect(inspectProcess(original.pid, original.processStartIdentity)).toBe('alive');
      expect(readFileSync(join(value.base, 'configured'), 'utf8')).toBe(configured);
      expect(readFileSync(value.profile.databasePath)).toEqual(corrupt);
      expect(existsSync(join(value.base, 'models'))).toBe(false);
      expect((await request('/v1/lifecycle')).status).toBe(200);
      expect(await value.call(value.server('stop'))).toBe(0);
      expect(inspectProcess(original.pid, original.processStartIdentity)).toBe('dead');
      expect(readDaemonReservation(value.endpoint)).toBeUndefined();
      expect(existsSync(value.endpoint.record)).toBe(false);
      expect(existsSync(value.endpoint.socket)).toBe(false);
      expect(readFileSync(value.profile.databasePath)).toEqual(corrupt);
    } finally {
      await value.cleanup();
    }
  },
  30000,
);
