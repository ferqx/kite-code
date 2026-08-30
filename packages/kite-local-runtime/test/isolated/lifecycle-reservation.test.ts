import { afterEach, describe, expect, test } from 'bun:test';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearDeadKiteLocalRuntimeEndpoint,
  createKiteHomeIdentity,
  encodeKiteLocalRuntimeLifecycleReservation,
  KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
  readKiteLocalRuntimeLifecycleReservation,
  resolveKiteLocalRuntimeEndpoint,
} from '../../src/service';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          if (!server.listening) resolvePromise();
          else server.close(() => resolvePromise());
        }),
    ),
  );
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('single-Service lifecycle reservation', () => {
  test('preserves alive evidence and clears only the same dead PID/start/socket identity', async () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-lifecycle-parent-')));
    roots.push(parent);
    const endpoint = resolveKiteLocalRuntimeEndpoint({
      home: createKiteHomeIdentity(join(parent, 'home')),
      runtimeParent: parent,
      platform: process.platform,
    });
    if (endpoint.kind !== 'unix') throw new Error('expected Unix endpoint');
    mkdirSync(endpoint.root, { recursive: true, mode: 0o700 });
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(endpoint.socket, resolvePromise);
    });
    const socket = lstatSync(endpoint.socket);
    const expected = {
      schema: KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
      pid: 42_001,
      processStartIdentity: 'process-start-1',
      instanceId: 'service-1',
      buildId: 'build-1',
      startedAt: '2026-08-30T00:00:00.000Z',
      socketDevice: socket.dev,
      socketInode: socket.ino,
    } as const;
    writeFileSync(
      endpoint.lifecycleReservation,
      encodeKiteLocalRuntimeLifecycleReservation(expected),
      { flag: 'wx', mode: 0o600 },
    );
    expect(readKiteLocalRuntimeLifecycleReservation(endpoint)).toEqual(expected);

    await expect(
      clearDeadKiteLocalRuntimeEndpoint({
        endpoint,
        expected,
        process: { inspect: async () => 'alive' },
      }),
    ).resolves.toEqual({ outcome: 'blocked', diagnostic: 'alive' });
    expect(readKiteLocalRuntimeLifecycleReservation(endpoint)).toEqual(expected);

    await expect(
      clearDeadKiteLocalRuntimeEndpoint({
        endpoint,
        expected,
        process: { inspect: async () => 'dead' },
      }),
    ).resolves.toEqual({ outcome: 'cleared' });
    expect(readKiteLocalRuntimeLifecycleReservation(endpoint)).toBeUndefined();
  });

  test('keeps identity-drifted evidence even with dead proof for the old owner', async () => {
    const parent = realpathSync.native(mkdtempSync(join(tmpdir(), 'kite-lifecycle-drift-')));
    roots.push(parent);
    const endpoint = resolveKiteLocalRuntimeEndpoint({
      home: createKiteHomeIdentity(join(parent, 'home')),
      runtimeParent: parent,
      platform: process.platform,
    });
    if (endpoint.kind !== 'unix') throw new Error('expected Unix endpoint');
    mkdirSync(endpoint.root, { recursive: true, mode: 0o700 });
    const current = {
      schema: KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
      pid: 42_002,
      processStartIdentity: 'process-start-new',
      instanceId: 'service-new',
      buildId: 'build-1',
      startedAt: '2026-08-30T00:00:01.000Z',
    } as const;
    writeFileSync(
      endpoint.lifecycleReservation,
      encodeKiteLocalRuntimeLifecycleReservation(current),
      { flag: 'wx', mode: 0o600 },
    );
    await expect(
      clearDeadKiteLocalRuntimeEndpoint({
        endpoint,
        expected: { ...current, instanceId: 'service-old' },
        process: { inspect: async () => 'dead' },
      }),
    ).resolves.toEqual({ outcome: 'blocked', diagnostic: 'drift' });
    expect(readKiteLocalRuntimeLifecycleReservation(endpoint)).toEqual(current);
  });
});
