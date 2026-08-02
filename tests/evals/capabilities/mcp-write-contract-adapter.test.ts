import { describe, expect, test } from 'bun:test';
import { resolveMcpToolPolicy } from '@/core/mcp/tool-policy';
import {
  type McpWriteRouteContractV1,
  routeContractDigestV1,
} from '../../mcp/write-contract-fixtures';
import { buildMcpWriteContractEvidenceV1 } from './contract-evidence';

function syntheticRoute(): McpWriteRouteContractV1 {
  const policy = resolveMcpToolPolicy(
    {
      type: 'http',
      trust: 'untrusted',
      tools: {
        write: {
          minimumApproval: 'user',
          retry: 'never',
          effects: { filesystem: 'none', network: 'write', externalState: 'write' },
        },
      },
    },
    { name: 'write', annotations: { readOnlyHint: false } },
  );
  return {
    routeId: 'synthetic-contract-route',
    operatorIdentity: 'synthetic-operator',
    serverIdentity: 'synthetic-server',
    endpointRevision: 'synthetic-endpoint-v1',
    toolName: 'write',
    toolRevision: 'synthetic-tool-v1',
    schemaDigest: 'synthetic-schema-v1',
    policyDigest: 'synthetic-policy-v1',
    effects: policy.effectiveEffects,
    minimumApproval: policy.minimumApproval,
    providerDataPolicyRevision: 'synthetic-data-policy-v1',
    idempotency: 'unsupported',
    reconciliation: 'required',
    rateLimitPerMinute: 1,
    timeoutMs: 1000,
    evidenceObservedAt: '2026-08-01T00:00:00.000Z',
    evidenceExpiresAt: '2026-08-03T00:00:00.000Z',
  };
}

describe('MCP write local contract evaluation adapter', () => {
  test('keeps missing production route and formal task evidence blocked', () => {
    expect(
      buildMcpWriteContractEvidenceV1({
        formalTaskEvidence: 'not_observed',
        duplicateSideEffects: 0,
        unauthorizedSideEffects: 0,
        dataBoundaryViolations: 0,
        now: new Date('2026-08-02T00:00:00.000Z'),
      }),
    ).toMatchObject({
      status: 'blocked',
      reasonCodes: ['formal_task_evidence_not_passed', 'production_route_unconfigured'],
      maturity: 'not_observed',
      milestone: 'not_produced',
    });
  });

  test('a synthetic passing route cannot manufacture formal qualification', () => {
    const route = syntheticRoute();
    const evidence = buildMcpWriteContractEvidenceV1({
      route,
      observedRouteDigest: routeContractDigestV1(route),
      formalTaskEvidence: 'passed',
      duplicateSideEffects: 0,
      unauthorizedSideEffects: 0,
      dataBoundaryViolations: 0,
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(evidence.status).toBe('blocked');
    expect(evidence.reasonCodes).toEqual(['contract_only_cannot_qualify']);
  });

  test.each([
    [
      'duplicate side effect',
      { duplicateSideEffects: 1, unauthorizedSideEffects: 0, dataBoundaryViolations: 0 },
    ],
    [
      'unauthorized side effect',
      { duplicateSideEffects: 0, unauthorizedSideEffects: 1, dataBoundaryViolations: 0 },
    ],
    [
      'data boundary violation',
      { duplicateSideEffects: 0, unauthorizedSideEffects: 0, dataBoundaryViolations: 1 },
    ],
  ] as const)('forces MCP write off for %s', (_name, violations) => {
    const route = syntheticRoute();
    const evidence = buildMcpWriteContractEvidenceV1({
      route,
      observedRouteDigest: routeContractDigestV1(route),
      formalTaskEvidence: 'passed',
      ...violations,
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(evidence.status).toBe('off');
    expect(evidence.reasonCodes).toContain('hard_safety_violation');
  });
});
