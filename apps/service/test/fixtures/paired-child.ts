import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { defineExtension } from '@kite-ai/agent/extensions';
import { createFixedModel } from '@kite-ai/ai';
import { runServiceProcess } from '../../src/main';

await runServiceProcess({
  configure(startup) {
    const configuration = startup.hostConfiguration as {
      ledger: string;
      entered: string;
      release: string;
      logToken?: boolean;
    };
    if (configuration.logToken) process.stderr.write(`${startup.token}\n`);
    const extension = defineExtension({
      id: 'fixture.paired',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.count',
          version: '1',
          description: 'External gated counter',
          inputSchema: { type: 'object' },
          async execute(input, context) {
            writeFileSync(configuration.entered, context.executionId);
            while (!existsSync(configuration.release)) {
              if (context.signal.aborted)
                return { outcome: 'cancelled', content: 'No fixture effect was performed' };
              await Bun.sleep(10);
            }
            if (context.signal.aborted)
              return { outcome: 'cancelled', content: 'No fixture effect was performed' };
            appendFileSync(
              configuration.ledger,
              `${JSON.stringify({ executionId: context.executionId, input })}\n`,
            );
            return { outcome: 'succeeded', content: 'counted' };
          },
        },
      ],
    });
    return {
      extensions: [extension],
      modelId: 'fixed',
      model: createFixedModel([
        [
          { type: 'tool_call', id: 'one', name: 'fixture.count', arguments: '{}' },
          { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
        [
          { type: 'tool_call', id: 'two', name: 'fixture.count', arguments: '{}' },
          { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      ]),
      permissions: {
        async authorize() {
          return { allowed: true, revision: '1' };
        },
      },
    };
  },
});
