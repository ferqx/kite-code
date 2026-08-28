import { afterEach, describe, expect, test } from 'bun:test';
import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorMethod,
  type CoordinatorRequestClient,
  type CoordinatorResponseFor,
  type CoordinatorResultByMethod,
  type CoordinatorWorkerReference,
  type CoordinatorWorkspaceIdentity,
} from '@kite-ai/kite-local-runtime/coordinator';
import type {
  RuntimeAccess,
  RuntimeAccessNotification,
  RuntimeClientEvent,
  RuntimeHistorySessionTranscript,
  RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import { RuntimeServer } from '@kite-ai/runtime-server';
import {
  createKiteServiceCarrier,
  KITE_SERVICE_CONNECT_PATH,
  type KiteServiceApplicationPort,
  type KiteServiceCarrier,
} from '../../src/carrier';
import {
  createWebGatewayUpstream,
  type WorkspaceWorkerWebGatewayUpstream,
} from '../../src/web-gateway';
import {
  createWorkspaceWorkerCapabilityAuthority,
  KITE_WORKER_CLIENT_ID_HEADER,
  KITE_WORKER_CONNECTION_GENERATION_HEADER,
  KITE_WORKER_PURPOSE_HEADER,
} from '../../src/workspace-worker/control-carrier';

const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/tmp/kite-web-upstream-workspace',
  projectId: 'project-1',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};
const coordinatorWorkspace = workspace as CoordinatorWorkspaceIdentity;
const sessionId = 'session-1';
const historyEvent: RuntimeClientEvent = {
  type: 'user.message',
  messageId: 'message-1',
  kind: 'task',
  text: 'History from the native Worker.',
};
const liveEvent: RuntimeClientEvent = {
  type: 'model.text_delta',
  requestId: 'request-1',
  text: 'Live from the native Worker.',
};

const carriers: KiteServiceCarrier[] = [];
const upstreams: WorkspaceWorkerWebGatewayUpstream[] = [];

afterEach(async () => {
  await Promise.allSettled(upstreams.splice(0).map((upstream) => upstream.close()));
  await Promise.allSettled(carriers.splice(0).map((carrier) => carrier.close()));
});

