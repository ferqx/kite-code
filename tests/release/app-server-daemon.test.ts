import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_ } from '@kite-ai/kite-app-contract';
import {
  createKiteAppServerDaemonClient,
  createNodeSocketRuntimeClientTransport,
  KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_,
  KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
  KITE_APP_SERVER_DAEMON_VERSION_,
} from '@kite-ai/kite-local-runtime/client';
import { createKiteSingleServiceNativeProcessIdentityProbe } from '@kite-ai/kite-local-runtime/manager';
import { readKiteLocalRuntimeLifecycleReservation } from '@kite-ai/kite-local-runtime/service';
import { RuntimeClient } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMethod } from '@kite-ai/runtime-protocol';
import { createManagedLocalAppServerDaemon } from '../../scripts/release/app-server-daemon';

describe('explicit App Server daemon lifecycle', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  });

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
      expect(await shell.text()).toContain('Kite daemon Web');
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
      const processProbe = createKiteSingleServiceNativeProcessIdentityProbe();
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
  writeFileSync(join(root, 'index.html'), '<html>Kite daemon Web</html>');
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
