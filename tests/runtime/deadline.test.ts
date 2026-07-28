import { describe, expect, test } from 'bun:test';
import {
  createDeadlinePhaseTimer,
  createInvocationDeadline,
} from '../../src/core/runtime/deadline';

describe('invocation deadline', () => {
  test('preserves the first external cancellation reason', () => {
    const external = new AbortController();
    const deadline = createInvocationDeadline({
      deadlineAt: Date.now() + 10_000,
      signal: external.signal,
    });

    external.abort(new Error('user cancelled'));
    deadline.cancel('deadline_exceeded');

    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.reason?.kind).toBe('external_abort');
    expect(deadline.reason?.message).toBe('user cancelled');
    deadline.dispose();
  });

  test('rejects an already exhausted absolute deadline', () => {
    const deadline = createInvocationDeadline({ deadlineAt: 99, now: () => 100 });
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.reason?.kind).toBe('deadline_exceeded');
    expect(deadline.remainingMs()).toBe(0);
    deadline.dispose();
  });

  test('phase timers cannot overwrite an earlier timeout cause', async () => {
    const deadline = createInvocationDeadline({ deadlineAt: Date.now() + 1_000 });
    const firstByte = createDeadlinePhaseTimer(deadline, 'first_byte_timeout', 5);
    const idle = createDeadlinePhaseTimer(deadline, 'idle_timeout', 20);

    await Bun.sleep(10);

    expect(deadline.reason?.kind).toBe('first_byte_timeout');
    firstByte.dispose();
    idle.dispose();
    deadline.dispose();
  });
});
