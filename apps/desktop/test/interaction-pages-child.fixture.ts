import { appendFileSync } from 'node:fs';
import { createFixedModel } from '@kite-ai/ai';
import { runServiceProcess } from '@kite-ai/service/main';

const ledger = 'LEDGER_PATH';
await runServiceProcess({
  configure: async () => ({
    modelId: 'fixed',
    model: createFixedModel([
      [
        { type: 'tool_call', id: 'parent', name: 'fixture.parent', arguments: '{}' },
        { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
    ]),
    permissions: {
      async authorize(request) {
        return request.kind === 'job'
          ? {
              allowed: false,
              revision: 'policy',
              approval: { request: { title: 'Original Job approval' } },
            }
          : { allowed: true, revision: 'policy' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'fixture.parent',
            version: '1',
            description: 'Create owned independent Jobs',
            inputSchema: { type: 'object' },
            async execute(_input, ctx) {
              await Promise.all(
                Array.from({ length: 40 }, (_, i) =>
                  ctx.operations.ensure({
                    key: `job-${i}`,
                    cancellation: 'detached',
                    request: {
                      kind: 'job',
                      definitionId: 'fixture.job',
                      definitionVersion: '1',
                      input: { index: i },
                    },
                  }),
                ),
              );
              return { outcome: 'succeeded', content: 'all original approvals observed' };
            },
          },
        ],
        jobs: [
          {
            id: 'fixture.job',
            version: '1',
            description: 'Harmless explicit counter Job',
            inputSchema: { type: 'object' },
            async start(input) {
              appendFileSync(ledger, 'effect\n');
              return { reference: input };
            },
            async *observe() {
              yield {
                type: 'terminal' as const,
                supervision: 'ended' as const,
                result: { outcome: 'succeeded' as const, content: 'counted' },
              };
            },
            async cancel() {
              return { status: 'stopped' as const };
            },
            async dispose() {},
          },
        ],
      },
    ],
  }),
});
