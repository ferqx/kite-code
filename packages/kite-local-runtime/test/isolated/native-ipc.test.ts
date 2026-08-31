import { describe, expect, test } from 'bun:test';
import {
  decodeKiteLocalNativeRequest,
  decodeKiteLocalNativeResponse,
  encodeKiteLocalNativeFrame,
  KITE_LOCAL_NATIVE_MAX_FRAME_BYTES,
  KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
  KITE_LOCAL_NATIVE_REQUEST_SCHEMA_,
  KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
} from '../../src/service';

describe('Single-Service Native IPC contract', () => {
  test('round-trips exact discovery', () => {
    const request = decodeKiteLocalNativeRequest({
      schema: KITE_LOCAL_NATIVE_REQUEST_SCHEMA_,
      requestId: 'request-1',
      operation: 'describe',
      protocolVersion: KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
      clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
      expectedBuildId: 'build-1',
    });
    expect(encodeKiteLocalNativeFrame(request)).toEndWith('\n');

    expect(
      decodeKiteLocalNativeResponse({
        schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
        requestId: 'request-1',
        operation: 'describe',
        outcome: 'ready',
        service: {
          instanceId: 'instance-1',
          pid: 42,
          startedAt: '2026-08-30T00:00:00.000Z',
          protocolVersion: KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
          clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
          serverVersion: 'service-1',
          buildId: 'build-1',
          httpOrigin: 'http://127.0.0.1:43170',
        },
        accessToken: 'a'.repeat(43),
      }),
    ).toMatchObject({ operation: 'describe', outcome: 'ready' });
  });

  test('rejects unknown fields, retired Web lifecycle operations, and oversized frames', () => {
    const base = {
      schema: KITE_LOCAL_NATIVE_REQUEST_SCHEMA_,
      requestId: 'request-1',
      operation: 'describe',
      protocolVersion: KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
      clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
      expectedBuildId: 'build-1',
    } as const;
    expect(() => decodeKiteLocalNativeRequest({ ...base, token: 'secret' })).toThrow();
    expect(() =>
      decodeKiteLocalNativeRequest({
        ...base,
        operation: 'web_ensure',
        staticAssetRoot: 'relative/assets',
      }),
    ).toThrow();
    expect(() =>
      decodeKiteLocalNativeResponse({
        schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
        requestId: 'request-2',
        operation: 'web_stop',
        outcome: 'applied',
        state: 'absent',
      }),
    ).toThrow();
    expect(() =>
      encodeKiteLocalNativeFrame({
        ...base,
        expectedBuildId: `build-${'x'.repeat(KITE_LOCAL_NATIVE_MAX_FRAME_BYTES)}`,
      }),
    ).toThrow(RangeError);
  });
});
