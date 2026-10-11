import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { openSqliteStore } from '../../../src/sqlite';
import type { WorkerRequest } from '../../../src/storage/worker/protocol';

const NativeWorker = globalThis.Worker;

/** Real SQLite Worker; only selected reply delivery is held at the host boundary. */
class GatedWorker extends NativeWorker {
  readonly posted: WorkerRequest[] = [];
  readonly held: MessageEvent[] = [];
  readonly queries = new Set<number>();
  holdQueries = false;
  holdAll = false;
  private heldThreshold: { count: number; resolve: () => void } | undefined;
  private postedThreshold: { count: number; resolve: () => void } | undefined;
  constructor(...args: ConstructorParameters<typeof NativeWorker>) {
    super(...args);
    this.addEventListener('message', (event: MessageEvent) => {
      if (this.holdAll || (this.holdQueries && this.queries.has(event.data.id))) {
        event.stopImmediatePropagation();
        this.held.push(event);
        if (this.heldThreshold && this.held.length >= this.heldThreshold.count) {
          this.heldThreshold.resolve();
          this.heldThreshold = undefined;
        }
      }
    });
  }
  override postMessage(message: unknown, transfer: Transferable[]): void;
  override postMessage(message: unknown, options?: StructuredSerializeOptions): void;
  override postMessage(
    message: unknown,
    options?: Transferable[] | StructuredSerializeOptions,
  ): void {
    const frame = message as WorkerRequest;
    this.posted.push(frame);
    if (frame.method === 'getMetadata') this.queries.add(frame.id);
    if (Array.isArray(options)) super.postMessage(message, options);
    else super.postMessage(message, options);
    if (this.postedThreshold && this.posted.length >= this.postedThreshold.count) {
      this.postedThreshold.resolve();
      this.postedThreshold = undefined;
    }
  }
  releaseQueries(): void {
    this.holdQueries = false;
    this.holdAll = false;
    for (const event of this.held.splice(0)) this.onmessage?.(event);
  }
  waitForHeld(count: number): Promise<void> {
    if (this.held.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.heldThreshold = { count, resolve };
    });
  }
  releaseHeld(count: number): void {
    for (const event of this.held.splice(0, count)) this.onmessage?.(event);
  }
  waitForPosted(count: number): Promise<void> {
    if (this.posted.length >= count) return Promise.resolve();
    return new Promise((resolve) => {
      this.postedThreshold = { count, resolve };
    });
  }
}

