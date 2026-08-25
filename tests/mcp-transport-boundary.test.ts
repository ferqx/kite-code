import { describe, expect, test } from 'bun:test';
import { dirname } from 'node:path';
import {
  createMcpTransportAdmissionReceipt,
  createMcpTransportBoundaryIdentity,
  DefaultMcpSupervisor,
  McpConnectionManager,
  type McpTransportAdmissionRequest,
  type McpTransportBoundaryController,
} from '@kite-ai/builtin-runtime/mcp';
import type {
  ExecutionBoundary,
  ExecutionCapabilitySurface,
  NetworkDecisionReceipt,
} from '@kite-ai/builtin-runtime/sandbox';
import {
  createNetworkBoundaryFetch,
  createProtectedPathEvaluator,
  networkBoundaryPolicyFromExecutionBoundary,
} from '@kite-ai/builtin-runtime/sandbox';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { createInMemoryMcpConfigRepository } from './helpers/mcp-test-composition';

const workspace = process.cwd();
const executionBoundary: ExecutionBoundary = {
  filesystemScope: 'workspace_write',
  workspaceRoot: workspace,
  networkMode: 'allowlist',
  networkAllowlist: ['mcp.example'],
  allowLocalAndPrivateNetwork: false,
  protectedPathPolicy: 'deny',
  maxProcessTreeSizePerShellInvocation: 8,
  sandboxRequired: true,
  sandboxUnavailable: 'fail',
};
const executionSurface: ExecutionCapabilitySurface = {
  inProcessReadOnlyTools: null,
  network: true,
  process: true,
  write: true,
  workspaceWrite: true,
  shell: true,
  skillChild: true,
  localStdioMcp: true,
  gitInspect: false,
  brokeredGitFeatureRevision: null,
};
const networkPolicy = networkBoundaryPolicyFromExecutionBoundary(executionBoundary, true);
const safeHttpTransportOptions = {
  transportNetworkPolicy: networkPolicy,
  transportRecordNetworkDecision: async (_decision: NetworkDecisionReceipt) => {},
};
const protectedPathEvaluator = createProtectedPathEvaluator({
  workspaceRoot: workspace,
  mode: 'deny',
});

function boundaryIdentity(surface = executionSurface) {
  return createMcpTransportBoundaryIdentity({
    workspaceRoot: workspace,
    executionBoundary,
    executionSurface: surface,
    runIdentity: 'run-1',
    profileIdentity: 'profile-1',
    networkPolicyRevision: networkPolicy.revision,
  });
}

function controller(
  requests: McpTransportAdmissionRequest[],
  identity = boundaryIdentity(),
): McpTransportBoundaryController {
  return {
    identity,
    async admit(request) {
      requests.push(request);
      return createMcpTransportAdmissionReceipt(request);
    },
  };
}

function fakeClient(calls: { tool: number; resource: number }): Client {
  return {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({
      tools: [{ name: 'read', inputSchema: { type: 'object', additionalProperties: false } }],
    }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [{ uri: 'docs://one', name: 'One' }] }),
    setNotificationHandler: () => {},
    callTool: async () => {
      calls.tool += 1;
      return { content: [] };
    },
    readResource: async () => {
      calls.resource += 1;
      return { contents: [{ uri: 'docs://one', text: 'one' }] };
    },
  } as unknown as Client;
}

