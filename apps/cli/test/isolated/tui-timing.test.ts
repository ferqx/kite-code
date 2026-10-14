import { expect, test } from 'bun:test';
import type { SessionLogEntry, SessionLogPage, SessionView } from '@kite-ai/client';
import { readTuiTimings } from '../../host/tui-timing';

function view(): SessionView {
  return {
    storeId: 'store',
    snapshotCursor: '4',
    session: {
      id: 's',
      workspaceId: 'w',
      parentSessionId: null,
      title: 's',
      controlRevision: '1',
      contextSelectionId: 'c',
      nextSeq: '1',
      deletedAt: null,
    },
    messages: [],
    runs: [],
    executions: [
      {
        id: 'tool',
        originStoreId: 'store',
        sessionId: 's',
        runId: null,
        kind: 'tool',
        definitionId: 'original.tool',
        definitionVersion: '1',
        status: 'succeeded',
        result: null,
        resultRevision: '1',
        cancelRequestedAt: null,
      },
    ],
  };
}
function entry(
  at: 'dispatching' | 'finished',
  cursor: string,
  occurredAt: number | null,
): SessionLogEntry {
  return {
    cursor,
    sessionId: 's',
    objectId: 'tool',
    type: `execution.${at}`,
    revision: '0',
    occurredAt,
    category: 'execution',
    recordedStatus: at === 'dispatching' ? 'dispatching' : 'succeeded',
    summary: 'recorded event',
    details: {
      executionId: 'tool',
      kind: 'tool',
      definitionId: 'original.tool',
      definitionVersion: '1',
    },
    modelExecutionId: null,
  };
}
function page(entries: SessionLogEntry[], next: string | null): SessionLogPage {
  return {
    storeId: 'store',
    sessionId: 's',
    upperCursor: '4',
    snapshotCursor: '9',
    replayFloor: '0',
    entries,
    nextAfterCursor: next,
    complete: next === null,
  };
}

test('recorded dispatch timings exhaust a fixed original bound and never read foreign execution origins', async () => {
  const original = view();
  original.executions.push({
    ...original.executions[0]!,
    id: 'restored',
    originStoreId: 'old-store',
  });
  const calls: { after: string; upper?: string }[] = [];
  const result = await readTuiTimings(
    {
      async listSessionLogs(_id, query) {
        calls.push({ after: query.afterCursor, upper: query.upperCursor });
        return query.afterCursor === '0'
          ? page([entry('dispatching', '1', 100)], '1')
          : page([entry('finished', '4', 145)], null);
      },
    },
    'store',
    original,
    new AbortController().signal,
  );
  expect(calls).toEqual([
    { after: '0', upper: '4' },
    { after: '1', upper: '4' },
  ]);
  expect(result.tool).toEqual({
    availability: 'recorded_dispatch',
    startedAt: 100,
    finishedAt: 145,
  });
  expect(result.restored).toEqual({ availability: 'unavailable' });
});

test('missing original timestamps and replay gaps stay unavailable without invented observer timing', async () => {
  const signal = new AbortController().signal;
  const missing = await readTuiTimings(
    {
      async listSessionLogs() {
        return page([entry('dispatching', '1', null), entry('finished', '4', 145)], null);
      },
    },
    'store',
    view(),
    signal,
  );
  expect(missing.tool).toEqual({ availability: 'unavailable' });
  const expired = await readTuiTimings(
    {
      async listSessionLogs() {
        return {
          ...page([entry('dispatching', '1', 100), entry('finished', '4', 145)], null),
          replayFloor: '2',
        };
      },
    },
    'store',
    view(),
    signal,
  );
  expect(expired.tool).toEqual({ availability: 'unavailable' });
  const wrong = await readTuiTimings(
    {
      async listSessionLogs() {
        return page(
          [
            entry('dispatching', '1', 100),
            {
              ...entry('finished', '4', 145),
              details: { ...entry('finished', '4', 145).details, definitionVersion: 'different' },
            },
          ],
          null,
        );
      },
    },
    'store',
    view(),
    signal,
  );
  expect(wrong.tool).toEqual({ availability: 'unavailable' });
});
