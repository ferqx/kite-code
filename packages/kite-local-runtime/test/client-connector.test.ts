import { afterEach, describe, expect, test } from 'bun:test';
import type {
  KiteWorkspaceIdentity,
  WorkspaceTrustQueryResponse,
} from '@kite-ai/kite-app-contract';
import {
  WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
  WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-app-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import {
  LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
  type LocalRuntimeServiceDescriptor,
} from '../src/client';
import type { LocalRuntimeClientOptions } from '../src/client/connection';
import {
  createLocalKiteConnection,
  LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME,
  LOCAL_RUNTIME_APP_WORKSPACE_TRUST_QUERY_PATH,
  LOCAL_RUNTIME_CONNECT_PATH,
  LOCAL_RUNTIME_TICKET_AUTHORIZATION_SCHEME,
  type LocalRuntimeClientStatePort,
  type LocalRuntimeConnectorOptions,
  type NativeRuntimeWebSocketEvent,
  type NativeRuntimeWebSocketEventType,
  type NativeRuntimeWebSocketFactory,
  type NativeRuntimeWebSocketLike,
} from '../src/client/native-connector';
import {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
} from '../src/service';

const ACCESS_TOKEN = 'a'.repeat(43);
const TICKET = 't'.repeat(43);
const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/tmp/kite-connector-workspace',
  projectId: 'project-connector',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

const clients: NativeRuntimeTestClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe('Native Local Runtime connector', () => {
  test('prepares App Control without Runtime transport and deduplicates the later connect', async () => {
    const fixture = createFixture();
    const connection = createLocalKiteConnection(fixture.options);
    clients.push(connection);

    await Promise.all([connection.prepareAppControl(), connection.prepareAppControl()]);
    expect(fixture.managerCalls).toHaveLength(1);
    expect(fixture.tokenKinds).toEqual(['access']);
    expect(fixture.webSockets).toHaveLength(0);
    expect(
      fixture.requests.filter((request) => request.path === LOCAL_RUNTIME_CONNECT_PATH),
    ).toHaveLength(0);

    await connection.app.queryWorkspaceTrust({
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace: workspace.canonicalPath,
    });
    expect(fixture.webSockets).toHaveLength(0);

    await Promise.all([connection.connect(), connection.connect()]);
    expect(fixture.webSockets).toHaveLength(1);
    expect(
      fixture.requests.filter((request) => request.path === LOCAL_RUNTIME_CONNECT_PATH),
    ).toHaveLength(1);
  });

  test('strictly discovers descriptor/access, issues a ticket, and routes exact History/App calls', async () => {
    const fixture = createFixture();
    const connection = createLocalKiteConnection(fixture.options);
    clients.push(connection);

    await connection.connect();
    expect(connection.status).toBe('active');
    expect(connection.generation).toBe(1);
    expect(connection.service.instanceId).toBe(fixture.descriptor.instanceId);
    expect(fixture.managerCalls).toHaveLength(1);
    expect(fixture.tokenKinds).toEqual(['access']);
    expect(fixture.webSockets[0]?.options.headers).toEqual({
      authorization: `${LOCAL_RUNTIME_TICKET_AUTHORIZATION_SCHEME} ${TICKET}`,
      origin: fixture.descriptor.endpoint.origin,
    });
    expect(fixture.requests[0]).toMatchObject({
      path: LOCAL_RUNTIME_CONNECT_PATH,
      authorization: `${LOCAL_RUNTIME_ACCESS_AUTHORIZATION_SCHEME} ${ACCESS_TOKEN}`,
      credentials: 'omit',
      body: { workspace: workspace.canonicalPath },
    });
    expect(fixture.requests[0]?.headers.cookie).toBeUndefined();

    await expect(connection.history.listSessions({ limit: 1 })).resolves.toEqual({
      entries: [],
      hasMore: false,
    });
    const trustRequest = {
      schema: WORKSPACE_TRUST_QUERY_REQUEST_SCHEMA_,
      workspace: workspace.canonicalPath,
    } as const;
    await expect(connection.app.queryWorkspaceTrust(trustRequest)).resolves.toMatchObject({
      schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
      workspace,
      status: 'unknown',
    });
    expect(
      fixture.requests.filter(
        (request) => request.path === LOCAL_RUNTIME_APP_WORKSPACE_TRUST_QUERY_PATH,
      ),
    ).toHaveLength(1);

    const credential = await connection.credential.writeProviderCredential({
      schema: 'kite.local-runtime-credential-request.v1',
      mutationId: 'credential-1',
      operation: 'write_provider_api_key',
      providerId: 'openai',
      apiKey: 'secret-never-returned',
    });
    expect(credential).toMatchObject({
      schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
      outcome: 'applied',
    });
    expect(fixture.responses.join('\n')).not.toContain('secret-never-returned');
  });

  test('rejects a Runtime initialize response belonging to another Service instance', async () => {
    const fixture = createFixture({ runtimeInstanceId: 'wrong-instance' });
    const connection = createLocalKiteConnection(fixture.options);
    clients.push(connection);

    await expect(connection.connect()).rejects.toMatchObject({ code: 'instance_mismatch' });
    expect(connection.status).toBe('closed');
    expect(fixture.webSockets).toHaveLength(1);
  });

  test('explicit reconnect refreshes identity and lets RuntimeClient resubscribe without replaying mutations', async () => {
    let descriptor = makeDescriptor('instance-one', 4317);
    const fixture = createFixture({ descriptor: () => descriptor, sockets: 2 });
    const connection = createLocalKiteConnection(fixture.options);
    clients.push(connection);
    await connection.connect();
    await connection.runtime.subscribeHandle({ scope: 'sessions' });

    descriptor = makeDescriptor('instance-two', 4318);
    await connection.reconnect();

    expect(connection.generation).toBe(2);
    expect(connection.service.instanceId).toBe('instance-two');
    expect(fixture.webSockets).toHaveLength(2);
    expect(
      fixture.webSockets[1]?.sent.some((message) => message.includes('runtime/subscribe')),
    ).toBe(true);
    expect(fixture.managerCalls).toHaveLength(2);
    expect(
      fixture.requests.filter((request) => request.path === LOCAL_RUNTIME_CONNECT_PATH),
    ).toHaveLength(2);
  });

  test('lost native credential response is not replayed by reconnect', async () => {
    let credentialCalls = 0;
    const fixture = createFixture({
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/_kite/app/provider-credential/write') {
          credentialCalls += 1;
          throw new Error('native response lost');
        }
        return fixtureFetch(input, init, fixture.descriptorProvider());
      },
      sockets: 2,
    });
    const connection = createLocalKiteConnection(fixture.options);
    clients.push(connection);
    await connection.connect();
    await expect(
      connection.credential.writeProviderCredential({
        schema: 'kite.local-runtime-credential-request.v1',
        mutationId: 'credential-lost',
        operation: 'write_provider_api_key',
        providerId: 'openai',
        apiKey: 'secret',
      }),
    ).rejects.toMatchObject({ code: 'connection_failed' });
    await connection.reconnect();
    expect(credentialCalls).toBe(1);
  });

  test('rejects unknown and extra-field History events at the closed client boundary', async () => {
    let historyEvent: unknown = { type: 'secret.event', apiKey: 'leak' };
    const fixture = createFixture({
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/_kite/history/load-session') {
          return Response.json(historyTranscript(historyEvent));
        }
        return fixtureFetch(input, init, fixture.descriptorProvider());
      },
    });
    const connection = createLocalKiteConnection(fixture.options);
    clients.push(connection);
    await connection.connect();

    await expect(connection.history.loadSession('session-1')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    historyEvent = {
      type: 'model.text_delta',
      requestId: 'request-1',
      text: 'safe text',
      providerBody: { apiKey: 'leak' },
    };
    await expect(connection.history.loadSession('session-1')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  test('rejects a delayed HTTP response from a replaced Service identity', async () => {
    let descriptor = makeDescriptor('instance-one', 4317);
    let resolveHistory: ((response: Response) => void) | undefined;
    let markHistoryStarted: (() => void) | undefined;
    const historyStarted = new Promise<void>((resolve) => {
      markHistoryStarted = resolve;
    });
    const fixture = createFixture({
      descriptor: () => descriptor,
      sockets: 2,
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (path === '/_kite/history/list-sessions') {
          markHistoryStarted?.();
          return new Promise<Response>((resolve) => {
            resolveHistory = resolve;
          });
        }
        return fixtureFetch(input, init, descriptor);
      },
    });
    const connection = createLocalKiteConnection(fixture.options);
    clients.push(connection);
    await connection.connect();

    const staleRequest = connection.history.listSessions({ limit: 1 });
    await historyStarted;
    descriptor = makeDescriptor('instance-two', 4318);
    await connection.reconnect();
    resolveHistory?.(Response.json({ entries: [], hasMore: false }));

    await expect(staleRequest).rejects.toMatchObject({ code: 'connection_closed' });
  });
});

