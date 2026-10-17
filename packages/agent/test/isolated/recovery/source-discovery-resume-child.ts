import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createFileTools, createWorkspaceFiles } from '../../../src/files';
import { createRuntime, type RunConfiguration } from '../../../src/runtime';
import { createProjectSources } from '../../../src/sources';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export function discoveryBinding(directory: string) {
  const workspace = join(directory, 'workspace');
  const files = createWorkspaceFiles({ root: workspace });
  const sources = createProjectSources({
    workspaceRoot: async () => workspace,
    targetPaths: (request) => {
      const input = request.input;
      return input &&
        typeof input === 'object' &&
        !Array.isArray(input) &&
        typeof input.path === 'string'
        ? [input.path]
        : [];
    },
  });
  const tools = createFileTools(files).map((tool) => ({
    ...tool,
    async execute(...args: Parameters<typeof tool.execute>) {
      appendFileSync(
        join(directory, 'io.jsonl'),
        `${JSON.stringify({
          name: tool.id,
          path: (args[0] as { path: string }).path,
        })}\n`,
      );
      return tool.execute(...args);
    },
  }));
  const configuration: RunConfiguration = {
    modelId: 'fixed',
    snapshot: { fixture: 'source-discovery-resume' },
    model: {
      async *stream(request) {
        appendFileSync(join(directory, 'models.jsonl'), `${JSON.stringify(request)}\n`);
        if (request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'text_delta', text: 'Finished actual source discovery.' };
          yield finish;
          return;
        }
        for (const [id, name, path] of [
          ['package', 'files.read', 'package.json'],
          ['apps', 'files.list', 'apps'],
          ['packages', 'files.list', 'packages'],
          ['docs', 'files.list', 'docs'],
        ])
          yield { type: 'tool_call', id: id!, name: name!, arguments: JSON.stringify({ path }) };
        yield { ...finish, type: 'finish', reason: 'tool_calls' };
      },
    },
    sources,
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    extensions: [{ id: 'builtin.files', version: '1', apiMajor: 1, tools }],
  };
  return {
    configuration,
    async close() {
      await files.close();
      await sources.dispose();
    },
  };
}

if (import.meta.main) {
  const [directory, boundary] = process.argv.slice(2) as [string, string];
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  async function stop(executionId: string) {
    const run = (await store.getView('s')).runs.find((run) => run.isActive)!;
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
  const wrapped = new Proxy(store, {
    get(target, key) {
      if (key === 'finishExecution' && boundary === 'response')
        return async (input: Parameters<Store['finishExecution']>[0]) => {
          const value = await target.finishExecution(input);
          if ((await target.getExecution(input.executionId))?.kind === 'model')
            await stop(input.executionId);
          return value;
        };
      if (key === 'markDispatching' && boundary === 'results')
        return async (input: Parameters<Store['markDispatching']>[0]) => {
          const execution = await target.getExecution(input.executionId);
          if (
            execution?.kind === 'model' &&
            readFileSync(join(directory, 'models.jsonl'), 'utf8').trim().length &&
            (await target.listExecutions('s')).filter(
              (item) => item.kind === 'tool' && item.status === 'succeeded',
            ).length === 4
          )
            await stop(input.executionId);
          return target.markDispatching(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const fixture = discoveryBinding(directory);
  const runtime = createRuntime({
    store: wrapped,
    artifacts: createArtifactStore({ profile, store: wrapped }),
    permissions: fixture.configuration.permissions!,
    resolveRunConfiguration: async () => fixture.configuration,
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'w',
    rootUri: pathToFileURL(join(directory, 'workspace')).href,
  });
  await runtime.createSession({
    expectedStoreId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'discovery',
  });
  await runtime.submitCommand({
    expectedStoreId,
    sessionId: 's',
    commandId: 'work',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'Read the project evidence.' },
  });
  await new Promise<void>(() => {});
}
