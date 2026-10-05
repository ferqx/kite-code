import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { runDaemonProcess } from '@kite-ai/service/daemon-main';

try {
  await runDaemonProcess({
    configure(startup) {
      const base = dirname(startup.profile.dataRoot);
      const model = createFixedModel([]);
      return {
        compressor: {
          id: 'management-summary',
          version: '1',
          async prepare() {
            return { instructions: 'fixture summary', snapshot: { fixture: true } };
          },
          async validateSummary() {
            return true;
          },
        },
        modelId: 'shared-fixed',
        model: {
          async *stream(...args: Parameters<typeof model.stream>) {
            const request = args[0];
            if (
              JSON.stringify(request).includes('fixture summary') &&
              existsSync(join(base, 'hold-summary'))
            ) {
              writeFileSync(join(base, 'summary-entered'), 'entered');
              const signal = args[1].signal;
              if (!signal?.aborted)
                await new Promise<void>((resolve) =>
                  signal?.addEventListener('abort', () => resolve(), { once: true }),
                );
              writeFileSync(join(base, 'summary-cancelled'), 'cancelled');
            }
            appendFileSync(join(base, 'models'), 'call\n');
            const last = request.messages.at(-1);
            const text = JSON.stringify(last);
            let events: ModelEvent[];
            if (last?.role !== 'tool' && text.includes('hold external'))
              events = [
                { type: 'tool_call', id: 'held', name: 'fixture.held', arguments: '{}' },
                {
                  type: 'finish',
                  reason: 'tool_calls',
                  usage: { inputTokens: 1, outputTokens: 1 },
                },
              ];
            else if (last?.role !== 'tool' && text.includes('question shared'))
              events = [
                { type: 'tool_call', id: 'question', name: 'fixture.question', arguments: '{}' },
                {
                  type: 'finish',
                  reason: 'tool_calls',
                  usage: { inputTokens: 1, outputTokens: 1 },
                },
              ];
            else
              events = [
                { type: 'text_delta', text: `complete-owned-answer:${'z'.repeat(84 * 1024)}:TAIL` },
                { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
              ];
            yield* createFixedModel([events]).stream(...args);
          },
        },
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'fixed' };
          },
        },
        extensions: [
          {
            id: 'fixture.shared',
            version: '1',
            apiMajor: 1,
            tools: [
              {
                id: 'fixture.held',
                version: '1',
                description: 'Owned held execution',
                inputSchema: { type: 'object' },
                async execute(_input, context) {
                  writeFileSync(join(base, `entered-${context.sessionId}`), context.executionId);
                  if (!context.signal.aborted)
                    await new Promise<void>((resolve) =>
                      context.signal.addEventListener('abort', () => resolve(), { once: true }),
                    );
                  writeFileSync(join(base, `cancelled-${context.sessionId}`), context.executionId);
                  return { outcome: 'cancelled', content: 'owned cancelled' };
                },
              },
              {
                id: 'fixture.question',
                version: '1',
                description: 'Owned input question',
                inputSchema: { type: 'object' },
                async execute(_input, context) {
                  const answer = await context.requestInput({
                    schema: {
                      type: 'object',
                      required: ['reply'],
                      properties: { reply: { type: 'string', enum: ['yes'] } },
                      additionalProperties: false,
                    },
                  });
                  writeFileSync(join(base, `answer-${context.sessionId}`), JSON.stringify(answer));
                  return { outcome: 'succeeded', content: 'answered' };
                },
              },
            ],
          },
        ],
      };
    },
  });
} catch {
  process.stderr.write('shared_fixture_failed\n');
  process.exitCode = 1;
}
