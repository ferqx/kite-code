import { expect, spyOn, test } from 'bun:test';
import type { OperationRef, PublicExecution, ToolContext } from '@kite-ai/agent/extensions';
import { completeForegroundTask } from '../../../../src/extensions/task/foreground';
import { AgentError } from '../../../../src/storage/types';
import { completeForegroundShell } from '../../../../src/tools/shell-foreground';

const ref: OperationRef = {
  originStoreId: 'store',
  sessionId: 'session',
  extensionId: 'builtin.shell',
  commandId: 'command',
  executionId: 'job',
  key: 'original',
};
function execution(status: PublicExecution['status'] = 'cancelled'): PublicExecution {
  return {
    id: ref.executionId!,
    sessionId: ref.sessionId,
    originStoreId: ref.originStoreId,
    runId: 'run',
    kind: 'job',
    definitionId: 'shell.command',
    resultRevision: '1',
    status,
    result: {
      outcome: status,
      content: `Shell ${status}`,
      details: {
        groupStopped: status !== 'outcome_unknown',
        processTreeStopped: status !== 'outcome_unknown',
      },
    },
  };
}
function context(controller: AbortController, get: () => Promise<PublicExecution | null>) {
  let waits = 0,
    dispatches = 0;
  const value = {
    signal: controller.signal,
    operations: {
      async wait(original: OperationRef) {
        expect(original).toEqual(ref);
        waits++;
        controller.abort(Error('cancel_requested'));
        throw controller.signal.reason;
      },
      async get(original: OperationRef) {
        expect(original).toEqual(ref);
        return get();
      },
      async ensure() {
        dispatches++;
        throw Error('must_not_restart');
      },
      async cancel() {
        dispatches++;
        throw Error('must_not_repeat_cancel');
      },
      async readOutput() {
        throw Error('cancelled_output_stays_in_original_reader');
      },
    },
  } as unknown as ToolContext;
  return { value, waits: () => waits, dispatches: () => dispatches };
}

test('a finite foreground deadline uses a bounded integer wait and keeps the original successful Job', async () => {
  const clock = spyOn(performance, 'now');
  try {
    for (const [deadline, elapsed, expected] of [
      [4000, 0.25, 3999],
      [1, 0.75, 1],
      [600000, 0.25, 30000],
    ] as const) {
      clock.mockReturnValueOnce(100).mockReturnValueOnce(100 + elapsed);
      const c = context(new AbortController(), async () => execution('succeeded'));
      const waits: number[] = [];
      c.value.operations.wait = async (original, options) => {
        expect(original).toEqual(ref);
        const timeout = options?.timeoutMs;
        if (
          typeof timeout !== 'number' ||
          !Number.isSafeInteger(timeout) ||
          timeout < 0 ||
          timeout > 30000
        )
          throw new AgentError('invalid_wait_timeout');
        waits.push(timeout);
        return execution('succeeded');
      };
      c.value.operations.readOutput = async () => ({
        items: [],
        highWaterSeq: '0',
        nextAfterSeq: null,
      });
      const result = await completeForegroundShell(ref, c.value, deadline, 'standalone');
      expect(waits).toEqual([expected]);
      expect(result.outcome).toBe('succeeded');
      expect(result.details).toMatchObject({ timedOut: false, ref });
      expect(c.dispatches()).toBe(0);
    }
  } finally {
    clock.mockRestore();
  }
});

for (const timeoutMs of [600000, undefined])
  test(`foreground Shell abort with timeout=${timeoutMs ?? 'none'} waits for the exact owned stop`, async () => {
    const controller = new AbortController();
    let reads = 0;
    const c = context(controller, async () => (++reads === 1 ? execution('running') : execution()));
    const result = await completeForegroundShell(ref, c.value, timeoutMs, 'standalone');
    expect(reads).toBe(2);
    expect(c.waits()).toBe(1);
    expect(c.dispatches()).toBe(0);
    expect(result.outcome).toBe('cancelled');
    expect(result.details).toMatchObject({
      ref,
      cancellationObserved: true,
      execution: {
        id: 'job',
        status: 'cancelled',
        result: { details: { groupStopped: true, processTreeStopped: true } },
      },
    });
  });

test('foreground Shell abort retains an unknown stop and refuses foreign or missing terminal evidence', async () => {
  for (const observed of [
    execution('outcome_unknown'),
    { ...execution(), id: 'foreign-job' },
    { ...execution(), result: null },
  ]) {
    const c = context(new AbortController(), async () => observed);
    const result = await completeForegroundShell(ref, c.value, 600000, 'standalone');
    expect(result.outcome).toBe('outcome_unknown');
    expect(c.dispatches()).toBe(0);
  }
});

test('abort during final Shell output reading does not lose an already recorded exact terminal stop', async () => {
  const controller = new AbortController();
  const c = context(controller, async () => execution());
  c.value.operations.wait = async () => execution();
  c.value.operations.readOutput = async () => {
    controller.abort(Error('cancel_requested'));
    throw controller.signal.reason;
  };
  const result = await completeForegroundShell(ref, c.value, 600000, 'standalone');
  expect(result.outcome).toBe('cancelled');
  expect(result.details).toMatchObject({ cancellationObserved: true });
  expect(c.dispatches()).toBe(0);
});

test('foreground Task cancellation preserves an actual failed or unknown carrier instead of inventing cancellation', async () => {
  for (const status of ['failed', 'outcome_unknown'] as const) {
    const c = context(new AbortController(), async () => execution(status));
    const result = await completeForegroundTask(ref, c.value);
    expect(result.outcome).toBe(status);
    expect(result.content).toBe(`Shell ${status}`);
    expect(c.dispatches()).toBe(0);
  }
});
