// src/core/mcp/manager.ts

import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  createSnapshot,
  descriptorRevision,
  digestCapability,
  UNKNOWN_EXTERNAL_EFFECTS,
} from '@/core/capabilities/catalog';
import { compileCapabilitySchema } from '@/core/capabilities/schema';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@/protocol/capabilities';
import { type McpCredentialStore, NativeMcpCredentialStore } from './credential-store';
import { diagnoseMcpError } from './diagnostics';
import {
  capabilityChangedProviderError,
  McpProviderError,
  providerErrorFromDiagnostic,
} from './provider-errors';
import type {
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
  McpRuntimeProvider,
} from './runtime-provider';
import { isMcpToolEnabled, resolveMcpToolPolicy } from './tool-policy';
import type { McpPrompt, McpResource, McpServerConfig, McpServerState } from './types';

const MCP_STARTUP_TIMEOUT = 5000;
const MCP_TOOL_CALL_TIMEOUT = 30_000;
const MCP_RESOURCE_TIMEOUT = 10_000;
const HTTP_MAX_RECONNECT = 5;
const HTTP_RECONNECT_BASE_MS = 1000;
const MCP_CIRCUIT_FAILURE_THRESHOLD = 3;
const MCP_CIRCUIT_OPEN_MS = 30_000;

/** Prompt registry entry: maps slash command key to server info */
export interface PromptEntry {
  server: string;
  prompt: McpPrompt;
}

export interface McpManagerOptions {
  createClient?: () => Client;
  createTransport?: (
    config: McpServerConfig,
    authProvider?: OAuthClientProvider,
  ) => Parameters<Client['connect']>[0] | Promise<Parameters<Client['connect']>[0]>;
  credentialStore?: McpCredentialStore;
}

/**
 * Manages multiple MCP server connections, tool aggregation, and prompt registry.
 */
export class McpManager implements McpRuntimeProvider {
  private readonly createClient: () => Client;
  private readonly createManagerTransport: (
    config: McpServerConfig,
    authProvider?: OAuthClientProvider,
  ) => Parameters<Client['connect']>[0] | Promise<Parameters<Client['connect']>[0]>;
  private servers = new Map<string, McpServerState>();
  private promptRegistry = new Map<string, PromptEntry>();
  private snapshot: CapabilitySnapshot = createSnapshot([]);
  private listeners = new Set<() => void>();
  private oauthProviders = new Map<string, OAuthClientProvider>();
  private oauthTransports = new Map<
    string,
    { generation: number; transport: OAuthFinishTransport }
  >();

  constructor(options: McpManagerOptions = {}) {
    this.createClient =
      options.createClient ??
      (() => new Client({ name: 'kite-code', version: '0.1.0' }, { capabilities: {} }));
    const credentialStore = options.credentialStore ?? new NativeMcpCredentialStore();
    this.createManagerTransport =
      options.createTransport ??
      ((config, authProvider) => createTransport(config, authProvider, credentialStore));
  }

