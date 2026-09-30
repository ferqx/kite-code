import { describe, expect, test } from 'bun:test';
import {
  createNetworkBoundaryFetch,
  type NetworkDecisionReceipt,
} from '@kite-ai/builtin-runtime/sandbox';
import { createRuntimeHostStateInitialState } from '@kite-ai/runtime-host/kernel-adapter';
import {
  createWebMechanismPort,
  resolveWebNetworkBoundaryPolicy,
} from '#kite-service/bootstrap/runtime/tool-provider-services';
import type { AgentConfig } from '#kite-service/config';
import { executeTestRuntimeTools } from '../../../../tests/helpers/runtime-model';

const developmentConfig: AgentConfig = {
  apiKey: '',
  baseURL: 'http://localhost',
  modelName: 'test',
  providerName: 'test',
  providerType: 'openai-compatible',
  reasoningEffort: null,
  sandbox: { enabled: false },
  features: { networkBoundary: false },
};

describe('development web network boundary', () => {
  test('admits public redirects with pinned addresses and a durable decision before each request', async () => {
    const policy = resolveWebNetworkBoundaryPolicy(developmentConfig)!;
    const decisions: NetworkDecisionReceipt[] = [];
    const hosts: string[] = [];
    const fetch = createNetworkBoundaryFetch(policy, {
      toolCallId: 'web-call',
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      recordDecision: async (decision) => {
        decisions.push(decision);
      },
      request: async ({ url, admission }) => {
        expect(decisions.at(-1)).toEqual(admission);
        expect(admission.address).toBe('93.184.216.34');
        hosts.push(url.hostname);
        return hosts.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://other.example/page' } })
          : new Response('public content');
      },
    });
    expect(await (await fetch('https://example.com')).text()).toBe('public content');
    expect(hosts).toEqual(['example.com', 'other.example']);
    expect(decisions.map((decision) => decision.hop)).toEqual([0, 1]);
    expect(decisions.every((decision) => decision.policyRevision === policy.revision)).toBe(true);
  });

  test('denies private redirect addresses and stops before dispatch if recording fails', async () => {
    const policy = resolveWebNetworkBoundaryPolicy(developmentConfig)!;
    const decisions: NetworkDecisionReceipt[] = [];
    let requests = 0;
    const fetch = createNetworkBoundaryFetch(policy, {
      resolver: async (host) => [
        { address: host === 'example.com' ? '93.184.216.34' : '127.0.0.1', family: 4 },
      ],
      recordDecision: async (decision) => {
        decisions.push(decision);
      },
      request: async () => {
        requests += 1;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://private.example' },
        });
      },
    });
    await expect(fetch('https://example.com')).rejects.toMatchObject({
      code: 'private_or_reserved_address',
    });
    expect(requests).toBe(1);
    expect(decisions.at(-1)).toMatchObject({
      outcome: 'denied',
      hop: 1,
      failureCode: 'private_or_reserved_address',
    });
    const unrecordable = createNetworkBoundaryFetch(policy, {
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      recordDecision: async () => {
        throw new Error('stale controller');
      },
      request: async () => {
        requests += 1;
        return new Response('unexpected');
      },
    });
    await expect(unrecordable('https://example.com')).rejects.toMatchObject({
      code: 'controller_unavailable',
    });
    expect(requests).toBe(1);
  });

  test('preserves missing authority failures and sealed off or allowlist policies', () => {
    expect(resolveWebNetworkBoundaryPolicy(undefined)).toBeUndefined();
    expect(
      resolveWebNetworkBoundaryPolicy({
        ...developmentConfig,
        productionExecution: {},
      } as AgentConfig),
    ).toBeUndefined();
    expect(createWebMechanismPort({}).unavailable?.code).toBe('network_boundary_unavailable');
    expect(
      createWebMechanismPort({
        networkBoundaryPolicy: resolveWebNetworkBoundaryPolicy(developmentConfig),
      }).unavailable?.code,
    ).toBe('controller_unavailable');
    const boundary = {
      filesystemScope: 'workspace_write',
      workspaceRoot: process.cwd(),
      networkMode: 'allowlist',
      networkAllowlist: ['example.com'],
      allowLocalAndPrivateNetwork: false,
      protectedPathPolicy: 'deny',
      maxProcessTreeSizePerShellInvocation: 16,
      sandboxRequired: true,
      sandboxUnavailable: 'fail',
    } satisfies NonNullable<AgentConfig['executionBoundary']>;
    expect(
      resolveWebNetworkBoundaryPolicy({
        ...developmentConfig,
        executionBoundary: boundary,
        features: { networkBoundary: true },
      }),
    ).toMatchObject({ mode: 'allowlist', allowedHosts: ['example.com'] });
    expect(
      resolveWebNetworkBoundaryPolicy({
        ...developmentConfig,
        executionBoundary: boundary,
        features: { networkBoundary: false },
      }),
    ).toMatchObject({ mode: 'off', allowedHosts: [] });
  });

  test('routes an approved ordinary config web invocation to network admission', async () => {
    const state = createRuntimeHostStateInitialState({
      recoveryIdentityKey: '0'.repeat(64),
      threadId: 'development-web',
      userId: 'user',
      workspace: process.cwd(),
    });
    state.mode = 'accept_edits';
    state.tools.calls.call = {
      toolCallId: 'call',
      modelMessageId: 'message',
      ordinal: 0,
      name: 'web_fetch',
      args: { url: 'https://8.8.8.8' },
      status: 'queued',
      createdAtTurnId: state.turn.turnId,
    };
    state.tools.queue = ['call'];
    const requested = await executeTestRuntimeTools({
      state,
      toolCallIds: ['call'],
      taskConfig: developmentConfig,
    });
    const approval = requested.find((event) => event.type === 'approval.requested');
    expect(approval?.type).toBe('approval.requested');
    if (approval?.type !== 'approval.requested') throw new Error('Missing approval');
    state.tools.calls.call.status = 'approved';
    state.tools.calls.call.approvalGrant = 'approve_once';
    state.tools.calls.call.approvalHash = approval.approval.approvalHash;
    const decisions: NetworkDecisionReceipt[] = [];
    const executed = await executeTestRuntimeTools({
      state,
      toolCallIds: ['call'],
      taskConfig: developmentConfig,
      recordNetworkDecision: async (decision) => {
        decisions.push(decision);
      },
    });
    expect(decisions).toContainEqual(
      expect.objectContaining({ outcome: 'denied', failureCode: 'ip_literal_denied' }),
    );
    expect(
      executed.filter((event) => event.type === 'capability.invocation_recorded'),
    ).toHaveLength(1);
    expect(executed.filter((event) => event.type === 'tool.finished')).toHaveLength(1);
  });
});
