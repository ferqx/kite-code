import { expect, test } from 'bun:test';
import type { AgentClient, ExecutionOutputPage } from '@kite-ai/client';
import { NativeJobOutputReads } from '../electron/job-output-reads';
import { NativeCaller } from '../electron/native-caller';
import { decodeNativeRequest } from '../electron/native-ipc';
import { nativeJobOutputPageBytes } from '../src/job-output-bridge';
import type { NativeBridge, NativeJobOutputScope } from '../src/native-bridge';
import { readNativeJobOutput } from '../src/native-job-output';

const scope: NativeJobOutputScope = {
  generation: 1,
  viewSelection: 2,
  historyEpoch: 0,
  storeId: 'store',
  originStoreId: 'store',
  sessionId: 's',
  workspaceId: 'w',
  executionId: 'job',
};
const job = { id: 'job', kind: 'job', originStoreId: 'store', sessionId: 's' };
const row = (i: number, text = `原内容${i}🙂\n`) => ({
  executionId: 'job',
  seq: String(i),
  throughSeq: String(i),
  stream: (i % 2 ? 'stdout' : 'stderr') as 'stdout' | 'stderr',
  content: text,
  droppedBytes: '0',
});
const client = (patch: Partial<AgentClient> = {}) =>
  ({
    verifyConnection: async () => ({ storeId: 'store' }),
    getExecution: async () => job,
    ...patch,
  }) as unknown as AgentClient;
