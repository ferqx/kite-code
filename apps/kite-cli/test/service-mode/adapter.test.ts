import { describe, expect, test } from 'bun:test';
import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  WORKER_CONTROLLER_RESPONSE_SCHEMA_,
  type WorkerControllerClient,
  type WorkerControllerDurableOperation,
  type WorkerControllerMutationResponse,
} from '@kite-ai/kite-app-contract/worker-controller';
import type {
  LocalKiteConnection,
  LocalKiteConnectionStatus,
} from '@kite-ai/kite-local-runtime/client';
import { LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ } from '@kite-ai/kite-local-runtime/client';
import type { LocalRuntimeServiceDescriptor } from '@kite-ai/kite-local-runtime/service';
import type {
  RuntimeClientConnection,
  RuntimeClientTransport,
  RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import { RuntimeClient } from '@kite-ai/runtime-client';
import type { RuntimeNotification, RuntimeSessionProjection } from '@kite-ai/runtime-contract';
import {
  acquireKiteServiceModeController,
  connectKiteServiceMode,
  createKiteServiceModeAdapter,
  createKiteServiceModeSession,
  detachKiteServiceModeController,
  type KiteServiceModeConnector,
  releaseKiteServiceModeController,
} from '../../src/service-mode';

const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/tmp/service-mode-workspace',
  projectId: 'service-mode-project',
  workspaceDigest: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
};

