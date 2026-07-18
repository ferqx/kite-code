import { describe, expect, test } from 'bun:test';
import type { CallToolResult, Tool as SdkTool } from '@modelcontextprotocol/sdk/types.js';
import type { McpConfigCatalog, McpConfigRepository, McpServerConfigEntry } from '@/core/config';
import { DefaultMcpSupervisor, diagnoseMcpError, type McpManagerControlPlane } from '@/core/mcp';
import type { McpServerConfig, McpServerState } from '@/core/mcp/types';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@/protocol/capabilities';

class FakeManager implements McpManagerControlPlane {
  readonly states = new Map<string, McpServerState>();
  readonly reconnects: Array<{ name: string; generation: number }> = [];
  discoveredTools: SdkTool[] = [{ name: 'read', inputSchema: { type: 'object' } } as SdkTool];
  discoveredResources: McpServerState['resources'] = [];
  private readonly listeners = new Set<() => void>();
  private capabilitySnapshot: CapabilitySnapshot = { revision: 'empty', descriptors: [] };
  connectGate: Promise<void> = Promise.resolve();
  reconnectFailure: Error | undefined;

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async reconnect(name: string, config: McpServerConfig, generation: number): Promise<void> {
    this.reconnects.push({ name, generation });
    this.states.set(name, state(config, generation, 'connecting'));
    this.emit();
    await this.connectGate;
    if (this.reconnectFailure) {
      const current = this.states.get(name);
      if (current) {
        current.health = 'disconnected';
        current.diagnostic = diagnoseMcpError(this.reconnectFailure);
        this.emit();
      }
      throw this.reconnectFailure;
    }
    const current = this.states.get(name);
    if (!current || current.generation !== generation) return;
    current.health = 'ready';
    current.tools = this.discoveredTools;
    current.resources = [...this.discoveredResources];
    const descriptors = this.discoveredTools
      .filter((tool) => tool.name === 'read')
      .map(() => toolDescriptor(name));
    this.capabilitySnapshot = { revision: `cap-${generation}`, descriptors };
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

  getProviderDirectorySnapshot() {
    return {
      revision: 'fake-directory',
      entries: [...this.states.entries()].map(([providerId, current]) => ({
        providerId,
        status:
          current.health === 'ready'
            ? ('ready' as const)
            : current.health === 'degraded'
              ? ('degraded' as const)
              : ('failed' as const),
        required: current.config.required === true,
        source: 'explicit' as const,
        lastKnownCapabilityNames: current.tools.map((tool) => tool.name),
        ...(current.diagnostic ? { diagnosticCode: current.diagnostic.code } : {}),
        retryable: current.diagnostic?.retryable ?? false,
      })),
    };
  }

  getResourceDirectorySnapshot() {
    return {
      revision: 'fake-resources',
      resources: [...this.states.entries()].flatMap(([providerId, current]) =>
        current.resources.map((resource) => ({
          providerId,
          uri: resource.uri,
          name: resource.name,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        })),
      ),
    };
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

  test('exposes a redacted provider directory and retains last-known Tool names while unavailable', async () => {
    const manager = new FakeManager();
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => catalog(),
    });

    await supervisor.start('/workspace');
    await Bun.sleep(0);

    const provider = supervisor.getRuntimeProvider();
    expect(provider).toBe(supervisor);
    expect(provider.getProviderDirectorySnapshot().entries).toEqual([
      expect.objectContaining({
        providerId: 'approval',
        status: 'pending_approval',
        lastKnownCapabilityNames: [],
        diagnosticCode: 'approval_required',
      }),
      expect.objectContaining({
        providerId: 'good',
        status: 'ready',
        lastKnownCapabilityNames: ['read'],
      }),
    ]);

    const good = manager.states.get('good')!;
    good.health = 'disconnected';
    good.tools = [];
    good.diagnostic = {
      code: 'auth_required',
      retryable: false,
      message: 'Bearer [REDACTED]',
    };
    manager.emit();

    expect(
      provider.getProviderDirectorySnapshot().entries.find((entry) => entry.providerId === 'good'),
    ).toMatchObject({
      status: 'login_required',
      lastKnownCapabilityNames: ['read'],
      diagnosticCode: 'auth_required',
    });
    expect(JSON.stringify(provider.getProviderDirectorySnapshot())).not.toContain('Bearer');
    await supervisor.stop();
  });

