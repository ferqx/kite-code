import { describe, expect, test } from 'bun:test';
import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
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
  connectKiteServiceMode,
  createKiteServiceModeAdapter,
  type KiteServiceModeConnector,
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
