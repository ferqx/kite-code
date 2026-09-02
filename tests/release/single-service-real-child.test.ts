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
import {
  KiteLocalNativeConnectionError,
  requestKiteLocalNativeEndpoint,
} from '@kite-ai/kite-local-runtime/client';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  acquireKiteServiceModeController,
  createKiteServiceModeSession,
} from '../../apps/kite-cli/src/service-mode';
import {
  createManagedSingleServiceNativeComposition,
  type ManagedSingleServiceNativeConnection,
} from '../../scripts/release/single-service-native-client';

describe('single-Service real child target', () => {
  test('replaces a compatible installed legacy Service build without owning Web', async () => {
    if (process.platform === 'win32') return;
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-installed-upgrade-')));
    const homeRoot = join(root, 'kite-home');
    const runtimeParent = join(root, 'runtime');
    const osHome = join(root, 'os-home');
    const neutral = join(root, 'neutral');
    const workspace = join(root, 'workspace');
    const model = createGatedModelServer();
    for (const directory of [homeRoot, runtimeParent, osHome, neutral, workspace]) {
      mkdirSync(directory, { mode: 0o700 });
      chmodSync(directory, 0o700);
    }
    writeFileSync(
      join(homeRoot, 'kite-code.jsonc'),
      JSON.stringify({
        provider: {
          fixture: {
            type: 'openai-compatible',
            apiKey: 'busy-upgrade-test-key',
            baseURL: model.baseURL,
            model: 'mock-model',
          },
        },
        model: { default: { provider: 'fixture', name: 'mock-model' } },
        sandbox: { enabled: false },
        interactionMode: 'auto',
      }),
    );
    const serviceEntrypoint = resolve(
      import.meta.dir,
      '../../scripts/release/entrypoints/service.ts',
    );
    const oldBuildId = '1'.repeat(24);
    const currentBuildId = '2'.repeat(24);
    const nextBuildId = '3'.repeat(24);
    let droppedAcceptedStops = 0;
    let postDropStopRequests = 0;
    let observedPreviousBuildStopRequests = 0;
    const composition = (
      buildId: string,
      active: boolean,
      dropAcceptedStopForBuild?: string,
      observeStopForBuild?: string,
    ) =>
      createManagedSingleServiceNativeComposition({
        home: createKiteHomeIdentity(homeRoot),
        runtimeParent,
        expectedBuildId: buildId,
        executable: { path: serviceEntrypoint, mode: 'installed', buildId },
        cwd: neutral,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: osHome,
          KITE_CODE_HOME: homeRoot,
          KITE_SERVICE_BUILD_ID: buildId,
          KITE_SINGLE_SERVICE_RUNTIME_PARENT: runtimeParent,
          NODE_ENV: 'production',
        },
        ...(active ? { canReplaceInstalledBuild: () => true } : {}),
        ...(dropAcceptedStopForBuild === undefined && observeStopForBuild === undefined
          ? {}
          : {
              request: async (endpoint, request, options) => {
                if (
                  request.operation === 'service_stop' &&
                  request.expectedBuildId === observeStopForBuild
                ) {
                  observedPreviousBuildStopRequests += 1;
                }
                if (
                  droppedAcceptedStops > 0 &&
                  request.operation === 'service_stop' &&
                  request.expectedBuildId === dropAcceptedStopForBuild
                ) {
                  postDropStopRequests += 1;
                }
                const response = await requestKiteLocalNativeEndpoint(endpoint, request, options);
                if (
                  droppedAcceptedStops === 0 &&
                  request.operation === 'service_stop' &&
                  request.expectedBuildId === dropAcceptedStopForBuild &&
                  response.operation === 'service_stop' &&
                  response.outcome === 'applied'
                ) {
                  droppedAcceptedStops += 1;
                  throw new KiteLocalNativeConnectionError('invalid_response');
                }
                return response;
              },
            }),
        startupTimeoutMs: 20_000,
        stopTimeoutMs: active ? 100 : 20_000,
        childStderr: 'inherit',
      });
    const previous = composition(oldBuildId, false);
    const current = composition(currentBuildId, true, undefined, oldBuildId);
    const currentPeer = composition(currentBuildId, true, undefined, oldBuildId);
    const next = composition(nextBuildId, true, currentBuildId);
    let previousTui: Awaited<ReturnType<typeof previous.connector.connect>> | undefined;
    let secondaryTui: Awaited<ReturnType<typeof previous.connector.connect>> | undefined;
    try {
      expect(await previous.manager.ensure({ executableMode: 'installed' })).toMatchObject({
        outcome: 'applied',
        state: 'ready',
      });
      const previousIdentity = await previous.client.describe();
      expect(previousIdentity.service.buildId).toBe(oldBuildId);
      previousTui = await previous.connector.connect({
        workspace,
        clientInfo: {
          name: 'previous-tui',
          version: '0.1.0',
          instanceId: 'previous-tui-client',
        },
      });
      const trust = await previousTui.app.queryWorkspaceTrust({
        schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
        workspace,
      });
      expect(
        await previousTui.app.decideWorkspaceTrust({
          schema: WORKSPACE_TRUST_DECISION_REQUEST_SCHEMA_,
          workspace: trust.workspace,
          observedStatus: trust.status,
          expectedRevision: trust.revision,
          decision: 'trust',
          externalReadScopeDigest: trust.externalReadScope.digest,
        }),
      ).toMatchObject({ outcome: 'recorded' });
      await previousTui.connect();
      const previousGeneration = previousTui.generation;
      secondaryTui = await previous.connector.connect({
        workspace,
        clientInfo: {
          name: 'secondary-previous-tui',
          version: '0.1.0',
          instanceId: 'secondary-previous-tui-client',
        },
      });
      await secondaryTui.connect();
      const secondaryGeneration = secondaryTui.generation;

      const busySession = await createKiteServiceModeSession(previousTui, 'busy-upgrade-session');
      await expect(
        previousTui.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: 'busy-upgrade-start-turn',
          type: 'start_turn',
          sessionId: 'busy-upgrade-session',
          expectedRevision: busySession.sessionRevision,
          input: 'hold this turn while the active candidate attempts an upgrade',
        }),
      ).resolves.toMatchObject({ status: 'applied' });
      await model.waitForRequest();

      expect(await current.manager.ensure({ executableMode: 'installed' })).toMatchObject({
        outcome: 'service_busy',
        state: 'ready',
        diagnostic: 'service_busy',
      });
      expect(await previous.client.describe()).toMatchObject({
        service: {
          buildId: oldBuildId,
          instanceId: previousIdentity.service.instanceId,
        },
      });
      expect(await current.manager.ensure({ executableMode: 'installed' })).toMatchObject({
        outcome: 'service_busy',
        state: 'ready',
        diagnostic: 'service_busy',
      });
      await expect(
        secondaryTui.runtime.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_session_projection',
          sessionId: 'busy-upgrade-session',
        }),
      ).resolves.toMatchObject({
        status: 'ok',
        queryType: 'get_session_projection',
        session: { activeWork: { status: 'running' } },
      });
      await expect(
        createKiteServiceModeSession(secondaryTui, 'post-busy-admission-session'),
      ).resolves.toMatchObject({
        lease: { sessionId: 'post-busy-admission-session' },
      });

      model.releaseResponse();
      await waitForSessionIdle(previousTui, 'busy-upgrade-session');

      observedPreviousBuildStopRequests = 0;
      const [currentEnsure, peerEnsure] = await Promise.all([
        current.manager.ensure({ executableMode: 'installed' }),
        currentPeer.manager.ensure({ executableMode: 'installed' }),
      ]);
      expect(currentEnsure).toMatchObject({ outcome: 'applied', state: 'ready' });
      expect(peerEnsure).toMatchObject({ outcome: 'applied', state: 'ready' });
      expect(observedPreviousBuildStopRequests).toBe(2);
      const currentIdentity = await current.client.describe();
      expect(await currentPeer.client.describe()).toMatchObject({
        service: { instanceId: currentIdentity.service.instanceId },
      });
      expect(currentIdentity.service).toMatchObject({ buildId: currentBuildId });
      expect(currentIdentity.service.instanceId).not.toBe(previousIdentity.service.instanceId);
      expect(
        await fetch(`${currentIdentity.service.httpOrigin}/`).then((response) => response.status),
      ).toBe(404);

      await Promise.all([previousTui.reconnect(), secondaryTui.reconnect()]);
      expect(previousTui.generation).toBeGreaterThan(previousGeneration);
      expect(previousTui.service).toMatchObject({
        buildId: currentBuildId,
        instanceId: currentIdentity.service.instanceId,
      });
      expect(secondaryTui.generation).toBeGreaterThan(secondaryGeneration);
      expect(secondaryTui.service).toMatchObject({
        buildId: currentBuildId,
        instanceId: currentIdentity.service.instanceId,
      });

      const approvalSession = await createKiteServiceModeSession(
        previousTui,
        'approval-upgrade-session',
      );
      await expect(
        previousTui.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: 'approval-upgrade-start-turn',
          type: 'start_turn',
          sessionId: 'approval-upgrade-session',
          expectedRevision: approvalSession.sessionRevision,
          input: 'request a shell operation that must wait for approval',
        }),
      ).resolves.toMatchObject({ status: 'applied' });
      await model.waitForRequestCount(2);
      await waitForSessionWaiting(previousTui, 'approval-upgrade-session');

      expect(await next.manager.ensure({ executableMode: 'installed' })).toMatchObject({
        outcome: 'service_busy',
        state: 'ready',
        diagnostic: 'service_busy',
      });
      expect(await current.client.describe()).toMatchObject({
        service: {
          buildId: currentBuildId,
          instanceId: currentIdentity.service.instanceId,
        },
      });

      await cancelActiveSession(previousTui, 'approval-upgrade-session');
      await waitForSessionIdle(previousTui, 'approval-upgrade-session');
      expect(await next.manager.ensure({ executableMode: 'installed' })).toMatchObject({
        outcome: 'applied',
        state: 'ready',
      });
      expect(droppedAcceptedStops).toBe(1);
      expect(postDropStopRequests).toBe(0);
      const nextIdentity = await next.client.describe();
      expect(nextIdentity.service).toMatchObject({ buildId: nextBuildId });
      await Promise.all([previousTui.reconnect(), secondaryTui.reconnect()]);
      expect(previousTui.service.instanceId).toBe(nextIdentity.service.instanceId);
      expect(secondaryTui.service.instanceId).toBe(nextIdentity.service.instanceId);
    } finally {
      await previousTui?.close('previous_tui_upgrade_test_complete').catch(() => undefined);
      await secondaryTui?.close('secondary_tui_upgrade_test_complete').catch(() => undefined);
      await next.manager.stop({ executableMode: 'installed' }).catch(() => undefined);
      await currentPeer.manager.stop({ executableMode: 'installed' }).catch(() => undefined);
      await current.manager.stop({ executableMode: 'installed' }).catch(() => undefined);
      await previous.manager.stop({ executableMode: 'installed' }).catch(() => undefined);
      model.stop();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test('ensures, reuses and stops one native endpoint without Kite Home process state', async () => {
    if (process.platform === 'win32') return;
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-single-child-')));
    const homeRoot = join(root, 'kite-home');
    const runtimeParent = join(root, 'runtime');
    const osHome = join(root, 'os-home');
    const neutral = join(root, 'neutral');
    const workspace = join(root, 'workspace');
    for (const directory of [homeRoot, runtimeParent, osHome, neutral, workspace]) {
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
    const buildId = 'single-child-build-1';
    const composition = createManagedSingleServiceNativeComposition({
      home: createKiteHomeIdentity(homeRoot),
      runtimeParent,
      expectedBuildId: buildId,
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
        const createdSession = await createKiteServiceModeSession(connection, 'real-child-session');
        expect(createdSession).toMatchObject({
          sessionRevision: 0,
          lease: {
            sessionId: 'real-child-session',
            clientId: 'real-child-client',
            controllerGeneration: 1,
          },
        });
        const controlledCommand = connection.runtime.command({
          schema: 'kite.runtime-command.v1',
          commandId: 'real-child-set-mode',
          type: 'set_interaction_mode',
          sessionId: 'real-child-session',
          expectedRevision: createdSession.sessionRevision,
          mode: 'full',
        });
        const controlledReceipt = await controlledCommand;
        expect(controlledReceipt).toMatchObject({ status: 'applied' });
        const controlledRevision =
          controlledReceipt.status === 'applied'
            ? controlledReceipt.revision
            : controlledReceipt.status === 'idempotent_replay'
              ? controlledReceipt.originalRevision
              : -1;
        await expect(
          connection.runtime.command({
            schema: 'kite.runtime-command.v1',
            commandId: 'real-child-start-turn',
            type: 'start_turn',
            sessionId: 'real-child-session',
            expectedRevision: controlledRevision,
            input: 'real child command admission',
          }),
        ).resolves.toMatchObject({ status: 'applied' });
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
        await cancelActiveSession(connection, 'real-child-session');
        await waitForSessionIdle(connection, 'real-child-session');
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
      const described = await composition.client.describe();
      expect(described).toMatchObject({ outcome: 'ready' });
      expect(
        await fetch(`${described.service.httpOrigin}/`).then((response) => response.status),
      ).toBe(404);
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

      await composition.dispose();
      await expect(composition.client.describe()).rejects.toBeInstanceOf(
        KiteLocalNativeConnectionError,
      );
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

function createGatedModelServer() {
  let release!: () => void;
  let notifyRequest!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requestObserved = new Promise<void>((resolve) => {
    notifyRequest = resolve;
  });
  let requestCount = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [{ id: 'mock-model', object: 'model' }] });
      }
      if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        return new Response('Not Found', { status: 404 });
      }
      const body = (await request.json()) as { readonly stream?: boolean };
      requestCount += 1;
      notifyRequest();
      if (requestCount === 1) await responseGate;
      const toolCall =
        requestCount === 1
          ? undefined
          : {
              id: 'approval-upgrade-shell',
              type: 'function' as const,
              function: {
                name: 'shell_execute',
                arguments: JSON.stringify({ command: 'bun test' }),
              },
            };
      if (body.stream === true) {
        const delta = toolCall
          ? { role: 'assistant', tool_calls: [{ index: 0, ...toolCall }] }
          : { content: 'done' };
        return new Response(
          [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
            'data: [DONE]\n\n',
          ].join(''),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      return Response.json({
        choices: [
          {
            index: 0,
            message: toolCall
              ? { role: 'assistant', content: null, tool_calls: [toolCall] }
              : { role: 'assistant', content: 'done' },
          },
        ],
      });
    },
  });
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    waitForRequest: () => requestObserved,
    async waitForRequestCount(expected: number) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (requestCount >= expected) return;
        await Bun.sleep(10);
      }
      throw new Error(`Gated model observed ${requestCount}/${expected} requests.`);
    },
    releaseResponse: () => release(),
    stop: () => server.stop(true),
  };
}

