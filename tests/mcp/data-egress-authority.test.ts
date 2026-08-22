import { describe, expect, test } from 'bun:test';
import {
  classifyRemoteMcpArgumentsV1,
  createRemoteMcpEgressPermitV1,
  McpConnectionManager,
  type RemoteMcpEgressPermitRequestV1,
  remoteMcpArgumentDigestV1,
} from '@kite/builtin-runtime/mcp';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { testRemoteMcpOriginFactsV1 } from '../helpers/mcp-egress';

describe('remote MCP DataOrigin/EgressAuthority admission', () => {
  test('derives the sole MCP destination authority from an exact permit', async () => {
    let calls = 0;
    const client = {
      connect: async () => {},
      close: async () => {},
      listTools: async () => ({ tools: [{ name: 'send', inputSchema: { type: 'object' } }] }),
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      setNotificationHandler: () => {},
      callTool: async () => {
        calls += 1;
        return { content: [] };
      },
    } as unknown as Client;
    const manager = new McpConnectionManager({
      createClient: () => client,
      createTransport: () => ({}) as never,
    });
    await manager.connect('remote', {
      type: 'http',
      url: 'https://remote.example.test/mcp',
      providerVersion: 'endpoint-v1',
    });
    const descriptor = manager.findCapability('mcp:remote/send');
    const route = descriptor && manager.getCapabilityRoute(descriptor.capabilityId);
    if (!descriptor || !route) throw new Error('fixture route unavailable');
    const args = { query: 'safe' };
    const content = classifyRemoteMcpArgumentsV1(args);
    const request: RemoteMcpEgressPermitRequestV1 = {
      ...route,
      invocationId: 'invocation-1',
      toolCallId: 'tool-1',
      argumentDigest: remoteMcpArgumentDigestV1(args),
      ...testRemoteMcpOriginFactsV1(content),
      content,
    };
    const permit = createRemoteMcpEgressPermitV1({
      request,
      nonce: 'nonce-1',
      approvedAt: new Date(Date.now() - 1_000),
      expiresAt: new Date(Date.now() + 60_000),
    });
    const decisions: string[] = [];
    const policy = {
      enabled: true,
      invocationId: 'invocation-1',
      toolCallId: 'tool-1',
      content: request.content,
      ...testRemoteMcpOriginFactsV1(request.content),
      permit,
      recordDecision: (receipt: { reason: string }) => {
        decisions.push(receipt.reason);
      },
    };
    await manager.callCapability({
      capabilityId: descriptor.capabilityId,
      expectedRevision: descriptor.revision,
      arguments: args,
      remoteEgress: policy,
    });
    expect(calls).toBe(1);
    expect(decisions).toEqual(['permit_consumed']);

    await expect(
      manager.callCapability({
        capabilityId: descriptor.capabilityId,
        expectedRevision: descriptor.revision,
        arguments: args,
        remoteEgress: { ...policy, permit: undefined },
      }),
    ).rejects.toMatchObject({ receipt: { reason: 'permit_missing' } });
    expect(calls).toBe(1);
  });
});
