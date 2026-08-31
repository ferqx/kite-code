import { describe, expect, test } from 'bun:test';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createManagedSingleServiceNativeComposition,
  createSingleServiceNativeClientComposition,
} from '../../scripts/release/single-service-native-client';

describe('single-Service release client target', () => {
  test('binds custom homes to distinct endpoints and derives the stable Web root', async () => {
    const operations: string[] = [];
    const first = createSingleServiceNativeClientComposition({
      home: createKiteHomeIdentity('/tmp/kite-home-a'),
      runtimeParent: '/tmp/runtime-owner',
      platform: 'linux',
      expectedBuildId: 'build-1',
      request: async (_endpoint, request) => {
        operations.push(request.operation);
        return {
          schema: 'kite.local-native.response.v1',
          requestId: request.requestId,
          operation: 'describe',
          outcome: 'ready',
          service: {
            instanceId: 'instance-1',
            pid: 42,
            startedAt: '2026-08-31T00:00:00.000Z',
            protocolVersion: 1,
            clientContractRevision: 'kite-local-runtime-contract-v1',
            serverVersion: 'service-1',
            buildId: 'build-1',
            httpOrigin: 'http://127.0.0.1:43170',
          },
          accessToken: 'a'.repeat(43),
        };
      },
    });
    const second = createSingleServiceNativeClientComposition({
      home: createKiteHomeIdentity('/tmp/kite-home-b'),
      runtimeParent: '/tmp/runtime-owner',
      platform: 'linux',
      expectedBuildId: 'build-1',
      request: async () => {
        throw new Error('not used');
      },
    });

    expect(first.endpoint.homeDigest).not.toBe(second.endpoint.homeDigest);
    await expect(first.discoverWeb()).resolves.toBe('http://127.0.0.1:43170/');
    expect(operations).toEqual(['describe']);
  });

  test('rejects a managed relative or mismatched Service asset root', () => {
    expect(() =>
      createManagedSingleServiceNativeComposition({
        home: createKiteHomeIdentity('/tmp/kite-home-a'),
        runtimeParent: '/tmp/runtime-owner',
        platform: 'linux',
        expectedBuildId: 'build-1',
        staticAssetRoot: 'apps/kite-web/dist',
        executable: { path: '/missing/service', mode: 'source' },
        cwd: '/tmp/runtime-owner',
        env: {},
      }),
    ).toThrow('must be absolute');
    expect(() =>
      createManagedSingleServiceNativeComposition({
        home: createKiteHomeIdentity('/tmp/kite-home-a'),
        runtimeParent: '/tmp/runtime-owner',
        platform: 'linux',
        expectedBuildId: 'build-1',
        staticAssetRoot: '/bundle/web',
        executable: { path: '/missing/service', mode: 'source' },
        cwd: '/tmp/runtime-owner',
        env: { KITE_SERVICE_WEB_STATIC_ROOT: '/different/web' },
      }),
    ).toThrow('does not match');
  });
});