describe('MCP transport execution boundary', () => {
  test('does not construct an eager transport without a sealed admission controller', async () => {
    let legacyFactoryCalls = 0;
    const manager = new McpConnectionManager({
      transportBoundaryRequired: true,
      createClient: () => fakeClient({ tool: 0, resource: 0 }),
      createTransport: () => {
        legacyFactoryCalls += 1;
        return {} as never;
      },
    });

    await expect(
      manager.connect('sealed', {
        type: 'http',
        url: 'https://mcp.example',
        providerVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'boundary_unavailable' });
    expect(legacyFactoryCalls).toBe(0);
  });

  test('validates connect and every Tool/Resource invocation before SDK dispatch', async () => {
    const requests: McpTransportAdmissionRequest[] = [];
    const calls = { tool: 0, resource: 0 };
    let sdkConnectCalls = 0;
    const identity = boundaryIdentity();
    const manager = new McpConnectionManager({
      ...safeHttpTransportOptions,
      transportBoundaryRequired: true,
      transportBoundary: controller(requests, identity),
      createClient: () => {
        const client = fakeClient(calls);
        client.connect = async () => {
          sdkConnectCalls += 1;
        };
        return client;
      },
    });
    await manager.connect('sealed', {
      type: 'http',
      url: 'https://mcp.example',
      providerVersion: 'endpoint-v1',
    });
    expect(sdkConnectCalls).toBe(1);
    expect(requests.map((request) => request.operation)).toEqual([
      'connect',
      'tool_list',
      'prompt_list',
      'resource_list',
    ]);

    const descriptor = manager.findCapability('mcp:sealed/read')!;
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: {},
      }),
    ).rejects.toMatchObject({ code: 'invocation_identity_missing' });
    expect(calls.tool).toBe(0);

    const transportBoundary = {
      boundaryIdentityDigest: identity.identityDigest,
      invocationId: 'invocation-1',
      toolCallId: 'tool-call-1',
      endpointRevision: 'endpoint-v1',
    };
    await manager.callCapability({
      capabilityId: descriptor.capabilityId,
      expectedRevision: descriptor.revision,
      arguments: {},
      transportBoundary,
    });
    await expect(
      manager.readResource('sealed', 'docs://one', undefined, {
        ...transportBoundary,
        invocationId: 'invocation-2',
        toolCallId: 'resource-read-1',
      }),
    ).resolves.toBe('one');
    expect(calls).toEqual({ tool: 1, resource: 1 });
    expect(requests.map((request) => request.operation)).toEqual([
      'connect',
      'tool_list',
      'prompt_list',
      'resource_list',
      'tool_call',
      'resource_read',
    ]);
    expect(new Set(requests.map((request) => request.invocationId)).size).toBe(6);
    expect(
      requests.every(
        (request) =>
          request.workspaceKey === identity.workspaceKey &&
          request.executionBoundaryRevision === identity.executionBoundaryRevision &&
          request.runIdentity === 'run-1' &&
          request.profileIdentity === 'profile-1' &&
          request.networkPolicyRevision === networkPolicy.revision &&
          request.canonicalEndpoint === 'https://mcp.example/' &&
          request.endpointIdentityDigest.length === 64,
      ),
    ).toBe(true);
  });

  test('rejects stale boundary and endpoint identities before consulting admission or transport', async () => {
    const requests: McpTransportAdmissionRequest[] = [];
    const calls = { tool: 0, resource: 0 };
    const identity = boundaryIdentity();
    const manager = new McpConnectionManager({
      ...safeHttpTransportOptions,
      transportBoundaryRequired: true,
      transportBoundary: controller(requests, identity),
      createClient: () => fakeClient(calls),
    });
    await manager.connect('sealed', {
      type: 'http',
      url: 'https://mcp.example',
      providerVersion: 'endpoint-v1',
    });
    const descriptor = manager.findCapability('mcp:sealed/read')!;
    const base = {
      invocationId: 'invocation-stale',
      toolCallId: 'tool-stale',
      endpointRevision: 'endpoint-v1',
    };
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: {},
        transportBoundary: { ...base, boundaryIdentityDigest: 'wrong-boundary' },
      }),
    ).rejects.toMatchObject({ code: 'boundary_identity_mismatch' });
    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: {},
        transportBoundary: {
          ...base,
          boundaryIdentityDigest: identity.identityDigest,
          endpointRevision: 'old-endpoint',
        },
      }),
    ).rejects.toMatchObject({ code: 'endpoint_revision_mismatch' });
    expect(requests).toHaveLength(4);
    expect(calls.tool).toBe(0);
  });

  test('rejects a forged admission receipt before constructing the transport', async () => {
    const identity = boundaryIdentity();
    let sdkConnectCalls = 0;
    const manager = new McpConnectionManager({
      ...safeHttpTransportOptions,
      transportBoundaryRequired: true,
      transportBoundary: {
        identity,
        async admit(request) {
          return {
            ...createMcpTransportAdmissionReceipt(request),
            endpointRevision: 'forged-endpoint',
          };
        },
      },
      createClient: () => {
        const client = fakeClient({ tool: 0, resource: 0 });
        client.connect = async () => {
          sdkConnectCalls += 1;
        };
        return client;
      },
    });
    await expect(
      manager.connect('sealed', {
        type: 'http',
        url: 'https://mcp.example',
        providerVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'admission_receipt_mismatch' });
    expect(sdkConnectCalls).toBe(0);
  });

  test('rejects non-canonical endpoint config and network-policy mismatch before SDK dispatch', async () => {
    const requests: McpTransportAdmissionRequest[] = [];
    let sdkConnectCalls = 0;
    const createClient = () => {
      const client = fakeClient({ tool: 0, resource: 0 });
      client.connect = async () => {
        sdkConnectCalls += 1;
      };
      return client;
    };
    const invalidEndpointManager = new McpConnectionManager({
      ...safeHttpTransportOptions,
      transportBoundaryRequired: true,
      transportBoundary: controller(requests),
      createClient,
    });
    await expect(
      invalidEndpointManager.connect('sealed', {
        type: 'http',
        url: 'https://mcp.example?token=secret',
        providerVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'transport_denied' });
    expect(requests).toEqual([]);
    expect(sdkConnectCalls).toBe(0);

    const mismatchedPolicy = { ...networkPolicy, revision: 'wrong-network-policy' };
    const policyManager = new McpConnectionManager({
      transportBoundaryRequired: true,
      transportBoundary: controller(requests),
      transportNetworkPolicy: mismatchedPolicy,
      transportRecordNetworkDecision: async () => {},
      createClient,
    });
    await expect(
      policyManager.connect('sealed', {
        type: 'http',
        url: 'https://mcp.example',
        providerVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'boundary_identity_mismatch' });
    expect(requests).toHaveLength(1);
    expect(sdkConnectCalls).toBe(0);
  });

  test('re-admits every actual HTTP redirect hop through the pinned network boundary', async () => {
    const requests: McpTransportAdmissionRequest[] = [];
    const decisions: NetworkDecisionReceipt[] = [];
    const pinnedRequests: Array<{ url: string; address: string; invocationId: string }> = [];
    const identity = boundaryIdentity();
    const client = fakeClient({ tool: 0, resource: 0 });
    client.connect = async (transport) => {
      const httpTransport = transport as unknown as {
        start(): Promise<void>;
        send(message: {
          jsonrpc: '2.0';
          id: number;
          method: string;
          params: Record<string, never>;
        }): Promise<void>;
      };
      await httpTransport.start();
      await httpTransport.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      });
    };
    const manager = new McpConnectionManager({
      transportBoundaryRequired: true,
      transportBoundary: controller(requests, identity),
      transportNetworkPolicy: networkPolicy,
      transportNetworkResolver: async () => [{ address: '93.184.216.34', family: 4 }],
      transportRecordNetworkDecision: async (decision) => {
        decisions.push(decision);
      },
      createNetworkBoundaryFetch: (policy, options) =>
        createNetworkBoundaryFetch(policy, {
          resolver: options.resolver,
          recordDecision: options.recordDecision,
          toolCallId: options.toolCallId,
          invocationIdFactory: options.invocationIdFactory,
          request: options.request,
        }),
      transportPinnedRequest: async ({ url, admission }) => {
        pinnedRequests.push({
          url: url.href,
          address: admission.address,
          invocationId: admission.invocationId,
        });
        return pinnedRequests.length === 1
          ? new Response(null, {
              status: 307,
              headers: { location: 'https://mcp.example/redirected' },
            })
          : new Response(null, { status: 202 });
      },
      createClient: () => client,
    });

    await manager.connect('sealed', {
      type: 'http',
      url: 'https://mcp.example',
      providerVersion: 'endpoint-v1',
    });

    expect(decisions).toHaveLength(2);
    expect(decisions.map((decision) => decision.outcome)).toEqual(['allowed', 'allowed']);
    expect(decisions.map((decision) => decision.hop)).toEqual([0, 1]);
    expect(pinnedRequests.map((request) => request.url)).toEqual([
      'https://mcp.example/',
      'https://mcp.example/redirected',
    ]);
    expect(pinnedRequests.every((request) => request.address === '93.184.216.34')).toBe(true);
    expect(new Set(pinnedRequests.map((request) => request.invocationId)).size).toBe(1);
    expect(pinnedRequests[0]?.invocationId).toBe(requests[0]?.invocationId);
  });

  test('requires a fresh admission for notification-driven inventory refresh', async () => {
    const requests: McpTransportAdmissionRequest[] = [];
    const identity = boundaryIdentity();
    let toolListCalls = 0;
    let refresh: (() => Promise<void>) | undefined;
    const client = {
      connect: async () => {},
      close: async () => {},
      listTools: async () => {
        toolListCalls += 1;
        return { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
      },
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      setNotificationHandler: (schema: unknown, handler: () => Promise<void>) => {
        if (schema === ToolListChangedNotificationSchema) refresh = handler;
      },
    } as unknown as Client;
    const manager = new McpConnectionManager({
      ...safeHttpTransportOptions,
      transportBoundaryRequired: true,
      transportBoundary: controller(requests, identity),
      createClient: () => client,
    });
    await manager.connect('sealed', {
      type: 'http',
      url: 'https://mcp.example',
      providerVersion: 'endpoint-v1',
    });
    const first = requests.find((request) => request.operation === 'tool_list');
    expect(first).toBeDefined();
    await refresh?.();
    const inventoryAdmissions = requests.filter((request) => request.operation === 'tool_list');
    expect(toolListCalls).toBe(2);
    expect(inventoryAdmissions).toHaveLength(2);
    expect(inventoryAdmissions[1]?.invocationId).not.toBe(first?.invocationId);
  });

  test('checks canonical Workspace identity before Supervisor catalog or transport work', async () => {
    const requests: McpTransportAdmissionRequest[] = [];
    let catalogLoads = 0;
    const manager = new McpConnectionManager({
      transportBoundaryRequired: true,
      transportBoundary: controller(requests),
      createClient: () => fakeClient({ tool: 0, resource: 0 }),
    });
    const supervisor = new DefaultMcpSupervisor({
      manager,
      repository: createInMemoryMcpConfigRepository(() => {
        catalogLoads += 1;
        throw new Error('must not load');
      }),
    });
    await expect(supervisor.start(dirname(workspace))).rejects.toMatchObject({
      code: 'workspace_mismatch',
    });
    expect(catalogLoads).toBe(0);
    expect(requests).toEqual([]);
  });

  test('applies independent local-stdio and remote-HTTP surface axes before admission', async () => {
    const requests: McpTransportAdmissionRequest[] = [];
    const deniedSurface = { ...executionSurface, network: false, localStdioMcp: false };
    const httpDeniedManager = new McpConnectionManager({
      transportBoundaryRequired: true,
      transportBoundary: controller(requests, boundaryIdentity(deniedSurface)),
      createClient: () => fakeClient({ tool: 0, resource: 0 }),
    });
    await expect(
      httpDeniedManager.connect('http', { type: 'http', url: 'https://mcp.example' }),
    ).rejects.toMatchObject({ code: 'transport_denied' });

    const localStillExcludedManager = new McpConnectionManager({
      transportBoundaryRequired: true,
      transportBoundary: controller(requests, boundaryIdentity(deniedSurface)),
      protectedPathEvaluator,
      createClient: () => fakeClient({ tool: 0, resource: 0 }),
    });
    await expect(
      localStillExcludedManager.connect('stdio', { type: 'stdio', command: 'fixture' }),
    ).rejects.toMatchObject({ code: 'transport_denied' });
    expect(requests).toEqual([]);
  });
});
