import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCoordinatorEndpointIdentity,
  assertCoordinatorJsonValue,
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_LIMITS,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorCarrierSocket,
  type CoordinatorClientIdentity,
  type CoordinatorDispatcherHandlers,
  type CoordinatorGatewayRegistration,
  type CoordinatorIdentity,
  CoordinatorLengthPrefixedFrameDecoder,
  type CoordinatorRequestFrame,
  type CoordinatorWireFrame,
  type CoordinatorWorkerReference,
  type CoordinatorWorkerRegistration,
  type CoordinatorWorkspaceIdentity,
  createCoordinatorCarrier,
  createCoordinatorDispatcher,
  createCoordinatorNamedPipeEndpoint,
  createCoordinatorRegistry,
  createCoordinatorRequestClient,
  createCoordinatorSocketRequestTransport,
  createCoordinatorUnixSocketEndpoint,
  decodeCoordinatorEndpointDescriptor,
  decodeCoordinatorRequestFrame,
  encodeCoordinatorWireFrame,
  ensureCoordinatorStateRoot,
  PosixCoordinatorCarrierAdapter,
  WindowsCoordinatorCarrierAdapter,
} from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const workspace: CoordinatorWorkspaceIdentity = {
  canonicalPath: '/workspaces/kite',
  projectId: 'project-kite',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

const coordinator: CoordinatorIdentity = {
  role: 'coordinator',
  instanceId: 'coordinator-instance-1',
  buildId: 'build-1',
  protocolVersion: COORDINATOR_PROTOCOL_VERSION,
  protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
  clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
};

const client: CoordinatorClientIdentity = {
  role: 'client',
  instanceId: 'client-instance-1',
  buildId: 'build-1',
  protocolVersion: COORDINATOR_PROTOCOL_VERSION,
  protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
  clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
};

const webGateway = {
  role: 'web_gateway',
  instanceId: 'web-gateway-instance-1',
  buildId: 'build-1',
  protocolVersion: COORDINATOR_PROTOCOL_VERSION,
  protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
  clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
} as const;

const worker: CoordinatorWorkerReference = {
  identity: {
    role: 'worker',
    workerScopeId: 'worker-scope-1',
    instanceId: 'worker-instance-1',
    buildId: 'build-1',
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
    clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
  },
  workspace,
  endpoint: {
    origin: 'http://127.0.0.1:43123',
    websocketUrl: 'ws://127.0.0.1:43123/rpc',
  },
};

function request<M extends CoordinatorRequestFrame['method']>(
  method: M,
  params: Extract<CoordinatorRequestFrame, { method: M }>['params'],
): Extract<CoordinatorRequestFrame, { method: M }> {
  return {
    schema: 'kite.local-coordinator-frame.v1',
    kind: 'request',
    protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    requestId: `request-${method}`,
    idempotencyKey: `idempotency-${method}`,
    deadlineMs: 5_000,
    method,
    params,
  } as Extract<CoordinatorRequestFrame, { method: M }>;
}

function handlers(): CoordinatorDispatcherHandlers {
  return {
    status: () => ({ state: 'ready', identity: coordinator, directoryRevision: 'revision-1' }),
    resolveWorkspaceWorker: () => ({ worker }),
    ensureWorkspaceWorker: () => ({ worker }),
    resolveSessionWorkspace: () => ({
      workerScopeId: worker.identity.workerScopeId,
      workspace,
      worker,
    }),
    listSessionMetadata: () => ({ entries: [] }),
    mintWorkerConnectionCapability: (params) => ({
      worker,
      clientId: params.clientId,
      connectionGeneration: params.connectionGeneration,
      purpose: params.purpose,
      workerConnectionCapability: 'A'.repeat(32),
      expiresAt: '2026-08-28T00:00:30.000Z',
    }),
    ensureWebGateway: () => ({ gateway: null }),
    discoverWebGateway: () => ({ gateway: null }),
    stopWebGateway: () => ({ gateway: null }),
    subscribeDirectoryChanges: () => ({
      subscriptionId: 'subscription-1',
      directoryRevision: 'revision-1',
    }),
  };
}

describe('Coordinator endpoint and identity codecs', () => {
  test('uses a distinct owner-only Coordinator state root', () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-coordinator-state-'));
    try {
      const paths = ensureCoordinatorStateRoot(createKiteHomeIdentity(home));
      expect(paths.root).toBe(join(home, 'coordinator', 'v1'));
      expect(paths.root).not.toContain(`${join('runtime-service', 'v1')}`);
      expect(paths.endpointDescriptor).toBe(join(paths.root, 'endpoint.json'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('keeps Unix and named-pipe descriptors path-free and identity-bound', () => {
    const unix = createCoordinatorUnixSocketEndpoint({
      endpointId: 'unix-endpoint-1',
      ownerUid: 501,
      coordinator,
    });
    const pipe = createCoordinatorNamedPipeEndpoint({
      endpointId: 'pipe-endpoint-1',
      userSid: 'S-1-5-21-100-200-300-400',
      coordinator,
    });

    expect(unix.transport).toBe('unix_socket');
    expect(unix.protection).toBe('owner_only');
    expect(pipe.transport).toBe('named_pipe');
    expect(pipe.protection).toBe('current_user');
    expect(JSON.stringify(unix)).not.toContain('path');
    expect(JSON.stringify(pipe)).not.toContain('path');
    expect(() =>
      decodeCoordinatorEndpointDescriptor({ ...unix, path: '/tmp/coordinator.sock' }),
    ).toThrow();
    expect(() =>
      decodeCoordinatorEndpointDescriptor({ ...pipe, pipeName: '\\\\.\\pipe\\kite' }),
    ).toThrow();
    expect(() =>
      assertCoordinatorEndpointIdentity(unix, { ...coordinator, instanceId: 'replacement' }),
    ).toThrow();
  });

  test('rejects identity drift and malformed Windows SID', () => {
    const endpoint = createCoordinatorNamedPipeEndpoint({
      endpointId: 'pipe-endpoint-1',
      userSid: 'S-1-5-21-100-200-300-400',
      coordinator,
    });
    expect(() =>
      decodeCoordinatorEndpointDescriptor({
        ...endpoint,
        owner: { kind: 'windows_sid', sid: 'not-a-sid' },
      }),
    ).toThrow();
    expect(() =>
      assertCoordinatorEndpointIdentity(
        { ...endpoint, coordinator: { ...coordinator, buildId: 'other' } },
        coordinator,
      ),
    ).toThrow();
  });
});

describe('Coordinator frame codecs', () => {
  test('accepts only the fixed methods and closed metadata shapes', () => {
    const decoded = decodeCoordinatorRequestFrame(request('resolveWorkspaceWorker', { workspace }));
    expect(decoded.method).toBe('resolveWorkspaceWorker');
    expect(() =>
      decodeCoordinatorRequestFrame({ ...decoded, method: 'runtime/command' }),
    ).toThrow();
    expect(() =>
      decodeCoordinatorRequestFrame({ ...decoded, params: { workspace, model: 'gpt' } }),
    ).toThrow();
    expect(() =>
      decodeCoordinatorRequestFrame({ ...decoded, params: { workspace, tool: { name: 'x' } } }),
    ).toThrow();
    expect(() =>
      decodeCoordinatorRequestFrame({ ...decoded, params: { workspace, credential: 'secret' } }),
    ).toThrow();
    expect(() => decodeCoordinatorRequestFrame({ ...decoded, unknown: true })).toThrow();
  });

  test('bounds identifiers, deadline, depth, and serialized size', () => {
    const valid = request('status', {});
    expect(() => decodeCoordinatorRequestFrame({ ...valid, requestId: 'x'.repeat(129) })).toThrow();
    expect(() =>
      decodeCoordinatorRequestFrame({ ...valid, idempotencyKey: 'x'.repeat(129) }),
    ).toThrow();
    expect(() => decodeCoordinatorRequestFrame({ ...valid, deadlineMs: 120_001 })).toThrow();

    let deep: unknown = {};
    for (let index = 0; index < 14; index += 1) deep = { nested: deep };
    expect(() => assertCoordinatorJsonValue(deep)).toThrow();
    expect(() => assertCoordinatorJsonValue({ payload: 'x'.repeat(70_000) })).toThrow();
  });
});

describe('Coordinator dispatcher and request client', () => {
  test('dispatches fixed handlers and verifies handshake peer identity', async () => {
    const dispatcher = createCoordinatorDispatcher({
      identity: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      handlers: handlers(),
    });
    const handshake = dispatcher.handleHandshake({
      schema: 'kite.local-coordinator-handshake.v1',
      kind: 'handshake_request',
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      requestId: 'handshake-1',
      idempotencyKey: 'handshake-key-1',
      deadlineMs: 5_000,
      expectedCoordinator: coordinator,
      peer: client,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
    });
    expect(handshake).toMatchObject({ accepted: true, diagnostic: 'accepted' });

    const wrongPeer = dispatcher.handleHandshake({
      schema: 'kite.local-coordinator-handshake.v1',
      kind: 'handshake_request',
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      requestId: 'handshake-2',
      idempotencyKey: 'handshake-key-2',
      deadlineMs: 5_000,
      expectedCoordinator: coordinator,
      peer: client,
      peerOsIdentity: { kind: 'posix_uid', uid: 502 },
    });
    expect(wrongPeer).toMatchObject({ accepted: false, diagnostic: 'wrong_peer' });

    const wrongBuild = dispatcher.handleHandshake({
      schema: 'kite.local-coordinator-handshake.v1',
      kind: 'handshake_request',
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      requestId: 'handshake-3',
      idempotencyKey: 'handshake-key-3',
      deadlineMs: 5_000,
      expectedCoordinator: coordinator,
      peer: { ...client, buildId: 'other-build' },
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
    });
    expect(wrongBuild).toMatchObject({ accepted: false, diagnostic: 'wrong_build' });

    const response = await dispatcher.dispatch(request('status', {}), client);
    expect(response).toMatchObject({ method: 'status', outcome: 'ok' });
  });

  test('returns a typed deadline error and does not expose handler errors', async () => {
    const slowHandlers: CoordinatorDispatcherHandlers = {
      ...handlers(),
      status: async () => {
        await Bun.sleep(20);
        return { state: 'ready', identity: coordinator };
      },
    };
    const dispatcher = createCoordinatorDispatcher({
      identity: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      handlers: slowHandlers,
    });
    const response = await dispatcher.dispatch({ ...request('status', {}), deadlineMs: 1 }, client);
    expect(response).toMatchObject({
      outcome: 'error',
      error: { code: 'deadline_exceeded', diagnostic: 'expired' },
    });

    const invalidHandlers: CoordinatorDispatcherHandlers = {
      ...handlers(),
      status: () => ({ bad: 'not-a-status' }) as never,
    };
    const invalidDispatcher = createCoordinatorDispatcher({
      identity: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      handlers: invalidHandlers,
    });
    const invalidResponse = await invalidDispatcher.dispatch(request('status', {}), client);
    expect(invalidResponse).toMatchObject({
      outcome: 'error',
      error: { code: 'invalid_response' },
    });
    expect(JSON.stringify(invalidResponse)).not.toContain('not-a-status');
  });

  test('uses an injected transport through named client methods without mutation replay', async () => {
    const dispatcher = createCoordinatorDispatcher({
      identity: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      handlers: handlers(),
    });
    const clientApi = createCoordinatorRequestClient({
      transport: {
        handshake: async (frame) => dispatcher.handleHandshake(frame),
        request: async (frame) => dispatcher.dispatch(frame, client),
      },
      identity: client,
      expectedCoordinator: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      requestId: (() => {
        let count = 0;
        return () => `client-request-${++count}`;
      })(),
      idempotencyKey: (() => {
        let count = 0;
        return () => `client-key-${++count}`;
      })(),
    });
    expect((await clientApi.handshake()).accepted).toBe(true);
    expect((await clientApi.status()).outcome).toBe('ok');
    expect((await clientApi.resolveWorkspaceWorker({ workspace })).outcome).toBe('ok');
    expect((await clientApi.discoverWebGateway()).outcome).toBe('ok');
  });

  test('binds the authenticated peer role to method and capability purpose', async () => {
    const dispatcher = createCoordinatorDispatcher({
      identity: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: 501 },
      handlers: handlers(),
    });
    const forbiddenLifecycle = await dispatcher.dispatch(
      request('ensureWebGateway', {}),
      webGateway,
    );
    expect(forbiddenLifecycle).toMatchObject({
      outcome: 'error',
      error: { code: 'peer_identity_mismatch', diagnostic: 'wrong_peer' },
    });
    const forbiddenNativeCapability = await dispatcher.dispatch(
      request('mintWorkerConnectionCapability', {
        workspace,
        workerScopeId: worker.identity.workerScopeId,
        clientId: webGateway.instanceId,
        connectionGeneration: 1,
        purpose: 'native_client',
      }),
      webGateway,
    );
    expect(forbiddenNativeCapability).toMatchObject({ outcome: 'error' });
    const observerCapability = await dispatcher.dispatch(
      request('mintWorkerConnectionCapability', {
        workspace,
        workerScopeId: worker.identity.workerScopeId,
        clientId: webGateway.instanceId,
        connectionGeneration: 1,
        purpose: 'web_observer',
      }),
      webGateway,
    );
    expect(observerCapability).toMatchObject({ outcome: 'ok' });
  });
});

describe('Coordinator length-prefixed carrier', () => {
  test('runs the named request client over one authenticated local socket', async () => {
    const homeRoot = mkdtempSync(join(realpathSync(tmpdir()), 'kite-coordinator-client-'));
    temporaryRoots.push(homeRoot);
    const home = createKiteHomeIdentity(homeRoot);
    const endpoint = createCoordinatorUnixSocketEndpoint({
      endpointId: 'unix-client-1',
      ownerUid: process.getuid?.() ?? 501,
      coordinator,
    });
    const carrier = createCoordinatorCarrier({
      home,
      endpoint,
      dispatcher: createCoordinatorDispatcher({
        identity: coordinator,
        peerOsIdentity: { kind: 'posix_uid', uid: process.getuid?.() ?? 501 },
        handlers: handlers(),
      }),
      peerOsIdentity: { kind: 'posix_uid', uid: process.getuid?.() ?? 501 },
    });
    await carrier.start();
    const transport = createCoordinatorSocketRequestTransport({ home, endpoint });
    const clientApi = createCoordinatorRequestClient({
      transport,
      identity: client,
      expectedCoordinator: coordinator,
      peerOsIdentity: { kind: 'posix_uid', uid: process.getuid?.() ?? 501 },
    });
    await expect(clientApi.handshake()).resolves.toMatchObject({ accepted: true });
    await expect(clientApi.status()).resolves.toMatchObject({ outcome: 'ok' });
    await transport.close?.();
    await waitFor(() => carrier.activeConnections === 0);
    expect(carrier.activeConnections).toBe(0);
    await carrier.close();
  });

  test('serves a POSIX owner-only Unix socket and accepts fragmented handshake frames', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-coordinator-carrier-'));
    temporaryRoots.push(home);
    const diagnostics: string[] = [];
    const carrier = createCoordinatorCarrier({
      home: createKiteHomeIdentity(home),
      endpoint: createCoordinatorUnixSocketEndpoint({
        endpointId: 'unix-carrier-1',
        ownerUid: process.getuid?.() ?? 501,
        coordinator,
      }),
      dispatcher: createCoordinatorDispatcher({
        identity: coordinator,
        peerOsIdentity: { kind: 'posix_uid', uid: process.getuid?.() ?? 501 },
        handlers: handlers(),
      }),
      peerOsIdentity: { kind: 'posix_uid', uid: process.getuid?.() ?? 501 },
      handshakeDeadlineMs: 500,
      onDiagnostic: (code) => diagnostics.push(code),
    });
    await carrier.start();
    const socket = await new PosixCoordinatorCarrierAdapter().connect(carrier.address);
    const reader = frameReader(socket);
    const handshake = {
      schema: 'kite.local-coordinator-handshake.v1' as const,
      kind: 'handshake_request' as const,
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      requestId: 'carrier-handshake-1',
      idempotencyKey: 'carrier-handshake-key-1',
      deadlineMs: 500,
      expectedCoordinator: coordinator,
      peer: client,
      peerOsIdentity: { kind: 'posix_uid' as const, uid: process.getuid?.() ?? 501 },
    };
    const encoded = encodeCoordinatorWireFrame(handshake);
    await socket.write(encoded.slice(0, 3));
    await socket.write(encoded.slice(3));
    expect(await reader.next()).toMatchObject({ accepted: true, diagnostic: 'accepted' });
    await socket.write(encodeCoordinatorWireFrame(request('status', {})));
    expect(await reader.next()).toMatchObject({
      kind: 'response',
      method: 'status',
      outcome: 'ok',
    });
    const peerClosed = closed(socket);
    socket.end();
    await expect(
      Promise.race([
        peerClosed,
        Bun.sleep(250).then(() => {
          throw new Error('Coordinator server did not finish the peer half-close.');
        }),
      ]),
    ).resolves.toBeUndefined();
    expect(carrier.activeConnections).toBe(0);
    await carrier.close();
    expect(carrier.activeConnections).toBe(0);
    expect(diagnostics).not.toContain('malformed_frame');
  });

  test('fails closed for malformed, oversized, partial, and handshake-timeout connections', async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-coordinator-carrier-negative-'));
    temporaryRoots.push(home);
    const diagnostics: string[] = [];
    const peerUid = process.getuid?.() ?? 501;
    const carrier = createCoordinatorCarrier({
      home: createKiteHomeIdentity(home),
      endpoint: createCoordinatorUnixSocketEndpoint({
        endpointId: 'unix-carrier-negative-1',
        ownerUid: peerUid,
        coordinator,
      }),
      dispatcher: createCoordinatorDispatcher({
        identity: coordinator,
        peerOsIdentity: { kind: 'posix_uid', uid: peerUid },
        handlers: handlers(),
      }),
      peerOsIdentity: { kind: 'posix_uid', uid: peerUid },
      handshakeDeadlineMs: 15,
      onDiagnostic: (code) => diagnostics.push(code),
    });
    await carrier.start();
    const adapter = new PosixCoordinatorCarrierAdapter();

    const malformed = await adapter.connect(carrier.address);
    const malformedClosed = closed(malformed);
    await malformed.write(Uint8Array.from([0, 0, 0, 5, 0x7b, 0x78, 0x78, 0x78, 0x7d]));
    await malformedClosed;

    const oversized = await adapter.connect(carrier.address);
    const oversizedClosed = closed(oversized);
    const oversizedPrefix = new Uint8Array(4);
    new DataView(oversizedPrefix.buffer).setUint32(0, COORDINATOR_LIMITS.maxFrameBytes + 1, false);
    await oversized.write(oversizedPrefix);
    await oversizedClosed;

    const partial = await adapter.connect(carrier.address);
    const partialClosed = closed(partial);
    await partial.write(Uint8Array.from([0, 0]));
    partial.end();
    await partialClosed;

    const timeout = await adapter.connect(carrier.address);
    await closed(timeout);
    await carrier.close();
    expect(diagnostics).toContain('malformed_frame');
    expect(diagnostics).toContain('oversized_frame');
    expect(diagnostics).toContain('partial_frame');
    expect(diagnostics).toContain('handshake_timeout');
  });

  test('reports typed unsupported instead of falling back to TCP for named pipes', async () => {
    if (process.platform === 'win32') return;
    const endpoint = createCoordinatorNamedPipeEndpoint({
      endpointId: 'pipe-unsupported-1',
      userSid: 'S-1-5-21-100-200-300-400',
      coordinator,
    });
    const adapter = new WindowsCoordinatorCarrierAdapter();
    expect(adapter.supported).toBe(false);
    expect(() =>
      adapter.resolveAddress(createKiteHomeIdentity('/tmp/kite-coordinator'), endpoint),
    ).not.toThrow();
    const carrier = createCoordinatorCarrier({
      home: createKiteHomeIdentity('/tmp/kite-coordinator'),
      endpoint,
      dispatcher: createCoordinatorDispatcher({
        identity: coordinator,
        peerOsIdentity: { kind: 'windows_sid', sid: 'S-1-5-21-100-200-300-400' },
        handlers: handlers(),
      }),
      peerOsIdentity: { kind: 'windows_sid', sid: 'S-1-5-21-100-200-300-400' },
      adapter,
    });
    await expect(carrier.start()).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('Coordinator registry and path-free directory mirror', () => {
  test('allows one live Worker per scope and replaces only a dead owner', () => {
    const registry = createCoordinatorRegistry();
    const first = workerRegistration('worker-instance-1');
    registry.registerWorker(first);
    expect(() => registry.registerWorker(workerRegistration('worker-instance-2'))).toThrow();
    registry.markWorkerDead('worker-scope-1', 'worker-instance-1');
    expect(
      registry.registerWorker(workerRegistration('worker-instance-2')).identity.instanceId,
    ).toBe('worker-instance-2');
    expect(() => registry.markWorkerDead('worker-scope-1', 'worker-instance-1')).toThrow();
  });

  test('keeps Session metadata path-free, revisions observable, and Gateway singleton', () => {
    const registry = createCoordinatorRegistry();
    const changes: string[] = [];
    const subscription = registry.subscribeDirectoryChanges((change) => changes.push(change.kind));
    registry.upsertSessionMetadata({
      sessionId: 'session-1',
      workerScopeId: 'worker-scope-1',
      directoryRevision: 'session-revision-1',
      updatedAt: '2026-08-28T00:00:00.000Z',
      tombstone: false,
    });
    expect(JSON.stringify(registry.snapshot().sessions)).not.toContain('canonicalPath');
    expect(() =>
      registry.upsertSessionMetadata({
        sessionId: 'session-2',
        workerScopeId: 'worker-scope-1',
        directoryRevision: 'session-revision-2',
        updatedAt: '2026-08-28T00:00:00.000Z',
        tombstone: false,
        runtimeEvent: { body: 'must-not-enter-catalog' },
      } as never),
    ).toThrow();

    const gateway = gatewayRegistration('gateway-instance-1');
    registry.ensureWebGateway(gateway);
    expect(() => registry.ensureWebGateway(gatewayRegistration('gateway-instance-2'))).toThrow();
    expect(() => registry.stopWebGateway('gateway-instance-2')).toThrow();
    registry.stopWebGateway('gateway-instance-1');
    subscription.close();
    expect(registry.discoverWebGateway()).toBeNull();
    expect(changes).toContain('session_metadata_changed');
    expect(changes).toContain('gateway_changed');
    expect(Number(registry.snapshot().directoryRevision)).toBeGreaterThan(0);
  });

  test('reconciles only closed Worker/Gateway/Session facts', () => {
    const registry = createCoordinatorRegistry();
    const result = registry.reconcile({
      workers: [workerRegistration('worker-instance-reconcile')],
      sessions: [
        {
          sessionId: 'session-reconcile',
          workerScopeId: 'worker-scope-1',
          directoryRevision: 'session-revision-reconcile',
          updatedAt: '2026-08-28T00:00:00.000Z',
          tombstone: true,
        },
      ],
      gateway: gatewayRegistration('gateway-instance-reconcile'),
    });
    expect(result.workers).toHaveLength(1);
    expect(result.sessions).toHaveLength(1);
    expect(result.gateway?.identity.instanceId).toBe('gateway-instance-reconcile');
    expect(JSON.stringify(result)).not.toContain('prompt');
    expect(JSON.stringify(result)).not.toContain('credential');
  });
});

function frameReader(socket: CoordinatorCarrierSocket): {
  next(): Promise<CoordinatorWireFrame>;
} {
  const decoder = new CoordinatorLengthPrefixedFrameDecoder();
  const queue: CoordinatorWireFrame[] = [];
  const waiters: Array<{
    resolve: (frame: CoordinatorWireFrame) => void;
    reject: (error: Error) => void;
  }> = [];
  let closed = false;
  socket.onData((chunk) => {
    try {
      for (const frame of decoder.push(chunk)) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(frame);
        else queue.push(frame);
      }
    } catch (error) {
      const waiter = waiters.shift();
      if (waiter) waiter.reject(error instanceof Error ? error : new Error('frame decode failed'));
    }
  });
  const close = () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter.reject(new Error('socket closed'));
  };
  socket.onEnd(close);
  socket.onClose(close);
  return {
    next: () => {
      const frame = queue.shift();
      if (frame) return Promise.resolve(frame);
      if (closed) return Promise.reject(new Error('socket closed'));
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
  };
}

function closed(socket: CoordinatorCarrierSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.onClose(resolve);
    socket.onEnd(resolve);
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Coordinator connection did not close in time.');
    await Bun.sleep(5);
  }
}

function workerRegistration(instanceId: string): CoordinatorWorkerRegistration {
  return {
    identity: { ...worker.identity, instanceId },
    workspaceDigest: workspace.workspaceDigest,
    endpoint: worker.endpoint,
    state: 'ready',
    startedAt: '2026-08-28T00:00:00.000Z',
    lastSeenAt: '2026-08-28T00:00:01.000Z',
  };
}

function gatewayRegistration(instanceId: string): CoordinatorGatewayRegistration {
  return {
    identity: {
      role: 'web_gateway',
      instanceId,
      buildId: 'build-1',
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      protocolRevision: COORDINATOR_PROTOCOL_REVISION_,
      clientContractRevision: COORDINATOR_CLIENT_CONTRACT_REVISION_,
    },
    endpoint: { origin: 'http://127.0.0.1:43124' },
    state: 'ready',
    startedAt: '2026-08-28T00:00:00.000Z',
    lastSeenAt: '2026-08-28T00:00:01.000Z',
  };
}
