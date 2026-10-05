import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CLIServiceArtifact } from '../../host';

// Both roles run from the same owned, source-free directory. Paired startup deliberately
// strips environment variables; Service configuration is derived from its own directory.
const settings = JSON.parse(readFileSync(join(import.meta.dir, 'settings.json'), 'utf8')) as {
  root: string;
  workspace: string;
  dataRoot: string;
  mcpUrl: string;
  artifact: CLIServiceArtifact;
};
if (!process.stdin.isTTY) {
  const { createDefaultProcessConfiguration } = await import('@kite-ai/service/configuration');
  const { runServiceProcess } = await import('@kite-ai/service/main');
  const { createMcpHttpTransportPort } = await import('@kite-ai/service/mcp-http-port');
  appendFileSync(join(settings.root, 'startup-ledger'), 'service imports ready\n');
  await runServiceProcess({
    configure(startup) {
      appendFileSync(join(settings.root, 'startup-ledger'), 'configure reached\n');
      return createDefaultProcessConfiguration({
        profile: selectProfile(startup.profile),
        hostConfiguration: startup.hostConfiguration,
        credentialBackend: {
          kind: 'temporary',
          async put() {
            appendFileSync(join(settings.root, 'credential-io'), 'put\n');
            throw Error('owned_credential_io_forbidden');
          },
          async resolve() {
            appendFileSync(join(settings.root, 'credential-io'), 'resolve\n');
            throw Error('owned_credential_io_forbidden');
          },
          async remove() {
            appendFileSync(join(settings.root, 'credential-io'), 'remove\n');
            throw Error('owned_credential_io_forbidden');
          },
        },
        mcp: {
          servers: [{ id: 'owned-server', transport: { type: 'http', url: settings.mcpUrl } }],
          transportPort: createMcpHttpTransportPort({
            servers: [{ id: 'owned-server', url: settings.mcpUrl }],
            allowLoopbackForTests: true,
            async admit() {
              appendFileSync(join(settings.root, 'mcp-admit'), 'admit\n');
              throw Error('selection_must_not_connect');
            },
          }),
        },
      });
    },
  });
} else {
  const { runTUIHost } = await import('@kite-ai/cli/tui-host');
  const actual = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const response = await actual(...args);
      const url = new URL(String(args[0]));
      const options = args[1];
      appendFileSync(
        join(settings.root, 'http-ledger.jsonl'),
        `${JSON.stringify({
          method: options?.method ?? 'GET',
          path: url.pathname,
          ...(typeof options?.body === 'string' ? { body: JSON.parse(options.body) } : {}),
        })}\n`,
      );
      if (url.pathname === '/v1/server' && response.ok) {
        const token = new Headers(options?.headers).get('authorization');
        if (token?.startsWith('Bearer '))
          writeFileSync(
            join(settings.root, 'observer-private.json'),
            JSON.stringify({ endpoint: url.origin, token: token.slice(7) }),
            { mode: 0o600 },
          );
      }
      return response;
    },
    { preconnect: actual.preconnect },
  );
  const exit = new AbortController();
  process.once('SIGTERM', () => exit.abort());
  process.exitCode = await runTUIHost({
    artifact: settings.artifact,
    dataRoot: settings.dataRoot,
    profile: 'development',
    thread: 'a',
    cwd: settings.workspace,
    exitSignal: exit.signal,
    onLaunched: ({ pid }) =>
      writeFileSync(join(settings.root, 'owned-pid'), String(pid), { mode: 0o600 }),
  });
}
