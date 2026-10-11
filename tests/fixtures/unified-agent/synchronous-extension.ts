import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { createFixedModel } from '@kite-ai/ai';

const [root] = process.argv.slice(2);
if (!root) throw new Error('Explicit disposable fixture root required.');
const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
const model = createFixedModel([
  [
    { type: 'tool_call', id: 'call', name: 'fixture.synchronous', arguments: '{}' },
    {
      type: 'finish',
      reason: 'tool_calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    },
  ],
]);
const runtime = createRuntime({
  store,
  model,
  modelId: 'fixed',
  permissions: {
    async authorize() {
      return { allowed: true, revision: '1' };
    },
  },
  extensions: [
    {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.synchronous',
          version: '1',
          description: 'Deliberately blocks its trusted host thread',
          inputSchema: { type: 'object' },
          execute(_input, context) {
            const timeoutMs = 100;
            // A timer on this same thread is not an isolate or code preemption.
            const timer = new Promise<never>((_, reject) => {
              setTimeout(() => {
                writeFileSync(join(root, 'timer-fired.json'), 'true');
                reject(new Error('fixture_timeout'));
              }, timeoutMs);
            });
            const blocked = async () => {
              void runtime
                .getView('s')
                .then(() => writeFileSync(join(root, 'observation-returned.json'), 'true'));
              writeFileSync(
                join(root, 'entered.json'),
                JSON.stringify({
                  pid: process.pid,
                  executionId: context.executionId,
                  modelRequests: model.requests.length,
                  enteredAt: Date.now(),
                  timeoutMs,
                }),
              );
              for (;;) {
                // This is an actual synchronous infinite callback, not an unresolved Promise.
              }
            };
            return Promise.race([blocked(), timer]);
          },
        },
      ],
    },
  ],
});
const expectedStoreId = (await runtime.getMetadata()).storeId;
await runtime.createWorkspace({
  expectedStoreId,
  id: 'w',
  name: 'Disposable',
  rootUri: pathToFileURL(root).href,
});
await runtime.createSession({
  expectedStoreId,
  commandId: 'create',
  sessionId: 's',
  subjectId: 'owner',
  workspaceId: 'w',
  title: 'Synchronous boundary',
});
writeFileSync(join(root, 'ready.json'), JSON.stringify({ pid: process.pid, expectedStoreId }));
await runtime.submitCommand({
  expectedStoreId,
  commandId: 'work',
  sessionId: 's',
  subjectId: 'owner',
  request: { kind: 'run.start', content: 'Exercise the actual trusted synchronous boundary.' },
});
await runtime.waitForCommand('work');
throw new Error('The infinite callback must never return.');
