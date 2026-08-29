import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  KiteAppControlClient,
  KiteWorkspaceIdentity,
  WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import {
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import {
  WORKER_CONTROLLER_PATH_,
  WORKER_CONTROLLER_RECEIPT_SCHEMA_,
  WORKER_CONTROLLER_REQUEST_SCHEMA_,
  WORKER_CONTROLLER_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract/worker-controller';
import {
  LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME,
  type LocalRuntimeFetch,
  type NativeRuntimeWebSocketFactory,
} from '@kite-ai/kite-local-runtime/client';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorRequestClient,
  type CoordinatorWorkerReference,
} from '@kite-ai/kite-local-runtime/coordinator';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import { RuntimeServer } from '@kite-ai/runtime-server';
import {
  createKiteServiceCarrier,
  KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
  KITE_SERVICE_CONNECT_PATH,
  KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH,
  KITE_SERVICE_INSTANCE_HANDSHAKE_PATH,
  type KiteServiceApplicationPort,
} from '../../apps/kite-service/src/carrier';
import {
  createWorkspaceWorkerCapabilityAuthority,
  KITE_WORKER_CLIENT_ID_HEADER,
  KITE_WORKER_CONNECTION_GENERATION_HEADER,
  KITE_WORKER_PURPOSE_HEADER,
} from '../../apps/kite-service/src/workspace-worker/control-carrier';
import { createManagedLocalWorkspaceWorkerConnector } from '../../scripts/release/local-workspace-worker-client';

const BUILD_ID = 'worker-release-build-v1';
const SERVER_VERSION = 'worker-release-test';
const CONTROL_TOKEN = 'C'.repeat(43);
const EXTERNAL_READ_SCOPE_DIGEST = `sha256:${'0'.repeat(64)}` as const;

interface WorkerFixture {
  readonly root: string;
  readonly workspace: KiteWorkspaceIdentity;
  readonly reference: CoordinatorWorkerReference;
  readonly authority: ReturnType<typeof createWorkspaceWorkerCapabilityAuthority>;
  readonly carrier: ReturnType<typeof createKiteServiceCarrier>;
  readonly coordinator: Pick<
    CoordinatorRequestClient,
    'ensureWorkspaceWorker' | 'mintWorkerConnectionCapability'
  >;
  readonly requests: Array<{
    readonly path: string;
    readonly headers: Headers;
  }>;
}

const fixtures: WorkerFixture[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.carrier.close()));
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function createFixture(options: { readonly handshakeInstanceId?: string } = {}): WorkerFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-release-worker-client-')));
  roots.push(root);
  const workspacePath = realpathSync(mkdtempSync(join(root, 'workspace-')));
  const workspace = makeWorkspace(workspacePath);
  const identity = {
    workerScopeId: 'workspace-worker-scope-release',
    workerInstanceId: 'worker-instance-release',
    buildId: BUILD_ID,
    workspace,
  } as const;
  const authority = createWorkspaceWorkerCapabilityAuthority({ identity });
  const requests: WorkerFixture['requests'] = [];
  const application = makeApplication(workspace);
  const carrier = createKiteServiceCarrier({
    application,
    instanceId: options.handshakeInstanceId ?? identity.workerInstanceId,
    serverVersion: SERVER_VERSION,
    buildId: BUILD_ID,
    accessToken: 'A'.repeat(43),
    controlToken: CONTROL_TOKEN,
    accessTokenVerifier: ({ token, request, pathname }) => {
      const clientId = request.headers.get(KITE_WORKER_CLIENT_ID_HEADER);
      const generation = request.headers.get(KITE_WORKER_CONNECTION_GENERATION_HEADER);
      const purpose = request.headers.get(KITE_WORKER_PURPOSE_HEADER);
      if (
        clientId === null ||
        generation === null ||
        !/^\d+$/u.test(generation) ||
        purpose !== 'native_client'
      ) {
        return false;
      }
      return authority.verifyConnectionCapability(
        {
          workerScopeId: identity.workerScopeId,
          workerInstanceId: identity.workerInstanceId,
          workspaceDigest: identity.workspace.workspaceDigest,
          clientId,
          connectionGeneration: Number(generation),
          purpose,
          secret: token,
        },
        { consume: pathname === KITE_SERVICE_CONNECT_PATH },
      );
    },
    connectionBindingForRequest: (request) => {
      const clientId = request.headers.get(KITE_WORKER_CLIENT_ID_HEADER);
      const generation = request.headers.get(KITE_WORKER_CONNECTION_GENERATION_HEADER);
      return clientId && generation && /^\d+$/u.test(generation)
        ? {
            clientId,
            connectionGeneration: Number(generation),
            workerInstanceId: identity.workerInstanceId,
          }
        : undefined;
    },
    connectionKindForRequest: (request) =>
      request.headers.get(KITE_WORKER_PURPOSE_HEADER) === 'native_client'
        ? 'native_client'
        : undefined,
  });
  const reference: CoordinatorWorkerReference = {
    identity: {
      role: 'worker',
      workerScopeId: identity.workerScopeId,
      instanceId: identity.workerInstanceId,
      buildId: identity.buildId,
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
      clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
    },
    workspace,
    endpoint: { origin: carrier.origin, websocketUrl: carrier.rpcUrl },
  };
  const coordinator = {
    async ensureWorkspaceWorker() {
      return {
        outcome: 'ok' as const,
        result: { worker: reference },
      } as Awaited<ReturnType<CoordinatorRequestClient['ensureWorkspaceWorker']>>;
    },
    async mintWorkerConnectionCapability(input: {
      readonly workspace: KiteWorkspaceIdentity;
      readonly workerScopeId: string;
      readonly clientId: string;
      readonly connectionGeneration: number;
      readonly purpose: 'native_client' | 'web_observer';
    }) {
      const minted = await authority.mintConnectionCapability({
        clientId: input.clientId,
        connectionGeneration: input.connectionGeneration,
        purpose: input.purpose,
      });
      if (minted.outcome !== 'applied') {
        return {
          outcome: 'error' as const,
          error: {
            code: 'outcome_unknown' as const,
            diagnostic: 'outcome_unknown' as const,
          },
        } as unknown as Awaited<
          ReturnType<CoordinatorRequestClient['mintWorkerConnectionCapability']>
        >;
      }
      return {
        outcome: 'ok' as const,
        result: {
          worker: reference,
          clientId: input.clientId,
          connectionGeneration: input.connectionGeneration,
          purpose: input.purpose,
          workerConnectionCapability: minted.capability,
          expiresAt: minted.expiresAt,
        },
      } as Awaited<ReturnType<CoordinatorRequestClient['mintWorkerConnectionCapability']>>;
    },
  } satisfies Pick<
    CoordinatorRequestClient,
    'ensureWorkspaceWorker' | 'mintWorkerConnectionCapability'
  >;
  const fixture = { root, workspace, reference, authority, carrier, coordinator, requests };
  fixtures.push(fixture);
  return fixture;
}

