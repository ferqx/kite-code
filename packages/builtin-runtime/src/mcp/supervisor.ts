import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { CallToolResult, Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import {
  DefaultMcpAuthCoordinator,
  type McpAuthCoordinator,
  type McpAuthResult,
  type McpAuthSnapshot,
} from './auth-coordinator';
import {
  type CapabilitySnapshot,
  compileCapabilitySchema,
  digestCapability,
} from './capability-domain';
import type {
  McpConfigCatalog,
  McpConfigCommand,
  McpConfigRepository,
  McpServerConfigEntry,
} from './config-domain';
import type {
  McpConfigStatus,
  McpControlSnapshot,
  McpServerControlState,
  McpServerKey,
  McpToolControlState,
} from './control-types';
import {
  type BuiltinCredentialBrokerV1,
  createBuiltinCredentialBrokerV1,
} from './credential-broker';
import type { McpCredentialStore } from './credential-store';
import type { McpDiagnostic } from './diagnostics';
import { McpConnectionManager, type McpConnectionManagerOptions } from './manager';
import { canonicalWorkspaceKeyV1 } from './mechanism-ports';
import { revokeMcpOAuthToken } from './oauth-revocation';
import { McpProviderError, providerErrorFromDiagnostic } from './provider-errors';
import type {
  McpCapabilityInvocation,
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
  McpProviderDirectoryStatus,
  McpResourceDirectorySnapshot,
  McpRuntimeProvider,
} from './runtime-provider';
import {
  configuredMcpToolNames,
  hasConfiguredMcpToolPolicy,
  resolveMcpToolPolicy,
} from './tool-policy';
import type { McpTransportInvocationBindingV1 } from './transport-boundary';
import type { McpServerConfig, McpServerState } from './types';

const EMPTY_SNAPSHOT: McpControlSnapshot = Object.freeze({
  revision: digestCapability([]),
  generation: 0,
  servers: Object.freeze([]),
  sourceRevisions: Object.freeze({ local: '', project: '', user: '' }),
});

export interface McpSupervisor {
  start(workspace: string): Promise<void>;
  stop(): Promise<void>;
  reload(): Promise<void>;
  retry(key: McpServerKey): Promise<void>;
  mutate(command: McpConfigCommand): Promise<void>;
  remove(
    key: McpServerKey,
    expectedRevision: string,
  ): Promise<{
    credentialCleanup: 'not_needed' | 'completed' | 'failed';
  }>;
  login(key: McpServerKey): Promise<McpAuthResult>;
  cancelAuth(flowId: string): Promise<McpAuthResult>;
  logout(key: McpServerKey, revoke: boolean): Promise<McpAuthResult>;
  getSnapshot(): McpControlSnapshot;
  subscribe(listener: () => void): () => void;
  getRuntimeProvider(): McpRuntimeProvider;
}

export interface McpConnectionManagerControlPlane {
  subscribe(listener: () => void): () => void;
  reconnect(
    name: string,
    config: McpServerConfig,
    generation: number,
    timeoutMs?: number,
  ): Promise<void>;
  disconnect(name: string, options?: { retainCapabilities?: boolean }): Promise<void>;
  disconnectAll(): Promise<void>;
  getServerStates(): ReadonlyMap<string, Readonly<McpServerState>>;
  getCapabilitySnapshot(): CapabilitySnapshot;
  getProviderDirectorySnapshot(): McpProviderDirectorySnapshot;
  getResourceDirectorySnapshot(): McpResourceDirectorySnapshot;
  findCapability(
    capabilityId: string,
  ): import('./capability-domain').CapabilityDescriptor | undefined;
  getCapabilityRoute?(
    capabilityId: string,
  ): import('./egress-permit').McpCapabilityRouteV1 | undefined;
  assertTransportBoundaryWorkspace?(workspace: string): void;
  callCapability(invocation: McpCapabilityInvocation): Promise<CallToolResult>;
  readResource(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
    transportBoundary?: McpTransportInvocationBindingV1,
  ): Promise<string>;
  beginOAuth?(
    name: string,
    config: McpServerConfig,
    generation: number,
    provider: OAuthClientProvider,
  ): Promise<'authorization_required' | 'connected'>;
  finishOAuth?(name: string, authorizationCode: string, generation: number): Promise<void>;
  clearOAuth?(name: string): Promise<void>;
}

export interface McpSupervisorOptions {
  manager?: McpConnectionManagerControlPlane;
  connectionManagerOptions?: Omit<McpConnectionManagerOptions, 'credentialBroker'>;
  /** One Builtin credential authority shared by Manager and AuthCoordinator. */
  credentialBroker?: BuiltinCredentialBrokerV1;
  /** Test-only mechanism injected into the sole Supervisor-owned broker. */
  credentialStore?: McpCredentialStore;
  repository?: McpConfigRepository;
  authCoordinator?: McpAuthCoordinator;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export class DefaultMcpSupervisor implements McpSupervisor, McpRuntimeProvider {
  private readonly manager: McpConnectionManagerControlPlane;
  private readonly repository: McpConfigRepository;
  private readonly authCoordinator: McpAuthCoordinator;
  private readonly credentialBroker: BuiltinCredentialBrokerV1;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private readonly listeners = new Set<() => void>();
  private snapshot = EMPTY_SNAPSHOT;
  private catalog: McpConfigCatalog | undefined;
  private workspace: string | undefined;
  private managerUnsubscribe: (() => void) | undefined;
  private configUnsubscribe: (() => void) | undefined;
  private authUnsubscribe: (() => void) | undefined;
  private generation = 0;
  private started = false;
  private reconcileChain: Promise<void> = Promise.resolve();
  private readonly providerRecoveryChains = new Map<string, Promise<void>>();
  private readonly lastKnownCapabilityNames = new Map<string, readonly string[]>();

  constructor(options: McpSupervisorOptions) {
    const credentialBroker =
      options.credentialBroker ??
      createBuiltinCredentialBrokerV1({
        store: options.credentialStore,
      });
    this.credentialBroker = credentialBroker;
    this.manager =
      options.manager ??
      new McpConnectionManager({
        ...options.connectionManagerOptions,
        credentialBroker,
      });
    if (!options.repository) {
      throw new Error('MCP config repository must be composed by the application bootstrap.');
    }
    this.repository = options.repository;
    this.authCoordinator =
      options.authCoordinator ?? new DefaultMcpAuthCoordinator({ credentialBroker });
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? Date.now;
  }

  async start(workspace: string): Promise<void> {
    if (this.started && this.workspace === workspace) return;
    if (this.started) await this.stop();
    this.manager.assertTransportBoundaryWorkspace?.(workspace);
    this.started = true;
    this.workspace = workspace;
    this.generation += 1;
    this.managerUnsubscribe = this.manager.subscribe(() => this.projectSnapshot());
    this.authUnsubscribe = this.authCoordinator.subscribe(() => this.projectSnapshot());
    this.catalog = await this.repository.load(workspace);
    await this.registerAuthTargets(this.catalog);
    this.configUnsubscribe = this.repository.watch(workspace, () => {
      void this.reload().catch(() => {
        // Manual reload and the next file event can retry an unavailable source.
      });
    });
    this.projectSnapshot();
    this.connectCatalog(this.catalog, this.generation);
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    this.managerUnsubscribe?.();
    this.managerUnsubscribe = undefined;
    this.authUnsubscribe?.();
    this.authUnsubscribe = undefined;
    this.configUnsubscribe?.();
    this.configUnsubscribe = undefined;
    this.catalog = undefined;
    this.workspace = undefined;
    this.lastKnownCapabilityNames.clear();
    this.setSnapshot(
      Object.freeze({
        revision: digestCapability({ generation: this.generation, servers: [] }),
        generation: this.generation,
        servers: Object.freeze([]),
        sourceRevisions: Object.freeze({ local: '', project: '', user: '' }),
      }),
    );
    await this.manager.disconnectAll();
  }

  async reload(): Promise<void> {
    if (!this.started || !this.workspace) return;
    await this.enqueue(async () => {
      if (!this.started || !this.workspace) return;
      await this.reconcile(await this.repository.load(this.workspace));
    });
  }

  async retry(key: McpServerKey): Promise<void> {
    if (!this.started || !this.workspace) return;
    await this.enqueue(async () => {
      if (!this.started || !this.workspace) return;
      await this.reconcile(await this.repository.load(this.workspace));
      const catalog = this.catalog;
      if (!catalog) return;
      this.generation += 1;
      const entry = catalog.entries.find(
        (candidate) =>
          candidate.effective &&
          candidate.name === key.name &&
          candidate.source.kind === key.source,
      );
      const config = catalog.connectableServers[key.name];
      if (!entry || !config) {
        await this.manager.disconnect(key.name);
        this.projectSnapshot();
        return;
      }
      this.projectSnapshot();
      try {
        await this.connectServer(entry, config, this.generation);
      } catch {
        // Manager publishes the typed failure state. A single provider never rejects the supervisor.
      }
    });
  }

  async mutate(command: McpConfigCommand): Promise<void> {
    if (!this.started) return;
    await this.enqueue(async () => {
      if (!this.started) return;
      await this.reconcile(await this.repository.mutate(command));
    });
  }

  async remove(
    key: McpServerKey,
    expectedRevision: string,
  ): Promise<{ credentialCleanup: 'not_needed' | 'completed' | 'failed' }> {
    if (!this.started) return { credentialCleanup: 'not_needed' };
    return this.enqueue(async () => {
      const current = this.snapshot.servers.find(
        (candidate) => candidate.key.name === key.name && candidate.key.source === key.source,
      );
      const nextCatalog = await this.repository.mutate({
        type: 'remove',
        key,
        expectedRevision,
      });
      let credentialCleanup: 'not_needed' | 'completed' | 'failed' = 'not_needed';
      if (current?.credentialPresent) {
        try {
          await this.authCoordinator.logout(key, false);
          credentialCleanup = 'completed';
        } catch {
          credentialCleanup = 'failed';
        }
      }
      await this.reconcile(nextCatalog);
      return { credentialCleanup };
    });
  }

  async login(key: McpServerKey): Promise<McpAuthResult> {
    return this.authCoordinator.login(key);
  }

  async cancelAuth(flowId: string): Promise<McpAuthResult> {
    return this.authCoordinator.cancel(flowId);
  }

  async logout(key: McpServerKey, revoke: boolean): Promise<McpAuthResult> {
    return this.authCoordinator.logout(key, revoke);
  }

  getSnapshot(): McpControlSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRuntimeProvider(): McpRuntimeProvider {
    return this;
  }

  getCapabilitySnapshot(): CapabilitySnapshot {
    return this.manager.getCapabilitySnapshot();
  }

  getProviderDirectorySnapshot(): McpProviderDirectorySnapshot {
    const entries = this.snapshot.servers
      .filter((server) => server.effective)
      .map(
        (server): Readonly<McpProviderDirectoryEntry> =>
          Object.freeze({
            providerId: server.key.name,
            status: providerDirectoryStatus(server),
            required: server.required,
            source: server.source,
            lastKnownCapabilityNames: Object.freeze([
              ...(this.lastKnownCapabilityNames.get(server.key.name) ?? []),
            ]),
            ...(server.diagnostic ? { diagnosticCode: server.diagnostic.code } : {}),
            retryable: server.diagnostic?.retryable ?? false,
          }),
      )
      .sort((left, right) => left.providerId.localeCompare(right.providerId));
    return Object.freeze({
      revision: digestCapability(entries),
      entries: Object.freeze(entries),
    });
  }

  async ensureProviderReady(
    providerId: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const current = this.snapshot.servers.find(
      (server) => server.effective && server.key.name === providerId,
    )?.health;
    if (current === 'ready' || current === 'degraded' || current === 'half_open') return;
    const deadline = this.now() + Math.max(0, timeoutMs);
    return this.enqueueProviderRecovery(providerId, () =>
      this.ensureProviderReadySerialized(providerId, deadline, signal),
    );
  }

  private async ensureProviderReadySerialized(
    providerId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const ready = () =>
      this.getProviderDirectorySnapshot().entries.find((entry) => entry.providerId === providerId);
    const health = () =>
      this.snapshot.servers.find((server) => server.effective && server.key.name === providerId)
        ?.health;
    const isCallable = () => {
      const current = health();
      return current === 'ready' || current === 'degraded' || current === 'half_open';
    };
    if (isCallable()) return;
    if (health() === 'connecting' || health() === 'discovering') {
      await this.waitForProviderTransition(providerId, deadline, signal);
      if (isCallable()) return;
    }
    if (this.now() >= deadline) throw providerReconnectTimeout(providerId);
    const catalog = this.catalog;
    const config = catalog?.connectableServers[providerId];
    const entry = catalog?.entries.find(
      (candidate) => candidate.effective && candidate.name === providerId,
    );
    if (!config || !entry || config.type !== 'http') {
      this.assertProviderAvailable(providerId);
      return;
    }

    throwIfAborted(signal);
    try {
      this.generation += 1;
      const attemptGeneration = this.generation;
      const remainingMs = Math.max(1, deadline - this.now());
      await this.withProviderDeadline(
        providerId,
        attemptGeneration,
        remainingMs,
        this.connectServer(entry, config, attemptGeneration, 1, remainingMs),
        signal,
      );
      if (isCallable()) return;
    } catch (error) {
      if (error instanceof McpProviderError) throw error;
      const current = ready();
      if (current && !current.retryable) {
        this.assertProviderAvailable(providerId);
        throw error;
      }
      throw new McpProviderError({
        providerId,
        kind: 'provider_unavailable',
        message: error instanceof Error ? error.message : 'MCP provider is unavailable.',
        recoveryAction: 'retry',
        retryable: true,
      });
    }
    this.assertProviderAvailable(providerId);
  }

  private async waitForProviderTransition(
    providerId: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe = () => {};
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        reject(abortReason(signal));
      };
      const finish = () => {
        cleanup();
        resolve();
      };
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      unsubscribe = this.subscribe(() => {
        const current = this.snapshot.servers.find(
          (server) => server.effective && server.key.name === providerId,
        )?.health;
        if (current !== 'connecting' && current !== 'discovering') finish();
      });
      timer = setTimeout(finish, Math.max(0, deadline - this.now()));
      const current = this.snapshot.servers.find(
        (server) => server.effective && server.key.name === providerId,
      )?.health;
      if (current !== 'connecting' && current !== 'discovering') finish();
    });
  }

  private async withProviderDeadline<T>(
    providerId: string,
    generation: number,
    timeoutMs: number,
    operation: Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        if (this.generation === generation) this.generation += 1;
        void this.manager.disconnect(providerId, { retainCapabilities: true });
        reject(
          new McpProviderError({
            providerId,
            kind: 'provider_unavailable',
            message: `MCP provider did not reconnect within ${timeoutMs}ms.`,
            recoveryAction: 'retry',
            retryable: true,
          }),
        );
      }, timeoutMs);
    });
    try {
      return await abortable(Promise.race([operation, timeout]), signal);
    } catch (error) {
      if (signal?.aborted) {
        if (this.generation === generation) this.generation += 1;
        void this.manager.disconnect(providerId, { retainCapabilities: true });
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  findCapability(capabilityId: string) {
    return this.manager.findCapability(capabilityId);
  }

  getCapabilityRoute(capabilityId: string) {
    const fromManager = this.manager.getCapabilityRoute?.(capabilityId);
    if (fromManager) return fromManager;
    const descriptor = this.manager.findCapability(capabilityId);
    if (descriptor?.kind !== 'mcp_tool') return undefined;
    const server = this.snapshot.servers.find(
      (candidate) => candidate.effective && candidate.key.name === descriptor.provider.id,
    );
    if (!server) return undefined;
    return Object.freeze({
      transport: server.transport,
      serverIdentity: server.key.name,
      endpointRevision: server.revision,
      toolRevision: descriptor.revision,
    });
  }

  getResourceDirectorySnapshot(): McpResourceDirectorySnapshot {
    const callableProviders = new Set(
      this.snapshot.servers
        .filter(
          (server) =>
            server.effective &&
            server.enabled &&
            (server.health === 'ready' ||
              server.health === 'degraded' ||
              server.health === 'half_open'),
        )
        .map((server) => server.key.name),
    );
    const current = this.manager.getResourceDirectorySnapshot();
    const resources = current.resources.filter((resource) =>
      callableProviders.has(resource.providerId),
    );
    return Object.freeze({
      revision: digestCapability(resources),
      resources: Object.freeze(resources),
    });
  }

  async callCapability(invocation: McpCapabilityInvocation): Promise<CallToolResult> {
    const descriptor = this.manager.findCapability(invocation.capabilityId);
    const providerId =
      descriptor?.provider.id ?? invocation.capabilityId.match(/^mcp:([^/]+)\//u)?.[1] ?? 'unknown';
    this.assertProviderAvailable(providerId);
    return this.manager.callCapability(invocation);
  }

  async readResource(
    server: string,
    uri: string,
    signal?: AbortSignal,
    transportBoundary?: McpTransportInvocationBindingV1,
  ): Promise<string> {
    this.assertProviderAvailable(server);
    return this.manager.readResource(server, uri, signal, transportBoundary);
  }

  private connectCatalog(catalog: McpConfigCatalog, generation: number): void {
    for (const [name, config] of Object.entries(catalog.connectableServers)) {
      const entry = catalog.effective.get(name);
      if (!entry) continue;
      void this.connectServer(entry, config, generation).catch(() => {
        // The disconnected state and diagnostic are already observable through the manager.
      });
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.reconcileChain.then(operation, operation);
    this.reconcileChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private enqueueProviderRecovery<T>(providerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.providerRecoveryChains.get(providerId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.providerRecoveryChains.set(providerId, settled);
    void settled.finally(() => {
      if (this.providerRecoveryChains.get(providerId) === settled) {
        this.providerRecoveryChains.delete(providerId);
      }
    });
    return next;
  }

  private async reconcile(next: McpConfigCatalog): Promise<void> {
    if (!this.started) return;
    const previous = this.catalog?.connectableServers ?? {};
    const names = new Set([...Object.keys(previous), ...Object.keys(next.connectableServers)]);
    const changed = [...names].filter(
      (name) => previous[name]?.providerVersion !== next.connectableServers[name]?.providerVersion,
    );
    this.catalog = next;
    await this.registerAuthTargets(next);
    this.projectSnapshot();
    if (changed.length === 0) return;
    this.generation += 1;
    const generation = this.generation;
    this.projectSnapshot();
    await Promise.all(changed.map((name) => this.manager.disconnect(name)));
    if (!this.started || generation !== this.generation) return;
    for (const name of changed) {
      const config = next.connectableServers[name];
      if (!config) continue;
      const entry = next.effective.get(name);
      if (!entry) continue;
      void this.connectServer(entry, config, generation).catch(() => {
        // Manager publishes a typed failure without rejecting the control plane.
      });
    }
  }

  private projectSnapshot(): void {
    if (!this.catalog) return;
    const managerStates = this.manager.getServerStates();
    const capabilitySnapshot = this.manager.getCapabilitySnapshot();
    const approvals = new Map(
      this.catalog.projectApprovals.map((approval) => [
        `${approval.sourceKind}:${approval.name}`,
        approval,
      ]),
    );
    const servers = this.catalog.entries
      .map((entry) =>
        projectServer(
          entry,
          managerStates.get(entry.name),
          capabilitySnapshot,
          approvals,
          fallbackSource(entry, this.catalog!.entries),
          this.authSnapshot(entry),
        ),
      )
      .sort(compareServers);
    const effectiveNames = new Set(
      servers.filter((server) => server.effective).map((server) => server.key.name),
    );
    for (const server of servers) {
      if (!server.effective) continue;
      const discovered = server.tools
        .filter((tool) => tool.discovered)
        .map((tool) => safeProviderMetadata(tool.name))
        .filter(Boolean)
        .sort();
      if (discovered.length > 0) {
        this.lastKnownCapabilityNames.set(server.key.name, Object.freeze(discovered));
      }
    }
    for (const providerId of this.lastKnownCapabilityNames.keys()) {
      if (!effectiveNames.has(providerId)) this.lastKnownCapabilityNames.delete(providerId);
    }
    const revision = digestCapability({ generation: this.generation, servers });
    this.setSnapshot(
      Object.freeze({
        revision,
        generation: this.generation,
        servers: Object.freeze(servers),
        sourceRevisions: Object.freeze({ ...this.catalog.sourceRevisions }),
      }),
    );
  }

  private setSnapshot(snapshot: McpControlSnapshot): void {
    if (
      snapshot.revision === this.snapshot.revision &&
      snapshot.generation === this.snapshot.generation
    ) {
      return;
    }
    this.snapshot = snapshot;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // One frontend observer cannot break the control-plane projection.
      }
    }
  }

  private assertProviderAvailable(providerId: string): void {
    const entry = this.getProviderDirectorySnapshot().entries.find(
      (candidate) => candidate.providerId === providerId,
    );
    if (!entry || entry.status === 'ready' || entry.status === 'degraded') return;
    if (entry.status === 'pending_approval') {
      throw new McpProviderError({
        providerId,
        kind: 'provider_approval_required',
        message: 'MCP provider approval is required.',
        recoveryAction: 'approve',
        diagnosticCode: entry.diagnosticCode,
      });
    }
    if (entry.status === 'login_required') {
      throw new McpProviderError({
        providerId,
        kind: 'provider_auth_required',
        message: 'MCP provider authentication is required.',
        recoveryAction: 'login',
        diagnosticCode: entry.diagnosticCode,
      });
    }
    throw providerErrorFromDiagnostic(
      providerId,
      entry.diagnosticCode
        ? {
            code: entry.diagnosticCode,
            retryable: entry.retryable,
            message: 'MCP provider is unavailable.',
          }
        : undefined,
    );
  }

  private async registerAuthTargets(catalog: McpConfigCatalog): Promise<void> {
    if (!this.manager.beginOAuth || !this.manager.finishOAuth || !this.manager.clearOAuth) return;
    let workspaceKey: string;
    try {
      workspaceKey = canonicalWorkspaceKeyV1(catalog.workspace);
    } catch {
      return;
    }
    for (const entry of catalog.entries) {
      if (
        !entry.effective ||
        entry.normalizedConfig?.type !== 'http' ||
        !entry.normalizedConfig.url ||
        (entry.normalizedConfig.auth !== undefined && entry.normalizedConfig.auth.type !== 'oauth')
      ) {
        this.authCoordinator.unregister({ name: entry.name, source: entry.source.kind });
        continue;
      }
      const key = Object.freeze({ name: entry.name, source: entry.source.kind });
      const config = entry.normalizedConfig;
      const serverUrl = config.url;
      if (!serverUrl) continue;
      const credentialKey = {
        workspaceKey,
        source: entry.source.kind,
        server: entry.name,
        profile: config.auth?.type === 'oauth' ? (config.auth.credentialRef ?? 'oauth') : 'oauth',
      };
      const credentialHandle = await this.credentialBroker.issueForKey(credentialKey, {
        purpose: 'mcp.oauth',
      });
      const clientSecretKey =
        config.auth?.type === 'oauth' && config.auth.clientSecretRef
          ? {
              workspaceKey,
              source: entry.source.kind,
              server: entry.name,
              profile: config.auth.clientSecretRef,
            }
          : undefined;
      const clientSecretHandle = clientSecretKey
        ? await this.credentialBroker.issueForKey(clientSecretKey, {
            purpose: 'mcp.oauth.client-secret',
          })
        : undefined;
      let authGeneration = this.generation;
      this.authCoordinator.register({
        key,
        credentialKey,
        credentialHandle,
        serverUrl: new URL(serverUrl),
        ...(config.auth?.type === 'oauth' && config.auth.scopes
          ? { scopes: config.auth.scopes }
          : {}),
        ...(config.auth?.type === 'oauth' && config.auth.clientId
          ? { clientId: config.auth.clientId }
          : {}),
        ...(clientSecretKey ? { clientSecretKey } : {}),
        ...(clientSecretHandle ? { clientSecretHandle } : {}),
        begin: async (provider) => {
          this.generation += 1;
          authGeneration = this.generation;
          this.projectSnapshot();
          return this.manager.beginOAuth!(entry.name, config, authGeneration, provider);
        },
        complete: async (authorizationCode) => {
          await this.manager.finishOAuth!(entry.name, authorizationCode, authGeneration);
        },
        logout: async () => {
          await this.manager.clearOAuth!(entry.name);
        },
        revoke: async (provider) => {
          await revokeMcpOAuthToken(provider, new URL(serverUrl));
        },
      });
    }
  }

  private async connectServer(
    entry: McpServerConfigEntry,
    config: McpServerConfig,
    generation: number,
    maximumAttempts = 3,
    attemptTimeoutMs?: number,
  ): Promise<void> {
    const runtimeConfig =
      config.auth?.type === 'credential'
        ? await this.withCredentialIdentity(entry, config)
        : config;
    if (config.type === 'http') {
      const resumed = await this.authCoordinator.resume({
        name: entry.name,
        source: entry.source.kind,
      });
      if (resumed !== 'not_configured') return;
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < maximumAttempts; attempt++) {
      try {
        await this.manager.reconnect(entry.name, runtimeConfig, generation, attemptTimeoutMs);
        return;
      } catch (error) {
        lastError = error;
        const directory = this.manager
          .getProviderDirectorySnapshot()
          .entries.find((candidate) => candidate.providerId === entry.name);
        if (config.type !== 'http' || !directory?.retryable || attempt + 1 >= maximumAttempts) {
          throw error;
        }
        await this.sleep(2 ** attempt * 1_000);
      }
    }
    throw lastError;
  }

  private async withCredentialIdentity(
    entry: McpServerConfigEntry,
    config: McpServerConfig,
  ): Promise<McpServerConfig> {
    if (config.auth?.type !== 'credential') return config;
    const credentialKey = {
      workspaceKey: canonicalWorkspaceKeyV1(entry.source.workspace),
      source: entry.source.kind,
      server: entry.name,
      profile: config.auth.credentialRef,
    };
    const credentialHandle = await this.credentialBroker.issueForKey(credentialKey, {
      purpose: 'mcp.transport',
    });
    return {
      ...config,
      credentialHandle,
    };
  }

  private authSnapshot(entry: McpServerConfigEntry): Readonly<McpAuthSnapshot> | undefined {
    if (
      entry.normalizedConfig?.type !== 'http' ||
      (entry.normalizedConfig.auth !== undefined && entry.normalizedConfig.auth.type !== 'oauth')
    ) {
      return undefined;
    }
    return this.authCoordinator.getSnapshot({ name: entry.name, source: entry.source.kind });
  }
}

function projectServer(
  entry: McpServerConfigEntry,
  managerState: Readonly<McpServerState> | undefined,
  capabilitySnapshot: CapabilitySnapshot,
  approvals: ReadonlyMap<string, McpConfigCatalog['projectApprovals'][number]>,
  fallback: McpServerControlState['fallbackSource'],
  auth: Readonly<McpAuthSnapshot> | undefined,
): Readonly<McpServerControlState> {
  const runtimeState = entry.effective ? managerState : undefined;
  const providerVersion = entry.normalizedConfig?.providerVersion;
  const currentRuntimeState =
    runtimeState?.config.providerVersion === providerVersion ? runtimeState : undefined;
  const descriptors = capabilitySnapshot.descriptors.filter(
    (descriptor) =>
      descriptor.provider.type === 'mcp' &&
      descriptor.provider.id === entry.name &&
      descriptor.provider.version === providerVersion,
  );
  const toolDescriptors = new Map(
    descriptors
      .filter((descriptor) => descriptor.kind === 'mcp_tool')
      .map((descriptor) => [descriptor.displayName, descriptor]),
  );
  const tools = Object.freeze(
    projectTools(
      currentRuntimeState?.tools ?? [],
      entry.normalizedConfig,
      entry.source.kind,
      toolDescriptors,
    ),
  );
  const approval = approvals.get(`${entry.source.kind}:${entry.name}`);
  const diagnostic = currentRuntimeState?.diagnostic ?? configDiagnostic(entry);
  const status = configStatus(entry);
  const authStatus =
    diagnostic?.code === 'auth_required' &&
    auth?.status !== 'authorizing' &&
    auth?.status !== 'refreshing'
      ? 'login_required'
      : (auth?.status ?? 'not_required');
  const capabilityRevision =
    descriptors.length > 0
      ? digestCapability(
          descriptors.map((descriptor) => ({
            capabilityId: descriptor.capabilityId,
            revision: descriptor.revision,
          })),
        )
      : undefined;
  return Object.freeze({
    key: Object.freeze({ name: entry.name, source: entry.source.kind }),
    effective: entry.effective,
    configStatus: status,
    authStatus,
    credentialPresent: auth?.credentialPresent ?? false,
    ...(auth?.flowId ? { authFlowId: auth.flowId } : {}),
    ...(auth?.errorCode ? { authErrorCode: auth.errorCode } : {}),
    health: currentRuntimeState?.health ?? 'disconnected',
    transport: entry.normalizedConfig?.type ?? (entry.rawConfig.type === 'http' ? 'http' : 'stdio'),
    contentEgress: Object.freeze({
      remote:
        (entry.normalizedConfig?.type ?? (entry.rawConfig.type === 'http' ? 'http' : 'stdio')) ===
        'http',
      nonEmptyArgumentsClassification: 'confidential' as const,
      independentPermitRequired:
        (entry.normalizedConfig?.type ?? (entry.rawConfig.type === 'http' ? 'http' : 'stdio')) ===
        'http',
    }),
    source: entry.source.kind,
    sourcePath: entry.source.path,
    configuration: Object.freeze({
      ...(typeof entry.rawConfig.command === 'string' ? { command: entry.rawConfig.command } : {}),
      ...(Array.isArray(entry.rawConfig.args)
        ? { argumentCount: entry.rawConfig.args.length }
        : {}),
      ...safeEndpoint(entry.rawConfig.url),
    }),
    revision: entry.revision,
    enabled: entry.enabled,
    required: entry.normalizedConfig?.required === true,
    ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
    ...(fallback ? { fallbackSource: fallback } : {}),
    capabilityRevision,
    toolCount: currentRuntimeState?.tools.length ?? 0,
    availableToolCount: tools.filter((tool) => tool.available).length,
    resourceCount: currentRuntimeState?.resources.length ?? 0,
    promptCount: currentRuntimeState?.prompts.length ?? 0,
    tools,
    resources: Object.freeze(
      (currentRuntimeState?.resources ?? []).map((resource) => Object.freeze({ ...resource })),
    ),
    prompts: Object.freeze(
      (currentRuntimeState?.prompts ?? []).map((prompt) =>
        Object.freeze({
          ...prompt,
          arguments: prompt.arguments
            ? Object.freeze(prompt.arguments.map((argument) => Object.freeze({ ...argument })))
            : undefined,
        }),
      ),
    ),
    ...(approval
      ? {
          approval: Object.freeze({
            configDigest: approval.configDigest,
            review: Object.freeze({ ...approval.review }),
          }),
        }
      : {}),
    ...(currentRuntimeState?.retryAt !== undefined ? { retryAt: currentRuntimeState.retryAt } : {}),
    ...(currentRuntimeState?.lastAttemptAt
      ? { lastAttemptAt: currentRuntimeState.lastAttemptAt }
      : {}),
    ...(diagnostic ? { diagnostic } : {}),
  });
}

function safeEndpoint(value: unknown): { endpoint?: string } {
  if (typeof value !== 'string') return {};
  try {
    const endpoint = new URL(value);
    return { endpoint: endpoint.origin };
  } catch {
    return {};
  }
}

function providerReconnectTimeout(providerId: string): McpProviderError {
  return new McpProviderError({
    providerId,
    kind: 'provider_unavailable',
    message: 'MCP provider did not reconnect within the Tool Call wait budget.',
    recoveryAction: 'retry',
    retryable: true,
  });
}

function fallbackSource(
  entry: McpServerConfigEntry,
  entries: readonly McpServerConfigEntry[],
): McpServerControlState['fallbackSource'] {
  if (!entry.effective) return undefined;
  const rank: Record<string, number> = {
    project: 6,
    user: 5,
    local: 4,
    project_mcp_json: 3,
    project_legacy: 2,
    user_legacy: 1,
    explicit: 5,
  };
  return entries
    .filter((candidate) => candidate.name === entry.name && candidate !== entry)
    .sort((left, right) => (rank[right.source.kind] ?? 0) - (rank[left.source.kind] ?? 0))[0]
    ?.source.kind;
}

function projectTool(
  tool: SdkTool,
  config: McpServerConfig,
  source: McpServerConfigEntry['source']['kind'],
  descriptor: CapabilitySnapshot['descriptors'][number] | undefined,
): Readonly<McpToolControlState> {
  const schema = compileCapabilitySchema(tool.inputSchema);
  const policy = resolveMcpToolPolicy(config, tool);
  const available = policy.enabled && descriptor?.availability === 'available';
  return Object.freeze({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: projectToolParameters(tool.inputSchema),
    discovered: true,
    enabled: policy.enabled,
    availability: !schema.ok ? 'quarantined' : available ? 'available' : 'unavailable',
    available,
    declaredEffects: Object.freeze({ ...policy.declaredEffects }),
    effectiveEffects: Object.freeze({ ...policy.effectiveEffects }),
    annotationProvenance: policy.annotationProvenance,
    policySource: hasConfiguredMcpToolPolicy(config, tool.name) ? source : 'default',
    minimumApproval: policy.minimumApproval,
    retry: policy.retry,
    ...(policy.idempotencyKeyArgument
      ? { idempotencyKeyArgument: policy.idempotencyKeyArgument }
      : {}),
    ...(!schema.ok
      ? {
          diagnostic: Object.freeze({
            code: 'invalid_schema' as const,
            retryable: false,
            message: schema.diagnostic,
          }),
        }
      : {}),
  });
}

function projectTools(
  discoveredTools: readonly SdkTool[],
  config: McpServerConfig | undefined,
  source: McpServerConfigEntry['source']['kind'],
  descriptors: ReadonlyMap<string, CapabilitySnapshot['descriptors'][number]>,
): Readonly<McpToolControlState>[] {
  if (!config) return [];
  const discoveredNames = new Set(discoveredTools.map((tool) => tool.name));
  const discovered = discoveredTools.map((tool) =>
    projectTool(tool, config, source, descriptors.get(tool.name)),
  );
  const missing = configuredMcpToolNames(config)
    .filter((name) => !discoveredNames.has(name))
    .map((name) => projectMissingTool(name, config, source));
  return [...discovered, ...missing].sort((left, right) => left.name.localeCompare(right.name));
}

function projectMissingTool(
  name: string,
  config: McpServerConfig,
  source: McpServerConfigEntry['source']['kind'],
): Readonly<McpToolControlState> {
  const policy = resolveMcpToolPolicy(config, { name });
  return Object.freeze({
    name,
    parameters: Object.freeze([]),
    discovered: false,
    enabled: policy.enabled,
    availability: 'unavailable',
    available: false,
    declaredEffects: Object.freeze({ ...policy.declaredEffects }),
    effectiveEffects: Object.freeze({ ...policy.effectiveEffects }),
    annotationProvenance: policy.annotationProvenance,
    policySource: source,
    minimumApproval: policy.minimumApproval,
    retry: policy.retry,
    ...(policy.idempotencyKeyArgument
      ? { idempotencyKeyArgument: policy.idempotencyKeyArgument }
      : {}),
    diagnostic: Object.freeze({
      code: 'tool_not_discovered',
      retryable: false,
      message: 'The configured Tool name was not returned by MCP discovery.',
    }),
  });
}

function projectToolParameters(inputSchema: unknown): McpToolControlState['parameters'] {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return Object.freeze([]);
  }
  const schema = inputSchema as Record<string, unknown>;
  if (
    !schema.properties ||
    typeof schema.properties !== 'object' ||
    Array.isArray(schema.properties)
  ) {
    return Object.freeze([]);
  }
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === 'string')
      : [],
  );
  return Object.freeze(
    Object.entries(schema.properties as Record<string, unknown>).map(([name, value]) => {
      const property =
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const rawType = property.type;
      const type = Array.isArray(rawType)
        ? rawType.filter((item): item is string => typeof item === 'string').join(' | ')
        : typeof rawType === 'string'
          ? rawType
          : 'unknown';
      return Object.freeze({
        name,
        required: required.has(name),
        type,
        ...(typeof property.description === 'string' ? { description: property.description } : {}),
      });
    }),
  );
}

