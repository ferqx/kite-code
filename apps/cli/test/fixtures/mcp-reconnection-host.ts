import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '@kite-ai/agent';
import { createArtifactStore } from '@kite-ai/agent/artifacts';
import { createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { acquireProfileAccess, acquireProfileDataLock } from '@kite-ai/agent/profile-access';
import { createWorkspaceSerialLocks } from '@kite-ai/agent/resources';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import { getLoadedSqliteEngine } from '@kite-ai/agent/sqlite-engine';
import { type AgentClient, createClient, requiresInteractionAttachment } from '@kite-ai/client';
import { startService } from '@kite-ai/service';
import { createDefaultProcessConfiguration } from '@kite-ai/service/configuration';
import type {
  TuiMcpConnectionIntent,
  TuiMcpReconnectionCarrier,
  TuiMcpReconnectionIntent,
  TuiMcpReconnectionObservation,
} from '@kite-ai/ui/tui';
import { openMcpConnectionJournal } from '../../host/mcp-connection-journal';
import { openMcpReconnectionJournal } from '../../host/mcp-reconnection-journal';
import { openMcpSourceApprovalJournal } from '../../host/mcp-source-approval-journal';
import { createTuiMcpPort } from '../../host/tui-mcp';
import { createTuiMcpConnectionPort } from '../../host/tui-mcp-connection';
import { createTuiMcpReconnectionPort } from '../../host/tui-mcp-reconnection';
import { createTuiMcpSourceApprovalPort } from '../../host/tui-mcp-source-approval';

/** Runtime-only cross-owner test boundary: CLI rootDir stays exact; the original
 * qualified fixture retains the formal builder/initializer and isolated lifetime. */
export async function prepareReconnectionEngine() {
  const module: unknown = await import(
    new URL('../../../../tests/fixtures/unified-agent/qualified-sqlite-fixture.ts', import.meta.url)
      .href
  );
  if (
    !module ||
    typeof module !== 'object' ||
    !('prepareQualifiedSqliteFixture' in module) ||
    typeof module.prepareQualifiedSqliteFixture !== 'function'
  )
    throw Error('owned_engine_fixture_module_invalid');
  const result: unknown = await Reflect.apply(module.prepareQualifiedSqliteFixture, module, []);
  if (
    !result ||
    typeof result !== 'object' ||
    !('engine' in result) ||
    !('close' in result) ||
    typeof result.close !== 'function'
  )
    throw Error('owned_engine_fixture_result_invalid');
  const engine = getLoadedSqliteEngine();
  if (!engine || result.engine !== engine || engine.qualification !== 'selected')
    throw Error('owned_engine_fixture_selection_invalid');
  const close = result.close;
  return {
    engine,
    close() {
      Reflect.apply(close, result, []);
    },
  };
}

export async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 8000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw Error('owned_reconnection_host_deadline');
    await Bun.sleep(5);
  }
}
export function reconnect(
  observed: TuiMcpReconnectionObservation,
  id: string,
): TuiMcpReconnectionIntent {
  return {
    sessionId: observed.carrier.sessionId,
    workspaceId: observed.carrier.workspaceId,
    workspaceIdentity: observed.carrier.workspaceIdentity,
    targetRequest: observed.carrier.request,
    request: {
      expectedStoreId: observed.carrier.request.expectedStoreId,
      commandId: id,
      kind: 'extension.invoke',
      extensionId: 'builtin.mcp',
      actionId: 'mcp.reconnect',
      definitionVersion: '1',
      input: {
        serverId: observed.carrier.request.input.serverId,
        key: `key_${id}`,
        target: observed.target,
        replacement: observed.replacement,
      },
    },
  };
}
export function carrier(
  intent: TuiMcpConnectionIntent | TuiMcpReconnectionIntent,
): TuiMcpReconnectionCarrier {
  return {
    sessionId: intent.sessionId,
    workspaceId: intent.workspaceId,
    workspaceIdentity: intent.workspaceIdentity,
    request: intent.request,
  };
}
/** Real public in-process assembly; setup engine belongs to the isolated test file, not this Profile. */
export async function reconnectionHostFixture(ask = false, many = false) {
  const root = realpathSync(mkdtempSync('/private/tmp/kite-reconnection-host-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { mode: 0o700 });
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  mkdirSync(profile.profilePath, { recursive: true, mode: 0o700 });
  let access = acquireProfileAccess(profile),
    accessHeld = true;
  const journalOptions = () => ({
    access,
    acquireWriteLock: () => acquireProfileDataLock(access, 'tui_private'),
  });
  let connectionJournal = openMcpConnectionJournal(journalOptions());
  let reconnectionJournal = openMcpReconnectionJournal(journalOptions());
  let sourceJournal = openMcpSourceApprovalJournal(journalOptions());
  let journalsHeld = true;
  let store: Awaited<ReturnType<typeof openSqliteStore>> | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let locks: ReturnType<typeof createWorkspaceSerialLocks> | undefined;
  let service: Awaited<ReturnType<typeof startService>> | undefined;
  let client: AgentClient | undefined;
  let storeId = '',
    expectedOld: string | undefined;
  let models = 0,
    vault = 0,
    effects = 0,
    sequence = 0;
  const rpc: string[] = [],
    wire: {
      sequence: number;
      method: string;
      oldExecutionId: string | null;
      oldTerminal: boolean | null;
      oldTransportStopped: boolean | null;
    }[] = [];
  const http: { method: string; operation: string }[] = [];
  const wireHttp: { method: string; operation: string }[] = [];
  const origins = new Set<string>();
  const originalFetch = globalThis.fetch;
  const ownedFetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
    const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]));
    if (origins.has(url.origin)) {
      const path = url.pathname;
      const operation = path.includes('/queries/')
        ? `query:${decodeURIComponent(path.split('/queries/')[1]!)}`
        : path.startsWith('/v1/commands/')
          ? 'command'
          : path.includes('/artifacts/')
            ? 'artifact'
            : path.endsWith('/view')
              ? 'view'
              : path.startsWith('/v1/workspaces')
                ? 'workspaces'
                : path.endsWith('/commands')
                  ? 'commandPost'
                  : path === '/v1/info'
                    ? 'info'
                    : 'other';
      wireHttp.push({
        method: args[1]?.method ?? (args[0] instanceof Request ? args[0].method : 'GET'),
        operation,
      });
    }
    return originalFetch(...args);
  }, originalFetch);
  globalThis.fetch = ownedFetch;
  // Keep the complete original descriptor inside the public Source adapter's 1MiB wire limit.
  const description = `原始完整描述🙂\r\n${'x'.repeat(700 * 1024)}完整原尾部`;
  const peer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'DELETE') return new Response(null, { status: 200 });
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const body = (await request.json()) as { id?: number; method: string };
      const event = {
        sequence: ++sequence,
        method: body.method,
        oldExecutionId: expectedOld ?? null,
        oldTerminal: null as boolean | null,
        oldTransportStopped: null as boolean | null,
      };
      wire.push(event); // Real wire attempt recorded before any response or state observation.
      if (body.id === undefined) return new Response(null, { status: 202 });
      rpc.push(body.method);
      if (body.method === 'tools/call') {
        effects++;
        return new Response(null, { status: 500 });
      }
      if (expectedOld && store) {
        const old = await store.getExecution(expectedOld);
        event.oldTerminal = !!old && ['succeeded', 'failed', 'cancelled'].includes(old.status);
        const result = old?.result;
        event.oldTransportStopped =
          !!result &&
          typeof result === 'object' &&
          !Array.isArray(result) &&
          !!result.details &&
          typeof result.details === 'object' &&
          !Array.isArray(result.details) &&
          result.details.transportStopped === true;
      }
      const result =
        body.method === 'initialize'
          ? {
              protocolVersion: '2024-11-05',
              serverInfo: { name: 'owned', version: '1' },
              capabilities: { tools: {} },
            }
          : body.method === 'tools/list'
            ? {
                tools: [
                  {
                    name: 'original_full_tool',
                    description,
                    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
                    annotations: { title: '原始完整标题' },
                  },
                ],
              }
            : null;
      if (!result) return new Response(null, { status: 500 });
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    },
  });
  const provider = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      models++;
      return new Response(null, { status: 500 });
    },
  });
  const sourcePath = join(profile.profilePath, 'mcp.json');
  const source = (revision = 1) =>
    JSON.stringify({
      mcpServers: Object.fromEntries([
        [
          'owned',
          {
            type: 'http',
            url: new URL(`revision-${revision}`, peer.url).href,
            auth: { type: 'none' },
          },
        ],
        ...(many
          ? Array.from({ length: 26 }, (_, n) => [
              `unused_${n}`,
              { type: 'http', url: peer.url.href, auth: { type: 'none' }, enabled: false },
            ])
          : []),
      ]),
    });
  writeFileSync(sourcePath, source(), { mode: 0o600 });
  const configPath = join(profile.profilePath, 'config.jsonc');
  writeFileSync(
    configPath,
    JSON.stringify({
      modelId: 'fixed',
      models: [
        { id: 'fixed', provider: 'compatible', model: 'fixed', baseURL: `${provider.url.href}v1` },
      ],
    }),
    { mode: 0o600 },
  );
  const current = () => {
    if (!client) throw Error('owned_client_closed');
    return client;
  };
  const note = (method: string, operation: string) => http.push({ method, operation });
  const tracked = {
    get serverInfo() {
      return current().serverInfo;
    },
    async getView(...args: Parameters<AgentClient['getView']>) {
      note('GET', 'view');
      return current().getView(...args);
    },
    async listWorkspaces(...args: Parameters<AgentClient['listWorkspaces']>) {
      note('GET', 'workspacesPage');
      return current().listWorkspaces(...args);
    },
    async listAllWorkspaces(...args: Parameters<AgentClient['listAllWorkspaces']>) {
      note('GET', 'workspaces');
      return current().listAllWorkspaces(...args);
    },
    async getHostMutation(...args: Parameters<AgentClient['getHostMutation']>) {
      note('GET', 'hostMutation');
      return current().getHostMutation(...args);
    },
    async getExecution(...args: Parameters<AgentClient['getExecution']>) {
      note('GET', 'execution');
      return current().getExecution(...args);
    },
    async readArtifact(...args: Parameters<AgentClient['readArtifact']>) {
      note('GET', 'artifact');
      return current().readArtifact(...args);
    },
    async queryExtension(...args: Parameters<AgentClient['queryExtension']>) {
      note('GET', `query:${args[2]}`);
      return current().queryExtension(...args);
    },
    async getCommand(...args: Parameters<AgentClient['getCommand']>) {
      note('GET', 'command');
      return current().getCommand(...args);
    },
    async invokeExtension(...args: Parameters<AgentClient['invokeExtension']>) {
      note('POST', `action:${args[1].actionId}`);
      return current().invokeExtension(...args);
    },
  };
  const management = () => createTuiMcpPort(tracked, storeId);
  const connection = () => createTuiMcpConnectionPort(tracked, storeId, connectionJournal);
  const sourcePort = () => createTuiMcpSourceApprovalPort(tracked, storeId, sourceJournal);
  const port = () =>
    createTuiMcpReconnectionPort(
      tracked,
      storeId,
      { connection: connectionJournal, reconnection: reconnectionJournal },
      sourcePort(),
    );
  async function stop() {
    client?.disposeNetwork();
    client = undefined;
    if (service) {
      await service.close();
      service = undefined;
    }
    if (runtime) {
      await runtime.close();
      runtime = undefined;
      store = undefined;
    }
    if (locks) {
      await locks.close();
      locks = undefined;
    }
    if (store) {
      await store.close();
      store = undefined;
    }
  }
  function closeJournals() {
    if (!journalsHeld) return;
    connectionJournal.close();
    reconnectionJournal.close();
    sourceJournal.close();
    journalsHeld = false;
  }
  async function offline() {
    await stop();
    closeJournals();
    if (accessHeld) {
      access.lock.release();
      accessHeld = false;
    }
  }
  async function start() {
    const backend = createTemporaryCredentialBackend();
    const configuration = createDefaultProcessConfiguration({
      profile,
      observerSubjectId: 'owner',
      mcpSources: { http: { allowLoopbackForTests: true } },
      credentialBackend: {
        ...backend,
        async resolve(ref) {
          vault++;
          return backend.resolve(ref);
        },
      },
      permissionPolicy: {
        readPolicy: (request) => ({
          mode: ask ? 'ask' : 'full',
          workspaceTrust: true,
          revision: 'owned-reconnection-policy',
          allowed: [
            {
              kind: request.kind,
              definitionId: request.definitionId,
              definitionVersion: request.definitionVersion,
            },
          ],
        }),
      },
    });
    store = await openSqliteStore(profile);
    storeId = (await store.getMetadata()).storeId;
    locks = createWorkspaceSerialLocks(profile);
    runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      workspaceSerialLocks: locks,
      processConcurrency: 1,
      permissions: configuration.permissions!,
      extensions: configuration.extensions,
      supportsExtensionInputs: configuration.supportsExtensionInputs,
      resolveRunConfiguration: configuration.resolveRunConfiguration,
      resolveRecoveryRunConfiguration: configuration.resolveRecoveryRunConfiguration,
    });
    configuration.permissionManagement?.(runtime);
    service = await startService({
      runtime,
      subjectId: 'owner',
      buildId: 'owned-reconnection-host',
      profile: {
        dataRoot: profile.dataRoot,
        name: profile.profile,
        accessKey: profile.profileAccessKey,
      },
      configurationManagement: configuration.configurationManagement!(runtime),
    });
    origins.add(new URL(service.endpoint).origin);
    client = createClient({
      endpoint: service.endpoint,
      token: service.bootstrap.token,
      bootstrap: service.bootstrap,
      expected: {
        profile: service.bootstrap.profile,
        apiMajor: 1,
        requiredCapabilities: ['commands', 'extension_queries', 'extensions_actions'],
      },
    });
    await client.connect();
  }
  async function reopen() {
    if (!accessHeld) {
      access = acquireProfileAccess(profile);
      accessHeld = true;
    }
    if (!journalsHeld) {
      connectionJournal = openMcpConnectionJournal(journalOptions());
      reconnectionJournal = openMcpReconnectionJournal(journalOptions());
      sourceJournal = openMcpSourceApprovalJournal(journalOptions());
      journalsHeld = true;
    }
    await start();
  }
  async function close() {
    let failure: unknown;
    try {
      await offline();
    } catch (error) {
      failure = error;
    }
    try {
      peer.stop(true);
    } catch (error) {
      failure ??= error;
    }
    try {
      provider.stop(true);
    } catch (error) {
      failure ??= error;
    }
    if (globalThis.fetch === ownedFetch) globalThis.fetch = originalFetch;
    else failure ??= Error('owned_fetch_cleanup_unconfirmed');
    if (failure) throw failure;
    rmSync(root, { recursive: true });
    const confirmed = !existsSync(root);
    console.log(
      JSON.stringify({
        stage: 'reconnection_host_closed',
        confirmed,
        modelCalls: models,
        credentialCalls: vault,
        toolEffects: effects,
      }),
    );
    if (!confirmed) throw Error('owned_host_cleanup_unconfirmed');
  }
  try {
    await start();
    if (many)
      for (let n = 0; n < 101; n++)
        await current().createWorkspace({
          expectedStoreId: storeId,
          id: `unused_w_${String(n).padStart(3, '0')}`,
          name: 'unused',
          rootUri: pathToFileURL(workspace).href,
        });
    await current().createWorkspace({
      expectedStoreId: storeId,
      id: 'w_zz',
      name: 'owned',
      rootUri: pathToFileURL(workspace).href,
    });
    await current().createSession({
      expectedStoreId: storeId,
      sessionId: 's',
      commandId: 'create_s',
      workspaceId: 'w_zz',
      title: 'owned',
    });
    const facts = await management().read('s', new AbortController().signal);
    const sources = await sourcePort().read('s', new AbortController().signal);
    const ownedId = sources.items.find((row) => row.name === 'owned')?.id;
    const selected = facts.items.find((row) => row.id === ownedId)!;
    if (!selected) throw Error('owned_server_unavailable');
    const configured = JSON.parse(readFileSync(configPath, 'utf8'));
    configured.mcp = [{ id: selected.id, enabled: true }];
    writeFileSync(configPath, JSON.stringify(configured), { mode: 0o600 });
    return {
      root,
      workspace,
      profile,
      sourcePath,
      description,
      tracked,
      port,
      connection,
      management,
      sourcePort,
      offline,
      reopen,
      close,
      get client() {
        return current();
      },
      get store() {
        if (!store) throw Error('owned_store_closed');
        return store;
      },
      get storeId() {
        return storeId;
      },
      get journal() {
        return reconnectionJournal;
      },
      get connectionJournal() {
        return connectionJournal;
      },
      counts: () => ({
        models,
        vault,
        effects,
        rpc: [...rpc],
        wire: [...wire],
        http: [...http],
        wireHttp: [...wireHttp],
      }),
      expectOld(id: string) {
        expectedOld = id;
      },
      changeSource(revision: number) {
        writeFileSync(sourcePath, source(revision), { mode: 0o600 });
      },
      removeSourceAndMoveWorkspace() {
        writeFileSync(sourcePath, '{"mcpServers":{}}', { mode: 0o600 });
        renameSync(workspace, join(root, 'removed-workspace'));
      },
      async ordinary(id: string) {
        const facts = await management().read('s', new AbortController().signal);
        const intent: TuiMcpConnectionIntent = {
          sessionId: 's',
          workspaceId: 'w_zz',
          workspaceIdentity: facts.workspaceIdentity,
          request: {
            expectedStoreId: storeId,
            commandId: id,
            kind: 'extension.invoke',
            extensionId: 'builtin.mcp',
            actionId: 'mcp.connect',
            definitionVersion: '1',
            input: { serverId: selected.id, key: `key_${id}` },
          },
        };
        const outcome = await connection().submit(intent, facts);
        return { intent, outcome };
      },
      async connectionReady(intent: TuiMcpConnectionIntent) {
        return until(async () => {
          const outcome = await connection().lookup(intent, new AbortController().signal);
          return outcome.phase === 'ready' ? outcome : undefined;
        });
      },
      async reconnectionReady(intent: TuiMcpReconnectionIntent) {
        return until(async () => {
          const outcome = await port().lookup(intent, new AbortController().signal);
          return outcome.phase === 'ready' ? outcome : undefined;
        });
      },
      async approval(commandId: string, definitionId: string) {
        return until(async () => {
          const cards = await current().listInteractions('s', {
            storeId,
            state: 'pending',
            limit: 20,
          });
          for (const card of cards.interactions) {
            if (card.kind !== 'approval' || card.definitionId !== definitionId) continue;
            const execution = await store!.getExecution(card.executionId);
            if (
              execution?.originCommandId === commandId ||
              (execution?.parentExecutionId &&
                (await store!.getExecution(execution.parentExecutionId))?.originCommandId ===
                  commandId)
            )
              return card;
          }
          return undefined;
        });
      },
      async answer(
        card: Awaited<ReturnType<AgentClient['listInteractions']>>['interactions'][number],
        decision: 'approve' | 'deny',
      ) {
        if (requiresInteractionAttachment(card)) await current().readInteractionAttachment(card);
        return current().answerInteraction('s', card.id, {
          expectedStoreId: storeId,
          commandId: `answer_${card.id}`,
          expectedRevision: card.revision,
          answer: {
            kind: 'approval',
            decision,
            ...(decision === 'approve' ? { grant: 'approve_once' as const } : {}),
          },
        });
      },
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'owned_host_cleanup_failed');
    }
    throw error;
  }
}
