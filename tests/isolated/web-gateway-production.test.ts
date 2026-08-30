import { afterEach, describe, expect, test } from 'bun:test';
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
import { join } from 'node:path';
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
} from '../../apps/kite-service/src/carrier';
import type { WebGatewayCarrier } from '../../apps/kite-service/src/web-gateway';
import {
  createWebGatewayControlLink,
  KITE_WEB_DIRECTORY_PATH,
  KITE_WEB_TABS_PATH,
} from '../../apps/kite-service/src/web-gateway';
import type { WebGatewayMainEnvironment } from '../../apps/kite-service/src/web-gateway/process-main';
import { createProductionWebGatewayCarrier } from '../../apps/kite-service/src/web-gateway/production';
import {
  createWorkspaceWorkerCapabilityAuthority,
  KITE_WORKER_CLIENT_ID_HEADER,
  KITE_WORKER_CONNECTION_GENERATION_HEADER,
  KITE_WORKER_PURPOSE_HEADER,
} from '../../apps/kite-service/src/workspace-worker/control-carrier';
import {
  createWebObserverTransport,
  type WebObserverTransport,
  type WebObserverWebSocket,
} from '../../apps/kite-web/src/transport/client';

const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/tmp/kite-production-web-workspace',
  projectId: 'project-1',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};
const coordinatorWorkspace = workspace as CoordinatorWorkspaceIdentity;
const sessionId = 'session-1';
const historyEvent: RuntimeClientEvent = {
  type: 'user.message',
  messageId: 'message-1',
  kind: 'task',
  text: 'Production Gateway history.',
};
const liveEvent: RuntimeClientEvent = {
  type: 'model.text_delta',
  requestId: 'request-1',
  text: 'Production Gateway live.',
};

