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
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import {
  acquireKiteServiceModeController,
  createKiteServiceModeSession,
  releaseKiteServiceModeController,
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
    let modelRequests = 0;
    const modelServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'GET' && url.pathname === '/v1/models') {
          return Response.json({ data: [{ id: 'fixture-model', object: 'model' }] });
        }
        if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
          modelRequests += 1;
          return new Response(modelStream('OK'), {
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response('Not Found', { status: 404 });
      },
    });
    writeFileSync(
      join(homeRoot, 'kite-code.jsonc'),
      JSON.stringify({
        provider: {
          fixture: {
            type: 'openai-compatible',
            apiKey: 'real-child-test-key',
            baseURL: `http://127.0.0.1:${modelServer.port}/v1`,
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
        // The production TUI connects before it creates its first Session. The
        // Runtime socket must authorize later mutations from current Store
        // Controller state, not from a Controller header snapshot captured at
        // WebSocket open.
        await connection.connect();
        expect(await createKiteServiceModeSession(connection, 'real-child-session')).toMatchObject({
          sessionRevision: 0,
          lease: {
            sessionId: 'real-child-session',
            clientId: 'real-child-client',
            controllerGeneration: 1,
          },
        });
        expect(
          await connection.runtime.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'real-child-first-mutation',
            type: 'set_interaction_mode',
            sessionId: 'real-child-session',
            expectedRevision: 0,
            mode: 'accept_edits',
          }),
        ).toMatchObject({ status: 'applied', revision: 1 });

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

        expect(
          await createKiteServiceModeSession(connection, 'real-child-second-session'),
        ).toMatchObject({
          sessionRevision: 0,
          lease: {
            sessionId: 'real-child-second-session',
            clientId: 'real-child-client',
            controllerGeneration: 1,
          },
        });
        expect(
          await connection.runtime.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'real-child-first-session-after-switch',
            type: 'set_interaction_mode',
            sessionId: 'real-child-session',
            expectedRevision: 1,
            mode: 'auto',
          }),
        ).toMatchObject({ status: 'applied', revision: 2 });
        expect(
          await connection.runtime.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'real-child-second-session-mutation',
            type: 'set_interaction_mode',
            sessionId: 'real-child-second-session',
            expectedRevision: 0,
            mode: 'full',
          }),
        ).toMatchObject({ status: 'applied', revision: 1 });

        const originalSecondLease = await acquireKiteServiceModeController(
          connection,
          'real-child-second-session',
        );
        await releaseKiteServiceModeController(connection, originalSecondLease);
        const generationConnection = await composition.connector.connect({
          workspace,
          clientInfo: {
            name: 'real-child-generation-test',
            version: '1',
            instanceId: 'real-child-generation-client',
          },
        });
        try {
          const firstGeneration = await acquireKiteServiceModeController(
            generationConnection,
            'real-child-second-session',
          );
          await generationConnection.connect();
          await releaseKiteServiceModeController(generationConnection, firstGeneration);
          const nextGeneration = await acquireKiteServiceModeController(
            generationConnection,
            'real-child-second-session',
          );
          expect(nextGeneration.controllerGeneration).toBeGreaterThan(
            firstGeneration.controllerGeneration,
          );
          await expect(
            generationConnection.runtime.command({
              schema: RUNTIME_COMMAND_SCHEMA_,
              commandId: 'real-child-stale-controller-generation',
              type: 'set_interaction_mode',
              sessionId: 'real-child-second-session',
              expectedRevision: 1,
              mode: 'auto',
            }),
          ).rejects.toThrow('Unauthorized');
          await releaseKiteServiceModeController(generationConnection, nextGeneration);
        } finally {
          await generationConnection.close('real_child_generation_test_complete');
        }

        const foreignConnection = await composition.connector.connect({
          workspace,
          clientInfo: {
            name: 'real-child-foreign-test',
            version: '1',
            instanceId: 'real-child-foreign-client',
          },
        });
        try {
          await foreignConnection.connect();
          await expect(
            foreignConnection.runtime.command({
              schema: RUNTIME_COMMAND_SCHEMA_,
              commandId: 'real-child-foreign-mutation',
              type: 'set_interaction_mode',
              sessionId: 'real-child-session',
              expectedRevision: 2,
              mode: 'full',
            }),
          ).rejects.toThrow('Unauthorized');
        } finally {
          await foreignConnection.close('real_child_foreign_test_complete');
        }

        const turnSession = 'real-child-start-turn-session';
        expect(await createKiteServiceModeSession(connection, turnSession)).toMatchObject({
          sessionRevision: 0,
          lease: { sessionId: turnSession, clientId: 'real-child-client' },
        });
        expect(
          await connection.runtime.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            commandId: 'real-child-start-turn',
            type: 'start_turn',
            sessionId: turnSession,
            expectedRevision: 0,
            input: 'Reply OK',
          }),
        ).toMatchObject({ status: 'applied', revision: 2 });
        for (let attempt = 0; attempt < 200 && modelRequests === 0; attempt += 1) {
          await Bun.sleep(25);
        }
        expect(modelRequests).toBe(1);
        let turnIdle = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const projection = await connection.runtime.query({
            schema: RUNTIME_QUERY_SCHEMA_,
            type: 'get_session_projection',
            sessionId: turnSession,
          });
          if (
            projection.status === 'ok' &&
            projection.queryType === 'get_session_projection' &&
            projection.session &&
            (!projection.session.activeWork ||
              !['queued', 'running', 'waiting'].includes(projection.session.activeWork.status))
          ) {
            turnIdle = true;
            break;
          }
          await Bun.sleep(25);
        }
        expect(turnIdle).toBe(true);
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

      const previousInstalledBuild = '1'.repeat(24);
      const currentInstalledBuild = '2'.repeat(24);
      let previousInstalledIsActive = true;
      const previousInstalled = createManagedSingleServiceNativeComposition({
        home: createKiteHomeIdentity(homeRoot),
        runtimeParent,
        expectedBuildId: previousInstalledBuild,
        staticAssetRoot: staticRoot,
        executable: {
          path: resolve(import.meta.dir, '../../scripts/release/entrypoints/service.ts'),
          mode: 'installed',
          buildId: previousInstalledBuild,
        },
        cwd: neutral,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: osHome,
          KITE_CODE_HOME: homeRoot,
          KITE_SERVICE_BUILD_ID: previousInstalledBuild,
          KITE_SINGLE_SERVICE_RUNTIME_PARENT: runtimeParent,
          NODE_ENV: 'production',
        },
        startupTimeoutMs: 20_000,
        stopTimeoutMs: 20_000,
        childStderr: 'inherit',
        canReplaceInstalledBuild: () => previousInstalledIsActive,
      });
      try {
        expect(
          await previousInstalled.manager.ensure({
            requestId: 'installed-previous',
            executableMode: 'installed',
          }),
        ).toMatchObject({ outcome: 'applied', state: 'ready' });
        const previousIdentity = await previousInstalled.client.describe();
        const currentInstalled = createManagedSingleServiceNativeComposition({
          home: createKiteHomeIdentity(homeRoot),
          runtimeParent,
          expectedBuildId: currentInstalledBuild,
          staticAssetRoot: staticRoot,
          executable: {
            path: resolve(import.meta.dir, '../../scripts/release/entrypoints/service.ts'),
            mode: 'installed',
            buildId: currentInstalledBuild,
          },
          cwd: neutral,
          env: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: osHome,
            KITE_CODE_HOME: homeRoot,
            KITE_SERVICE_BUILD_ID: currentInstalledBuild,
            KITE_SINGLE_SERVICE_RUNTIME_PARENT: runtimeParent,
            NODE_ENV: 'production',
          },
          startupTimeoutMs: 20_000,
          stopTimeoutMs: 20_000,
          childStderr: 'inherit',
          canReplaceInstalledBuild: () => true,
        });
        try {
          expect(
            await currentInstalled.manager.ensure({
              requestId: 'installed-current',
              executableMode: 'installed',
            }),
          ).toMatchObject({ outcome: 'applied', state: 'ready' });
          expect(await currentInstalled.client.describe()).toMatchObject({
            outcome: 'ready',
            service: {
              buildId: currentInstalledBuild,
              instanceId: expect.not.stringMatching(previousIdentity.service.instanceId),
            },
          });
          previousInstalledIsActive = false;
          expect(
            await previousInstalled.manager.ensure({
              requestId: 'installed-stale-previous',
              executableMode: 'installed',
            }),
          ).toMatchObject({
            outcome: 'incompatible',
            state: 'ready',
            diagnostic: 'build_mismatch',
          });
          expect(await currentInstalled.client.describe()).toMatchObject({
            outcome: 'ready',
            service: { buildId: currentInstalledBuild },
          });
        } finally {
          await currentInstalled.manager
            .stop({ requestId: 'installed-current-cleanup' })
            .catch(() => undefined);
        }
      } finally {
        await previousInstalled.manager
          .stop({ requestId: 'installed-previous-cleanup' })
          .catch(() => undefined);
      }
    } finally {
      await composition.manager.stop({ requestId: 'cleanup' }).catch(() => undefined);
      modelServer.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

function modelStream(content: string): string {
  return [
    JSON.stringify({
      id: 'fixture-completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    }),
    JSON.stringify({
      id: 'fixture-completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'fixture-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    }),
  ]
    .map((frame) => `data: ${frame}\n\n`)
    .join('')
    .concat('data: [DONE]\n\n');
}

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
