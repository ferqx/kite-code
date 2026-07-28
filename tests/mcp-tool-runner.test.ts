import { describe, expect, test } from 'bun:test';
import type { AgentConfig } from '@/core/config';
import { resolveResourceBudgets } from '@/core/config/resource-budgets';
import { toolRequestFromCall } from '@/core/harness/tool-requests';
import { runApprovedTool } from '@/core/harness/tool-runner';
import type { McpRuntimeProvider } from '@/core/mcp';
import type { CapabilityDescriptor } from '@/protocol/capabilities';

function request(name = 'mcp__docs__search_docs') {
  const parsed = toolRequestFromCall(
    { id: 'mcp-call', name, args: { query: 'runtime' } },
    process.cwd(),
  );
  if (!parsed?.ok) throw new Error('Failed to construct MCP request.');
  return parsed.request;
}

function provider(
  callCapability: McpRuntimeProvider['callCapability'],
  toolName = 'search_docs',
): McpRuntimeProvider {
  const descriptor: CapabilityDescriptor = {
    capabilityId: `mcp:docs/${toolName}`,
    revision: 'revision',
    kind: 'mcp_tool',
    displayName: toolName,
    description: 'fixture',
    provider: { type: 'mcp', id: 'docs', provenance: 'remote' },
    inputSchema: { type: 'object' },
    declaredEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
    effectiveEffects: { filesystem: 'none', network: 'read', externalState: 'read' },
    policy: { workspaceTrustRequired: false, minimumApproval: 'none' },
    availability: 'available',
    diagnostics: [],
  };
  return {
    getCapabilitySnapshot: () => ({ revision: 'snapshot', descriptors: [descriptor] }),
    getProviderDirectorySnapshot: () => ({ revision: 'directory', entries: [] }),
    getResourceDirectorySnapshot: () => ({ revision: 'resources', resources: [] }),
    findCapability: () => descriptor,
    callCapability,
    readResource: async () => '',
  };
}

describe('MCP tool runner', () => {
  test('forwards cancellation to the protocol call', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const result = await runApprovedTool({
      workspace: process.cwd(),
      request: request(),
      authorization: {
        mode: 'full_access',
        commandGrants: {},
      },
      signal: controller.signal,
      mcpPolicy: {
        effects: { filesystem: 'none', network: 'read', externalState: 'read' },
        minimumApproval: 'none',
      },
      mcpManager: provider(async (invocation) => {
        observedSignal = invocation.signal;
        return { content: [] };
      }),
      mcpInvocation: { capabilityId: 'mcp:docs/search_docs', expectedRevision: 'revision' },
    });

    expect(result.ok).toBe(true);
    expect(observedSignal).toBe(controller.signal);
  });

  test('bounds oversized MCP output before it enters the model transcript', async () => {
    const result = await runApprovedTool({
      workspace: process.cwd(),
      request: request(),
      authorization: {
        mode: 'full_access',
        commandGrants: {},
      },
      mcpPolicy: {
        effects: { filesystem: 'none', network: 'read', externalState: 'read' },
        minimumApproval: 'none',
      },
      mcpManager: provider(async () => ({
        content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }],
      })),
      mcpInvocation: { capabilityId: 'mcp:docs/search_docs', expectedRevision: 'revision' },
    });

    expect(result.ok).toBe(true);
    expect(result.stdout.length).toBeLessThan(140 * 1024);
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'partial',
      truncated: true,
    });
    expect(result.capabilityResult?.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringMatching(/^x+$/),
    });
  });

  test('binds MCP calls to the configured absolute deadline', async () => {
    let observedDeadlineAt: number | undefined;
    const startedAt = Date.now();
    const result = await runApprovedTool({
      workspace: process.cwd(),
      request: request(),
      authorization: { mode: 'full_access', commandGrants: {} },
      mcpPolicy: {
        effects: { filesystem: 'none', network: 'read', externalState: 'read' },
        minimumApproval: 'none',
      },
      taskConfig: {
        features: { boundedExecutionV1: true },
        resourceBudgets: resolveResourceBudgets({ mcpCallMs: 123 }),
      } as AgentConfig,
      mcpManager: provider(async (invocation) => {
        observedDeadlineAt = invocation.deadlineAt;
        return { content: [] };
      }),
      mcpInvocation: { capabilityId: 'mcp:docs/search_docs', expectedRevision: 'revision' },
    });

    expect(result.ok).toBe(true);
    expect(observedDeadlineAt).toBeGreaterThanOrEqual(startedAt + 123);
    expect(observedDeadlineAt).toBeLessThanOrEqual(Date.now() + 123);
  });
});