async function waitForSessionIdle(
  connection: ManagedSingleServiceNativeConnection,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (
      result.status === 'ok' &&
      result.queryType === 'get_session_projection' &&
      (!result.session?.activeWork ||
        !['queued', 'running', 'waiting'].includes(result.session.activeWork.status))
    ) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error('Busy-upgrade fixture did not return to idle.');
}

async function waitForSessionWaiting(
  connection: ManagedSingleServiceNativeConnection,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await connection.runtime.query({
      schema: 'kite.runtime-query.v1',
      type: 'get_session_projection',
      sessionId,
    });
    if (
      result.status === 'ok' &&
      result.queryType === 'get_session_projection' &&
      result.session?.activeWork?.status === 'waiting' &&
      result.session.interactionQueue.interactions.length > 0
    ) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error('Approval-upgrade fixture did not enter waiting interaction.');
}

async function cancelActiveSession(
  connection: ManagedSingleServiceNativeConnection,
  sessionId: string,
): Promise<void> {
  const result = await connection.runtime.query({
    schema: 'kite.runtime-query.v1',
    type: 'get_session_projection',
    sessionId,
  });
  if (
    result.status !== 'ok' ||
    result.queryType !== 'get_session_projection' ||
    !result.session?.activeWork ||
    !['queued', 'running', 'waiting'].includes(result.session.activeWork.status) ||
    !result.session.activeWork.activeTurn
  ) {
    return;
  }
  await connection.runtime.command({
    schema: 'kite.runtime-command.v1',
    commandId: `cancel-${sessionId}`,
    type: 'cancel_turn',
    sessionId,
    expectedRevision: result.session.revision,
    turnId: result.session.activeWork.activeTurn.turnId,
  });
}
