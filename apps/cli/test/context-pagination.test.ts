import { expect, test } from 'bun:test';
import type { AgentClient, ContextQuery, SelectedContextPage } from '@kite-ai/client';
import { getCompleteContext } from '../src';

const base: SelectedContextPage = {
  selection: {
    id: 'selection',
    sessionId: 's',
    previousSelectionId: null,
    boundaryMessageId: null,
    boundarySeq: '0',
    tailFromSeq: '1',
    ranges: [],
  },
  highWaterSeq: '10',
  messages: [],
  resultSources: [],
  nextAfterSeq: null,
  nextAfterSourceId: null,
  snapshotCursor: '1',
};
function fixture(pages: SelectedContextPage[]) {
  const queries: ContextQuery[] = [];
  const client = {
    async getContext(_id: string, input: ContextQuery) {
      queries.push(structuredClone(input));
      const page = pages.shift();
      if (!page) throw Error('extra page');
      return page;
    },
  } as unknown as AgentClient;
  return { client, queries, write(_line: string) {} };
}
const source = (id: string) => ({
  id,
  seq: '10',
  sessionId: 's',
  createdSelectionId: 'selection',
  executionId: 'exec',
  resultRevision: '1',
  originStoreId: 'store',
  inclusion: 'explicit' as const,
  result: { futureField: 'retained' },
});
test('complete Context freezes water and selection while messages and sources finish independently', async () => {
  const f = fixture([
    {
      ...base,
      messages: [
        {
          id: 'm',
          sessionId: 's',
          runId: null,
          seq: '1',
          status: 'complete',
          role: 'user',
          content: 'full',
        },
      ],
      resultSources: [source('a')],
      nextAfterSourceId: 'a',
    },
    { ...base, snapshotCursor: '2', resultSources: [source('b')] },
  ]);
  const result = await getCompleteContext('s', { storeId: 'store' }, f);
  expect(result.messages).toHaveLength(1);
  expect(result.resultSources.map((s) => s.id)).toEqual(['a', 'b']);
  expect(result.resultSources[1]!.result).toEqual({ futureField: 'retained' });
  expect(f.queries[1]).toMatchObject({
    upperSeq: '10',
    contextSelectionId: 'selection',
    afterSeq: '10',
    afterSourceId: 'a',
  });
  expect(result.snapshotCursor).toBe('2');
});
test('nonprogress, foreign source and changed snapshot fail without returning a successful prefix', async () => {
  for (const pages of [
    [{ ...base, nextAfterSeq: '0' }],
    [{ ...base, resultSources: [{ ...source('a'), originStoreId: 'foreign' }] }],
    [
      { ...base, resultSources: [source('a')], nextAfterSourceId: 'a' },
      { ...base, highWaterSeq: '11' },
    ],
  ] as SelectedContextPage[][]) {
    const f = fixture(pages);
    await expect(getCompleteContext('s', { storeId: 'store' }, f)).rejects.toThrow();
    expect(f.queries.length).toBeLessThanOrEqual(2);
  }
});
