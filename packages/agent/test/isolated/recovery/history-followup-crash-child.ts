import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { historyBinding } from './history-followup-fixture';

const [directory, baseURL] = process.argv.slice(2) as [string, string];
const profile = { dataRoot: join(directory, 'data'), profile: 'owned' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'markDispatching')
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        if ((await store.getExecution(input.executionId))?.kind === 'tool') {
          writeFileSync(
            join(directory, 'ready.json'),
            JSON.stringify({
              expectedStoreId,
              executionId: input.executionId,
              expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
            }),
          );
          await new Promise<void>(() => {});
        }
        return store.markDispatching(input);
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const runtime = createRuntime({
  store: wrapped,
  artifacts: createArtifactStore({ profile, store: wrapped }),
  ...historyBinding(directory, baseURL),
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'owned',
  rootUri: `file://${directory}`,
});
await runtime.createSession({
  expectedStoreId,
  commandId: 'create',
  sessionId: 's',
  workspaceId: 'w',
  title: 'Original',
  subjectId: 'owner',
});
await runtime.submitCommand({
  expectedStoreId,
  commandId: 'work',
  sessionId: 's',
  subjectId: 'owner',
  request: { kind: 'run.start', content: 'Original decision' },
});
await new Promise<void>(() => {});