async function fixture() {
  const dataRoot = mkdtempSync('/private/tmp/kite-store-backpressure-');
  chmodSync(dataRoot, 0o700);
  let worker: GatedWorker | undefined;
  class SelectedWorker extends GatedWorker {
    constructor(...args: ConstructorParameters<typeof NativeWorker>) {
      super(...args);
      worker = this;
    }
  }
  globalThis.Worker = SelectedWorker;
  const profile = { dataRoot, profile: 'owned' };
  try {
    const store = await openSqliteStore(profile);
    return {
      profile,
      store,
      worker: worker!,
      async dispose() {
        worker!.releaseQueries();
        await store.close().catch(() => {});
        globalThis.Worker = NativeWorker;
        rmSync(dataRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    globalThis.Worker = NativeWorker;
    rmSync(dataRoot, { recursive: true, force: true });
    throw error;
  }
}

test('real Store backpressures ordinary requests, preserves control reservation, rechecks owner and drains pre-close calls', async () => {
  const f = await fixture();
  try {
    const expectedStoreId = (await f.store.getMetadata()).storeId;
    await f.store.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: 'file:///owned',
      name: 'w',
    });
    await f.store.createSession({
      expectedStoreId,
      commandId: 'create',
      sessionId: 's',
      workspaceId: 'w',
      title: 'backpressure',
      subjectId: 'user',
    });
    const owner = (await f.store.acquireSessionOwner('s', 'owner'))!;
    f.worker.holdQueries = true;
    const before = f.worker.posted.length;
    const queries = Array.from({ length: 226 }, () => f.store.getMetadata());
    const stale = f.store
      .startRun({ expectedStoreId, owner, commandId: 'unused', configuration: {} })
      .catch((error: unknown) => error);
    expect(f.worker.posted.slice(before).map((frame) => frame.method)).toEqual(
      Array(224).fill('getMetadata'),
    );
    expect(await f.store.releaseSessionOwner(owner)).toBe(true);
    expect(f.worker.posted.at(-1)?.method).toBe('releaseSessionOwner');
    const closing = f.store.close();
    expect(f.store.close()).toBe(closing);
    expect(f.worker.posted.some((frame) => frame.method === 'close')).toBe(false);
    expect(await f.store.getMetadata().catch((error: unknown) => error)).toMatchObject({
      code: 'store_closed',
    });
    f.worker.releaseQueries();
    expect((await Promise.all(queries)).map((metadata) => metadata.storeId)).toEqual(
      Array(226).fill(expectedStoreId),
    );
    expect(await stale).toMatchObject({ code: 'owner_changed' });
    await closing;
    expect(f.worker.posted.at(-1)?.method).toBe('close');
    expect(f.worker.posted.filter((frame) => frame.method === 'startRun')).toHaveLength(0);
    expect(new Set(f.worker.posted.map((frame) => frame.id)).size).toBe(f.worker.posted.length);
    const cold = await openSqliteStore({ ...f.profile, mode: 'readonly' });
    try {
      expect((await cold.getSession('s'))?.ownerInstanceId).toBeNull();
      expect((await cold.getMetadata()).storeId).toBe(expectedStoreId);
    } finally {
      await cold.close();
    }
  } finally {
    await f.dispose();
  }
});

test('oversized full frames fail before posting and a synchronous clone failure releases capacity', async () => {
  const f = await fixture();
  try {
    const before = f.worker.posted.length;
    expect(
      await f.store.getSession('x'.repeat(14 * 1024 * 1024)).catch((error) => error),
    ).toMatchObject({
      code: 'storage_queue_full',
      retryable: true,
    });
    expect(f.worker.posted).toHaveLength(before);
    const error = await f.store.getSession((() => {}) as unknown as string).catch((error) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('DataCloneError');
    expect((await f.store.getMetadata()).storeId).toBeString();
    await f.store.close();
    expect(f.worker.posted.at(-1)?.method).toBe('close');
  } finally {
    await f.dispose();
  }
});

test('ordinary capacity waiters progress after bounded control priority while reserved slots remain usable', async () => {
  const f = await fixture();
  try {
    const expectedStoreId = (await f.store.getMetadata()).storeId;
    f.worker.holdAll = true;
    const before = f.worker.posted.length;
    const ordinary = Array.from({ length: 225 }, () => f.store.getMetadata());
    const control = Array.from({ length: 37 }, (_, index) =>
      f.store
        .cancelCommand({
          expectedStoreId,
          sessionId: 'absent',
          commandId: `cancel-${index}`,
          targetCommandId: 'absent',
          subjectId: 'user',
        })
        .catch((error: unknown) => error),
    );
    expect(f.worker.posted).toHaveLength(before + 256);
    const tail = f.worker.posted.length;
    await f.worker.waitForHeld(33);
    f.worker.releaseHeld(33);
    // 223 outstanding: both classes can enter. Older ordinary work has its turn
    // after the original reserved control slots have already made progress.
    await f.worker.waitForPosted(tail + 6);
    expect(f.worker.posted[tail]?.method).toBe('getMetadata');
    expect(
      f.worker.posted.slice(tail).filter((frame) => frame.method === 'cancelCommand'),
    ).toHaveLength(5);
    f.worker.releaseQueries();
    expect(await Promise.all(ordinary)).toHaveLength(225);
    expect(await Promise.all(control)).toHaveLength(37);
    await f.store.close();
  } finally {
    await f.dispose();
  }
});

test('Worker failure rejects both posted and capacity-waiting calls without replay or a stuck close', async () => {
  const f = await fixture();
  try {
    f.worker.holdQueries = true;
    const before = f.worker.posted.length;
    const calls = Promise.allSettled(Array.from({ length: 226 }, () => f.store.getMetadata()));
    expect(f.worker.posted).toHaveLength(before + 224);
    f.worker.onerror?.(new ErrorEvent('error', { message: 'controlled Worker failure event' }));
    const results = await calls;
    expect(results).toHaveLength(226);
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    expect(results.map((result) => result.status === 'rejected' && result.reason.code)).toEqual(
      Array(226).fill('worker_unavailable'),
    );
    expect(f.worker.posted).toHaveLength(before + 224);
    expect(await f.store.close().catch((error) => error)).toMatchObject({
      code: 'worker_unavailable',
    });
    expect(f.worker.posted.some((frame) => frame.method === 'close')).toBe(false);
  } finally {
    await f.dispose();
  }
});
