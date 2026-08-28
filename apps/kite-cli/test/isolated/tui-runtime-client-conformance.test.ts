import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import type {
  LocalKiteConnection,
  LocalRuntimeServiceDescriptor,
} from '@kite-ai/kite-local-runtime/client';
import { LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_ } from '@kite-ai/kite-local-runtime/client';
import type {
  RuntimeClientConnection,
  RuntimeClientTransport,
  RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import { RuntimeClient } from '@kite-ai/runtime-client';
import { createNativeTuiRuntimeClient } from '../../src/service-mode';

const workspace = '/tmp/tui-runtime-client-contract';

test('TUI runtime facade consumes only an injected Native connection and exposes closed client methods', async () => {
  const fixture = createConnectionFixture();
  const facade = createNativeTuiRuntimeClient({
    connection: fixture.connection,
    workspace,
  });

  expect(Object.keys(facade).sort()).toEqual([
    'abortAll',
    'applyPersistedModelRoute',
    'buildContextStatusSnapshot',
    'cancelRuntimeOperations',
    'clearSessionCommandGrants',
    'createSession',
    'deletePersistedSession',
    'dispose',
    'executeRewind',
    'forkRecoveredSessionForContinuation',
    'generateAndPersistSessionName',
    'getActiveId',
    'getRuntime',
    'getSessionProjection',
    'getSnapshot',
    'handleContextCompaction',
    'handleContextDisplay',
    'handleContextReset',
    'hasRuntime',
    'listPersistedSessions',
    'listRewindCheckpoints',
    'loadPersistedSession',
    'onInterruptPending',
    'onStatusChange',
    'previewRewind',
    'registerSession',
    'removeRuntime',
    'saveTokenStats',
    'setName',
    'setSnapshotCallback',
    'shutdownObservability',
    'submitUserAction',
    'switchSession',
    'waitForSessionReady',
  ]);
  expect(facade.getSnapshot()).toEqual([]);
  expect(facade.hasRuntime('missing-session')).toBe(false);
  expect(facade.getRuntime('missing-session')).toBeUndefined();

  const source = readFileSync(
    new URL('../../src/service-mode/tui-client.ts', import.meta.url),
    'utf8',
  );
  expect(source).not.toContain("from '#kite-service/");
  expect(source).not.toContain('SessionManager');

  await facade.dispose();
  expect(fixture.closeReasons).toEqual(['tui_client_closed']);
});

function createConnectionFixture(): {
  readonly connection: LocalKiteConnection;
  readonly closeReasons: string[];
} {
  const transport: RuntimeClientTransport = {
    connect: async (): Promise<RuntimeClientConnection> => {
      throw new Error('TUI facade fixture transport is not connected');
    },
  };
  const runtime = new RuntimeClient({
    transport,
    clientInfo: { name: 'tui-runtime-client-test', version: '1', instanceId: 'tui-client' },
  });
  const history = {
    listSessions: async () => ({ entries: [], hasMore: false }),
    listEvents: async () => ({ entries: [], hasMore: false, observedLastSequence: 0 }),
    loadSession: async () => {
      throw new Error('history is not used by this contract fixture');
    },
  } as RuntimeHistoryClient;
  const closeReasons: string[] = [];
  const descriptor: LocalRuntimeServiceDescriptor = {
    schema: 'kite.local-runtime-service.v1',
    instanceId: 'service-instance',
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
  const connection: LocalKiteConnection = {
    runtime,
    history,
    app: {} as KiteAppControlClient,
    credential: {
      writeProviderCredential: async () => {
        throw new Error('credential is not used by this contract fixture');
      },
    },
    service: descriptor,
    status: 'active',
    generation: 1,
    snapshotStore: runtime.snapshotStore,
    subscribe: (listener) => runtime.snapshotStore.subscribe(listener),
    prepareAppControl: async () => undefined,
    connect: async () => undefined,
    reconnect: async () => undefined,
    close: async (reason) => {
      closeReasons.push(reason ?? '');
    },
    [Symbol.asyncDispose]: async () => undefined,
  };
  return { connection, closeReasons };
}