  /** Connect to all configured servers in parallel, non-blocking on individual failures */
  async connectAll(servers: Record<string, McpServerConfig>): Promise<void> {
    const entries = Object.entries(servers);
    const results = await Promise.allSettled(
      entries.map(([name, config]) => this.connect(name, config, 0)),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const serverName = entries[i]![0];
        console.error(`[MCP] Failed to connect ${serverName}.`);
      }
    }
  }

  /** Connect a single MCP server */
  async connect(name: string, config: McpServerConfig, generation = 0): Promise<void> {
    const client = this.createClient();
    const initialState: McpServerState = {
      config,
      client,
      tools: [],
      prompts: [],
      resources: [],
      health: 'connecting',
      generation,
      lastAttemptAt: new Date().toISOString(),
      consecutiveCallFailures: 0,
    };
    this.servers.set(name, initialState);
    this.publish();

    let transport: Parameters<Client['connect']>[0];
    try {
      transport = await this.createManagerTransport(config, this.oauthProviders.get(name));
      if (isOAuthFinishTransport(transport)) {
        this.oauthTransports.set(name, { generation, transport });
      } else {
        this.oauthTransports.delete(name);
      }
    } catch (err) {
      if (this.isCurrent(name, client, generation)) {
        initialState.health = 'disconnected';
        initialState.diagnostic = diagnoseMcpError(err, { phase: 'connect' });
        this.publish();
      }
      await closeClient(client);
      throw err;
    }

    try {
      await client.connect(transport, { timeout: MCP_STARTUP_TIMEOUT });
    } catch (err) {
      if (this.isCurrent(name, client, generation)) {
        initialState.health = 'disconnected';
        initialState.diagnostic = diagnoseMcpError(err, { phase: 'connect' });
        this.publish();
      } else {
        await closeClient(client);
      }
      throw err;
    }

    if (!this.isCurrent(name, client, generation)) {
      await closeClient(client);
      return;
    }

    const connectingState = this.servers.get(name);
    if (connectingState) {
      connectingState.health = 'discovering';
      this.publish();
    }

    // Fetch tools
    let tools: SdkTool[] = [];
    let discoveryFailed = false;
    try {
      const result = await client.listTools();
      tools = result.tools as SdkTool[];
    } catch (err) {
      discoveryFailed = true;
      if (this.isCurrent(name, client, generation)) {
        const state = this.servers.get(name);
        if (state) state.diagnostic = diagnoseMcpError(err, { phase: 'discovery' });
      }
    }

    if (!this.isCurrent(name, client, generation)) {
      await closeClient(client);
      return;
    }

    // Fetch prompts (optional)
    let prompts: McpPrompt[] = [];
    try {
      const result = await client.listPrompts();
      prompts = (result.prompts ?? []) as McpPrompt[];
    } catch {
      // prompts are optional
    }

    // Fetch resources (optional)
    let resources: McpResource[] = [];
    try {
      const resourceResult = await client.listResources();
      resources = (resourceResult.resources ?? []) as McpResource[];
    } catch {
      // Resources are optional in MCP
    }

    if (!this.isCurrent(name, client, generation)) {
      await closeClient(client);
      return;
    }

    // Register prompts in the global registry
    for (const prompt of prompts) {
      const key = `mcp__${name}__${prompt.name}`;
      this.promptRegistry.set(key, { server: name, prompt });
    }

    // Set up list-changed notification handlers
    try {
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        try {
          const result = await client.listTools();
          const state = this.servers.get(name);
          if (state && this.isCurrent(name, client, generation)) {
            state.tools = result.tools as SdkTool[];
            if (state.health !== 'circuit_open') state.health = 'ready';
            state.diagnostic = undefined;
            this.publish();
          }
        } catch (err) {
          const state = this.servers.get(name);
          if (
            state &&
            this.isCurrent(name, client, generation) &&
            state.health !== 'circuit_open'
          ) {
            state.health = 'degraded';
            state.diagnostic = diagnoseMcpError(err, { phase: 'discovery' });
            this.publish();
          }
        }
      });
    } catch {
      // handler setup best-effort
    }

    try {
      client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
        try {
          const result = await client.listPrompts();
          const state = this.servers.get(name);
          if (state && this.isCurrent(name, client, generation)) {
            state.prompts = (result.prompts ?? []) as McpPrompt[];
            // Refresh prompt registry for this server
            for (const [key, entry] of this.promptRegistry) {
              if (entry.server === name) {
                this.promptRegistry.delete(key);
              }
            }
            for (const prompt of state.prompts) {
              const key = `mcp__${name}__${prompt.name}`;
              this.promptRegistry.set(key, { server: name, prompt });
            }
            this.publish();
          }
        } catch {
          // The previous prompt registry remains valid until a successful refresh.
        }
      });
    } catch {
      // handler setup best-effort
    }

    try {
      client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
        const state = this.servers.get(name);
        if (state && this.isCurrent(name, client, generation)) {
          try {
            const result = await client.listResources();
            state.resources = (result.resources ?? []) as McpResource[];
            this.publish();
          } catch {
            /* ignore */
          }
        }
      });
    } catch {
      // handler setup best-effort
    }

    if (!this.isCurrent(name, client, generation)) {
      await closeClient(client);
      return;
    }
    initialState.tools = tools;
    initialState.prompts = prompts;
    initialState.resources = resources;
    initialState.health = discoveryFailed ? 'degraded' : 'ready';
    if (!discoveryFailed) initialState.diagnostic = undefined;
    this.publish();
  }

  /** Close the previous generation before starting one replacement connection. */
  async reconnect(name: string, config: McpServerConfig, generation: number): Promise<void> {
    await this.disconnect(name);
    await this.connect(name, config, generation);
  }

  /** Begin an explicit user-authorized OAuth attempt without opening a browser in Core. */
  async beginOAuth(
    name: string,
    config: McpServerConfig,
    generation: number,
    provider: OAuthClientProvider,
  ): Promise<'authorization_required' | 'connected'> {
    if (config.type !== 'http') throw new Error('OAuth is supported only for HTTP MCP servers.');
    await this.disconnect(name);
    this.oauthProviders.set(name, provider);
    try {
      await this.connect(name, config, generation);
      return 'connected';
    } catch (error) {
      if (error instanceof UnauthorizedError || diagnoseMcpError(error).code === 'auth_required') {
        return 'authorization_required';
      }
      throw error;
    }
  }

  /** Exchange the callback code, then reconnect and rediscover through a new client generation. */
  async finishOAuth(name: string, authorizationCode: string, generation: number): Promise<void> {
    const session = this.oauthTransports.get(name);
    const state = this.servers.get(name);
    if (!session || session.generation !== generation || !state) {
      throw new Error('OAuth session is no longer current.');
    }
    await session.transport.finishAuth(authorizationCode);
    await this.reconnect(name, state.config, generation);
  }

  /** Clear in-memory auth session state. Persistent credential deletion belongs to the coordinator. */
  async clearOAuth(name: string): Promise<void> {
    this.oauthProviders.delete(name);
    this.oauthTransports.delete(name);
    await this.disconnect(name);
  }

  /** Invalidate future bindings before best-effort transport shutdown. */
  async disconnect(name: string): Promise<void> {
    const state = this.servers.get(name);
    if (!state) return;
    this.servers.delete(name);
    this.oauthTransports.delete(name);
    this.removePromptsFor(name);
    this.publish();
    await closeClient(state.client as Client);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Return all tools from all connected servers */
  getAllTools(): Array<{ server: string; tool: SdkTool }> {
    const result: Array<{ server: string; tool: SdkTool }> = [];
    for (const [name, state] of this.servers) {
      if (!isUsableForDiscovery(state)) continue;
      for (const tool of state.tools) {
        if (!isMcpToolEnabled(state.config, tool.name)) continue;
        if (!compileCapabilitySchema(tool.inputSchema).ok) continue;
        result.push({ server: name, tool });
      }
    }
    return result;
  }

  /** Immutable discovery snapshot consumed by the Runtime binding controller. */
  getCapabilitySnapshot(): CapabilitySnapshot {
    return this.snapshot;
  }

  getProviderDirectorySnapshot(): McpProviderDirectorySnapshot {
    const entries = [...this.servers.entries()]
      .map(([providerId, state]): Readonly<McpProviderDirectoryEntry> => {
        const status =
          state.diagnostic?.code === 'auth_required'
            ? 'login_required'
            : state.health === 'connecting' || state.health === 'discovering'
              ? 'connecting'
              : state.health === 'ready'
                ? 'ready'
                : state.health === 'degraded' ||
                    state.health === 'half_open' ||
                    state.health === 'circuit_open'
                  ? 'degraded'
                  : state.health === 'quarantined'
                    ? 'quarantined'
                    : 'failed';
        return Object.freeze({
          providerId,
          status,
          required: state.config.required === true,
          source: 'explicit',
          lastKnownCapabilityNames: Object.freeze(
            state.tools.map((tool) => safeProviderMetadata(tool.name)).sort(),
          ),
          ...(state.diagnostic ? { diagnosticCode: state.diagnostic.code } : {}),
          retryable: state.diagnostic?.retryable ?? false,
        });
      })
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
    return Object.freeze({
      revision: digestCapability(entries),
      entries: Object.freeze(entries),
    });
  }

  findCapability(capabilityId: string): CapabilityDescriptor | undefined {
    return this.snapshot.descriptors.find((descriptor) => descriptor.capabilityId === capabilityId);
  }

  /** Execute an MCP tool on the specified server */
  async callTool(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const state = this.servers.get(server);
    if (!state) {
      throw providerErrorFromDiagnostic(server, undefined);
    }
    this.assertCallable(state, server);
    const discoveredTool = state.tools.find((tool) => tool.name === toolName);
    const descriptor = this.findCapability(`mcp:${server}/${toolName}`);
    if (!discoveredTool || !descriptor || descriptor.availability !== 'available') {
      throw capabilityChangedProviderError(server);
    }
    const client = state.client as Client;
    const execution = descriptor.execution;
    const canRetry =
      execution?.retry === 'safe_read' ||
      (execution?.retry === 'idempotency_key' &&
        typeof execution.idempotencyKeyArgument === 'string' &&
        typeof args[execution.idempotencyKeyArgument] === 'string' &&
        args[execution.idempotencyKeyArgument] !== '');
    try {
      let result: CallToolResult | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < (canRetry ? 2 : 1); attempt++) {
        try {
          result = (await client.callTool({ name: toolName, arguments: args }, undefined, {
            timeout: state.config.timeout ?? MCP_TOOL_CALL_TIMEOUT,
          })) as CallToolResult;
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!result) throw lastError;
      state.consecutiveCallFailures = 0;
      state.retryAt = undefined;
      state.health = 'ready';
      state.diagnostic = undefined;
      this.publish();
      // The SDK's task-enabled overload includes an indirection result. P0 uses
      // synchronous tool calls only; the protocol result is validated by the server.
      return result;
    } catch (error) {
      this.noteCallFailure(state, error);
      throw providerErrorFromDiagnostic(server, state.diagnostic);
    }
  }

  /** 列出指定 server 的所有资源（从缓存） / List resources for a server (from cache) */
  getResources(serverName: string): McpResource[] {
    return this.servers.get(serverName)?.resources ?? [];
  }

  /** 从指定 server 读取资源内容 / Read resource content from a server */
  async readResource(serverName: string, uri: string): Promise<string> {
    if (!serverName || !uri) {
      throw new Error('server and uri are required');
    }
    const state = this.servers.get(serverName);
    if (!state) {
      throw providerErrorFromDiagnostic(serverName, undefined);
    }
    if (!isUsableForDiscovery(state)) {
      throw providerErrorFromDiagnostic(serverName, state.diagnostic);
    }
    const client = state.client as Client;
    try {
      const result = await client.readResource(
        { uri },
        { timeout: state.config.timeout ?? MCP_RESOURCE_TIMEOUT },
      );
      // Extract text from resource contents
      if (result.contents && result.contents.length > 0) {
        return result.contents
          .map((c: { text?: string; blob?: string }) => c.text ?? c.blob ?? '')
          .join('\n');
      }
      return JSON.stringify(result);
    } catch (error) {
      this.noteCallFailure(state, error);
      throw providerErrorFromDiagnostic(serverName, state.diagnostic);
    }
  }

  /** Return the prompt registry (slash command key -> server/prompt) */
  getPromptRegistry(): Map<string, PromptEntry> {
    return this.promptRegistry;
  }

  /** @internal Migration/control-plane API. Frontends must consume McpControlSnapshot. */
  getServerStates(): ReadonlyMap<string, Readonly<McpServerState>> {
    return new Map(
      [...this.servers].map(([name, state]) => [
        name,
        Object.freeze({
          ...state,
          tools: Object.freeze([...state.tools]),
          prompts: Object.freeze(state.prompts.map((prompt) => Object.freeze({ ...prompt }))),
          resources: Object.freeze(
            state.resources.map((resource) => Object.freeze({ ...resource })),
          ),
        }) as Readonly<McpServerState>,
      ]),
    );
  }

  /** Disconnect all servers and clean up */
  async disconnectAll(): Promise<void> {
    const clients = [...this.servers.values()].map((state) => state.client as Client);
    this.servers.clear();
    this.promptRegistry.clear();
    this.oauthProviders.clear();
    this.oauthTransports.clear();
    this.publish();
    await Promise.allSettled(clients.map(closeClient));
  }

  private publish(): void {
    const descriptors: CapabilityDescriptor[] = [];
    for (const [serverName, state] of this.servers) {
      if (!isUsableForDiscovery(state)) continue;
      for (const tool of state.tools) {
        if (!isMcpToolEnabled(state.config, tool.name)) continue;
        const descriptor = createMcpToolDescriptor(serverName, state.config, tool);
        if (descriptor.availability === 'available') descriptors.push(descriptor);
      }
      for (const resource of state.resources) {
        descriptors.push(
          createPassiveDescriptor('mcp_resource', serverName, state.config, resource),
        );
      }
      for (const prompt of state.prompts) {
        descriptors.push(createPassiveDescriptor('mcp_prompt', serverName, state.config, prompt));
      }
    }
    this.snapshot = createSnapshot(descriptors);
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One observer cannot break connection lifecycle updates for other consumers.
      }
    }
  }

  private assertCallable(state: McpServerState, server: string): void {
    if (state.health === 'circuit_open') {
      if ((state.retryAt ?? Number.POSITIVE_INFINITY) > Date.now()) {
        throw new McpProviderError({
          providerId: server,
          kind: 'provider_unavailable',
          message: 'MCP provider circuit is open; retry later.',
          recoveryAction: 'retry',
          retryable: true,
          diagnosticCode: 'circuit_open',
        });
      }
      state.health = 'half_open';
      this.publish();
    }
    if (state.health !== 'ready' && state.health !== 'degraded' && state.health !== 'half_open') {
      throw providerErrorFromDiagnostic(server, state.diagnostic);
    }
  }

  private noteCallFailure(state: McpServerState, error: unknown): void {
    state.consecutiveCallFailures += 1;
    state.diagnostic = diagnoseMcpError(error, { phase: 'call' });
    if (state.consecutiveCallFailures >= MCP_CIRCUIT_FAILURE_THRESHOLD) {
      state.health = 'circuit_open';
      state.retryAt = Date.now() + MCP_CIRCUIT_OPEN_MS;
      state.diagnostic = Object.freeze({
        code: 'circuit_open',
        retryable: true,
        message: state.diagnostic.message,
        technical: state.diagnostic.technical,
      });
      this.publish();
      return;
    }
    state.health = 'degraded';
    this.publish();
  }

  private isCurrent(name: string, client: Client, generation: number): boolean {
    const state = this.servers.get(name);
    return state?.client === client && state.generation === generation;
  }

  private removePromptsFor(name: string): void {
    for (const [key, entry] of this.promptRegistry) {
      if (entry.server === name) this.promptRegistry.delete(key);
    }
  }
}

