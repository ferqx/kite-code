import { expect, test } from 'bun:test';
import { type AgentClient, ClientError } from '@kite-ai/client';
import { includeHistoricalResult, lookupContextOutcome } from '../src/context';

test('invalid POST response only reads saved original include; accepted is queued, lookup applied', async () => {
  let posts = 0,
    reads = 0;
  const request = {
    expectedStoreId: 'store-original',
    commandId: 'original-command',
    expectedContextSelectionId: 'selection-original',
    resultRevision: '4',
    targetRunId: 'run-original',
  };
  const client = {
    async includeResult(session: string, execution: string, input: unknown) {
      posts++;
      expect(session).toBe('original');
      expect(execution).toBe('job-original');
      expect(input).toEqual(request);
      throw new ClientError('invalid_response');
    },
    async getCommand(id: string) {
      reads++;
      expect(id).toBe('original-command');
      return {
        id,
        sessionId: 'original',
        originStoreId: 'store-original',
        kind: 'result.include',
        status: reads === 1 ? 'accepted' : 'applied',
        receipt: {
          outcome: reads === 1 ? 'result_queued' : 'result_included',
          runId: 'run-original',
        },
        cancelRequestedAt: null,
      };
    },
  } as unknown as AgentClient;
  const options = { client, write(_line: string) {} };
  const saved = await includeHistoricalResult('original', 'job-original', request, options);
  expect(saved.status).toBe('queued');
  expect(saved.request).toEqual(request);
  const next = await lookupContextOutcome(saved, options);
  expect(next.status).toBe('applied');
  expect(next.request).toEqual(request);
  expect(posts).toBe(1);
  expect(reads).toBe(2);
});
