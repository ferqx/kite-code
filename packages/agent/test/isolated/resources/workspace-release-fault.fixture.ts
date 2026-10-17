import { mock } from 'bun:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realLocks from '../../../src/platform/locks';
import * as realProfile from '../../../src/platform/profile';

const mode = process.argv[2]!;
const dataRoot = mkdtempSync(join(tmpdir(), 'kite-release-fault-'));
const profile = { dataRoot, profile: 'test' };
const acquireFileLock = realLocks.acquireFileLock;
const acquireProfileAccess = realProfile.acquireProfileAccess;
let injected = false;
let workspacePath = '';
const fault = new Error(`injected_${mode}_unlock_failure`);
mock.module('../../../src/platform/locks', () => ({
  ...realLocks,
  acquireFileLock(...args: Parameters<typeof acquireFileLock>) {
    const lock = acquireFileLock(...args);
    if (!mode.startsWith('workspace') || !lock.path.includes('/workspace-')) return lock;
    workspacePath = lock.path;
    return {
      ...lock,
      release() {
        if (!injected) {
          injected = true;
          throw fault;
        }
        lock.release();
      },
    };
  },
}));
mock.module('../../../src/platform/profile', () => ({
  ...realProfile,
  acquireProfileAccess(...args: Parameters<typeof acquireProfileAccess>) {
    const access = acquireProfileAccess(...args);
    if (mode !== 'profile') return access;
    return {
      ...access,
      lock: {
        ...access.lock,
        release() {
          if (!injected) {
            injected = true;
            throw fault;
          }
          access.lock.release();
        },
      },
    };
  },
}));
const { createWorkspaceSerialLocks } = await import('../../../src/platform/workspace-resources');
async function settled(promise: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => 'resolved',
        (error) => (error === fault ? 'fault' : String(error)),
      ),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('pending'), 150);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
try {
  const locks = createWorkspaceSerialLocks(profile);
  if (mode.startsWith('workspace')) {
    const release = await locks.acquire(
      { workspaceId: 'w', key: 'write' },
      new AbortController().signal,
    );
    let entered = false;
    const controller = new AbortController();
    const queued = locks.acquire({ workspaceId: 'w', key: 'write' }, controller.signal).then(
      (release) => {
        entered = true;
        release();
      },
      () => {},
    );
    const earlyClose = mode === 'workspace-closing' ? locks.close() : undefined;
    const earlyObserved = earlyClose && settled(earlyClose);
    assert.throws(release, (error) => error === fault);
    await Bun.sleep(40);
    assert.equal(entered, false);
    assert.throws(() => acquireFileLock(workspacePath, 'exclusive'), /busy/);
    assert.throws(() => acquireProfileAccess(profile, 'exclusive'), /busy/);
    if (earlyObserved) assert.equal(await earlyObserved, 'fault');
    else assert.equal(await settled(locks.close()), 'fault');
    await queued;
    release();
    release();
    assert.equal(await settled(locks.close()), 'resolved');
  } else {
    assert.equal(await settled(Promise.resolve().then(() => locks.close())), 'fault');
    assert.throws(() => acquireProfileAccess(profile, 'exclusive'), /busy/);
    assert.equal(await settled(locks.close()), 'resolved');
  }
  assert.equal(injected, true);
  await locks.close();
  const maintenance = acquireProfileAccess(profile, 'exclusive');
  maintenance.lock.release();
  console.log('fault recovered with real OS authority');
} finally {
  rmSync(dataRoot, { recursive: true, force: true });
}
