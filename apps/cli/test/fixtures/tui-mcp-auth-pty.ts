import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CLIServiceArtifact } from '../../host';

const settings = JSON.parse(readFileSync(join(import.meta.dir, 'settings.json'), 'utf8')) as {
  root: string;
  workspace: string;
  dataRoot: string;
  phase: string;
  artifact: CLIServiceArtifact;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const log = (name: string, value: object) =>
  appendFileSync(
    join(settings.root, name),
    `${JSON.stringify({ phase: settings.phase, pid: process.pid, ...value })}\n`,
    { mode: 0o600 },
  );
if (!process.stdin.isTTY) {
  const { createDefaultProcessConfiguration } = await import('@kite-ai/service/configuration');
  const { runServiceProcess } = await import('@kite-ai/service/main');
  const temporary = createTemporaryCredentialBackend();
  await runServiceProcess({
    configure(startup, context) {
      return createDefaultProcessConfiguration({
        profile: selectProfile(startup.profile),
        hostConfiguration: startup.hostConfiguration,
        observerSubjectId: context.subjectId,
        permissions: {
          async authorize(request) {
            log('permissions.jsonl', {
              kind: request.kind,
              executionId: request.executionId,
              definitionId: request.definitionId,
            });
            if (request.kind === 'model') throw Error('owned_auth_model_forbidden');
            return request.kind === 'job'
              ? {
                  allowed: false,
                  revision: 'owned-auth-ordinary-ask',
                  approval: { request: { effects: ['configuration'] }, grants: ['approve_once'] },
                }
              : { allowed: true, revision: 'owned-auth-read' };
          },
        },
        credentialBackend: {
          kind: 'temporary',
          async put(id, value) {
            log('credentials.jsonl', { operation: 'put' });
            await temporary.put(id, value);
          },
          async resolve(id) {
            log('credentials.jsonl', { operation: 'resolve' });
            return temporary.resolve(id);
          },
          async remove(id) {
            log('credentials.jsonl', { operation: 'remove' });
            await temporary.remove(id);
          },
          async status() {
            log('credentials.jsonl', { operation: 'status' });
            return 'available';
          },
        },
        mcpSources: {
          http: { allowLoopbackForTests: true },
          oauth: {
            network: { allowLoopbackForTests: true },
            callbackTimeoutMs: 2000,
            async openBrowser(url, signal) {
              log('browser.jsonl', { operation: 'open' });
              const response = await fetch(url, { redirect: 'manual', signal });
              if (response.status !== 302) throw Error('owned_auth_redirect_missing');
              const callback = response.headers.get('location');
              if (!callback || (await fetch(callback, { signal })).status !== 200)
                throw Error('owned_auth_callback_failed');
            },
          },
        },
      });
    },
  });
  log('service-exits.jsonl', { exitCode: process.exitCode ?? 0, returnedAfterCleanup: true });
} else {
  const { runTUIHost } = await import('@kite-ai/cli/tui-host');
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(
    async (...args: Parameters<typeof fetch>) => {
      const options = args[1],
        url = new URL(String(args[0]));
      const body =
        typeof options?.body === 'string'
          ? (JSON.parse(options.body) as Record<string, unknown>)
          : undefined;
      const answer = body?.answer as
        | { kind?: string; answers?: { decision?: string }; decision?: string }
        | undefined;
      log('ui-http.jsonl', {
        method: options?.method ?? 'GET',
        path: url.pathname,
        ...(body
          ? {
              body: {
                kind:
                  body.kind ??
                  (url.pathname.endsWith('/answer') ? 'interaction.answer' : undefined),
                commandId: body.commandId,
                extensionId: body.extensionId,
                actionId: body.actionId,
                requestSha256: digest(body),
                answerKind: answer?.kind,
                decision: answer?.answers?.decision ?? answer?.decision,
              },
            }
          : {}),
      });
      const response = await original(...args);
      if (url.pathname === '/v1/server' && response.ok) {
        const token = new Headers(options?.headers).get('authorization');
        if (!token?.startsWith('Bearer ')) throw Error('owned_auth_observer_missing');
        writeFileSync(
          join(settings.root, 'observer-private.json'),
          JSON.stringify({ endpoint: url.origin, token: token.slice(7) }),
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
    thread: 'a',
    cwd: settings.workspace,
    exitSignal: exit.signal,
    onLaunched: ({ pid }) => log('owned-services.jsonl', { servicePid: pid }),
  });
}
