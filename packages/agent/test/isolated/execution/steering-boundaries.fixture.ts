import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createTaskExtension } from '../../../src/extensions/task';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

export const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
export const finalBody = 'Actual child final only 雪🙂\nComplete second line.';
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(5);
  }
  throw Error(`steering_boundary_timeout:${label}`);
}
export async function fixture(options: {
  response: (
    request: ModelRequest,
    index: number,
    signal: AbortSignal,
  ) => AsyncGenerator<ModelEvent>;
  child?: boolean;
  afterApply?: () => Promise<void>;
  beforeFinish?: () => Promise<void>;
}) {
  const root = mkdtempSync(join(tmpdir(), 'kite-steering-boundaries-'));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  let appliedHeld = false,
    finishHeld = false;
  const observed = new Proxy(store, {
    get(target, key) {
      if (key === 'applyInput')
        return async (input: Parameters<Store['applyInput']>[0]) => {
          const result = await target.applyInput(input);
          if (input.kind === 'steer' && options.afterApply && !appliedHeld) {
            appliedHeld = true;
            await options.afterApply();
          }
          return result;
        };
      if (key === 'finishRun')
        return async (input: Parameters<Store['finishRun']>[0]) => {
          if (input.status === 'completed' && options.beforeFinish && !finishHeld) {
            finishHeld = true;
            await options.beforeFinish();
          }
          return target.finishRun(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const requests: ModelRequest[] = [],
    childRequests: ModelRequest[] = [];
  const childGate = gate();
  const effects: string[] = [],
    answers: unknown[] = [];
  const runtime = createRuntime({
    store: observed,
    artifacts: createArtifactStore({ profile, store }),
    modelId: 'parent',
    modelConcurrency: 4,
    model: {
      async *stream(request, { signal }) {
        requests.push(structuredClone(request));
        if (options.child && requests.length === 1) {
          yield {
            type: 'tool_call',
            id: 'spawn',
            name: 'spawn_agent',
            arguments: JSON.stringify({
              prompt: 'Return the complete assigned final result only.',
            }),
          };
          yield { ...finish, reason: 'tool_calls' };
        } else yield* options.response(request, requests.length, signal);
      },
    },
    extensions: [
      createTaskExtension({
        roles: [{ id: 'worker', configurationId: 'worker', description: 'Owned child' }],
      }),
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.effect',
            version: '1',
            description: 'Record a harmless actual adapter effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects.push('effect');
              return { outcome: 'succeeded', content: 'Actual adapter completed' };
            },
          },
          {
            id: 'fixture.question',
            version: '1',
            description: 'Ask a precise informational question',
            inputSchema: { type: 'object' },
            async execute(_input, context) {
              answers.push(
                await context.requestInput({
                  title: 'Choose the original value',
                  schema: { type: 'string', enum: ['accurate'] },
                }),
              );
              return { outcome: 'succeeded', content: 'Original answer accepted' };
            },
          },
        ],
      },
    ],
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        modelId: 'child',
        snapshot: {},
        toolIds: [],
        model: {
          async *stream(request) {
            childRequests.push(structuredClone(request));
            await childGate.promise;
            yield { type: 'text_delta', text: finalBody };
            yield finish;
          },
        },
      },
    ],
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    afterTurn: {
      async authorize() {
        return { allowed: true, revision: 'owned-continuation' };
      },
    },
  });
  const scope = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 'root',
    subjectId: 'owner',
  };
  await runtime.createWorkspace({
    expectedStoreId: scope.expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({ ...scope, commandId: 'create', workspaceId: 'w', title: 'root' });
  return {
    store,
    runtime,
    scope,
    profile,
    requests,
    childRequests,
    childGate,
    effects,
    answers,
    start: () =>
      runtime.submitCommand({
        ...scope,
        commandId: 'work',
        request: { kind: 'run.start', content: 'Original task' },
      }),
    async steer(id: string, content: string, targetRunId?: string) {
      const view = await store.getView('root');
      return runtime.submitCommand({
        ...scope,
        commandId: id,
        request: {
          kind: 'input.steer',
          content,
          targetRunId: targetRunId ?? view.runs.find((run) => run.isActive)!.id,
          contextSelectionId: view.session.contextSelectionId,
        },
      });
    },
    async follow(id: string, content: string, afterRunId: string) {
      const session = (await store.getSession('root'))!;
      return runtime.submitCommand({
        ...scope,
        commandId: id,
        request: {
          kind: 'input.follow_up',
          content,
          afterRunId,
          contextSelectionId: session.contextSelectionId,
        },
      });
    },
    inbox: () => store.listAgentMessages(scope),
    async close() {
      childGate.release();
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
