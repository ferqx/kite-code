import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import type {
  AuthorizationRequest,
  Extension,
  Json,
  ToolContext,
  ToolResult,
} from '../../../src/extensions';
import type { RuntimeOptions } from '../../../src/runtime';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export function groupOptions(
  directory: string,
  mode: string,
): Pick<
  RuntimeOptions,
  | 'resolveRunConfiguration'
  | 'resolveRecoveryRunConfiguration'
  | 'childConfigurations'
  | 'permissions'
  | 'resolveChildRunConfiguration'
> {
  // Fixed controlled-operation fixture, independent of the builtin Agent tool protocol.
  const delegate = async (input: Json, context: ToolContext): Promise<ToolResult> => {
    const content = (input as { content: string }).content;
    const ref = await context.operations.ensure({
      key: `owned-${context.executionId}`,
      request: { kind: 'agent', configurationId: 'worker', input: { content } },
      cancellation:
        ['group_terminal_descendant', 'group_new_descendant'].includes(mode) && content === 'grand'
          ? 'detached'
          : 'attached',
    });
    if (['group_terminal_descendant', 'group_new_descendant'].includes(mode) && content === 'grand')
      return { outcome: 'succeeded', content: 'Descendant accepted' };
    const result = await context.operations.wait(ref, { signal: context.signal });
    return { outcome: result.status as ToolResult['outcome'], content: 'Controlled child settled' };
  };
  const task: Extension = {
    id: 'fixture.group',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture_delegate',
        version: '1',
        description: 'Owned recovery fixture',
        inputSchema: {
          type: 'object',
          properties: { content: { type: 'string' } },
          required: ['content'],
          additionalProperties: false,
        },
        recovery: { version: '1' },
        execute: delegate,
        resume: delegate,
      },
    ],
  };
  const permissions = {
    async authorize(request: AuthorizationRequest) {
      if (
        mode === 'group_approval' &&
        request.kind === 'tool' &&
        request.definitionId === 'fixture/child-effect'
      )
        return {
          allowed: false,
          revision: '1',
          approval: { request: { description: 'original child effect' } },
        };
      return { allowed: true, revision: '1' };
    },
  };
  const effect: Extension = {
    id: 'group.effect',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture/child-effect',
        version: '1',
        description: 'owned child ledger',
        inputSchema: { type: 'object' },
        async execute(input) {
          appendFileSync(`${directory}/ledger`, `effect:${JSON.stringify(input)}\n`);
          return { outcome: 'succeeded', content: 'effect complete' };
        },
      },
    ],
  };
  const disposed = new Set<string>();
  const parent: ModelAdapter = {
    async *stream(request) {
      appendFileSync(`${directory}/ledger`, 'parent-model\n');
      if (request.messages.some((message) => message.role === 'tool')) {
        yield { type: 'text_delta', text: 'parent finished' };
        yield finish;
        return;
      }
      for (const key of [
        'group_nested',
        'group_terminal_descendant',
        'group_new_descendant',
      ].includes(mode)
        ? ['one']
        : mode === 'group_queued'
          ? ['one', 'two', 'three', 'four']
          : ['one', 'two', 'three'])
        yield {
          type: 'tool_call',
          id: key,
          name: 'fixture_delegate',
          arguments: JSON.stringify({ content: key }),
        };
      yield { ...finish, reason: 'tool_calls' };
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      const key = request.messages.find(
        (message) => message.role === 'user' && message.sourceIds?.[0]?.startsWith('child-start-'),
      )?.content;
      if (!key) throw new Error('original child input unavailable');
      appendFileSync(`${directory}/ledger`, `child-model:${key}\n`);
      if (
        mode === 'group_dynamic' &&
        existsSync(`${directory}/resuming`) &&
        !request.messages.some((message) => message.role === 'tool')
      ) {
        yield {
          type: 'tool_call',
          id: `dynamic-${key}`,
          name: 'fixture/child-effect',
          arguments: JSON.stringify({ key }),
        };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      if (
        mode === 'group_approval' &&
        !request.messages.some((message) => message.role === 'tool')
      ) {
        yield {
          type: 'tool_call',
          id: `effect-${key}`,
          name: 'fixture/child-effect',
          arguments: JSON.stringify({ key }),
        };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      if (
        (['group_nested', 'group_terminal_descendant'].includes(mode) ||
          (mode === 'group_new_descendant' && existsSync(`${directory}/resuming`))) &&
        key === 'one' &&
        !request.messages.some((message) => message.role === 'tool')
      ) {
        yield {
          type: 'tool_call',
          id: 'grand',
          name: 'fixture_delegate',
          arguments: JSON.stringify({ content: 'grand' }),
        };
        yield { ...finish, reason: 'tool_calls' };
        return;
      }
      const attempts = readFileSync(`${directory}/ledger`, 'utf8')
        .split('\n')
        .filter((line) => line === `child-model:${key}`).length;
      if (
        ['group_terminal_descendant', 'group_new_descendant'].includes(mode) &&
        key === 'grand' &&
        existsSync(`${directory}/resuming`)
      ) {
        appendFileSync(`${directory}/ledger`, 'grand-restored\n');
        while (!existsSync(`${directory}/release-grand`)) await Bun.sleep(5);
        if (disposed.has('one')) throw Error('parent_configuration_disposed');
        appendFileSync(`${directory}/ledger`, 'use-config:one\n');
      }
      if (
        attempts === 1 &&
        mode !== 'group_approval' &&
        !existsSync(`${directory}/resuming`) &&
        !(mode === 'group_terminal' && key === 'one')
      ) {
        yield { type: 'text_delta', text: `partial ${key}` };
        await new Promise<void>(() => {});
      } else {
        yield { type: 'text_delta', text: `child ${key} finished` };
        yield finish;
      }
    },
  };
  const configuration = {
    model: parent,
    modelId: 'parent',
    extensions: mode === 'group_approval' ? [task, effect] : [task],
    permissions,
    snapshot: { fixture: 'group-resume', mode },
    maxConcurrentSubagents: mode === 'group_queued' ? 2 : 3,
    ...(mode === 'group_dynamic'
      ? {
          readStepCapabilities: async () => ({
            extensions: [task, effect],
            snapshot: { catalogue: 'dynamic1' },
          }),
        }
      : {}),
  };
  return {
    permissions,
    resolveRunConfiguration: async () => configuration,
    resolveRecoveryRunConfiguration: async () => configuration,
    ...(['group_terminal_descendant', 'group_new_descendant'].includes(mode)
      ? {
          resolveChildRunConfiguration: async (
            input: Parameters<NonNullable<RuntimeOptions['resolveChildRunConfiguration']>>[0],
          ) => {
            const key = (input.parentExecution.input as { content: string }).content;
            return {
              model: child,
              modelId: 'worker',
              extensions: [task],
              permissions,
              toolIds: ['fixture_delegate'],
              snapshot: { key },
              dispose: async () => {
                disposed.add(key);
                appendFileSync(`${directory}/ledger`, `dispose-config:${key}\n`);
              },
            };
          },
        }
      : {}),
    ...(mode === 'group_dynamic'
      ? {
          resolveChildRunConfiguration: async (
            input: Parameters<NonNullable<RuntimeOptions['resolveChildRunConfiguration']>>[0],
          ) => ({
            model: child,
            modelId: 'worker',
            extensions: [task, effect],
            permissions,
            toolIds: input.parentTools
              .filter((tool) => tool.id === 'fixture/child-effect')
              .map((tool) => tool.id),
            snapshot: { roleToolIds: input.parentTools.map((tool) => tool.id) },
          }),
        }
      : {}),
    childConfigurations: [
      {
        id: 'worker',
        version: '1',
        model: child,
        modelId: 'worker',
        extensions: mode === 'group_approval' ? [task, effect] : [task],
        toolIds:
          mode === 'group_nested'
            ? ['fixture_delegate']
            : mode === 'group_approval'
              ? ['fixture/child-effect']
              : [],
        snapshot: { worker: true },
      },
    ],
  };
}
