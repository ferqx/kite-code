import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { createFixedModel, type ModelEvent } from '@kite-ai/ai';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import { runDaemonProcess } from '@kite-ai/service/daemon-main';

try {
  await runDaemonProcess({
    configure(startup) {
      const base = dirname(startup.profile.dataRoot);
      const configuration = createDefaultProcessConfiguration({
        profile: selectProfile(startup.profile),
        hostConfiguration: startup.hostConfiguration,
        credentialBackend: {
          kind: 'temporary',
          async put() {
            appendFileSync(join(base, 'credential-io'), 'put\n');
            throw Error('credential_io_forbidden');
          },
          async resolve() {
            appendFileSync(join(base, 'credential-io'), 'resolve\n');
            throw Error('credential_io_forbidden');
          },
          async remove() {
            appendFileSync(join(base, 'credential-io'), 'remove\n');
            throw Error('credential_io_forbidden');
          },
        },
      });
      const permissions = {
        async authorize() {
          return { allowed: true, revision: 'fixture' };
        },
      };
      const model = {
        async *stream(...args: Parameters<ReturnType<typeof createFixedModel>['stream']>) {
          appendFileSync(join(base, 'models'), 'call\n');
          const events: ModelEvent[] = [
            { type: 'tool_call', id: 'held', name: 'fixture.held', arguments: '{}' },
            { type: 'finish', reason: 'tool_calls', usage: { inputTokens: 1, outputTokens: 1 } },
          ];
          yield* createFixedModel([events]).stream(...args);
        },
      };
      return {
        ...configuration,
        permissions,
        resolveRunConfiguration: async () => ({
          model,
          modelId: 'status-fixed',
          snapshot: { fixture: 'status' },
          permissions,
          extensions: [
            {
              id: 'fixture.status',
              version: '1',
              apiMajor: 1 as const,
              tools: [
                {
                  id: 'fixture.held',
                  version: '1',
                  description: 'Held work independent from status query',
                  inputSchema: { type: 'object' },
                  async execute(
                    _input: unknown,
                    context: import('@kite-ai/agent/extensions').ToolContext,
                  ) {
                    writeFileSync(join(base, `entered-${context.sessionId}`), context.executionId);
                    if (!context.signal.aborted)
                      await new Promise<void>((resolve) =>
                        context.signal.addEventListener('abort', () => resolve(), { once: true }),
                      );
                    writeFileSync(
                      join(base, `cancelled-${context.sessionId}`),
                      context.executionId,
                    );
                    return { outcome: 'cancelled' as const, content: 'owned cancelled' };
                  },
                },
              ],
            },
          ],
        }),
      };
    },
  });
} catch {
  process.stderr.write('status_daemon_fixture_failed\n');
  process.exitCode = 1;
}
