import { randomUUID } from 'node:crypto';
import { createClient, type ServerInfo, type SessionView } from '@kite-ai/client';
import { decodeTuiMcpSnapshot } from '@kite-ai/ui/tui';
import { decodeMcpConnectionFact } from '../../../apps/cli/host/tui-mcp-connection';
import { decodeMcpSourcePage } from '../../../apps/cli/host/tui-mcp-source-approval';

/** Original fixture starts configured providers. Setup uses the actual public connect/approval path. */
export function installOriginalMcpSetup(options?: {
  skipInitialSetup?: boolean;
  sourceApprovalPermission?: boolean;
}) {
  const actualFetch = globalThis.fetch;
  let prepared = false;
  let info: ServerInfo | undefined;
  const owned = new AbortController();
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const response = await actualFetch(input, init);
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (
      response.ok &&
      url.pathname.endsWith('/commands') &&
      init?.method === 'POST' &&
      typeof init.body === 'string'
    ) {
      const request = JSON.parse(init.body);
      if (
        request.kind === 'extension.invoke' &&
        request.extensionId === 'builtin.mcp.sources' &&
        (request.actionId === 'mcp.auth.login' ||
          (options?.sourceApprovalPermission && request.actionId === 'mcp.source.approve'))
      ) {
        const sessionId = url.pathname.split('/')[3]!;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          owned.signal.throwIfAborted();
          const command = (await actualFetch(
            `${url.origin}/v1/commands/${encodeURIComponent(request.commandId)}`,
            { headers: init.headers, signal: owned.signal },
          ).then((reply) => reply.json())) as {
            id: string;
            originStoreId: string;
            sessionId: string;
            receipt?: { executionId?: string };
          };
          if (
            command.id !== request.commandId ||
            command.originStoreId !== request.expectedStoreId ||
            command.sessionId !== sessionId
          )
            throw Error('fixture_auth_command_scope_changed');
          const executionId = command.receipt?.executionId;
          if (executionId) {
            const execution = (await actualFetch(`${url.origin}/v1/executions/${executionId}`, {
              headers: init.headers,
              signal: owned.signal,
            }).then((reply) => reply.json())) as {
              originStoreId: string;
              sessionId: string;
              definitionId: string;
              definitionVersion: string;
              status: string;
            };
            if (
              execution.originStoreId !== request.expectedStoreId ||
              execution.sessionId !== sessionId ||
              execution.definitionId !== `builtin.mcp.sources/${request.actionId}` ||
              execution.definitionVersion !== '1'
            )
              throw Error('fixture_auth_execution_scope_changed');
            if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status))
              break;
            const page = (await actualFetch(
              `${url.origin}/v1/sessions/${sessionId}/interactions?storeId=${request.expectedStoreId}&state=pending&limit=100`,
              { headers: init.headers, signal: owned.signal },
            ).then((reply) => reply.json())) as {
              interactions: Array<{
                id: string;
                kind: string;
                executionId: string;
                originStoreId: string;
                sessionId: string;
                revision: string;
              }>;
            };
            const card = page.interactions.find(
              (item) =>
                item.kind === 'approval' &&
                item.executionId === executionId &&
                item.originStoreId === request.expectedStoreId &&
                item.sessionId === sessionId,
            );
            if (card) {
              const granted = await actualFetch(
                `${url.origin}/v1/sessions/${sessionId}/interactions/${card.id}/answer`,
                {
                  method: 'POST',
                  headers: init.headers,
                  signal: owned.signal,
                  body: JSON.stringify({
                    expectedStoreId: request.expectedStoreId,
                    commandId: randomUUID(),
                    expectedRevision: card.revision,
                    answer: { kind: 'approval', decision: 'approve', grant: 'approve_once' },
                  }),
                },
              );
              if (!granted.ok) throw Error('fixture_auth_approval_failed');
              break;
            }
          }
          await Bun.sleep(25);
        }
      }
    }
    if (url.pathname === '/v1/server' && response.ok)
      info = (await response.clone().json()) as ServerInfo;
    if (
      !options?.skipInitialSetup &&
      !prepared &&
      response.ok &&
      /\/v1\/sessions\/[^/]+\/view$/.test(url.pathname)
    ) {
      const view = (await response.clone().json()) as SessionView;
      if (view.session.title === 'Test configuration setup') return response;
      prepared = true;
      const serverReply = await actualFetch(`${url.origin}/v1/server`, {
        headers: init?.headers,
        signal: owned.signal,
      });
      if (!serverReply.ok) throw Error('fixture_mcp_server_unavailable');
      info = (await serverReply.json()) as ServerInfo;
      const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
      if (!token || !info.storeId || info.storeId !== view.storeId)
        throw Error('fixture_mcp_scope_missing');
      const client = createClient({
        endpoint: url.origin,
        token,
        bootstrap: info,
        expected: {
          profile: info.profile,
          apiMajor: 1,
          requiredCapabilities: ['sessions', 'commands', 'interactions'],
        },
      });
      await client.connect({ signal: owned.signal });
      try {
        const submit = async (
          extensionId: string,
          actionId: string,
          input: Parameters<typeof client.invokeExtension>[1]['input'],
        ) => {
          const accepted = await client.invokeExtension(
            view.session.id,
            {
              expectedStoreId: view.storeId,
              commandId: randomUUID(),
              kind: 'extension.invoke',
              extensionId,
              actionId,
              definitionVersion: '1',
              input,
            },
            { signal: owned.signal },
          );
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const command = await client.getCommand(accepted.id, { signal: owned.signal });
            const receipt = command.receipt;
            const executionId =
              receipt &&
              typeof receipt === 'object' &&
              !Array.isArray(receipt) &&
              'executionId' in receipt &&
              typeof receipt.executionId === 'string'
                ? receipt.executionId
                : undefined;
            if (executionId) {
              const execution = await client.getExecution(executionId, { signal: owned.signal });
              const ownIds = new Set([executionId]);
              if (actionId === 'mcp.connect') {
                const current = await client.getView(view.session.id, { signal: owned.signal });
                if (current.storeId !== view.storeId || current.session.id !== view.session.id)
                  throw Error('fixture_mcp_view_scope_changed');
                for (const child of current.executions) {
                  if (
                    child.parentExecutionId === executionId &&
                    child.originStoreId === view.storeId &&
                    child.sessionId === view.session.id &&
                    child.kind === 'job' &&
                    child.definitionId === 'mcp.source.connection' &&
                    child.definitionVersion === '1'
                  )
                    ownIds.add(child.id);
                }
              }
              if (actionId === 'mcp.connect' && command.status === 'applied') {
                const fact = decodeMcpConnectionFact(
                  await client.queryExtension(
                    view.session.id,
                    'builtin.mcp',
                    'mcp.connection',
                    { executionId, ...(input as Record<string, never>) },
                    { signal: owned.signal },
                  ),
                );
                if (
                  fact.storeId !== view.storeId ||
                  fact.sessionId !== view.session.id ||
                  fact.execution.id !== executionId
                )
                  throw Error('fixture_mcp_connection_scope_changed');
                if (fact.connection) ownIds.add(fact.connection.id);
                if (fact.phase !== 'pending') return;
              } else if (
                ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
              )
                return;
              const page = await client.listInteractions(
                view.session.id,
                { storeId: view.storeId, state: 'pending', limit: 100 },
                { signal: owned.signal },
              );
              for (const card of page.interactions) {
                if (
                  !ownIds.has(card.executionId) ||
                  card.originStoreId !== view.storeId ||
                  card.sessionId !== view.session.id
                )
                  continue;
                const request = card.request as Record<string, unknown>;
                const answer =
                  card.kind === 'approval'
                    ? {
                        kind: 'approval' as const,
                        decision: 'approve' as const,
                        grant: 'approve_once' as const,
                      }
                    : card.kind === 'question' &&
                        request.kind === 'mcp_source_approval' &&
                        request.executionId === executionId &&
                        request.originalStoreId === view.storeId
                      ? { kind: 'question' as const, answers: { decision: 'approved' } }
                      : undefined;
                if (!answer) continue;
                await client.answerInteraction(
                  view.session.id,
                  card.id,
                  {
                    expectedStoreId: view.storeId,
                    commandId: randomUUID(),
                    expectedRevision: card.revision,
                    answer,
                  },
                  { signal: owned.signal },
                );
              }
            } else if (command.status === 'rejected' || command.status === 'needs_review')
              throw Error('fixture_mcp_action_failed');
            await Bun.sleep(25);
          }
          throw Error('fixture_mcp_action_unsettled');
        };
        let sources = decodeMcpSourcePage(
          await client.queryExtension(
            view.session.id,
            'builtin.mcp.sources',
            'mcp.sources',
            { limit: 25 },
            { signal: owned.signal },
          ),
        );
        for (const source of sources.items) {
          if (!source.enabled || !source.transport) continue;
          if (!source.admitted && sources.readSet) {
            await submit('builtin.mcp.sources', 'mcp.source.approve', {
              serverId: source.id,
              expectedReadSet: JSON.parse(JSON.stringify(sources.readSet)),
            });
            sources = decodeMcpSourcePage(
              await client.queryExtension(
                view.session.id,
                'builtin.mcp.sources',
                'mcp.sources',
                { limit: 25 },
                { signal: owned.signal },
              ),
            );
          }
          let directory = decodeTuiMcpSnapshot(
            await client.queryExtension(
              view.session.id,
              'builtin.mcp.management',
              'mcp.servers',
              {},
              { signal: owned.signal },
            ),
          );
          let server = directory.items.find((item) => item.id === source.id);
          if (!server?.admitted) continue;
          if (!server.selected) {
            await submit('builtin.mcp.management', 'mcp.server.select', {
              serverId: server.id,
              enabled: true,
              scope: 'user',
              expectedReadSet: directory.readSet,
            });
            directory = decodeTuiMcpSnapshot(
              await client.queryExtension(
                view.session.id,
                'builtin.mcp.management',
                'mcp.servers',
                {},
                { signal: owned.signal },
              ),
            );
            server = directory.items.find((item) => item.id === source.id);
          }
          if (server?.selected && server.available)
            await submit('builtin.mcp', 'mcp.connect', { serverId: server.id, key: randomUUID() });
        }
        // Return another real scoped source read after setup, never a fabricated view.
        return await actualFetch(input, init);
      } finally {
        client.disposeNetwork();
      }
    }
    return response;
  }) as typeof fetch;
  return () => {
    owned.abort();
    globalThis.fetch = actualFetch;
  };
}
