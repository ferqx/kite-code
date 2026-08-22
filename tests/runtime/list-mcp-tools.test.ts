import { describe, expect, test } from 'bun:test';
import { toolRequestFromCall } from '@kite/builtin-runtime';
import type {
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
  McpResourceDirectorySnapshot,
  McpRuntimeProvider,
} from '@kite/builtin-runtime/mcp';
import type { CapabilityDescriptor, CapabilitySnapshot } from '@kite/runtime-contract';
import { createRuntimeHostState26InitialStateV1 } from '@kite/runtime-host';
import { createCapabilityBindingV1 } from '#builtin-runtime';
import {
  createTestAgentToolsV1 as createAgentTools,
  executeTestRuntimeToolsV1,
  testBuiltinToolCatalogV1,
} from '../helpers/runtime-model';

// ── helpers ──

function toolDescriptor(opts: {
  id: string;
  name: string;
  providerId: string;
  kind?: CapabilityDescriptor['kind'];
  availability?: CapabilityDescriptor['availability'];
}): CapabilityDescriptor {
  return {
    capabilityId: `mcp:${opts.providerId}/${opts.id}`,
    revision: `rev-${opts.providerId}-${opts.id}`,
    kind: opts.kind ?? 'mcp_tool',
    displayName: opts.name,
    description: `Tool ${opts.name}`,
    provider: { type: 'mcp', id: opts.providerId, provenance: 'remote' },
    inputSchema: { type: 'object', properties: {} },
    declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
    effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
    availability: opts.availability ?? 'available',
    diagnostics: [],
  };
}

function providerEntry(opts: {
  id: string;
  status: McpProviderDirectoryEntry['status'];
  required?: boolean;
  toolNames?: string[];
}): McpProviderDirectoryEntry {
  return {
    providerId: opts.id,
    status: opts.status,
    required: opts.required ?? false,
    source: 'user',
    lastKnownCapabilityNames: opts.toolNames ?? [],
    retryable: opts.status === 'failed' || opts.status === 'connecting',
  };
}

function makeProvider(
  descriptors: CapabilityDescriptor[],
  entries: McpProviderDirectoryEntry[],
): McpRuntimeProvider {
  const capabilities: CapabilitySnapshot = {
    revision: 'cap-rev-1',
    descriptors,
  };
  const dir: McpProviderDirectorySnapshot = {
    revision: 'dir-rev-1',
    entries,
  };
  const resources: McpResourceDirectorySnapshot = {
    revision: 'res-rev-1',
    resources: [],
  };
  return {
    getCapabilitySnapshot: () => capabilities,
    getProviderDirectorySnapshot: () => dir,
    getResourceDirectorySnapshot: () => resources,
    findCapability: () => undefined,
    callCapability: async () => {
      throw new Error('not implemented');
    },
    readResource: async () => '',
  };
}

function makeListMcpToolsRequest(args: Record<string, unknown> = {}) {
  const result = toolRequestFromCall(
    { id: 'list-tools', name: 'list_mcp_tools', args },
    process.cwd(),
    testBuiltinToolCatalogV1(),
  );
  if (!result?.ok) throw new Error('Failed to construct list_mcp_tools request.');
  return result.request;
}