describe('Workspace Worker Web Gateway upstream', () => {
  test('routes Directory and current History through a real Worker carrier', async () => {
    const fixture = createWorkerFixture();
    const upstream = trackUpstream(
      createWebGatewayUpstream({
        coordinator: fixture.coordinator,
        gatewayInstanceId: 'gateway-1',
        contractRevision: 'web-contract-1',
      }),
    );
    const observer = upstream.createObserver({ tabHandle: 'tab-1', connectionGeneration: 1 });

    const directory = await observer.listDirectory({
      schema: 'kite.app.web.directory-request.v1',
    });
    expect(directory.workspaces).toHaveLength(1);
    expect(directory.workspaces[0]).toMatchObject({
      workspaceId: workspace.workspaceDigest,
      label: workspace.projectId,
    });
    expect(directory.workspaces[0]?.sessions[0]).toMatchObject({
      sessionId,
      displayName: 'Native Worker Session',
      lastSequence: 1,
      status: 'idle',
    });
    const encodedDirectory = JSON.stringify(directory);
    expect(encodedDirectory).not.toContain(workspace.canonicalPath);
    expect(encodedDirectory).not.toContain(fixture.worker.endpoint.origin);
    expect(encodedDirectory).not.toContain(fixture.capabilityMaterial);

    const history = await observer.loadHistory({
      schema: 'kite.app.web.history-request.v1',
      sessionId,
      limit: 200,
    });
    expect(history.messages[0]?.blocks).toEqual([
      { kind: 'text', text: 'History from the native Worker.' },
    ]);
    expect(fixture.calls.mintPurposes).toEqual(['web_observer']);
    expect(fixture.calls.historyListSessions).toBe(1);
    expect(fixture.calls.historyLoadSession).toBe(1);

    await observer.disconnect({ schema: 'kite.app.web.disconnect-request.v1' });
  });

  test('maps only durable revision notifications and closes the Observer connection', async () => {
    const fixture = createWorkerFixture();
    const upstream = trackUpstream(
      createWebGatewayUpstream({
        coordinator: fixture.coordinator,
        gatewayInstanceId: 'gateway-2',
        contractRevision: 'web-contract-1',
      }),
    );
    const observer = upstream.createObserver({ tabHandle: 'tab-2', connectionGeneration: 2 });
    const subscription = await observer.subscribe({
      schema: 'kite.app.web.subscribe-request.v1',
      sessionId,
      afterSequence: 1,
    });
    const events = observer.events(subscription.subscriptionId)[Symbol.asyncIterator]();
    await expect(withDeadline(events.next())).resolves.toMatchObject({
      done: false,
      value: {
        type: 'message',
        sessionId,
        sequence: 2,
        message: {
          blocks: [{ kind: 'text', text: 'Live from the native Worker.' }],
        },
      },
    });
    expect(fixture.calls.ephemeralObserved).toBe(1);
    expect(fixture.calls.durableObserved).toBe(1);

    await observer.unsubscribe({
      schema: 'kite.app.web.unsubscribe-request.v1',
      subscriptionId: subscription.subscriptionId,
    });
    await observer.disconnect({ schema: 'kite.app.web.disconnect-request.v1' });
    await eventually(() => fixture.calls.runtimeConnectionsClosed === 1);
  });

  test('fails closed when the Coordinator Worker identity changes or capability is expired', async () => {
    const fixture = createWorkerFixture();
    let currentWorker = fixture.worker;
    const coordinator = fixture.withWorker(() => currentWorker);
    const upstream = trackUpstream(
      createWebGatewayUpstream({
        coordinator,
        gatewayInstanceId: 'gateway-3',
        contractRevision: 'web-contract-1',
        now: () => fixture.now,
      }),
    );
    const observer = upstream.createObserver({ tabHandle: 'tab-3', connectionGeneration: 3 });
    await observer.loadHistory({
      schema: 'kite.app.web.history-request.v1',
      sessionId,
      limit: 200,
    });
    currentWorker = {
      ...currentWorker,
      identity: { ...currentWorker.identity, instanceId: 'worker-2' },
    };
    await expect(
      observer.loadHistory({
        schema: 'kite.app.web.history-request.v1',
        sessionId,
        limit: 200,
      }),
    ).rejects.toThrow();
  });
});

interface WorkerFixture {
  readonly carrier: KiteServiceCarrier;
  readonly worker: CoordinatorWorkerReference;
  readonly coordinator: CoordinatorRequestClient;
  readonly capabilityMaterial: string;
  readonly calls: {
    mintPurposes: string[];
    historyListSessions: number;
    historyLoadSession: number;
    ephemeralObserved: number;
    durableObserved: number;
    runtimeConnectionsClosed: number;
  };
  readonly now: number;
  withWorker(resolve: () => CoordinatorWorkerReference): CoordinatorRequestClient;
}

