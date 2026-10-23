import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { steeringAgentOptions } from './run-resume-steering-agent-fixture';

const directory = process.argv[2]!;
writeFileSync(join(directory, 'ledger'), '');
const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
const store = await openSqliteStore(profile);
const expectedStoreId = (await store.getMetadata()).storeId;
let childRunId = '',
  childExecutionId = '',
  steerId = '';
const wrapped = new Proxy(store, {
  get(target, key) {
    if (key === 'markDispatching')
      return async (input: Parameters<Store['markDispatching']>[0]) => {
        const execution = await store.getExecution(input.executionId);
        if (execution?.kind === 'model' && execution.sessionId !== 's') {
          childRunId = execution.runId!;
          childExecutionId = execution.id;
          writeFileSync(join(directory, 'child-planned'), execution.id);
          await new Promise<void>(() => {});
        }
        return store.markDispatching(input);
      };
    if (key === 'acceptAgentInput')
      return async (input: Parameters<Store['acceptAgentInput']>[0]) => {
        const command = await store.acceptAgentInput(input);
        steerId = command.id;
        await store.applyInput({
          expectedStoreId,
          owner: input.owner,
          commandId: command.id,
          kind: 'steer',
          runId: input.targetRunId,
        });
        return (await store.getCommand(command.id))!;
      };
    if (key === 'persistModelPartial')
      return async (input: Parameters<Store['persistModelPartial']>[0]) => {
        const result = await store.persistModelPartial(input);
        const execution = await store.getExecution(input.executionId);
        if (execution?.sessionId === 's' && steerId) {
          const run = (await store.getView('s')).runs.find((run) => run.isActive)!;
          const session = (await store.getSession('s'))!;
          writeFileSync(
            join(directory, 'ready.tmp'),
            JSON.stringify({
              expectedStoreId,
              runId: run.id,
              expectedOwnerGeneration: session.ownerGeneration,
              executionId: execution.id,
              childRunId,
              childExecutionId,
              steerId,
            }),
          );
          renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
          await new Promise<void>(() => {});
        }
        return result;
      };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  },
}) as Store;
const runtime = createRuntime({
  store: wrapped,
  artifacts: createArtifactStore({ profile, store: wrapped }),
  ...steeringAgentOptions(directory),
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'owned',
  rootUri: pathToFileURL(directory).href,
});
await runtime.createSession({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'create',
  workspaceId: 'w',
  title: 'owned',
});
await runtime.submitCommand({
  expectedStoreId,
  sessionId: 's',
  subjectId: 'owner',
  commandId: 'work',
  request: { kind: 'run.start', content: 'Parent original task' },
});
await new Promise<void>(() => {});