async function invokeGovernedTool(input: {
  workspace: string;
  request: ReturnType<typeof makeListMcpToolsRequest>;
  mcpManager?: McpRuntimeProvider;
}) {
  const state = createRuntimeHostState26InitialStateV1({
    recoveryIdentityKey: '0'.repeat(64),
    threadId: 'list-mcp-tools-test',
    userId: 'test',
    workspace: input.workspace,
  });
  state.authorization.mode = 'full_access';
  state.tools.calls['list-tools'] = {
    toolCallId: 'list-tools',
    modelMessageId: 'list-mcp-tools-test-model',
    name: 'list_mcp_tools',
    args: input.request.args,
    status: 'queued',
    createdAtTurnId: state.turn.turnId,
  };
  state.tools.queue = [...state.tools.queue, 'list-tools'];
  const events = await executeTestRuntimeToolsV1({
    state,
    toolCallIds: ['list-tools'],
    sandboxAvailable: true,
    ...(input.mcpManager ? { mcpManager: input.mcpManager } : {}),
  });
  const terminal = events.find(
    (event): event is Extract<(typeof events)[number], { type: 'tool.finished' }> =>
      event.type === 'tool.finished' && event.toolCallId === 'list-tools',
  );
  if (terminal) {
    return {
      ok: terminal.result.ok,
      stdout: terminal.result.stdout,
      stderr: terminal.result.stderr,
    };
  }
  const failed = events.find(
    (event): event is Extract<(typeof events)[number], { type: 'tool.failed' | 'tool.rejected' }> =>
      (event.type === 'tool.failed' || event.type === 'tool.rejected') &&
      event.toolCallId === 'list-tools',
  );
  return {
    ok: false,
    stdout: '',
    stderr: failed?.type === 'tool.failed' ? failed.failure.message : (failed?.reason ?? ''),
  };
}

// ── tests ──

