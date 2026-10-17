import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { streakBinding } from './run-resume-streak-fixture';

const [directory, mode] = process.argv.slice(2) as [string, string];
writeFileSync(join(directory, 'ledger'), '');
writeFileSync(join(directory, 'source-revision'), 'old');
const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'test' });
const expectedStoreId = (await store.getMetadata()).storeId;
async function stop(executionId: string) {
  const session = (await store.getSession('s'))!;
  const run = (await store.getView('s')).runs.find((item) => item.isActive)!;
  writeFileSync(
    join(directory, 'ready.tmp'),
    JSON.stringify({
      expectedStoreId,
      runId: run.id,
      expectedOwnerGeneration: session.ownerGeneration,
      executionId,
    }),
  );
  renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
  await new Promise<void>(() => {});
}
let models = 0,
  tools = 0;
const preserve = mode.includes('preserve');
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'markDispatching')
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        const execution = await store.getExecution(input.executionId);
        if (
          execution?.kind === 'model' &&
          ++models === (preserve && !mode.endsWith('_legacy') ? 3 : 2) &&
          mode.startsWith('prior')
        )
          await stop(execution.id);
        return store.markDispatching(input);
      };
    if (key === 'finishExecution')
      return async (input: Parameters<Store['finishExecution']>[0]) => {
        const result = await store.finishExecution(input);
        const execution = await store.getExecution(input.executionId);
        if (
          execution?.kind === 'tool' &&
          ++tools === (preserve ? 5 : 4) &&
          mode.startsWith('last')
        ) {
          // Restore the original source before cold preflight; the saved rejection remains real.
          writeFileSync(join(directory, 'source-revision'), 'old');
          await stop(execution.id);
        }
        return result;
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const runtime = createRuntime({
  store: wrapped,
  permissions: streakBinding(directory, mode).permissions!,
  resolveRunConfiguration: async () => streakBinding(directory, mode),
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'w',
  rootUri: pathToFileURL(directory).href,
});
await runtime.createSession({
  expectedStoreId,
  sessionId: 's',
  commandId: 'create',
  workspaceId: 'w',
  subjectId: 'owner',
  title: 'streak',
});
await runtime.submitCommand({
  expectedStoreId,
  sessionId: 's',
  commandId: 'work',
  subjectId: 'owner',
  request: { kind: 'run.start', content: 'Original effects' },
});
await new Promise<void>(() => {});
