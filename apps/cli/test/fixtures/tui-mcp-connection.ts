import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CLIServiceArtifact } from '../../host';

const settings = JSON.parse(readFileSync(join(import.meta.dir, 'settings.json'), 'utf8')) as {
  root: string;
  workspace: string;
  dataRoot: string;
  mcpUrl: string;
  artifact: CLIServiceArtifact;
  phase: 'warm' | 'cold';
  serviceMode: 'paired' | 'shared';
  server?: string;
};
const log = (name: string, value: unknown) =>
  appendFileSync(
    join(settings.root, name),
    `${JSON.stringify({ phase: settings.phase, pid: process.pid, ...(value as object) })}\n`,
  );
if (!process.stdin.isTTY) {
  const { createDefaultProcessConfiguration } = await import('@kite-ai/service/configuration');
  const { runServiceProcess } = await import('@kite-ai/service/main');
  const { runDaemonProcess } = await import('@kite-ai/service/daemon-main');
  const run = settings.serviceMode === 'shared' ? runDaemonProcess : runServiceProcess;
  await run({
    configure(startup) {
      return createDefaultProcessConfiguration({
        profile: selectProfile(startup.profile),
        hostConfiguration: startup.hostConfiguration,
        permissions: {
          async authorize(request) {
            log('permissions.jsonl', {
              kind: request.kind,
              executionId: request.executionId,
              definitionId: request.definitionId,
            });
            if (request.kind === 'model') throw Error('owned_connection_model_forbidden');
            return request.kind === 'job'
              ? {
                  allowed: false,
                  revision: 'owned-tools-ask',
                  approval: { request: { effects: ['external'] }, grants: ['approve_once'] },
                }
              : { allowed: true, revision: 'owned-tools-read' };
          },
        },
        credentialBackend: {
          kind: 'temporary',
          async put() {
            log('credentials.jsonl', { operation: 'put' });
            throw Error('owned_connection_credential_forbidden');
          },
          async resolve() {
            log('credentials.jsonl', { operation: 'resolve' });
            throw Error('owned_connection_credential_forbidden');
          },
          async remove() {
            log('credentials.jsonl', { operation: 'remove' });
            throw Error('owned_connection_credential_forbidden');
          },
        },
        mcpSources: {
          http: {
            allowLoopbackForTests: true,
            async resolveAddresses(hostname) {
              log('resolutions.jsonl', { hostname });
              if (hostname !== '127.0.0.1') throw Error('owned_connection_remote_forbidden');
              return [{ address: '127.0.0.1', family: 4 as const }];
            },
          },
        },
      });
    },
  });
} else {
  const { runTUIHost } = await import('@kite-ai/cli/tui-host');
  const actual = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const options = args[1],
        url = new URL(String(args[0]));
      log('ui-http.jsonl', {
        method: options?.method ?? 'GET',
        path: url.pathname,
        ...(typeof options?.body === 'string' ? { body: JSON.parse(options.body) } : {}),
      });
      const response = await actual(...args);
      if (url.pathname === '/v1/server' && response.ok) {
        const authorization = new Headers(options?.headers).get('authorization');
        if (!authorization?.startsWith('Bearer ')) throw Error('owned_connection_observer_missing');
        writeFileSync(
          join(settings.root, 'observer-private.json'),
          JSON.stringify({
            endpoint: url.origin,
            token: authorization.slice(7),
          }),
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
    ...(settings.server ? { server: settings.server } : {}),
    dataRoot: settings.dataRoot,
    profile: 'development',
    thread: 'a',
    cwd: settings.workspace,
    exitSignal: exit.signal,
    onLaunched: ({ pid }) => log('owned-services.jsonl', { servicePid: pid }),
  });
}