async function closeClient(client: Client): Promise<void> {
  try {
    await client.close();
  } catch {
    // best-effort close
  }
}

function isUsableForDiscovery(state: McpServerState): boolean {
  return state.health === 'ready' || state.health === 'degraded' || state.health === 'half_open';
}

function createMcpToolDescriptor(
  serverName: string,
  config: McpServerConfig,
  tool: SdkTool,
): CapabilityDescriptor {
  const resolvedPolicy = resolveMcpToolPolicy(config, tool);
  const schema = compileCapabilitySchema(tool.inputSchema);
  const inputSchema = tool.inputSchema as Record<string, unknown>;
  const withoutRevision: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: `mcp:${serverName}/${tool.name}`,
    kind: 'mcp_tool',
    displayName: tool.name,
    description: tool.description ?? `MCP tool: ${tool.name}`,
    provider: {
      type: 'mcp',
      id: serverName,
      ...(config.providerVersion ? { version: config.providerVersion } : {}),
      provenance: trustedProvenance(config),
    },
    inputSchema,
    ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
    declaredEffects: resolvedPolicy.declaredEffects,
    effectiveEffects: resolvedPolicy.effectiveEffects,
    policy: {
      workspaceTrustRequired: false,
      minimumApproval: resolvedPolicy.minimumApproval,
    },
    execution: {
      retry: resolvedPolicy.retry,
      ...(resolvedPolicy.idempotencyKeyArgument
        ? { idempotencyKeyArgument: resolvedPolicy.idempotencyKeyArgument }
        : {}),
    },
    availability: schema.ok ? 'available' : 'quarantined',
    diagnostics: schema.ok ? [] : [schema.diagnostic],
  };
  return { ...withoutRevision, revision: descriptorRevision(withoutRevision) };
}

