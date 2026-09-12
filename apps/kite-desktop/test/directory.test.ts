import { expect, test } from 'bun:test';
import type { RuntimeLogSessionPage } from '@kite-ai/runtime-contract';
import { readCompleteSessionDirectory } from '../src/client';

test('space directory reads every protocol page without a user pagination action', async () => {
  const requests: RuntimeLogSessionPage['nextCursor'][] = [];
  const cursor = { updatedAt: 2, sessionId: 'newer' };
  const entries = await readCompleteSessionDirectory(async (requestCursor) => {
    requests.push(requestCursor);
    return requestCursor
      ? {
          entries: [session('older', 1)],
          hasMore: false,
        }
      : {
          entries: [session('newer', 2)],
          nextCursor: cursor,
          hasMore: true,
        };
  });

  expect(requests).toEqual([undefined, cursor]);
  expect(entries.map((entry) => entry.sessionId)).toEqual(['newer', 'older']);
});

function session(sessionId: string, updatedAt: number) {
  return {
    sessionId,
    displayName: sessionId,
    needsSmartName: false,
    updatedAt,
    lastSequence: 0,
  };
}
