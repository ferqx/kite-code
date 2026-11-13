import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { Extension } from '../../../src/extensions';
import { createTaskExtension } from '../../../src/extensions/task';
import { createRuntime, type RunConfiguration, type RuntimeOptions } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

export type MessageResumeDrift = 'none' | 'description' | 'schema' | 'snapshot';
const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export function childMessageResumeOptions(
  directory: string,
  pauseParent: boolean,
  drift: MessageResumeDrift = 'none',
): Omit<RuntimeOptions, 'store' | 'artifacts'> {
  const task = createTaskExtension({
    roles: [
      { id: 'worker', configurationId: 'worker', description: 'Exact recovery collaborator' },
    ],
  });
  const effect: Extension = {
    id: 'fixture.child-message',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'effect.once',
        version: '1',
        description:
          drift === 'description' ? 'Changed effect description' : 'Original exact effect',
        inputSchema: {
          type: 'object',
          properties: { original: { const: drift === 'schema' ? 'changed' : 'once' } },
          required: ['original'],
          additionalProperties: false,
        },
        async execute(input, context) {
          appendFileSync(
            join(directory, 'effects'),
            `${JSON.stringify({ id: context.executionId, input })}\n`,
          );
          return { outcome: 'succeeded', content: 'original effect exactly once' };
        },
      },
    ],
  };
  const extensions = [task, effect];
  const permissions: NonNullable<RuntimeOptions['permissions']> = {
    async authorize(request) {
      if (request.kind === 'tool' && request.definitionId === 'effect.once')
        return {
          allowed: false,
          revision: 'original-policy',
          approval: {
            request: { title: 'Approve original child effect' },
            options: [
              { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
            ],
          },
        };
      return { allowed: true, revision: 'original-policy' };
    },
  };
  const model = (actor: 'parent' | 'child'): ModelAdapter => ({
    async *stream(request) {
      appendFileSync(join(directory, 'models'), `${JSON.stringify({ actor, request })}\n`);
      if (actor === 'child') {
        if (request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'text_delta', text: 'child consumed the original effect' };
          yield finish;
        } else {
          yield {
            type: 'tool_call',
            id: 'original-effect-call',
            name: 'effect.once',
            arguments: '{"original":"once"}',
          };
          yield { ...finish, reason: 'tool_calls' };
        }
        return;
      }
      if (!request.messages.some((message) => message.role === 'tool')) {
        yield {
          type: 'tool_call',
          id: 'original-child-call',
          name: 'spawn_agent',
          arguments: '{"prompt":"Execute the original effect once and report its result."}',
        };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      // Keep the root at a recoverable Model boundary, never inside a
      // non-resumable mailbox Tool. The child already has its own planned Tool.
      if (pauseParent) await new Promise<void>(() => {});
      yield { type: 'text_delta', text: 'parent preserves the original collaborator' };
      yield finish;
    },
  });
  const rootModel = model('parent');
  const childModel = model('child');
  const rootIds = [...task.tools!.map((tool) => tool.id), 'effect.once'];
  const childIds = ['task.message', 'task.events', 'effect.once'];
  const binding = (child: boolean): RunConfiguration => ({
    model: child ? childModel : rootModel,
    modelId: child ? 'child-message-fixed' : 'parent-message-fixed',
    toolIds: child ? childIds : rootIds,
    permissions,
    snapshot: { fixture: 'child-message-resume', child, version: 1 },
    readStepCapabilities: async () => ({
      extensions: [],
      toolIds: child ? childIds : rootIds,
      snapshot: { fixture: 'child-message-step', child, changed: drift === 'snapshot' },
    }),
  });
  return {
    model: rootModel,
    modelId: 'parent-message-fixed',
    extensions,
    permissions,
    modelConcurrency: 2,
    resolveRunConfiguration: async () => binding(false),
    resolveRecoveryRunConfiguration: async () => binding(false),
    childConfigurations: [{ ...binding(true), id: 'worker', version: '1', model: childModel }],
  };
}

if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (!directory) throw Error('Explicit disposable child-message recovery root required.');
  for (const name of ['models', 'effects']) writeFileSync(join(directory, name), '');
  const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const expectedStoreId = (await store.getMetadata()).storeId;
  const runtime = createRuntime({
    store,
    artifacts: createArtifactStore({ profile, store }),
    ...childMessageResumeOptions(directory, true),
  });
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'w',
    name: 'Owned recovery fixture',
    rootUri: pathToFileURL(directory).href,
  });
  await runtime.createSession({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'create',
    sessionId: 's',
    workspaceId: 'w',
    title: 'Current child recovery catalogue',
  });
  await runtime.submitCommand({
    expectedStoreId,
    subjectId: 'owner',
    commandId: 'work',
    sessionId: 's',
    request: { kind: 'run.start', content: 'Delegate the original once-only effect.' },
  });
  const deadline = Date.now() + 7000;
  for (;;) {
    const root = await store.getView('s');
    const carrier = root.executions.find((row) => row.childSessionId);
    const child = carrier?.childSessionId ? await store.getView(carrier.childSessionId) : undefined;
    const effect = child?.executions.find((row) => row.definitionId === 'effect.once');
    const cards = await runtime.listInteractions({
      expectedStoreId,
      sessionId: 's',
      state: 'pending',
    });
    if (
      effect?.status === 'planned' &&
      child?.executions.some((row) => row.kind === 'model' && row.status === 'succeeded') &&
      root.executions.some(
        (row) => row.kind === 'model' && ['planned', 'dispatching', 'running'].includes(row.status),
      ) &&
      cards.interactions.length === 1
    ) {
      writeFileSync(
        join(directory, 'ready.tmp'),
        JSON.stringify({
          pid: process.pid,
          expectedStoreId,
          runId: root.runs[0]!.id,
          expectedOwnerGeneration: root.session.ownerGeneration,
          root,
          child,
          carrier,
          effect,
          card: cards.interactions[0],
        }),
      );
      renameSync(join(directory, 'ready.tmp'), join(directory, 'ready.json'));
      await new Promise<void>(() => {});
    }
    if (Date.now() >= deadline)
      throw Error(
        `child_planned_effect_not_reached:${JSON.stringify({
          root: root.executions.map(({ definitionId, status }) => ({ definitionId, status })),
          child: child?.executions.map(({ definitionId, status }) => ({ definitionId, status })),
          cards: cards.interactions.length,
        })}`,
      );
    await sleepTimer(5);
  }
}
