import { appendFileSync } from 'node:fs';
import { createFixedModel } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

const ledger = 'LEDGER_PATH';
await runServiceProcess({
  configure: async () => ({
    modelId: 'fixed',
    model: createFixedModel([
      [
        { type: 'tool_call', id: 'question', name: 'fixture.question', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]),
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'policy' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.question',
            version: '1',
            description: 'Owned original answer effect',
            inputSchema: { type: 'object' },
            async execute(_input, ctx) {
              const answer = await ctx.requestInteraction({
                kind: 'question',
                request: {
                  schema: {
                    type: 'object',
                    required: ['full'],
                    properties: { full: { type: 'string' } },
                    additionalProperties: false,
                  },
                },
              });
              appendFileSync(
                ledger,
                JSON.stringify({ executionId: ctx.executionId, answer }) + '\n',
              );
              return { outcome: 'succeeded', content: 'original answer saved' };
            },
          },
        ],
      },
    ],
  }),
});