describe('list_mcp_tools runtime', () => {
  test('is present in the builtin tool set', () => {
    const tools = createAgentTools({ workspace: '/tmp' });
    expect(tools.list_mcp_tools).toBeDefined();
  });

  test('fails closed when mcpManager is missing', async () => {
    const req = makeListMcpToolsRequest();
    const result = await invokeGovernedTool({
      workspace: '/tmp',
      request: req,
    });
    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('execution mechanism');
    expect(result.stderr).toContain('unavailable');
  });

  test('returns provider and tool inventory through tool runner', async () => {
    const mcpManager = makeProvider(
      [
        toolDescriptor({ id: 't1', name: 'create_issue', providerId: 'github' }),
        toolDescriptor({ id: 't2', name: 'list_repos', providerId: 'github' }),
      ],
      [providerEntry({ id: 'github', status: 'ready', toolNames: ['create_issue', 'list_repos'] })],
    );

    const req = makeListMcpToolsRequest();
    const result = await invokeGovernedTool({
      workspace: '/tmp',
      request: req,
      mcpManager,
    });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.configured_provider_count).toBe(1);
    expect(parsed.callable_provider_count).toBe(1);
    expect(parsed.available_tool_count).toBe(2);
    expect(parsed.providers[0]).toMatchObject({
      name: 'github',
      status: 'ready',
      available_tool_count: 2,
    });
    expect(parsed.tools).toEqual([
      { provider: 'github', name: 'create_issue' },
      { provider: 'github', name: 'list_repos' },
    ]);
  });

  test('Tool > 0, Resource = 0 — still lists tools and does not mention resources', async () => {
    const mcpManager = makeProvider(
      [toolDescriptor({ id: 't1', name: 'search', providerId: 'db' })],
      [providerEntry({ id: 'db', status: 'ready', toolNames: ['search'] })],
    );
    // Resource directory is empty (default)

    const req = makeListMcpToolsRequest();
    const result = await invokeGovernedTool({
      workspace: '/tmp',
      request: req,
      mcpManager,
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.available_tool_count).toBe(1);
    // Tool output must not contain resource-related fields
    expect(JSON.stringify(parsed)).not.toContain('resource_count');
    expect(JSON.stringify(parsed)).not.toContain('resource');
  });

  test('reports login_required provider with authenticate action', async () => {
    const mcpManager = makeProvider([], [providerEntry({ id: 'db', status: 'login_required' })]);

    const req = makeListMcpToolsRequest();
    const result = await invokeGovernedTool({
      workspace: '/tmp',
      request: req,
      mcpManager,
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.configured_provider_count).toBe(1);
    expect(parsed.callable_provider_count).toBe(0);
    expect(parsed.providers[0]).toMatchObject({
      name: 'db',
      status: 'login_required',
      next_action: 'authenticate',
    });
  });

  test('reports pending_approval provider with approve action', async () => {
    const mcpManager = makeProvider(
      [],
      [providerEntry({ id: 'github', status: 'pending_approval' })],
    );

    const req = makeListMcpToolsRequest();
    const result = await invokeGovernedTool({
      workspace: '/tmp',
      request: req,
      mcpManager,
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.providers[0]).toMatchObject({
      status: 'pending_approval',
      next_action: 'approve_project_provider',
    });
  });

  test('reports disabled and failed provider statuses distinctly', async () => {
    const mcpManager = makeProvider(
      [],
      [
        providerEntry({ id: 'disabled-svc', status: 'disabled' }),
        providerEntry({ id: 'failed-svc', status: 'failed' }),
      ],
    );

    const req = makeListMcpToolsRequest();
    const result = await invokeGovernedTool({
      workspace: '/tmp',
      request: req,
      mcpManager,
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.configured_provider_count).toBe(2);
    expect(parsed.callable_provider_count).toBe(0);
    const disabled = parsed.providers.find((p: { name: string }) => p.name === 'disabled-svc');
    const failed = parsed.providers.find((p: { name: string }) => p.name === 'failed-svc');
    expect(disabled).toMatchObject({ status: 'disabled', next_action: 'enable_provider' });
    expect(failed).toMatchObject({ status: 'failed', next_action: 'retry_connection' });
  });

  test('distinguishes empty config from unavailable providers', async () => {
    // Empty config
    const emptyManager = makeProvider([], []);
    const req1 = makeListMcpToolsRequest();
    const r1 = await invokeGovernedTool({
      workspace: '/tmp',
      request: req1,
      mcpManager: emptyManager,
    });
    const p1 = JSON.parse(r1.stdout);
    expect(p1.configured_provider_count).toBe(0);
    expect(p1.callable_provider_count).toBe(0);

    // Config exists but unavailable
    const unavailManager = makeProvider(
      [],
      [providerEntry({ id: 'db', status: 'login_required' })],
    );
    const req2 = makeListMcpToolsRequest();
    const r2 = await invokeGovernedTool({
      workspace: '/tmp',
      request: req2,
      mcpManager: unavailManager,
    });
    const p2 = JSON.parse(r2.stdout);
    expect(p2.configured_provider_count).toBe(1);
    expect(p2.callable_provider_count).toBe(0);
    // These must be distinguishable
    expect(p1.configured_provider_count).not.toBe(p2.configured_provider_count);
  });

  test('output does not contain sensitive fields', async () => {
    const mcpManager = makeProvider(
      [toolDescriptor({ id: 't1', name: 'public_tool', providerId: 'p' })],
      [providerEntry({ id: 'p', status: 'ready', toolNames: ['public_tool'] })],
    );

    const req = makeListMcpToolsRequest();
    const result = await invokeGovernedTool({
      workspace: '/tmp',
      request: req,
      mcpManager,
    });
    const json = JSON.stringify(JSON.parse(result.stdout));
    // must NOT leak internal identities
    expect(json).not.toContain('capabilityId');
    expect(json).not.toContain('"revision"');
    expect(json).not.toContain('inputSchema');
    expect(json).not.toContain('outputSchema');
    expect(json).not.toContain('"binding"');
    expect(json).not.toContain('credential');
    expect(json).not.toContain('transport');
    expect(json).not.toContain('header');
    expect(json).not.toContain('mcp:p/'); // capabilityId prefix
  });

  test('pagination: cursor works through tool runner', async () => {
    const descriptors = Array.from({ length: 5 }, (_, i) =>
      toolDescriptor({ id: `t${i}`, name: `tool_${String(i).padStart(2, '0')}`, providerId: 'p' }),
    );
    const entries = [
      providerEntry({
        id: 'p',
        status: 'ready',
        toolNames: descriptors.map((d) => d.displayName),
      }),
    ];
    const mcpManager = makeProvider(descriptors, entries);

    // page 1
    const req1 = makeListMcpToolsRequest({ limit: 3 });
    const r1 = await invokeGovernedTool({
      workspace: '/tmp',
      request: req1,
      mcpManager,
    });
    const p1 = JSON.parse(r1.stdout);
    expect(p1.tools).toHaveLength(3);
    expect(p1.truncated).toBe(true);
    expect(p1.next_cursor).toBeDefined();

    // page 2
    const req2 = makeListMcpToolsRequest({ limit: 3, cursor: p1.next_cursor });
    const r2 = await invokeGovernedTool({
      workspace: '/tmp',
      request: req2,
      mcpManager,
    });
    const p2 = JSON.parse(r2.stdout);
    expect(p2.tools).toHaveLength(2);
    expect(p2.truncated).toBe(false);

    // all tools unique
    const allNames = [...p1.tools, ...p2.tools].map((t: { name: string }) => t.name);
    expect(new Set(allNames).size).toBe(5);
  });

  test('stale cursor is rejected through tool runner', async () => {
    const descriptors = Array.from({ length: 5 }, (_, i) =>
      toolDescriptor({ id: `t${i}`, name: `tool_${i}`, providerId: 'p' }),
    );
    const mcpManager = makeProvider(descriptors, [
      providerEntry({
        id: 'p',
        status: 'ready',
        toolNames: descriptors.map((d) => d.displayName),
      }),
    ]);

    const req1 = makeListMcpToolsRequest({ limit: 2 });
    const r1 = await invokeGovernedTool({
      workspace: '/tmp',
      request: req1,
      mcpManager,
    });
    const p1 = JSON.parse(r1.stdout);

    // mutate snapshot by creating a new manager with a different revision
    const mutatedDescriptors = [
      ...descriptors,
      toolDescriptor({ id: 'new', name: 'new_tool', providerId: 'p' }),
    ];
    const mutatedManager = makeProvider(mutatedDescriptors, [
      providerEntry({ id: 'p', status: 'ready', toolNames: ['new_tool'] }),
    ]);
    // Override the revisions to simulate a catalog change
    const origGetCap = mutatedManager.getCapabilitySnapshot;
    const origGetDir = mutatedManager.getProviderDirectorySnapshot;
    mutatedManager.getCapabilitySnapshot = () => {
      const snap = origGetCap();
      return { ...snap, revision: 'cap-rev-2' };
    };
    mutatedManager.getProviderDirectorySnapshot = () => {
      const dir = origGetDir();
      return { ...dir, revision: 'dir-rev-2' };
    };

    const req2 = makeListMcpToolsRequest({ cursor: p1.next_cursor });
    const r2 = await invokeGovernedTool({
      workspace: '/tmp',
      request: req2,
      mcpManager: mutatedManager,
    });
    const p2 = JSON.parse(r2.stdout);
    expect(p2.ok).toBe(false);
    expect(p2.code).toBe('stale_cursor');
  });

  test('provider filter narrows results through tool runner', async () => {
    const mcpManager = makeProvider(
      [
        toolDescriptor({ id: 't1', name: 'a', providerId: 'github' }),
        toolDescriptor({ id: 't2', name: 'b', providerId: 'db' }),
      ],
      [
        providerEntry({ id: 'github', status: 'ready', toolNames: ['a'] }),
        providerEntry({ id: 'db', status: 'ready', toolNames: ['b'] }),
      ],
    );

    const req = makeListMcpToolsRequest({ provider: 'github' });
    const result = await invokeGovernedTool({
      workspace: '/tmp',
      request: req,
      mcpManager,
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0].name).toBe('github');
    expect(parsed.tools).toHaveLength(1);
  });
});

describe('list_mcp_tools in tool set completeness', () => {
  test('is excluded from mcpBindings dynamic tools (it is a builtin)', () => {
    const descriptor = toolDescriptor({ id: 'issue', name: 'create_issue', providerId: 'gh' });
    const tools = createAgentTools({
      workspace: '/tmp',
      mcpBindings: [
        {
          binding: createCapabilityBindingV1({
            capabilityId: descriptor.capabilityId,
            capabilityRevision: descriptor.revision,
            exposedToolName: 'mcp__gh__create_issue',
            inputSchema: descriptor.inputSchema ?? {},
            turnId: 't1',
          }),
          descriptor,
        },
      ],
    });
    expect(tools.list_mcp_tools).toBeDefined();
    expect(tools.mcp__gh__create_issue).toBeDefined();
  });
});