function historyTranscript(event: unknown): unknown {
  return {
    session: {
      sessionId: 'session-1',
      displayName: 'Session 1',
      needsSmartName: false,
      updatedAt: 1,
      lastSequence: 1,
    },
    events: [event],
    interactionMode: 'full',
    recovery: 'normal',
  };
}

interface RequestRecord {
  readonly path: string;
  readonly authorization?: string;
  readonly headers: Record<string, string>;
  readonly credentials?: RequestCredentials;
  readonly body: unknown;
}

interface FixtureOptions {
  readonly descriptor?: () => LocalRuntimeServiceDescriptor;
  readonly runtimeInstanceId?: string;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly sockets?: number;
}

interface Fixture {
  readonly options: LocalRuntimeConnectorOptions;
  readonly descriptor: LocalRuntimeServiceDescriptor;
  readonly descriptorProvider: () => LocalRuntimeServiceDescriptor;
  readonly managerCalls: LocalRuntimeClientOptions[];
  readonly tokenKinds: string[];
  readonly requests: RequestRecord[];
  readonly responses: string[];
  readonly webSockets: FakeWebSocket[];
}

type NativeRuntimeTestClient = { connect(): Promise<void>; close(): Promise<void> };

function createFixture(overrides: FixtureOptions = {}): Fixture {
  const descriptorProvider = overrides.descriptor ?? (() => makeDescriptor('instance-one', 4317));
  const descriptor = descriptorProvider();
  const managerCalls: LocalRuntimeClientOptions[] = [];
  const tokenKinds: string[] = [];
  const requests: RequestRecord[] = [];
  const responses: string[] = [];
  const webSockets: FakeWebSocket[] = [];
  const sockets = overrides.sockets ?? 1;
  let socketCount = 0;
  const state: LocalRuntimeClientStatePort = {
    readDescriptor: async () => descriptorProvider(),
    readToken: async (kind) => {
      tokenKinds.push(kind);
      return ACCESS_TOKEN;
    },
  };
  const fetch =
    overrides.fetch ??
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      return fixtureFetch(input, init, descriptorProvider(), requests, responses);
    });
  const webSocketFactory: NativeRuntimeWebSocketFactory = (url, options) => {
    if (socketCount >= sockets) throw new Error('unexpected extra socket');
    const socket = new FakeWebSocket(
      url,
      options,
      overrides.runtimeInstanceId ?? descriptorProvider().instanceId,
    );
    socketCount += 1;
    webSockets.push(socket);
    queueMicrotask(() => socket.open());
    return socket;
  };
  const options: LocalRuntimeConnectorOptions = {
    manager: {
      ensure: async (clientOptions) => {
        if (!clientOptions) throw new Error('missing client options');
        managerCalls.push(clientOptions);
        return descriptorProvider();
      },
    },
    state,
    workspace: workspace.canonicalPath,
    clientInfo: { name: 'connector-test', version: '1', instanceId: 'client-1' },
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    fetch,
    webSocketFactory,
    connectDeadlineMs: 500,
    sendDeadlineMs: 500,
  };
  return {
    options,
    descriptor,
    descriptorProvider,
    managerCalls,
    tokenKinds,
    requests,
    responses,
    webSockets,
  };
}

function fixtureFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  _descriptor: LocalRuntimeServiceDescriptor,
  requests: RequestRecord[] = [],
  responses: string[] = [],
): Promise<Response> {
  const url = new URL(String(input));
  let body: unknown;
  try {
    body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  } catch {
    body = undefined;
  }
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  requests.push({
    path: url.pathname,
    authorization: headers.authorization,
    headers,
    credentials: init?.credentials,
    body,
  });
  let value: unknown;
  switch (url.pathname) {
    case LOCAL_RUNTIME_CONNECT_PATH:
      value = { ticket: TICKET };
      break;
    case '/_kite/history/list-sessions':
      value = { entries: [], hasMore: false };
      break;
    case LOCAL_RUNTIME_APP_WORKSPACE_TRUST_QUERY_PATH:
      value = {
        schema: WORKSPACE_TRUST_QUERY_RESPONSE_SCHEMA_,
        workspace,
        status: 'unknown',
        revision: 'trust-revision-1',
        canDecide: true,
      } satisfies WorkspaceTrustQueryResponse;
      break;
    case '/_kite/app/provider-credential/write':
      value = {
        schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
        mutationId: (body as { readonly mutationId?: string } | undefined)?.mutationId,
        operation: 'write_provider_api_key',
        outcome: 'applied',
        credentialPresent: true,
        revision: 'credential-revision-1',
      };
      break;
    default:
      value = {};
      break;
  }
  const encoded = JSON.stringify(value);
  responses.push(encoded);
  return Promise.resolve(new Response(encoded, { status: 200 }));
}

