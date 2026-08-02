// src/core/mcp/manager.ts

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
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
import { compileCapabilitySchema, validateCapabilityArguments } from '@/core/capabilities/schema';
import { canonicalWorkspaceKey } from '@/core/config/mcp-project-approvals';
import type { ProtectedPathEvaluatorV1 } from '@/core/policies/protected-path';
import {
  createNetworkBoundaryFetchV1,
  type NetworkDecisionRecorderV1,
  type NetworkResolverV1,
  type PinnedNetworkRequestV1,
} from '@/core/sandbox/network-enforcer';
import type { NetworkBoundaryPolicyV1 } from '@/core/sandbox/network-policy';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@/protocol/capabilities';
import { type McpCredentialStore, NativeMcpCredentialStore } from './credential-store';
import { diagnoseMcpError } from './diagnostics';
import {
  classifyRemoteMcpArgumentsV1,
  createRemoteMcpEgressReceiptV1,
  inspectRemoteMcpArgumentsV1,
  type McpCapabilityRouteV1,
  RemoteMcpEgressDeniedError,
  RemoteMcpEgressPermitLedgerV1,
  remoteMcpArgumentDigestV1,
  snapshotRemoteMcpArgumentsV1,
} from './egress-permit';
import {
  capabilityChangedProviderError,
  McpProviderError,
  providerErrorFromDiagnostic,
} from './provider-errors';
import type {
  McpCapabilityInvocation,
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
  McpResourceDirectorySnapshot,
} from './runtime-provider';
import { isMcpToolEnabled, resolveMcpToolPolicy } from './tool-policy';
import {
  assertMcpTransportAdmissionReceiptV1,
  canonicalMcpHttpEndpointIdentityV1,
  type McpTransportAdmissionReceiptV1,
  type McpTransportBoundaryControllerV1,
  McpTransportBoundaryErrorV1,
  type McpTransportInvocationBindingV1,
  type McpTransportOperationV1,
} from './transport-boundary';
import type { McpPrompt, McpResource, McpServerConfig, McpServerState } from './types';

const MCP_STARTUP_TIMEOUT = 5000;
const MCP_TOOL_CALL_TIMEOUT = 30_000;
const MCP_RESOURCE_TIMEOUT = 10_000;
const HTTP_MAX_RECONNECT = 5;
const HTTP_RECONNECT_BASE_MS = 1000;
const MCP_CIRCUIT_FAILURE_THRESHOLD = 3;
const MCP_CIRCUIT_OPEN_MS = 30_000;

function isPathLikeExecutable(command: string | undefined): command is string {
  return (
    typeof command === 'string' &&
    (isAbsolute(command) || /^[a-zA-Z]:[\\/]/.test(command) || /[\\/]/.test(command))
  );
}