describe('Kite Service mode CLI adapter', () => {
  test('keeps the typed Runtime, History and App Control seams and reflects connection state', async () => {
    const fixture = createFixture();
    const adapter = createKiteServiceModeAdapter({ connection: fixture.connection });
    const observed: number[] = [];
    const unsubscribe = adapter.subscribeSnapshot(() => {
      observed.push(adapter.snapshotStore.getSnapshot().connectionGeneration);
    });

    fixture.runtime.snapshotStore.setConnection({
      generation: 1,
      status: 'active',
      serverInstanceId: 'service-1',
    });
    fixture.runtime.snapshotStore.beginIndexReset({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      serverInstanceId: 'service-1',
      indexRevision: 9,
    });
    fixture.runtime.snapshotStore.applyIndexSession({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      indexRevision: 9,
      session: sessionProjection(7),
    });
    fixture.runtime.snapshotStore.endIndexReset({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      indexRevision: 9,
    });
    fixture.runtime.snapshotStore.applySessionNotification({
      connectionGeneration: 1,
      subscriptionGeneration: 1,
      notification: ephemeralNotification(1),
    });

    expect(adapter.runtime).toBe(fixture.runtime);
    expect(adapter.history).toBe(fixture.history);
    expect(adapter.appControl).toBe(fixture.appControl);
    expect(adapter.snapshotStore.getSnapshot()).toMatchObject({
      connectionGeneration: 1,
      status: 'active',
      index: { ready: true, indexRevision: 9 },
      sessions: { 'session-1': { ready: false, projection: { revision: 7 } } },
    });
    expect(Object.keys(adapter.snapshotStore.getSnapshot().streams)).toHaveLength(1);

    // A new connection generation atomically drops the old index/readiness and
    // every ephemeral stream.  No adapter-side cache can resurrect them.
    fixture.generation = 2;
    fixture.status = 'reconnecting';
    fixture.runtime.snapshotStore.setConnection({ generation: 2, status: 'reconnecting' });
    expect(adapter.generation).toBe(2);
    expect(adapter.snapshotStore.getSnapshot()).toMatchObject({
      connectionGeneration: 2,
      status: 'reconnecting',
      index: { ready: false, indexRevision: 0 },
      sessions: {},
      streams: {},
    });

    // Re-subscription/index reset may legitimately establish a lower current
    // revision from the replacement Service instance.
    fixture.status = 'active';
    fixture.runtime.snapshotStore.setConnection({
      generation: 2,
      status: 'active',
      serverInstanceId: 'service-2',
    });
    fixture.runtime.snapshotStore.beginIndexReset({
      connectionGeneration: 2,
      subscriptionGeneration: 1,
      serverInstanceId: 'service-2',
      indexRevision: 1,
    });
    fixture.runtime.snapshotStore.applyIndexSession({
      connectionGeneration: 2,
      subscriptionGeneration: 1,
      indexRevision: 1,
      session: sessionProjection(1),
    });
    fixture.runtime.snapshotStore.endIndexReset({
      connectionGeneration: 2,
      subscriptionGeneration: 1,
      indexRevision: 1,
    });
    fixture.runtime.snapshotStore.markSessionReady({
      connectionGeneration: 2,
      subscriptionGeneration: 1,
      sessionId: 'session-1',
    });
    await Bun.sleep(0);
    expect(adapter.snapshotStore.getSnapshot()).toMatchObject({
      connectionGeneration: 2,
      status: 'active',
      index: { ready: true, indexRevision: 1 },
      sessions: { 'session-1': { ready: true, projection: { revision: 1 } } },
      streams: {},
    });
    expect(observed).toContain(2);
    unsubscribe();
    await adapter.close();
  });

  test('delegates reconnect and close without issuing a Runtime cancellation or closing a Session', async () => {
    const fixture = createFixture();
    const adapter = createKiteServiceModeAdapter(fixture.connection);

    await adapter.reconnect();
    await adapter.close();
    await adapter.close();

    expect(fixture.reconnectCalls).toBe(1);
    expect(fixture.closeCalls).toEqual(['service_mode_client_closed']);
    expect(fixture.commandCalls).toHaveLength(0);
    expect(adapter.status).toBe('closed');
  });

  test('connects only through an explicit connector and propagates connector failure', async () => {
    const fixture = createFixture();
    const workspaces: string[] = [];
    const connector: KiteServiceModeConnector = {
      connect: async (input) => {
        workspaces.push(input.workspace);
        return fixture.connection;
      },
    };
    const adapter = await connectKiteServiceMode(connector, {
      workspace: workspace.canonicalPath,
    });
    expect(workspaces).toEqual([workspace.canonicalPath]);
    expect(adapter.credentialClient).toBe(fixture.connection.credential);
    await adapter.close();

    const failure = new Error('service unavailable');
    await expect(
      connectKiteServiceMode(
        { connect: async () => Promise.reject(failure) },
        { workspace: workspace.canonicalPath },
      ),
    ).rejects.toBe(failure);
  });

  test('keeps a failed client close observable without retrying an uncertain teardown', async () => {
    const fixture = createFixture();
    const failure = new Error('connection close failed');
    let closeAttempts = 0;
    const connection: LocalKiteConnection = {
      ...fixture.connection,
      close: async () => {
        closeAttempts += 1;
        throw failure;
      },
    };
    const adapter = createKiteServiceModeAdapter(connection);

    await expect(adapter.close()).rejects.toBe(failure);
    await expect(adapter.close()).rejects.toBe(failure);
    await expect(adapter.reconnect()).rejects.toThrow('closed');
    expect(closeAttempts).toBe(1);
  });

  test('acquires only an exact native Controller lease and detaches/releases without Runtime commands', async () => {
    const fixture = createFixture();
    let status: 'idle' | 'active' = 'idle';
    let controllerGeneration = 0;
    const calls: string[] = [];
    const controller: WorkerControllerClient = {
      async createSession() {
        throw new Error('unused');
      },
      async read(request) {
        calls.push(`read:${request.sessionId}`);
        return {
          schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
          operation: 'read_controller',
          state: {
            sessionId: request.sessionId,
            status,
            controllerGeneration,
            connectionGeneration: status === 'active' ? 4 : 0,
            clientId: status === 'active' ? 'native-client' : null,
            workerInstanceId: status === 'active' ? fixture.connection.service.instanceId : null,
            interactionGeneration: 0,
            resumeCapabilityExpiresAtMs: null,
          },
        };
      },
      async requestControl(request) {
        calls.push(`request:${request.sessionId}`);
        status = 'active';
        controllerGeneration = 1;
        return {
          schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
          operation: 'request_control',
          status: 'applied',
          receipt: {
            schema: 'kite.app.worker-controller.receipt.v1',
            sessionId: request.sessionId,
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            operation: 'request_control',
            status: 'applied',
            code: 'acquired',
            controllerGeneration,
            connectionGeneration: 4,
            interactionGeneration: 0,
            clientId: 'native-client',
            workerInstanceId: fixture.connection.service.instanceId,
            completedAt: 1,
          },
          lease: {
            sessionId: request.sessionId,
            clientId: 'native-client',
            connectionGeneration: 4,
            controllerGeneration,
            workerInstanceId: fixture.connection.service.instanceId,
            status: 'active',
          },
        };
      },
      async releaseControl(request) {
        calls.push(`release:${request.sessionId}`);
        status = 'idle';
        return {
          schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
          operation: 'release_control',
          status: 'applied',
          receipt: {
            schema: 'kite.app.worker-controller.receipt.v1',
            sessionId: request.sessionId,
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            operation: 'release_control',
            status: 'applied',
            code: 'released',
            controllerGeneration: 2,
            connectionGeneration: 4,
            interactionGeneration: 0,
            clientId: 'native-client',
            workerInstanceId: fixture.connection.service.instanceId,
            completedAt: 2,
          },
        };
      },
      async detach(request) {
        calls.push(`detach:${request.sessionId}`);
        return {
          schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
          operation: 'detach_controller',
          status: 'applied',
          receipt: {
            schema: 'kite.app.worker-controller.receipt.v1',
            sessionId: request.sessionId,
            requestId: request.requestId,
            requestDigest: request.requestDigest,
            operation: 'detach_controller',
            status: 'applied',
            code: 'detached',
            controllerGeneration,
            connectionGeneration: 4,
            interactionGeneration: request.interactionGeneration,
            clientId: 'native-client',
            workerInstanceId: fixture.connection.service.instanceId,
            completedAt: 3,
          },
        };
      },
      issueResumeCapability: async () => {
        throw new Error('unused');
      },
      resume: async () => {
        throw new Error('unused');
      },
      mintDetachedRecoveryCapability: async () => {
        throw new Error('unused');
      },
      abandonDetachedController: async () => {
        throw new Error('unused');
      },
      validateResumeCapability: async () => ({
        schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
        operation: 'validate_resume_capability',
        status: 'missing',
      }),
    };
    const connection = { ...fixture.connection, controller };
    const lease = await acquireKiteServiceModeController(connection, 'session-1');
    expect(lease).toMatchObject({
      sessionId: 'session-1',
      clientId: 'native-client',
      connectionGeneration: 4,
      controllerGeneration: 1,
    });
    expect(calls).toEqual(['read:session-1', 'request:session-1', 'read:session-1']);
    await detachKiteServiceModeController(connection, lease);
    expect(calls).toContain('detach:session-1');
    status = 'active';
    await expect(acquireKiteServiceModeController(connection, 'session-1')).rejects.toThrow(
      'already owned',
    );
    await releaseKiteServiceModeController(connection, lease).catch(() => undefined);
    expect(fixture.commandCalls).toHaveLength(0);
  });

  test('tracks separate Session leases on one authenticated connection and rejects foreign or stale state', async () => {
    const fixture = createFixture();
    const states = new Map<string, TestControllerState>();
    const calls: string[] = [];
    const controller = createControllerClient(states, calls, fixture.connection.service.instanceId);
    const connection = { ...fixture.connection, controller };

    const first = await acquireKiteServiceModeController(connection, 'session-one');
    const second = await acquireKiteServiceModeController(connection, 'session-two');
    expect(first.sessionId).toBe('session-one');
    expect(second.sessionId).toBe('session-two');
    expect(first.controllerGeneration).toBe(1);
    expect(second.controllerGeneration).toBe(1);
    await expect(acquireKiteServiceModeController(connection, 'session-one')).resolves.toBe(first);

    states.set('foreign-session', {
      status: 'active',
      controllerGeneration: 7,
      connectionGeneration: 9,
      interactionGeneration: 0,
      clientId: 'foreign-client',
      workerInstanceId: fixture.connection.service.instanceId,
    });
    await expect(
      acquireKiteServiceModeController(connection, 'foreign-session'),
    ).rejects.toMatchObject({ code: 'busy' });

    states.set('session-one', {
      ...states.get('session-one')!,
      controllerGeneration: 2,
    });
    await expect(acquireKiteServiceModeController(connection, 'session-one')).rejects.toMatchObject(
      { code: 'busy' },
    );
    expect(calls).toEqual([
      'read:session-one',
      'request:session-one',
      'read:session-one',
      'read:session-two',
      'request:session-two',
      'read:session-two',
      'read:session-one',
      'read:foreign-session',
      'read:session-one',
    ]);
  });

  test('creates a Session and generation-one Controller through one atomic native use case', async () => {
    const fixture = createFixture();
    const states = new Map<string, TestControllerState>();
    const calls: string[] = [];
    const controller = createControllerClient(states, calls, fixture.connection.service.instanceId);
    const connection = { ...fixture.connection, controller };

    const created = await createKiteServiceModeSession(connection, 'session-created');
    expect(created).toMatchObject({
      sessionRevision: 1,
      lease: { sessionId: 'session-created', controllerGeneration: 1 },
    });
    expect(calls).toEqual(['create:session-created']);
    await expect(acquireKiteServiceModeController(connection, 'session-created')).resolves.toBe(
      created.lease,
    );
  });
});

