import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { runServiceProcess } from '@kite-ai/service/main';

await runServiceProcess({
  configure(startup) {
    const config = startup.hostConfiguration;
    if (
      !config ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      typeof config.ledger !== 'string' ||
      typeof config.release !== 'string'
    )
      throw new Error('invalid_fixture_configuration');
    const ledger = config.ledger,
      release = config.release;
    writeFileSync(`${ledger}.pid`, String(process.pid));
    return {
      modelId: 'fixed',
      modelConcurrency: 1,
      permissions: {
        async authorize() {
          return { allowed: true, revision: 'trusted-fixture' };
        },
      },
      model: {
        async *stream(_request, { signal }) {
          appendFileSync(ledger, 'started\n');
          try {
            const until = Date.now() + 10000;
            while (!existsSync(release)) {
              signal.throwIfAborted();
              if (Date.now() > until) throw new Error('fixture_deadline');
              await Bun.sleep(5);
            }
            yield { type: 'text_delta', text: 'fixed complete body' } as const;
            yield {
              type: 'finish',
              reason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1 },
            } as const;
          } finally {
            appendFileSync(ledger, 'stopped\n');
          }
        },
      },
    };
  },
});
