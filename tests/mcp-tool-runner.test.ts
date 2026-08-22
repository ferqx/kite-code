import { describe, expect, test } from 'bun:test';
import type { McpRuntimeProvider } from '@kite/builtin-runtime/mcp';
import type { CapabilityDescriptor } from '@kite/runtime-contract';
import { createRmv111WebMechanismPortV1 } from '#app/bootstrap/runtime/tool-provider-services';
import {
  BuiltinMechanismAuthorityErrorV1,
  type BuiltinOperationExecutionValueV1,
  createCapabilityBindingV1,
  DYNAMIC_MCP_OPERATION_INPUT_SCHEMA_V1,
  mergeBuiltinMechanismBundleV1,
  projectBuiltinExecutionReceiptTerminalResultV1,
  RMV1_11_CAPABILITY_REVISIONS_V1,
} from '#builtin-runtime';
import { testRuntimeCapabilityExecutionPortV1 } from './helpers/runtime-model';

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

function runtimeCapability(manager: McpRuntimeProvider, signal: AbortSignal) {
  const capabilityId = 'mcp:docs/search_docs';
  const capabilityRevision = 'revision';
  const binding = createCapabilityBindingV1({
    capabilityId: 'mcp:dynamic_tool',
    capabilityRevision: RMV1_11_CAPABILITY_REVISIONS_V1['mcp:dynamic_tool'],
    exposedToolName: 'mcp:dynamic_tool',
    inputSchema: DYNAMIC_MCP_OPERATION_INPUT_SCHEMA_V1,
    turnId: 'turn-test',
  });
  const requestInput = {
    capability_id: capabilityId,
    capability_revision: capabilityRevision,
    arguments: { query: 'runtime' },
  } as const;
  const runtimeCapability = {
    binding,
    subject: { capabilityId, capabilityRevision },
    requestInput,
    executionMechanisms: Object.freeze({
      mcp: Object.freeze({
        runtime: manager,
        invocation: Object.freeze({ capabilityId, expectedRevision: capabilityRevision }),
      }),
    }),
  } as const;
  return {
    runtimeCapability,
    invokeRuntimeCapability: (runtimeInput?: {
      readonly executionMechanisms?: Readonly<Record<string, unknown>>;
    }) =>
      testRuntimeCapabilityExecutionPortV1().invoke({
        binding,
        request: {
          invocationId: 'invocation-test',
          capabilityId: binding.capabilityId,
          capabilityRevision: binding.capabilityRevision,
          input: requestInput,
        },
        grant: {
          grantId: 'grant-test',
          capabilityId: binding.capabilityId,
          capabilityRevision: binding.capabilityRevision,
          authority: {},
        },
        requestDigest: 'request-digest-test',
        signal,
        environment: {
          environmentId: 'test',
          kind: 'in_process',
          mechanisms: {
            ...runtimeCapability.executionMechanisms,
            ...(runtimeInput?.executionMechanisms ?? {}),
          },
        },
        attempt: { invocationId: 'invocation-test', attemptId: 'attempt-test' },
      }),
  };
}