function createFixture(): {
  readonly runtime: RuntimeClient;
  readonly history: RuntimeHistoryClient;
  readonly appControl: KiteAppControlClient;
  readonly connection: LocalKiteConnection;
  generation: number;
  status: LocalKiteConnectionStatus;
  reconnectCalls: number;
  closeCalls: string[];
  commandCalls: unknown[];
} {
  const transport: RuntimeClientTransport = {
    connect: async (): Promise<RuntimeClientConnection> => {
      throw new Error('test transport is not connected');
    },
  };
  const runtime = new RuntimeClient({
    transport,
    clientInfo: { name: 'service-mode-test', version: '0.0.0', instanceId: 'client-1' },
  });
  const history = {
    listSessions: async () => ({ entries: [], hasMore: false }),
    listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
    loadSession: async () => {
      throw new Error('not used');
    },
  } as RuntimeHistoryClient;
  const appControl = {} as KiteAppControlClient;
  const descriptor: LocalRuntimeServiceDescriptor = {
    schema: 'kite.local-runtime-service.v1',
    instanceId: 'service-instance-1',
    pid: 1234,
    startedAt: '2026-08-27T00:00:00.000Z',
    endpoint: {
      origin: 'http://127.0.0.1:43123',
      websocketUrl: 'ws://127.0.0.1:43123/rpc',
    },
    protocolVersion: 1,
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    serverVersion: 'test-service',
    buildId: 'test-build',
  };
  const fixture: {
    readonly runtime: RuntimeClient;
    readonly history: RuntimeHistoryClient;
    readonly appControl: KiteAppControlClient;
    connection?: LocalKiteConnection;
    generation: number;
    status: LocalKiteConnectionStatus;
    reconnectCalls: number;
    closeCalls: string[];
    commandCalls: unknown[];
  } = {
    runtime,
    history,
    appControl,
    generation: 1,
    status: 'active',
    reconnectCalls: 0,
    closeCalls: [] as string[],
    commandCalls: [] as unknown[],
  };
  const connection: LocalKiteConnection = {
    runtime,
    history,
    app: appControl,
    credential: {
      writeProviderCredential: async () => ({
        schema: 'kite.local-runtime-credential-result.v1',
        mutationId: 'credential-test',
        operation: 'write_provider_api_key',
        outcome: 'applied',
        credentialPresent: true,
        revision: 'credential-revision',
      }),
    } as unknown as LocalKiteConnection['credential'],
    service: descriptor,
    snapshotStore: runtime.snapshotStore,
    subscribe: (listener) => runtime.snapshotStore.subscribe(listener),
    get status() {
      return fixture.status;
    },
    get generation() {
      return fixture.generation;
    },
    prepareAppControl: async () => undefined,
    connect: async () => undefined,
    reconnect: async () => {
      fixture.reconnectCalls += 1;
    },
    close: async (reason) => {
      fixture.closeCalls.push(reason ?? '');
      fixture.status = 'closed';
    },
    [Symbol.asyncDispose]: async () => {
      await connection.close('async_dispose');
    },
  };
  fixture.connection = connection;
  return fixture as typeof fixture & { readonly connection: LocalKiteConnection };
}

