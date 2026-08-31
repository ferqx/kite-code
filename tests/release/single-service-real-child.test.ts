import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  acquireKiteServiceModeController,
  createKiteServiceModeSession,
} from '../../apps/kite-cli/src/service-mode';
import { createManagedSingleServiceNativeComposition } from '../../scripts/release/single-service-native-client';

describe('single-Service real child target', () => {
  test('ensures, reuses and stops one native endpoint without Kite Home process state', async () => {
    if (process.platform === 'win32') return;
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-single-child-')));
    const homeRoot = join(root, 'kite-home');
    const runtimeParent = join(root, 'runtime');
    const osHome = join(root, 'os-home');
    const neutral = join(root, 'neutral');
    const staticRoot = join(root, 'web');
    const workspace = join(root, 'workspace');
    for (const directory of [homeRoot, runtimeParent, osHome, neutral, staticRoot, workspace]) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    writeFileSync(
      join(homeRoot, 'kite-code.jsonc'),
      JSON.stringify({
        provider: {
          fixture: {
            type: 'openai-compatible',
            apiKey: 'real-child-test-key',
            baseURL: 'http://127.0.0.1:43123/v1',
            model: 'fixture-model',
          },
        },
        model: { default: { provider: 'fixture', name: 'fixture-model' } },
        sandbox: { enabled: false },
        interactionMode: 'auto',
      }),
    );
    const buildId = 'dev:single-child-build-1';
    const composition = createManagedSingleServiceNativeComposition({
      home: createKiteHomeIdentity(homeRoot),
      runtimeParent,
      expectedBuildId: buildId,
      staticAssetRoot: staticRoot,
      executable: {
        path: resolve(import.meta.dir, '../../scripts/release/entrypoints/service.ts'),
        mode: 'source',
        buildId,
      },
      cwd: neutral,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: osHome,
        KITE_CODE_HOME: homeRoot,
        KITE_SERVICE_BUILD_ID: buildId,
        KITE_SINGLE_SERVICE_RUNTIME_PARENT: runtimeParent,
        NODE_ENV: 'production',
      },
      startupTimeoutMs: 20_000,
      stopTimeoutMs: 20_000,
      childStderr: 'inherit',
    });
    try {
      const first = await composition.manager.ensure({ requestId: 'ensure-1' });
      expect(first).toMatchObject({ outcome: 'applied', state: 'ready' });
      const second = await composition.manager.ensure({ requestId: 'ensure-2' });
      expect(second).toMatchObject({ outcome: 'applied', state: 'ready' });
      const compatibleSourceClient = createManagedSingleServiceNativeComposition({
        home: createKiteHomeIdentity(homeRoot),
        runtimeParent,
        expectedBuildId: 'dev:single-child-build-2',
        staticAssetRoot: staticRoot,
        executable: {
          path: resolve(import.meta.dir, '../../scripts/release/entrypoints/service.ts'),
          mode: 'source',
          buildId: 'dev:single-child-build-2',
        },
        cwd: neutral,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: osHome,
          KITE_CODE_HOME: homeRoot,
          KITE_SERVICE_BUILD_ID: 'dev:single-child-build-2',
          KITE_SINGLE_SERVICE_RUNTIME_PARENT: runtimeParent,
          NODE_ENV: 'production',
        },
        startupTimeoutMs: 2_000,
        stopTimeoutMs: 2_000,
        childStderr: 'inherit',
      });
      expect(
        await compatibleSourceClient.manager.ensure({ requestId: 'ensure-compatible-source' }),
      ).toMatchObject({ outcome: 'applied', state: 'ready' });
      expect(await compatibleSourceClient.client.describe()).toMatchObject({
        outcome: 'ready',
        service: { buildId },
      });
      expect(await composition.client.describe()).toMatchObject({
        outcome: 'ready',
        service: { buildId },
      });
      const connection = await composition.connector.connect({
        workspace,
        clientInfo: { name: 'real-child-test', version: '1', instanceId: 'real-child-client' },
      });
      try {
        const queried = await connection.app.queryWorkspaceTrust({
          schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
          workspace,
        });
        expect(queried.status).toBe('unknown');
        expect(
          await connection.app.decideWorkspaceTrust({
            schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
            workspace: queried.workspace,
            observedStatus: queried.status,
            expectedRevision: queried.revision,
            decision: 'trust',
            externalReadScopeDigest: queried.externalReadScope.digest,
          }),
        ).toMatchObject({ outcome: 'recorded' });
        expect(await createKiteServiceModeSession(connection, 'real-child-session')).toMatchObject({
          sessionRevision: 0,
          lease: {
            sessionId: 'real-child-session',
            clientId: 'real-child-client',
            controllerGeneration: 1,
          },
        });
        const database = new Database(join(homeRoot, 'kite.sqlite'), {
          readonly: true,
          strict: true,
        });
        try {
          expect(
            database
              .query<{ count: number }, []>(
                "SELECT count(*) AS count FROM runtime_sessions WHERE session_id = 'real-child-session'",
              )
              .get()?.count,
          ).toBe(1);
          expect(
            database
              .query<{ count: number }, []>(
                "SELECT count(*) AS count FROM kite_meta WHERE key LIKE 'workspace_authority/%real-child-session%'",
              )
              .get()?.count,
          ).toBe(3);
        } finally {
          database.close();
        }
        await connection.connect();
        const previousServiceInstanceId = connection.service.instanceId;
        expect(await composition.manager.stop({ requestId: 'restart-stop' })).toMatchObject({
          outcome: 'applied',
          state: 'absent',
        });
        await connection.reconnect();
        expect(connection.service.instanceId).not.toBe(previousServiceInstanceId);
        expect(
          await acquireKiteServiceModeController(connection, 'real-child-session'),
        ).toMatchObject({
          sessionId: 'real-child-session',
          clientId: 'real-child-client',
          connectionGeneration: 2,
          controllerGeneration: 1,
          workerInstanceId: connection.service.instanceId,
        });
      } finally {
        await connection.close('real_child_test_complete');
      }
      expect(readdirSync(homeRoot)).not.toContain('runtime-service');
      expect(readdirSync(homeRoot).filter((entry) => !isAllowedKiteHomeEntry(entry))).toEqual([]);
      expect(await composition.client.ensureWeb(staticRoot)).toMatchObject({
        outcome: 'unavailable',
        state: 'absent',
        diagnostic: 'web_assets_missing',
      });
      mkdirSync(join(staticRoot, 'api-docs'));
      mkdirSync(join(staticRoot, 'assets'));
      writeFileSync(join(staticRoot, 'index.html'), '<html></html>');
      writeFileSync(join(staticRoot, 'api-docs', 'openapi.json'), '{}');
      writeFileSync(join(staticRoot, 'assets', 'app.js'), 'export {};');
      const web = await composition.client.ensureWeb(staticRoot);
      expect(web).toMatchObject({ outcome: 'ready' });
      if (web.outcome !== 'ready') throw new Error('Web target did not become ready.');
      expect(await composition.client.ensureWeb(staticRoot)).toMatchObject({
        outcome: 'ready',
        origin: web.origin,
      });
      expect(await composition.client.stopWeb()).toMatchObject({
        outcome: 'applied',
        state: 'absent',
      });
      expect(await composition.client.describe()).toMatchObject({ outcome: 'ready' });
      if (composition.endpoint.kind !== 'unix') throw new Error('Expected Unix endpoint.');
      expect(readdirSync(composition.endpoint.root).sort()).toEqual([
        'service.lock',
        'service.sock',
      ]);
      expect(
        readdirSync(join(runtimeParent, 'kite-code', 'v1')).filter(
          (entry) => entry !== composition.endpoint.homeDigest,
        ),
      ).toEqual([]);

      const stopped = await composition.manager.stop({ requestId: 'stop-1' });
      expect(stopped).toMatchObject({ outcome: 'applied', state: 'absent' });
    } finally {
      await composition.manager.stop({ requestId: 'cleanup' }).catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function isAllowedKiteHomeEntry(entry: string): boolean {
  return (
    entry === 'kite-code.jsonc' ||
    entry === 'mcp.json' ||
    entry === 'mcp-project-approvals.jsonc' ||
    entry === 'workspace-trust.jsonc' ||
    entry === 'skills' ||
    entry === 'sessions' ||
    entry === 'kite.sqlite' ||
    entry === 'kite.sqlite-wal' ||
    entry === 'kite.sqlite-shm'
  );
}
