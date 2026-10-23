import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { compressionSteeringBinding, guidance } from './run-resume-compression-steering-fixture';

const [directory, cut] = process.argv.slice(2) as [string, string];
const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
let readEntered!: () => void, releaseRead!: () => void;
const readReady = new Promise<void>((resolve) => {
  readEntered = resolve;
});
const readRelease = new Promise<void>((resolve) => {
  releaseRead = resolve;
});
async function stop(executionId: string) {
  const run = (await store.getView('s')).runs[0]!;
  const session = (await store.getSession('s'))!;
  const executions = await store.listExecutions('s');
  writeFileSync(
    join(directory, 'ready.tmp'),
    JSON.stringify({
      expectedStoreId,
      runId: run.id,
      expectedOwnerGeneration: session.ownerGeneration,
      executionId,
      readExecutionId: executions.find((execution) => execution.kind === 'tool')!.id,
    }),
  );
  renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
  await new Promise<void>(() => {});
}
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'finishExecution' && cut === 'summary-complete')
      return async (input: Parameters<Store['finishExecution']>[0]) => {
        const result = await store.finishExecution(input);
        const execution = await store.getExecution(input.executionId);
        if (
          execution?.status === 'succeeded' &&
          (execution.decisionSource as { compressionId?: string }).compressionId
        )
          await stop(execution.id);
        return result;
      };
    if (key === 'commitCompression' && cut === 'published')
      return async (input: Parameters<Store['commitCompression']>[0]) => {
        const result = await store.commitCompression(input);
        await stop(result.modelExecutionId);
        return result;
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
const binding = compressionSteeringBinding(directory, undefined, async () => {
  readEntered();
  await readRelease;
});
const runtime = createRuntime({
  store: wrapped,
  artifacts: createArtifactStore({ profile, store: wrapped }),
  permissions: binding.permissions!,
  resolveRunConfiguration: async () => binding,
});
const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'owned',
  rootUri: pathToFileURL(directory).href,
});
await runtime.createSession({ ...base, commandId: 'create', workspaceId: 'w', title: 'recovery' });
await runtime.submitCommand({
  ...base,
  commandId: 'work',
  request: {
    kind: 'run.start',
    content:
      'Read owned material once, then report using Red until corrected. Never repeat a completed read.',
  },
});
await readReady;
const run = (await store.getView('s')).runs[0]!;
await runtime.submitCommand({
  ...base,
  commandId: 'original-guide',
  request: {
    kind: 'input.steer',
    targetRunId: run.id,
    contextSelectionId: run.contextSelectionId,
    content: guidance,
  },
});
releaseRead();
await new Promise<void>(() => {});
