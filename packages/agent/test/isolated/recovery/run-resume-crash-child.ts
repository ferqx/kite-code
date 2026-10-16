import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { binding } from './run-resume-fixture';

const [directory, mode] = process.argv.slice(2) as [string, string];
writeFileSync(join(directory, 'ledger'), '');
const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
async function stop(executionId: string) {
  const run = (await store.getView('s')).runs.find((r) => r.isActive)!;
  const session = (await store.getSession('s'))!;
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
let settledTools = 0;
let dispatchedModels = 0;
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'markDispatching')
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        const ex = await store.getExecution(input.executionId);
        if (ex?.kind === 'model') {
          dispatchedModels++;
          if (
            mode.startsWith('planned_') ||
            (['length_planned', 'retry_planned'].includes(mode) && dispatchedModels === 2) ||
            (mode === 'length_history' && dispatchedModels === 3)
          )
            await stop(ex.id);
        }
        return store.markDispatching(input);
      };
    if (key === 'finishExecution')
      return async (input: Parameters<Store['finishExecution']>[0]) => {
        if (mode === 'dispatched' && (await store.getExecution(input.executionId))?.kind === 'tool')
          await stop(input.executionId);
        const result = await store.finishExecution(input);
        const ex = await store.getExecution(input.executionId);
        if (
          (mode === 'completion' && ex?.kind === 'model') ||
          (mode === 'length_response' && ex?.kind === 'model') ||
          (mode === 'retry_failed' && ex?.kind === 'model') ||
          (['tool_result', 'large'].includes(mode) && ex?.kind === 'tool') ||
          (mode === 'repeat_failure' && ex?.kind === 'tool' && ++settledTools === 4)
        )
          await stop(input.executionId);
        return result;
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const runtime = createRuntime({
  permissions: binding(directory, mode).permissions!,
  store: wrapped,
  artifacts: createArtifactStore({ profile, store: wrapped }),
  resolveRunConfiguration: async () => binding(directory, mode),
  ...(mode === 'initializer'
    ? {
        initializeRunRequirements: async () => {
          await stop('');
          return [];
        },
      }
    : {}),
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'owned',
  rootUri: `file://${directory}`,
});
await runtime.createSession({
  expectedStoreId,
  subjectId: 'owner',
  commandId: 'create',
  sessionId: 's',
  workspaceId: 'w',
  title: 'Original',
});
await runtime.submitCommand({
  expectedStoreId,
  subjectId: 'owner',
  commandId: 'work',
  sessionId: 's',
  request: { kind: 'run.start', content: 'original' },
});
await new Promise<void>(() => {});
