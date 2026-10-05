import { appendFileSync } from 'node:fs';
import type { ModelAdapter, ModelEvent } from '@kite-ai/ai';
import type { Extension } from '../../../src/extensions';
import type { RunConfiguration } from '../../../src/runtime';

const finish: ModelEvent = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
export function binding(directory: string, mode: string): RunConfiguration {
  const model: ModelAdapter = {
    async *stream(request) {
      if (
        mode.includes('large') &&
        !request.messages.some(
          (message) =>
            typeof message.content === 'string' && message.content.includes('s'.repeat(80000)),
        )
      )
        throw Error('sealed large source not rehydrated');
      appendFileSync(`${directory}/ledger`, `model:${request.requestId}\n`);
      if (mode === 'completion' || request.messages.at(-1)?.role === 'tool') {
        yield { type: 'text_delta', text: 'done' };
        yield finish;
      } else {
        yield {
          type: 'tool_call',
          id: 'call',
          name: 'effect',
          arguments: JSON.stringify({
            value: mode.includes('large') ? 'x'.repeat(80000) : 'original',
          }),
        };
        yield { ...finish, reason: 'tool_calls' };
      }
    },
  };
  const extension: Extension = {
    id: 'resume.fixture',
    version: '1',
    apiMajor: 1,
    tools: [
      {
        id: 'effect',
        version: '1',
        description: 'Owned ledger',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input) {
          appendFileSync(
            `${directory}/ledger`,
            `effect:${(input as { value: string }).value.length}\n`,
          );
          return { outcome: 'succeeded', content: 'effect done' };
        },
      },
    ],
  };
  return {
    model,
    modelId: 'fixed',
    extensions: [extension],
    snapshot: { fixture: 'resume', mode },
    permissions: {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    },
    ...(mode.includes('large')
      ? {
          sources: {
            async capture() {
              return [
                {
                  id: 'large',
                  kind: 'fixture',
                  scope: 's',
                  digest: '1',
                  content: 's'.repeat(80000),
                },
              ];
            },
          },
        }
      : {}),
  };
}
