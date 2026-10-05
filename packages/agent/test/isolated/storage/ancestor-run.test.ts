import { expect, test } from 'bun:test';
import { createRuntime } from '../../../src';
import type { Store } from '../../../src/storage/port';
import type { CommandRecord, ExecutionRecord, RunRecord } from '../../../src/storage/types';

// A finite readonly Store fixture isolates ancestry validation; actual detached work is
// separately exercised by child/runtime and child/bindings with SQLite and real adapters.
test('nearest original Run follows a finite detached ancestry and rejects broken, cyclic or mismatched bindings', async () => {
  const command = {
    id: 'original',
    sessionId: 's',
    originStoreId: 'store',
    rootWorkCommandId: 'original',
    rootWorkSeq: '1',
    subjectId: 'user',
  } as CommandRecord;
  const run = {
    ...command,
    id: 'run',
    originCommandId: command.id,
    configuration: { snapshot: { skillSelection: { requested: [], resolvedIds: [] } } },
  } as unknown as RunRecord;
  const root = {
    ...command,
    id: 'root',
    originCommandId: command.id,
    runId: run.id,
    parentExecutionId: null,
  } as unknown as ExecutionRecord;
  const middle = { ...root, id: 'middle', runId: null, parentExecutionId: root.id };
  const origin = { ...middle, id: 'job', parentExecutionId: middle.id };
  const records = new Map([
    [root.id, root],
    [middle.id, middle],
  ]);
  let actualRun: RunRecord | null = run;
  const store = {
    getCommand: async () => command,
    getExecution: async (id: string) => records.get(id) ?? null,
    getRun: async () => actualRun,
  } as unknown as Store;
  const runtime = createRuntime({
    store,
    permissions: {
      async authorize() {
        return { allowed: false, revision: '1' };
      },
    },
  });
  const nearest = (
    runtime as unknown as {
      nearestParentRun(
        origin: ExecutionRecord,
      ): Promise<{ ancestor: ExecutionRecord; run: RunRecord | null }>;
    }
  ).nearestParentRun.bind(runtime);
  expect((await nearest(origin)).run).toEqual(run);
  expect((await nearest(origin)).ancestor.id).toBe('root');
  const reject = async (candidate: ExecutionRecord) => {
    const error = await nearest(candidate).catch((error: unknown) => error);
    expect((error as { code?: string }).code).toBe('invalid_child_parent');
  };
  await reject({ ...origin, parentExecutionId: 'missing' });
  records.set('middle', { ...middle, parentExecutionId: 'middle' });
  await reject(origin);
  for (const field of ['sessionId', 'originStoreId', 'rootWorkCommandId', 'rootWorkSeq'] as const) {
    records.set('middle', { ...middle, [field]: 'foreign' });
    await reject(origin);
  }
  records.set('middle', middle);
  actualRun = null;
  await reject(origin);
  for (const field of [
    'sessionId',
    'originStoreId',
    'rootWorkCommandId',
    'rootWorkSeq',
    'originCommandId',
  ] as const) {
    actualRun = { ...run, [field]: 'foreign' };
    await reject(origin);
  }
  actualRun = run;
  for (let index = 0; index < 33; index++)
    records.set(`chain-${index}`, {
      ...middle,
      id: `chain-${index}`,
      parentExecutionId: index === 32 ? root.id : `chain-${index + 1}`,
    });
  await reject({ ...origin, parentExecutionId: 'chain-0' });
  expect((await nearest({ ...root, runId: null })).run).toBeNull();
});
