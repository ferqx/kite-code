import { expect, test } from 'bun:test';
import type { Execution, ExecutionOutputPage, SessionView } from '@kite-ai/client';
import { createTuiJobTailReader } from '../../host/tui-job-tails';

const job: Execution = {
  id: 'shell',
  kind: 'job',
  originStoreId: 'store',
  sessionId: 's',
  runId: 'run',
  definitionId: 'shell.command',
  definitionVersion: '1',
  status: 'running',
  result: null,
  resultRevision: '0',
  cancelRequestedAt: null,
  parentExecutionId: 'launch',
  childSessionId: null,
};
const view = (jobs: Execution[] = [job]): SessionView => ({
  storeId: 'store',
  snapshotCursor: '1',
  session: {
    id: 's',
    workspaceId: 'w',
    rootSessionId: 's',
    parentSessionId: null,
    title: 'actual',
    controlRevision: '1',
    contextSelectionId: 'selection',
    nextSeq: '0',
    deletedAt: null,
  },
  runs: [],
  messages: [],
  executions: jobs,
});
const chunk = (seq: number, content: string): ExecutionOutputPage['items'][number] => ({
  executionId: 'shell',
  seq: String(seq),
  throughSeq: String(seq),
  stream: 'stdout',
  content,
  droppedBytes: '0',
});
const signal = new AbortController().signal;
test('incremental actual Job output keeps five last lines and split line boundary, not full history', async () => {
  const calls: string[] = [],
    items = [chunk(1, '0\n1\n2\n3\n4\n5\npart')];
  const reader = createTuiJobTailReader(
    {
      serverInfo: { storeId: 'store', instanceId: 'instance' },
      async getExecution() {
        return job;
      },
      async listExecutionOutput(_id, query) {
        calls.push(query?.afterSeq ?? '0');
        return {
          highWaterSeq: String(items.length),
          items: items.filter((item) => BigInt(item.seq) > BigInt(query?.afterSeq ?? '0')),
        };
      },
    },
    'store',
  );
  expect(await reader.read(view(), signal)).toEqual([
    { executionId: 'shell', content: '2\n3\n4\n5\npart', totalLines: 7 },
  ]);
  items.push(chunk(2, 'ial\n6\n7\n'));
  expect(await reader.read(view(), signal)).toEqual([
    { executionId: 'shell', content: '4\n5\npartial\n6\n7\n', totalLines: 9 },
  ]);
  expect(calls).toEqual(['0', '1']);
});
test('bounded page refresh resumes forward and never declares backlog complete', async () => {
  const items = Array.from({ length: 100 }, (_, n) => chunk(n + 1, `${n}\n`));
  const cursors: string[] = [];
  const reader = createTuiJobTailReader(
    {
      serverInfo: { storeId: 'store', instanceId: 'instance' },
      async getExecution() {
        return job;
      },
      async listExecutionOutput(_id, query) {
        cursors.push(query?.afterSeq ?? '0');
        return {
          highWaterSeq: '100',
          items: items
            .filter((item) => BigInt(item.seq) > BigInt(query?.afterSeq ?? '0'))
            .slice(0, query?.limit),
        };
      },
    },
    'store',
  );
  const first = (await reader.read(view(), signal))[0]!;
  expect(first.incomplete).toBe(true);
  expect(first.totalLines).toBe(64);
  const next = (await reader.read(view(), signal))[0]!;
  expect(next.incomplete).toBeUndefined();
  expect(next.totalLines).toBe(100);
  expect(next.content).toBe('95\n96\n97\n98\n99\n');
  expect(cursors).toEqual(['0', '32', '64', '96']);
});
test('gaps remain explicit, prevent joining lost fragments, and remove unknown line-count claims', async () => {
  let page: ExecutionOutputPage = { highWaterSeq: '1', items: [chunk(1, 'before')] };
  const reader = createTuiJobTailReader(
    {
      serverInfo: { storeId: 'store', instanceId: 'instance' },
      async getExecution() {
        return job;
      },
      async listExecutionOutput() {
        return page;
      },
    },
    'store',
  );
  await reader.read(view(), signal);
  page = {
    highWaterSeq: '4',
    items: [{ ...chunk(2, ''), throughSeq: '3', droppedBytes: '8' }, chunk(4, 'after\n')],
  };
  const tail = (await reader.read(view(), signal))[0]!;
  expect(tail.content).toBe('after\n');
  expect(tail.incomplete).toBe(true);
  expect(tail.totalLines).toBeUndefined();
});
test('foreign/unknown origin does not auto-read, original identity is rechecked, and absent view keys evict cache', async () => {
  let calls = 0,
    current = job;
  const cursors: string[] = [];
  const reader = createTuiJobTailReader(
    {
      serverInfo: { storeId: 'store', instanceId: 'instance' },
      async getExecution() {
        calls++;
        return current;
      },
      async listExecutionOutput(_id, query) {
        cursors.push(query?.afterSeq ?? '0');
        return {
          highWaterSeq: '1',
          items: query?.afterSeq === '1' ? [] : [chunk(1, 'original\n')],
        };
      },
    },
    'store',
  );
  expect(
    await reader.read(
      view([
        { ...job, originStoreId: 'foreign' },
        { ...job, id: 'unknown', originStoreId: undefined },
      ]),
      signal,
    ),
  ).toEqual([]);
  expect(calls).toBe(0);
  await reader.read(view(), signal);
  await reader.read(view([]), signal);
  await reader.read(view(), signal);
  expect(cursors).toEqual(['0', '0']);
  current = { ...job, definitionVersion: 'changed' };
  await expect(reader.read(view(), signal)).rejects.toThrow('tui_job_tail_identity_mismatch');
});