function createPassiveDescriptor(
  kind: 'mcp_resource' | 'mcp_prompt',
  serverName: string,
  _config: McpServerConfig,
  value: { name: string; description?: string; uri?: string },
): CapabilityDescriptor {
  const name = value.name ?? value.uri ?? 'unknown';
  const withoutRevision: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: `mcp:${serverName}/${kind}/${name}`,
    kind,
    displayName: name,
    description: value.description ?? name,
    provider: {
      type: 'mcp',
      id: serverName,
      ...(_config.providerVersion ? { version: _config.providerVersion } : {}),
      provenance: 'remote',
    },
    declaredEffects: UNKNOWN_EXTERNAL_EFFECTS,
    effectiveEffects: UNKNOWN_EXTERNAL_EFFECTS,
    policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
    availability: 'available',
    diagnostics: [],
  };
  return { ...withoutRevision, revision: descriptorRevision(withoutRevision) };
}

function trustedProvenance(
  config: McpServerConfig,
): CapabilityDescriptor['provider']['provenance'] {
  return typeof config.trust === 'object' ? config.trust.provenance : 'remote';
}

function safeProviderMetadata(value: string, maximum = 96): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? ' ' : character;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximum);
}

/** Create transport instance from server config */
async function createTransport(
  config: McpServerConfig,
  authProvider: OAuthClientProvider | undefined,
  credentialStore: McpCredentialStore,
) {
  if (config.type === 'http') {
    const url = new URL(config.url ?? 'http://localhost');
    const headers = await resolveHttpHeaders(config, credentialStore);
    return new StreamableHTTPClientTransport(url, {
      authProvider,
      requestInit: headers ? { headers } : undefined,
      reconnectionOptions: {
        maxReconnectionDelay: HTTP_RECONNECT_BASE_MS * 2 ** HTTP_MAX_RECONNECT,
        initialReconnectionDelay: HTTP_RECONNECT_BASE_MS,
        reconnectionDelayGrowFactor: 2,
        maxRetries: HTTP_MAX_RECONNECT,
      },
    });
  }
  // Default: stdio
  return new StdioClientTransport({
    command: config.command ?? '',
    args: config.args ?? [],
    cwd: config.cwd,
    env: {
      ...process.env,
      KITE_CODE_PROJECT_DIR: config.cwd ?? process.cwd(),
      ...config.env,
    } as Record<string, string>,
  });
}

