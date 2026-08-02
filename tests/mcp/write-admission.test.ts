import { describe, expect, test } from 'bun:test';
import { DEFAULT_FEATURE_FLAGS } from '@/core/config/features';
import { resolveMcpToolPolicy } from '@/core/mcp/tool-policy';
import {
  evaluateMcpWriteAdmissionV1,
  type McpWriteInvocationFactsV1,
  type McpWriteRouteContractV1,
} from './write-contract-fixtures';

const now = new Date('2026-08-02T00:00:00.000Z');

function route(): McpWriteRouteContractV1 {
  const policy = resolveMcpToolPolicy(
    {
      type: 'http',
      trust: 'untrusted',
      tools: {
        create_issue: {
          minimumApproval: 'user',
          retry: 'never',
          effects: { filesystem: 'none', network: 'write', externalState: 'write' },
        },
      },
    },
    { name: 'create_issue', annotations: { readOnlyHint: false } },
  );
  return {
    routeId: 'github-create-issue-v1',
    operatorIdentity: 'operator:github-org',
    serverIdentity: 'github-production',
    endpointRevision: 'endpoint-v1',
    toolName: 'create_issue',
    toolRevision: 'tool-v1',
    schemaDigest: 'schema-v1',
    policyDigest: 'policy-v1',
    effects: policy.effectiveEffects,
    minimumApproval: policy.minimumApproval,
    providerDataPolicyRevision: 'provider-data-v1',
    idempotency: 'reconciliation_only',
    reconciliation: 'required',
    rateLimitPerMinute: 10,
    timeoutMs: 30_000,
    evidenceObservedAt: '2026-08-01T00:00:00.000Z',
    evidenceExpiresAt: '2026-08-03T00:00:00.000Z',
  };
}

function invocation(contract = route()): McpWriteInvocationFactsV1 {
  return {
    providerIdentity: contract.operatorIdentity,
    serverIdentity: contract.serverIdentity,
    endpointRevision: contract.endpointRevision,
    toolName: contract.toolName,
    toolRevision: contract.toolRevision,
    schemaDigest: contract.schemaDigest,
    policyDigest: contract.policyDigest,
    bindingCurrent: true,
    providerDataPolicyAdmitted: true,
    egressApproved: true,
    networkBoundaryQualified: true,
  };
}

describe('MCP write admission contract', () => {
  test('keeps production write off when the production route is empty', () => {
    const decision = evaluateMcpWriteAdmissionV1({
      flags: {
        mcpExecutionRecordV1: true,
        mcpProviderActionV1: true,
        verificationV1: true,
      },
      invocation: invocation(),
      now,
    });
    expect(decision).toEqual({
      status: 'blocked',
      reasonCodes: ['production_route_unconfigured'],
    });
  });

  test('fails closed when any required default-off feature is disabled', () => {
    expect(DEFAULT_FEATURE_FLAGS.mcpExecutionRecordV1).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.mcpProviderActionV1).toBe(false);
    expect(DEFAULT_FEATURE_FLAGS.verificationV1).toBe(false);
    const contract = route();
    const decision = evaluateMcpWriteAdmissionV1({
      flags: DEFAULT_FEATURE_FLAGS,
      route: contract,
      invocation: invocation(contract),
      now,
    });
    expect(decision.status).toBe('blocked');
    expect(decision.reasonCodes).toEqual([
      'flag_off:mcpExecutionRecordV1',
      'flag_off:mcpProviderActionV1',
      'flag_off:verificationV1',
    ]);
  });

  test('requires exact route, binding, policy, egress and network facts', () => {
    const contract = route();
    const facts = invocation(contract);
    const decision = evaluateMcpWriteAdmissionV1({
      flags: {
        mcpExecutionRecordV1: true,
        mcpProviderActionV1: true,
        verificationV1: true,
      },
      route: contract,
      invocation: {
        ...facts,
        endpointRevision: 'stale-endpoint',
        toolRevision: 'stale-tool',
        schemaDigest: 'stale-schema',
        policyDigest: 'stale-policy',
        bindingCurrent: false,
        providerDataPolicyAdmitted: false,
        egressApproved: false,
        networkBoundaryQualified: false,
      },
      now,
    });
    expect(decision.status).toBe('blocked');
    expect(decision.reasonCodes).toEqual([
      'binding_stale',
      'egress_not_approved',
      'endpoint_revision_mismatch',
      'network_boundary_unqualified',
      'policy_digest_mismatch',
      'provider_data_policy_denied',
      'schema_digest_mismatch',
      'tool_revision_mismatch',
    ]);
  });

  test('admits only an exact fresh write route at user approval', () => {
    const contract = route();
    expect(
      evaluateMcpWriteAdmissionV1({
        flags: {
          mcpExecutionRecordV1: true,
          mcpProviderActionV1: true,
          verificationV1: true,
        },
        route: contract,
        invocation: invocation(contract),
        now,
      }),
    ).toEqual({ status: 'admitted', reasonCodes: [] });
  });
});
