import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { stopWorkConfiguration } from './stop-work.fixture';

const root = process.argv[2]!;
const profile = { dataRoot: join(root, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'finishExecution')
      return async (input: Parameters<Store['finishExecution']>[0]) => {
        const result = await target.finishExecution(input);
        if (result.kind === 'tool' && result.status === 'succeeded') {
          writeFileSync(
            join(root, 'ready.json'),
            JSON.stringify({
              expectedStoreId,
              executionId: result.id,
              runId: result.runId,
              expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
            }),
          );
          await new Promise(() => {});
        }
        return result;
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const config = stopWorkConfiguration(root);
const runtime = createRuntime({
  store: wrapped,
  permissions: config.permissions!,
  artifacts: createArtifactStore({ profile, store: wrapped }),
  resolveRunConfiguration: async () => config,
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
  title: 'stop',
});
await runtime.submitCommand({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'work',
  request: { kind: 'run.start', content: 'Original task' },
});
await new Promise(() => {});
