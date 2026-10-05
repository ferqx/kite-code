import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CLIServiceArtifact } from '../../host';

const settings = JSON.parse(readFileSync(join(import.meta.dir, 'settings.json'), 'utf8')) as {
  root: string;
  workspace: string;
  dataRoot: string;
  artifact: CLIServiceArtifact;
};
const record = (name: string, value: unknown) =>
  appendFileSync(join(settings.root, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
if (!process.stdin.isTTY) {
  const { createDefaultProcessConfiguration } = await import('@kite-ai/service/configuration');
  const { selectProfile } = await import('@kite-ai/agent/profile');
  const { runServiceProcess } = await import('@kite-ai/service/main');
  await runServiceProcess({
    configure(startup, context) {
      return createDefaultProcessConfiguration({
        profile: selectProfile(startup.profile),
        hostConfiguration: startup.hostConfiguration,
        observerSubjectId: context.subjectId,
        credentialBackend: {
          kind: 'temporary',
          async put() {
            throw Error('owned_question_credential_write_forbidden');
          },
          async resolve() {
            record('credentials.jsonl', { operation: 'resolve' });
            return 'local-fixture-key';
          },
          async remove() {
            throw Error('owned_question_credential_remove_forbidden');
          },
        },
      });
    },
  });
  record('service-exit.jsonl', {
    pid: process.pid,
    exitCode: process.exitCode ?? 0,
    returnedAfterCleanup: true,
  });
} else {
  const { runTUIHost } = await import('@kite-ai/cli/tui-host');
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const request = args[0],
        options = args[1];
      const url = new URL(request instanceof Request ? request.url : String(request));
      record('ui-http.jsonl', {
        method: options?.method ?? 'GET',
        path: url.pathname,
        ...(typeof options?.body === 'string' ? { body: JSON.parse(options.body) } : {}),
      });
      const response = await original(...args);
      if (url.pathname === '/v1/server' && response.ok) {
        const authorization = new Headers(options?.headers).get('authorization');
        if (!authorization?.startsWith('Bearer ')) throw Error('owned_question_observer_missing');
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
    { preconnect: original.preconnect },
  );
  const exit = new AbortController();
  process.once('SIGTERM', () => exit.abort());
  process.exitCode = await runTUIHost({
    artifact: settings.artifact,
    dataRoot: settings.dataRoot,
    profile: 'development',
    cwd: settings.workspace,
    exitSignal: exit.signal,
    onLaunched: ({ pid }) => record('owned-service.jsonl', { pid }),
  });
}
