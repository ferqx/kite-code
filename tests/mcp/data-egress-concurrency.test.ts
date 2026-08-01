import { describe, expect, test } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  classifyRemoteMcpArgumentsV1,
  createRemoteMcpEgressPermitV1,
  RemoteMcpEgressPermitLedgerV1,
  type RemoteMcpEgressPermitRequestV1,
  remoteMcpArgumentDigestV1,
} from '@/core/mcp';
import { McpConnectionManager } from '@/core/mcp/manager';

async function fixture() {
  let requests = 0;
  const client = {
    connect: async () => {},
    close: async () => {},
    listTools: async () => ({ tools: [{ name: 'send', inputSchema: { type: 'object' } }] }),
    listPrompts: async () => ({ prompts: [] }),
    listResources: async () => ({ resources: [] }),
    setNotificationHandler: () => {},
    callTool: async () => {
      requests += 1;
      await Promise.resolve();
      return { content: [] };
    },
  } as unknown as Client;
  const manager = new McpConnectionManager({
    createClient: () => client,
    createTransport: () => ({}) as never,
    remoteMcpEgressPolicyRequired: true,
    remoteMcpEgressPermitLedger: new RemoteMcpEgressPermitLedgerV1(),
  });
  await manager.connect('remote', {
    type: 'http',
    url: 'https://remote.example.test/rpc',
    providerVersion: 'endpoint-v1',
  });
  const descriptor = manager.findCapability('mcp:remote/send');
  const route = descriptor ? manager.getCapabilityRoute(descriptor.capabilityId) : undefined;
  if (!descriptor || !route) throw new Error('fixture route unavailable');
  const request = (invocationId: string, toolCallId: string): RemoteMcpEgressPermitRequestV1 => {
    const args = { value: 'workspace content' };
    return {
      ...route,
      invocationId,
      toolCallId,
      argumentDigest: remoteMcpArgumentDigestV1(args),
      content: classifyRemoteMcpArgumentsV1(args),
    };
  };
  const permit = (permitRequest: RemoteMcpEgressPermitRequestV1, nonce: string) => {
    const now = Date.now();
    return createRemoteMcpEgressPermitV1({
      request: permitRequest,
      nonce,
      approvedAt: new Date(now - 1_000),
      expiresAt: new Date(now + 60_000),
    });
  };
  const call = (
    permitRequest: RemoteMcpEgressPermitRequestV1,
    egressPermit: ReturnType<typeof permit>,
  ) =>
    manager.callCapability({
      capabilityId: descriptor.capabilityId,
      expectedRevision: descriptor.revision,
      arguments: { value: 'workspace content' },
      remoteEgress: {
        enabled: true,
        invocationId: permitRequest.invocationId,
        toolCallId: permitRequest.toolCallId,
        content: permitRequest.content,
        permit: egressPermit,
        recordDecision: () => {},
      },
    });
  return { call, permit, request, requests: () => requests };
}

describe('remote MCP egress permit concurrency', () => {
  test('a shared sibling permit cannot transfer to a different invocation', async () => {
    const { call, permit, request, requests } = await fixture();
    const first = request('invocation-a', 'call-a');
    const second = request('invocation-b', 'call-b');
    const shared = permit(first, 'shared-nonce');
    const outcomes = await Promise.allSettled([call(first, shared), call(second, shared)]);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: { receipt: { reason: 'invocation_mismatch' } },
    });
    expect(requests()).toBe(1);
  });

  test('racing the exact same permit consumes it once before network dispatch', async () => {
    const { call, permit, request, requests } = await fixture();
    const one = request('same-invocation', 'same-call');
    const token = permit(one, 'race-nonce');
    const outcomes = await Promise.allSettled([
      call(one, token),
      call(one, token),
      call(one, token),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(2);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toMatchObject({ receipt: { reason: 'permit_replayed' } });
      }
    }
    expect(requests()).toBe(1);
  });

  test('one denied sibling neither authorizes nor consumes another sibling permit', async () => {
    const { call, permit, request, requests } = await fixture();
    const denied = request('denied', 'denied-call');
    const allowed = request('allowed', 'allowed-call');
    const deniedToken = { ...permit(denied, 'denied-nonce'), argumentDigest: 'mismatch' };
    const allowedToken = permit(allowed, 'allowed-nonce');
    const outcomes = await Promise.allSettled([
      call(denied, deniedToken),
      call(allowed, allowedToken),
    ]);
    expect(outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: { receipt: { reason: 'argument_digest_mismatch' } },
    });
    expect(outcomes[1]).toMatchObject({ status: 'fulfilled' });
    expect(requests()).toBe(1);
  });
});
