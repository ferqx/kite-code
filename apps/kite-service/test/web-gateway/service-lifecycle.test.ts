import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSingleServiceWebLifecycle,
  type SingleServiceWebRouteOwner,
} from '../../src/web-gateway/service-lifecycle';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Single-Service Web lifecycle', () => {
  test('returns web_assets_missing without creating route or auth state, then retries cleanly', async () => {
    const root = makeRoot(false);
    let creates = 0;
    const lifecycle = createSingleServiceWebLifecycle({
      createRouteOwner: () => {
        creates += 1;
        return fakeOwner('http://127.0.0.1:43170');
      },
    });

    await expect(lifecycle.ensure(root)).resolves.toEqual({
      outcome: 'unavailable',
      state: 'absent',
      diagnostic: 'web_assets_missing',
    });
    expect(creates).toBe(0);
    expect(lifecycle.assetIdentity).toBeUndefined();

    writeFileSync(join(root, 'assets', 'app.js'), 'export {};');
    await expect(lifecycle.ensure(root)).resolves.toMatchObject({
      outcome: 'ready',
      state: 'ready',
      origin: 'http://127.0.0.1:43170',
    });
    expect(creates).toBe(1);
    await lifecycle[Symbol.asyncDispose]();
  });

  test('single-flights concurrent ensure and returns a fresh in-memory launch URL to each caller', async () => {
    const root = makeRoot();
    let creates = 0;
    let closes = 0;
    const lifecycle = createSingleServiceWebLifecycle({
      createRouteOwner: async () => {
        creates += 1;
        await Promise.resolve();
        return fakeOwner('http://127.0.0.1:43171', () => {
          closes += 1;
        });
      },
    });

    const [first, second] = await Promise.all([lifecycle.ensure(root), lifecycle.ensure(root)]);
    expect(creates).toBe(1);
    expect(first.outcome).toBe('ready');
    expect(second.outcome).toBe('ready');
    if (first.outcome !== 'ready' || second.outcome !== 'ready') throw new Error('expected ready');
    expect(first.launchUrl).not.toBe(second.launchUrl);
    expect(first.assetDigest).toBe(second.assetDigest);
    expect(JSON.stringify(first)).not.toContain(root);
    const status = await lifecycle.status();
    expect(status.outcome).toBe('ready');
    expect(status.state).toBe('ready');
    if (status.state !== 'ready' || status.outcome !== 'ready') throw new Error('expected ready');
    expect(status).toEqual({
      outcome: 'ready',
      state: 'ready',
      origin: 'http://127.0.0.1:43171',
      assetDigest: second.assetDigest,
    });

    await expect(lifecycle.stop()).resolves.toEqual({
      outcome: 'applied',
      state: 'absent',
    });
    await expect(lifecycle.status()).resolves.toEqual({ outcome: 'ready', state: 'absent' });
    await expect(lifecycle.stop()).resolves.toEqual({
      outcome: 'noop',
      state: 'absent',
    });
    expect(closes).toBe(1);
  });

  test('clears a failed creation attempt and can replace changed assets without a second owner', async () => {
    const root = makeRoot();
    let attempts = 0;
    let activeOwners = 0;
    let maximumOwners = 0;
    const lifecycle = createSingleServiceWebLifecycle({
      createRouteOwner: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('injected readiness failure');
        activeOwners += 1;
        maximumOwners = Math.max(maximumOwners, activeOwners);
        return fakeOwner(`http://127.0.0.1:${43170 + attempts}`, () => {
          activeOwners -= 1;
        });
      },
    });

    await expect(lifecycle.ensure(root)).resolves.toEqual({
      outcome: 'unavailable',
      state: 'absent',
      diagnostic: 'web_readiness_failed',
    });
    const ready = await lifecycle.ensure(root);
    expect(ready.outcome).toBe('ready');
    expect(activeOwners).toBe(1);

    writeFileSync(join(root, 'assets', 'app.js'), 'export const changed = true;');
    const replaced = await lifecycle.ensure(root);
    expect(replaced.outcome).toBe('ready');
    expect(attempts).toBe(3);
    expect(activeOwners).toBe(1);
    expect(maximumOwners).toBe(1);
    await lifecycle[Symbol.asyncDispose]();
    expect(activeOwners).toBe(0);
  });

  test('preserves the exact current owner when missing assets or stop cleanup is uncertain', async () => {
    const root = makeRoot();
    let failClose = true;
    const lifecycle = createSingleServiceWebLifecycle({
      createRouteOwner: () =>
        fakeOwner('http://127.0.0.1:43174', () => {
          if (failClose) throw new Error('injected close failure');
        }),
    });
    expect((await lifecycle.ensure(root)).outcome).toBe('ready');

    rmSync(join(root, 'assets', 'app.js'));
    await expect(lifecycle.ensure(root)).resolves.toEqual({
      outcome: 'unavailable',
      state: 'ready',
      diagnostic: 'web_assets_missing',
    });
    expect(lifecycle.state).toBe('ready');
    await expect(lifecycle.stop()).resolves.toEqual({
      outcome: 'unavailable',
      state: 'ready',
      diagnostic: 'web_stop_failed',
    });

    failClose = false;
    await expect(lifecycle.stop()).resolves.toEqual({
      outcome: 'applied',
      state: 'absent',
    });
  });

  test('closes an exact route owner when launch readiness fails', async () => {
    const root = makeRoot();
    let closes = 0;
    const lifecycle = createSingleServiceWebLifecycle({
      createRouteOwner: () => ({
        origin: 'http://127.0.0.1:43175',
        mintLaunchUrl: () => {
          throw new Error('injected launch failure');
        },
        close: () => {
          closes += 1;
        },
      }),
    });

    await expect(lifecycle.ensure(root)).resolves.toEqual({
      outcome: 'unavailable',
      state: 'absent',
      diagnostic: 'web_readiness_failed',
    });
    expect(closes).toBe(1);
    expect(lifecycle.state).toBe('absent');
  });
});

function makeRoot(complete = true): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-single-service-web-')));
  roots.push(root);
  mkdirSync(join(root, 'api-docs'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<html></html>');
  writeFileSync(join(root, 'api-docs', 'openapi.json'), '{}');
  if (complete) writeFileSync(join(root, 'assets', 'app.js'), 'export {};');
  return root;
}

function fakeOwner(
  origin: string,
  close: () => void = () => undefined,
): SingleServiceWebRouteOwner {
  let launch = 0;
  return Object.freeze({
    origin,
    mintLaunchUrl: () => `${origin}/#launch-${++launch}`,
    close,
  });
}
