import { describe, expect, test } from 'bun:test';
import { createKiteSingleServiceClient, KiteSingleServiceClientError } from '../src/client';
import {
  createKiteHomeIdentity,
  KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
  type KiteLocalNativeResponse,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  resolveKiteLocalRuntimeEndpoint,
} from '../src/service';

const endpoint = resolveKiteLocalRuntimeEndpoint({
  home: createKiteHomeIdentity('/tmp/kite-single-service-client-home'),
  runtimeParent: '/tmp',
  platform: 'linux',
});

describe('Single-Service native client', () => {
  test('sends one exact request per operation and preserves typed Web diagnostics', async () => {
    const requests: Array<{ operation: string; requestId: string }> = [];
    const responses: KiteLocalNativeResponse[] = [
      {
        schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
        requestId: 'request-1',
        operation: 'describe',
        outcome: 'ready',
        service: {
          instanceId: 'instance-1',
          pid: 42,
          startedAt: '2026-08-30T00:00:00.000Z',
          protocolVersion: 1,
          clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
          serverVersion: 'service-1',
          buildId: 'build-1',
          httpOrigin: 'http://127.0.0.1:43170',
        },
        accessToken: 'a'.repeat(43),
      },
      {
        schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
        requestId: 'request-2',
        operation: 'web_ensure',
        outcome: 'unavailable',
        state: 'absent',
        diagnostic: 'web_assets_missing',
      },
      {
        schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
        requestId: 'request-3',
        operation: 'web_stop',
        outcome: 'noop',
        state: 'absent',
      },
    ];
    let identity = 0;
    const client = createKiteSingleServiceClient({
      endpoint,
      expectedBuildId: 'build-1',
      requestId: () => `request-${++identity}`,
      request: async (_endpoint, request) => {
        requests.push({ operation: request.operation, requestId: request.requestId });
        return responses.shift()!;
      },
    });

    await expect(client.describe()).resolves.toMatchObject({ outcome: 'ready' });
    await expect(client.ensureWeb('/absolute/web')).resolves.toEqual({
      schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
      requestId: 'request-2',
      operation: 'web_ensure',
      outcome: 'unavailable',
      state: 'absent',
      diagnostic: 'web_assets_missing',
    });
    await expect(client.stopWeb()).resolves.toMatchObject({ outcome: 'noop' });
    expect(requests).toEqual([
      { operation: 'describe', requestId: 'request-1' },
      { operation: 'web_ensure', requestId: 'request-2' },
      { operation: 'web_stop', requestId: 'request-3' },
    ]);
  });

  test('does not retry rejected or operation-confused responses', async () => {
    let calls = 0;
    const client = createKiteSingleServiceClient({
      endpoint,
      expectedBuildId: 'build-1',
      requestId: () => 'request-rejected',
      request: async () => {
        calls += 1;
        return {
          schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
          requestId: 'request-rejected',
          operation: 'rejected',
          outcome: 'rejected',
          diagnostic: 'incompatible',
        };
      },
    });
    await expect(client.stopService()).rejects.toMatchObject({
      diagnostic: 'incompatible',
    });
    expect(calls).toBe(1);

    const confused = createKiteSingleServiceClient({
      endpoint,
      expectedBuildId: 'build-1',
      requestId: () => 'request-confused',
      request: async () => ({
        schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
        requestId: 'request-confused',
        operation: 'web_stop',
        outcome: 'noop',
        state: 'absent',
      }),
    });
    await expect(confused.describe()).rejects.toEqual(
      new KiteSingleServiceClientError('invalid_response'),
    );
  });
});
