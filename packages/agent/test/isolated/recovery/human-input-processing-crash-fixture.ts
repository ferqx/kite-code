import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelEvent } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import { createRuntime, type RunConfiguration, type RuntimeOptions } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
export const permissions = {
  async authorize() {
    return { allowed: true, revision: 'fixture' };
  },
};
export function binding(
  root: string,
  effects = false,
  purpose: 'work' | 'progress' = 'work',
  scenario?: 'unresolved-tool-decision',
): RunConfiguration {
  return {
    modelId: 'original-A',
    snapshot: { original: 'immutable A' },
    permissions,
    ...(effects
      ? {
          extensions: [
            {
              id: 'fixture',
              version: '1',
              apiMajor: 1 as const,
              tools: [
                {
                  id: 'fixture.effect',
                  version: '1',
                  description: 'append the actual business effect',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                  async execute(_input: unknown, context: { executionId: string }) {
                    appendFileSync(join(root, 'ledger'), `effect:${context.executionId}\n`);
                    return { outcome: 'succeeded' as const, content: 'exact effect recorded' };
                  },
                },
              ],
            },
          ],
        }
      : {}),
    model: {
      async *stream(request) {
        const instruction = request.messages.find((m) =>
          m.content.includes('Original input identity:'),
        );
        appendFileSync(
          join(root, 'ledger'),
          `${instruction ? 'interpret' : 'business'}:${request.requestId}\n`,
        );
        if (instruction) {
          if (request.tools.length) throw Error('processing_tools_exposed');
          if (scenario === 'unresolved-tool-decision') {
            appendFileSync(join(root, 'ledger'), `readonly-request:${JSON.stringify(request)}\n`);
            if (
              !request.messages.some(
                (message) =>
                  message.role === 'tool' && message.toolCallId === 'hallucinated-follow-up',
              )
            ) {
              yield { type: 'text_delta', text: 'I will carry out this ambiguous request.' };
              yield {
                type: 'tool_call',
                id: 'hallucinated-follow-up',
                name: 'follow_up_agent',
                arguments: JSON.stringify({ agent_id: 's', prompt: 'Unauthorized follow-up.' }),
              };
              yield { ...finish, reason: 'tool_calls' };
              return;
            }
          }
          const identity = JSON.parse(
            instruction.content
              .split('\n')
              .find((line) => line.startsWith('Original input identity: '))!
              .slice('Original input identity: '.length),
          );
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              ...identity,
              relation: 'same_work',
              purpose,
              target_root_work_command_id: 'A',
              selection_effect: 'keep',
              answer: null,
              clarification: null,
            }),
          };
        } else {
          const lastUser = request.messages.reduce(
            (last, message, index) => (message.role === 'user' ? index : last),
            -1,
          );
          if (
            effects &&
            !request.messages.slice(lastUser + 1).some((message) => message.role === 'tool')
          ) {
            yield { type: 'tool_call', id: 'effect', name: 'fixture.effect', arguments: '{}' };
            yield { ...finish, reason: 'tool_calls' };
            return;
          }
          yield { type: 'text_delta', text: 'Business completed using original A.' };
        }
        yield finish;
      },
    },
  };
}
export async function runCrashFixture(
  root: string,
  window: string,
  host?: Partial<RuntimeOptions> & {
    permissionManagement?: (runtime: ReturnType<typeof createRuntime>) => unknown;
  },
  humanInputContent?: string,
) {
  const actual = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  let armed = false,
    proposals = 0;
  const store = new Proxy(actual, {
    get(target, key) {
      if (key === 'decideHumanInput')
        return async (input: Parameters<Store['decideHumanInput']>[0]) => {
          if (!armed || input.proposal.basis.kind !== 'model_proposal')
            return target.decideHumanInput(input);
          if (window === 'progress-race' && proposals++ === 0) {
            await runtime.submitCommand({
              expectedStoreId: input.expectedStoreId,
              sessionId: 's',
              subjectId: 'owner',
              commandId: 'B',
              request: { kind: 'run.start', content: '新任务：Independent B' },
            });
            return target.decideHumanInput(input);
          }
          if (window === 'decision' || window === 'unresolved-tool-decision')
            await target.decideHumanInput(input);
          const raw = (await target.getCommand(input.inputCommandId))!;
          const processing = (raw.receipt as { processingCommandId: string }).processingCommandId;
          const run = (await target.getView('s')).runs.find(
            (r) => r.originCommandId === processing,
          )!;
          const session = (await target.getSession('s'))!;
          console.log(
            JSON.stringify({
              storeId: input.expectedStoreId,
              rawId: raw.id,
              processingId: processing,
              runId: run.id,
              generation: session.ownerGeneration,
            }),
          );
          await new Promise(() => {});
          throw Error('unreachable');
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const runtime = createRuntime({
    ...host,
    store,
    artifacts: createArtifactStore({
      profile: { dataRoot: join(root, 'data'), profile: 'test' },
      store,
    }),
    permissions: host?.permissions ?? permissions,
    resolveRunConfiguration:
      host?.resolveRunConfiguration ??
      (async () =>
        binding(
          root,
          true,
          window.startsWith('progress') ? 'progress' : 'work',
          window === 'unresolved-tool-decision' ? window : undefined,
        )),
  });
  host?.permissionManagement?.(runtime);
  const storeId = (await store.getMetadata()).storeId;
  await runtime.createWorkspace({
    expectedStoreId: storeId,
    id: 'w',
    name: 'fixture',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    expectedStoreId: storeId,
    sessionId: 's',
    commandId: 'create',
    workspaceId: 'w',
    subjectId: 'owner',
    title: 'processing recovery',
  });
  await runtime.submitCommand({
    expectedStoreId: storeId,
    sessionId: 's',
    commandId: 'A',
    subjectId: 'owner',
    request: { kind: 'run.start', content: 'Original A' },
  });
  await runtime.waitForCommand('A');
  armed = true;
  // Existing selection + no explicit lexical routing requires the ordinary interpreter.
  await runtime.submitCommand({
    expectedStoreId: storeId,
    sessionId: 's',
    commandId: 'input',
    subjectId: 'owner',
    request: {
      kind: 'run.start',
      content:
        humanInputContent ??
        (window.startsWith('progress') ? '请问 A 的进度怎样？' : '核对一下原工作的事实并完成说明'),
    },
  });
  await new Promise(() => {});
}

if (import.meta.main) await runCrashFixture(process.argv[2]!, process.argv[3]!);
