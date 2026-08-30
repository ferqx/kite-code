import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  createManagedSingleServiceNativeComposition,
  createSingleServiceNativeClientComposition,
} from '../../scripts/release/single-service-native-client';

describe('single-Service release client target', () => {
  test('binds custom homes to distinct endpoints and supplies CLI/TUI Web adapters', async () => {
    const operations: string[] = [];
    const first = createSingleServiceNativeClientComposition({
      home: createKiteHomeIdentity('/tmp/kite-home-a'),
      runtimeParent: '/tmp/runtime-owner',
      platform: 'linux',
      expectedBuildId: 'build-1',
      staticAssetRoot: '/bundle/web',
      request: async (_endpoint, request) => {
        operations.push(request.operation);
        return {
          schema: 'kite.local-native.response.v1',
          requestId: request.requestId,
          operation: 'web_ensure',
          outcome: 'ready',
          origin: 'http://127.0.0.1:43170',
          launchUrl: `http://127.0.0.1:43170/#${'a'.repeat(43)}`,
          assetDigest: '1'.repeat(64),
        };
      },
    });
    const second = createSingleServiceNativeClientComposition({
      home: createKiteHomeIdentity('/tmp/kite-home-b'),
      runtimeParent: '/tmp/runtime-owner',
      platform: 'linux',
      expectedBuildId: 'build-1',
      staticAssetRoot: '/bundle/web',
      request: async () => {
        throw new Error('not used');
      },
    });

    expect(first.endpoint.homeDigest).not.toBe(second.endpoint.homeDigest);
    expect(first.web.staticAssetRoot).toBe('/bundle/web');
    await expect(first.discoverWeb()).resolves.toBe(`http://127.0.0.1:43170/#${'a'.repeat(43)}`);
    expect(operations).toEqual(['web_ensure']);
  });

  test('rejects an implicit relative asset root', () => {
    expect(() =>
      createSingleServiceNativeClientComposition({
        home: createKiteHomeIdentity('/tmp/kite-home-a'),
        runtimeParent: '/tmp/runtime-owner',
        platform: 'linux',
        expectedBuildId: 'build-1',
        staticAssetRoot: 'apps/kite-web/dist',
      }),
    ).toThrow('must be absolute');
  });

  test('returns web_assets_missing before any endpoint request or child spawn', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-web-preflight-')));
    let requests = 0;
    try {
      const composition = createManagedSingleServiceNativeComposition({
        home: createKiteHomeIdentity(join(root, 'home')),
        runtimeParent: root,
        platform: 'linux',
        expectedBuildId: 'build-1',
        staticAssetRoot: root,
        executable: { path: '/missing/service', mode: 'source' },
        cwd: root,
        env: {},
        request: async () => {
          requests += 1;
          throw new Error('must not request endpoint');
        },
      });
      await expect(composition.web.client.ensureWeb(root)).resolves.toMatchObject({
        outcome: 'unavailable',
        state: 'absent',
        diagnostic: 'web_assets_missing',
      });
      expect(requests).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