function makeWorkspace(path: string): KiteWorkspaceIdentity {
  const digest = createHash('sha256').update(path, 'utf8').digest('hex');
  return {
    canonicalPath: path,
    projectId: `project_${digest}`,
    workspaceDigest: `sha256:${digest}`,
  };
}

function makeApplication(workspace: KiteWorkspaceIdentity): KiteServiceApplicationPort {
  const runtime: RuntimeAccess = {
    async command(command) {
      return {
        status: 'applied',
        commandId: command.commandId,
        sessionId: 'release-worker-session',
        revision: 1,
      };
    },
    async query(query) {
      return { status: 'ok', queryType: query.type, sessions: [] };
    },
    subscribe() {
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => await new Promise<IteratorResult<never>>(() => undefined),
        }),
      };
    },
  };
  const server = new RuntimeServer(
    {
      runtime,
      admission: {
        async authorize() {
          return { allowed: true, workspace: workspace.canonicalPath };
        },
      },
    },
    { serverInfo: { version: SERVER_VERSION, instanceId: 'worker-instance-release' } },
  );
  const trust: WorkspaceTrustQueryResponse = {
    schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
    workspace,
    status: 'trusted',
    revision: 'trust-revision-1',
    canDecide: false,
    externalReadScope: { roots: [], digest: EXTERNAL_READ_SCOPE_DIGEST },
  };
  const appControl = {
    async queryWorkspaceTrust() {
      return trust;
    },
  } as unknown as KiteAppControlClient;
  const history = {
    async listSessions() {
      return { entries: [], hasMore: false };
    },
    async listEvents() {
      return { entries: [], hasMore: false, observedLastSequence: 0 };
    },
    async loadSession() {
      throw new Error('not used by this connector test');
    },
  } as KiteServiceApplicationPort['history'];
  return {
    server,
    history,
    workspaceAdmission: {
      async admitForConnect(requestedWorkspace) {
        return requestedWorkspace === workspace.canonicalPath
          ? { outcome: 'admitted' as const, workspace }
          : { outcome: 'untrusted' as const };
      },
      async resolveIdentity(candidate) {
        return sameWorkspace(candidate, workspace) ? workspace : undefined;
      },
    },
    runtimeAdmission: {
      create: () => ({
        async authorize() {
          return { allowed: true as const, workspace: workspace.canonicalPath };
        },
      }),
    },
    appControl: { discovery: appControl, forWorkspace: () => appControl },
    controller: {
      async createSession(request, binding) {
        return {
          schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
          operation: 'create_session',
          status: 'applied',
          sessionRevision: 1,
          receipt: {
            schema: WORKER_CONTROLLER_RECEIPT_SCHEMA_,
            sessionId: request.sessionId,
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            operation: 'request_control',
            status: 'applied',
            code: 'acquired',
            controllerGeneration: 1,
            connectionGeneration: binding.connectionGeneration,
            interactionGeneration: 0,
            clientId: binding.clientId,
            workerInstanceId: binding.workerInstanceId,
            completedAt: 1,
          },
          lease: {
            sessionId: request.sessionId,
            clientId: binding.clientId,
            connectionGeneration: binding.connectionGeneration,
            controllerGeneration: 1,
            workerInstanceId: binding.workerInstanceId,
            status: 'active',
          },
        };
      },
      async read() {
        throw new Error('unused');
      },
      async requestControl() {
        throw new Error('unused');
      },
      async releaseControl() {
        throw new Error('unused');
      },
      async detach() {
        throw new Error('unused');
      },
      async issueResumeCapability() {
        throw new Error('unused');
      },
      async resume() {
        throw new Error('unused');
      },
      async mintDetachedRecoveryCapability() {
        throw new Error('unused');
      },
      async abandonDetachedController() {
        throw new Error('unused');
      },
      async validateResumeCapability() {
        throw new Error('unused');
      },
    },
  };
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

