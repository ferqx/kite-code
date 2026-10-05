import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn as spawnChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import specification from '../../generated/openapi.json';
import {
  type DaemonBootstrap,
  readDaemonReservation,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from '../../src/daemon';

const repository = resolve(import.meta.dir, '../../../..');
let root: string;
let artifact: string;
let fixtureEntry: string;
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function deadline<T>(work: Promise<T>, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('daemon_fixture_deadline')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function runBuild(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  try {
    const [code, stdout, stderr] = await deadline(
      Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]),
      20000,
    );
    if (code !== 0) throw Error(`daemon_fixture_build_failed:${stdout}\n${stderr}`);
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGKILL');
      await child.exited;
    }
  }
}
beforeAll(async () => {
  root = mkdtempSync('/private/tmp/kite-daemon-process-');
  artifact = join(root, 'artifact');
  const modules = join(artifact, 'node_modules');
  const dependencies = new Map<string, Set<string>>();
  for (const directory of ['packages/agent', 'packages/ai', 'packages/client', 'apps/service']) {
    const source = join(repository, directory);
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      exports: Record<string, string>;
      scripts: { build: string };
      dependencies?: Record<string, string>;
    };
    const destination = join(modules, manifest.name);
    mkdirSync(destination, { recursive: true });
    for (const segment of manifest.scripts.build.split(/\s*&&\s*/)) {
      const words = segment.trim().split(/\s+/);
      if (words.shift() !== 'bun') throw Error('daemon_fixture_manifest_unknown');
      const args = words.map((word) =>
        word === 'dist' || word === './dist'
          ? destination
          : word.replace(/^--outdir=(?:\.\/)?dist$/, `--outdir=${destination}`),
      );
      const output = args.indexOf('--outdir');
      if (output >= 0) args[output + 1] = destination;
      await runBuild(args, source);
    }
    const exports = Object.fromEntries(
      Object.entries(manifest.exports).map(([key, value]) => [
        key,
        value.replace(/^\.\/src\//, './').replace(/\.ts$/, '.js'),
      ]),
    );
    writeFileSync(
      join(destination, 'package.json'),
      JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module', exports }),
    );
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      const owners = dependencies.get(dependency) ?? new Set<string>();
      owners.add(source);
      dependencies.set(dependency, owners);
    }
    expect(existsSync(join(destination, 'src'))).toBe(false);
  }
  for (const [dependency, owners] of dependencies) {
    if (dependency.startsWith('@kite-ai/')) continue;
    const installed = [
      ...Array.from(owners, (owner) => join(owner, 'node_modules', dependency)),
      join(repository, 'node_modules', dependency),
    ].find(existsSync);
    if (!installed) throw Error(`daemon_fixture_dependency_missing:${dependency}`);
    const target = join(modules, dependency);
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(realpathSync(installed), target, 'dir');
  }
  const fixtureBuild = await Bun.build({
    entrypoints: [new URL('../fixtures/daemon-process-child.ts', import.meta.url).pathname],
    target: 'bun',
    packages: 'external',
    outdir: artifact,
  });
  expect(fixtureBuild.success).toBe(true);
  fixtureEntry = join(artifact, 'daemon-process-child.js');
}, 60000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
function selection() {
  const directory = join(root, randomUUID());
  mkdirSync(directory, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(directory, 'data'), profile: 'owned' });
  const webDirectory = join(directory, 'web');
  mkdirSync(webDirectory);
  const paths = [
    [
      '/index.html',
      'text/html; charset=utf-8',
      '<!doctype html><title>Owned daemon</title><script src="/app.js"></script>',
    ],
    ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.fixtureDaemon = true;'],
    ['/app.css', 'text/css; charset=utf-8', 'body { color: black; }'],
  ];
  const assets = paths.map(([path, mediaType, content]) => {
    writeFileSync(join(webDirectory, path!.slice(1)), content!);
    return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
  });
  const manifest = JSON.stringify(assets);
  writeFileSync(join(webDirectory, 'manifest.json'), manifest);
  const host = {
    configured: join(directory, 'configured'),
    models: join(directory, 'models'),
    entered: join(directory, 'entered'),
    effects: join(directory, 'effects'),
    cancelled: join(directory, 'cancelled'),
  };
  const startup = {
    profile: {
      dataRoot: profile.dataRoot,
      profile: profile.profile,
      profileAccessKey: profile.profileAccessKey,
    },
    instanceId: `daemon-${randomUUID()}`,
    buildId: 'compiled-fixture',
    token: 't'.repeat(64),
    hostConfiguration: host,
  };
  const input = {
    operation: 'start' as 'start' | 'preflight',
    startup,
    workspace: directory,
    socket: join(directory, 'd.sock'),
    web: { directory: webDirectory, manifestSha256: hash(manifest) },
  };
  const identity = {
    dataRoot: profile.dataRoot,
    name: profile.profile,
    accessKey: profile.profileAccessKey,
  };
  const endpoint = selectDaemonEndpoint({
    profileAccessKey: profile.profileAccessKey,
    explicitSocket: input.socket,
  });
  return { directory, profile, host, input, identity, endpoint };
}
function spawn(input: ReturnType<typeof selection>['input']) {
  const child = Bun.spawn([process.execPath, fixtureEntry], {
    cwd: artifact,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stderr = new Response(child.stderr).text();
  child.stdin.write(`${JSON.stringify(input)}\n`);
  child.stdin.end();
  return { child, stderr };
}
async function launch(value: ReturnType<typeof selection>) {
  const process = spawn(value.input);
  const reader = process.child.stdout.getReader();
  let text = '';
  try {
    while (!text.includes('\n')) {
      const chunk = await deadline(reader.read());
      if (chunk.done) throw Error(`daemon_fixture_no_bootstrap:${await process.stderr}`);
      text += new TextDecoder().decode(chunk.value);
    }
  } catch (error) {
    process.child.kill('SIGKILL');
    await process.child.exited;
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bootstrap = JSON.parse(text.trim()) as DaemonBootstrap;
  return { ...process, bootstrap };
}
async function clean(process: Awaited<ReturnType<typeof launch>>) {
  if (process.child.exitCode === null) {
    process.child.kill('SIGTERM');
    try {
      await deadline(process.child.exited, 5000);
    } catch {
      process.child.kill('SIGKILL');
      await process.child.exited;
    }
  }
}
function http(bootstrap: DaemonBootstrap, path: string, init?: RequestInit) {
  return fetch(bootstrap.httpEndpoint + path, {
    ...init,
    headers: { authorization: `Bearer ${bootstrap.token}`, ...init?.headers },
    signal: AbortSignal.timeout(5000),
  });
}
function shutdown(bootstrap: DaemonBootstrap, mode: 'if_idle' | 'cancel') {
  return http(bootstrap, '/v1/lifecycle/shutdown', {
    method: 'POST',
    body: JSON.stringify({
      lifecycleVersion: 1,
      expectedProfile: bootstrap.profile,
      expectedInstanceId: bootstrap.instanceId,
      mode,
    }),
  });
}
async function until(read: () => boolean) {
  const end = Date.now() + 5000;
  while (!read()) {
    if (Date.now() > end) throw Error('daemon_fixture_observation_timeout');
    await Bun.sleep(5);
  }
}
nativeTest(
  'compiled daemon survives startup EOF; native/HTTP identity and Cookie Web docs have no token; idle closes exact endpoint',
  async () => {
    const value = selection();
    const process = await launch(value);
    try {
      expect(process.child.exitCode).toBeNull();
      const native = await requestDaemonBootstrap(value.endpoint, value.identity);
      expect(native).toMatchObject({
        instanceId: value.input.startup.instanceId,
        buildId: 'compiled-fixture',
        pid: process.child.pid,
        profile: value.identity,
      });
      expect(native.httpEndpoint).toBe(process.bootstrap.httpEndpoint);
      const lifecycle = await (await http(native, '/v1/lifecycle')).json();
      expect(lifecycle).toMatchObject({
        instanceId: native.instanceId,
        profile: value.identity,
        state: 'accepting',
        busy: false,
      });
      expect(
        (await http(native, '/v1/lifecycle', { headers: { origin: native.webOrigin } })).status,
      ).toBe(403);
      const shell = await fetch(native.webOrigin);
      const cookie = shell.headers.get('set-cookie')!.split(';')[0]!;
      const pageIdentity = shell.headers.get('x-kite-web-identity')!;
      expect(shell.status).toBe(200);
      expect(await shell.text()).not.toContain(native.token);
      for (const path of ['/app.js', '/app.css']) {
        const asset = await fetch(native.webOrigin + path);
        expect(asset.status).toBe(200);
        expect(await asset.text()).not.toContain(native.token);
      }
      const headers = { cookie, origin: native.webOrigin, 'x-kite-web-identity': pageIdentity };
      const browser = await fetch(`${native.webOrigin}/browser/v1/server`, { headers });
      expect(browser.status).toBe(200);
      const info = await browser.json();
      expect(info).toMatchObject({ instanceId: native.instanceId, buildId: native.buildId });
      expect(JSON.stringify(info)).not.toContain(native.token);
      expect((await fetch(`${native.webOrigin}/browser/v1/workspaces`, { headers })).status).toBe(
        200,
      );
      expect(
        (
          await fetch(`${native.webOrigin}/v1/lifecycle/shutdown`, {
            method: 'POST',
            headers,
            body: '{}',
          })
        ).status,
      ).not.toBe(202);
      const docs = await fetch(`${native.webOrigin}/api-docs`);
      expect(docs.status).toBe(200);
      const docsText = await docs.text();
      expect(docsText).toContain('Kite API Docs');
      expect(docsText).not.toContain(native.token);
      const spec = await fetch(`${native.webOrigin}/openapi.json`);
      expect(spec.status).toBe(200);
      const json = await spec.json();
      expect(json).toEqual(specification);
      expect(JSON.stringify(json)).not.toContain(native.token);
      expect(existsSync(value.host.models)).toBe(false);
      expect((await shutdown(native, 'if_idle')).status).toBe(202);
      expect(await deadline(process.child.exited)).toBe(0);
      expect(readDaemonReservation(value.endpoint)).toBeUndefined();
      expect(existsSync(value.endpoint.socket)).toBe(false);
      expect(existsSync(value.endpoint.record)).toBe(false);
      expect(existsSync(value.host.models)).toBe(false);
    } finally {
      await clean(process);
    }
  },
  20000,
);

nativeTest(
  'held real Run makes if_idle busy; explicit cancel actually exits and clears original record/socket',
  async () => {
    const value = selection();
    const process = await launch(value);
    const native = process.bootstrap;
    const client = createClient({
      endpoint: native.httpEndpoint,
      token: native.token,
      expected: {
        profile: native.profile,
        instanceId: native.instanceId,
        buildId: native.buildId,
        apiMajor: 1,
        requiredCapabilities: [],
      },
    });
    try {
      const server = await client.connect();
      const storeId = server.storeId!;
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'workspace',
        rootUri: `file://${value.directory}`,
        name: 'Owned',
      });
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create',
        sessionId: 'session',
        workspaceId: 'workspace',
        title: 'Held',
      });
      await client.startRun('session', {
        expectedStoreId: storeId,
        commandId: 'run',
        kind: 'run.start',
        content: 'owned held effect',
      });
      await until(() => existsSync(value.host.entered));
      expect((await shutdown(native, 'if_idle')).status).toBe(409);
      expect(process.child.exitCode).toBeNull();
      expect((await requestDaemonBootstrap(value.endpoint, value.identity)).instanceId).toBe(
        native.instanceId,
      );
      expect(await (await http(native, '/v1/lifecycle')).json()).toMatchObject({
        state: 'accepting',
        busy: true,
      });
      expect(readFileSync(value.host.models, 'utf8')).toBe('call\n');
      expect((await shutdown(native, 'cancel')).status).toBe(202);
      expect(await deadline(process.child.exited)).toBe(0);
      expect(readDaemonReservation(value.endpoint)).toBeUndefined();
      expect(existsSync(value.endpoint.socket)).toBe(false);
      expect(existsSync(value.endpoint.record)).toBe(false);
      expect(existsSync(value.host.effects)).toBe(false);
      expect(readFileSync(value.host.cancelled, 'utf8')).toBe(
        readFileSync(value.host.entered, 'utf8'),
      );
    } finally {
      client.disposeNetwork();
      await clean(process);
    }
  },
  20000,
);

