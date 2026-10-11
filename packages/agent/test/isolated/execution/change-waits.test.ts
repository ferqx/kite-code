import { expect, test } from 'bun:test';
import { ChangeWaits } from '../../../src/execution/change-waits';
import type { Store } from '../../../src/storage/port';
import { AgentError, type ChangeEvent } from '../../../src/storage/types';

function event(cursor: string): ChangeEvent {
  return {
    cursor,
    sessionId: 's',
    objectId: 'job',
    type: 'execution',
    revision: '1',
    payload: null,
  };
}

function fixture() {
  const reads: Parameters<Store['getChanges']>[0][] = [];
  let events: ChangeEvent[] = [];
  let failure: Error | undefined;
  const store = {
    async getChanges(input: Parameters<Store['getChanges']>[0]) {
      reads.push(input);
      if (failure) throw failure;
      return { events, cursor: events.at(-1)?.cursor ?? input.after };
    },
  } as unknown as Store;
  const waits = new ChangeWaits(store);
  return {
    waits,
    reads,
    publish(page: ChangeEvent[]) {
      events = page;
    },
    fail(error: Error) {
      failure = error;
    },
  };
}

test('65 concurrent wakes preserve 64 active registrations and admit older waiters first', async () => {
  const f = fixture();
  const controller = new AbortController();
  const retained = Array.from({ length: 63 }, () => f.waits.wait('10', controller.signal, 1000));
  const drain = Promise.allSettled(retained);
  try {
    const first = f.waits.wait('0', controller.signal, 1000);
    let olderDone = false;
    const older = f.waits.wait('0', controller.signal, 1000).then((value) => {
      olderDone = true;
      return value;
    });
    expect(f.waits.size).toBe(64);
    f.publish([event('1')]);
    await f.waits.poll();
    expect(await first).toEqual([event('1')]);
    expect(olderDone).toBe(false);
    expect(f.waits.size).toBe(64);

    let newerDone = false;
    const newer = f.waits.wait('0', controller.signal, 1000).then((value) => {
      newerDone = true;
      return value;
    });
    f.publish([event('2')]);
    await f.waits.poll();
    expect(await older).toEqual([event('2')]);
    expect(newerDone).toBe(false);
    expect(f.waits.size).toBe(64);
    f.publish([event('3')]);
    await f.waits.poll();
    expect(await newer).toEqual([event('3')]);
    expect(f.waits.size).toBe(63);
    expect(f.reads).toEqual([
      { after: '0', limit: 200 },
      { after: '0', limit: 200 },
      { after: '0', limit: 200 },
    ]);
  } finally {
    f.waits.close();
    await drain;
  }
});

test('capacity waiting keeps the original timer and fires at its original deadline after admission', async () => {
  const f = fixture();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers: { fire: () => void; delay: number | undefined }[] = [];
  const cleared = new Set<unknown>();
  globalThis.setTimeout = ((callback: () => void, delay?: number) => {
    const timer = { fire: callback, delay };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => {
    cleared.add(timer);
  }) as typeof clearTimeout;
  const activeControllers = Array.from({ length: 64 }, () => new AbortController());
  const active = activeControllers.map((controller) => f.waits.wait('0', controller.signal, 1000));
  const drain = Promise.allSettled(active);
  try {
    const queued = f.waits.wait('0', new AbortController().signal, 150);
    const originalTimer = timers[64]!;
    expect(timers).toHaveLength(65);
    expect(originalTimer.delay).toBe(150);
    expect(f.waits.size).toBe(64);
    activeControllers[0]!.abort(new Error('release original slot before deadline'));
    expect(f.waits.size).toBe(64);
    expect(timers).toHaveLength(65);
    expect(timers[64]).toBe(originalTimer);
    expect(cleared.has(originalTimer)).toBe(false);
    // Dispatch the timer created at the original call, without advancing a wall-clock budget.
    originalTimer.fire();
    expect(await queued).toEqual([]);
    expect(cleared.has(originalTimer)).toBe(true);
    expect(f.waits.size).toBe(63);
    expect(f.reads).toEqual([]);
  } finally {
    f.waits.close();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    await drain;
  }
});

test('actual timeout completes a capacity waiter before any active slot is released', async () => {
  const f = fixture();
  const controller = new AbortController();
  const active = Array.from({ length: 64 }, () => f.waits.wait('0', controller.signal, 1000));
  const drain = Promise.allSettled(active);
  try {
    const queued = f.waits.wait('0', controller.signal, 10);
    expect(await queued).toEqual([]);
    expect(f.waits.size).toBe(64);
    expect(f.reads).toEqual([]);
  } finally {
    f.waits.close();
    await drain;
  }
});

test('abort keeps its exact reason before admission and after permit handoff', async () => {
  const f = fixture();
  const controller = new AbortController();
  const active = Array.from({ length: 64 }, () => f.waits.wait('0', controller.signal, 1000));
  const drain = Promise.allSettled(active);
  try {
    const queuedController = new AbortController();
    const reason = new AgentError('original_cancel');
    const queued = f.waits.wait('0', queuedController.signal, 1000);
    const rejected = queued.catch((error: unknown) => error);
    queuedController.abort(reason);
    expect(await rejected).toBe(reason);
    expect(f.waits.size).toBe(64);

    const nextController = new AbortController();
    const next = f.waits.wait('0', nextController.signal, 1000);
    const nextReason = new Error('cancel active promoted wake');
    const nextRejected = next.catch((error: unknown) => error);
    f.publish([event('1')]);
    await f.waits.poll();
    expect(f.waits.size).toBe(1);
    nextController.abort(nextReason);
    expect(await nextRejected).toBe(nextReason);
    expect(f.waits.size).toBe(0);
    expect(() => f.waits.wait('0', queuedController.signal, 1000)).toThrow(reason);
  } finally {
    f.waits.close();
    await drain;
  }
});

test('close rejects both active and capacity waiters and seals future registration', async () => {
  const f = fixture();
  const controller = new AbortController();
  const waits = Array.from({ length: 65 }, () => f.waits.wait('0', controller.signal, 1000));
  const drain = Promise.allSettled(waits);
  expect(f.waits.size).toBe(64);
  f.waits.close();
  const outcomes = await drain;
  expect(outcomes).toHaveLength(65);
  for (const outcome of outcomes) {
    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') expect(outcome.reason.code).toBe('runtime_draining');
  }
  expect(f.waits.size).toBe(0);
  await expect(f.waits.wait('0', controller.signal, 1000)).rejects.toThrow('runtime_draining');
  await f.waits.poll();
  f.waits.close();
  expect(f.reads).toEqual([]);
});

test('expired cursor wakes only the current page registrations and other Store errors propagate', async () => {
  const f = fixture();
  const controller = new AbortController();
  const active = Array.from({ length: 64 }, () => f.waits.wait('0', controller.signal, 1000));
  const queued = f.waits.wait('0', controller.signal, 1000);
  const queuedDrain = Promise.allSettled([queued]);
  try {
    f.fail(new AgentError('cursor_expired'));
    await f.waits.poll();
    expect(await Promise.all(active)).toEqual(Array.from({ length: 64 }, () => []));
    expect(f.waits.size).toBe(1);
    const original = new AgentError('storage_error');
    f.fail(original);
    await expect(f.waits.poll()).rejects.toBe(original);
    expect(f.waits.size).toBe(1);
    expect(f.reads).toEqual([
      { after: '0', limit: 200 },
      { after: '0', limit: 200 },
    ]);
  } finally {
    f.waits.close();
    await queuedDrain;
  }
});