function configStatus(entry: McpServerConfigEntry): McpConfigStatus {
  if (!entry.effective) return 'shadowed';
  if (!entry.enabled) return 'disabled';
  if (entry.approvalStatus === 'not_required') return 'configured';
  return entry.approvalStatus;
}

function configDiagnostic(entry: McpServerConfigEntry): McpDiagnostic | undefined {
  switch (configStatus(entry)) {
    case 'pending_approval':
      return Object.freeze({
        code: 'approval_required',
        retryable: false,
        message: 'Project MCP server approval is required.',
      });
    case 'rejected':
      return Object.freeze({
        code: 'approval_rejected',
        retryable: false,
        message: 'Project MCP server approval was rejected.',
      });
    case 'invalid':
    case 'store_corrupt':
    case 'store_unavailable':
      return Object.freeze({
        code: 'config_invalid',
        retryable: false,
        message: entry.diagnostics[0]?.message ?? 'MCP configuration is unavailable.',
      });
    default:
      return undefined;
  }
}

function compareServers(
  left: Readonly<McpServerControlState>,
  right: Readonly<McpServerControlState>,
): number {
  if (left.effective !== right.effective) return left.effective ? -1 : 1;
  const status = statusRank(left) - statusRank(right);
  if (status !== 0) return status;
  const name = left.key.name.localeCompare(right.key.name);
  return name !== 0 ? name : left.source.localeCompare(right.source);
}

