import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNativeKiteServiceManagerComposition } from '../../src/manager';
import {
  acquireLocalRuntimeServiceLock,
  clearLocalRuntimeServiceState,
  createKiteHomeIdentity,
  ensureLocalRuntimeServiceStateRoot,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
  publishLocalRuntimeServiceDescriptor,
  publishLocalRuntimeServiceToken,
} from '../../src/service';

describe('Native Kite Service manager composition', () => {
  test('binds lifecycle and access-only discovery to one explicit home', async () => {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'kite-native-manager-')));
    let fetchCalls = 0;
    try {
      const composition = createNativeKiteServiceManagerComposition({
        home: createKiteHomeIdentity(root),
        environment: {
          resolve: async () => ({ cwd: root, env: Object.freeze({}) }),
        },
        executableResolver: {
          resolve: async (mode) => ({ path: '/not-started', mode }),
        },
        fetch: async () => {
          fetchCalls += 1;
          throw new Error('unexpected network request');
        },
      });

      await expect(composition.manager.status()).resolves.toMatchObject({
        outcome: 'applied',
        operation: 'status',
        state: 'absent',
      });
      await expect(composition.clientState.readDescriptor()).resolves.toBeUndefined();
      await expect(composition.clientState.readToken('access')).resolves.toBeUndefined();
      expect(fetchCalls).toBe(0);
      expect(Object.keys(composition.clientState).sort()).toEqual(['readDescriptor', 'readToken']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'uses the authenticated instance handshake instead of echoing the disk descriptor',
    async () => {
      const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'kite-native-probe-')));
      const identity = createKiteHomeIdentity(root);
      const paths = ensureLocalRuntimeServiceStateRoot(identity);
      const instanceId = 'instance-native-probe';
      const descriptor = {
        schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
        instanceId,
        pid: process.pid,
        startedAt: '2026-08-27T00:00:00.000Z',
        endpoint: {
          origin: 'http://127.0.0.1:43123',
          websocketUrl: 'ws://127.0.0.1:43123/rpc',
        },
        protocolVersion: 1,
        clientContractRevision: 'kite-local-runtime-contract-v1',
        serverVersion: 'service-native-probe',
        buildId: 'build-native-probe',
      } as const;
      const instanceLock = {
        schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
        nonce: 'native-probe-lock',
        pid: process.pid,
        operation: 'start' as const,
        instanceId,
        createdAt: '2026-08-27T00:00:00.000Z',
      } as const;
      const accessToken = 'a'.repeat(32);
      const calls: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
      const handshake = {
        schema: 'kite.local-runtime.instance-handshake.v1',
        instanceId,
        protocolVersion: 1,
        clientContractRevision: 'kite-local-runtime-contract-v1',
        serverVersion: 'service-native-probe',
        buildId: 'build-native-probe',
      } as const;
      const lock = acquireLocalRuntimeServiceLock(paths, 'instance', instanceLock);
      publishLocalRuntimeServiceDescriptor(paths, descriptor);
      publishLocalRuntimeServiceToken(paths, 'access', accessToken);
      try {
        let response: {
          readonly schema: string;
          readonly instanceId: string;
          readonly protocolVersion: number;
          readonly clientContractRevision: string;
          readonly serverVersion: string;
          readonly buildId: string;
        } = handshake;
        const composition = createNativeKiteServiceManagerComposition({
          home: identity,
          environment: {
            resolve: async () => ({ cwd: root, env: Object.freeze({}) }),
          },
          executableResolver: {
            resolve: async (mode) => ({ path: '/not-started', mode }),
          },
          fetch: async (input, init) => {
            const url = String(input);
            calls.push({ url, init });
            if (url.endsWith('/readyz')) return new Response('ready', { status: 200 });
            if (!url.endsWith('/_kite/instance')) return new Response('not found', { status: 404 });
            return new Response(JSON.stringify(response), {
              status: 200,
              headers: { 'content-type': 'application/json; charset=utf-8' },
            });
          },
        });

        await expect(
          composition.manager.status({ requestId: 'native-probe-valid' }),
        ).resolves.toMatchObject({
          outcome: 'applied',
          state: 'ready',
        });
        expect(calls).toHaveLength(2);
        const handshakeCall = calls[1];
        expect(handshakeCall?.url).toBe('http://127.0.0.1:43123/_kite/instance');
        expect(handshakeCall?.init?.method).toBe('POST');
        expect(handshakeCall?.init?.body).toBe('{}');
        const headers = new Headers(handshakeCall?.init?.headers);
        expect(headers.get('authorization')).toBe(`Kite-Local-Access ${accessToken}`);
        expect(headers.get('content-type')).toBe('application/json');
        expect(handshakeCall?.init?.credentials).toBe('omit');

        // A live PID and a healthy /readyz response are insufficient when the listener is an
        // unrelated process. The manager must not copy instance identity from its stale file.
        response = { ...handshake, instanceId: 'unrelated-process' };
        await expect(
          composition.manager.status({ requestId: 'native-probe-mismatch' }),
        ).resolves.toMatchObject({
          outcome: 'unavailable',
          state: 'ready',
          diagnostic: 'identity_uncertain',
        });
      } finally {
        clearLocalRuntimeServiceState(paths, {
          descriptor,
          accessToken,
          instanceLock,
        });
        lock.release();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'fails closed on a malformed or non-instance handshake without stale cleanup',
    async () => {
      const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'kite-native-probe-')));
      const identity = createKiteHomeIdentity(root);
      const paths = ensureLocalRuntimeServiceStateRoot(identity);
      const descriptor = {
        schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
        instanceId: 'instance-malformed-probe',
        pid: process.pid,
        startedAt: '2026-08-27T00:00:00.000Z',
        endpoint: {
          origin: 'http://127.0.0.1:43124',
          websocketUrl: 'ws://127.0.0.1:43124/rpc',
        },
        protocolVersion: 1,
        clientContractRevision: 'kite-local-runtime-contract-v1',
        serverVersion: 'service-native-probe',
        buildId: 'build-native-probe',
      } as const;
      const instanceLock = {
        schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
        nonce: 'malformed-probe-lock',
        pid: process.pid,
        operation: 'start' as const,
        instanceId: descriptor.instanceId,
        createdAt: '2026-08-27T00:00:00.000Z',
      } as const;
      const accessToken = 'b'.repeat(32);
      const lock = acquireLocalRuntimeServiceLock(paths, 'instance', instanceLock);
      publishLocalRuntimeServiceDescriptor(paths, descriptor);
      publishLocalRuntimeServiceToken(paths, 'access', accessToken);
      try {
        const composition = createNativeKiteServiceManagerComposition({
          home: identity,
          environment: {
            resolve: async () => ({ cwd: root, env: Object.freeze({}) }),
          },
          executableResolver: {
            resolve: async (mode) => ({ path: '/not-started', mode }),
          },
          fetch: async (input) =>
            String(input).endsWith('/readyz')
              ? new Response('ready', { status: 200 })
              : new Response(JSON.stringify({ schema: 'wrong' }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                }),
        });
        await expect(
          composition.manager.status({ requestId: 'native-probe-malformed' }),
        ).resolves.toMatchObject({
          outcome: 'unavailable',
          state: 'ready',
          diagnostic: 'identity_uncertain',
        });
        expect(await composition.clientState.readDescriptor()).toEqual(descriptor);
        expect(await composition.clientState.readToken('access')).toBe(accessToken);
      } finally {
        clearLocalRuntimeServiceState(paths, {
          descriptor,
          accessToken,
          instanceLock,
        });
        lock.release();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
