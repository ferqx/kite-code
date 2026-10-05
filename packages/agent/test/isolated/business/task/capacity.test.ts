import { expect, test } from 'bun:test';
import { ChildSlots } from '../../../../src/execution/child-slots';

test('fail-fast reservations use the same original child slots, reject at the exact default boundary, and release idempotently', async () => {
  const slots = new ChildSlots();
  const signal = new AbortController().signal;
  const releases = Array.from({ length: 3 }, () => slots.tryAcquire('actual-run', 3, signal));
  expect(releases.every(Boolean)).toBe(true);
  expect(slots.tryAcquire('actual-run', 3, signal)).toBeNull();
  let queued = false;
  const pending = slots.acquire('actual-run', 3, signal).then((release) => {
    queued = true;
    return release;
  });
  releases[0]!();
  releases[0]!();
  const releasePending = await pending;
  expect(queued).toBe(true);
  expect(slots.tryAcquire('actual-run', 3, signal)).toBeNull();
  releasePending();
  releases[1]!();
  releases[2]!();
  const fresh = slots.tryAcquire('actual-run', 3, signal);
  expect(fresh).not.toBeNull();
  fresh!();
  const aborted = new AbortController();
  aborted.abort(new Error('cancelled'));
  expect(() => slots.tryAcquire('actual-run', 3, aborted.signal)).toThrow('cancelled');
});
