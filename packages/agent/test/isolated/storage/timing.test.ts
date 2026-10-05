import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { semanticDigest } from '../../../src/json';
import { type DbTiming, openSqliteStore } from '../../../src/sqlite';

function percentile(values: number[], percent: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percent))] ?? 0;
}
test('real dual Workers report SQL/COMMIT separately and throwing observer cannot affect writes', async () => {
  const dataRoot = mkdtempSync('/private/tmp/kite-store-timing-');
  chmodSync(dataRoot, 0o700);
  const measurements: DbTiming[] = [];
  const perWorker: DbTiming[][] = [[], []];
  const first = await openSqliteStore({
    dataRoot,
    profile: 'test',
    onTiming(observation) {
      measurements.push(observation);
      perWorker[0]!.push(observation);
      throw new Error('observer fixture failure');
    },
  });
  const second = await openSqliteStore({
    dataRoot,
    profile: 'test',
    onTiming(observation) {
      measurements.push(observation);
      perWorker[1]!.push(observation);
    },
  });
  try {
    const expectedStoreId = (await first.getMetadata()).storeId;
    await first.createWorkspace({
      expectedStoreId,
      id: 'w',
      rootUri: 'file:///fixture',
      name: 'w',
    });
    await Promise.all(
      Array.from({ length: 2 }, async (_, ordinal) => {
        const store = ordinal ? second : first;
        const sessionId = `s${ordinal}`;
        await store.createSession({
          expectedStoreId,
          commandId: `create${ordinal}`,
          sessionId,
          workspaceId: 'w',
          title: 'timing',
          subjectId: 'user',
        });
        const owner = (await store.acquireSessionOwner(sessionId, `owner${ordinal}`))!;
        await store.acceptCommand({
          expectedStoreId,
          commandId: `run${ordinal}`,
          sessionId,
          subjectId: 'user',
          request: { kind: 'run.start', content: 'fixed storage fixture' },
        });
        const run = await store.startRun({
          expectedStoreId,
          owner,
          commandId: `run${ordinal}`,
          configuration: { model: 'fixed-storage-fixture' },
        });
        const executionId = `model${ordinal}`;
        const source = { kind: 'model_request', requestId: executionId };
        await store.planExecution({
          expectedStoreId,
          owner,
          executionId,
          sessionId,
          runId: run.id,
          originCommandId: `run${ordinal}`,
          stepId: 'step',
          callId: 'model',
          kind: 'model',
          definitionId: 'fixed',
          definitionVersion: '1',
          input: {},
          decisionSource: source,
        });
        await store.markDispatching({
          expectedStoreId,
          owner,
          executionId,
          authorization: {
            allowed: true,
            revision: '0',
            definitionVersion: '1',
            inputDigest: await semanticDigest({}),
          },
          requirements: [],
          freshness: { checked: true, source },
        });
        const queries = Array.from({ length: 40 }, () => store.getView(sessionId));
        const bodies = Array.from({ length: 20 }, (_, index) =>
          store.persistModelPartial({
            expectedStoreId,
            owner,
            executionId,
            content: `fixed chunk ${index}`,
          }),
        );
        const cancellations = Array.from({ length: 4 }, (_, index) =>
          store.cancelCommand({
            expectedStoreId,
            commandId: `cancel-${ordinal}-${index}`,
            sessionId,
            targetCommandId: `run${ordinal}`,
            subjectId: 'user',
          }),
        );
        await Promise.all([...queries, ...bodies, ...cancellations]);
      }),
    );
    expect((await first.getSession('s0'))?.id).toBe('s0');
    expect((await second.getSession('s1'))?.id).toBe('s1');
    const samples = measurements.filter((sample) => sample.operation !== 'open');
    expect(samples.length).toBeGreaterThan(100);
    expect(
      samples.every(
        (sample) =>
          sample.sqlDurationMs !== undefined &&
          sample.sqlDurationMs >= 0 &&
          sample.queueWaitMs >= 0 &&
          sample.totalMs >= sample.queueWaitMs,
      ),
    ).toBe(true);
    const commits = samples.filter((sample) => sample.commitMs !== undefined);
    expect(commits.length).toBeGreaterThan(40);
    expect(
      samples
        .filter((sample) => sample.operation === 'getView')
        .every((sample) => sample.commitMs !== undefined),
    ).toBe(true);
    expect(
      measurements
        .filter((sample) => sample.operation === 'open')
        .every((sample) => sample.sqlDurationMs === undefined && sample.commitMs === undefined),
    ).toBe(true);
    expect(samples.filter((sample) => sample.operation === 'persistModelPartial')).toHaveLength(40);
    expect(samples.filter((sample) => sample.operation === 'cancelCommand')).toHaveLength(8);
    for (const worker of perWorker) {
      const lastQuery =
        worker.length -
        1 -
        [...worker].reverse().findIndex((sample) => sample.operation === 'getView');
      expect(worker.findIndex((sample) => sample.operation === 'cancelCommand')).toBeLessThan(
        lastQuery,
      );
      expect(worker.findIndex((sample) => sample.operation === 'persistModelPartial')).toBeLessThan(
        lastQuery,
      );
    }
    console.log(
      JSON.stringify({
        fixture: 'dual-worker-fixed-storage',
        samples: samples.length,
        workerQueueMs: {
          p50: percentile(
            samples.map((sample) => sample.queueWaitMs),
            0.5,
          ),
          p95: percentile(
            samples.map((sample) => sample.queueWaitMs),
            0.95,
          ),
        },
        sqlMs: {
          p50: percentile(
            samples.map((sample) => sample.sqlDurationMs!),
            0.5,
          ),
          p95: percentile(
            samples.map((sample) => sample.sqlDurationMs!),
            0.95,
          ),
        },
        commitMs: {
          p50: percentile(
            commits.map((sample) => sample.commitMs!),
            0.5,
          ),
          p95: percentile(
            commits.map((sample) => sample.commitMs!),
            0.95,
          ),
        },
        workerTotalMs: {
          p95: percentile(
            samples.map((sample) => sample.totalMs),
            0.95,
          ),
        },
        transportMs: 'not_measured',
        initializationSqlMs: 'not_measured',
      }),
    );
  } finally {
    await first.close();
    await second.close();
    rmSync(dataRoot, { recursive: true, force: true });
  }
});