async function invokeCapability(capability: ReturnType<typeof runtimeCapability>) {
  try {
    const prepared = mergeBuiltinMechanismBundleV1({
      executionMechanism: 'mcp',
      prepared: capability.runtimeCapability.executionMechanisms,
    });
    const receipt = await capability.invokeRuntimeCapability({
      executionMechanisms: prepared,
    });
    const terminal = projectBuiltinExecutionReceiptTerminalResultV1(receipt);
    const value = terminal.structuredContent as BuiltinOperationExecutionValueV1 | undefined;
    const capabilityResult =
      value?.capabilityResult &&
      typeof value.capabilityResult === 'object' &&
      !Array.isArray(value.capabilityResult) &&
      Array.isArray((value.capabilityResult as { readonly content?: unknown }).content)
        ? (value.capabilityResult as { readonly content: readonly unknown[] })
        : undefined;
    return {
      ok: terminal.status === 'success' && value?.ok === true,
      stdout: value?.stdout ?? '',
      stderr: value?.stderr ?? terminal.failure?.message ?? '',
      capabilityResult,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

describe('MCP tool runner', () => {
  test('forwards cancellation to the protocol call', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const manager = provider(async (invocation) => {
      observedSignal = invocation.signal;
      return { content: [] };
    });
    const capability = runtimeCapability(manager, controller.signal);
    const result = await invokeCapability(capability);

    expect(result.ok).toBe(true);
    expect(observedSignal).toBe(controller.signal);
  });

  test('bounds oversized MCP output before it enters the model transcript', async () => {
    const manager = provider(async () => ({
      content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }],
    }));
    const capability = runtimeCapability(manager, new AbortController().signal);
    const result = await invokeCapability(capability);

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

  test('rejects mutable or duplicate mechanism authority before Host/provider entry', async () => {
    const controller = new AbortController();
    let providerCalls = 0;
    let hostCalls = 0;
    const beforeDispatchCalls = 0;
    const manager = provider(async () => {
      providerCalls += 1;
      return { content: [] };
    });
    const capability = runtimeCapability(manager, controller.signal);
    const mutableMcp = {
      ...capability.runtimeCapability.executionMechanisms.mcp,
    };
    const result = await invokeCapability({
      ...capability,
      runtimeCapability: {
        ...capability.runtimeCapability,
        executionMechanisms: Object.freeze({ mcp: mutableMcp }),
      },
      invokeRuntimeCapability: async () => {
        hostCalls += 1;
        throw new Error('Host must not be called');
      },
    });

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("mechanism 'mcp' wrapper must be a frozen object");
    expect(beforeDispatchCalls).toBe(0);
    expect(hostCalls).toBe(0);
    expect(providerCalls).toBe(0);

    const frozenMcp = capability.runtimeCapability.executionMechanisms.mcp;
    const merged = mergeBuiltinMechanismBundleV1({
      executionMechanism: 'mcp',
      prepared: Object.freeze({ mcp: frozenMcp }),
    });
    expect(Object.isFrozen(merged)).toBe(true);
    expect(merged.mcp).toBe(frozenMcp);
    expect(() =>
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'mcp',
        prepared: Object.freeze({ mcp: frozenMcp }),
        runner: Object.freeze({ mcp: frozenMcp }),
      }),
    ).toThrow(BuiltinMechanismAuthorityErrorV1);
    expect(() =>
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'mcp',
        prepared: Object.freeze({
          mcp: frozenMcp,
          web: createRmv111WebMechanismPortV1({}),
        }),
      }),
    ).toThrow("requires only 'mcp'");
    expect(() =>
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'mcp',
        prepared: { mcp: frozenMcp },
      }),
    ).toThrow('prepared mechanism map must be a frozen object');

    const symbolKeyed = { mcp: frozenMcp };
    Object.defineProperty(symbolKeyed, Symbol('hidden-authority'), {
      value: frozenMcp,
      enumerable: true,
    });
    expect(() =>
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'mcp',
        prepared: Object.freeze(symbolKeyed),
      }),
    ).toThrow('must not contain symbol keys');

    const nonEnumerable = { mcp: frozenMcp };
    Object.defineProperty(nonEnumerable, 'hiddenAuthority', {
      value: frozenMcp,
      enumerable: false,
    });
    expect(() =>
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'mcp',
        prepared: Object.freeze(nonEnumerable),
      }),
    ).toThrow('must contain only enumerable keys');
  });

  test('web execution without an explicit fetch returns an unavailable frozen port', () => {
    const unavailable = createRmv111WebMechanismPortV1({});
    expect(Object.isFrozen(unavailable)).toBe(true);
    expect(unavailable).toMatchObject({
      unavailable: {
        code: 'network_boundary_unavailable',
      },
    });
    expect(() =>
      mergeBuiltinMechanismBundleV1({
        executionMechanism: 'web',
        prepared: Object.freeze({ web: unavailable }),
      }),
    ).not.toThrow();
  });
});