const open = (readId = 'read') => ({
  readId,
  executionId: 'job',
  viewSelection: 2,
  historyEpoch: 0,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function bridge(reads: NativeJobOutputReads): NativeBridge {
  return {
    request: async (request) => {
      if (request.method === 'jobOutput.open') return reads.open(request);
      if (request.method === 'jobOutput.next') return reads.next(request.readId);
      if (request.method === 'jobOutput.close') {
        reads.close(request.readId);
        return null;
      }
      throw Error('unexpected_business_operation');
    },
    watch: () => () => undefined,
  };
}

test('Main and renderer exhaust fixed saved output in finite byte pages while later production stays outside the first H', async () => {
  const calls: Parameters<AgentClient['listExecutionOutput']>[1][] = [],
    signals: AbortSignal[] = [];
  let identityChecks = 0;
  const reads = new NativeJobOutputReads(
    client({
      verifyConnection: async () => {
        identityChecks++;
        return { storeId: 'store' } as never;
      },
      listExecutionOutput: async (_id, options) => {
        calls.push(options);
        signals.push(options!.signal!);
        const start = Number(options!.afterSeq),
          upper = Number(options!.upperSeq ?? '301'),
          end = Math.min(upper, start + options!.limit!);
        return {
          highWaterSeq: calls.length === 1 ? '301' : '305',
          items: Array.from({ length: end - start }, (_, i) =>
            row(start + i + 1, `${'完整Unicode原文🙂'.repeat(130)} tail-${start + i + 1}`),
          ),
        };
      },
    }),
    () => scope,
  );
  const port = bridge(reads),
    pages: unknown[] = [];
  const recorded: NativeBridge = {
    ...port,
    request: async (request) => {
      const value = await port.request(request);
      if (value) pages.push(value);
      return value;
    },
  };
  const all = await readNativeJobOutput({
    bridge: recorded,
    scope,
    signal: new AbortController().signal,
    isCurrent: () => true,
  });
  expect(all.items).toHaveLength(301);
  expect(all.items.at(-1)!.content).toContain('tail-301');
  expect(all.highWaterSeq).toBe('301');
  expect(calls.length).toBeGreaterThan(3);
  expect(calls[0]).toMatchObject({ afterSeq: '0', limit: 200 });
  expect(calls[1]).toMatchObject({ afterSeq: '0', upperSeq: '301', limit: 100 });
  expect(calls.slice(1).every((item) => item?.upperSeq === '301')).toBe(true);
  expect(
    pages.every(
      (page) =>
        new TextEncoder().encode(JSON.stringify(page)).byteLength <= nativeJobOutputPageBytes,
    ),
  ).toBe(true);
  expect(identityChecks).toBe(1 + 2 * calls.length);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test('an oversized response with foreign rows fails before any smaller page can conceal the identity error', async () => {
  let calls = 0;
  const reads = new NativeJobOutputReads(
    client({
      listExecutionOutput: async () => {
        calls++;
        return {
          highWaterSeq: '200',
          items: Array.from({ length: 200 }, (_, index) => ({
            ...row(index + 1, 'x'.repeat(4000)),
            executionId: 'foreign',
          })),
        };
      },
    }),
    () => scope,
  );
  await expect(reads.open(open())).rejects.toMatchObject({
    code: 'execution_output_page_conflict',
  });
  expect(calls).toBe(1);
  await expect(reads.next('read')).rejects.toMatchObject({ code: 'job_output_read_missing' });
});

test('close during controller refresh reaches the synchronously registered lease before any fresh Execution GET', async () => {
  const refresh = deferred<void>(),
    identity = deferred<never>();
  let current = { ...scope },
    signal: AbortSignal | undefined,
    executionGets = 0;
  const reads = new NativeJobOutputReads(
    client({
      verifyConnection: async (options) => {
        signal = options!.signal;
        return identity.promise;
      },
      getExecution: async () => {
        executionGets++;
        return job as never;
      },
    }),
    () => current,
  );
  const caller = Object.assign(Object.create(NativeCaller.prototype), {
    generation: 1,
    closed: false,
    refreshing: refresh.promise,
    jobOutput: reads,
  }) as NativeCaller;
  const pending = caller.invoke({ method: 'jobOutput.open', generation: 1, ...open() }).then(
    () => undefined,
    (error: unknown) => error,
  );
  await caller.invoke({ method: 'jobOutput.close', generation: 1, readId: 'read' });
  expect(signal!.aborted).toBe(true);
  current = { ...scope, viewSelection: 3, sessionId: 'other' };
  refresh.resolve();
  identity.resolve({ storeId: 'store' } as never);
  expect(await pending).toMatchObject({ code: 'job_output_view_changed' });
  await expect(
    caller.invoke({ method: 'jobOutput.open', generation: 1, ...open('late') }),
  ).rejects.toMatchObject({ code: 'native_selection_changed' });
  expect(executionGets).toBe(0);
});

test('fresh original Execution and Service identity must be valid before any output page; view reset rejects the next GET', async () => {
  for (const patch of [
    { id: 'foreign' },
    { kind: 'model' },
    { sessionId: 'other' },
    { originStoreId: 'other' },
    { originStoreId: undefined },
  ]) {
    let outputGets = 0;
    const reads = new NativeJobOutputReads(
      client({
        getExecution: async () => ({ ...job, ...patch }) as never,
        listExecutionOutput: async () => {
          outputGets++;
          return { items: [], highWaterSeq: '0' };
        },
      }),
      () => scope,
    );
    await expect(reads.open(open())).rejects.toMatchObject({
      code: 'job_output_identity_mismatch',
    });
    expect(outputGets).toBe(0);
  }
  let current = { ...scope },
    outputGets = 0;
  const reads = new NativeJobOutputReads(
    client({
      listExecutionOutput: async () => {
        outputGets++;
        return { items: [row(1)], highWaterSeq: '2' };
      },
    }),
    () => current,
  );
  await reads.open(open());
  current = { ...scope, historyEpoch: 1 };
  await expect(reads.next('read')).rejects.toMatchObject({ code: 'job_output_view_changed' });
  expect(outputGets).toBe(1);
  reads.release();
});

test('late output after close never changes a newer lease and renderer abort completes without waiting for an ignored signal', async () => {
  const late = deferred<ExecutionOutputPage>();
  let calls = 0;
  const reads = new NativeJobOutputReads(
    client({
      listExecutionOutput: async () =>
        ++calls === 1 ? late.promise : { items: [row(1)], highWaterSeq: '1' },
    }),
    () => scope,
  );
  const abort = new AbortController();
  const pending = readNativeJobOutput({
    bridge: bridge(reads),
    scope,
    signal: abort.signal,
    isCurrent: () => true,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  while (!calls) await Promise.resolve();
  abort.abort();
  expect(await pending).toMatchObject({ code: 'job_output_view_changed' });
  const newer = await reads.open(open('new'));
  expect(newer.page.items).toEqual([row(1)]);
  reads.close('missing');
  late.resolve({ items: [row(1, 'LATE_FOREIGN_BODY')], highWaterSeq: '1' });
  await Promise.resolve();
  reads.release();
});

test('closed Job IPC admits only exact read handles and observed view identities, never output cursors or new execution authority', () => {
  const request = { method: 'jobOutput.open' as const, generation: 1, ...open() };
  expect(decodeNativeRequest(request)).toEqual(request);
  for (const patch of [
    { storeId: 'other' },
    { sessionId: 'other' },
    { workspaceId: 'other' },
    { path: '/private' },
    { upperSeq: '1' },
    { limit: 200 },
    { viewSelection: 0 },
    { historyEpoch: -1 },
    { executionId: 'a/b' },
  ])
    expect(() => decodeNativeRequest({ ...request, ...patch })).toThrow('invalid_native_request');
  for (const method of ['jobOutput.next', 'jobOutput.close'] as const) {
    expect(decodeNativeRequest({ method, generation: 1, readId: 'read' })).toEqual({
      method,
      generation: 1,
      readId: 'read',
    });
    expect(() =>
      decodeNativeRequest({ method, generation: 1, readId: 'read', executionId: 'job' }),
    ).toThrow('invalid_native_request');
  }
});