function makeDescriptor(instanceId: string, port: number): LocalRuntimeServiceDescriptor {
  return {
    schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
    instanceId,
    pid: 123,
    startedAt: '2026-08-27T00:00:00.000Z',
    endpoint: {
      origin: `http://127.0.0.1:${port}`,
      websocketUrl: `ws://127.0.0.1:${port}/rpc`,
    },
    protocolVersion: 1,
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    serverVersion: '1.0.0',
    buildId: 'dev:test',
  };
}

class FakeWebSocket implements NativeRuntimeWebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly url: string;
  readonly sent: string[] = [];
  readonly options: { readonly headers: Readonly<Record<string, string>> };
  readonly #runtimeInstanceId: string;
  readonly #listeners = new Map<
    NativeRuntimeWebSocketEventType,
    Set<(event: NativeRuntimeWebSocketEvent) => void>
  >();

  constructor(
    url: string,
    options: { readonly headers: Readonly<Record<string, string>> },
    runtimeInstanceId: string,
  ) {
    this.url = url;
    this.options = options;
    this.#runtimeInstanceId = runtimeInstanceId;
  }

  addEventListener(
    type: NativeRuntimeWebSocketEventType,
    listener: (event: NativeRuntimeWebSocketEvent) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(
    type: NativeRuntimeWebSocketEventType,
    listener: (event: NativeRuntimeWebSocketEvent) => void,
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
    const message = JSON.parse(data) as RuntimeProtocolMessage;
    if (!('method' in message)) return;
    if (message.method === 'initialize') {
      this.message({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: 1,
          protocolSchema: 'kite.runtime-protocol.v1',
          serverInfo: { version: '1.0.0', instanceId: this.#runtimeInstanceId },
          capabilities: {
            methods: [
              'initialize',
              'runtime/command',
              'runtime/query',
              'runtime/subscribe',
              'runtime/unsubscribe',
              'server/ping',
            ],
            subscriptions: ['sessions', 'session'],
          },
          limits: {
            maxMessageBytes: 1_048_576,
            maxDepth: 16,
            maxInFlightRequests: 64,
            maxSubscriptions: 8,
            maxOutboundMessages: 64,
          },
        },
      });
    } else if (message.method === 'runtime/subscribe') {
      this.message({
        jsonrpc: '2.0',
        id: message.id,
        result: { subscriptionId: 'remote-subscription-1', generation: 1 },
      });
    } else if (message.method === 'runtime/unsubscribe') {
      this.message({ jsonrpc: '2.0', id: message.id, result: { unsubscribed: true } });
    } else if (message.method === 'server/ping') {
      this.message({ jsonrpc: '2.0', id: message.id, result: { status: 'ok' } });
    }
  }

  close(): void {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.#emit('close', {});
  }

  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.#emit('open', {});
  }

  message(data: unknown): void {
    this.#emit('message', { data: JSON.stringify(data) });
  }

  #emit(type: NativeRuntimeWebSocketEventType, event: NativeRuntimeWebSocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}