const gateways: WebGatewayCarrier[] = [];
const workerCarriers: KiteServiceCarrier[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(gateways.splice(0).map((gateway) => gateway.close()));
  await Promise.allSettled(workerCarriers.splice(0).map((carrier) => carrier.close()));
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('production Web Gateway composition', () => {
  test('runs browser bootstrap, Directory/History, native Worker live, and observer-only stop', async () => {
    const fixture = createWorkerFixture();
    const staticRoot = createStaticRoot();
    const environment = createGatewayEnvironment(staticRoot, 'gateway-production-1');
    let shutdownRequests = 0;
    const gateway = trackGateway(
      createProductionWebGatewayCarrier(environment, fixture.coordinator, () => {
        shutdownRequests += 1;
      }),
    );
    expect(readdirSync(staticRoot)).toEqual(['index.html']);

    const rawFrames: unknown[] = [];
    const closeReasons: string[] = [];
    let cookie = '';
    const transport = createBrowserTransport(
      gateway,
      () => cookie,
      (next) => {
        cookie = next;
      },
      rawFrames,
      closeReasons,
    );
    const connection = await transport.connect();
    expect(connection.gatewayInstanceId).toBe(environment.instanceId);
    expect(connection.tabHandle).toMatch(/^[A-Za-z0-9_-]{32}$/u);
    expect(cookie).toMatch(/^kite_web_[a-f0-9]{24}=/u);

    const directory = await transport.listDirectory();
    expect(directory.workspaces).toEqual([
      {
        workspaceId: 'worker-scope-production',
        label: workspace.projectId,
        sessions: [
          {
            sessionId,
            displayName: 'Production Worker Session',
            updatedAt: fixture.updatedAt,
            lastSequence: 1,
            status: 'running',
          },
        ],
      },
    ]);
    const history = await transport.loadHistory(sessionId);
    expect(history.messages[0]?.blocks).toEqual([
      { kind: 'text', text: 'Production Gateway history.' },
    ]);

    const subscription = await transport.subscribe({
      sessionId,
      afterSequence: history.observedLastSequence,
      onEvent: () => undefined,
    });
    await Bun.sleep(50);
    await expectEventually(() => rawFrames.some(isLiveMessageFrame));
    await subscription.unsubscribe();
    await transport.disconnect();
    await expectEventually(() => fixture.calls.runtimeConnectionsClosed === 1);
    await expectEventually(() => closeReasons.length > 0);

    const forbidden = [
      workspace.canonicalPath,
      fixture.worker.endpoint.origin,
      fixture.worker.endpoint.websocketUrl,
      fixture.capabilityMaterial,
    ];
    const browserOutput = JSON.stringify({ directory, history, frames: rawFrames });
    for (const secret of forbidden) expect(browserOutput).not.toContain(secret);
    for (const reason of closeReasons) {
      for (const secret of forbidden) expect(reason).not.toContain(secret);
    }

    const control = createWebGatewayControlLink({
      origin: gateway.origin,
      credential: environment.controlCredential,
      expectedInstanceId: environment.instanceId,
      expectedBuildId: environment.buildId,
    });
    const launch = await control.mintLaunchUrl();
    expect(launch).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#[-_A-Za-z0-9]{43}$/u);
    await control.stop();
    await Bun.sleep(60);
    expect(shutdownRequests).toBe(1);
    expect(fixture.calls.runtimeCommands).toBe(0);
    expect(fixture.calls.workerStopRequests).toBe(0);

    const staleCookie = cookie;
    const staleTab = connection.tabHandle;
    await gateway.close();
    const restartedRoot = createStaticRoot();
    const restarted = trackGateway(
      createProductionWebGatewayCarrier(
        createGatewayEnvironment(restartedRoot, environment.instanceId),
        fixture.coordinator,
        () => undefined,
      ),
    );
    const staleCookieResponse = await fetch(`${restarted.origin}${KITE_WEB_TABS_PATH}`, {
      method: 'POST',
      headers: browserHeaders(restarted.origin, staleCookie),
      body: JSON.stringify({ schema: 'kite.app.web.tab-create-request.v1' }),
    });
    expect(staleCookieResponse.status).toBe(401);
    const fresh = await bootstrapGateway(restarted);
    const staleTabResponse = await fetch(`${restarted.origin}${KITE_WEB_DIRECTORY_PATH}`, {
      method: 'POST',
      headers: browserHeaders(restarted.origin, fresh.cookie, staleTab),
      body: JSON.stringify({ schema: 'kite.app.web.directory-request.v1' }),
    });
    expect(staleTabResponse.status).toBe(401);
  });
});

interface WorkerFixture {
  readonly worker: CoordinatorWorkerReference;
  readonly coordinator: CoordinatorRequestClient;
  readonly capabilityMaterial: string;
  readonly updatedAt: number;
  readonly calls: {
    runtimeCommands: number;
    workerStopRequests: number;
    runtimeConnectionsClosed: number;
  };
}

function createWorkerFixture(): WorkerFixture {
  const calls = { runtimeCommands: 0, workerStopRequests: 0, runtimeConnectionsClosed: 0 };
  const updatedAt = Date.now();
  let capabilityMaterial = 'not-issued';
  const projection = sessionProjection(1, 'running');
  const nextProjection = sessionProjection(2, 'running');
  const runtime: RuntimeAccess = {
    command: async () => {
      calls.runtimeCommands += 1;
      return { status: 'applied', commandId: 'command-1', sessionId, revision: 1 };
    },
    query: async (query) =>
      query.type === 'get_session_projection'
        ? {
            status: 'ok',
            queryType: query.type,
            revision: projection.revision,
            session: projection,
          }
        : { status: 'ok', queryType: query.type, sessions: [] },
    subscribe: ({ signal }) => ({
      async *[Symbol.asyncIterator]() {
        yield {
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
        } satisfies RuntimeAccessNotification;
        yield {
          schema: 'kite.runtime-notification.v1',
          durability: 'durable',
          sessionId,
          revision: 2,
          projection: { kind: 'session', session: nextProjection, event: liveEvent },
        } satisfies RuntimeAccessNotification;
        await waitForAbort(signal ?? new AbortController().signal);
      },
    }),
  };
  const history: RuntimeHistorySessionTranscript = {
    session: {
      sessionId,
      displayName: 'Production Worker Session',
      needsSmartName: false,
      updatedAt,
      lastSequence: 1,
    },
    records: [{ sequence: 1, events: [historyEvent] }],
    events: [historyEvent],
    interactionMode: 'auto',
    recovery: 'normal',
  };
  const workerIdentity = {
    workerScopeId: 'worker-scope-production',
    workerInstanceId: 'worker-production-1',
    buildId: 'worker-build-production-1',
    workspace,
  };
  const authority = createWorkspaceWorkerCapabilityAuthority({
    identity: workerIdentity,
    randomBytes: (size) => new Uint8Array(size).fill(17),
    requestIdleStop: async () => {
      calls.workerStopRequests += 1;
      return 'closed';
    },
  });
  const application: KiteServiceApplicationPort = {
    server: new RuntimeServer(
      {
        runtime,
        admission: {
          authorize: async () => ({ allowed: true, workspace: workspace.canonicalPath }),
        },
      },
      { serverInfo: { instanceId: workerIdentity.workerInstanceId, version: 'worker-test' } },
    ),
    history: {
      listSessions: async () => ({
        entries: [
          {
            sessionId,
            displayName: 'Production Worker Session',
            needsSmartName: false,
            updatedAt,
            lastSequence: 1,
          },
        ],
        hasMore: false,
      }),
      listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 1 }),
      loadSession: async () => history,
    },
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
  workerCarriers.push(carrier);
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
  const coordinator = createCoordinator({
    worker,
    mint: async (params) => {
      const result = await authority.mintConnectionCapability(params);
      if (result.outcome !== 'applied') throw new Error('Worker capability mint failed.');
      capabilityMaterial = result.capability;
      return result;
    },
  });
  return {
    worker,
    coordinator,
    get capabilityMaterial() {
      return capabilityMaterial;
    },
    updatedAt,
    calls,
  };
}

