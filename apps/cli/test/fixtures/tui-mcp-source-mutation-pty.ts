import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import type { CLIServiceArtifact } from '../../host';

const settings = JSON.parse(readFileSync(join(import.meta.dir, 'settings.json'), 'utf8')) as {
  root: string;
  workspace: string;
  dataRoot: string;
  phase: string;
  artifact: CLIServiceArtifact;
};
const log = (name: string, value: object) =>
  appendFileSync(
    join(settings.root, name),
    `${JSON.stringify({ phase: settings.phase, pid: process.pid, ...value })}\n`,
    { mode: 0o600 },
  );
if (!process.stdin.isTTY) {
  const { createDefaultProcessConfiguration } = await import('@kite-ai/service/configuration');
  const { runServiceProcess } = await import('@kite-ai/service/main');
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
              definitionId: request.definitionId,
              executionId: request.executionId,
            });
            if (request.kind === 'model') throw Error('owned_source_mutation_model_forbidden');
            return request.kind === 'job'
              ? {
                  allowed: false,
                  revision: 'owned-source-mutation-ask',
                  approval: { request: { effects: ['configuration'] }, grants: ['approve_once'] },
                }
              : { allowed: true, revision: 'owned-source-mutation-read' };
          },
        },
        credentialBackend: {
          kind: 'temporary',
          async put() {
            log('credentials.jsonl', { operation: 'put' });
            throw Error('owned_source_mutation_vault_forbidden');
          },
          async resolve() {
            log('credentials.jsonl', { operation: 'resolve' });
            throw Error('owned_source_mutation_vault_forbidden');
          },
          async remove() {
            log('credentials.jsonl', { operation: 'remove' });
            throw Error('owned_source_mutation_vault_forbidden');
          },
        },
        mcpSources: {
          http: {
            allowLoopbackForTests: true,
            async resolveAddresses() {
              log('resolutions.jsonl', { attempted: true });
              throw Error('owned_source_mutation_transport_forbidden');
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
      const answer = body?.answer as { kind?: string; decision?: string } | undefined;
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
                requestSha256: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
                answerKind: answer?.kind,
                decision: answer?.decision,
              },
            }
          : {}),
      });
      const response = await original(...args);
      if (url.pathname === '/v1/server' && response.ok) {
        const token = new Headers(options?.headers).get('authorization');
        if (!token?.startsWith('Bearer ')) throw Error('owned_source_mutation_observer_missing');
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
