import { appendFileSync, writeFileSync } from 'node:fs';
import { defineExtension } from '@kite-ai/agent/extensions';
import { selectProfile } from '@kite-ai/agent/profile';
import { createFixedModel } from '@kite-ai/ai';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { runDaemonProcess } from '@kite-ai/service/daemon-main';

try {
  await runDaemonProcess({
    configure(startup, context) {
      const management = createDefaultProcessConfiguration({
        userConfigurationPath: selectProfile(startup.profile).profilePath + '/config.jsonc',
        profile: selectProfile(startup.profile),
        observerSubjectId: context.subjectId,
      });
      const host = startup.hostConfiguration as {
        configured: string;
        models: string;
        entered: string;
        effects: string;
        cancelled: string;
      };
      writeFileSync(host.configured, startup.instanceId);
      const fixed = createFixedModel([
        [
          { type: 'tool_call', id: 'held', name: 'fixture.held', arguments: '{}' },
          { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
        ],
        [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      ]);
      return {
        // Use real Host owners for onboarding; keep the original trusted Runtime below.
        configurationManagement: management.configurationManagement,
        permissionManagement: management.permissionManagement,
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
