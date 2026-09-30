import { expect, test } from 'bun:test';
import type { RuntimeBackgroundExecutionSnapshot } from '@kite-ai/runtime-contract';
import { BackgroundExecutionPages } from '../src/bootstrap/runtime/background-execution-pages';
import { pageBackgroundExecutionSnapshot } from '../src/bootstrap/runtime/CliRuntimeBridge';

test('a complete background directory projects once across pages and refreshes on a new read', () => {
  const cache = new BackgroundExecutionPages();
  let sourceReads = 0;
  const project = (): RuntimeBackgroundExecutionSnapshot => {
    sourceReads += 1_000;
    return Object.freeze({
      sessionId: 's',
      sessionRevision: 1,
      aggregateGeneration: 'g',
      watermark: sourceReads,
      executions: Object.freeze(
        Array.from({ length: 1_000 }, (_, n) => ({
          executionId: `exec-${n}`,
          sessionId: 's',
          sessionRevision: 1,
          kind: 'subagent' as const,
          status: 'completed' as const,
          ownerGeneration: 'o',
          revision: n,
          cleanupConfirmed: true,
        })),
      ),
    });
  };
  let cursor: number | undefined;
  let count = 0;
  do {
    const page = pageBackgroundExecutionSnapshot(
      cache.read('binding', cursor, project),
      cursor,
      50,
    );
    count += page.backgroundSnapshot.executions.length;
    expect(page.backgroundSnapshot.watermark).toBe(1_000);
    cursor = page.nextBackgroundCursor;
  } while (cursor !== undefined);
  expect(count).toBe(1_000);
  expect(sourceReads).toBe(1_000);
  expect(cache.read('binding', undefined, project).watermark).toBe(2_000);
  expect(cache.read('changed-revision', 50, project).watermark).toBe(3_000);
});
