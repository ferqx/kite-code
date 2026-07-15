import { describe, expect, test } from 'bun:test';
import type { CallToolResult, Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfigCatalog, McpServerConfigEntry } from '@/core/config';
import { DefaultMcpSupervisor, diagnoseMcpError, type McpManagerControlPlane } from '@/core/mcp';
import type { McpServerConfig, McpServerState } from '@/core/mcp/types';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@/protocol/capabilities';

class FakeManager implements McpManagerControlPlane {
  readonly states = new Map<string, McpServerState>();
  readonly reconnects: Array<{ name: string; generation: number }> = [];
  private readonly listeners = new Set<() => void>();
  private capabilitySnapshot: CapabilitySnapshot = { revision: 'empty', descriptors: [] };
  connectGate: Promise<void> = Promise.resolve();

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reconnect(name: string, config: McpServerConfig, generation: number): Promise<void> {
    this.reconnects.push({ name, generation });
    this.states.set(name, state(config, generation, 'connecting'));
    this.emit();
    await this.connectGate;
    const current = this.states.get(name);
    if (!current || current.generation !== generation) return;
    current.health = 'ready';
    current.tools = [{ name: 'read', inputSchema: { type: 'object' } } as SdkTool];
    const descriptor = toolDescriptor(name);
    this.capabilitySnapshot = { revision: `cap-${generation}`, descriptors: [descriptor] };
    this.emit();
  }

  async disconnect(name: string) {
    this.states.delete(name);
    this.capabilitySnapshot = { revision: 'empty', descriptors: [] };
    this.emit();
  }

  async disconnectAll() {
    this.states.clear();
    this.capabilitySnapshot = { revision: 'empty', descriptors: [] };
    this.emit();
  }

  getServerStates() {
    return this.states;
  }

  getCapabilitySnapshot() {
    return this.capabilitySnapshot;
  }

  findCapability(capabilityId: string): CapabilityDescriptor | undefined {
    return this.capabilitySnapshot.descriptors.find(
      (descriptor) => descriptor.capabilityId === capabilityId,
    );
  }

  async callTool(): Promise<CallToolResult> {
    throw new Error('not used');
  }

  async readResource(): Promise<string> {
    throw new Error('not used');
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }
}

describe('McpSupervisor', () => {
  test('publishes configured state immediately and reacts to manager health/discovery', async () => {
    const manager = new FakeManager();
    let release = () => {};
    manager.connectGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => catalog(),
    });
    const observed: string[] = [];
    supervisor.subscribe(() => {
      const server = supervisor
        .getSnapshot()
        .servers.find((candidate) => candidate.key.name === 'good');
      if (server) observed.push(`${server.configStatus}:${server.health}:${server.toolCount}`);
    });

    await supervisor.start('/workspace');
    expect(observed[0]).toBe('configured:disconnected:0');
    expect(supervisor.getSnapshot().servers.map((server) => server.key.name)).toEqual([
      'good',
      'approval',
    ]);
    expect(supervisor.getSnapshot().servers[0]?.health).toBe('connecting');

    release();
    await Bun.sleep(0);
    expect(supervisor.getSnapshot().servers[0]).toMatchObject({
      health: 'ready',
      toolCount: 1,
      availableToolCount: 1,
    });
    expect(supervisor.getSnapshot().servers[1]).toMatchObject({
      configStatus: 'pending_approval',
      health: 'disconnected',
      diagnostic: { code: 'approval_required' },
    });
    await supervisor.stop();
  });

  test('retry reloads the approval/config gate and advances generation', async () => {
    const manager = new FakeManager();
    const supervisor = new DefaultMcpSupervisor({ manager, loadCatalog: () => catalog() });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    const key = supervisor.getSnapshot().servers[0]!.key;
    const previousGeneration = supervisor.getSnapshot().generation;
    await supervisor.retry(key);
    expect(supervisor.getSnapshot().generation).toBe(previousGeneration + 1);
    expect(manager.reconnects.at(-1)).toEqual({ name: 'good', generation: previousGeneration + 1 });
    await supervisor.stop();
    await supervisor.stop();
  });

  test('maps and redacts technical diagnostics', () => {
    const auth = diagnoseMcpError(
      Object.assign(
        new Error('Unauthorized Bearer super-secret at https://user:pass@example.com/mcp?token=x'),
        {
          status: 401,
        },
      ),
      { phase: 'connect' },
    );
    expect(auth.code).toBe('auth_required');
    expect(auth.retryable).toBe(false);
    expect(auth.message).not.toContain('super-secret');
    expect(auth.message).not.toContain('user:pass');
    expect(auth.message).not.toContain('token=x');
  });
});

function catalog(): McpConfigCatalog {
  const good = entry('good', 'user', 'not_required');
  const approval = entry('approval', 'project', 'pending_approval');
  return {
    entries: [good, approval],
    effective: new Map([
      ['good', good],
      ['approval', approval],
    ]),
    connectableServers: { good: good.normalizedConfig! },
    projectApprovals: [
      {
        name: 'approval',
        sourceKind: 'project',
        sourcePath: '/workspace/.mcp.json',
        transport: 'stdio',
        configDigest: 'digest',
        status: 'pending_approval',
        review: { command: 'bun', argumentCount: 1 },
        diagnostics: [],
      },
    ],
    diagnostics: [],
    workspace: '/workspace',
    sourceRevisions: { local: 'local', project: 'project', user: 'user' },
  };
}

function entry(
  name: string,
  kind: McpServerConfigEntry['source']['kind'],
  approvalStatus: McpServerConfigEntry['approvalStatus'],
): McpServerConfigEntry {
  return {
    name,
    source: {
      kind,
      path: kind === 'user' ? '/home/config.jsonc' : '/workspace/.mcp.json',
      workspace: '/workspace',
    },
    rawConfig: { type: 'stdio', command: 'bun' },
    normalizedConfig: { type: 'stdio', command: 'bun' },
    ...(kind === 'project' ? { configDigest: 'digest' } : {}),
    revision: `${kind}:${name}:revision`,
    providerConfigDigest: `${kind}:${name}:provider`,
    enabled: true,
    approvalStatus,
    diagnostics: [],
    effective: true,
  };
}

function state(
  config: McpServerConfig,
  generation: number,
  health: McpServerState['health'],
): McpServerState {
  return {
    config,
    client: {},
    tools: [],
    prompts: [],
    resources: [],
    health,
    generation,
    lastAttemptAt: '2026-07-15T00:00:00.000Z',
    consecutiveCallFailures: 0,
  };
}

function toolDescriptor(server: string): CapabilityDescriptor {
  return {
    capabilityId: `mcp:${server}/read`,
    kind: 'mcp_tool',
    displayName: 'read',
    description: 'read',
    provider: { type: 'mcp', id: server, provenance: 'remote' },
    inputSchema: { type: 'object' },
    declaredEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
    effectiveEffects: { filesystem: 'unknown', network: 'unknown', externalState: 'unknown' },
    policy: { workspaceTrustRequired: false, minimumApproval: 'user' },
    availability: 'available',
    diagnostics: [],
    revision: 'tool-revision',
  };
}
