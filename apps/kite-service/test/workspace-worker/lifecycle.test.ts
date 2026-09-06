import { describe, expect, test } from 'bun:test';
import { createWorkspaceWorkerIdleLifecycle } from '../../src/workspace-worker';

function timers() {
  let pending: (() => void) | undefined;
  return {
    setTimer: ((callback: () => void) => {
      pending = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout,
    clearTimer: (() => {
      pending = undefined;
    }) as typeof clearTimeout,
    fire: () => {
      const callback = pending;
      pending = undefined;
      callback?.();
    },
    hasPending: () => pending !== undefined,
  };
}

describe('Workspace Worker idle lifecycle', () => {
  test('keeps the Worker alive for every authority hold and drains after bounded idle grace', async () => {
    const clock = timers();
    const order: string[] = [];
    const lifecycle = createWorkspaceWorkerIdleLifecycle({
      idleGraceMs: 10,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      drain: async () => {
        order.push('drain');
      },
      close: async () => {
        order.push('close');
      },
    });
    const turn = lifecycle.acquire('turn', 'turn-1');
    const client = lifecycle.acquire('client', 'client-1');
    expect(await lifecycle.stopIfIdle()).toBe('busy');
    lifecycle.markReady();
    expect(clock.hasPending()).toBe(false);
    await client[Symbol.asyncDispose]();
    expect(clock.hasPending()).toBe(false);
    expect(await lifecycle.stopIfIdle()).toBe('busy');
    await turn[Symbol.asyncDispose]();
    expect(lifecycle.state).toBe('idle_grace');
    expect(clock.hasPending()).toBe(true);
    clock.fire();
    await lifecycle.waitForClose();
    expect(lifecycle.state).toBe('closed');
    expect(order).toEqual(['drain', 'close']);
  });

  test('cancels idle shutdown when new work arrives and never double-closes', async () => {
    const clock = timers();
    let closes = 0;
    const lifecycle = createWorkspaceWorkerIdleLifecycle({
      idleGraceMs: 10,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      drain: async () => undefined,
      close: async () => {
        closes += 1;
      },
    });
    lifecycle.markReady();
    expect(lifecycle.state).toBe('idle_grace');
    const recovery = lifecycle.acquire('recovery', 'recovery-1');
    expect(lifecycle.state).toBe('ready');
    clock.fire();
    expect(closes).toBe(0);
    await recovery[Symbol.asyncDispose]();
    expect(await lifecycle.stopIfIdle()).toBe('closed');
    expect(await lifecycle.stopIfIdle()).toBe('closed');
    expect(closes).toBe(1);
  });

  test('preserves the first drain failure while still closing the Worker', async () => {
    const clock = timers();
    const lifecycle = createWorkspaceWorkerIdleLifecycle({
      idleGraceMs: 10,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      drain: async () => {
        throw new Error('receipt drain failed');
      },
      close: async () => undefined,
    });
    lifecycle.markReady();
    const closed = lifecycle.waitForClose().catch((error: unknown) => error);
    const stopped = await lifecycle.stopIfIdle().catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(Error);
    expect((stopped as Error).message).toBe('receipt drain failed');
    expect(lifecycle.state).toBe('closed');
    const closeFailure = await closed;
    expect(closeFailure).toBeInstanceOf(Error);
    expect((closeFailure as Error).message).toBe('receipt drain failed');
  });
});