function createWorkerFixture(): WorkerFixture {
  const calls = {
    mintPurposes: [] as string[],
    historyListSessions: 0,
    historyLoadSession: 0,
    ephemeralObserved: 0,
    durableObserved: 0,
    runtimeConnectionsClosed: 0,
  };
  const now = Date.now();
  let capabilityMaterial = 'not-minted';
  const projection = sessionProjection(1);
  const nextProjection = sessionProjection(2);
  const ephemeral: RuntimeAccessNotification = {
    schema: 'kite.runtime-notification.v1',
    durability: 'ephemeral',
    sessionId,
    workId: 'work-1',
    turnId: 'turn-1',
    actorId: 'actor-1',
    attemptId: 'attempt-1',
    compositionRevision: 'composition-1',
    streamId: 'stream-1',
    sequence: 1,
    event: liveEvent,
  };
  const durable: RuntimeAccessNotification = {
    schema: 'kite.runtime-notification.v1',
    durability: 'durable',
    sessionId,
    revision: 2,
    projection: {
      kind: 'session',
      session: nextProjection,
      event: liveEvent,
    },
  };
  const runtime: RuntimeAccess = {
    command: async () => ({
      status: 'applied',
      commandId: 'command-1',
      sessionId,
      revision: 1,
    }),
    query: async (query) =>
      query.type === 'get_session_projection'
        ? {
            status: 'ok',
            queryType: query.type,
            revision: projection.revision,
            session: projection,
          }
        : {
            status: 'ok',
            queryType: query.type,
            sessions: [],
          },
    subscribe: ({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        calls.ephemeralObserved += 1;
        yield ephemeral;
        calls.durableObserved += 1;
        yield durable;
        await waitForAbort(signal ?? new AbortController().signal);
      },
    }),
  };
  const history = {
    listSessions: async () => {
      calls.historyListSessions += 1;
      return {
        entries: [
          {
            sessionId,
            displayName: 'Native Worker Session',
            needsSmartName: false,
            updatedAt: now,
            lastSequence: 1,
          },
        ],
        hasMore: false,
      };
    },
    listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 1 }),
    loadSession: async (): Promise<RuntimeHistorySessionTranscript> => {
      calls.historyLoadSession += 1;
      return {
        session: {
          sessionId,
          displayName: 'Native Worker Session',
          needsSmartName: false,
          updatedAt: now,
          lastSequence: 1,
        },
        records: [{ sequence: 1, events: [historyEvent] }],
        events: [historyEvent],
        interactionMode: 'auto',
        recovery: 'normal',
      };
    },
  };
  const workerIdentity = {
    workerScopeId: 'worker-scope-1',
    workerInstanceId: 'worker-1',
    buildId: 'worker-build-1',
    workspace,
  };
  const authority = createWorkspaceWorkerCapabilityAuthority({
    identity: workerIdentity,
    randomBytes: (size) => new Uint8Array(size).fill(7),
  });
  const application: KiteServiceApplicationPort = {
    server: new RuntimeServer(
      {
        runtime,
        admission: {
          authorize: async () => ({ allowed: true, workspace: workspace.canonicalPath }),
        },
      },
      { serverInfo: { instanceId: 'worker-1', version: 'worker-test' } },
    ),
    history,
    workspaceAdmission: {
      admitForConnect: async (requested) =>
        requested === workspace.canonicalPath
          ? { outcome: 'admitted', workspace }
          : { outcome: 'untrusted' },
      resolveIdentity: async (candidate) =>
        sameWorkspace(candidate, workspace) ? workspace : undefined,
    },
    runtimeAdmission: {
      create: () => ({
        authorize: async () => ({ allowed: true, workspace: workspace.canonicalPath }),
      }),
    },
    appControl: {
      discovery: {} as KiteAppControlClient,
      forWorkspace: () => ({}) as KiteAppControlClient,
    },
    onConnectionClosed: () => {
      calls.runtimeConnectionsClosed += 1;
    },
  };
  const carrier = createKiteServiceCarrier({
    application,
    instanceId: workerIdentity.workerInstanceId,
    serverVersion: 'worker-test',
    buildId: workerIdentity.buildId,
    accessToken: 'A'.repeat(43),
    controlToken: 'B'.repeat(43),
    accessTokenVerifier: ({ token, request, pathname }) => {
      const clientId = request.headers.get(KITE_WORKER_CLIENT_ID_HEADER);
      const generation = Number(request.headers.get(KITE_WORKER_CONNECTION_GENERATION_HEADER));
      const purpose = request.headers.get(KITE_WORKER_PURPOSE_HEADER);
      return (
        clientId !== null &&
        Number.isSafeInteger(generation) &&
        generation > 0 &&
        purpose === 'web_observer' &&
        authority.verifyConnectionCapability(
          {
            workerScopeId: workerIdentity.workerScopeId,
            workerInstanceId: workerIdentity.workerInstanceId,
            workspaceDigest: workspace.workspaceDigest,
            clientId,
            connectionGeneration: generation,
            purpose,
            secret: token,
          },
          { consume: pathname === KITE_SERVICE_CONNECT_PATH },
        )
      );
    },
  });
  carriers.push(carrier);
  const worker: CoordinatorWorkerReference = {
    identity: {
      role: 'worker',
      workerScopeId: workerIdentity.workerScopeId,
      instanceId: workerIdentity.workerInstanceId,
      buildId: workerIdentity.buildId,
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
      clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
    },
    workspace: coordinatorWorkspace,
    endpoint: { origin: carrier.origin, websocketUrl: carrier.rpcUrl },
  };
  const coordinator = createFakeCoordinator({
    worker,
    mint: async (params) => {
      calls.mintPurposes.push(params.purpose);
      const result = await authority.mintConnectionCapability(params);
      if (result.outcome !== 'applied') throw new Error('capability mint failed');
      capabilityMaterial = result.capability;
      return result;
    },
  });
  return {
    carrier,
    worker,
    coordinator,
    capabilityMaterial,
    calls,
    now,
    withWorker: (resolve) =>
      createFakeCoordinator({
        worker,
        resolveWorker: resolve,
        mint: async (params) => {
          const result = await authority.mintConnectionCapability(params);
          if (result.outcome !== 'applied') throw new Error('capability mint failed');
          capabilityMaterial = result.capability;
          return result;
        },
      }),
  };
}

