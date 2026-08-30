import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCoordinatorStatePaths } from '@kite-ai/kite-local-runtime/coordinator';
import { createKiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';
import {
  readSqliteActiveLayoutPointer,
  resolveSqliteRuntimeLayoutPaths,
} from '@kite-ai/runtime-storage-sqlite';
import {
  createManagedLocalCoordinatorClientComposition,
  resolveCoordinatorPeerOsIdentity,
} from '../../scripts/release/local-coordinator-client';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('managed local Coordinator release composition', () => {
  test('uses only the explicit --kite-home and fails closed before a layout exists', async () => {
    const systemHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-system-')));
    const explicitHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-explicit-')));
    roots.push(systemHome, explicitHome);

    const composition = createManagedLocalCoordinatorClientComposition({
      argv: ['kite', '--kite-home', explicitHome],
      systemHome,
      readProcessStartIdentity: async () => undefined,
    });

    await expect(
      composition.lifecycle.status({ requestId: 'missing-layout-1' }),
    ).resolves.toMatchObject({
      requestId: 'missing-layout-1',
      operation: 'status',
      outcome: 'unavailable',
      diagnostic: 'identity_uncertain',
    });
    await expect(
      composition.lifecycle.status({ requestId: 'missing-layout-2' }),
    ).resolves.toMatchObject({
      requestId: 'missing-layout-2',
      operation: 'status',
      outcome: 'unavailable',
      diagnostic: 'identity_uncertain',
    });

    expect(existsSync(join(systemHome, '.kite-code'))).toBe(false);
    const state = resolveCoordinatorStatePaths(createKiteHomeIdentity(explicitHome));
    expect(existsSync(state.root)).toBe(true);
    expect(existsSync(state.lifecycleLock)).toBe(false);
  });

  test('rejects duplicate or non-absolute home arguments before creating a client', () => {
    const systemHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-args-')));
    roots.push(systemHome);

    expect(() =>
      createManagedLocalCoordinatorClientComposition({
        argv: ['kite', '--kite-home', '/tmp/one', '--kite-home', '/tmp/two'],
        systemHome,
        readProcessStartIdentity: async () => undefined,
      }),
    ).toThrow('--kite-home may be supplied only once');
    expect(() =>
      createManagedLocalCoordinatorClientComposition({
        argv: ['kite', '--kite-home', 'relative-home'],
        systemHome,
        readProcessStartIdentity: async () => undefined,
      }),
    ).toThrow('--kite-home requires an absolute path');
  });

  test('does not initialize a fresh layout without manager process identity', async () => {
    const systemHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-fresh-system-')));
    const explicitHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-fresh-home-')));
    roots.push(systemHome, explicitHome);
    const composition = createManagedLocalCoordinatorClientComposition({
      argv: ['kite', '--kite-home', explicitHome],
      systemHome,
      readProcessStartIdentity: async () => undefined,
    });
    await expect(
      composition.lifecycle.ensure({ requestId: 'fresh-ensure' }),
    ).resolves.toMatchObject({
      outcome: 'unavailable',
      diagnostic: 'identity_uncertain',
    });
    expect(
      readSqliteActiveLayoutPointer(resolveSqliteRuntimeLayoutPaths(explicitHome)),
    ).toBeUndefined();
  });

  test('starts and gracefully stops a real Coordinator through the authenticated v2 lifecycle', async () => {
    const systemHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-stop-system-')));
    const explicitHome = realpathSync(mkdtempSync(join(tmpdir(), 'kite-coordinator-stop-home-')));
    roots.push(systemHome, explicitHome);
    const composition = createManagedLocalCoordinatorClientComposition({
      argv: ['kite', '--kite-home', explicitHome],
      systemHome,
    });
    let started = false;
    try {
      const ensured = await composition.lifecycle.ensure({
        requestId: 'coordinator-v2-ensure',
        // The composition owns source/installed selection; callers cannot switch it.
        executableMode: 'installed',
      });
      expect(ensured).toMatchObject({ outcome: 'applied', state: 'ready' });
      started = ensured.outcome === 'applied';
      await expect(
        composition.lifecycle.stop({ requestId: 'coordinator-v2-stop' }),
      ).resolves.toMatchObject({
        operation: 'stop',
        outcome: 'applied',
        state: 'absent',
      });
      started = false;
    } finally {
      if (started) await composition.lifecycle.stop().catch(() => undefined);
    }
  });

  test('uses the native Windows SID seam only for a Windows platform', () => {
    let sidReads = 0;
    expect(
      resolveCoordinatorPeerOsIdentity(undefined, 'win32', () => {
        sidReads += 1;
        return 'S-1-5-21-100-200-300-400';
      }),
    ).toEqual({ kind: 'windows_sid', sid: 'S-1-5-21-100-200-300-400' });
    expect(sidReads).toBe(1);

    expect(
      resolveCoordinatorPeerOsIdentity(undefined, 'linux', () => {
        sidReads += 1;
        return 'S-1-5-21-100-200-300-400';
      }).kind,
    ).toBe('posix_uid');
    expect(sidReads).toBe(1);
  });
});
