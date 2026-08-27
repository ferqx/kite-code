import { describe, expect, test } from 'bun:test';
import { KITE_APP_CONTRACT_REVISION_ } from '@kite-ai/kite-app-contract';
import {
  createKiteHomeIdentity,
  decodeLocalRuntimeServiceDescriptor,
  decodeLocalRuntimeToken,
  decodeLocalServiceLockIdentity,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
  resolveLocalRuntimeServiceStatePaths,
  safeDecodeLocalRuntimeServiceDescriptor,
} from '@kite-ai/kite-local-runtime/service';

const descriptor = {
  schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  instanceId: 'instance-1',
  pid: 42,
  startedAt: '2026-08-27T00:00:00.000Z',
  endpoint: {
    origin: 'http://127.0.0.1:43123',
    websocketUrl: 'ws://127.0.0.1:43123/rpc',
  },
  protocolVersion: 1,
  clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  serverVersion: '0.1.0',
  buildId: 'dev:0123456789012345678901234567890123456789',
} as const;

describe('kite-local-runtime service codecs', () => {
  test('binds the native handshake to the exact App Contract revision', () => {
    expect(LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_).toBe(
      `kite-local-runtime-contract-v2+${KITE_APP_CONTRACT_REVISION_}`,
    );
    expect(
      safeDecodeLocalRuntimeServiceDescriptor({
        ...descriptor,
        clientContractRevision: 'kite-local-runtime-contract-v1',
      }),
    ).toMatchObject({ success: false });
  });

  test('accepts the exact descriptor and rejects secret/path additions', () => {
    expect(decodeLocalRuntimeServiceDescriptor(descriptor)).toEqual(descriptor);
    expect(() =>
      decodeLocalRuntimeServiceDescriptor({ ...descriptor, accessToken: 'secret' }),
    ).toThrow();
    expect(() =>
      decodeLocalRuntimeServiceDescriptor({
        ...descriptor,
        endpoint: { ...descriptor.endpoint, origin: 'http://localhost:43123' },
      }),
    ).toThrow();
    expect(() =>
      decodeLocalRuntimeServiceDescriptor({
        ...descriptor,
        endpoint: { ...descriptor.endpoint, websocketUrl: 'ws://127.0.0.1:43124/rpc' },
      }),
    ).toThrow();
  });

  test('safe descriptor decoding is fail closed', () => {
    expect(safeDecodeLocalRuntimeServiceDescriptor(descriptor)).toMatchObject({ success: true });
    expect(safeDecodeLocalRuntimeServiceDescriptor({ ...descriptor, pid: 0 })).toMatchObject({
      success: false,
    });
  });

  test('validates lock identity and bounded token material', () => {
    expect(
      decodeLocalServiceLockIdentity({
        schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
        nonce: 'nonce-1',
        pid: 42,
        operation: 'ensure',
        createdAt: descriptor.startedAt,
      }),
    ).toMatchObject({ operation: 'ensure' });
    expect(() =>
      decodeLocalServiceLockIdentity({
        schema: LOCAL_RUNTIME_SERVICE_LOCK_SCHEMA_,
        nonce: 'nonce-1',
        pid: 42,
        operation: 'kill',
        createdAt: descriptor.startedAt,
      }),
    ).toThrow();
    expect(decodeLocalRuntimeToken('A'.repeat(32))).toBe('A'.repeat(32));
    expect(() => decodeLocalRuntimeToken('too-short')).toThrow();
    expect(() => decodeLocalRuntimeToken(`${'A'.repeat(32)}.`)).toThrow();
  });
});

describe('kite-local-runtime service state layout', () => {
  test('derives the fixed state root without reading or mutating files', () => {
    const identity = createKiteHomeIdentity('/tmp/kite-local-runtime-test');
    expect(resolveLocalRuntimeServiceStatePaths(identity)).toEqual({
      root: '/tmp/kite-local-runtime-test/runtime-service/v1',
      descriptor: '/tmp/kite-local-runtime-test/runtime-service/v1/instance.json',
      accessToken: '/tmp/kite-local-runtime-test/runtime-service/v1/access.token',
      controlToken: '/tmp/kite-local-runtime-test/runtime-service/v1/control.token',
      instanceLock: '/tmp/kite-local-runtime-test/runtime-service/v1/instance.lock',
      lifecycleLock: '/tmp/kite-local-runtime-test/runtime-service/v1/lifecycle.lock',
    });
  });

  test('requires an absolute explicit home identity', () => {
    expect(() => createKiteHomeIdentity('relative-home')).toThrow();
    expect(createKiteHomeIdentity('/tmp/kite-home', 'os_user_home').source).toBe('os_user_home');
  });
});
