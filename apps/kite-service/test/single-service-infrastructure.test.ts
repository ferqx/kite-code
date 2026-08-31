import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import { requestKiteLocalNativeEndpoint } from '@kite-ai/kite-local-runtime/client';
import {
  createKiteHomeIdentity,
  KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
  KITE_LOCAL_NATIVE_REQUEST_SCHEMA_,
  type KiteLocalNativeRequest,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  readKiteLocalRuntimeLifecycleReservation,
} from '@kite-ai/kite-local-runtime/service';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import { RuntimeServer } from '@kite-ai/runtime-server';
import {
  type AgentApiReadContext,
  createAgentApiRouteHandler,
  createSingleServiceInfrastructure,
  type NativeKiteServiceApplicationPort,
  type SingleServiceInfrastructure,
} from '../src';

const BUILD_ID = 'dev:single-service-build-1';
const roots: string[] = [];
const owners: SingleServiceInfrastructure[] = [];

const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/tmp/kite-single-service-workspace',
  projectId: 'project-single-service',
  workspaceDigest: `sha256:${'1'.repeat(64)}`,
};

afterEach(async () => {
  await Promise.allSettled(owners.splice(0).map((owner) => owner[Symbol.asyncDispose]()));
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Single-Service native infrastructure target', () => {
  test.skipIf(process.platform === 'win32')(
    'keeps discovery credentials in memory and Web on the same HTTP listener',
    async () => {
      const fixtureRoot = makeRoot();
      const homeRoot = join(fixtureRoot, 'home');
      const runtimeParent = join(fixtureRoot, 'runtime');
      const assets = makeWebAssets(fixtureRoot);
      mkdirSync(homeRoot);
      const owner = createTarget(
        homeRoot,
        runtimeParent,
        'single-service-instance',
        undefined,
        assets,
      );
      owners.push(owner);

      await expect(owner.start()).resolves.toMatchObject({
        outcome: 'applied',
        state: 'ready',
      });
      expect(readdirSync(homeRoot)).toEqual([]);
      if (owner.endpoint.kind !== 'unix') throw new Error('expected Unix endpoint');
      expect(readdirSync(owner.endpoint.root).sort()).toEqual(['service.lock', 'service.sock']);
      expect(readKiteLocalRuntimeLifecycleReservation(owner.endpoint)).toMatchObject({
        pid: process.pid,
        processStartIdentity: 'test-process-single-service-instance',
        instanceId: 'single-service-instance',
        buildId: BUILD_ID,
        socketDevice: expect.any(Number),
        socketInode: expect.any(Number),
      });

      const described = await requestKiteLocalNativeEndpoint(
        owner.endpoint,
        request('describe', 'describe-1'),
      );
      expect(described).toMatchObject({
        operation: 'describe',
        outcome: 'ready',
        service: {
          instanceId: 'single-service-instance',
          buildId: BUILD_ID,
          httpOrigin: owner.httpOrigin,
        },
        accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      });
      expect(JSON.stringify(described)).not.toContain(homeRoot);

      const ownerOrigin = owner.httpOrigin;
      if (!ownerOrigin) throw new Error('Service HTTP origin is unavailable');
      const root = await fetch(`${ownerOrigin}/`);
      expect(root.status).toBe(200);
      expect(root.headers.get('set-cookie')).toContain('HttpOnly');
      expect(await root.text()).toBe('<html>single service target</html>');
      const rootCookie = root.headers.get('set-cookie')?.split(';', 1)[0];
      if (!rootCookie) throw new Error('Service root omitted its Browser session.');
      expect(
        await fetch(`${ownerOrigin}/v1/workspaces`, {
          headers: {
            origin: ownerOrigin,
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            cookie: rootCookie,
          },
        }).then((response) => response.status),
      ).toBe(200);
      expect(await fetch(`${ownerOrigin}/index.html`).then((response) => response.text())).toBe(
        '<html>single service target</html>',
      );
      const browserHeaders = {
        origin: ownerOrigin,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
      };
      const workspaces = await fetch(`${ownerOrigin}/v1/workspaces`, {
        headers: { ...browserHeaders, cookie: rootCookie, accept: 'application/json' },
      });
      expect(workspaces.status).toBe(200);
      expect(await workspaces.json()).toEqual({
        schema: 'kite.agent-api.workspace-page.v1',
        items: [],
      });
      expect((await fetch(`${ownerOrigin}/_kite/web/bootstrap`)).status).toBe(404);

      const incompatible = await requestKiteLocalNativeEndpoint(owner.endpoint, {
        ...request('describe', 'wrong-build'),
        expectedBuildId: 'different-build',
      });
      expect(incompatible).toEqual({
        schema: 'kite.local-native.response.v1',
        requestId: 'wrong-build',
        operation: 'rejected',
        outcome: 'rejected',
        diagnostic: 'incompatible',
      });

      expect(await fetch(`${owner.httpOrigin}/`).then((response) => response.status)).toBe(200);
      expect(await fetch(`${owner.httpOrigin}/readyz`).then((response) => response.text())).toBe(
        'ready',
      );

      const stoppedService = await requestKiteLocalNativeEndpoint(
        owner.endpoint,
        request('service_stop', 'service-stop'),
      );
      expect(stoppedService).toMatchObject({
        operation: 'service_stop',
        outcome: 'applied',
        state: 'draining',
      });
      await expect(owner.shell.waitForShutdown()).resolves.toMatchObject({
        outcome: 'applied',
        state: 'absent',
      });
      expect(readdirSync(homeRoot)).toEqual([]);
      expect(() =>
        readdirSync(owner.endpoint.kind === 'unix' ? owner.endpoint.root : ''),
      ).toThrow();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'does not replace an existing per-home native lifecycle owner',
    async () => {
      const fixtureRoot = makeRoot();
      const homeRoot = join(fixtureRoot, 'home');
      const runtimeParent = join(fixtureRoot, 'runtime');
      mkdirSync(homeRoot);
      let firstReserved = 0;
      let duplicateReserved = 0;
      const first = createTarget(homeRoot, runtimeParent, 'single-service-instance', () => {
        firstReserved += 1;
      });
      const duplicate = createTarget(homeRoot, runtimeParent, 'duplicate-instance', () => {
        duplicateReserved += 1;
      });
      owners.push(first, duplicate);
      await first.start();
      await expect(duplicate.start()).rejects.toBeDefined();
      expect(firstReserved).toBe(1);
      expect(duplicateReserved).toBe(0);

      const described = await requestKiteLocalNativeEndpoint(
        first.endpoint,
        request('describe', 'still-first'),
      );
      expect(described).toMatchObject({
        operation: 'describe',
        outcome: 'ready',
        service: { instanceId: 'single-service-instance' },
      });
    },
  );
});

function createTarget(
  homeRoot: string,
  runtimeParent: string,
  instanceId = 'single-service-instance',
  onEndpointReserved?: () => void,
  staticAssetRoot = makeWebAssets(join(homeRoot, '..')),
): SingleServiceInfrastructure {
  const browserReadContext: AgentApiReadContext = {
    query: async (query) => ({
      status: 'not_found',
      queryType: query.type,
      code: 'session_not_found',
    }),
    history: {
      listSessions: async () => ({ entries: [], hasMore: false }),
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
    },
    checkpoints: { list: () => ({ entries: [], hasMore: false }), get: () => undefined },
    directory: { list: () => [] },
    close: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
  const agentApi = createAgentApiRouteHandler({
    serverVersion: 'single-service-test',
    buildId: BUILD_ID,
    consumeCapability: () => undefined,
    admitWorkspace: async () => 'unavailable',
    isClientGenerationCurrent: () => false,
    browserReadContext,
    browserCapabilities: ['checkpoints', 'history', 'sessions', 'workspaces'],
  });
  return createSingleServiceInfrastructure({
    home: createKiteHomeIdentity(homeRoot),
    runtimeParent,
    application: createApplication(),
    instanceId,
    serverVersion: 'single-service-test',
    buildId: BUILD_ID,
    processStartIdentity: `test-process-${instanceId}`,
    ...(onEndpointReserved ? { onEndpointReserved } : {}),
    webGateway: { staticAssetRoot },
    agentApi,
    carrierLimits: {
      heartbeatIntervalMs: 50,
      heartbeatDeadlineMs: 150,
      drainDeadlineMs: 50,
    },
  });
}

function request(
  operation: KiteLocalNativeRequest['operation'],
  requestId: string,
): KiteLocalNativeRequest {
  return {
    schema: KITE_LOCAL_NATIVE_REQUEST_SCHEMA_,
    requestId,
    operation,
    protocolVersion: KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    expectedBuildId: BUILD_ID,
  } as KiteLocalNativeRequest;
}

function makeRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-single-service-target-')));
  roots.push(root);
  return root;
}

function makeWebAssets(root: string): string {
  const assets = join(root, 'web');
  mkdirSync(join(assets, 'api-docs'), { recursive: true });
  mkdirSync(join(assets, 'assets'), { recursive: true });
  writeFileSync(join(assets, 'index.html'), '<html>single service target</html>');
  writeFileSync(join(assets, 'api-docs', 'openapi.json'), '{}');
  writeFileSync(join(assets, 'assets', 'app.js'), 'export {};');
  return assets;
}

function createApplication(): NativeKiteServiceApplicationPort {
  const runtime: RuntimeAccess = {
    command: async (command) => ({
      status: 'applied',
      commandId: command.commandId,
      sessionId: 'session-target',
      revision: 1,
    }),
    query: async (query) => ({
      status: 'ok',
      queryType: query.type,
      sessions: [],
    }),
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => await new Promise<IteratorResult<never>>(() => undefined),
      }),
    }),
  };
  const server = new RuntimeServer(
    {
      runtime,
      admission: {
        authorize: async () => ({
          allowed: true,
          workspace: workspace.canonicalPath,
        }),
      },
    },
    {
      serverInfo: {
        version: 'single-service-test',
        instanceId: 'runtime-target',
      },
    },
  );
  const unavailable = async (): Promise<never> => {
    throw new Error('not used by target infrastructure test');
  };
  const appControl: KiteAppControlClient = {
    queryWorkspaceTrust: unavailable,
    decideWorkspaceTrust: unavailable,
    getProviderModelSnapshot: unavailable,
    selectProviderModel: unavailable,
    getMcpSnapshot: unavailable,
    applyMcpAction: unavailable,
    getSkillCatalog: unavailable,
    getExecutionStatus: unavailable,
    getReleaseStatus: unavailable,
  };
  return {
    server,
    history: {
      listSessions: async () => ({ entries: [], hasMore: false }),
      listEvents: async () => ({
        entries: [],
        hasMore: false,
        observedLastSequence: 0,
      }),
      loadSession: unavailable,
    },
    workspaceAdmission: {
      admitForConnect: async () => ({ outcome: 'admitted', workspace }),
      resolveIdentity: async () => workspace,
    },
    runtimeAdmission: {
      create: () => ({
        authorize: async () => ({
          allowed: true,
          workspace: workspace.canonicalPath,
        }),
      }),
    },
    appControl: { discovery: appControl, forWorkspace: () => appControl },
    start: async () => undefined,
    quiesceMutations: async () => ({
      activeOperations: false,
      resume: () => undefined,
      commitDrain: async () => undefined,
    }),
    cancelAll: async () => undefined,
    [Symbol.asyncDispose]: async () => undefined,
  };
}
