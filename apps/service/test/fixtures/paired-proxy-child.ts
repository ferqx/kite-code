import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createFixedModel } from '@kite-ai/ai';
import { runServiceProcess } from '../../src/main';

await runServiceProcess({
  async configure(startup) {
    const fixture = startup.hostConfiguration as { report: string; requests: string[] };
    const proxyKeys = [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'NO_PROXY',
      'no_proxy',
      'ALL_PROXY',
      'all_proxy',
    ];
    const forbidden = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_ACCESS_TOKEN',
      'CODEX_AUTH_TOKEN',
      'KITE_PAIRED_SECRET',
      'NODE_OPTIONS',
      'BUN_OPTIONS',
      'NODE_EXTRA_CA_CERTS',
    ];
    const responses = [];
    for (const url of fixture.requests) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        responses.push({ url, status: response.status, text: await response.text() });
      } catch {
        // Newer Bun rejects refused CONNECT; older Bun returns the proxy status.
        responses.push({ url, failed: true });
      }
    }
    writeFileSync(
      fixture.report,
      JSON.stringify({
        pid: process.pid,
        proxies: Object.fromEntries(
          proxyKeys.flatMap((key) => {
            const value = process.env[key];
            return value === undefined
              ? []
              : [[key, createHash('sha256').update(value).digest('hex')]];
          }),
        ),
        codexHomeDigest:
          process.env.CODEX_HOME === undefined
            ? null
            : createHash('sha256').update(process.env.CODEX_HOME).digest('hex'),
        forbiddenPresent: forbidden.filter((key) => process.env[key] !== undefined),
        startupContainsProxyCredential: JSON.stringify(startup).includes('fixture-proxy-password'),
        responses,
      }),
      { mode: 0o600 },
    );
    return {
      modelId: 'fixed',
      model: createFixedModel([
        [{ type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }],
      ]),
    };
  },
});
