import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineExtension } from '@kite-ai/agent/extensions';
import { createFixedModel } from '@kite-ai/ai';
import { runDaemonProcess } from '@kite-ai/service/daemon-main';

try {
  await runDaemonProcess({
    configure(startup) {
      const base = dirname(startup.profile.dataRoot);
      const host = Object.fromEntries(
        ['configured', 'models', 'entered', 'effects', 'cancelled'].map((name) => [
          name,
          join(base, name),
        ]),
      ) as Record<'configured' | 'models' | 'entered' | 'effects' | 'cancelled', string>;
      writeFileSync(host.configured, startup.instanceId);
      const fixed = createFixedModel([
        [
          { type: 'tool_call', id: 'held', name: 'fixture.held', arguments: '{}' },
          { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      ]);
      return {
        modelId: 'fixed-daemon',
        model: {
          async *stream(...args: Parameters<typeof fixed.stream>) {
            appendFileSync(host.models, 'call\n');
            yield* fixed.stream(...args);
          },
        },
        extensions: [
          defineExtension({
            id: 'fixture.daemon',
            version: '1',
            apiMajor: 1,
            tools: [
              {
                id: 'fixture.held',
                version: '1',
                description: 'Owned cancellation gate',
                inputSchema: { type: 'object' },
                async execute(_input, context) {
                  writeFileSync(host.entered, context.executionId);
                  if (!context.signal.aborted)
                    await new Promise<void>((resolve) =>
                      context.signal.addEventListener('abort', () => resolve(), { once: true }),
                    );
                  writeFileSync(host.cancelled, context.executionId);
                  return { outcome: 'cancelled', content: 'No fixture external effect' };
                },
              },
            ],
          }),
        ],
        permissions: {
          async authorize() {
            return { allowed: true, revision: 'fixed' };
          },
        },
      };
    },
  });
} catch {
  process.stderr.write('daemon_fixture_failed\n');
  process.exitCode = 1;
}
