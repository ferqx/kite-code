import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  createKiteHomeIdentity,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
} from '@kite-ai/kite-local-runtime/service';
import { createKiteServiceManagerNativeLifecycleLockPort } from '../../src/manager/native-lock';
import { createKiteServiceManagerNativeStatePort } from '../../src/manager/native-state';

function descriptor() {
  return {
    schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
    instanceId: 'native-instance',
    pid: 7321,
    startedAt: '2026-08-27T00:00:00.000Z',
    endpoint: {
      origin: 'http://127.0.0.1:43123',
      websocketUrl: 'ws://127.0.0.1:43123/rpc',
    },
    protocolVersion: 1,
    clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
    serverVersion: 'service-1',
    buildId: 'build-1',
  } as const;
}

function temporaryHome(): string {
  // The Native primitive intentionally rejects symlinked path components; keep the fixture under
  // this repository instead of macOS /var/tmp, where /var is commonly a symlink.
  return mkdtempSync(join(import.meta.dir, '.kite-service-manager-home-'));
}

describe('Kite Service manager Native adapters', () => {
  test('binds state to an explicit home identity and clears only exact published entries', async () => {
    const home = temporaryHome();
    try {
      const state = createKiteServiceManagerNativeStatePort(
        createKiteHomeIdentity(home, 'explicit_argument'),
      );
      await state.publishDescriptor(descriptor());
      await state.publishToken('access', 'a'.repeat(32));
      await state.publishToken('control', 'c'.repeat(32));

      expect(await state.readDescriptor()).toMatchObject({ instanceId: 'native-instance' });
      expect(await state.readToken('access')).toBe('a'.repeat(32));
      expect(await state.readToken('control')).toBe('c'.repeat(32));

      await state.clearStale();
      expect(await state.readDescriptor()).toBeUndefined();
      expect(await state.readToken('access')).toBeUndefined();
      expect(await state.readToken('control')).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('uses dead-only quarantine for a lifecycle lock and never kills its owner', async () => {
    const home = temporaryHome();
    let inspectedPid: number | undefined;
    try {
      const process = {
        async inspect(pid: number) {
          inspectedPid = pid;
          return 'dead' as const;
        },
      };
      const lock = createKiteServiceManagerNativeLifecycleLockPort({
        identity: createKiteHomeIdentity(home, 'explicit_argument'),
        process,
      });
      const first = await lock.acquire('ensure');
      expect(first).toBeDefined();
      expect(await lock.acquire('status')).toBeUndefined();
      expect(await lock.inspect()).toMatchObject({ status: 'dead' });
      expect(inspectedPid).toBeGreaterThan(0);

      await lock.quarantineStale();
      const replacement = await lock.acquire('ensure');
      expect(replacement).toBeDefined();
      await replacement?.release();
      // There is intentionally no kill/terminate port in the adapter surface.
      expect('kill' in process).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
