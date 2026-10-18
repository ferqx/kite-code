import { expect, test } from 'bun:test';
import { LifecycleObservers } from '../src/extensions/lifecycle';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('observer backlog is bounded and independent; delivery preserves order without joining close', async () => {
  const observers = new LifecycleObservers();
  const blocked = gate();
  const entered = gate();
  const slow: number[] = [];
  const fast: number[] = [];
  const observe = async (value: number) => {
    slow.push(value);
    entered.release();
    await blocked.promise;
  };
  observers.publish(observe, 0);
  await entered.promise;
  for (let value = 1; value <= 200; value++) observers.publish(observe, value);
  observers.publish((value: number) => {
    fast.push(value);
  }, 201);
  await Promise.resolve();
  expect(fast).toEqual([201]);
  expect(slow).toEqual([0]);
  blocked.release();
  // Let each of the bounded queued deliveries complete, without timers or an elapsed-time gate.
  for (let turn = 0; turn < 40; turn++) await Promise.resolve();
  expect(slow).toEqual(Array.from({ length: 17 }, (_, index) => index));
  observers.close();
  observers.publish(observe, 202);
  await Promise.resolve();
  expect(slow).toHaveLength(17);
});

test('failed observers are locally disabled and pending observations are dropped on close', async () => {
  const observers = new LifecycleObservers();
  let failures = 0;
  const failed = async () => {
    failures++;
    throw new Error('observer failure');
  };
  observers.publish(failed, null);
  observers.publish(failed, null);
  await Promise.resolve();
  await Promise.resolve();
  observers.publish(failed, null);
  let delivered = false;
  observers.publish(() => {
    delivered = true;
  }, null);
  observers.close();
  await Promise.resolve();
  expect(failures).toBe(1);
  expect(delivered).toBe(false);
});
