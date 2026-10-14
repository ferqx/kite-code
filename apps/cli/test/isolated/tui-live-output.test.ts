import { expect, test } from 'bun:test';
import type { ModelOutputSnapshot, SessionView } from '@kite-ai/client';
import { readTuiLiveOutput } from '../../host/tui-live-output';

const view: SessionView = {
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
    nextSeq: '1',
    deletedAt: null,
  },
  messages: [],
  executions: [
    {
      id: 'model',
      sessionId: 's',
      originStoreId: 'store',
      runId: 'run',
      kind: 'model',
      definitionId: 'actual-model',
      definitionVersion: '1',
      status: 'dispatching',
      result: null,
      resultRevision: '0',
      cancelRequestedAt: null,
    },
  ],
  runs: [
    {
      id: 'run',
      sessionId: 's',
      originCommandId: 'work',
      originStoreId: 'store',
      status: 'running',
      isActive: true,
      createdAt: 1,
      finishedAt: null,
      reason: null,
    },
  ],
};
const body: ModelOutputSnapshot = {
  storeId: 'store',
  sessionId: 's',
  rootSessionId: 's',
  runId: 'run',
  executionId: 'model',
  originCommandId: 'work',
  rootWorkCommandId: 'work',
  rootWorkSeq: '1',
  attempt: 1,
  status: 'dispatching',
  bodyHash: 'a'.repeat(64),
  bodyBytes: '1',
  contentBytes: '0',
  reasoningBytes: '5',
  snapshotCursor: '1',
  output: { content: '', reasoning: 'actual prefix', toolCalls: [], complete: false },
};
test('live reader selects one current actual Model and reads its public prefix once', async () => {
  const calls: unknown[] = [];
  const client = {
    async getModelOutput(...args: unknown[]) {
      calls.push(args);
      return body;
    },
  };
  const signal = new AbortController().signal;
  expect(await readTuiLiveOutput(client, view, 'store', signal)).toBe(body);
  expect(calls).toEqual([['s', 'model', { expectedStoreId: 'store', signal }]]);
  expect(await readTuiLiveOutput(client, { ...view, runs: [] }, 'store', signal)).toBeUndefined();
  expect(
    await readTuiLiveOutput(
      client,
      { ...view, executions: [...view.executions, { ...view.executions[0]!, id: 'other-model' }] },
      'store',
      signal,
    ),
  ).toBeUndefined();
  expect(calls).toHaveLength(1);
});
test('a foreign or terminal response never enters the live display and abort remains effective', async () => {
  const signal = new AbortController().signal;
  for (const changed of [
    { storeId: 'foreign' },
    { sessionId: 'other' },
    { runId: 'other' },
    { executionId: 'other' },
    { rootSessionId: 'other' },
    { originCommandId: 'other' },
    { status: 'succeeded' as const, output: { ...body.output, complete: true } },
    { output: { ...body.output, toolCalls: [{ id: 'partial', name: 'tool', arguments: '{}' }] } },
  ]) {
    await expect(
      readTuiLiveOutput(
        {
          async getModelOutput() {
            return { ...body, ...changed };
          },
        },
        view,
        'store',
        signal,
      ),
    ).rejects.toThrow('tui_live_output_identity_mismatch');
  }
  let calls = 0;
  const abort = new AbortController();
  abort.abort();
  await expect(
    readTuiLiveOutput(
      {
        async getModelOutput() {
          calls++;
          return body;
        },
      },
      view,
      'store',
      abort.signal,
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});
