import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_ } from '@kite-ai/kite-app-contract';
import {
  createKiteAppServerDaemonClient,
  createNodeSocketRuntimeClientTransport,
  KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_,
  KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
  KITE_APP_SERVER_DAEMON_VERSION_,
  requestKiteLifecycle,
} from '@kite-ai/kite-local-runtime/client';
import {
  createKiteLocalRuntimeProcessIdentityProbe,
  readKiteLocalRuntimeLifecycleReservation,
} from '@kite-ai/kite-local-runtime/service';
import { RuntimeClient } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMethod } from '@kite-ai/runtime-protocol';
import { initializeKiteHomeStoreSchema } from '../../packages/runtime-storage-sqlite/src/kite-home-store';
import { KITE_SESSION_STORE11_DDL } from '../../packages/runtime-storage-sqlite/src/kite-session-store11-conversion';
import { createManagedLocalAppServerDaemon } from '../../scripts/release/app-server-daemon';

describe('explicit App Server daemon lifecycle', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  test('server-rejected protocol versions are incompatible without shutdown or replacement', async () => {
    if (process.platform === 'win32') return;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-daemon-version-')));
    cleanup.push(root);
    const endpoint = join(root, 'daemon.sock');
    const methods: string[] = [];
    const server = createServer((socket) => {
      let buffered = '';
      socket.on('data', (chunk) => {
        buffered += chunk.toString();
        while (true) {
          const newline = buffered.indexOf('\n');
          if (newline < 0) break;
          const request = JSON.parse(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          methods.push(request.method);
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32004,
                message: 'Protocol version mismatch',
                data: { code: 'protocol_version_mismatch' },
              },
            })}\n`,
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(endpoint, resolve);
    });
    try {
      const daemon = createManagedLocalAppServerDaemon({
        argv: ['kite', '--kite-home', join(root, 'home')],
        systemHome: root,
        endpoint,
      });
      await expect(daemon.status()).resolves.toMatchObject({ state: 'incompatible' });
      await expect(daemon.start(root)).resolves.toMatchObject({ state: 'incompatible' });
      await expect(daemon.stop()).rejects.toThrow('lifecycle is unavailable');
      await expect(daemon.discoverWeb()).rejects.toThrow('protocol is incompatible');
      expect(methods.filter(Boolean)).toEqual(Array(4).fill('initialize'));
      expect(existsSync(join(root, 'home'))).toBe(false);
      expect(server.listening).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  test('restarts an independently running incompatible business version through lifecycle v1', async () => {
    const root = realpathSync.native(
      mkdtempSync(join(realpathSync.native(tmpdir()), 'kite-upgrade-')),
    );
    cleanup.push(root);
    const daemon = createManagedLocalAppServerDaemon({
      argv: ['kite', '--kite-home', join(root, 'home')],
      systemHome: root,
      sourceWebStaticRoot: createWebAssets(root),
    });
    const child = Bun.spawn(
      [
        process.execPath,
        'tests/fixtures/lifecycle/old-daemon.ts',
        daemon.endpoint.kind === 'unix' ? daemon.endpoint.socket : daemon.endpoint.pipeName,
        daemon.endpoint.homeDigest,
        root,
      ],
      { stdout: 'pipe', stderr: 'inherit' },
    );
    try {
      await until(async () => (await daemon.status()).state === 'incompatible');
      await expect(daemon.start(root)).resolves.toMatchObject({
        state: 'incompatible',
        buildId: 'old-release-fixture',
      });
      await expect(
        requestKiteLifecycle(daemon.endpoint, {
          operation: 'shutdown',
          expectedInstanceId: 'wrong-instance',
          mode: 'cancel',
        }),
      ).resolves.toMatchObject({ outcome: 'instance_changed' });
      const restarted = await daemon.restart(root);
      expect(restarted).toMatchObject({
        state: 'ready',
        buildId: daemon.target.buildId,
        workspace: root,
      });
      expect(restarted.instanceId).not.toBe('released-old-fixture');
      expect(await child.exited).toBe(0);
      const again = await daemon.restart(root);
      expect(again.instanceId).not.toBe(restarted.instanceId);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await child.exited;
      }
      const status = await daemon.status();
      if (status.lifecycle) await daemon.stop();
    }
  }, 30_000);

  test('preflight failure preserves the instance and concurrent restarts settle on one owner', async () => {
    if (process.platform === 'win32') return;
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-concurrent-restart-')));
    cleanup.push(root);
    const options = {
      argv: ['kite', '--kite-home', join(root, 'home')],
      systemHome: root,
      sourceWebStaticRoot: createWebAssets(root),
    };
    const daemon = createManagedLocalAppServerDaemon(options);
    try {
      const original = await daemon.start(root);
      const invalid = createManagedLocalAppServerDaemon({
        ...options,
        sourceWebStaticRoot: join(root, 'missing-assets'),
      });
      await expect(invalid.restart(root)).rejects.toThrow('Web assets');
      expect((await daemon.status()).instanceId).toBe(original.instanceId);
      const results = await Promise.allSettled([daemon.restart(root), daemon.restart(root)]);
      expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
      const settled = await daemon.status();
      expect(settled).toMatchObject({ state: 'ready', buildId: daemon.target.buildId });
      expect(settled.instanceId).not.toBe(original.instanceId);
    } finally {
      if ((await daemon.status()).lifecycle) await daemon.stop();
    }
  }, 30_000);

  test('absent daemon delegates exact Store 11 preparation and surfaces an unqualified admission refusal', async () => {
    if (process.platform === 'win32') return;
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-daemon-store11-')));
    cleanup.push(root);
    const home = join(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const storePath = join(home, 'kite-session.sqlite');
    const store = new Database(storePath, { strict: true });
    chmodSync(storePath, 0o600);
    try {
      for (const sql of KITE_SESSION_STORE11_DDL) store.run(sql);
      store.query('INSERT INTO kite_meta(key,value) VALUES (?,?)').run('schema_version', '11');
      store
        .query('INSERT INTO kite_meta(key,value) VALUES (?,?)')
        .run('format_epoch', 'kite-session-accepted-runs-2026-09-15');
      store.run('PRAGMA user_version=11');
    } finally {
      store.close(false);
    }
    const before = createHash('sha256').update(readFileSync(storePath)).digest('hex');
    const daemon = createManagedLocalAppServerDaemon({
      argv: ['kite', '--kite-home', home],
      systemHome: root,
      sourceWebStaticRoot: createWebAssets(root),
    });
    await expect(daemon.start(root)).rejects.toThrow('STORE_HISTORY_RECONCILIATION_REQUIRED');
    expect(createHash('sha256').update(readFileSync(storePath)).digest('hex')).toBe(before);
    expect((await daemon.status()).state).toBe('absent');
  }, 20_000);

  test('restart preserves a ready daemon when historical source or publication intent appears', async () => {
    if (process.platform === 'win32') return;
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-daemon-restart-guard-')));
    cleanup.push(root);
    const home = join(root, 'home');
    const daemon = createManagedLocalAppServerDaemon({
      argv: ['kite', '--kite-home', home],
      systemHome: root,
      sourceWebStaticRoot: createWebAssets(root),
    });
    const started = await daemon.start(root);
    try {
      const historicalPath = join(home, 'kite.sqlite');
      const historical = new Database(historicalPath, { strict: true });
      chmodSync(historicalPath, 0o600);
      try {
        initializeKiteHomeStoreSchema(historical);
      } finally {
        historical.close(false);
      }
      await expect(daemon.restart(root)).rejects.toThrow('Historical session data exists');
      expect((await daemon.status()).instanceId).toBe(started.instanceId);
      rmSync(historicalPath);
      writeFileSync(join(home, 'kite-session-publication.json'), '{}', { mode: 0o600 });
      await expect(daemon.restart(root)).rejects.toThrow('Store publication is pending');
      expect((await daemon.status()).instanceId).toBe(started.instanceId);
    } finally {
      await daemon.stop();
    }
  }, 20_000);

  test('two absent starters converge on one daemon after their temporary stdio Services close', async () => {
    if (process.platform === 'win32') return;
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-daemon-absent-race-')));
    cleanup.push(root);
    const daemon = createManagedLocalAppServerDaemon({
      argv: ['kite', '--kite-home', join(root, 'home')],
      systemHome: root,
      sourceWebStaticRoot: createWebAssets(root),
    });
    try {
      const starts = await Promise.allSettled([daemon.start(root), daemon.start(root)]);
      expect(starts.some((result) => result.status === 'fulfilled')).toBe(true);
      await until(async () => (await daemon.status()).state === 'ready');
      const final = await daemon.status();
      expect(final).toMatchObject({ state: 'ready', buildId: daemon.target.buildId });
      for (const result of starts) {
        if (result.status === 'fulfilled' && result.value.state === 'ready')
          expect(result.value.instanceId).toBe(final.instanceId);
      }
    } finally {
      if ((await daemon.status()).lifecycle) await daemon.stop();
    }
  }, 20_000);

  test('starts explicitly, serves two clients over the exact protocol, and stops explicitly', async () => {
    if (process.platform === 'win32') return;
    const systemHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-daemon-home-')));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'kite-daemon-workspace-')));
    cleanup.push(systemHome, workspace);
    const kiteHome = join(systemHome, '.kite-code');
    const sourceWebStaticRoot = createWebAssets(systemHome);
    const daemon = createManagedLocalAppServerDaemon({
      argv: ['kite', '--kite-home', kiteHome],
      systemHome,
      executableMode: 'source',
      sourceWebStaticRoot,
    });
    mkdirSync(daemon.target.configRoot, { recursive: true });
    writeFileSync(
      join(daemon.target.configRoot, 'kite-code.jsonc'),
      JSON.stringify({
        provider: {
          fixture: {
            type: 'openai-compatible',
            apiKey: 'test-key',
            baseURL: 'http://127.0.0.1:1',
            models: ['fixture-model'],
          },
        },
        model: { default: { provider: 'fixture', name: 'fixture-model' } },
      }),
    );
    let first: Awaited<ReturnType<typeof daemon.connector.connect>> | undefined;
    let second: Awaited<ReturnType<typeof daemon.connector.connect>> | undefined;
    try {
      const started = await daemon.start(workspace);
      expect(started).toMatchObject({ state: 'ready', workspace });
      expect(started.webOrigin).toMatch(/^http:\/\/127\.0\.0\.1:/u);
      await expect(daemon.discoverWeb()).resolves.toBe(`${started.webOrigin}/`);
      expect((await daemon.start(workspace)).instanceId).toBe(started.instanceId);

      const shell = await fetch(`${started.webOrigin}/`);
      const html = await shell.text();
      expect(html).toContain('Kite daemon Web');
      const pageIdentity = /name="kite-web-identity" content="([^"]+)"/.exec(html)?.[1];
      if (!pageIdentity) throw new Error('Web shell has no instance/build identity');
      const cookie = shell.headers.get('set-cookie');
      expect(cookie).toBeTruthy();
      const api = await fetch(`${started.webOrigin}/v1`, {
        headers: {
          cookie: cookie!,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'same-origin',
        },
      });
      expect(api.status).toBe(200);
      expect(api.headers.get('x-kite-web-identity')).toBe(pageIdentity);
      await expect(api.json()).resolves.toMatchObject({ build_id: daemon.target.buildId });

      const oldCompatible = createKiteAppServerDaemonClient({
        endpoint: daemon.endpoint,
        clientInfo: { name: 'old-client', version: '0', instanceId: 'old-client-1' },
      });
      await oldCompatible.connect();
      await expect(
        oldCompatible.runtime.requestServerControl('server/status', {
          schema: KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
        }),
      ).resolves.toMatchObject({ buildId: daemon.target.buildId });
      await oldCompatible.close('old-compatible-client-complete');

      const oldProtocol = new RuntimeClient({
        transport: createNodeSocketRuntimeClientTransport({ endpoint: daemon.endpoint }),
        clientInfo: { name: 'old-protocol-client', version: '0', instanceId: 'old-protocol-1' },
        expectedServer: {
          version: 'kite-app-server-daemon-v1',
          requiredMethods: KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_,
        },
      });
      await expect(oldProtocol.connect()).rejects.toMatchObject({ code: 'server_mismatch' });
      await oldProtocol.close('expected-version-mismatch');

      const futureClient = new RuntimeClient({
        transport: createNodeSocketRuntimeClientTransport({ endpoint: daemon.endpoint }),
        clientInfo: { name: 'future-client', version: '2', instanceId: 'future-client-1' },
        expectedServer: {
          version: KITE_APP_SERVER_DAEMON_VERSION_,
          requiredMethods: [
            ...KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_,
            'server/future-capability' as RuntimeProtocolMethod,
          ],
        },
      });
      await expect(futureClient.connect()).rejects.toThrow();
      await futureClient.close('expected-capability-mismatch');
      expect(await daemon.status()).toMatchObject({
        state: 'ready',
        instanceId: started.instanceId,
      });

      first = await daemon.connector.connect({ workspace });
      const trust = await first.app.queryWorkspaceTrust({
        schema: 'kite.app.workspace-trust.query-request.v1',
        workspace,
      });
      if (trust.status !== 'trusted') {
        await first.app.decideWorkspaceTrust({
          schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
          workspace: trust.workspace,
          observedStatus: trust.status,
          expectedRevision: trust.revision,
          decision: 'trust',
          externalReadScopeDigest: trust.externalReadScope.digest,
        });
      }
      const sessionId = `daemon-session-${Date.now()}`;
      const receipt = await first.runtime.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: `create-${sessionId}`,
        type: 'create_session',
        workspace,
        bootstrapSessionId: sessionId,
      });
      expect(receipt.status).toBe('applied');

      second = await daemon.connector.connect({ workspace });
      const page = await second.history.listSessions({ limit: 10 });
      expect(page.entries.map((session) => session.sessionId)).toContain(sessionId);
      await expect(readBrowserSessionIds(started.webOrigin!, cookie!)).resolves.toContain(
        sessionId,
      );
      expect(await daemon.status()).toMatchObject({
        state: 'ready',
        instanceId: started.instanceId,
      });

      expect(await daemon.stop()).toMatchObject({ state: 'absent' });
    } finally {
      await first?.close('test-cleanup').catch(() => undefined);
      await second?.close('test-cleanup').catch(() => undefined);
      const status = await daemon.status();
      if (status.state === 'ready' || status.state === 'draining') {
        await daemon.stop().catch(() => undefined);
      }
    }
  }, 30_000);

  test('absent status and stop do not create Kite Home or daemon state', async () => {
    if (process.platform === 'win32') return;
    const systemHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-daemon-read-home-')));
    cleanup.push(systemHome);
    const kiteHome = join(systemHome, '.kite-code');
    const daemon = createManagedLocalAppServerDaemon({
      argv: ['kite', '--kite-home', kiteHome],
      systemHome,
      executableMode: 'source',
      sourceWebStaticRoot: createWebAssets(systemHome),
    });

    await expect(daemon.status()).resolves.toMatchObject({ state: 'absent' });
    await expect(daemon.stop()).resolves.toMatchObject({ state: 'absent' });
    await expect(daemon.discoverWeb()).rejects.toThrow('kite server start');
    expect(existsSync(kiteHome)).toBe(false);
  });

  test('reclaims only an exact dead daemon reservation before restart', async () => {
    if (process.platform === 'win32') return;
    const systemHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-daemon-dead-home-')));
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'kite-daemon-dead-workspace-')));
    cleanup.push(systemHome, workspace);
    const daemon = createManagedLocalAppServerDaemon({
      argv: ['kite', '--kite-home', join(systemHome, '.kite-code')],
      systemHome,
      executableMode: 'source',
      sourceWebStaticRoot: createWebAssets(systemHome),
    });
    try {
      const first = await daemon.start(workspace);
      const reservation = readKiteLocalRuntimeLifecycleReservation(daemon.endpoint);
      expect(reservation?.instanceId).toBe(first.instanceId);
      if (!reservation || reservation.pid === process.pid) {
        throw new Error('Daemon test did not obtain a child process identity.');
      }
      process.kill(reservation.pid, 'SIGKILL');
      const processProbe = createKiteLocalRuntimeProcessIdentityProbe();
      await until(
        async () =>
          (await daemon.status()).state === 'unavailable' &&
          (await processProbe.inspect(reservation.pid, reservation.processStartIdentity)) ===
            'dead',
      );

      const restarted = await daemon.start(workspace);
      expect(restarted).toMatchObject({ state: 'ready', workspace });
      expect(restarted.instanceId).not.toBe(first.instanceId);
    } finally {
      const status = await daemon.status();
      if (status.state === 'ready' || status.state === 'draining') {
        await daemon.stop().catch(() => undefined);
      }
    }
  }, 30_000);
});

async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error('Timed out waiting for daemon state.');
}

function createWebAssets(parent: string): string {
  const root = join(parent, 'web');
  mkdirSync(join(root, 'api-docs'), { recursive: true });
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<html><head></head><body>Kite daemon Web</body></html>');
  writeFileSync(join(root, 'api-docs', 'openapi.json'), '{}');
  writeFileSync(join(root, 'assets', 'app.js'), 'export {};');
  return realpathSync(root);
}

async function readBrowserSessionIds(origin: string, cookie: string): Promise<string[]> {
  const headers = {
    cookie,
    accept: 'application/json',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'same-origin',
  };
  const workspaces = (await fetch(`${origin}/v1/workspaces?limit=100`, { headers }).then(
    (response) => response.json(),
  )) as { readonly items: readonly { readonly workspace_id: string }[] };
  const sessionIds: string[] = [];
  for (const workspace of workspaces.items) {
    const sessions = (await fetch(
      `${origin}/v1/workspaces/${encodeURIComponent(workspace.workspace_id)}/sessions?limit=100`,
      { headers },
    ).then((response) => response.json())) as {
      readonly items: readonly { readonly session_id: string }[];
    };
    sessionIds.push(...sessions.items.map((session) => session.session_id));
  }
  return sessionIds;
}