nativeTest(
  'failed selected build preflight preserves running daemon, Core bytes and zero configure/Model calls',
  async () => {
    const value = selection();
    const process = await launch(value);
    try {
      const configured = readFileSync(value.host.configured, 'utf8');
      const check = async (input: typeof value.input) => {
        const candidate = spawn({
          ...input,
          operation: 'preflight',
          startup: { ...input.startup, instanceId: `candidate-${randomUUID()}` },
        });
        const stdout = new Response(candidate.child.stdout).text();
        try {
          expect(await deadline(candidate.child.exited)).toBe(1);
          expect(await stdout).toBe('');
          expect(await candidate.stderr).toContain('daemon_fixture_failed');
        } finally {
          if (candidate.child.exitCode === null) {
            candidate.child.kill('SIGKILL');
            await candidate.child.exited;
          }
        }
        expect(readFileSync(value.host.configured, 'utf8')).toBe(configured);
        expect(existsSync(value.host.models)).toBe(false);
        expect(process.child.exitCode).toBeNull();
        expect((await requestDaemonBootstrap(value.endpoint, value.identity)).instanceId).toBe(
          process.bootstrap.instanceId,
        );
        expect((await http(process.bootstrap, '/v1/lifecycle')).status).toBe(200);
      };
      const original = readFileSync(value.profile.databasePath);
      const originalWalPath = `${value.profile.databasePath}-wal`;
      const originalWal = existsSync(originalWalPath) ? readFileSync(originalWalPath) : null;
      await check({ ...value.input, web: { ...value.input.web, manifestSha256: '0'.repeat(64) } });
      expect(readFileSync(value.profile.databasePath)).toEqual(original);
      expect(existsSync(originalWalPath) ? readFileSync(originalWalPath) : null).toEqual(
        originalWal,
      );
      const db = new Database(value.profile.databasePath);
      db.exec('UPDATE storage_meta SET format_major=99');
      db.close(true);
      const core = readFileSync(value.profile.databasePath);
      const walPath = `${value.profile.databasePath}-wal`;
      const wal = existsSync(walPath) ? readFileSync(walPath) : null;
      await check(value.input);
      expect(readFileSync(value.profile.databasePath)).toEqual(core);
      expect(existsSync(walPath) ? readFileSync(walPath) : null).toEqual(wal);
      expect((await shutdown(process.bootstrap, 'if_idle')).status).toBe(202);
      expect(await deadline(process.child.exited)).toBe(0);
    } finally {
      await clean(process);
    }
  },
  20000,
);