  test('projects resources only for currently callable effective providers', async () => {
    const manager = new FakeManager();
    manager.discoveredResources = [{ uri: 'docs://guide', name: 'Guide' }];
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => catalog(),
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);

    expect(supervisor.getResourceDirectorySnapshot().resources).toEqual([
      { providerId: 'good', uri: 'docs://guide', name: 'Guide' },
    ]);
    const current = manager.states.get('good');
    expect(current).toBeDefined();
    current!.health = 'disconnected';
    manager.emit();
    expect(supervisor.getResourceDirectorySnapshot().resources).toEqual([]);
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

  test('connects static-auth HTTP servers without registering an OAuth recovery flow', async () => {
    const manager = new FakeManager();
    const remote = httpEntry('remote', {
      type: 'environment',
      header: 'Authorization',
      env: 'MCP_TOKEN',
      scheme: 'Bearer',
    });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['remote', remote]]),
      connectableServers: { remote: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
    });

    await supervisor.start('/workspace');
    await Bun.sleep(0);

    expect(manager.reconnects).toHaveLength(1);
    expect(supervisor.getSnapshot().servers[0]).toMatchObject({
      health: 'ready',
      authStatus: 'not_required',
    });
    await supervisor.stop();
  });

  test('retries a transient initial HTTP connection at most three times', async () => {
    const manager = new FakeManager();
    manager.reconnectFailure = new Error('connection refused');
    const delays: number[] = [];
    let now = 0;
    const remote = httpEntry('startup-retry', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['startup-retry', remote]]),
      connectableServers: { 'startup-retry': remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      now: () => now,
    });

    await supervisor.start('/workspace');
    for (let turn = 0; turn < 10 && manager.reconnects.length < 3; turn++) {
      await Bun.sleep(0);
    }

    expect(manager.reconnects).toHaveLength(3);
    expect(delays).toEqual([1_000, 2_000]);
    await supervisor.stop();
  });

  test('reconnects an unavailable HTTP provider on demand but does not restart stdio', async () => {
    const manager = new FakeManager();
    const remote = httpEntry('remote', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['remote', remote]]),
      connectableServers: { remote: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    const remoteState = manager.states.get('remote')!;
    remoteState.health = 'disconnected';
    remoteState.diagnostic = diagnoseMcpError(new Error('connection refused'));
    manager.emit();
    const before = manager.reconnects.length;

    await supervisor.ensureProviderReady('remote', 1_000);
    expect(manager.reconnects.length).toBe(before + 1);
    expect(supervisor.getProviderDirectorySnapshot().entries[0]?.status).toBe('ready');
    await supervisor.stop();

    const stdioManager = new FakeManager();
    const stdioSupervisor = new DefaultMcpSupervisor({
      manager: stdioManager,
      loadCatalog: () => catalog(),
    });
    await stdioSupervisor.start('/workspace');
    await Bun.sleep(0);
    const stdio = stdioManager.states.get('good')!;
    stdio.health = 'disconnected';
    stdio.diagnostic = diagnoseMcpError(new Error('connection refused'));
    stdioManager.emit();
    const stdioBefore = stdioManager.reconnects.length;
    await expect(stdioSupervisor.ensureProviderReady('good', 1_000)).rejects.toMatchObject({
      kind: 'provider_unavailable',
    });
    expect(stdioManager.reconnects).toHaveLength(stdioBefore);
    await stdioSupervisor.stop();
  });

  test('does not let one provider recovery block a healthy provider', async () => {
    const manager = new FakeManager();
    const slowEntry = httpEntry('slow', { type: 'none' });
    const healthyEntry = httpEntry('healthy', { type: 'none' });
    const multiCatalog: McpConfigCatalog = {
      entries: [slowEntry, healthyEntry],
      effective: new Map([
        ['slow', slowEntry],
        ['healthy', healthyEntry],
      ]),
      connectableServers: {
        slow: slowEntry.normalizedConfig!,
        healthy: healthyEntry.normalizedConfig!,
      },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => multiCatalog,
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    const slow = manager.states.get('slow')!;
    slow.health = 'connecting';
    manager.emit();

    const controller = new AbortController();
    const recovering = supervisor.ensureProviderReady('slow', 30_000, controller.signal);
    await Bun.sleep(0);
    await expect(supervisor.ensureProviderReady('healthy', 10)).resolves.toBeUndefined();

    controller.abort();
    await expect(recovering).rejects.toMatchObject({ name: 'AbortError' });
    await supervisor.stop();
  });

  test('aborts an in-flight provider recovery without publishing a late connection', async () => {
    const manager = new FakeManager();
    const remote = httpEntry('abortable', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['abortable', remote]]),
      connectableServers: { abortable: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    const current = manager.states.get('abortable')!;
    current.health = 'connecting';
    manager.emit();
    const controller = new AbortController();

    const recovering = supervisor.ensureProviderReady('abortable', 30_000, controller.signal);
    await Bun.sleep(0);
    controller.abort();
    await expect(recovering).rejects.toMatchObject({ name: 'AbortError' });

    expect(manager.states.get('abortable')?.health).not.toBe('ready');
    await supervisor.stop();
  });

  test('bounds an HTTP recovery wait and returns a typed unavailable failure', async () => {
    const manager = new FakeManager();
    const remote = httpEntry('slow', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['slow', remote]]),
      connectableServers: { slow: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    const slow = manager.states.get('slow')!;
    slow.health = 'disconnected';
    slow.diagnostic = diagnoseMcpError(new Error('connection refused'));
    manager.connectGate = new Promise(() => {});
    manager.emit();
    const startedAt = Date.now();

    await expect(supervisor.ensureProviderReady('slow', 25)).rejects.toMatchObject({
      name: 'McpProviderError',
      kind: 'provider_unavailable',
      retryable: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
    await supervisor.stop();
  });

  test('waits for an in-flight HTTP connection instead of starting a competing reconnect', async () => {
    const manager = new FakeManager();
    let release = () => {};
    manager.connectGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remote = httpEntry('inflight', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['inflight', remote]]),
      connectableServers: { inflight: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
    });
    await supervisor.start('/workspace');
    const initialAttempts = manager.reconnects.length;
    const waiting = supervisor.ensureProviderReady('inflight', 1_000);
    release();
    await waiting;

    expect(manager.reconnects).toHaveLength(initialAttempts);
    expect(supervisor.getProviderDirectorySnapshot().entries[0]?.status).toBe('ready');
    await supervisor.stop();
  });

  test('uses five bounded exponential backoffs for a retryable session reconnect', async () => {
    const manager = new FakeManager();
    const delays: number[] = [];
    let now = 0;
    const remote = httpEntry('retrying', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['retrying', remote]]),
      connectableServers: { retrying: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      now: () => now,
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    manager.reconnectFailure = new Error('connection refused');
    const current = manager.states.get('retrying')!;
    current.health = 'disconnected';
    current.diagnostic = diagnoseMcpError(manager.reconnectFailure);
    manager.emit();
    const before = manager.reconnects.length;

    await expect(supervisor.ensureProviderReady('retrying', 60_000)).rejects.toMatchObject({
      kind: 'provider_unavailable',
      retryable: true,
    });
    expect(manager.reconnects.length - before).toBe(6);
    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    await supervisor.stop();
  });

  test('truncates exponential backoff at the remaining reconnect deadline', async () => {
    const manager = new FakeManager();
    const delays: number[] = [];
    let now = 0;
    const remote = httpEntry('deadline', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['deadline', remote]]),
      connectableServers: { deadline: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      now: () => now,
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    manager.reconnectFailure = new Error('connection refused');
    const current = manager.states.get('deadline')!;
    current.health = 'disconnected';
    current.diagnostic = diagnoseMcpError(manager.reconnectFailure);
    manager.emit();
    const before = manager.reconnects.length;

    await expect(supervisor.ensureProviderReady('deadline', 2_500)).rejects.toMatchObject({
      kind: 'provider_unavailable',
    });
    expect(manager.reconnects.length - before).toBe(2);
    expect(delays).toEqual([1_000, 1_500]);
    expect(now).toBe(2_500);
    await supervisor.stop();
  });

  test('counts time spent waiting in the supervisor queue against the reconnect budget', async () => {
    const manager = new FakeManager();
    const remote = httpEntry('queued', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['queued', remote]]),
      connectableServers: { queued: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    let releaseLoad = () => {};
    let loadCount = 0;
    const repository: McpConfigRepository = {
      load: async () => {
        loadCount += 1;
        if (loadCount > 1) {
          await new Promise<void>((resolve) => {
            releaseLoad = resolve;
          });
        }
        return remoteCatalog;
      },
      mutate: async () => remoteCatalog,
      watch: () => () => {},
    };
    let now = 0;
    const supervisor = new DefaultMcpSupervisor({
      manager,
      repository,
      now: () => now,
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    const current = manager.states.get('queued')!;
    current.health = 'disconnected';
    current.diagnostic = diagnoseMcpError(new Error('connection refused'));
    manager.emit();
    const before = manager.reconnects.length;

    const reload = supervisor.reload();
    await Bun.sleep(0);
    const waiting = supervisor.ensureProviderReady('queued', 30);
    now = 31;
    releaseLoad();
    await reload;

    await expect(waiting).rejects.toMatchObject({ kind: 'provider_unavailable' });
    expect(manager.reconnects).toHaveLength(before);
    await supervisor.stop();
  });

  test('does not retry a non-retryable authentication failure', async () => {
    const manager = new FakeManager();
    const delays: number[] = [];
    let now = 0;
    const remote = httpEntry('login', { type: 'none' });
    const remoteCatalog: McpConfigCatalog = {
      entries: [remote],
      effective: new Map([['login', remote]]),
      connectableServers: { login: remote.normalizedConfig! },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => remoteCatalog,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      now: () => now,
    });
    await supervisor.start('/workspace');
    await Bun.sleep(0);
    manager.reconnectFailure = new Error('401 Unauthorized');
    const current = manager.states.get('login')!;
    current.health = 'disconnected';
    current.diagnostic = diagnoseMcpError(manager.reconnectFailure);
    manager.emit();
    const before = manager.reconnects.length;

    await expect(supervisor.ensureProviderReady('login', 60_000)).rejects.toMatchObject({
      kind: 'provider_auth_required',
      retryable: false,
    });
    expect(manager.reconnects.length - before).toBe(1);
    expect(delays).toEqual([]);
    await supervisor.stop();
  });

  test('projects visibility, effective policy, schema quarantine, and missing Tool diagnostics', async () => {
    const manager = new FakeManager();
    manager.discoveredTools = [
      {
        name: 'read',
        description: 'Read data',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
      } as SdkTool,
      { name: 'broken', inputSchema: { type: 'string' } } as unknown as SdkTool,
    ];
    const configured = entry('policy', 'user', 'not_required');
    configured.rawConfig = {
      type: 'stdio',
      command: 'bun',
      enabledTools: ['read', 'missing'],
    };
    configured.normalizedConfig = {
      type: 'stdio',
      command: 'bun',
      enabledTools: ['read', 'missing'],
      trust: { provenance: 'user', allowAnnotations: 'read_only' },
      tools: {
        read: { minimumApproval: 'none', retry: 'safe_read' },
        missing: { enabled: false },
      },
    };
    const policyCatalog: McpConfigCatalog = {
      entries: [configured],
      effective: new Map([['policy', configured]]),
      connectableServers: { policy: configured.normalizedConfig },
      projectApprovals: [],
      diagnostics: [],
      workspace: '/workspace',
      sourceRevisions: { local: 'local', project: 'project', user: 'user' },
    };
    const supervisor = new DefaultMcpSupervisor({
      manager,
      loadCatalog: () => policyCatalog,
    });

    await supervisor.start('/workspace');
    await Bun.sleep(0);

    const server = supervisor.getSnapshot().servers[0]!;
    expect(server).toMatchObject({ toolCount: 2, availableToolCount: 1 });
    expect(server.tools.find((tool) => tool.name === 'read')).toMatchObject({
      discovered: true,
      enabled: true,
      availability: 'available',
      available: true,
      annotationProvenance: 'user',
      policySource: 'user',
      minimumApproval: 'none',
      retry: 'safe_read',
      effectiveEffects: {
        filesystem: 'read',
        network: 'read',
        externalState: 'read',
      },
    });
    expect(server.tools.find((tool) => tool.name === 'broken')).toMatchObject({
      discovered: true,
      enabled: false,
      availability: 'quarantined',
      available: false,
      diagnostic: { code: 'invalid_schema' },
    });
    expect(server.tools.find((tool) => tool.name === 'missing')).toMatchObject({
      discovered: false,
      enabled: false,
      availability: 'unavailable',
      available: false,
      diagnostic: { code: 'tool_not_discovered' },
    });
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

function httpEntry(name: string, auth: NonNullable<McpServerConfig['auth']>): McpServerConfigEntry {
  const config: McpServerConfig = {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
    auth,
  };
  return {
    name,
    source: { kind: 'user', path: '/home/config.jsonc', workspace: '/workspace' },
    rawConfig: { type: 'http', url: config.url, auth },
    normalizedConfig: config,
    revision: `user:${name}:revision`,
    providerConfigDigest: `user:${name}:provider`,
    enabled: true,
    approvalStatus: 'not_required',
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