async function resolveHttpHeaders(
  config: McpServerConfig,
  credentialStore: McpCredentialStore,
): Promise<Record<string, string> | undefined> {
  const headers = { ...config.headers };
  const auth = config.auth;
  if (!auth || auth.type === 'none' || auth.type === 'oauth') {
    return Object.keys(headers).length > 0 ? headers : undefined;
  }
  if (auth.type === 'environment') {
    const secret = process.env[auth.env];
    if (!secret) throw new Error('MCP authentication environment variable is unavailable.');
    headers[auth.header] = `${auth.scheme ? `${auth.scheme} ` : ''}${secret}`;
    return headers;
  }
  if (!config.credentialKey) throw new Error('MCP credential reference is unavailable.');
  const material = await credentialStore.get(config.credentialKey);
  if (material?.kind !== 'bearer') {
    throw new Error('MCP credential reference is unavailable.');
  }
  headers[auth.header] = `${auth.scheme ? `${auth.scheme} ` : ''}${material.secret}`;
  return headers;
}

interface OAuthFinishTransport {
  finishAuth(authorizationCode: string): Promise<void>;
}

function isOAuthFinishTransport(transport: unknown): transport is OAuthFinishTransport {
  return (
    !!transport &&
    typeof transport === 'object' &&
    typeof (transport as { finishAuth?: unknown }).finishAuth === 'function'
  );
}
