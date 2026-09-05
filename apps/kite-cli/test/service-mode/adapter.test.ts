import { describe, expect, test } from 'bun:test';
import type { KiteAppServerConnection } from '@kite-ai/kite-local-runtime/client';
import {
  connectKiteRuntimeMode,
  createKiteRuntimeModeAdapter,
  type KiteRuntimeModeConnector,
} from '../../src/service-mode';

describe('App Server runtime mode adapter', () => {
  test('projects one typed connection and closes it exactly once', async () => {
    const closeReasons: string[] = [];
    const connection = {
      runtime: { snapshotStore: {} },
      history: {},
      app: {},
      credential: {},
      snapshotStore: {},
      status: 'active',
      generation: 3,
      subscribe: () => () => undefined,
      prepareAppControl: async () => undefined,
      connect: async () => undefined,
      reconnect: async () => undefined,
      close: async (reason?: string) => {
        closeReasons.push(reason ?? '');
      },
      [Symbol.asyncDispose]: async () => undefined,
    } as unknown as KiteAppServerConnection;
    const adapter = createKiteRuntimeModeAdapter(connection);
    expect(adapter.runtime).toBe(connection.runtime);
    expect(adapter.history).toBe(connection.history);
    expect(adapter.appControl).toBe(connection.app);
    expect(adapter.credentialClient).toBe(connection.credential);
    expect(adapter.status).toBe('active');
    expect(adapter.generation).toBe(3);
    await adapter.close('test-close');
    await adapter.close('ignored');
    expect(closeReasons).toEqual(['test-close']);
  });

  test('connects only through the injected App Server connector', async () => {
    const calls: string[] = [];
    const connection = {
      runtime: { snapshotStore: {} },
      history: {},
      app: {},
      credential: {},
      snapshotStore: {},
      status: 'disconnected',
      generation: 0,
      subscribe: () => () => undefined,
      prepareAppControl: async () => undefined,
      connect: async () => undefined,
      reconnect: async () => undefined,
      close: async () => undefined,
      [Symbol.asyncDispose]: async () => undefined,
    } as unknown as KiteAppServerConnection;
    const connector: KiteRuntimeModeConnector = {
      connect: async ({ workspace }) => {
        calls.push(workspace);
        return connection;
      },
    };
    const adapter = await connectKiteRuntimeMode(connector, { workspace: '/workspace' });
    expect(adapter.connection).toBe(connection);
    expect(calls).toEqual(['/workspace']);
  });
});
