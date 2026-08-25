import { describe, expect, test } from 'bun:test';
import type {
  McpProviderDirectoryEntry,
  McpProviderDirectorySnapshot,
  McpProviderDirectoryStatus,
} from '@kite/builtin-runtime/mcp';
import {
  buildMcpInventory,
  type McpInventoryResult,
  type McpInventorySuccess,
  mcpProviderInventoryNextAction,
} from '@kite/builtin-runtime/mcp';
import { createCapabilitySnapshot } from '@kite/builtin-runtime/skills';
import type { CapabilityDescriptor } from '@kite/runtime-contract';

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

function skillDescriptor(opts: { id: string; name: string }): CapabilityDescriptor {
  return {
    capabilityId: `skill:${opts.id}`,
    revision: `rev-skill-${opts.id}`,
    kind: 'skill',
    displayName: opts.name,
    description: `Skill ${opts.name}`,
    provider: { type: 'builtin', id: 'skills', provenance: 'builtin' },
    inputSchema: { type: 'object', properties: {} },
    declaredEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
    effectiveEffects: { filesystem: 'none', network: 'none', externalState: 'none' },
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
    availability: 'available',
    diagnostics: [],
  };
}

function providerEntry(opts: {
  id: string;
  status: McpProviderDirectoryStatus;
  required?: boolean;
  toolNames?: string[];
  diagnosticCode?: string;
}): McpProviderDirectoryEntry {
  return {
    providerId: opts.id,
    status: opts.status,
    required: opts.required ?? false,
    source: 'user',
    lastKnownCapabilityNames: opts.toolNames ?? [],
    retryable: opts.status === 'failed' || opts.status === 'connecting',
    ...(opts.diagnosticCode
      ? {
          diagnosticCode:
            opts.diagnosticCode as import('@kite/builtin-runtime/mcp').McpDiagnosticCode,
        }
      : {}),
  };
}

function directorySnapshot(entries: McpProviderDirectoryEntry[]): McpProviderDirectorySnapshot {
  return { revision: 'dir-rev-1', entries };
}

function success(result: McpInventoryResult): asserts result is McpInventorySuccess {
  if (!result.ok) throw new Error(`Expected ok but got: ${JSON.stringify(result)}`);
}

// ── tests ──

