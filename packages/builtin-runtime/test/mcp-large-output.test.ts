import { describe, expect, test } from 'bun:test';
import type { CapabilityExecutionContext, RuntimeJsonValue } from '@kite-ai/runtime-spi';
import { createRuntimeModuleRegistry } from '@kite-ai/runtime-spi';
import {
  type BuiltinMcpRuntimePort,
  createModelRuntimeModule,
  isBuiltinOperationExecutionValue,
  MODEL_CAPABILITY_REVISIONS_,
} from '../src/model/runtime-module';

const registry = createRuntimeModuleRegistry([createModelRuntimeModule()]);

async function execute(
  operationId: keyof typeof MODEL_CAPABILITY_REVISIONS_,
  input: Record<string, RuntimeJsonValue>,
  runtime: BuiltinMcpRuntimePort,
  invocation?: { capabilityId: string; expectedRevision: string },
) {
  const executor = registry.executor(operationId);
  if (!executor) throw new Error(`Missing ${operationId} executor`);
  const context: CapabilityExecutionContext = {
    grant: {
      grantId: 'grant',
      capabilityId: operationId,
      capabilityRevision: MODEL_CAPABILITY_REVISIONS_[operationId],
      authority: {},
    },
    requestDigest: 'request',
    signal: new AbortController().signal,
    environment: {
      environmentId: 'test',
      kind: 'in_process',
      mechanisms: { mcp: { runtime, ...(invocation ? { invocation } : {}) } },
    },
    attempt: { invocationId: 'invocation', attemptId: 'attempt' },
  };
  const receipt = await executor.execute(
    {
      invocationId: 'invocation',
      capabilityId: operationId,
      capabilityRevision: MODEL_CAPABILITY_REVISIONS_[operationId],
      input,
    },
    context,
  );
  if (!isBuiltinOperationExecutionValue(receipt.value)) {
    throw new Error(`${operationId} did not return a Builtin operation value`);
  }
  return receipt.value;
}

function runtime(overrides: Partial<BuiltinMcpRuntimePort> = {}): BuiltinMcpRuntimePort {
  return {
    getCapabilitySnapshot: () => ({}),
    getProviderDirectorySnapshot: () => ({}),
    getResourceDirectorySnapshot: () => ({}),
    findCapability: () => undefined,
    callCapability: async () => ({}),
    readResource: async () => '',
    ...overrides,
  };
}

describe('MCP model-facing output without fixed content quotas', () => {
  test('returns a large dynamic result after identity and output-schema checks', async () => {
    const text = 'complete result '.repeat(10_000);
    const value = await execute(
      'mcp:dynamic_tool',
      {
        capability_id: 'mcp:docs:search',
        capability_revision: 'revision-1',
        arguments: {},
      },
      runtime({
        findCapability: () => ({
          revision: 'revision-1',
          outputSchema: {
            type: 'object',
            properties: { result: { type: 'string' } },
            required: ['result'],
          },
        }),
        callCapability: async () => ({
          content: [{ type: 'text', text }],
          structuredContent: { result: text },
        }),
      }),
      { capabilityId: 'mcp:docs:search', expectedRevision: 'revision-1' },
    );
    expect(value.ok).toBe(true);
    expect(JSON.parse(value.stdout)).toMatchObject({
      status: 'success',
      content: [{ type: 'text', text }],
      structuredContent: { result: text },
    });
    expect(value.resultMeta).toMatchObject({ truncated: false });
    expect(value.capabilityResult).toMatchObject({ status: 'success' });
  });

  test('lists all tools and resources by default, preserving long names and explicit pagination', async () => {
    const providerId = `provider-${'p'.repeat(110)}`;
    const names = Array.from(
      { length: 125 },
      (_, index) => `tool-${String(index).padStart(3, '0')}-${'n'.repeat(110)}`,
    );
    const mcp = runtime({
      getCapabilitySnapshot: () => ({
        revision: 'catalog-1',
        descriptors: names.map((name, index) => ({
          kind: 'mcp_tool',
          availability: 'available',
          capabilityId: `mcp:provider:tool-${index}`,
          provider: { id: providerId },
          displayName: name,
        })),
      }),
      getProviderDirectorySnapshot: () => ({
        revision: 'providers-1',
        entries: [{ providerId, status: 'ready', source: 'explicit' }],
      }),
      getResourceDirectorySnapshot: () => ({
        resources: Array.from({ length: 125 }, (_, index) => ({
          providerId,
          uri: `docs://resource-${index}`,
          name: `resource-${index}`,
        })),
      }),
    });
    const all = JSON.parse((await execute('builtin:list_mcp_tools', {}, mcp)).stdout);
    expect(all.tools).toHaveLength(125);
    expect(all.truncated).toBe(false);
    expect(all.providers[0].name).toBe(providerId);
    expect(all.tools.map((tool: { name: string }) => tool.name)).toEqual(names);

    const first = JSON.parse((await execute('builtin:list_mcp_tools', { limit: 120 }, mcp)).stdout);
    expect(first.tools).toHaveLength(120);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = JSON.parse(
      (await execute('builtin:list_mcp_tools', { cursor: first.next_cursor }, mcp)).stdout,
    );
    expect(second.tools).toHaveLength(5);
    expect(second.truncated).toBe(false);

    const longProviderId = `provider-${'p'.repeat(2_200)}`;
    const longProvider = runtime({
      getCapabilitySnapshot: () => ({
        revision: 'catalog-long',
        descriptors: Array.from({ length: 2 }, (_, index) => ({
          kind: 'mcp_tool',
          availability: 'available',
          capabilityId: `mcp:long:tool-${index}`,
          provider: { id: longProviderId },
          displayName: `long-tool-${index}`,
        })),
      }),
      getProviderDirectorySnapshot: () => ({
        revision: 'providers-long',
        entries: [{ providerId: longProviderId, status: 'ready' }],
      }),
    });
    const longFirst = JSON.parse(
      (
        await execute(
          'builtin:list_mcp_tools',
          { provider: longProviderId, limit: 1 },
          longProvider,
        )
      ).stdout,
    );
    expect(longFirst.providers[0].name).toBe(longProviderId);
    expect(longFirst.next_cursor.length).toBeGreaterThan(2_048);
    const longSecond = JSON.parse(
      (
        await execute(
          'builtin:list_mcp_tools',
          { provider: longProviderId, cursor: longFirst.next_cursor },
          longProvider,
        )
      ).stdout,
    );
    expect(longSecond.tools).toHaveLength(1);
    expect(longSecond.truncated).toBe(false);

    const providerOnly = JSON.parse(
      (
        await execute(
          'builtin:list_mcp_tools',
          {},
          runtime({
            getCapabilitySnapshot: () => ({ revision: 'empty', descriptors: [] }),
            getProviderDirectorySnapshot: () => ({
              revision: 'providers-empty',
              entries: [{ providerId: 'configured-only', status: 'disabled' }],
            }),
          }),
        )
      ).stdout,
    );
    expect(providerOnly.providers).toHaveLength(1);
    expect(providerOnly.tools).toHaveLength(0);

    const resources = JSON.parse((await execute('builtin:list_mcp_resources', {}, mcp)).stdout);
    expect(resources.resources).toHaveLength(125);
    expect(resources.truncated).toBe(false);
  });
});