function createFakeCoordinator(input: {
  readonly worker: CoordinatorWorkerReference;
  readonly resolveWorker?: () => CoordinatorWorkerReference;
  readonly mint?: (params: {
    readonly clientId: string;
    readonly connectionGeneration: number;
    readonly purpose: 'native_client' | 'web_observer';
    readonly workspace: CoordinatorWorkspaceIdentity;
    readonly workerScopeId: string;
  }) => Promise<{ readonly capability: string; readonly expiresAt: string }>;
}): CoordinatorRequestClient {
  const resolveWorker = input.resolveWorker ?? (() => input.worker);
  return {
    listSessionMetadata: async () =>
      ok('listSessionMetadata', {
        entries: [
          {
            sessionId,
            workerScopeId: input.worker.identity.workerScopeId,
            directoryRevision: '1',
            updatedAt: '2026-08-29T00:00:00.000Z',
            tombstone: false,
          },
        ],
      }),
    resolveSessionWorkspace: async () => {
      const worker = resolveWorker();
      return ok('resolveSessionWorkspace', {
        workerScopeId: worker.identity.workerScopeId,
        workspace: coordinatorWorkspace,
        worker,
      });
    },
    mintWorkerConnectionCapability: async (
      params: Parameters<CoordinatorRequestClient['mintWorkerConnectionCapability']>[0],
    ) => {
      const result = input.mint
        ? await input.mint(params)
        : { capability: 'unused', expiresAt: '2026-08-29T00:00:00.000Z' };
      const worker = resolveWorker();
      return ok('mintWorkerConnectionCapability', {
        worker,
        clientId: params.clientId,
        connectionGeneration: params.connectionGeneration,
        purpose: params.purpose,
        workerConnectionCapability: result.capability,
        expiresAt: result.expiresAt,
      });
    },
  } as unknown as CoordinatorRequestClient;
}

function ok<M extends CoordinatorMethod>(
  method: M,
  result: CoordinatorResultByMethod[M],
): CoordinatorResponseFor<M> {
  return {
    schema: 'kite.local-coordinator-frame.v1',
    kind: 'response',
    protocolVersion: 1,
    requestId: `request-${method}`,
    idempotencyKey: `key-${method}`,
    deadlineMs: 1_000,
    method,
    outcome: 'ok',
    result,
  } as CoordinatorResponseFor<M>;
}

function sessionProjection(revision: number): RuntimeSessionProjection {
  return {
    schema: 'kite.runtime-projection.v1',
    sessionId,
    revision,
    displayName: 'Native Worker Session',
    lifecycle: 'open',
    interactionQueue: { revision, interactions: [] },
  };
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}

async function withDeadline<Value>(promise: Promise<Value>): Promise<Value> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error('upstream test deadline exceeded')), 2_000),
    ),
  ]);
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

function trackUpstream(
  upstream: WorkspaceWorkerWebGatewayUpstream,
): WorkspaceWorkerWebGatewayUpstream {
  upstreams.push(upstream);
  return upstream;
}