nativeTest(
  'launcher closes bootstrap output pipes immediately; original endpoint discovery remains live and idle public shutdown exits',
  async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const value = selection();
      const child = spawnChildProcess(process.execPath, [fixtureEntry], {
        cwd: artifact,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once('exit', resolve);
        child.once('error', reject);
      });
      void exited.catch(() => {});
      child.stdin.on('error', () => {});
      child.stdin.end(`${JSON.stringify(value.input)}\n`);
      child.stdout.destroy();
      child.stderr.destroy();
      let bootstrap: DaemonBootstrap | undefined;
      try {
        // configure runs only after the original reservation publish/fsync. Do not read the
        // wx-created record before its owned initial write; unsafe records remain fatal.
        const configuredDeadline = Date.now() + 5000;
        for (;;) {
          if (child.exitCode !== null) throw Error(`daemon_fixture_early_exit:${child.exitCode}`);
          if (existsSync(value.host.configured)) {
            const configured = readFileSync(value.host.configured, 'utf8');
            if (configured === value.input.startup.instanceId) break;
            if (configured.length !== 0) throw Error('daemon_fixture_configure_identity_mismatch');
          }
          if (Date.now() > configuredDeadline) throw Error('daemon_fixture_configure_timeout');
          await Bun.sleep(5);
        }
        const end = Date.now() + 5000;
        for (;;) {
          if (child.exitCode !== null) throw Error(`daemon_fixture_early_exit:${child.exitCode}`);
          const record = readDaemonReservation(value.endpoint);
          if (record) {
            if (record.instanceId !== value.input.startup.instanceId || record.pid !== child.pid)
              throw Error('daemon_fixture_discovery_identity_mismatch');
            try {
              bootstrap = await requestDaemonBootstrap(value.endpoint, value.identity);
              break;
            } catch (error) {
              if (
                !(
                  error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === 'daemon_not_ready'
                )
              )
                throw error;
            }
          }
          if (Date.now() > end) throw Error('daemon_fixture_discovery_timeout');
          await Bun.sleep(5);
        }
        expect(bootstrap).toMatchObject({
          instanceId: value.input.startup.instanceId,
          pid: child.pid,
          buildId: value.input.startup.buildId,
          profile: value.identity,
        });
        expect(await (await http(bootstrap, '/v1/lifecycle')).json()).toMatchObject({
          state: 'accepting',
          instanceId: bootstrap.instanceId,
          busy: false,
        });
        expect(existsSync(value.host.models)).toBe(false);
        expect((await shutdown(bootstrap, 'if_idle')).status).toBe(202);
        expect(await deadline(exited)).toBe(0);
        expect(existsSync(value.endpoint.socket)).toBe(false);
        expect(existsSync(value.endpoint.record)).toBe(false);
        expect(existsSync(value.host.models)).toBe(false);
      } finally {
        if (child.exitCode === null) {
          child.kill('SIGTERM');
          try {
            await deadline(exited, 5000);
          } catch {
            child.kill('SIGKILL');
            await exited;
          }
        }
      }
    }
  },
  20000,
);