function sessionProjection(revision: number): RuntimeSessionProjection {
  return {
    schema: 'kite.runtime-projection.v1',
    sessionId: 'session-1',
    revision,
    workspace: workspace.canonicalPath,
    lifecycle: 'open',
    interactionQueue: { revision, interactions: [] },
  };
}

function ephemeralNotification(
  sequence: number,
): Extract<RuntimeNotification, { durability: 'ephemeral' }> {
  return {
    schema: 'kite.runtime-notification.v1',
    durability: 'ephemeral',
    sessionId: 'session-1',
    workId: 'work-1',
    turnId: 'turn-1',
    actorId: 'actor-1',
    attemptId: 'attempt-1',
    compositionRevision: 'composition-1',
    streamId: 'stream-1',
    sequence,
    event: { type: 'model.text_delta', requestId: 'request-1', text: 'hello' },
  };
}

interface TestControllerState {
  status: 'idle' | 'active' | 'detached';
  controllerGeneration: number;
  connectionGeneration: number;
  interactionGeneration: number;
  clientId: string | null;
  workerInstanceId: string | null;
}

function createControllerClient(
  states: Map<string, TestControllerState>,
  calls: string[],
  workerInstanceId: string,
): WorkerControllerClient {
  const stateFor = (sessionId: string): TestControllerState => {
    const existing = states.get(sessionId);
    if (existing) return existing;
    const initial: TestControllerState = {
      status: 'idle',
      controllerGeneration: 0,
      connectionGeneration: 0,
      interactionGeneration: 0,
      clientId: null,
      workerInstanceId: null,
    };
    states.set(sessionId, initial);
    return initial;
  };
  const operation = (
    request: {
      readonly sessionId: string;
      readonly requestId: string;
      readonly requestDigest: string;
    },
    name: WorkerControllerDurableOperation,
    result: TestControllerState,
  ): WorkerControllerMutationResponse => ({
    schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
    operation: name,
    status: 'applied',
    receipt: {
      schema: 'kite.app.worker-controller.receipt.v1',
      sessionId: request.sessionId,
      requestId: request.requestId,
      requestDigest: request.requestDigest,
      operation: name,
      status: 'applied',
      code: name === 'request_control' ? 'acquired' : 'released',
      controllerGeneration: result.controllerGeneration,
      connectionGeneration: result.connectionGeneration,
      interactionGeneration: result.interactionGeneration,
      clientId: result.clientId,
      workerInstanceId: result.workerInstanceId,
      completedAt: 1,
    },
    lease: {
      sessionId: request.sessionId,
      clientId: result.clientId!,
      connectionGeneration: result.connectionGeneration,
      controllerGeneration: result.controllerGeneration,
      workerInstanceId,
      status: 'active',
    },
  });

  return {
    async createSession(request) {
      calls.push(`create:${request.sessionId}`);
      const created: TestControllerState = {
        status: 'active',
        controllerGeneration: 1,
        connectionGeneration: 9,
        interactionGeneration: 0,
        clientId: 'native-client',
        workerInstanceId,
      };
      states.set(request.sessionId, created);
      const durable = operation(request, 'request_control', created);
      return { ...durable, operation: 'create_session', sessionRevision: 1 };
    },
    async read(request) {
      calls.push(`read:${request.sessionId}`);
      const state = stateFor(request.sessionId);
      return {
        schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
        operation: 'read_controller',
        state: {
          sessionId: request.sessionId,
          status: state.status,
          controllerGeneration: state.controllerGeneration,
          connectionGeneration: state.connectionGeneration,
          clientId: state.clientId,
          workerInstanceId: state.workerInstanceId,
          interactionGeneration: state.interactionGeneration,
          resumeCapabilityExpiresAtMs: null,
        },
      };
    },
    async requestControl(request) {
      calls.push(`request:${request.sessionId}`);
      const state = stateFor(request.sessionId);
      if (state.status === 'active') {
        throw new Error('controller busy');
      }
      const next: TestControllerState = {
        ...state,
        status: 'active',
        controllerGeneration: state.controllerGeneration + 1,
        connectionGeneration: 9,
        clientId: 'native-client',
        workerInstanceId,
      };
      states.set(request.sessionId, next);
      return operation(request, 'request_control', next);
    },
    releaseControl: async () => {
      throw new Error('unused');
    },
    detach: async () => {
      throw new Error('unused');
    },
    issueResumeCapability: async () => {
      throw new Error('unused');
    },
    resume: async () => {
      throw new Error('unused');
    },
    mintDetachedRecoveryCapability: async () => {
      throw new Error('unused');
    },
    abandonDetachedController: async () => {
      throw new Error('unused');
    },
    validateResumeCapability: async () => ({
      schema: WORKER_CONTROLLER_RESPONSE_SCHEMA_,
      operation: 'validate_resume_capability',
      status: 'missing',
    }),
  };
}
