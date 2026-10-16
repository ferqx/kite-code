import { expect, test } from 'bun:test';
import type { AgentClient } from '@kite-ai/client';
import { NativeCaller } from '../electron/native-caller';
import type { NativeJobOutputPage } from '../src/job-output-bridge';
import { sessionChange } from './native-change.fixture';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function promptly<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      value,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error('job_output_waited_for_parent_refresh')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('fixed Job output survives same-selection metadata refresh while selection, reset and failed refresh revoke pending reads', async () => {
  for (const invalidation of ['select', 'reset', 'failure'] as const) {
    const parentStarted = deferred(),
      parentGate = deferred(),
      outputStarted = deferred(),
      outputGate = deferred();
    let holdParent = false,
      holdOutput = false;
    let notify!: () => void, reset!: () => void;
    const cancellations: string[] = [];
    const outputCalls: Parameters<AgentClient['listExecutionOutput']>[1][] = [];
    const job = { id: 'job', sessionId: 'root', originStoreId: 'store', kind: 'job' };
    const connection = {
      serverInfo: { storeId: 'store', subjectId: 'local-user', capabilities: [] },
      connect: async () => ({}),
      verifyConnection: async () => ({ storeId: 'store' }),
      async observe(options: Parameters<AgentClient['observe']>[0]) {
        notify = () => void options.onChange?.(sessionChange('root'));
        reset = () => void options.onReset?.({} as never);
        await new Promise<void>((done) =>
          options.signal!.addEventListener('abort', () => done(), { once: true }),
        );
      },
      async getView(id: string) {
        if (id === 'root' && holdParent) {
          parentStarted.resolve();
          await parentGate.promise;
          if (invalidation === 'failure') throw Error('parent_refresh_failed');
        }
        return {
          storeId: 'store',
          snapshotCursor: '0',
          session: {
            id,
            workspaceId: 'w',
            rootSessionId: id,
            parentSessionId: null,
            title: id,
            nextSeq: '0',
            contextSelectionId: 'selection',
            controlRevision: '0',
            deletedAt: null,
          },
          runs: [],
          executions: id === 'root' ? [job] : [],
          messages: [],
        };
      },
      getExecution: async () => job,
      async listExecutionOutput(
        _id: string,
        options: Parameters<AgentClient['listExecutionOutput']>[1],
      ) {
        outputCalls.push(options);
        if (holdOutput) {
          outputStarted.resolve();
          await outputGate.promise;
        }
        const seq = options?.afterSeq === '0' ? '1' : '2';
        return {
          highWaterSeq: options?.afterSeq === '0' ? '2' : '4',
          items: [
            {
              executionId: 'job',
              seq,
              throughSeq: seq,
              stream: 'stdout',
              content: `saved-${seq}🙂`,
              droppedBytes: '0',
            },
          ],
        };
      },
      listWorkspaces: async () => [],
      listAllWorkspaces: async () => [],
      listAllSessions: async () => [],
      listSessions: async () => [],
      disposeNetwork() {},
    } as unknown as AgentClient;
    for (const method of [
      'cancelCommand',
      'cancelRun',
      'cancelExecution',
      'cancelSession',
      'startRun',
    ])
      Object.assign(connection, {
        [method]: async () => {
          cancellations.push(method);
          throw Error('reading_must_not_mutate_business');
        },
      });
    const caller = new NativeCaller(connection, () => {});
    try {
      await caller.invoke({ method: 'attach' });
      await caller.invoke({ method: 'select', generation: 1, sessionId: 'root' });
      const selection = caller.state().selection!;
      const open = (readId: string) =>
        caller.invoke({
          method: 'jobOutput.open',
          generation: 1,
          viewSelection: selection.viewSelection!,
          historyEpoch: 0,
          executionId: 'job',
          readId,
        }) as Promise<NativeJobOutputPage>;
      const first = await open('fixed-H');
      expect(first).toMatchObject({ upperSeq: '2', nextAfterSeq: '1', complete: false });
      holdParent = true;
      notify();
      await promptly(parentStarted.promise);
      // Current production has advanced to H4; this read remains pinned to its original H2.
      const last = await promptly(
        caller.invoke({ method: 'jobOutput.next', generation: 1, readId: 'fixed-H' }),
      );
      expect(last).toMatchObject({
        upperSeq: '2',
        nextAfterSeq: '2',
        complete: true,
        page: { items: [{ content: 'saved-2🙂' }] },
      });
      expect(outputCalls.at(-1)).toMatchObject({ afterSeq: '1', upperSeq: '2' });
      await caller.invoke({ method: 'jobOutput.close', generation: 1, readId: 'fixed-H' });
      expect(await promptly(open('held-late'))).toMatchObject({ upperSeq: '2', nextAfterSeq: '1' });
      holdOutput = true;
      const late = caller
        .invoke({ method: 'jobOutput.next', generation: 1, readId: 'held-late' })
        .then(
          () => undefined,
          (cause) => cause,
        );
      await promptly(outputStarted.promise);
      const signal = outputCalls.at(-1)!.signal!;
      if (invalidation === 'select')
        await caller.invoke({ method: 'select', generation: 1, sessionId: 'other-root' });
      else if (invalidation === 'reset') reset();
      else {
        parentGate.resolve();
        await caller.invoke({ method: 'state', generation: 1 });
        expect(caller.state().selection?.permissionUnavailable).toBe(true);
      }
      expect(signal.aborted).toBe(true);
      outputGate.resolve();
      expect(await promptly(late)).toBeInstanceOf(Error);
      await expect(
        caller.invoke({ method: 'jobOutput.next', generation: 1, readId: 'held-late' }),
      ).rejects.toThrow();
      expect(cancellations).toEqual([]);
    } finally {
      parentGate.resolve();
      outputGate.resolve();
      await caller.close();
    }
  }
});
