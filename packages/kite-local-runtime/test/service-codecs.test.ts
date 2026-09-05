import { describe, expect, test } from 'bun:test';
import {
  createKiteHomeIdentity,
  decodeLocalRuntimeServiceDescriptor,
  decodeLocalRuntimeToken,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
} from '@kite-ai/kite-local-runtime/service';
import { RUNTIME_PROTOCOL_VERSION } from '@kite-ai/runtime-protocol';

const descriptor = {
  schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  instanceId: 'instance-1',
  pid: 42,
  startedAt: '2026-08-27T00:00:00.000Z',
  endpoint: {
    origin: 'http://127.0.0.1:43123',
    websocketUrl: 'ws://127.0.0.1:43123/rpc',
  },
  protocolVersion: RUNTIME_PROTOCOL_VERSION,
  clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  serverVersion: '0.1.0',
  buildId: 'dev:0123456789012345678901234567890123456789',
} as const;

describe('kite-local-runtime service codecs', () => {
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

  test('validates bounded token material', () => {
    expect(decodeLocalRuntimeToken('A'.repeat(32))).toBe('A'.repeat(32));
    expect(() => decodeLocalRuntimeToken('too-short')).toThrow();
    expect(() => decodeLocalRuntimeToken(`${'A'.repeat(32)}.`)).toThrow();
  });
});

describe('kite-local-runtime profile identity', () => {
  test('requires an absolute explicit home identity', () => {
    expect(() => createKiteHomeIdentity('relative-home')).toThrow();
    expect(createKiteHomeIdentity('/tmp/kite-home', 'os_user_home').source).toBe('os_user_home');
  });
});
