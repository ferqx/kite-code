import { appendFileSync, existsSync } from 'node:fs';
import type { ModelAdapter } from '@kite-ai/ai';
import type { Extension } from '../../../src/extensions';
import type { RuntimeOptions } from '../../../src/runtime';

export const agentGuidance = 'Parent Agent correction: preserve Blue 雪 as attributed data.';
export function steeringAgentOptions(
  directory: string,
): Pick<
  RuntimeOptions,
  | 'resolveRunConfiguration'
  | 'resolveRecoveryRunConfiguration'
  | 'childConfigurations'
  | 'permissions'
> {
  const permissions = {
    async authorize() {
      return { allowed: true, revision: '1' };
    },
  };
  const extension: Extension = {
    id: 'fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'fixture.spawn-steer',
        version: '1',
        description: 'Create and steer an actual child',
        inputSchema: { type: 'object' },
        async execute(_input, ctx) {
          const ref = await ctx.operations.ensure({
            key: 'child',
            request: {
              kind: 'agent',
              configurationId: 'child',
              input: { content: 'Original child task' },
            },
            cancellation: 'detached',
          });
          const end = Date.now() + 5000;
          while (!existsSync(`${directory}/child-planned`)) {
            if (Date.now() > end) throw Error('child_plan_timeout');
            await Bun.sleep(5);
          }
          const child = await ctx.operations.readAgent(ref);
          await ctx.operations.sendAgentInput(ref, {
            mode: 'steer',
            key: 'correction',
            targetRunId: child.run!.id,
            contextSelectionId: child.contextSelectionId,
            content: agentGuidance,
          });
          return { outcome: 'succeeded', content: 'Actual child steer accepted' };
        },
      },
    ],
  };
  const parent: ModelAdapter = {
    async *stream(request) {
      appendFileSync(`${directory}/ledger`, `parent:${request.requestId}\n`);
      if (existsSync(`${directory}/resuming`)) {
        yield { type: 'text_delta', text: 'Parent continued' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
        return;
      }
      if (request.messages.some((message) => message.role === 'tool')) {
        yield { type: 'text_delta', text: 'Parent waiting safely for child. '.repeat(4000) };
        await new Promise<void>(() => {});
        return;
      }
      yield { type: 'tool_call', id: 'spawn', name: 'fixture.spawn-steer', arguments: '{}' };
      yield { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const child: ModelAdapter = {
    async *stream(request) {
      appendFileSync(`${directory}/ledger`, `child:${JSON.stringify(request)}\n`);
      yield { type: 'text_delta', text: 'Child continued from original attributed correction' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  const configuration = {
    model: parent,
    modelId: 'parent',
    permissions,
    extensions: [extension],
    snapshot: { fixture: 'steering-agent-resume' },
  };
  return {
    permissions,
    resolveRunConfiguration: async () => configuration,
    resolveRecoveryRunConfiguration: async () => configuration,
    childConfigurations: [
      {
        id: 'child',
        version: '1',
        model: child,
        modelId: 'child',
        extensions: [],
        toolIds: [],
        permissions,
        snapshot: { fixture: 'child-steering' },
      },
    ],
  };
}
