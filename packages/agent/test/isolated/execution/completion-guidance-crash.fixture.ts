import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { guidanceConfiguration } from './completion-guidance.fixture';

const [root, frontier] = process.argv.slice(2) as [string, string];
const profile = { dataRoot: join(root, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
let models = 0;
async function hold(executionId: string) {
  const run = (await store.getView('s')).runs.find((run) => run.isActive)!;
  writeFileSync(
    join(root, 'ready.json'),
    JSON.stringify({
      expectedStoreId,
      runId: run.id,
      executionId,
      expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
    }),
  );
  await new Promise(() => {});
}
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'markDispatching' && frontier.endsWith('planned'))
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        const row = await store.getExecution(input.executionId);
        if (row?.kind === 'model' && ++models === 2) await hold(row.id);
        return store.markDispatching(input);
      };
    if (key === 'finishExecution' && frontier.endsWith('settled'))
      return async (input: Parameters<Store['finishExecution']>[0]) => {
        const result = await store.finishExecution(input);
        const row = await store.getExecution(input.executionId);
        if (row?.kind === 'model' && ++models === 2) await hold(row.id);
        return result;
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const config = guidanceConfiguration(root);
const actualConfig = frontier.startsWith('static-') ? { ...config, extensions: undefined } : config;
const runtime = createRuntime({
  extensions: frontier.startsWith('static-') ? config.extensions : undefined,
  permissions: config.permissions!,
  store: wrapped,
  artifacts: createArtifactStore({ profile, store: wrapped }),
  resolveRunConfiguration: async () => actualConfig,
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'temporary',
  rootUri: pathToFileURL(root).href,
});
await runtime.createSession({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'create',
  workspaceId: 'w',
  title: 'guidance',
});
await runtime.submitCommand({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'work',
  request: { kind: 'run.start', content: 'Original task' },
});
await new Promise(() => {});
