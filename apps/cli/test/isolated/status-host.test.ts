import { Database } from 'bun:sqlite';
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
import { dirname, join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createClient } from '@kite-ai/client';
import {
  inspectProcess,
  requestDaemonBootstrap,
  selectDaemonEndpoint,
} from '@kite-ai/service/daemon';
import { runSelectedDaemon } from '../../host/daemon';
import { buildOwnedDaemon } from '../fixtures/daemon-host-build';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
let root: string, service: string, daemonEntry: string, driver: string;
const nativeTest = ['darwin', 'linux'].includes(process.platform) ? test : test.skip;
beforeAll(async () => {
  root = realpathSync(mkdtempSync('/private/tmp/kite-status-host-'));
  const old = await buildOwnedDaemon(join(root, 'artifact'));
  const result = await Bun.build({
    entrypoints: [
      new URL('../fixtures/status-host-driver.ts', import.meta.url).pathname,
      new URL('../fixtures/status-host-daemon-child.ts', import.meta.url).pathname,
      new URL('../fixtures/status-host-paired-child.ts', import.meta.url).pathname,
    ],
    target: 'bun',
    packages: 'external',
    naming: '[name].js',
    outdir: dirname(old),
  });
  if (!result.success) throw new AggregateError(result.logs, 'status_fixture_build_failed');
  service = join(dirname(old), 'status-host-paired-child.js');
  daemonEntry = join(dirname(old), 'status-host-daemon-child.js');
  driver = join(dirname(old), 'status-host-driver.js');
}, 60000);
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw Error('status_fixture_timeout');
    await Bun.sleep(5);
  }
}
async function fixture() {
  const base = join(root, randomUUID());
  mkdirSync(base, { mode: 0o700 });
  const workspace = join(base, 'workspace'),
    elsewhere = join(base, 'elsewhere');
  mkdirSync(workspace);
  mkdirSync(elsewhere);
  const profile = selectProfile({ dataRoot: join(base, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let providers = 0;
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      providers++;
      return new Response('provider_must_not_be_called', { status: 500 });
    },
  });
  writeFileSync(
    join(profile.profilePath, 'config.jsonc'),
    JSON.stringify({
      modelId: 'configured',
      tools: [],
      models: [
        {
          id: 'configured',
          provider: 'compatible',
          model: 'fixture',
          baseURL: `${provider.url.href}v1`,
          credentialRef: 'nonexistent-status-secret',
        },
      ],
    }),
    { mode: 0o600 },
  );
  const artifact = {
    entrypoint: service,
    entrypointSha256: hash(readFileSync(service)),
    executable: process.execPath,
    executableSha256: hash(readFileSync(process.execPath)),
    buildId: 'status-paired-fixture',
    apiMajor: 1 as const,
  };
  async function run(args: string[], shared = false) {
    const child = Bun.spawn([process.execPath, driver, ...args], {
      cwd: elsewhere,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        LANG: 'C.UTF-8',
        STATUS_BASE: base,
        STATUS_CWD: workspace,
        ...(!shared ? { STATUS_ARTIFACT: JSON.stringify(artifact) } : {}),
      },
    });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) {
        child.kill('SIGKILL');
        await child.exited;
      }
    }
  }
  function counts() {
    const db = new Database(profile.databasePath, { readonly: true });
    try {
      return Object.fromEntries(
        ['workspace', 'session', 'run', 'execution', 'command', 'host_mutation'].map((table) => [
          table,
          (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
        ]),
      );
    } finally {
      db.close();
    }
  }
  function output(result: Awaited<ReturnType<typeof run>>, kind: string) {
    expect(result.code, JSON.stringify(result)).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines.length).toBe(1);
    const value = JSON.parse(lines[0]!);
    expect(Object.keys(value).sort()).toEqual(['identity', 'scope', kind].sort());
    expect(value.identity.apiMajor).toBe(1);
    expect(value.identity.storeId).toBeString();
    expect(value.identity.profileAccessKey).toBe(profile.profileAccessKey);
    if (kind === 'release')
      expect(value.release).toMatchObject({
        active: false,
        production: null,
        qualification: 'unverified',
      });
    if (kind === 'telemetry')
      expect(value.telemetry).toMatchObject({
        enabled: false,
        exporterConfigured: false,
        diskSpool: false,
      });
    return value;
  }
  function pairedStopped() {
    for (const pid of readFileSync(join(base, 'paired-pids'), 'utf8').trim().split('\n'))
      expect(() => process.kill(Number(pid), 0)).toThrow();
  }
  return {
    base,
    workspace,
    elsewhere,
    profile,
    artifact,
    provider,
    run,
    counts,
    output,
    pairedStopped,
    providers: () => providers,
    close() {
      provider.stop(true);
      rmSync(base, { recursive: true, force: true });
    },
  };
}
nativeTest(
  'actual paired argv three status flags enforce trust and remain pure JSON reads without Session/Run/Provider',
  async () => {
    const f = await fixture();
    try {
      const refused = await f.run(['run', '--execution-status']);
      expect(refused.code, JSON.stringify(refused)).toBe(1);
      expect(refused.stdout).toBe('');
      expect(refused.stderr).toContain('workspace_not_trusted');
      expect(f.counts()).toEqual({
        workspace: 0,
        session: 0,
        run: 0,
        execution: 0,
        command: 0,
        host_mutation: 0,
      });
      f.pairedStopped();
      const trusted = f.output(
        await f.run(['run', '--execution-status', '--trust-workspace']),
        'execution',
      );
      expect(trusted.scope.sessionId).toBeNull();
      expect(trusted.scope.workspaceId).toBeString();
      expect(trusted.execution.permissions.workspaceTrust).toBe('trusted');
      expect(trusted.execution.sandbox.qualification).toBe('unqualified');
      const original = f.counts();
      expect(original.workspace).toBe(1);
      expect(original.session).toBe(0);
      expect(original.run).toBe(0);
      expect(original.execution).toBe(0);
      expect(original.command).toBe(0);
      expect(original.host_mutation).toBe(1);
      for (const kind of ['execution', 'release', 'telemetry']) {
        const value = f.output(await f.run(['run', `--${kind}-status`]), kind);
        expect(value.scope).toEqual(trusted.scope);
        expect(f.counts()).toEqual(original);
      }
      expect(f.providers()).toBe(0);
      expect(existsSync(join(f.base, 'credential-io'))).toBe(false);
      f.pairedStopped();
      writeFileSync(join(f.profile.profilePath, 'config.jsonc'), '{broken:');
      const degraded = f.output(await f.run(['run', '--release-status']), 'release');
      expect(degraded.release.qualification).toBe('unverified');
      expect(f.counts()).toEqual(original);
      expect(f.providers()).toBe(0);
      expect(existsSync(join(f.base, 'credential-io'))).toBe(false);
      f.pairedStopped();
    } finally {
      f.close();
    }
  },
  60000,
);
nativeTest(
  'actual shared argv selects only original thread scope and detaches while existing held work retains its instance',
  async () => {
    const f = await fixture();
    const endpoint = selectDaemonEndpoint({
      profileAccessKey: f.profile.profileAccessKey,
      explicitSocket: join(f.base, 'status.sock'),
    });
    const web = join(f.base, 'web');
    mkdirSync(web);
    const manifest = [
      ['/index.html', 'text/html; charset=utf-8', '<title>Owned status</title>'],
      ['/app.js', 'text/javascript; charset=utf-8', 'globalThis.owned=true;'],
      ['/app.css', 'text/css; charset=utf-8', 'body{}'],
    ].map(([path, mediaType, content]) => {
      writeFileSync(join(web, path!.slice(1)), content!);
      return { path, mediaType, size: Buffer.byteLength(content!), sha256: hash(content!) };
    });
    const raw = JSON.stringify(manifest);
    writeFileSync(join(web, 'manifest.json'), raw);
    const artifact = {
      ...f.artifact,
      buildId: 'status-running-shared',
      entrypoint: daemonEntry,
      entrypointSha256: hash(readFileSync(daemonEntry)),
      daemon: {
        entrypoint: daemonEntry,
        entrypointSha256: hash(readFileSync(daemonEntry)),
        web: { directory: web, manifestSha256: hash(raw) },
      },
    };
    async function daemon(action: 'start' | 'stop') {
      await runSelectedDaemon({
        arguments: {
          kind: 'server',
          action,
          server: endpoint.socket,
          cancel: action === 'stop',
          json: false,
        },
        dataRoot: f.profile.dataRoot,
        profile: 'owned',
        cwd: f.workspace,
        artifact,
        write() {},
      });
    }
    let client: ReturnType<typeof createClient> | undefined;
    try {
      await daemon('start');
      const bootstrap = await requestDaemonBootstrap(endpoint, {
        dataRoot: f.profile.dataRoot,
        name: 'owned',
        accessKey: f.profile.profileAccessKey,
      });
      client = createClient({
        endpoint: bootstrap.httpEndpoint,
        token: bootstrap.token,
        expected: {
          profile: bootstrap.profile,
          instanceId: bootstrap.instanceId,
          apiMajor: 1 as const,
          requiredCapabilities: [],
        },
      });
      const info = await client.connect();
      const storeId = info.storeId!;
      const first = f.output(
        await f.run(
          ['run', '--execution-status', '--server', endpoint.socket, '--trust-workspace'],
          true,
        ),
        'execution',
      );
      expect(first.identity.instanceId).toBe(bootstrap.instanceId);
      const workspaceId = first.scope.workspaceId;
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create-original',
        sessionId: 'original',
        workspaceId,
        title: 'Original scope',
      });
      await client.createWorkspace({
        expectedStoreId: storeId,
        id: 'elsewhere',
        rootUri: `file://${f.elsewhere}`,
        name: 'Other',
      });
      await client.createSession({
        expectedStoreId: storeId,
        commandId: 'create-alien',
        sessionId: 'alien',
        workspaceId: 'elsewhere',
        title: 'Alien',
      });
      await client.startRun('original', {
        expectedStoreId: storeId,
        commandId: 'held',
        kind: 'run.start',
        content: 'hold external',
      });
      await until(async () => existsSync(join(f.base, 'entered-original')));
      const baseline = f.counts(),
        original = (await client.getView('original')).executions.find(
          (e) => e.definitionId === 'fixture.held',
        )!;
      for (const kind of ['execution', 'release', 'telemetry']) {
        const value = f.output(
          await f.run(
            ['run', `--${kind}-status`, '--server', endpoint.socket, '--thread', 'original'],
            true,
          ),
          kind,
        );
        expect(value.scope).toEqual({ workspaceId, sessionId: 'original' });
        expect(value.identity.instanceId).toBe(bootstrap.instanceId);
        expect(f.counts()).toEqual(baseline);
        expect(
          (await client.getView('original')).executions.find((e) => e.id === original.id)!.status,
        ).toBe(original.status);
        expect(inspectProcess(bootstrap.pid, bootstrap.processStartIdentity)).toBe('alive');
        expect((await requestDaemonBootstrap(endpoint, bootstrap.profile)).instanceId).toBe(
          bootstrap.instanceId,
        );
      }
      const wrong = await f.run(
        ['run', '--release-status', '--server', endpoint.socket, '--thread', 'alien'],
        true,
      );
      expect(wrong.code).toBe(1);
      expect(wrong.stdout).toBe('');
      expect(wrong.stderr).toContain('workspace_identity_mismatch');
      expect(f.counts()).toEqual(baseline);
      const absent = await f.run(
        ['run', '--telemetry-status', '--server', endpoint.socket, '--thread', 'absent'],
        true,
      );
      expect(absent.code).toBe(1);
      expect(absent.stdout).toBe('');
      expect(f.counts()).toEqual(baseline);
      expect(existsSync(join(f.base, 'asset-reads'))).toBe(false);
      expect(existsSync(join(f.base, 'paired-pids'))).toBe(false);
      expect(readFileSync(join(f.base, 'models'), 'utf8')).toBe('call\n');
      expect(existsSync(join(f.base, 'cancelled-original'))).toBe(false);
      expect(f.providers()).toBe(0);
      expect(existsSync(join(f.base, 'credential-io'))).toBe(false);
    } finally {
      client?.disposeNetwork();
      await daemon('stop');
      f.close();
    }
  },
  60000,
);
