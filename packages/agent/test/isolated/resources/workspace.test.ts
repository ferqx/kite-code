import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWorkspaceSerialLocks } from '../../../src/resources';
import { acquireProfileAccess } from '../../../src/sqlite';

async function rejection(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string } | undefined)?.code).toBe(code);
}
function lines(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  let buffer = '';
  return async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          while (!buffer.includes('\n')) {
            const chunk = await reader.read();
            if (chunk.done) throw new Error('Child exited before readiness');
            buffer += new TextDecoder().decode(chunk.value);
          }
          const end = buffer.indexOf('\n');
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          return line;
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Child readiness timeout')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
  };
}
test('real Workspace OS key excludes frozen process, permits other keys, and releases on SIGKILL', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-workspace-lock-');
  chmodSync(dataRoot, 0o700);
  const locks = createWorkspaceSerialLocks({ dataRoot, profile: 'test' });
  const child = Bun.spawn(
    [process.execPath, new URL('./workspace-child.ts', import.meta.url).pathname],
    { env: { ...process.env, TEST_DATA_ROOT: dataRoot }, stdout: 'pipe', stderr: 'pipe' },
  );
  const line = lines(child.stdout);
  try {
    expect(await line()).toBe('started');
    expect(await line()).toBe('acquired');
    child.kill('SIGSTOP');
    const controller = new AbortController();
    let entered = false;
    const pending = locks
      .acquire({ workspaceId: 'w', key: 'write' }, controller.signal)
      .then((release) => {
        entered = true;
        return release;
      });
    const otherKey = await locks.acquire(
      { workspaceId: 'w', key: 'read' },
      new AbortController().signal,
    );
    const otherWorkspace = await locks.acquire(
      { workspaceId: 'other', key: 'write' },
      new AbortController().signal,
    );
    expect(entered).toBe(false);
    otherKey();
    otherWorkspace();
    controller.abort(new Error('cancelled candidate'));
    await pending.catch((error) => expect(error.message).toBe('cancelled candidate'));
    expect(entered).toBe(false);
    const acquired = locks.acquire(
      { workspaceId: 'w', key: 'write' },
      new AbortController().signal,
    );
    child.kill('SIGKILL');
    await child.exited;
    const release = await acquired;
    release();
    release();
    await locks.close();
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    await locks.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 10000);
test('lock descriptors are not inherited by spawned process and close drains active permits', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-workspace-close-');
  chmodSync(dataRoot, 0o700);
  const locks = createWorkspaceSerialLocks({ dataRoot, profile: 'test' });
  const held = await locks.acquire(
    { workspaceId: 'w', key: 'write' },
    new AbortController().signal,
  );
  const child = Bun.spawn(
    [process.execPath, new URL('./workspace-child.ts', import.meta.url).pathname],
    { env: { ...process.env, TEST_DATA_ROOT: dataRoot }, stdout: 'pipe', stderr: 'pipe' },
  );
  try {
    const line = lines(child.stdout);
    expect(await line()).toBe('started');
    held();
    expect(await line()).toBe('acquired');
    const active = await locks.acquire(
      { workspaceId: 'w', key: 'different' },
      new AbortController().signal,
    );
    child.kill('SIGKILL');
    await child.exited;
    const queued = locks.acquire(
      { workspaceId: 'w', key: 'different' },
      new AbortController().signal,
    );
    let closed = false;
    const closing = locks.close().then(() => {
      closed = true;
    });
    await rejection(
      locks.acquire({ workspaceId: 'w', key: 'new' }, new AbortController().signal),
      'resource_coordinator_closed',
    );
    await rejection(queued, 'resource_coordinator_closed');
    expect(closed).toBe(false);
    expect(() => acquireProfileAccess({ dataRoot, profile: 'test' }, 'exclusive')).toThrow('busy');
    active();
    await closing;
    expect(closed).toBe(true);
    const maintenance = acquireProfileAccess({ dataRoot, profile: 'test' }, 'exclusive');
    maintenance.lock.release();
  } finally {
    held();
    child.kill('SIGKILL');
    await child.exited;
    await locks.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
}, 10000);
test('Workspace waiters are bounded, cancelled without ownership, and unfinished restore journal blocks factory', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-workspace-bound-');
  chmodSync(dataRoot, 0o700);
  const locks = createWorkspaceSerialLocks({ dataRoot, profile: 'test' });
  const release = await locks.acquire(
    { workspaceId: 'w', key: 'write' },
    new AbortController().signal,
  );
  try {
    const controllers = Array.from({ length: 255 }, () => new AbortController());
    const pending = controllers.map((controller) =>
      locks.acquire({ workspaceId: 'w', key: 'write' }, controller.signal).catch(() => undefined),
    );
    await rejection(
      locks.acquire({ workspaceId: 'w', key: 'write' }, new AbortController().signal),
      'resource_queue_full',
    );
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    release();
    const next = await locks.acquire(
      { workspaceId: 'w', key: 'write' },
      new AbortController().signal,
    );
    next();
    await rejection(
      locks.acquire({ workspaceId: 'w', key: '\0bad' }, new AbortController().signal),
      'invalid_workspace_resource',
    );
    await locks.close();
    const access = acquireProfileAccess({ dataRoot, profile: 'test' });
    const journal = join(access.coordinationPath, 'restore-journal.json');
    access.lock.release();
    writeFileSync(journal, '{}', { mode: 0o600 });
    expect(() => createWorkspaceSerialLocks({ dataRoot, profile: 'test' })).toThrow(
      'restore_reconciliation_required',
    );
  } finally {
    release();
    await locks.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