describe('buildMcpInventory', () => {
  // 1. no providers, no tools
  test('returns empty inventory when nothing is configured', () => {
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers: directorySnapshot([]),
      query: {},
    });
    success(result);
    expect(result.configured_provider_count).toBe(0);
    expect(result.callable_provider_count).toBe(0);
    expect(result.available_tool_count).toBe(0);
    expect(result.providers).toEqual([]);
    expect(result.tools).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  // 2. one ready provider with multiple tools
  test('returns tools for a single ready provider', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 't1', name: 'create_issue', providerId: 'github' }),
      toolDescriptor({ id: 't2', name: 'get_pr', providerId: 'github' }),
      toolDescriptor({ id: 't3', name: 'list_repos', providerId: 'github' }),
    ]);
    const providers = directorySnapshot([
      providerEntry({
        id: 'github',
        status: 'ready',
        toolNames: ['create_issue', 'get_pr', 'list_repos'],
      }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: {} });
    success(result);
    expect(result.configured_provider_count).toBe(1);
    expect(result.callable_provider_count).toBe(1);
    expect(result.available_tool_count).toBe(3);
    expect(result.providers[0]).toMatchObject({
      name: 'github',
      status: 'ready',
      available_tool_count: 3,
    });
    expect(result.tools.map((t) => t.name)).toEqual(['create_issue', 'get_pr', 'list_repos']);
  });

  // 3. provider ready, but resource count is 0 (irrelevant — inventory shouldn't care)
  test('lists tools even when provider has zero resources', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 't1', name: 'search', providerId: 'db' }),
    ]);
    const providers = directorySnapshot([
      providerEntry({ id: 'db', status: 'ready', toolNames: ['search'] }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: {} });
    success(result);
    expect(result.available_tool_count).toBe(1);
    expect(result.tools[0]!.name).toBe('search');
  });

  // 4. login_required
  test('reports login_required provider with next_action', () => {
    const providers = directorySnapshot([providerEntry({ id: 'db', status: 'login_required' })]);
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers,
      query: {},
    });
    success(result);
    expect(result.configured_provider_count).toBe(1);
    expect(result.callable_provider_count).toBe(0);
    expect(result.providers[0]).toMatchObject({
      name: 'db',
      status: 'login_required',
      next_action: 'authenticate',
    });
  });

  // 5. pending_approval
  test('reports pending_approval provider with next_action', () => {
    const providers = directorySnapshot([
      providerEntry({ id: 'github', status: 'pending_approval' }),
    ]);
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers,
      query: {},
    });
    success(result);
    expect(result.providers[0]).toMatchObject({
      status: 'pending_approval',
      next_action: 'approve_project_provider',
    });
  });

  // 6. degraded
  test('counts degraded provider as callable', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 't1', name: 'search', providerId: 'db' }),
    ]);
    const providers = directorySnapshot([
      providerEntry({ id: 'db', status: 'degraded', toolNames: ['search'] }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: {} });
    success(result);
    expect(result.callable_provider_count).toBe(1);
    expect(result.providers[0]).toMatchObject({
      status: 'degraded',
      next_action: 'retry_if_needed',
    });
  });

  // 7. disabled
  test('reports disabled provider with enable action', () => {
    const providers = directorySnapshot([providerEntry({ id: 'db', status: 'disabled' })]);
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers,
      query: {},
    });
    success(result);
    expect(result.providers[0]).toMatchObject({
      status: 'disabled',
      next_action: 'enable_provider',
    });
    expect(result.callable_provider_count).toBe(0);
  });

  // 8. provider exists but has zero tools
  test('shows provider with 0 tools when none are available', () => {
    const providers = directorySnapshot([
      providerEntry({ id: 'db', status: 'ready', toolNames: [] }),
    ]);
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers,
      query: {},
    });
    success(result);
    expect(result.configured_provider_count).toBe(1);
    expect(result.callable_provider_count).toBe(1);
    expect(result.available_tool_count).toBe(0);
    expect(result.providers[0]!.available_tool_count).toBe(0);
  });

  // 9. provider in Capability Snapshot but not in Directory (defensive backfill)
  test('backfills provider from capability snapshot when directory is missing it', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 't1', name: 'run', providerId: 'orphan' }),
    ]);
    const result = buildMcpInventory({
      capabilities,
      providers: directorySnapshot([]),
      query: {},
    });
    success(result);
    expect(result.configured_provider_count).toBe(1);
    expect(result.providers[0]).toMatchObject({
      name: 'orphan',
      status: 'ready',
      source: 'explicit',
      available_tool_count: 1,
    });
  });

  // 10. provider in Directory but no tools in Capability Snapshot
  test('reports provider from directory even when capabilities are empty', () => {
    const providers = directorySnapshot([
      providerEntry({ id: 'db', status: 'ready', toolNames: ['search', 'insert'] }),
    ]);
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers,
      query: {},
    });
    success(result);
    expect(result.configured_provider_count).toBe(1);
    expect(result.providers[0]!.last_known_tool_count).toBe(2);
    expect(result.available_tool_count).toBe(0);
  });

  // 11. provider exact filter
  test('filters tools by provider name', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 't1', name: 'a', providerId: 'github' }),
      toolDescriptor({ id: 't2', name: 'b', providerId: 'db' }),
    ]);
    const providers = directorySnapshot([
      providerEntry({ id: 'github', status: 'ready', toolNames: ['a'] }),
      providerEntry({ id: 'db', status: 'ready', toolNames: ['b'] }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: { provider: 'github' } });
    success(result);
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]!.name).toBe('github');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe('a');
  });

  // 12. unknown provider
  test('fails with unknown_provider for nonexistent name', () => {
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers: directorySnapshot([]),
      query: { provider: 'nonexistent' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('unknown_provider');
    }
  });

  // 13. stable sorting
  test('sorts providers and tools stably', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 'z', name: 'zeta', providerId: 'b-provider' }),
      toolDescriptor({ id: 'a', name: 'alpha', providerId: 'b-provider' }),
      toolDescriptor({ id: 'm', name: 'middle', providerId: 'a-provider' }),
    ]);
    const providers = directorySnapshot([
      providerEntry({ id: 'b-provider', status: 'ready', toolNames: ['zeta', 'alpha'] }),
      providerEntry({ id: 'a-provider', status: 'ready', toolNames: ['middle'] }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: {} });
    success(result);
    expect(result.providers.map((p) => p.name)).toEqual(['a-provider', 'b-provider']);
    expect(result.tools.map((t) => `${t.provider}/${t.name}`)).toEqual([
      'a-provider/middle',
      'b-provider/alpha',
      'b-provider/zeta',
    ]);
  });

  // 14. limit
  test('respects limit parameter', () => {
    const descriptors = Array.from({ length: 10 }, (_, i) =>
      toolDescriptor({ id: `t${i}`, name: `tool_${i}`, providerId: 'p' }),
    );
    const providers = directorySnapshot([
      providerEntry({ id: 'p', status: 'ready', toolNames: descriptors.map((d) => d.displayName) }),
    ]);
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot(descriptors),
      providers,
      query: { limit: 3 },
    });
    success(result);
    expect(result.tools).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  // 15. cursor pagination
  test('paginates with stable cursor', () => {
    const descriptors = Array.from({ length: 5 }, (_, i) =>
      toolDescriptor({ id: `t${i}`, name: `tool_${i}`, providerId: 'p' }),
    );
    const providers = directorySnapshot([
      providerEntry({ id: 'p', status: 'ready', toolNames: descriptors.map((d) => d.displayName) }),
    ]);
    const capabilities = createCapabilitySnapshot(descriptors);

    // page 1
    const page1 = buildMcpInventory({ capabilities, providers, query: { limit: 3 } });
    success(page1);
    expect(page1.tools).toHaveLength(3);
    expect(page1.truncated).toBe(true);
    expect(page1.next_cursor).toBeDefined();

    // page 2
    const page2 = buildMcpInventory({
      capabilities,
      providers,
      query: { limit: 3, cursor: page1.next_cursor },
    });
    success(page2);
    expect(page2.tools).toHaveLength(2);
    expect(page2.truncated).toBe(false);
    expect(page2.next_cursor).toBeUndefined();

    // all tools unique across pages
    const allNames = [...page1.tools, ...page2.tools].map((t) => t.name);
    expect(new Set(allNames).size).toBe(5);
  });

  // 16. stale cursor
  test('rejects cursor when catalog revision changed', () => {
    const descriptors = Array.from({ length: 5 }, (_, i) =>
      toolDescriptor({ id: `t${i}`, name: `tool_${i}`, providerId: 'p' }),
    );
    const providers = directorySnapshot([
      providerEntry({ id: 'p', status: 'ready', toolNames: descriptors.map((d) => d.displayName) }),
    ]);
    const cap1 = createCapabilitySnapshot(descriptors);
    const page1 = buildMcpInventory({ capabilities: cap1, providers, query: { limit: 3 } });
    success(page1);

    // mutate the snapshot
    const cap2 = createCapabilitySnapshot([
      ...descriptors,
      toolDescriptor({ id: 't99', name: 'new_tool', providerId: 'p' }),
    ]);

    const result = buildMcpInventory({
      capabilities: cap2,
      providers,
      query: { limit: 3, cursor: page1.next_cursor },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('stale_cursor');
  });

  // 17. invalid cursor
  test('rejects malformed cursor', () => {
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers: directorySnapshot([]),
      query: { cursor: 'not-valid-base64!!!' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_cursor');
  });

  // 18. duplicate descriptor dedup
  test('deduplicates identical tools from same provider', () => {
    const t = toolDescriptor({ id: 'dup', name: 'run', providerId: 'p' });
    const capabilities = createCapabilitySnapshot([t, { ...t }]); // same capabilityId, different object
    const providers = directorySnapshot([
      providerEntry({ id: 'p', status: 'ready', toolNames: ['run'] }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: {} });
    success(result);
    expect(result.tools).toHaveLength(1);
    expect(result.available_tool_count).toBe(1); // deduped unique tools
  });

  // 19. quarantined tool excluded
  test('excludes quarantined tools from available count', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 'ok', name: 'safe', providerId: 'p', availability: 'available' }),
      toolDescriptor({ id: 'bad', name: 'unsafe', providerId: 'p', availability: 'quarantined' }),
    ]);
    const providers = directorySnapshot([
      providerEntry({ id: 'p', status: 'degraded', toolNames: ['safe'] }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: {} });
    success(result);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe('safe');
  });

  // 20. skill excluded from inventory
  test('excludes skills from MCP inventory', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 'mcp1', name: 'mcp_tool', providerId: 'p' }),
      skillDescriptor({ id: 's1', name: 'my_skill' }),
    ]);
    const providers = directorySnapshot([
      providerEntry({ id: 'p', status: 'ready', toolNames: ['mcp_tool'] }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: {} });
    success(result);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]!.name).toBe('mcp_tool');
    // no "my_skill" in tools
    expect(result.tools.find((t) => t.name === 'my_skill')).toBeUndefined();
  });
});