function createCoordinator(input: {
  readonly worker: CoordinatorWorkerReference;
  readonly mint: (
    params: Parameters<CoordinatorRequestClient['mintWorkerConnectionCapability']>[0],
  ) => Promise<{ readonly capability: string; readonly expiresAt: string }>;
}): CoordinatorRequestClient {
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
    resolveSessionWorkspace: async () =>
      ok('resolveSessionWorkspace', {
        workerScopeId: input.worker.identity.workerScopeId,
        workspace: coordinatorWorkspace,
        worker: input.worker,
      }),
    mintWorkerConnectionCapability: async (
      params: Parameters<CoordinatorRequestClient['mintWorkerConnectionCapability']>[0],
    ) => {
      const minted = await input.mint(params);
      return ok('mintWorkerConnectionCapability', {
        worker: input.worker,
        clientId: params.clientId,
        connectionGeneration: params.connectionGeneration,
        purpose: params.purpose,
        workerConnectionCapability: minted.capability,
        expiresAt: minted.expiresAt,
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

function sessionProjection(
  revision: number,
  status: 'running' | 'waiting' | 'completed' = 'running',
): RuntimeSessionProjection {
  return {
    schema: 'kite.runtime-projection.v1',
    sessionId,
    revision,
    displayName: 'Production Worker Session',
    lifecycle: status === 'completed' ? 'closed' : 'open',
    interactionQueue: { revision, interactions: [] },
    activeWork:
      status === 'completed'
        ? undefined
        : {
            workId: 'work-1',
            phase: 'building',
            status,
            activeTurn: { turnId: 'turn-1', status },
          },
  };
}

function createStaticRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-web-production-')));
  temporaryRoots.push(root);
  const staticRoot = join(root, 'web');
  mkdirSync(staticRoot, { mode: 0o700 });
  chmodSync(staticRoot, 0o700);
  writeFileSync(join(staticRoot, 'index.html'), '<!doctype html><title>Kite Observer</title>');
  return staticRoot;
}

function createGatewayEnvironment(
  staticAssetRoot: string,
  instanceId: string,
): WebGatewayMainEnvironment {
  return {
    home: '/tmp/kite-web-production-home',
    staticAssetRoot,
    buildId: 'gateway-build-production-1',
    instanceId,
    controlCredential: 'C'.repeat(43),
    readinessFd: 3,
  };
}

function createBrowserTransport(
  gateway: WebGatewayCarrier,
  currentCookie: () => string,
  setCookie: (value: string) => void,
  rawFrames: unknown[],
  closeReasons: string[],
): WebObserverTransport {
  const origin = new URL(gateway.origin);
  return createWebObserverTransport({
    location: {
      hash: new URL(gateway.launchUrl).hash,
      host: origin.host,
      origin: gateway.origin,
      pathname: '/',
      protocol: origin.protocol,
      search: '',
    },
    history: { replaceState: () => undefined },
    fetch: (input, init) => browserFetch(gateway.origin, input, init, currentCookie, setCookie),
    webSocketFactory: (url) =>
      browserSocket(url, gateway.origin, currentCookie, rawFrames, closeReasons),
  });
}

async function browserFetch(
  origin: string,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  currentCookie: () => string,
  setCookie: (value: string) => void,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('origin', origin);
  headers.set('sec-fetch-site', 'same-origin');
  headers.set('sec-fetch-mode', 'cors');
  const cookie = currentCookie();
  if (cookie) headers.set('cookie', cookie);
  const response = await fetch(new URL(String(input), origin), { ...init, headers });
  const issued = response.headers.get('set-cookie')?.split(';', 1)[0];
  if (issued) setCookie(issued);
  return response;
}

function browserSocket(
  url: string,
  origin: string,
  currentCookie: () => string,
  rawFrames: unknown[],
  closeReasons: string[],
): WebObserverWebSocket {
  const socket = new WebSocket(url, {
    headers: {
      Cookie: currentCookie(),
      Origin: origin,
      'Sec-Fetch-Mode': 'websocket',
      'Sec-Fetch-Site': 'same-origin',
    },
  } as unknown as string[]);
  socket.addEventListener('message', (event) => {
    try {
      rawFrames.push(JSON.parse(String(event.data)) as unknown);
    } catch {
      rawFrames.push('invalid');
    }
  });
  socket.addEventListener('close', (event) => closeReasons.push(event.reason));
  return socket as unknown as WebObserverWebSocket;
}

async function bootstrapGateway(
  gateway: WebGatewayCarrier,
): Promise<{ readonly cookie: string; readonly origin: string }> {
  const token = new URL(gateway.launchUrl).hash.slice(1);
  const response = await fetch(`${gateway.origin}/_kite/web/bootstrap`, {
    method: 'POST',
    headers: browserHeaders(gateway.origin),
    body: JSON.stringify({ launchToken: token }),
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) throw new Error('Gateway bootstrap omitted cookie.');
  return { cookie: setCookie.split(';', 1)[0]!, origin: gateway.origin };
}

function browserHeaders(origin: string, cookie?: string, tabHandle?: string): HeadersInit {
  return {
    origin,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'content-type': 'application/json',
    ...(cookie === undefined ? {} : { cookie }),
    ...(tabHandle === undefined ? {} : { 'x-kite-web-tab': tabHandle }),
  };
}

function isLiveMessageFrame(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'message' &&
    'sequence' in value &&
    value.sequence === 2
  );
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

async function expectEventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

function trackGateway(gateway: WebGatewayCarrier): WebGatewayCarrier {
  gateways.push(gateway);
  return gateway;
}
