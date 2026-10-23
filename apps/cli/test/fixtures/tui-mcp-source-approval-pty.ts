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
  await runServiceProcess({
    configure(startup, context) {
      const configuration = createDefaultProcessConfiguration({
        userConfigurationPath: selectProfile(startup.profile).profilePath + '/config.jsonc',
        profile: selectProfile(startup.profile),
        hostConfiguration: startup.hostConfiguration,
        observerSubjectId: context.subjectId,
        credentialBackend: {
          kind: 'temporary',
          async put() {
            log('credentials.jsonl', { operation: 'put' });
            throw Error('owned_source_vault_forbidden');
          },
          async resolve() {
            log('credentials.jsonl', { operation: 'resolve' });
            throw Error('owned_source_vault_forbidden');
          },
          async remove() {
            log('credentials.jsonl', { operation: 'remove' });
            throw Error('owned_source_vault_forbidden');
          },
        },
        mcpSources: {
          http: {
            allowLoopbackForTests: true,
            async resolveAddresses(hostname) {
              log('resolutions.jsonl', { attempt: true });
              if (hostname !== '127.0.0.1') throw Error('owned_source_remote_forbidden');
              return [{ address: '127.0.0.1', family: 4 as const }];
            },
          },
        },
      });
      const permissions = configuration.permissions;
      if (!permissions) throw Error('owned_source_default_permissions_unavailable');
      return {
        ...configuration,
        permissions: {
          ...permissions,
          async authorize(request: Parameters<typeof permissions.authorize>[0]) {
            log('permissions.jsonl', {
              kind: request.kind,
              executionId: request.executionId,
              definitionId: request.definitionId,
            });
            if (request.kind === 'model') throw Error('owned_source_model_forbidden');
            return request.kind === 'job'
              ? {
                  allowed: false,
                  revision: 'owned-source-ordinary-ask',
                  approval: { request: { effects: ['configuration'] }, grants: ['approve_once'] },
                }
              : { allowed: true, revision: 'owned-source-read' };
          },
        },
      };
    },
  });
  log('service-exits.jsonl', { exitCode: process.exitCode ?? 0, returnedAfterCleanup: true });
} else {
  const { runTUIHost } = await import('@kite-ai/cli/tui-host');
  const { TuiController } = await import('@kite-ai/ui/tui');
  const originalSelect = TuiController.prototype.select;
  let selectionCompletion = 0;
  // Test-only observation of the original Promise, not a state or readiness
  // override. A same-value refresh need not produce a new terminal paint.
  TuiController.prototype.select = function (...args) {
    const pending = originalSelect.apply(this, args);
    void pending.then(
      () => {
        const state = this.state;
        log('selection-completions.jsonl', {
          completion: ++selectionCompletion,
          requestedSessionId: args[0],
          storeId: this.port.storeId,
          sessionId: state.sessionId,
          loading: state.loading,
          stale: state.stale,
          snapshotStale: state.snapshotStale,
          cards: state.snapshot?.interactions.map((card) => ({
            id: card.id,
            revision: card.revision,
            storeId: card.originStoreId,
            sessionId: card.presentationSessionId,
          })),
        });
      },
      () => {
        log('selection-completions.jsonl', {
          completion: ++selectionCompletion,
          requestedSessionId: args[0],
          rejected: true,
        });
      },
    );
    return pending;
  };
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
                expectedStoreId: body.expectedStoreId,
                expectedOwnerGeneration: body.expectedOwnerGeneration,
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
        if (!token?.startsWith('Bearer ')) throw Error('owned_source_observer_missing');
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
    testDiagnostics: true,
    artifact: settings.artifact,
    dataRoot: settings.dataRoot,
    profile: 'development',
    thread: 'a',
    cwd: settings.workspace,
    exitSignal: exit.signal,
    onLaunched: ({ pid }) => log('owned-services.jsonl', { servicePid: pid }),
  });
}