function providerIdFromCapability(capabilityId: string): string {
  return capabilityId.match(/^mcp:([^/]+)\//u)?.[1] ?? 'unknown';
}

function transportEndpointRevision(serverIdentity: string, config: McpServerConfig): string {
  return (
    config.providerVersion ??
    digestCapability({
      serverIdentity,
      config,
    })
  );
}

/** Prompt registry entry: maps slash command key to server info */
export interface PromptEntry {
  server: string;
  prompt: McpPrompt;
}

export interface McpConnectionManagerOptions {
  createClient?: () => Client;
  createTransport?: (
    config: McpServerConfig,
    authProvider?: OAuthClientProvider,
  ) => Parameters<Client['connect']>[0] | Promise<Parameters<Client['connect']>[0]>;
  credentialStore?: McpCredentialStore;
  /** Production supervisors enable this; direct manager users remain an internal compatibility API. */
  remoteMcpEgressPolicyRequired?: boolean;
  remoteMcpEgressPermitLedger?: RemoteMcpEgressPermitLedgerV1;
  /** Shared release boundary for local stdio process working directories. */
  protectedPathEvaluator?: ProtectedPathEvaluatorV1;
  /** Sealed execution profiles require a per-operation transport admission controller. */
  transportBoundaryRequired?: boolean;
  transportBoundary?: McpTransportBoundaryControllerV1;
  /** Release-derived policy used by the built-in pinned HTTP transport. */
  transportNetworkPolicy?: NetworkBoundaryPolicyV1;
  transportNetworkResolver?: NetworkResolverV1;
  transportRecordNetworkDecision?: NetworkDecisionRecorderV1;
  /** Test-only pinned request adapter; production omits it for the native implementation. */
  transportPinnedRequest?: PinnedNetworkRequestV1;
}

/**
 * Manages multiple MCP server connections, tool aggregation, and prompt registry.
 */
export class McpConnectionManager {
  private readonly createClient: () => Client;
  private readonly createManagerTransport: (
    config: McpServerConfig,
    authProvider?: OAuthClientProvider,
  ) => Parameters<Client['connect']>[0] | Promise<Parameters<Client['connect']>[0]>;
  private readonly remoteMcpEgressPolicyRequired: boolean;
  private readonly remoteMcpEgressPermitLedger: RemoteMcpEgressPermitLedgerV1;
  private readonly protectedPathEvaluator: ProtectedPathEvaluatorV1 | undefined;
  private readonly transportBoundaryRequired: boolean;
  private readonly transportBoundary: McpTransportBoundaryControllerV1 | undefined;
  private readonly credentialStore: McpCredentialStore;
  private readonly transportNetworkPolicy: NetworkBoundaryPolicyV1 | undefined;
  private readonly transportNetworkResolver: NetworkResolverV1 | undefined;
  private readonly transportRecordNetworkDecision: NetworkDecisionRecorderV1 | undefined;
  private readonly transportPinnedRequest: PinnedNetworkRequestV1 | undefined;
  private readonly transportHttpContext = new AsyncLocalStorage<McpTransportAdmissionReceiptV1>();
  private servers = new Map<string, McpServerState>();
  private promptRegistry = new Map<string, PromptEntry>();
  private snapshot: CapabilitySnapshot = createSnapshot([]);
  private retainedDescriptors = new Map<string, readonly CapabilityDescriptor[]>();
  private retainedResources = new Map<string, readonly McpResource[]>();
  private listeners = new Set<() => void>();
  private oauthProviders = new Map<string, OAuthClientProvider>();
  private oauthTransports = new Map<
    string,
    { generation: number; transport: OAuthFinishTransport }
  >();

  constructor(options: McpConnectionManagerOptions = {}) {
    this.createClient =
      options.createClient ??
      (() => new Client({ name: 'kite-code', version: '0.1.0' }, { capabilities: {} }));
    const credentialStore = options.credentialStore ?? new NativeMcpCredentialStore();
    this.credentialStore = credentialStore;
    this.createManagerTransport =
      options.createTransport ??
      ((config, authProvider) => createTransport(config, authProvider, credentialStore));
    this.remoteMcpEgressPolicyRequired = options.remoteMcpEgressPolicyRequired === true;
    this.remoteMcpEgressPermitLedger =
      options.remoteMcpEgressPermitLedger ?? new RemoteMcpEgressPermitLedgerV1();
    this.protectedPathEvaluator = options.protectedPathEvaluator;
    this.transportBoundaryRequired = options.transportBoundaryRequired === true;
    this.transportBoundary = options.transportBoundary;
    this.transportNetworkPolicy = options.transportNetworkPolicy;
    this.transportNetworkResolver = options.transportNetworkResolver;
    this.transportRecordNetworkDecision = options.transportRecordNetworkDecision;
    this.transportPinnedRequest = options.transportPinnedRequest;
  }

  assertTransportBoundaryWorkspace(workspace: string): void {
    if (!this.transportBoundaryRequired) return;
    const expected = canonicalWorkspaceKey(workspace);
    if (!this.transportBoundary || this.transportBoundary.identity.workspaceKey !== expected) {
      throw new McpTransportBoundaryErrorV1(
        this.transportBoundary ? 'workspace_mismatch' : 'boundary_unavailable',
        'MCP transport boundary does not match the canonical Workspace.',
      );
    }
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
  async connect(
    name: string,
    config: McpServerConfig,
    generation = 0,
    timeoutMs = MCP_STARTUP_TIMEOUT,
  ): Promise<void> {
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
    let connectAdmission: McpTransportAdmissionReceiptV1 | undefined;
    try {
      let transportConfig = config;
      if (config.type === 'stdio' && this.protectedPathEvaluator) {
        const cwdDecision = this.protectedPathEvaluator.evaluate({
          path: config.cwd ?? this.protectedPathEvaluator.workspaceRoot,
          operation: 'execute',
        });
        if (cwdDecision.outcome !== 'allow' || !cwdDecision.canonicalPath) {
          throw new Error(
            `Rejected local stdio MCP working directory by protected-path policy (${cwdDecision.reason}).`,
          );
        }
        let admittedCommand = config.command;
        if (isPathLikeExecutable(config.command)) {
          const commandDecision = this.protectedPathEvaluator.evaluate({
            path: resolve(cwdDecision.canonicalPath, config.command!),
            operation: 'execute',
          });
          if (commandDecision.outcome !== 'allow' || !commandDecision.canonicalPath) {
            throw new Error(
              `Rejected local stdio MCP executable by protected-path policy (${commandDecision.reason}).`,
            );
          }
          admittedCommand = commandDecision.canonicalPath;
        }
        if ((config.args?.length ?? 0) > 0) {
          throw new Error(
            'Rejected local stdio MCP arguments by protected-path policy; sealed argv pinning requires Task 1B.8.',
          );
        }
        transportConfig = { ...config, cwd: cwdDecision.canonicalPath, command: admittedCommand };
      }
      initialState.config = transportConfig;
      const endpointRevision = transportEndpointRevision(name, transportConfig);
      connectAdmission = await this.admitTransport(name, transportConfig, 'connect', {
        boundaryIdentityDigest: this.transportBoundary?.identity.identityDigest ?? '',
        invocationId: randomUUID(),
        toolCallId: `mcp-connect:${name}`,
        endpointRevision,
      });
      transport = connectAdmission
        ? await this.createRequiredHttpTransport(transportConfig, this.oauthProviders.get(name))
        : await this.createManagerTransport(transportConfig, this.oauthProviders.get(name));
      if (connectAdmission) {
        initialState.transportBoundary = {
          identityDigest: connectAdmission.boundaryIdentityDigest,
          endpointRevision: connectAdmission.endpointRevision,
        };
      }
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
      await this.withTransportReceipt(connectAdmission, () =>
        client.connect(transport, {
          timeout: Math.max(1, Math.min(MCP_STARTUP_TIMEOUT, timeoutMs)),
        }),
      );
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
      const admission = await this.admitInternalTransport(name, initialState.config, 'tool_list');
      if (!this.isCurrent(name, client, generation)) {
        await closeClient(client);
        return;
      }
      const result = await this.withTransportReceipt(admission, () => client.listTools());
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
      const admission = await this.admitInternalTransport(name, initialState.config, 'prompt_list');
      if (!this.isCurrent(name, client, generation)) {
        await closeClient(client);
        return;
      }
      const result = await this.withTransportReceipt(admission, () => client.listPrompts());
      prompts = (result.prompts ?? []) as McpPrompt[];
    } catch {
      // prompts are optional
    }

    // Fetch resources (optional)
    let resources: McpResource[] = [];
    try {
      const admission = await this.admitInternalTransport(
        name,
        initialState.config,
        'resource_list',
      );
      if (!this.isCurrent(name, client, generation)) {
        await closeClient(client);
        return;
      }
      const resourceResult = await this.withTransportReceipt(admission, () =>
        client.listResources(),
      );
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
          if (!this.isCurrent(name, client, generation)) return;
          const admission = await this.admitInternalTransport(
            name,
            initialState.config,
            'tool_list',
          );
          if (!this.isCurrent(name, client, generation)) return;
          const result = await this.withTransportReceipt(admission, () => client.listTools());
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
          if (!this.isCurrent(name, client, generation)) return;
          const admission = await this.admitInternalTransport(
            name,
            initialState.config,
            'prompt_list',
          );
          if (!this.isCurrent(name, client, generation)) return;
          const result = await this.withTransportReceipt(admission, () => client.listPrompts());
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
            const admission = await this.admitInternalTransport(
              name,
              initialState.config,
              'resource_list',
            );
            if (!this.isCurrent(name, client, generation)) return;
            const result = await this.withTransportReceipt(admission, () => client.listResources());
            state.resources = (result.resources ?? []) as McpResource[];
            if (state.health !== 'circuit_open') state.health = 'ready';
            state.diagnostic = undefined;
            this.publish();
          } catch (err) {
            if (state.health !== 'circuit_open') state.health = 'degraded';
            state.diagnostic = diagnoseMcpError(err, { phase: 'discovery' });
            this.publish();
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
  async reconnect(
    name: string,
    config: McpServerConfig,
    generation: number,
    timeoutMs?: number,
  ): Promise<void> {
    await this.disconnect(name, { retainCapabilities: true });
    await this.connect(name, config, generation, timeoutMs);
  }

  /** Begin an explicit user-authorized OAuth attempt without opening a browser in Core. */
  async beginOAuth(
    name: string,
    config: McpServerConfig,
    generation: number,
    provider: OAuthClientProvider,
  ): Promise<'authorization_required' | 'connected'> {
    if (config.type !== 'http') throw new Error('OAuth is supported only for HTTP MCP servers.');
    await this.disconnect(name, { retainCapabilities: true });
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
    const admission = await this.admitInternalTransport(name, state.config, 'oauth_finish');
    if (
      this.oauthTransports.get(name)?.transport !== session.transport ||
      this.servers.get(name) !== state
    ) {
      throw new McpTransportBoundaryErrorV1(
        'boundary_identity_mismatch',
        'OAuth transport changed during boundary admission.',
      );
    }
    await this.withTransportReceipt(admission, () =>
      session.transport.finishAuth(authorizationCode),
    );
    await this.reconnect(name, state.config, generation);
  }

  /** Clear in-memory auth session state. Persistent credential deletion belongs to the coordinator. */
  async clearOAuth(name: string): Promise<void> {
    this.oauthProviders.delete(name);
    this.oauthTransports.delete(name);
    await this.disconnect(name, { retainCapabilities: true });
  }

  /** Invalidate future bindings before best-effort transport shutdown. */
  async disconnect(name: string, options: { retainCapabilities?: boolean } = {}): Promise<void> {
    const state = this.servers.get(name);
    if (!state) return;
    this.servers.delete(name);
    this.oauthTransports.delete(name);
    this.removePromptsFor(name);
    if (!options.retainCapabilities) this.retainedDescriptors.delete(name);
    if (!options.retainCapabilities) this.retainedResources.delete(name);
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

  getCapabilityRoute(capabilityId: string): McpCapabilityRouteV1 | undefined {
    const descriptor = this.findCapability(capabilityId);
    if (descriptor?.kind !== 'mcp_tool') return undefined;
    const server = descriptor.provider.id;
    const state = this.servers.get(server);
    if (!state) return undefined;
    return Object.freeze({
      transport: state.config.type,
      serverIdentity: server,
      endpointRevision: transportEndpointRevision(server, state.config),
      toolRevision: descriptor.revision,
    });
  }

  /** Execute exactly one revision-checked MCP capability invocation. */
  async callCapability(invocation: McpCapabilityInvocation): Promise<CallToolResult> {
    const descriptor = this.findCapability(invocation.capabilityId);
    if (
      descriptor?.kind !== 'mcp_tool' ||
      descriptor.availability !== 'available' ||
      descriptor.revision !== invocation.expectedRevision ||
      !descriptor.inputSchema
    ) {
      const providerId =
        descriptor?.provider.id ?? providerIdFromCapability(invocation.capabilityId);
      throw capabilityChangedProviderError(providerId);
    }
    const server = descriptor.provider.id;
    const toolName = descriptor.displayName;
    const state = this.servers.get(server);
    if (!state) {
      throw providerErrorFromDiagnostic(server, undefined);
    }
    const route = this.getCapabilityRoute(invocation.capabilityId);
    const argumentSnapshot = snapshotRemoteMcpArgumentsV1(invocation.arguments);
    const governedRemoteHttp =
      route?.transport === 'http' &&
      (this.remoteMcpEgressPolicyRequired || invocation.remoteEgress);
    if (!argumentSnapshot.ok && !governedRemoteHttp) {
      throw new McpProviderError({
        providerId: descriptor.provider.id,
        kind: 'provider_capability_changed',
        message: 'MCP arguments must be a bounded JSON-safe object without custom serialization.',
        retryable: false,
      });
    }
    const args = argumentSnapshot.ok ? argumentSnapshot.arguments : Object.freeze({});
    if (argumentSnapshot.ok) {
      const argumentError = validateCapabilityArguments(descriptor.inputSchema, args);
      if (argumentError) {
        throw new McpProviderError({
          providerId: descriptor.provider.id,
          kind: 'provider_capability_changed',
          message: argumentError,
          retryable: false,
        });
      }
    }
    if (governedRemoteHttp) {
      const policy = invocation.remoteEgress;
      const content = argumentSnapshot.ok
        ? classifyRemoteMcpArgumentsV1(args)
        : Object.freeze({
            dataClassifications: Object.freeze(['confidential'] as const),
            payloadKinds: Object.freeze(['user_prompt', 'file_snippet', 'tool_result'] as const),
          });
      const request = {
        ...route,
        invocationId:
          policy?.invocationId ??
          digestCapability({
            capabilityId: invocation.capabilityId,
            expectedRevision: invocation.expectedRevision,
            arguments: argumentSnapshot.ok ? args : { invalidArgumentShape: true },
          }),
        toolCallId: policy?.toolCallId ?? 'unscoped-runtime-call',
        argumentDigest: remoteMcpArgumentDigestV1(
          argumentSnapshot.ok ? args : { invalidArgumentShape: true },
        ),
        content,
      };
      if (!policy?.recordDecision) {
        throw new RemoteMcpEgressDeniedError(
          createRemoteMcpEgressReceiptV1({
            enabled: policy?.enabled === true,
            request,
            permit: policy?.permit,
            reason: 'receipt_persistence_failed',
          }),
        );
      }
      const contentInspection = argumentSnapshot.ok ? inspectRemoteMcpArgumentsV1(args) : 'unknown';
      const receipt =
        contentInspection === 'clear'
          ? this.remoteMcpEgressPermitLedger.consume({
              enabled: policy?.enabled === true,
              request,
              permit: policy?.permit,
            })
          : createRemoteMcpEgressReceiptV1({
              enabled: policy?.enabled === true,
              request,
              permit: policy?.permit,
              reason:
                contentInspection === 'secret' ? 'secret_detected' : 'content_inspection_unknown',
            });
      try {
        await policy.recordDecision(receipt);
      } catch (error) {
        if (error instanceof RemoteMcpEgressDeniedError) throw error;
        throw new RemoteMcpEgressDeniedError(
          createRemoteMcpEgressReceiptV1({
            enabled: policy?.enabled === true,
            request,
            permit: policy?.permit,
            reason: 'receipt_persistence_failed',
          }),
        );
      }
      if (!receipt.admitted) throw new RemoteMcpEgressDeniedError(receipt);
    }
    if (!argumentSnapshot.ok) {
      throw new McpProviderError({
        providerId: descriptor.provider.id,
        kind: 'provider_capability_changed',
        message: 'MCP arguments must be a bounded JSON-safe object without custom serialization.',
        retryable: false,
      });
    }
    this.assertCallable(state, server);
    const discoveredTool = state.tools.find((tool) => tool.name === toolName);
    if (!discoveredTool || discoveredTool.name !== toolName) {
      throw capabilityChangedProviderError(server);
    }
    const client = state.client as Client;
    const transportAdmission = await this.admitTransport(
      server,
      state.config,
      'tool_call',
      invocation.transportBoundary,
    );
    if (!this.isCurrent(server, client, state.generation)) {
      throw capabilityChangedProviderError(server);
    }
    try {
      const result = (await this.withTransportReceipt(transportAdmission, () =>
        client.callTool({ name: toolName, arguments: args }, undefined, {
          timeout: state.config.timeout ?? MCP_TOOL_CALL_TIMEOUT,
          signal: invocation.signal,
        }),
      )) as CallToolResult;
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

  /**
   * Internal control-plane/test convenience. Runtime callers must use the
   * revision-bearing callCapability contract exposed by the Supervisor façade.
   */
  async callTool(
    server: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const descriptor = this.findCapability(`mcp:${server}/${toolName}`);
    if (!descriptor) throw capabilityChangedProviderError(server);
    return this.callCapability({
      capabilityId: descriptor.capabilityId,
      expectedRevision: descriptor.revision,
      arguments: args,
      signal,
    });
  }

  /** 列出指定 server 的所有资源（从缓存） / List resources for a server (from cache) */
  getResources(serverName: string): McpResource[] {
    return this.servers.get(serverName)?.resources ?? [];
  }

  getResourceDirectorySnapshot(): McpResourceDirectorySnapshot {
    const resources = [...this.retainedResources]
      .flatMap(([providerId, entries]) =>
        entries.map((resource) => ({
          providerId,
          uri: resource.uri,
          name: resource.name || resource.uri,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        })),
      )
      .sort(
        (left, right) =>
          left.providerId.localeCompare(right.providerId) ||
          left.uri.localeCompare(right.uri) ||
          left.name.localeCompare(right.name),
      );
    return Object.freeze({
      revision: digestCapability(resources),
      resources: Object.freeze(resources.map((resource) => Object.freeze(resource))),
    });
  }

  /** 从指定 server 读取资源内容 / Read resource content from a server */
  async readResource(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
    transportBoundary?: McpTransportInvocationBindingV1,
  ): Promise<string> {
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
    if (!state.resources.some((resource) => resource.uri === uri)) {
      throw new Error(`MCP resource URI is not present in the current discovery snapshot: ${uri}`);
    }
    const client = state.client as Client;
    const transportAdmission = await this.admitTransport(
      serverName,
      state.config,
      'resource_read',
      transportBoundary,
    );
    if (!this.isCurrent(serverName, client, state.generation)) {
      throw capabilityChangedProviderError(serverName);
    }
    try {
      const result = await this.withTransportReceipt(transportAdmission, () =>
        client.readResource(
          { uri },
          { timeout: state.config.timeout ?? MCP_RESOURCE_TIMEOUT, signal },
        ),
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
    this.retainedDescriptors.clear();
    this.retainedResources.clear();
    this.publish();
    await Promise.allSettled(clients.map(closeClient));
  }

  private async createRequiredHttpTransport(
    config: McpServerConfig,
    authProvider?: OAuthClientProvider,
  ): Promise<Parameters<Client['connect']>[0]> {
    if (
      config.type !== 'http' ||
      !this.transportNetworkPolicy ||
      !this.transportRecordNetworkDecision
    ) {
      throw new McpTransportBoundaryErrorV1(
        'boundary_unavailable',
        'The pinned MCP HTTP transport boundary is unavailable.',
      );
    }
    if (
      this.transportNetworkPolicy.mode !== 'allowlist' ||
      this.transportNetworkPolicy.revision !==
        this.transportBoundary?.identity.networkPolicyRevision
    ) {
      throw new McpTransportBoundaryErrorV1(
        'boundary_identity_mismatch',
        'The MCP HTTP network policy does not match the admitted execution boundary.',
      );
    }
    const networkPolicy = this.transportNetworkPolicy;
    const recordNetworkDecision = this.transportRecordNetworkDecision;
    const boundaryFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const receipt = this.transportHttpContext.getStore();
      if (!receipt) {
        throw new McpTransportBoundaryErrorV1(
          'invocation_identity_missing',
          'An MCP HTTP request escaped its admitted invocation context.',
        );
      }
      return createNetworkBoundaryFetchV1(networkPolicy, {
        resolver: this.transportNetworkResolver,
        recordDecision: recordNetworkDecision,
        toolCallId: receipt.toolCallId,
        invocationIdFactory: () => receipt.invocationId,
        request: this.transportPinnedRequest,
      })(input, init);
    }) as typeof fetch;
    return createTransport(config, authProvider, this.credentialStore, boundaryFetch);
  }

  private async admitTransport(
    serverIdentity: string,
    config: McpServerConfig,
    operation: McpTransportOperationV1,
    binding: McpTransportInvocationBindingV1 | undefined,
  ): Promise<McpTransportAdmissionReceiptV1 | undefined> {
    if (!this.transportBoundaryRequired && !this.transportBoundary) return undefined;
    const boundary = this.transportBoundary;
    if (!boundary) {
      throw new McpTransportBoundaryErrorV1(
        'boundary_unavailable',
        'MCP transport admission controller is unavailable.',
      );
    }
    if (config.type === 'stdio' || !boundary.identity.remoteHttpMcp) {
      throw new McpTransportBoundaryErrorV1(
        'transport_denied',
        config.type === 'stdio'
          ? 'Local stdio MCP remains excluded until a sandbox-backed transport is available.'
          : 'MCP HTTP transport is denied by the execution surface.',
      );
    }
    if (!binding) {
      throw new McpTransportBoundaryErrorV1(
        'invocation_identity_missing',
        'MCP transport invocation identity is missing.',
      );
    }
    const endpointRevision = transportEndpointRevision(serverIdentity, config);
    const endpointIdentity = canonicalMcpHttpEndpointIdentityV1(config);
    if (
      !binding.boundaryIdentityDigest.trim() ||
      !binding.invocationId.trim() ||
      !binding.toolCallId.trim() ||
      !binding.endpointRevision.trim()
    ) {
      throw new McpTransportBoundaryErrorV1(
        'invocation_identity_missing',
        'MCP transport invocation identity is incomplete.',
      );
    }
    if (binding.boundaryIdentityDigest !== boundary.identity.identityDigest) {
      throw new McpTransportBoundaryErrorV1(
        'boundary_identity_mismatch',
        'MCP transport invocation belongs to a different execution boundary.',
      );
    }
    if (binding.endpointRevision !== endpointRevision) {
      throw new McpTransportBoundaryErrorV1(
        'endpoint_revision_mismatch',
        'MCP transport endpoint revision changed before dispatch.',
      );
    }
    if (operation !== 'connect') {
      const active = this.servers.get(serverIdentity)?.transportBoundary;
      if (
        active?.identityDigest !== boundary.identity.identityDigest ||
        active.endpointRevision !== endpointRevision
      ) {
        throw new McpTransportBoundaryErrorV1(
          'boundary_identity_mismatch',
          'The active MCP transport was not created for this execution boundary.',
        );
      }
    }
    const request = Object.freeze({
      version: 1 as const,
      operation,
      transport: config.type,
      serverIdentity,
      workspaceKey: boundary.identity.workspaceKey,
      executionBoundaryRevision: boundary.identity.executionBoundaryRevision,
      runIdentity: boundary.identity.runIdentity,
      profileIdentity: boundary.identity.profileIdentity,
      networkPolicyRevision: boundary.identity.networkPolicyRevision,
      ...endpointIdentity,
      ...binding,
    });
    const receipt = await boundary.admit(request);
    assertMcpTransportAdmissionReceiptV1(request, receipt);
    return receipt;
  }

  private async admitInternalTransport(
    serverIdentity: string,
    config: McpServerConfig,
    operation: Exclude<McpTransportOperationV1, 'connect' | 'tool_call' | 'resource_read'>,
  ): Promise<McpTransportAdmissionReceiptV1 | undefined> {
    if (!this.transportBoundaryRequired && !this.transportBoundary) return undefined;
    const invocationId = randomUUID();
    return this.admitTransport(serverIdentity, config, operation, {
      boundaryIdentityDigest: this.transportBoundary?.identity.identityDigest ?? '',
      invocationId,
      toolCallId: `mcp-${operation}:${serverIdentity}:${invocationId}`,
      endpointRevision: transportEndpointRevision(serverIdentity, config),
    });
  }

  private async withTransportReceipt<T>(
    receipt: McpTransportAdmissionReceiptV1 | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    return receipt ? this.transportHttpContext.run(receipt, operation) : operation();
  }

  private publish(): void {
    const descriptors: CapabilityDescriptor[] = [];
    const projectedProviders = new Set<string>();
    for (const [serverName, state] of this.servers) {
      projectedProviders.add(serverName);
      if (isUsableForDiscovery(state)) {
        const current: CapabilityDescriptor[] = [];
        for (const tool of state.tools) {
          if (!isMcpToolEnabled(state.config, tool.name)) continue;
          const descriptor = createMcpToolDescriptor(serverName, state.config, tool);
          if (descriptor.availability === 'available') current.push(descriptor);
        }
        for (const resource of state.resources) {
          current.push(createPassiveDescriptor('mcp_resource', serverName, state.config, resource));
        }
        for (const prompt of state.prompts) {
          current.push(createPassiveDescriptor('mcp_prompt', serverName, state.config, prompt));
        }
        if (state.health === 'ready' || current.length > 0) {
          this.retainedDescriptors.set(serverName, Object.freeze(current));
          this.retainedResources.set(
            serverName,
            Object.freeze(state.resources.map((resource) => Object.freeze({ ...resource }))),
          );
        }
      }
      descriptors.push(...(this.retainedDescriptors.get(serverName) ?? []));
    }
    for (const [serverName, retained] of this.retainedDescriptors) {
      if (!projectedProviders.has(serverName)) descriptors.push(...retained);
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
  boundaryFetch?: typeof fetch,
) {
  if (config.type === 'http') {
    const url = new URL(config.url ?? 'http://localhost');
    const headers = await resolveHttpHeaders(config, credentialStore);
    return new StreamableHTTPClientTransport(url, {
      authProvider,
      fetch: boundaryFetch,
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
