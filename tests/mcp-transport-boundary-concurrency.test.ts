import { describe, expect, test } from 'bun:test';
import {
  classifyRemoteMcpArgumentsV1,
  createMcpTransportAdmissionReceiptV1,
  createMcpTransportBoundaryIdentityV1,
  createRemoteMcpEgressPermitV1,
  McpConnectionManager,
  type McpTransportAdmissionRequestV1,
  remoteMcpArgumentDigestV1,
} from '@kite/builtin-runtime/mcp';
import type { ExecutionBoundaryV1 } from '@kite/builtin-runtime/sandbox';
import { networkBoundaryPolicyFromExecutionBoundaryV1 } from '@kite/builtin-runtime/sandbox';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { testRemoteMcpOriginFactsV1 } from './helpers/mcp-egress';

describe('MCP transport boundary concurrency', () => {
  test('does not reuse one sibling admission for another concurrent invocation', async () => {
    const workspace = process.cwd();
    const executionBoundary: ExecutionBoundaryV1 = {
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
    const networkPolicy = networkBoundaryPolicyFromExecutionBoundaryV1(executionBoundary, true);
    const identity = createMcpTransportBoundaryIdentityV1({
      workspaceRoot: workspace,
      executionBoundary,
      executionSurface: {
        inProcessReadOnlyTools: null,
        network: true,
        process: true,
        write: false,
        workspaceWrite: false,
        shell: false,
        skillChild: false,
        localStdioMcp: false,
        gitInspect: false,
        brokeredGitFeatureRevision: null,
      },
      runIdentity: 'run-concurrent',
      profileIdentity: 'profile-concurrent',
      networkPolicyRevision: networkPolicy.revision,
    });
    const admitted: McpTransportAdmissionRequestV1[] = [];
    const dispatched: string[] = [];
    let releaseStaleAdmission = () => {};
    let observeStaleAdmission = () => {};
    const staleAdmissionGate = new Promise<void>((resolve) => {
      releaseStaleAdmission = resolve;
    });
    const staleAdmissionObserved = new Promise<void>((resolve) => {
      observeStaleAdmission = resolve;
    });
    const client = {
      connect: async () => {},
      close: async () => {},
      listTools: async () => ({
        tools: [
          {
            name: 'read',
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
        ],
      }),
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      setNotificationHandler: () => {},
      callTool: async ({ arguments: args }: { arguments?: { id?: string } }) => {
        dispatched.push(args?.id ?? 'missing');
        return { content: [] };
      },
    } as unknown as Client;
    const manager = new McpConnectionManager({
      transportBoundaryRequired: true,
      transportBoundary: {
        identity,
        async admit(request) {
          admitted.push(request);
          if (request.operation === 'tool_call')
            await Bun.sleep(request.invocationId === 'a' ? 5 : 0);
          if (request.invocationId === 'c') {
            observeStaleAdmission();
            await staleAdmissionGate;
          }
          const receipt = createMcpTransportAdmissionReceiptV1(request);
          return request.invocationId === 'b'
            ? { ...receipt, toolCallId: 'sibling-a-cached' }
            : receipt;
        },
      },
      transportNetworkPolicy: networkPolicy,
      transportRecordNetworkDecision: async () => {},
      createClient: () => client,
    });
    await manager.connect('sealed', {
      type: 'http',
      url: 'https://mcp.example',
      providerVersion: 'endpoint-v1',
    });
    const descriptor = manager.findCapability('mcp:sealed/read')!;
    const invoke = (invocationId: string) =>
      (() => {
        const args = { id: invocationId };
        const route = manager.getCapabilityRoute(descriptor.capabilityId)!;
        const content = classifyRemoteMcpArgumentsV1(args);
        const originFacts = testRemoteMcpOriginFactsV1(content);
        const request = {
          ...route,
          invocationId,
          toolCallId: `tool-${invocationId}`,
          argumentDigest: remoteMcpArgumentDigestV1(args),
          originDigest: originFacts.originDigest,
          content,
        };
        const permit = createRemoteMcpEgressPermitV1({
          request,
          nonce: `nonce-${invocationId}`,
          approvedAt: new Date(Date.now() - 1_000),
          expiresAt: new Date(Date.now() + 60_000),
        });
        return manager.callCapability({
          capabilityId: descriptor.capabilityId,
          expectedRevision: descriptor.revision,
          arguments: args,
          remoteEgress: {
            enabled: true,
            invocationId,
            toolCallId: `tool-${invocationId}`,
            content,
            ...originFacts,
            permit,
            recordDecision: () => {},
          },
          transportBoundary: {
            boundaryIdentityDigest: identity.identityDigest,
            invocationId,
            toolCallId: `tool-${invocationId}`,
            endpointRevision: 'endpoint-v1',
          },
        });
      })();
    const results = await Promise.allSettled([invoke('a'), invoke('b')]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'admission_receipt_mismatch' },
    });
    expect(admitted.filter((request) => request.operation === 'tool_call')).toHaveLength(2);
    expect(dispatched).toEqual(['a']);

    const stale = invoke('c');
    await staleAdmissionObserved;
    await manager.disconnect('sealed');
    releaseStaleAdmission();
    await expect(stale).rejects.toMatchObject({ kind: 'provider_capability_changed' });
    expect(dispatched).toEqual(['a']);
  });
});
