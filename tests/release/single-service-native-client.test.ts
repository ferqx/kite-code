import { describe, expect, test } from 'bun:test';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import { createSingleServiceNativeClientComposition } from '../../scripts/release/single-service-native-client';

describe('single-Service release client target', () => {
  test('binds custom homes to distinct legacy endpoints without a Web lifecycle surface', () => {
    const first = createSingleServiceNativeClientComposition({
      home: createKiteHomeIdentity('/tmp/kite-home-a'),
      runtimeParent: '/tmp/runtime-owner',
      platform: 'linux',
      expectedBuildId: 'build-1',
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
    expect(first).not.toHaveProperty('discoverWeb');
  });
});