describe('release Workspace Worker connector', () => {
  test('closes transient ensure, capability, and handshake recovery windows inside one connect', async () => {
    const fixture = createFixture();
    let ensureAttempts = 0;
    let mintAttempts = 0;
    let handshakeAttempts = 0;
    const coordinator = {
      ...fixture.coordinator,
      async ensureWorkspaceWorker(
        input: Parameters<CoordinatorRequestClient['ensureWorkspaceWorker']>[0],
      ) {
        ensureAttempts += 1;
        if (ensureAttempts === 1) {
          return {
            outcome: 'error' as const,
            error: { code: 'unavailable' as const, diagnostic: 'handler_rejected' as const },
          } as Awaited<ReturnType<CoordinatorRequestClient['ensureWorkspaceWorker']>>;
        }
        return fixture.coordinator.ensureWorkspaceWorker(input);
      },
      async mintWorkerConnectionCapability(
        input: Parameters<CoordinatorRequestClient['mintWorkerConnectionCapability']>[0],
      ) {
        mintAttempts += 1;
        if (mintAttempts === 1) {
          return {
            outcome: 'error' as const,
            error: { code: 'outcome_unknown' as const, diagnostic: 'handler_rejected' as const },
          } as Awaited<ReturnType<CoordinatorRequestClient['mintWorkerConnectionCapability']>>;
        }
        return fixture.coordinator.mintWorkerConnectionCapability(input);
      },
    };
    const actualFetch = fixtureFetch(fixture);
    const connector = createManagedLocalWorkspaceWorkerConnector({
      coordinatorClient: coordinator,
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.pathname === KITE_SERVICE_INSTANCE_HANDSHAKE_PATH) {
          handshakeAttempts += 1;
          if (handshakeAttempts === 1) return new Response('{}', { status: 503 });
        }
        return actualFetch(input, init);
      },
      clientInfo: { name: 'release-test', version: '1', instanceId: 'release-client-recovery' },
    });

    const connection = await connector.connect({ workspace: fixture.workspace.canonicalPath });
    try {
      expect(ensureAttempts).toBe(4);
      expect(mintAttempts).toBe(3);
      expect(handshakeAttempts).toBe(2);
      expect(connection.service.instanceId).toBe(fixture.reference.identity.instanceId);
    } finally {
      await connection.close();
    }
  });

  test('assigns a distinct default client identity to concurrent logical connections', async () => {
    const fixture = createFixture();
    const clientIds: string[] = [];
    const coordinator = {
      ...fixture.coordinator,
      async mintWorkerConnectionCapability(
        input: Parameters<CoordinatorRequestClient['mintWorkerConnectionCapability']>[0],
      ) {
        clientIds.push(input.clientId);
        return fixture.coordinator.mintWorkerConnectionCapability(input);
      },
    };
    const connector = createManagedLocalWorkspaceWorkerConnector({
      coordinatorClient: coordinator,
      fetch: fixtureFetch(fixture),
    });

    const [first, second] = await Promise.all([
      connector.connect({ workspace: fixture.workspace.canonicalPath }),
      connector.connect({ workspace: fixture.workspace.canonicalPath }),
    ]);
    try {
      expect(clientIds).toHaveLength(2);
      expect(new Set(clientIds).size).toBe(2);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  test('does not retry a non-recoverable Coordinator rejection', async () => {
    const fixture = createFixture();
    let ensureAttempts = 0;
    const coordinator = {
      ...fixture.coordinator,
      async ensureWorkspaceWorker() {
        ensureAttempts += 1;
        return {
          outcome: 'error' as const,
          error: {
            code: 'protocol_incompatible' as const,
            diagnostic: 'wrong_protocol' as const,
          },
        } as Awaited<ReturnType<CoordinatorRequestClient['ensureWorkspaceWorker']>>;
      },
    };
    const connector = createManagedLocalWorkspaceWorkerConnector({
      coordinatorClient: coordinator,
      fetch: fixtureFetch(fixture),
      clientInfo: { name: 'release-test', version: '1', instanceId: 'release-client-rejected' },
    });

    await expect(
      connector.connect({ workspace: fixture.workspace.canonicalPath }),
    ).rejects.toMatchObject({ code: 'service_unavailable' });
    expect(ensureAttempts).toBe(1);
  });

  test('canonicalizes, ensures, mints, handshakes, and prepares trust/history over closed bindings', async () => {
    const fixture = createFixture();
    const connector = createManagedLocalWorkspaceWorkerConnector({
      coordinatorClient: fixture.coordinator,
      fetch: fixtureFetch(fixture),
      clientInfo: { name: 'release-test', version: '1', instanceId: 'release-client-1' },
    });
    const connection = await connector.connect({ workspace: fixture.workspace.canonicalPath });
    try {
      const trust = await connection.app.queryWorkspaceTrust({
        schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
        workspace: fixture.workspace.canonicalPath,
      });
      const history = await connection.history.listSessions({ limit: 1 });
      expect(trust.workspace).toEqual(fixture.workspace);
      expect(trust.status).toBe('trusted');
      expect(history).toEqual({ entries: [], hasMore: false });
      expect(fixture.requests.map((request) => request.path)).toContain(
        KITE_SERVICE_INSTANCE_HANDSHAKE_PATH,
      );
      expect(fixture.requests.at(-1)?.path).toBe(KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH);
      for (const request of fixture.requests) {
        expect(request.headers.get(KITE_WORKER_CLIENT_ID_HEADER)).toBe('release-client-1');
        expect(request.headers.get(KITE_WORKER_CONNECTION_GENERATION_HEADER)).toBe('1');
        expect(request.headers.get(KITE_WORKER_PURPOSE_HEADER)).toBe('native_client');
      }
      expect(fixture.requests[0]?.headers.get('authorization')).toMatch(
        new RegExp(`^${KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME} `),
      );
      expect(fixture.requests[0]?.headers.get('authorization')).not.toContain('release-client-1');
      expect(connection.service.endpoint.origin).toBe(fixture.reference.endpoint.origin);
      const created = await connection.controller.createSession({
        schema: WORKER_CONTROLLER_REQUEST_SCHEMA_,
        operation: 'create_session',
        sessionId: 'release-created-session',
        requestId: 'release-create-request',
        requestDigest: 'd'.repeat(64),
        resumeSecret: Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString(
          'base64url',
        ),
        resumeExpiresAtMs: Date.now() + 60_000,
      });
      expect(created).toMatchObject({
        operation: 'create_session',
        sessionRevision: 1,
        lease: { controllerGeneration: 1 },
      });
      expect(fixture.requests.at(-1)?.path).toBe(WORKER_CONTROLLER_PATH_);
    } finally {
      await connection.close();
    }
  });

  test('reconnect mints a new generation/capability and rejects the old capability binding', async () => {
    const fixture = createFixture();
    const sockets: Array<{
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }> = [];
    const webSocketFactory: NativeRuntimeWebSocketFactory = (url, options) => {
      sockets.push({ url, headers: options.headers });
      const nativeWebSocket = WebSocket as unknown as new (
        url: string,
        options?: unknown,
      ) => ReturnType<NativeRuntimeWebSocketFactory>;
      return new nativeWebSocket(url, {
        headers: { ...options.headers },
      }) as unknown as ReturnType<NativeRuntimeWebSocketFactory>;
    };
    const connector = createManagedLocalWorkspaceWorkerConnector({
      coordinatorClient: fixture.coordinator,
      fetch: fixtureFetch(fixture),
      webSocketFactory,
      clientInfo: { name: 'release-test', version: '1', instanceId: 'release-client-2' },
    });
    const connection = await connector.connect({ workspace: fixture.workspace.canonicalPath });
    try {
      const firstInstance = fixture.requests.find(
        (request) => request.path === KITE_SERVICE_INSTANCE_HANDSHAKE_PATH,
      );
      const firstAuthorization = firstInstance?.headers.get('authorization');
      await connection.connect();
      await connection.reconnect();
      await connection.history.listSessions({ limit: 1 });
      const handshakes = fixture.requests.filter(
        (request) => request.path === KITE_SERVICE_INSTANCE_HANDSHAKE_PATH,
      );
      expect(handshakes).toHaveLength(2);
      expect(
        handshakes.map((request) => request.headers.get(KITE_WORKER_CONNECTION_GENERATION_HEADER)),
      ).toEqual(['1', '2']);
      expect(handshakes[0]?.headers.get('authorization')).not.toBe(
        handshakes[1]?.headers.get('authorization'),
      );
      expect(sockets).toHaveLength(2);
      expect(
        sockets.map((socket) => socket.headers[KITE_WORKER_CONNECTION_GENERATION_HEADER]),
      ).toEqual(['1', '2']);
      expect(
        sockets.every((socket) => socket.url === fixture.reference.endpoint.websocketUrl),
      ).toBe(true);
      const oldCapability = firstAuthorization?.slice(
        `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} `.length,
      );
      const rejected = await fetch(
        `${fixture.reference.endpoint.origin}${KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH}`,
        {
          method: 'POST',
          headers: {
            authorization: `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${oldCapability}`,
            'content-type': 'application/json',
            [KITE_WORKER_CLIENT_ID_HEADER]: 'release-client-2',
            [KITE_WORKER_CONNECTION_GENERATION_HEADER]: '2',
            [KITE_WORKER_PURPOSE_HEADER]: 'native_client',
          },
          body: JSON.stringify({ limit: 1 }),
        },
      );
      expect(rejected.status).toBe(401);
    } finally {
      await connection.close();
    }
  });

  test('fails closed before preparing a connection when Worker instance identity mismatches', async () => {
    const fixture = createFixture({ handshakeInstanceId: 'wrong-worker-instance' });
    const connector = createManagedLocalWorkspaceWorkerConnector({
      coordinatorClient: fixture.coordinator,
      fetch: fixtureFetch(fixture),
      clientInfo: { name: 'release-test', version: '1', instanceId: 'release-client-3' },
    });
    await expect(
      connector.connect({ workspace: fixture.workspace.canonicalPath }),
    ).rejects.toMatchObject({
      code: 'service_unavailable',
    });
  });
});

function fixtureFetch(fixture: WorkerFixture): LocalRuntimeFetch {
  const actual = globalThis.fetch.bind(globalThis);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    fixture.requests.push({ path: url.pathname, headers: new Headers(init?.headers) });
    return actual(input, init);
  };
}
