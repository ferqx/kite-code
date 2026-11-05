import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import { initializeSqliteEngine } from '../../../src/sqlite-engine';
import { authorizationClockBinding } from './authorization-check-clock-fixture';

const [directory, engine, shape] = process.argv.slice(2) as [string, string, string];
initializeSqliteEngine(JSON.parse(engine));
const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
const ensure = store.ensureAuthorizationCheck.bind(store);
if (shape === 'pre-metadata')
  store.ensureAuthorizationCheck = (input) => {
    const { operationKey: _operation, timeout: _timeout, ...original } = input;
    return ensure(original);
  };
const request = store.requestInteraction.bind(store);
store.requestInteraction = async (input) => {
  const result = await request(input);
  if (result.kind === 'approval') {
    const target = (await store.getExecution(result.executionId))!;
    const check = (await store.listExecutions('s')).find(
      (item) => item.kind === 'model' && item.runId === null,
    )!;
    const checkCommand = (await store.getCommand(check.originCommandId))!;
    writeFileSync(
      join(directory, 'ready.tmp'),
      JSON.stringify({
        expectedStoreId,
        runId: target.runId,
        expectedOwnerGeneration: target.ownerGeneration,
        targetId: target.id,
        checkId: check.id,
        checkPayload: (checkCommand.request as { input: unknown }).input,
      }),
    );
    renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
    await new Promise<never>(() => {});
  }
  return result;
};
const runtime = createRuntime({
  store,
  artifacts: createArtifactStore({ profile, store }),
  ...authorizationClockBinding(
    directory,
    true,
    { checks: 0, models: 0, effects: 0 },
    shape === 'host-projection',
  ),
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'Owned',
  rootUri: pathToFileURL(directory).href,
});
await runtime.createSession({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'create',
  workspaceId: 'w',
  title: 'Native clock',
});
await runtime.submitCommand({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'work',
  request: {
    kind: 'run.start',
    content: 'Perform the exact harmless effect after independent human approval',
  },
});
await new Promise<never>(() => {});