function statusRank(server: Readonly<McpServerControlState>): number {
  if (server.health === 'ready') return 0;
  if (server.health === 'connecting' || server.health === 'discovering') return 1;
  if (server.configStatus === 'pending_approval') return 2;
  if (server.health === 'degraded' || server.health === 'half_open') return 3;
  if (server.configStatus === 'shadowed') return 5;
  return 4;
}

function providerDirectoryStatus(
  server: Readonly<McpServerControlState>,
): McpProviderDirectoryStatus {
  if (server.configStatus === 'pending_approval') return 'pending_approval';
  if (server.configStatus === 'rejected') return 'rejected';
  if (server.configStatus === 'disabled') return 'disabled';
  if (server.diagnostic?.code === 'auth_required') return 'login_required';
  if (server.authStatus === 'login_required' || server.authStatus === 'reauth_required') {
    return 'login_required';
  }
  if (server.configStatus === 'invalid' || server.configStatus.startsWith('store_')) {
    return 'quarantined';
  }
  if (server.health === 'quarantined') return 'quarantined';
  if (server.health === 'connecting' || server.health === 'discovering') return 'connecting';
  if (server.health === 'ready') return 'ready';
  if (
    server.health === 'degraded' ||
    server.health === 'half_open' ||
    server.health === 'circuit_open'
  ) {
    return 'degraded';
  }
  return server.diagnostic ? 'failed' : 'connecting';
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

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('The MCP operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
