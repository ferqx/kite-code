import { describe, expect, test } from 'bun:test';
import { createCapabilitySnapshotV1, descriptorRevisionV1 } from '@kite/builtin-runtime';
import type { McpServerConfig, McpServerState } from '@kite/builtin-runtime/mcp';
import {
  DefaultMcpSupervisor,
  type McpConnectionManagerControlPlane,
} from '@kite/builtin-runtime/mcp';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@kite/runtime-contract';
import type { McpConfigCatalog, McpServerConfigEntry } from '#app/config/mcp-config';
import type { McpConfigCommand, McpConfigRepository } from '#app/config/mcp-config-repository';

describe('MCP config reconcile', () => {
  test('invalidates changed provider generation before reconnect and retains unchanged servers', async () => {
    const repository = new MutableRepository(catalog('v1', 'other-v1'));
    const manager = new RecordingManager();
    const supervisor = new DefaultMcpSupervisor({ repository, manager });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    const firstRevision = manager.getCapabilitySnapshot().revision;
    manager.operations.length = 0;

    repository.current = catalog('v2', 'other-v1');
    await supervisor.reload();
    await Bun.sleep(0);

    expect(manager.operations).toEqual(['disconnect:changed', 'reconnect:changed:v2']);
    expect(manager.getCapabilitySnapshot().revision).not.toBe(firstRevision);
    expect(manager.findCapability('mcp:changed/read')?.provider.version).toBe('v2');
    expect(manager.findCapability('mcp:unchanged/read')?.provider.version).toBe('other-v1');
    await supervisor.stop();
  });

  test('disable removes future capability visibility without reconnecting it', async () => {
    const repository = new MutableRepository(catalog('v1', 'other-v1'));
    const manager = new RecordingManager();
    const supervisor = new DefaultMcpSupervisor({ repository, manager });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    manager.operations.length = 0;
    repository.current = catalog(undefined, 'other-v1', false);

    await supervisor.reload();

    expect(manager.operations).toEqual(['disconnect:changed']);
    expect(manager.findCapability('mcp:changed/read')).toBeUndefined();
    expect(
      supervisor.getSnapshot().servers.find((server) => server.key.name === 'changed'),
    ).toMatchObject({
      configStatus: 'disabled',
      enabled: false,
    });
    await supervisor.stop();
  });
});

class MutableRepository implements McpConfigRepository {
  current: McpConfigCatalog;
  constructor(current: McpConfigCatalog) {
    this.current = current;
  }
  load = async () => this.current;
  mutate = async (_command: McpConfigCommand) => this.current;
  watch = () => () => {};
}

class RecordingManager implements McpConnectionManagerControlPlane {
  readonly operations: string[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly states = new Map<string, McpServerState>();
  private snapshot: CapabilitySnapshot = createCapabilitySnapshotV1([]);

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  reconnect = async (name: string, config: McpServerConfig, generation: number) => {
    this.operations.push(`reconnect:${name}:${config.providerVersion}`);
    this.states.set(name, {
      config,
      client: {},
      tools: [{ name: 'read', inputSchema: { type: 'object' } }],
      prompts: [],
      resources: [],
      health: 'ready',
      generation,
      lastAttemptAt: '2026-07-15T00:00:00.000Z',
      consecutiveCallFailures: 0,
    });
    this.publish();
  };
  disconnect = async (name: string) => {
    this.operations.push(`disconnect:${name}`);
    this.states.delete(name);
    this.publish();
  };
  disconnectAll = async () => {
    this.states.clear();
    this.publish();
  };
  getServerStates = () => new Map(this.states);
  getCapabilitySnapshot = () => this.snapshot;

  getProviderDirectorySnapshot = () => ({ revision: 'fake-directory', entries: [] });
  getResourceDirectorySnapshot = () => ({ revision: 'fake-resources', resources: [] });
  findCapability = (capabilityId: string) =>
    this.snapshot.descriptors.find((descriptor) => descriptor.capabilityId === capabilityId);
  getAllTools = () => [];
  callCapability = async () => ({ content: [] });
  getResources = () => [];
  readResource = async () => '';

  private publish(): void {
    this.snapshot = createCapabilitySnapshotV1(
      [...this.states].map(([name, state]) => descriptor(name, state.config.providerVersion)),
    );
    for (const listener of this.listeners) listener();
  }
}

function catalog(
  changedVersion: string | undefined,
  unchangedVersion: string,
  changedEnabled = true,
): McpConfigCatalog {
  const changed = entry('changed', changedVersion ?? 'v2', changedEnabled);
  const unchanged = entry('unchanged', unchangedVersion, true);
  return {
    entries: [changed, unchanged],
    effective: new Map([
      ['changed', changed],
      ['unchanged', unchanged],
    ]),
    connectableServers: {
      ...(changedVersion && changedEnabled ? { changed: changed.normalizedConfig! } : {}),
      unchanged: unchanged.normalizedConfig!,
    },
    projectApprovals: [],
    diagnostics: [],
    workspace: '/workspace',
    sourceRevisions: { local: 'local', project: 'project', user: 'user' },
  };
}

function entry(name: string, version: string, enabled: boolean): McpServerConfigEntry {
  return {
    name,
    source: { kind: 'user', path: '/home/config.jsonc', workspace: '/workspace' },
    rawConfig: { command: name, enabled },
    normalizedConfig: {
      type: 'stdio',
      command: name,
      enabled,
      providerVersion: version,
    },
    revision: `${name}:${version}:${enabled}`,
    providerConfigDigest: version,
    enabled,
    approvalStatus: 'not_required',
    diagnostics: [],
    effective: true,
  };
}

function descriptor(name: string, version: string | undefined): CapabilityDescriptor {
  const withoutRevision: Omit<CapabilityDescriptor, 'revision'> = {
    capabilityId: `mcp:${name}/read`,
    kind: 'mcp_tool',
    displayName: 'read',
    description: 'read',
    provider: { type: 'mcp', id: name, version, provenance: 'remote' },
    inputSchema: { type: 'object' },
    declaredEffects: { filesystem: 'read', network: 'read', externalState: 'read' },
    effectiveEffects: { filesystem: 'read', network: 'read', externalState: 'read' },
    policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
    availability: 'available',
    diagnostics: [],
  };
  return { ...withoutRevision, revision: descriptorRevisionV1(withoutRevision) };
}
