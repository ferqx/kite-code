import type { Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import { digestCapability } from '@/core/capabilities/catalog';
import type { McpConfigCatalog, McpServerConfigEntry } from '@/core/config/mcp-config';
import {
  DefaultMcpConfigRepository,
  type McpConfigCommand,
  type McpConfigRepository,
} from '@/core/config/mcp-config-repository';
import type { CapabilitySnapshot } from '@/protocol/capabilities';
import type {
  McpConfigStatus,
  McpControlSnapshot,
  McpServerControlState,
  McpServerKey,
  McpToolControlState,
} from './control-types';
import type { McpDiagnostic } from './diagnostics';
import { McpManager } from './manager';
import type { McpRuntimeProvider } from './runtime-provider';
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
  getSnapshot(): McpControlSnapshot;
  subscribe(listener: () => void): () => void;
  getRuntimeProvider(): McpRuntimeProvider;
}

export interface McpManagerControlPlane extends McpRuntimeProvider {
  subscribe(listener: () => void): () => void;
  reconnect(name: string, config: McpServerConfig, generation: number): Promise<void>;
  disconnect(name: string): Promise<void>;
  disconnectAll(): Promise<void>;
  getServerStates(): ReadonlyMap<string, Readonly<McpServerState>>;
  getCapabilitySnapshot(): CapabilitySnapshot;
}

export interface McpSupervisorOptions {
  manager?: McpManagerControlPlane;
  loadCatalog?: (options: { workspace: string }) => McpConfigCatalog;
  repository?: McpConfigRepository;
}

export class DefaultMcpSupervisor implements McpSupervisor {
  private readonly manager: McpManagerControlPlane;
  private readonly repository: McpConfigRepository;
  private readonly listeners = new Set<() => void>();
  private snapshot = EMPTY_SNAPSHOT;
  private catalog: McpConfigCatalog | undefined;
  private workspace: string | undefined;
  private managerUnsubscribe: (() => void) | undefined;
  private configUnsubscribe: (() => void) | undefined;
  private generation = 0;
  private started = false;
  private reconcileChain: Promise<void> = Promise.resolve();

  constructor(options: McpSupervisorOptions = {}) {
    this.manager = options.manager ?? new McpManager();
    this.repository =
      options.repository ?? new DefaultMcpConfigRepository({ loadCatalog: options.loadCatalog });
  }

  async start(workspace: string): Promise<void> {
    if (this.started && this.workspace === workspace) return;
    if (this.started) await this.stop();
    this.started = true;
    this.workspace = workspace;
    this.generation += 1;
    this.managerUnsubscribe = this.manager.subscribe(() => this.projectSnapshot());
    this.catalog = await this.repository.load(workspace);
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
    this.configUnsubscribe?.();
    this.configUnsubscribe = undefined;
    this.catalog = undefined;
    this.workspace = undefined;
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
        await this.manager.reconnect(key.name, config, this.generation);
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
    return this.manager;
  }

  private connectCatalog(catalog: McpConfigCatalog, generation: number): void {
    for (const [name, config] of Object.entries(catalog.connectableServers)) {
      void this.manager.reconnect(name, config, generation).catch(() => {
        // The disconnected state and diagnostic are already observable through the manager.
      });
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.reconcileChain.then(operation, operation);
    this.reconcileChain = next.catch(() => {});
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
      void this.manager.reconnect(name, config, generation).catch(() => {
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
        ),
      )
      .sort(compareServers);
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
}

function projectServer(
  entry: McpServerConfigEntry,
  managerState: Readonly<McpServerState> | undefined,
  capabilitySnapshot: CapabilitySnapshot,
  approvals: ReadonlyMap<string, McpConfigCatalog['projectApprovals'][number]>,
  fallback: McpServerControlState['fallbackSource'],
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
    (currentRuntimeState?.tools ?? []).map((tool) =>
      projectTool(tool, toolDescriptors.get(tool.name)),
    ),
  );
  const approval = approvals.get(`${entry.source.kind}:${entry.name}`);
  const diagnostic = currentRuntimeState?.diagnostic ?? configDiagnostic(entry);
  const status = configStatus(entry);
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
    authStatus: 'not_required',
    health: currentRuntimeState?.health ?? 'disconnected',
    transport: entry.normalizedConfig?.type ?? (entry.rawConfig.type === 'http' ? 'http' : 'stdio'),
    source: entry.source.kind,
    sourcePath: entry.source.path,
    revision: entry.revision,
    enabled: entry.enabled,
    required: entry.normalizedConfig?.required === true,
    ...(entry.shadowedBy ? { shadowedBy: entry.shadowedBy } : {}),
    ...(fallback ? { fallbackSource: fallback } : {}),
    capabilityRevision,
    toolCount: tools.length,
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

function fallbackSource(
  entry: McpServerConfigEntry,
  entries: readonly McpServerConfigEntry[],
): McpServerControlState['fallbackSource'] {
  if (!entry.effective) return undefined;
  const rank: Record<string, number> = {
    local: 4,
    project_legacy: 3,
    project: 2,
    user: 1,
    explicit: 5,
  };
  return entries
    .filter((candidate) => candidate.name === entry.name && candidate !== entry)
    .sort((left, right) => (rank[right.source.kind] ?? 0) - (rank[left.source.kind] ?? 0))[0]
    ?.source.kind;
}

function projectTool(
  tool: SdkTool,
  descriptor: CapabilitySnapshot['descriptors'][number] | undefined,
): Readonly<McpToolControlState> {
  const available = descriptor?.availability === 'available';
  return Object.freeze({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    available,
    ...(!available
      ? {
          diagnostic: Object.freeze({
            code: 'invalid_schema' as const,
            retryable: false,
            message: 'The discovered tool schema is not supported.',
          }),
        }
      : {}),
  });
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
