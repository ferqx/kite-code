import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import {
  type createCredentialVault,
  type McpPrivateSourceEntry,
  type McpSourceOptions,
  mcpCanonical,
  readConfigurationFile,
  readMcpSources,
  updateConfigurationFile,
  userMcpSourceBinding,
  writeMcpSourceEntry,
  writeUserMcpSourceCredentialBinding,
} from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import {
  createMcpAdapter,
  createMcpOAuthProvider,
  createUserMcpStdioTransportPort,
  type McpHostTransportPort,
  type McpStdioPortOptions,
  type McpTransportConfiguration,
  type McpUserTransportBinding,
} from '@kite-ai/agent/mcp';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import type { HostMutationRecord } from '@kite-ai/agent/storage';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListToolsResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  type UserMcpOperationResult,
  UserMcpOperationResultSchema,
  type UserMcpSettingsOperation,
  UserMcpSettingsOperationSchema,
  type UserMcpSettingsView,
  UserMcpSettingsViewSchema,
  type UserMcpToolsPage,
  UserMcpToolsPageSchema,
} from './http/schema/user-mcp';
import { createUserMcpHttpTransportPort, type McpHttpPortOptions } from './mcp-http-port';
import { openMcpOAuthBrowser } from './mcp-oauth-browser';
import { createMcpOAuthSession, type McpOAuthSessionOptions } from './mcp-oauth-session';
import { acquireUserMcpOAuth, userMcpOAuthScope } from './user-mcp-credentials';
import { disabledUserMcpSources } from './user-mcp-selection';

export interface UserMcpIdentity {
  expectedStoreId: string;
  subjectId: string;
}
export interface UserMcpOperationIdentity extends UserMcpIdentity {
  commandId: string;
}
export interface UserMcpSettingsInput extends UserMcpOperationIdentity {
  expectedReadSet: string;
  operation: UserMcpSettingsOperation;
}
export interface UserMcpManagementOptions {
  profile: ProfileSelection;
  runtime: () => AgentRuntime;
  credentialVault: ReturnType<typeof createCredentialVault>;
  /** Trusted complete user configuration path, for its existing MCP enabled selection. */
  userConfigurationPath: string;
  subjectId?: string;
  variables?: () => Readonly<Record<string, string>>;
  http?: Pick<
    McpHttpPortOptions,
    'resolveAddresses' | 'allowLoopbackForTests' | 'trustedTestCertificate' | 'limits'
  >;
  stdio?: Pick<
    McpStdioPortOptions,
    'guardianPath' | 'bunExecutable' | 'limits' | 'controlBase' | 'linux'
  >;
  oauth?: Partial<
    Pick<McpOAuthSessionOptions, 'openBrowser' | 'network' | 'callbackTimeoutMs' | 'now'>
  >;
}
export interface UserMcpManagementPort {
  read(input: UserMcpIdentity): Promise<UserMcpSettingsView>;
  mutate(input: UserMcpSettingsInput): Promise<UserMcpOperationResult>;
  lookup(input: UserMcpOperationIdentity): Promise<UserMcpOperationResult>;
  cancel(input: UserMcpOperationIdentity): Promise<UserMcpOperationResult>;
  tools(
    input: UserMcpIdentity & { serverId: string; generation: number; afterIndex?: number },
  ): Promise<UserMcpToolsPage>;
  close(): Promise<void>;
}

const hash = (value: unknown) => createHash('sha256').update(mcpCanonical(value)).digest('hex');
const obj = (value: unknown): Record<string, Json> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
type Receipt = UserMcpOperationResult['receipt'];
type Auth = UserMcpSettingsView['sources'][number]['authentication'];
type ConnectionState = UserMcpSettingsView['sources'][number]['connection'];
const emptyReceipt = (): Receipt => ({
  code: null,
  cancelled: false,
  configuration: 'unchanged',
  authentication: null,
  connection: null,
  revocation: null,
});
const disconnected = (): ConnectionState => ({
  state: 'disconnected',
  generation: null,
  toolCount: null,
});
function safeCode(error: unknown, fallback = 'mcp_settings_unavailable'): string {
  const value = error && typeof error === 'object' && 'code' in error ? error.code : null;
  return typeof value === 'string' && /^[a-z0-9_]{1,128}$/.test(value) ? value : fallback;
}