describe('mcpProviderInventoryNextAction', () => {
  test('maps all non-ready statuses to actions', () => {
    expect(mcpProviderInventoryNextAction('pending_approval')).toBe('approve_project_provider');
    expect(mcpProviderInventoryNextAction('rejected')).toBe('review_project_approval');
    expect(mcpProviderInventoryNextAction('disabled')).toBe('enable_provider');
    expect(mcpProviderInventoryNextAction('login_required')).toBe('authenticate');
    expect(mcpProviderInventoryNextAction('connecting')).toBe('wait_or_retry');
    expect(mcpProviderInventoryNextAction('failed')).toBe('retry_connection');
    expect(mcpProviderInventoryNextAction('degraded')).toBe('retry_if_needed');
    expect(mcpProviderInventoryNextAction('quarantined')).toBe('fix_configuration_or_schema');
  });

  test('returns undefined for ready', () => {
    expect(mcpProviderInventoryNextAction('ready')).toBeUndefined();
  });
});

describe('McpInventoryResult serialization safety', () => {
  test('does not leak capabilityId, revision, or schema in output', () => {
    const capabilities = createCapabilitySnapshot([
      toolDescriptor({ id: 'sensitive', name: 'public_name', providerId: 'p' }),
    ]);
    const providers = directorySnapshot([
      providerEntry({ id: 'p', status: 'ready', toolNames: ['public_name'] }),
    ]);
    const result = buildMcpInventory({ capabilities, providers, query: {} });
    const json = JSON.stringify(result);
    expect(json).not.toContain('capabilityId');
    expect(json).not.toContain('revision');
    expect(json).not.toContain('inputSchema');
    expect(json).not.toContain('outputSchema');
    expect(json).not.toContain('binding');
    expect(json).not.toContain('credential');
    expect(json).not.toContain('transport');
    expect(json).not.toContain('mcp:sensitive');
  });
});

describe('McpInventoryResult invalid_limit', () => {
  test('rejects limit < 1', () => {
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers: directorySnapshot([]),
      query: { limit: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_limit');
  });

  test('rejects limit > 100', () => {
    const result = buildMcpInventory({
      capabilities: createCapabilitySnapshot([]),
      providers: directorySnapshot([]),
      query: { limit: 101 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_limit');
  });
});
