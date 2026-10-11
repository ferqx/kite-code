import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime, type RunConfiguration } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export const parallelResult = (name: string) => `${`${name}:雪🙂\r\n`.repeat(1000)}${name}:TAIL`;
export function parallelBinding(directory: string): RunConfiguration {
  return {
    modelId: 'parallel-fixed',
    snapshot: { fixture: 'parallel-resume', version: 1 },
    model: {
      async *stream(request) {
        appendFileSync(join(directory, 'models'), `${JSON.stringify(request)}\n`);
        if (request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'text_delta', text: 'both original results consumed' };
          yield finish;
          return;
        }
        for (const name of ['A', 'B'])
          yield {
            type: 'tool_call',
            id: `call-${name}`,
            name: `effect.${name}`,
            arguments: JSON.stringify({ original: name }),
          };
        yield { ...finish, reason: 'tool_calls' };
      },
    },
    permissions: {
      async authorize(request) {
        appendFileSync(
          join(directory, 'permissions'),
          `${JSON.stringify({ kind: request.kind, executionId: request.executionId, definitionId: request.definitionId, input: request.input })}\n`,
        );
        if (request.kind === 'tool' && request.definitionId === 'effect.A')
          return {
            allowed: false,
            revision: 'original-policy',
            approval: { request: { title: 'Approve exact original A' }, grants: ['approve_once'] },
          };
        return { allowed: true, revision: 'original-policy' };
      },
    },
    extensions: [
      {
        id: 'parallel.fixture',
        version: '1',
        apiMajor: 1,
        tools: ['A', 'B'].map((name) => ({
          id: `effect.${name}`,
          version: '1',
          description: `Original ${name} effect`,
          inputSchema: {
            type: 'object',
            properties: { original: { const: name } },
            required: ['original'],
            additionalProperties: false,
          },
          async execute(input) {
            appendFileSync(join(directory, 'effects'), `${JSON.stringify({ name, input })}\n`);
            return { outcome: 'succeeded', content: parallelResult(name) };
          },
        })),
      },
    ],
  };
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw Error('Explicit disposable parallel fixture root required.');
  for (const name of ['models', 'permissions', 'effects']) writeFileSync(join(directory, name), '');
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    permissions: parallelBinding(directory).permissions!,
    artifacts: createArtifactStore({ profile, store }),
    resolveRunConfiguration: async () => parallelBinding(directory),
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'Owned',
    rootUri: pathToFileURL(directory).href,
  });
  await runtime.createSession({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Original parallel batch',
  });
  await runtime.submitCommand({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'work',
    sessionId: 's',
    request: { kind: 'run.start', content: 'original batch' },
  });
  const deadline = Date.now() + 3000;
  for (;;) {
    const view = await store.getView('s');
    const a = view.executions.find((row) => row.definitionId === 'effect.A');
    const b = view.executions.find((row) => row.definitionId === 'effect.B');
    const cards = await runtime.listInteractions({
      expectedStoreId,
      sessionId: 's',
      state: 'pending',
    });
    if (a?.status === 'planned' && b?.status === 'succeeded' && cards.interactions.length === 1) {
      const session = (await store.getSession('s'))!;
      writeFileSync(
        join(directory, 'ready.tmp'),
        JSON.stringify({
          pid: process.pid,
          expectedStoreId,
          runId: view.runs[0]!.id,
          expectedOwnerGeneration: session.ownerGeneration,
          a,
          b,
          model: view.executions.find((row) => row.kind === 'model'),
          card: cards.interactions[0],
          view,
        }),
      );
      renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
      await new Promise<void>(() => {});
    }
    if (Date.now() >= deadline) throw Error('parallel_planned_success_boundary_unconfirmed');
    await Bun.sleep(5);
  }
}
