import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createRuntime } from '../../../src';
import { openSqliteStore } from '../../../src/sqlite';

async function unlockFailure(action: Promise<unknown>) {
  const error = await action.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ message: 'fixture_session_unlock_failed' });
}

async function codeFailure(action: Promise<unknown>, code: string) {
  const error = await action.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toMatchObject({ code });
}

/** An isolated source-derived adapter; the Worker, SQL and every held OS lock are real. */
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-owner-release-')));
  const original = fileURLToPath(new URL('../../../src/sqlite.ts', import.meta.url));
  const rewritten = readFileSync(original, 'utf8')
    .replace(
      'acquireProfileAccess, acquireSessionLock,',
      'acquireProfileAccess, acquireSessionLock as actualAcquireSessionLock,',
    )
    .replace(
      /from (['"])(\.[^'"]+)\1/g,
      (_match, quote, specifier) => `from ${quote}${resolve(dirname(original), specifier)}${quote}`,
    )
    .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(original).href));
  const modulePath = join(root, 'sqlite-fault-fixture.ts');
  writeFileSync(
    modulePath,
    `${rewritten}
const fixtureHeld = new Set<FileLock>();
export const fixtureFaults = {
  remaining: 0, attempts: 0,
  cleanup() { for (const lock of fixtureHeld) { lock.release(); fixtureHeld.delete(lock); } },
};
function acquireSessionLock(...args: Parameters<typeof actualAcquireSessionLock>): FileLock {
  const lock = actualAcquireSessionLock(...args);
  fixtureHeld.add(lock);
  return { path: lock.path, mode: lock.mode, release() {
    fixtureFaults.attempts++;
    if (fixtureFaults.remaining > 0) { fixtureFaults.remaining--; throw Error('fixture_session_unlock_failed'); }
    lock.release(); fixtureHeld.delete(lock);
  } };
}
`,
  );
  const selected = (await import(pathToFileURL(modulePath).href)) as {
    openSqliteStore: typeof openSqliteStore;
    fixtureFaults: { remaining: number; attempts: number; cleanup(): void };
  };
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await selected.openSqliteStore(profile);
  const observer = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  await store.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: pathToFileURL(root).href,
  });
  await store.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'release facts',
  });
  const owner = (await store.acquireSessionOwner('s', 'host'))!;
  return {
    store,
    observer,
    owner,
    faults: selected.fixtureFaults,
    profile,
    expectedStoreId,
    async close() {
      selected.fixtureFaults.remaining = 0;
      await store.close().catch(() => {});
      selected.fixtureFaults.cleanup();
      await observer.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('a once-failed OS unlock retains its owner record until a repeated release really succeeds', async () => {
  const f = await fixture();
  try {
    f.faults.remaining = 1;
    await unlockFailure(f.store.releaseSessionOwner(f.owner));
    expect((await f.observer.getSession('s'))!.ownerInstanceId).toBeNull();
    expect(await f.observer.acquireSessionOwner('s', 'other')).toBeNull();
    expect(await f.store.releaseSessionOwner(f.owner)).toBe(true);
    expect(f.faults.attempts).toBe(2);
    const next = await f.observer.acquireSessionOwner('s', 'other');
    expect(next).not.toBeNull();
    expect(BigInt(next!.generation)).toBeGreaterThan(BigInt(f.owner.generation));
    expect(await f.observer.releaseSessionOwner(next!)).toBe(true);
  } finally {
    await f.close();
  }
});

test('an unconfirmed unlock cannot restore the logically released generation as live authority', async () => {
  const f = await fixture();
  try {
    f.faults.remaining = 2;
    await unlockFailure(f.store.releaseSessionOwner(f.owner));
    await codeFailure(f.store.acquireSessionOwner('s', 'host'), 'owner_busy');
    expect(
      await f.store.acceptCommand({
        expectedStoreId: f.expectedStoreId,
        commandId: 'later',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'new accepted input' },
      }),
    ).toBeDefined();
    await codeFailure(
      f.store.rejectCommand({
        expectedStoreId: f.expectedStoreId,
        owner: f.owner,
        commandId: 'later',
        reason: 'must not use released authority',
      }),
      'owner_changed',
    );
    await unlockFailure(f.store.releaseSessionOwner(f.owner));
    expect(await f.store.releaseSessionOwner(f.owner)).toBe(true);
    expect(f.faults.attempts).toBe(3);
  } finally {
    await f.close();
  }
});

test('close finishes a retained unlock after logical release without reacquiring the old generation', async () => {
  const f = await fixture();
  try {
    f.faults.remaining = 1;
    await unlockFailure(f.store.releaseSessionOwner(f.owner));
    await f.store.close();
    expect(f.faults.attempts).toBe(2);
    const next = await f.observer.acquireSessionOwner('s', 'other');
    expect(next).not.toBeNull();
    await f.observer.releaseSessionOwner(next!);
  } finally {
    await f.close();
  }
});

test('a failed close unlock stays observable and a second close retries only unfinished native cleanup', async () => {
  const f = await fixture();
  try {
    f.faults.remaining = 1;
    await unlockFailure(f.store.close());
    expect(await f.observer.acquireSessionOwner('s', 'other')).toBeNull();
    await codeFailure(f.store.getMetadata(), 'store_closed');
    await f.store.close();
    expect(f.faults.attempts).toBe(2);
    const next = await f.observer.acquireSessionOwner('s', 'other');
    expect(next).not.toBeNull();
    await f.observer.releaseSessionOwner(next!);
  } finally {
    await f.close();
  }
});

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('runtime_unlock_fixture_timeout');
    await Bun.sleep(5);
  }
}
for (const persistent of [false, true])
  test(`Runtime retains ${persistent ? 'persistent' : 'once-only'} unlock failure after completed work without replay`, async () => {
    const f = await fixture();
    const finish: Extract<ModelEvent, { type: 'finish' }> = {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    const model = createFixedModel([[finish]]);
    let disposals = 0;
    const runtime = createRuntime({
      store: f.store,
      instanceId: 'host',
      model,
      modelId: 'fixed',
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'owned' };
        },
      },
      async resolveRunConfiguration() {
        return {
          model,
          modelId: 'fixed',
          snapshot: {},
          async dispose() {
            disposals++;
          },
        };
      },
    });
    try {
      f.faults.remaining = persistent ? 3 : 1;
      await runtime.submitCommand({
        expectedStoreId: f.expectedStoreId,
        commandId: 'work',
        sessionId: 's',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'Complete the original task once.' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 5000 });
      await until(
        () => f.faults.attempts >= 1 && runtime.getLifecycleState().reasons.includes('cleanup'),
      );
      expect((await f.store.getView('s')).runs).toMatchObject([
        { status: 'completed', reason: null },
      ]);
      expect(model.requests).toHaveLength(1);
      expect(disposals).toBe(1);
      expect(f.faults.attempts).toBe(1);
      expect(runtime.getLifecycleState()).toMatchObject({ state: 'accepting', busy: true });
      expect(await f.observer.acquireSessionOwner('s', 'other')).toBeNull();
      const closing = runtime.close();
      expect(runtime.close()).toBe(closing);
      if (persistent) {
        const error = await closing.then(
          () => null,
          (error: unknown) => error,
        );
        expect(error).toMatchObject({ code: 'shutdown_cleanup_unconfirmed' });
        expect(runtime.getLifecycleState()).toMatchObject({ state: 'drain_failed', busy: true });
        expect(runtime.getLifecycleState().reasons).toContain('cleanup');
        expect((await f.store.getMetadata()).storeId).toBe(f.expectedStoreId);
        expect(await f.observer.acquireSessionOwner('s', 'other')).toBeNull();
        expect(runtime.close()).toBe(closing);
        expect(await runtime.close().catch((error: unknown) => error)).toBe(error);
      } else {
        await closing;
        expect(runtime.getLifecycleState()).toMatchObject({ state: 'closed', busy: false });
        const next = await f.observer.acquireSessionOwner('s', 'other');
        expect(next).not.toBeNull();
        expect(BigInt(next!.generation)).toBeGreaterThan(BigInt(f.owner.generation));
        await f.observer.releaseSessionOwner(next!);
      }
      expect(f.faults.attempts).toBe(2);
      expect(model.requests).toHaveLength(1);
      expect(disposals).toBe(1);
    } finally {
      await runtime.close().catch(() => {});
      await f.close();
    }
  });