/** User-only configuration/catalogue owner. It exposes no Agent tool execution entry point. */
export function createUserMcpManagement(options: UserMcpManagementOptions): UserMcpManagementPort {
  const { profile, credentialVault: vault } = options;
  let storeId: string | undefined,
    subjectId = options.subjectId,
    closed = false;
  type Owned = Awaited<ReturnType<McpHostTransportPort<McpUserTransportBinding>['open']>>;
  type Connection = {
    client: Client;
    owned: Owned;
    controller: AbortController;
    configuration: McpTransportConfiguration;
    entry: McpPrivateSourceEntry;
    generation: number;
    tools: Tool[];
    state: ConnectionState['state'];
    commandId: string;
    subjectId: string;
    requestDigest: string;
  };
  const connections = new Map<string, Connection>();
  const connectionFacts = new Map<string, ConnectionState>();
  const challenges = new Map<
    string,
    { resourceMetadataUrl?: string; scopes?: readonly string[] }
  >();
  const tasks = new Map<
    string,
    {
      controller: AbortController;
      done: Promise<void>;
      serverId?: string;
      kind: UserMcpSettingsOperation['kind'];
    }
  >();
  let generation = 0;
  let closeTask: Promise<void> | undefined;
  function heldSources(exclude: ReadonlySet<string>): UserMcpSettingsView['sources'] {
    return [...connections.entries()]
      .filter(([id]) => !exclude.has(id))
      .map(([id, connection]) => ({
        id,
        name: connection.entry.server.name,
        transport: connection.entry.server.transport,
        address:
          connection.configuration.type === 'http'
            ? connection.configuration.url
            : connection.configuration.command,
        enabled: false,
        configured: false,
        diagnostics: ['mcp_source_entry_missing'],
        authentication: {
          policy: policy(connection.entry),
          status: 'unknown',
          loginAllowed: false,
        },
        connection: {
          state: connection.state === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
          generation: null,
          toolCount: null,
        },
      }));
  }
  function cleanupReadSet() {
    return connections.size
      ? hash({
          domain: 'kite-user-mcp-cleanup-read-v1',
          storeId,
          subjectId,
          owners: [...connections.entries()]
            .map(([serverId, connection]) => ({
              serverId,
              commandId: connection.commandId,
              requestDigest: connection.requestDigest,
            }))
            .sort((a, b) => a.serverId.localeCompare(b.serverId)),
        })
      : null;
  }
  const key = (input: UserMcpOperationIdentity) =>
    JSON.stringify([input.expectedStoreId, input.subjectId, input.commandId]);
  async function identify(input: UserMcpIdentity, allowClosed = false) {
    if ((!allowClosed && closed) || !input.subjectId || input.subjectId.length > 256)
      throw new AgentError('mcp_settings_unavailable');
    const host = options.runtime(),
      metadata = await host.getMetadata();
    if (
      metadata.storeId !== input.expectedStoreId ||
      (storeId !== undefined && storeId !== metadata.storeId)
    )
      throw new AgentError('store_mismatch');
    if (subjectId !== undefined && subjectId !== input.subjectId)
      throw new AgentError('mcp_settings_subject_mismatch');
    storeId = metadata.storeId;
    subjectId ??= input.subjectId;
    return host;
  }
  function sourceOptions(): McpSourceOptions {
    if (!storeId) throw new AgentError('store_unavailable');
    return {
      profilePath: profile.profilePath,
      scope: {
        mode: 'user',
        profileId: profile.profileAccessKey,
        storeId,
        sessionId: null,
        workspaceId: null,
      },
      variables: options.variables?.() ?? {},
    };
  }
  function observe() {
    const source = sourceOptions(),
      state = readMcpSources(source);
    const user = readConfigurationFile({
      path: options.userConfigurationPath,
      windowsPathPolicy: 'private',
    });
    if (
      user.value.mcp !== undefined &&
      (!Array.isArray(user.value.mcp) ||
        user.value.mcp.some((entry) => !obj(entry).id || typeof obj(entry).id !== 'string'))
    )
      throw new AgentError('mcp_configuration_unavailable');
    disabledUserMcpSources(user.value);
    return { source, state, user, readSet: hash({ source: state.readSet, userEtag: user.etag }) };
  }
  function selected(observed: ReturnType<typeof observe>, entry: McpPrivateSourceEntry) {
    if (!entry.server.enabled) return false;
    const selection = observed.user.value.mcp;
    if (selection === undefined)
      return !disabledUserMcpSources(observed.user.value).includes(entry.server.id);
    const chosen = (selection as Json[]).find((item) => obj(item).id === entry.server.id);
    return chosen !== undefined && obj(chosen).enabled !== false;
  }
  function transport(entry: McpPrivateSourceEntry): McpTransportConfiguration {
    const value = entry.transport;
    if (value?.type === 'http' && typeof value.url === 'string')
      return { type: 'http', url: value.url };
    if (value?.type === 'stdio' && typeof value.command === 'string')
      return {
        type: 'stdio',
        command: value.command,
        args: value.args as string[],
        env: value.env as Record<string, string>,
        cwd: typeof value.cwd === 'string' ? value.cwd : profile.profilePath,
      };
    throw new AgentError('mcp_transport_unavailable');
  }
  function assertEntry(original: McpPrivateSourceEntry, enabled: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    if (closed) throw new AgentError('mcp_settings_unavailable');
    const current = observe(),
      entry = current.state.entries.find((row) => row.server.id === original.server.id);
    if (
      entry?.server.source.kind !== 'user' ||
      hash(entry.server.source) !== hash(original.server.source) ||
      entry.server.rawEntryDigest !== original.server.rawEntryDigest ||
      entry.server.transportDigest !== original.server.transportDigest ||
      hash(entry.userCredentialBinding ?? null) !== hash(original.userCredentialBinding ?? null) ||
      (enabled && !selected(current, entry))
    )
      throw new AgentError('mcp_source_conflict');
  }
  function sameEntry(original: McpPrivateSourceEntry, current: McpPrivateSourceEntry) {
    return (
      hash(original.server.source) === hash(current.server.source) &&
      original.server.rawEntryDigest === current.server.rawEntryDigest &&
      original.server.transportDigest === current.server.transportDigest &&
      hash(original.userCredentialBinding ?? null) === hash(current.userCredentialBinding ?? null)
    );
  }
  const policy = (entry: McpPrivateSourceEntry): Auth['policy'] =>
    entry.transport?.type !== 'http'
      ? 'none'
      : obj(entry.transport.auth).type === 'credential'
        ? 'credential'
        : obj(entry.transport.auth).type === 'oauth'
          ? 'oauth'
          : Object.hasOwn(obj(entry.raw), 'auth')
            ? 'none'
            : 'auto';
  async function acceptedCredential(entry: McpPrivateSourceEntry) {
    const saved = entry.userCredentialBinding;
    if (!saved || saved.revoked || saved.expiresAt <= Date.now())
      throw new AgentError('mcp_credential_binding_required');
    const proof = saved.proof,
      actual = await options.runtime().getHostMutation({
        expectedStoreId: storeId!,
        subjectId: proof.subjectId,
        commandId: proof.commandId,
      });
    const operation = obj(obj(obj(actual?.safeRequest).mcpSettings).operation);
    if (
      actual?.kind !== 'config.user.write' ||
      actual.scope !== 'user' ||
      actual.state !== 'applied' ||
      actual.originStoreId !== storeId ||
      actual.subjectId !== proof.subjectId ||
      actual.requestDigest !== proof.requestDigest ||
      operation.kind !== 'bind' ||
      operation.serverId !== entry.server.id ||
      operation.expiresAt !== saved.expiresAt ||
      obj(actual.receipt).credentialBindingDigest !== hash(saved)
    )
      throw new AgentError('mcp_source_decision_invalid');
    return saved;
  }
  async function authentication(
    entry: McpPrivateSourceEntry,
    signal = new AbortController().signal,
  ): Promise<Auth> {
    const kind = policy(entry);
    if (kind === 'none') return { policy: kind, status: 'none', loginAllowed: false };
    if (kind === 'credential') {
      if (!entry.userCredentialBinding)
        return { policy: kind, status: 'missing', loginAllowed: false };
      try {
        const binding = await acceptedCredential(entry);
        const secret = await vault.resolve(binding.vaultRef);
        return { policy: kind, status: secret ? 'present' : 'missing', loginAllowed: false };
      } catch {
        return { policy: kind, status: 'unavailable', loginAllowed: false };
      }
    }
    const scope = userMcpOAuthScope(profile.profileAccessKey, storeId!, entry),
      status = await vault.statusOwned(scope);
    const loginAllowed =
      entry.server.enabled && (kind === 'oauth' || challenges.has(scope.ownerDigest));
    if (status !== 'available') return { policy: kind, status, loginAllowed };
    const provider = createMcpOAuthProvider({
      vault,
      scope,
      redirectUrl: new URL('http://127.0.0.1/oauth/callback'),
      signal,
      assertFresh: () => signal.throwIfAborted(),
      ...(options.oauth?.now ? { now: options.oauth.now } : {}),
    });
    try {
      return {
        policy: kind,
        status: (await provider.getTokenState()).present ? 'present' : 'missing',
        loginAllowed,
      };
    } catch {
      return { policy: kind, status: 'unknown', loginAllowed };
    } finally {
      provider.cancel();
    }
  }
  async function oauth(
    entry: McpPrivateSourceEntry,
    signal: AbortSignal,
    action: 'login' | 'authRefresh' | 'clear' | 'revoke' | 'credential',
  ) {
    const scope = userMcpOAuthScope(profile.profileAccessKey, storeId!, entry);
    const release = await acquireUserMcpOAuth(scope, signal);
    try {
      assertEntry(entry, false, signal);
      const auth = obj(entry.transport?.auth),
        challenge = challenges.get(scope.ownerDigest);
      const session = createMcpOAuthSession({
        vault,
        scope,
        serverUrl: String(entry.transport!.url),
        signal,
        assertFresh: () => assertEntry(entry, false, signal),
        openBrowser: options.oauth?.openBrowser ?? openMcpOAuthBrowser,
        ...(options.oauth?.network ? { network: options.oauth.network } : {}),
        ...(options.oauth?.callbackTimeoutMs
          ? { callbackTimeoutMs: options.oauth.callbackTimeoutMs }
          : {}),
        ...(options.oauth?.now ? { now: options.oauth.now } : {}),
        ...(typeof auth.clientId === 'string' ? { clientId: auth.clientId } : {}),
        ...(typeof auth.clientSecretRef === 'string'
          ? { clientSecretRef: auth.clientSecretRef }
          : {}),
        ...(Array.isArray(auth.scopes)
          ? { scopes: auth.scopes as string[] }
          : challenge?.scopes
            ? { scopes: challenge.scopes }
            : {}),
        ...(challenge?.resourceMetadataUrl
          ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
          : {}),
      });
      if (action === 'login') {
        if (!(await authentication(entry, signal)).loginAllowed)
          throw new AgentError('mcp_oauth_login_unavailable');
        await session.login();
        return null;
      }
      if (action === 'authRefresh') {
        await session.refresh();
        return null;
      }
      if (action === 'clear') {
        await session.clear();
        return null;
      }
      if (action === 'revoke') return session.revoke();
      const current = await session.credential();
      if (!current) return null;
      const provider = createMcpOAuthProvider({
        vault,
        scope,
        redirectUrl: new URL('http://127.0.0.1/oauth/callback'),
        signal,
        assertFresh: () => assertEntry(entry, true, signal),
      });
      try {
        return await provider.readAccessToken(current.tokenRevision);
      } finally {
        provider.cancel();
      }
    } finally {
      release();
    }
  }
  async function prepareOAuthRemoval(entry: McpPrivateSourceEntry, signal: AbortSignal) {
    const scope = userMcpOAuthScope(profile.profileAccessKey, storeId!, entry);
    const release = await acquireUserMcpOAuth(scope, signal);
    try {
      assertEntry(entry, false, signal);
      const status = await vault.statusOwned(scope);
      assertEntry(entry, false, signal);
      if (status !== 'available')
        throw new AgentError(
          status === 'locked' ? 'mcp_credential_store_locked' : 'mcp_credential_store_unavailable',
        );
      const present = (await vault.readOwned(scope)) !== null;
      assertEntry(entry, false, signal);
      return {
        release,
        async clear(assertFresh: () => void) {
          if (!present) return;
          await createMcpOAuthSession({
            vault,
            scope,
            serverUrl: String(entry.transport!.url),
            signal,
            assertFresh,
            openBrowser: options.oauth?.openBrowser ?? openMcpOAuthBrowser,
          }).clear();
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }
  async function stop(serverId: string): Promise<void> {
    const connection = connections.get(serverId);
    if (!connection) {
      if (connectionFacts.get(serverId)?.state === 'outcome_unknown')
        throw new AgentError('mcp_connection_stop_unknown');
      connectionFacts.set(serverId, disconnected());
      return;
    }
    connection.controller.abort();
    const result = await Promise.allSettled([connection.owned.stop(), connection.client.close()]);
    const proof = result[0];
    if (
      proof.status === 'rejected' ||
      !['stopped', 'already_finished'].includes(proof.value.status)
    ) {
      connection.state = 'outcome_unknown';
      connectionFacts.set(serverId, {
        state: 'outcome_unknown',
        generation: null,
        toolCount: null,
      });
      throw new AgentError('mcp_connection_stop_unknown');
    }
    connections.delete(serverId);
    connectionFacts.set(serverId, disconnected());
  }
  async function readCatalogue(connection: Connection, signal: AbortSignal) {
    const tools: Tool[] = [],
      cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 64; page++) {
      assertEntry(connection.entry, true, signal);
      const result = await connection.client.request(
        { method: 'tools/list', params: cursor ? { cursor } : {} },
        ListToolsResultSchema,
        { signal, timeout: 10000 },
      );
      assertEntry(connection.entry, true, signal);
      tools.push(...result.tools);
      if (tools.length > 4096 || Buffer.byteLength(JSON.stringify(tools)) > 8 * 1024 * 1024)
        throw new AgentError('mcp_tools_metadata_limit');
      if (!result.nextCursor) {
        connection.tools = structuredClone(tools);
        connection.generation = ++generation;
        connection.state = 'ready';
        connectionFacts.set(connection.entry.server.id, {
          state: 'ready',
          generation: connection.generation,
          toolCount: tools.length,
        });
        return;
      }
      if (cursors.has(result.nextCursor)) throw new AgentError('mcp_cursor_repeated');
      cursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw new AgentError('mcp_catalogue_limit');
  }
  async function connect(
    input: UserMcpSettingsInput,
    record: HostMutationRecord,
    entry: McpPrivateSourceEntry,
    signal: AbortSignal,
  ) {
    if (
      connections.has(entry.server.id) &&
      connections.get(entry.server.id)!.state === 'disconnected'
    )
      await stop(entry.server.id);
    if (
      connections.has(entry.server.id) ||
      connectionFacts.get(entry.server.id)?.state === 'outcome_unknown'
    )
      throw new AgentError('mcp_connection_exists');
    if (!entry.server.admitted)
      throw new AgentError(entry.server.reason ?? 'mcp_server_not_admitted');
    if (!selected(observe(), entry)) throw new AgentError('mcp_server_disabled');
    const configuration = transport(entry),
      configDigest = createMcpAdapter({
        id: entry.server.id,
        transport: configuration,
      }).getCatalogue().configDigest;
    const controller = new AbortController(),
      lifetimeSignal = controller.signal;
    const cancelled = () => controller.abort();
    signal.addEventListener('abort', cancelled, { once: true });
    const binding: McpUserTransportBinding = {
      owner: 'user',
      originalStoreId: input.expectedStoreId,
      subjectId: input.subjectId,
      commandId: input.commandId,
      requestDigest: record.requestDigest,
      serverId: entry.server.id,
      scopeId: JSON.stringify(['user', input.expectedStoreId, input.subjectId, entry.server.id]),
      configDigest,
      configuration,
    };
    const admit = async () => {
      const host = await identify(input),
        original = await host.getHostMutation(input);
      const live = connections.get(entry.server.id);
      if (
        !original ||
        original.requestDigest !== record.requestDigest ||
        !['pending', ...(live ? ['applied'] : [])].includes(original.state)
      )
        throw new AgentError('operation_unverifiable');
      assertEntry(entry, true, lifetimeSignal);
    };
    const assertFresh = () => assertEntry(entry, true, lifetimeSignal);
    let port: McpHostTransportPort<McpUserTransportBinding>;
    if (configuration.type === 'http') {
      const kind = policy(entry);
      port = createUserMcpHttpTransportPort({
        ...options.http,
        admit,
        assertFresh,
        servers: [
          {
            id: entry.server.id,
            url: configuration.url,
            ...(kind === 'none'
              ? {}
              : {
                  managementCredential: async () => {
                    await admit();
                    if (kind === 'credential') {
                      const binding = await acceptedCredential(entry);
                      return vault.resolve(binding.vaultRef);
                    }
                    const auth = await authentication(entry, lifetimeSignal);
                    if (auth.status !== 'present') return null;
                    return await oauth(entry, lifetimeSignal, 'credential');
                  },
                }),
            ...(kind === 'oauth' || kind === 'auto'
              ? {
                  onUnauthorized: (_binding, challenge) => {
                    assertFresh();
                    const scope = userMcpOAuthScope(profile.profileAccessKey, storeId!, entry);
                    challenges.set(scope.ownerDigest, {
                      ...(challenge.resourceMetadataUrl
                        ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
                        : {}),
                      ...(challenge.scopes ? { scopes: challenge.scopes } : {}),
                    });
                  },
                }
              : {}),
          },
        ],
      });
    } else {
      if (!options.stdio) throw new AgentError('mcp_stdio_asset_unavailable');
      port = createUserMcpStdioTransportPort({
        ...options.stdio,
        controlBase: options.stdio.controlBase ?? profile.coordinationPath,
        servers: [
          {
            id: entry.server.id,
            configuration: {
              ...configuration,
              args: [...configuration.args],
              env: { ...configuration.env },
            },
          },
        ],
        allowedEnvNames: Object.keys(configuration.env),
        admit,
        assertFresh,
      });
    }
    connectionFacts.set(entry.server.id, {
      state: 'connecting',
      generation: null,
      toolCount: null,
    });
    let owned: Owned | undefined, connection: Connection | undefined;
    try {
      owned = await port.open(binding, { signal: lifetimeSignal });
      const client = new Client(
        { name: 'kite-user-mcp-settings', version: '1' },
        { capabilities: {} },
      );
      connection = {
        client,
        owned,
        controller,
        configuration,
        entry,
        generation: 0,
        tools: [],
        state: 'connecting',
        commandId: input.commandId,
        subjectId: input.subjectId,
        requestDigest: record.requestDigest,
      };
      connections.set(entry.server.id, connection);
      client.onclose = () => {
        if (connections.get(entry.server.id) === connection && connection!.state === 'ready') {
          connection!.state = 'disconnected';
          connectionFacts.set(entry.server.id, disconnected());
        }
      };
      await client.connect(owned.transport, { signal, timeout: 10000 });
      await readCatalogue(connection, signal);
      void owned.stopped
        .then((proof) => {
          if (connections.get(entry.server.id) !== connection) return;
          connection!.state = proof.supervision === 'ended' ? 'disconnected' : 'outcome_unknown';
          connectionFacts.set(entry.server.id, {
            state: connection!.state,
            generation: null,
            toolCount: null,
          });
        })
        .catch(() => {
          if (connections.get(entry.server.id) === connection) {
            connection!.state = 'outcome_unknown';
            connectionFacts.set(entry.server.id, {
              state: 'outcome_unknown',
              generation: null,
              toolCount: null,
            });
          }
        });
    } catch (error) {
      if (connection) await stop(entry.server.id);
      else if (owned && !['stopped', 'already_finished'].includes((await owned.stop()).status))
        throw new AgentError('mcp_connection_stop_unknown');
      connectionFacts.set(entry.server.id, { state: 'failed', generation: null, toolCount: null });
      throw error;
    } finally {
      signal.removeEventListener('abort', cancelled);
    }
  }
  function publicResult(record: HostMutationRecord, orphan = false): UserMcpOperationResult {
    const request = obj(obj(record.safeRequest).mcpSettings);
    if (
      record.kind !== 'config.user.write' ||
      record.scope !== 'user' ||
      typeof request.expectedReadSet !== 'string'
    )
      throw new AgentError('mcp_operation_not_found');
    const receipt =
      record.state === 'pending'
        ? emptyReceipt()
        : Object.fromEntries(
            [
              'code',
              'cancelled',
              'configuration',
              'authentication',
              'connection',
              'revocation',
            ].map((field) => [field, obj(record.receipt)[field]]),
          );
    return UserMcpOperationResultSchema.parse({
      scope: 'user',
      storeId: record.originStoreId,
      commandId: record.id,
      expectedReadSet: request.expectedReadSet,
      operation: request.operation,
      state: orphan ? 'outcome_unknown' : record.state,
      receipt: orphan
        ? {
            ...emptyReceipt(),
            configuration: ['add', 'remove', 'enabled', 'bind', 'clear', 'revoke'].includes(
              String(obj(request.operation).kind),
            )
              ? 'outcome_unknown'
              : 'unchanged',
            code: 'mcp_operation_owner_unavailable',
          }
        : receipt,
    });
  }
  async function lookup(input: UserMcpOperationIdentity) {
    const host = await identify(input, true),
      record = await host.getHostMutation(input);
    if (!record) throw new AgentError('mcp_operation_not_found');
    return publicResult(record, record.state === 'pending' && !tasks.has(key(input)));
  }
  async function perform(
    input: UserMcpSettingsInput,
    record: HostMutationRecord,
    controller: AbortController,
  ) {
    const receipt = emptyReceipt(),
      signal = controller.signal;
    let credentialBindingDigest: string | undefined;
    let state: UserMcpOperationResult['state'] = 'applied';
    try {
      if (input.operation.kind === 'disconnect') {
        const serverId = input.operation.serverId;
        signal.throwIfAborted();
        if (!connections.has(serverId) && !connectionFacts.has(serverId))
          throw new AgentError('mcp_connection_unavailable');
        const originalTasks = [...tasks.entries()]
          .filter(
            ([taskKey, task]) =>
              taskKey !== key(input) && task.serverId === serverId && task.kind !== 'disconnect',
          )
          .map(([, task]) => task);
        for (const task of originalTasks) task.controller.abort();
        await Promise.all(originalTasks.map((task) => task.done));
        await stop(serverId);
        receipt.connection = connectionFacts.get(serverId) ?? disconnected();
      } else {
        const observed = observe();
        if (observed.readSet !== input.expectedReadSet)
          throw new AgentError('configuration_read_set_conflict');
        signal.throwIfAborted();
        const op = input.operation,
          entry =
            'serverId' in op
              ? observed.state.entries.find((row) => row.server.id === op.serverId)
              : undefined;
        if (op.kind !== 'add' && !entry) throw new AgentError('mcp_source_entry_conflict');
        if (op.kind === 'add') {
          writeMcpSourceEntry({
            ...observed.source,
            expectedReadSet: observed.state.readSet,
            operationId: input.commandId,
            mutation: { ...op, scope: 'user' },
            validatePublication: () => {
              signal.throwIfAborted();
              if (observe().readSet !== input.expectedReadSet)
                throw new AgentError('configuration_read_set_conflict');
            },
          });
          receipt.configuration = 'published';
        } else if (op.kind === 'remove' || op.kind === 'enabled') {
          await stop(entry!.server.id);
          if (op.kind === 'remove' || (op.enabled && !entry!.server.enabled)) {
            const cleanup =
              op.kind === 'remove' && ['oauth', 'auto'].includes(policy(entry!))
                ? await prepareOAuthRemoval(entry!, signal)
                : undefined;
            try {
              const written = writeMcpSourceEntry({
                ...observed.source,
                expectedReadSet: observed.state.readSet,
                operationId: input.commandId,
                mutation:
                  op.kind === 'remove'
                    ? {
                        kind: 'remove',
                        scope: 'user',
                        serverId: op.serverId,
                        expectedRawEntryDigest: entry!.server.rawEntryDigest,
                      }
                    : {
                        kind: 'enabled',
                        scope: 'user',
                        serverId: op.serverId,
                        expectedRawEntryDigest: entry!.server.rawEntryDigest,
                        enabled: op.enabled,
                      },
                validatePublication: () => {
                  signal.throwIfAborted();
                  if (observe().readSet !== input.expectedReadSet)
                    throw new AgentError('configuration_read_set_conflict');
                },
              });
              receipt.configuration = 'published';
              try {
                await cleanup?.clear(() => {
                  signal.throwIfAborted();
                  if (closed) throw new AgentError('mcp_settings_unavailable');
                  const current = observe();
                  if (
                    current.user.etag !== observed.user.etag ||
                    hash(current.state.readSet) !==
                      hash({
                        ...observed.state.readSet,
                        user: { ...observed.state.readSet.user, etag: written.newEtag },
                      })
                  )
                    throw new AgentError('mcp_source_conflict');
                });
              } catch (error) {
                throw new AgentError(
                  safeCode(error).endsWith('_unknown')
                    ? 'mcp_source_removed_credential_cleanup_unknown'
                    : 'mcp_source_removed_credential_cleanup_failed',
                );
              }
            } finally {
              cleanup?.release();
            }
          }
          if (op.kind === 'enabled') {
            const current = observe(),
              defaults = current.user.value.mcp === undefined;
            const next: Json[] = defaults
              ? disabledUserMcpSources(current.user.value).filter((id) => id !== op.serverId)
              : (current.user.value.mcp as Json[]).filter((row) => obj(row).id !== op.serverId);
            if (defaults) {
              if (!op.enabled) next.push(op.serverId);
              disabledUserMcpSources({ disabledUserMcpSources: next });
            } else next.push({ id: op.serverId, enabled: op.enabled });
            updateConfigurationFile({
              path: options.userConfigurationPath,
              windowsPathPolicy: 'private',
              ifMatch: observed.user.etag,
              operations: [
                {
                  kind: 'set',
                  path: [defaults ? 'disabledUserMcpSources' : 'mcp'],
                  value: next,
                },
              ],
              validatePublication: () => {
                signal.throwIfAborted();
                if (hash(readMcpSources(current.source).readSet) !== hash(current.state.readSet))
                  throw new AgentError('mcp_source_conflict');
              },
            });
            receipt.configuration = 'published';
          }
          receipt.connection = connectionFacts.get(entry!.server.id) ?? disconnected();
        } else if (op.kind === 'connect') await connect(input, record, entry!, signal);
        else if (op.kind === 'reconnect') {
          await stop(op.serverId);
          await connect(input, record, entry!, signal);
        } else if (op.kind === 'refresh') {
          const connection = connections.get(op.serverId);
          if (connection?.state !== 'ready') throw new AgentError('mcp_connection_unavailable');
          await readCatalogue(connection, signal);
        } else if (
          op.kind === 'bind' ||
          ((op.kind === 'clear' || op.kind === 'revoke') && policy(entry!) === 'credential')
        ) {
          await stop(entry!.server.id);
          const auth = obj(entry!.transport?.auth),
            binding = userMcpSourceBinding(observed.source, entry!);
          if (
            !binding ||
            auth.type !== 'credential' ||
            typeof auth.credentialRef !== 'string' ||
            typeof auth.profile !== 'string'
          )
            throw new AgentError('mcp_credential_binding_required');
          if (op.kind === 'bind') {
            if (op.expiresAt <= Date.now()) throw new AgentError('mcp_credential_binding_expired');
            await vault.resolve(auth.credentialRef);
          }
          const current = observe();
          if (current.readSet !== input.expectedReadSet)
            throw new AgentError('configuration_read_set_conflict');
          const value = {
            ...binding,
            kind: 'mcp_user_credential_binding' as const,
            authProfile: auth.profile,
            purpose: 'mcp.http' as const,
            vaultRef: auth.credentialRef,
            expiresAt: op.kind === 'bind' ? op.expiresAt : Date.now(),
            revoked: op.kind !== 'bind',
            proof: {
              kind: 'host_mutation' as const,
              storeId: input.expectedStoreId,
              subjectId: input.subjectId,
              commandId: input.commandId,
              requestDigest: record.requestDigest,
              recordedAt: Date.now(),
            },
          };
          writeUserMcpSourceCredentialBinding({
            ...current.source,
            expectedReadSet: current.state.readSet,
            value,
            validateUserDecision: (proof) =>
              !signal.aborted &&
              proof.commandId === record.id &&
              proof.requestDigest === record.requestDigest &&
              observe().readSet === input.expectedReadSet,
          });
          credentialBindingDigest = hash(value);
          receipt.configuration = 'published';
          if (op.kind === 'revoke') {
            await vault.revoke(auth.credentialRef);
            receipt.revocation = 'completed';
          }
        } else if (op.kind !== 'authStatus') {
          if (!['oauth', 'auto'].includes(policy(entry!)))
            throw new AgentError('mcp_oauth_not_available');
          if (
            op.kind === 'clear' ||
            op.kind === 'revoke' ||
            op.kind === 'login' ||
            op.kind === 'authRefresh'
          ) {
            await stop(entry!.server.id);
            const result = await oauth(entry!, signal, op.kind);
            if (op.kind === 'revoke') receipt.revocation = result as 'completed' | 'not_supported';
          }
        }
        if (entry) {
          const current = observe().state.entries.find((row) => row.server.id === entry.server.id);
          if (current)
            receipt.authentication =
              op.kind === 'bind'
                ? { policy: 'credential', status: 'present', loginAllowed: false }
                : await authentication(current, signal);
          receipt.connection = connectionFacts.get(entry.server.id) ?? disconnected();
        }
      }
    } catch (error) {
      const code = safeCode(
        error,
        signal.aborted ? 'mcp_operation_cancelled' : 'mcp_settings_unavailable',
      );
      const unknown =
        code.endsWith('_unknown') ||
        code === 'configuration_publication_uncertain' ||
        receipt.configuration === 'published';
      state = unknown ? 'outcome_unknown' : 'failed';
      receipt.code = code;
      receipt.cancelled = signal.aborted;
      if (code.includes('publication') || code === 'configuration_publication_uncertain')
        receipt.configuration = 'outcome_unknown';
    }
    try {
      await options.runtime().finishHostMutation({
        ...input,
        requestDigest: record.requestDigest,
        state,
        receipt: {
          ...receipt,
          ...(credentialBindingDigest ? { credentialBindingDigest } : {}),
        } as unknown as Json,
      });
    } catch {
      // Publication uncertainty never leaves a newly established catalogue owner running
      // after its original durable completion could not be observed.
      if (
        'serverId' in input.operation &&
        connections.get(input.operation.serverId)?.commandId === input.commandId
      ) {
        try {
          await stop(input.operation.serverId);
        } catch {
          /* Keep the exact unknown owner retained. */
        }
      }
    }
  }
  return {
    async read(input) {
      await identify(input);
      try {
        const observed = observe(),
          sources: UserMcpSettingsView['sources'] = [];
        for (const entry of observed.state.entries) {
          const diagnostics = entry.server.reason ? [entry.server.reason] : [];
          const live = connections.get(entry.server.id);
          const stale = live && (!sameEntry(live.entry, entry) || !selected(observed, entry));
          if (stale) diagnostics.push('mcp_source_conflict');
          if (entry.server.transport === 'stdio' && !options.stdio)
            diagnostics.push('mcp_stdio_asset_unavailable');
          sources.push({
            id: entry.server.id,
            name: entry.server.name,
            transport: entry.server.transport,
            address:
              typeof entry.transport?.url === 'string'
                ? entry.transport.url
                : typeof entry.transport?.command === 'string'
                  ? entry.transport.command
                  : null,
            enabled: selected(observed, entry),
            configured: true,
            diagnostics,
            authentication: await authentication(entry),
            connection: stale
              ? { state: 'failed', generation: null, toolCount: null }
              : (connectionFacts.get(entry.server.id) ?? disconnected()),
          });
        }
        sources.push(
          ...heldSources(new Set(observed.state.entries.map((entry) => entry.server.id))),
        );
        return UserMcpSettingsViewSchema.parse({
          scope: 'user',
          storeId: input.expectedStoreId,
          readSet: observed.readSet,
          sources,
          errors: [
            observed.state.registry.errors.user,
            observed.state.registry.errors.binding,
          ].filter(Boolean),
        });
      } catch (error) {
        return {
          scope: 'user',
          storeId: input.expectedStoreId,
          readSet: cleanupReadSet(),
          sources: heldSources(new Set()),
          errors: [safeCode(error)],
        };
      }
    },
    async mutate(input) {
      const host = await identify(input);
      const operation = UserMcpSettingsOperationSchema.parse(input.operation);
      if (!/^[a-f0-9]{64}$/.test(input.expectedReadSet))
        throw new AgentError('invalid_host_mutation');
      if (operation.kind === 'add') {
        const value = operation.entry;
        if (
          Object.values(value).some(
            (part) =>
              typeof part === 'string' &&
              (Array.from(part).some(
                (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
              ) ||
                part.includes('${')),
          )
        )
          throw new AgentError('mcp_source_mutation_invalid');
        if (value.type === 'http') {
          let url: URL;
          try {
            url = new URL(value.url);
          } catch {
            throw new AgentError('mcp_transport_unavailable');
          }
          if (
            !['http:', 'https:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            value.url.includes('?') ||
            value.url.includes('#')
          )
            throw new AgentError('mcp_transport_unavailable');
        } else if (!isAbsolute(value.command)) throw new AgentError('mcp_transport_unavailable');
      }
      input = { ...input, operation };
      const requestDigest = hash({
        domain: 'kite-user-mcp-settings-v1',
        storeId: input.expectedStoreId,
        subjectId: input.subjectId,
        commandId: input.commandId,
        expectedReadSet: input.expectedReadSet,
        operation,
      });
      const accepted = await host.beginHostMutation({
        ...input,
        kind: 'config.user.write',
        scope: 'user',
        requestDigest,
        safeRequest: {
          scope: 'user',
          ifMatch: input.expectedReadSet,
          operationCount: 1,
          mcpSettings: { expectedReadSet: input.expectedReadSet, operation },
        },
      });
      if (!accepted.created)
        return publicResult(
          accepted.record,
          accepted.record.state === 'pending' && !tasks.has(key(input)),
        );
      const controller = new AbortController(),
        taskKey = key(input),
        server = 'serverId' in operation ? operation.serverId : undefined;
      const entry = {
        controller,
        done: Promise.resolve(),
        kind: operation.kind,
        ...(server ? { serverId: server } : {}),
      };
      tasks.set(taskKey, entry);
      entry.done = Promise.resolve()
        .then(async () => {
          try {
            if (
              [...tasks.entries()].some(
                ([otherKey, task]) =>
                  otherKey !== taskKey &&
                  (operation.kind === 'disconnect'
                    ? task.kind === 'disconnect' && task.serverId === server
                    : !server || !task.serverId || task.serverId === server),
              )
            ) {
              await host.finishHostMutation({
                ...input,
                requestDigest,
                state: 'failed',
                receipt: { ...emptyReceipt(), code: 'mcp_operation_busy' },
              });
            } else await perform(input, accepted.record, controller);
          } finally {
            tasks.delete(taskKey);
          }
        })
        .catch(() => {
          tasks.delete(taskKey);
        });
      if (['add', 'remove', 'enabled', 'bind', 'authStatus'].includes(operation.kind)) {
        await entry.done;
        return lookup(input);
      }
      return publicResult(accepted.record);
    },
    lookup,
    async cancel(input) {
      await identify(input, true);
      const task = tasks.get(key(input));
      if (task) {
        task.controller.abort();
        await task.done;
      }
      return lookup(input);
    },
    async tools(input) {
      await identify(input);
      const connection = connections.get(input.serverId);
      if (connection?.state !== 'ready' || connection.generation !== input.generation)
        throw new AgentError('mcp_tools_snapshot_stale');
      assertEntry(connection.entry, true, connection.controller.signal);
      const after = input.afterIndex === undefined ? 0 : input.afterIndex + 1;
      if (!Number.isSafeInteger(after) || after < 0 || after > connection.tools.length)
        throw new AgentError('mcp_tools_cursor_invalid');
      const entries: UserMcpToolsPage['entries'] = [];
      let bytes = 0,
        index = after;
      for (; index < connection.tools.length && entries.length < 32; index++) {
        const descriptor = connection.tools[index]!,
          size = Buffer.byteLength(JSON.stringify(descriptor));
        if (size > 1024 * 1024) throw new AgentError('mcp_tools_metadata_limit');
        if (entries.length && bytes + size > 1024 * 1024) break;
        entries.push({
          index,
          definitionId: `mcp.${input.serverId}.${hash(descriptor.name).slice(0, 32)}`,
          definitionVersion: hash({
            configDigest: createMcpAdapter({
              id: input.serverId,
              transport: connection.configuration,
            }).getCatalogue().configDigest,
            descriptor,
          }),
          descriptor: descriptor as Json,
        });
        bytes += size;
      }
      return UserMcpToolsPageSchema.parse({
        scope: 'user',
        storeId: input.expectedStoreId,
        serverId: input.serverId,
        generation: input.generation,
        entries,
        nextAfterIndex: index < connection.tools.length ? index - 1 : null,
        complete: index === connection.tools.length,
      });
    },
    close() {
      if (closeTask) return closeTask;
      closeTask = (async () => {
        closed = true;
        for (const task of tasks.values()) task.controller.abort();
        await Promise.all([...tasks.values()].map((task) => task.done));
        const result = await Promise.allSettled([...connections.keys()].map(stop));
        if (result.some((row) => row.status === 'rejected'))
          throw new AgentError('mcp_connection_stop_unknown');
      })();
      return closeTask;
    },
  };
}
