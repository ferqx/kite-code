import { renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const directory = process.argv[2]!;
const store = await openSqliteStore({ dataRoot: join(directory, 'data'), profile: 'owned' });
const expectedStoreId = (await store.getMetadata()).storeId;
const runtime = createRuntime({
  store,
  modelId: 'fixed',
  model: {
    async *stream(request) {
      const execution = (await store.getExecution(request.requestId!))!;
      writeFileSync(
        join(directory, 'ready.tmp'),
        JSON.stringify({
          expectedStoreId,
          executionId: execution.id,
          runId: execution.runId,
          expectedOwnerGeneration: (await store.getSession('s'))!.ownerGeneration,
        }),
      );
      renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
      await new Promise<void>(() => {});
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  },
  permissions: {
    async authorize() {
      return { allowed: true, revision: 'actual' };
    },
  },
});
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'history boundary',
  rootUri: pathToFileURL(directory).href,
});
await runtime.createSession({
  expectedStoreId,
  sessionId: 's',
  workspaceId: 'w',
  commandId: 'create',
  subjectId: 'owner',
  title: 'history boundary',
});
await runtime.submitCommand({
  expectedStoreId,
  sessionId: 's',
  commandId: 'original',
  subjectId: 'owner',
  request: {
    kind: 'run.start',
    content: 'Original unfinished user instruction 雪🙂',
    files: [{ name: 'original.txt', uri: pathToFileURL(join(directory, 'original.txt')).href }],
  },
});
await new Promise<void>(() => {});
