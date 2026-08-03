import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolveMcpToolPolicy } from '@/core/mcp/tool-policy';
import {
  type McpWriteRouteContractV1,
  parseMcpWriteRouteRegistryV1,
  qualifyMcpWriteRouteV1,
  routeContractDigestV1,
} from './write-contract-fixtures';

function route(): McpWriteRouteContractV1 {
  const policy = resolveMcpToolPolicy(
    {
      type: 'http',
      trust: 'untrusted',
      tools: {
        update_ticket: {
          minimumApproval: 'user',
          retry: 'idempotency_key',
          idempotencyKeyArgument: 'request_id',
          effects: { filesystem: 'none', network: 'write', externalState: 'write' },
        },
      },
    },
    { name: 'update_ticket', annotations: { readOnlyHint: false } },
  );
  return {
    routeId: 'tickets-update-v1',
    operatorIdentity: 'operator:tickets',
    serverIdentity: 'tickets-production',
    endpointRevision: 'endpoint-v1',
    toolName: 'update_ticket',
    toolRevision: 'tool-v1',
    schemaDigest: 'schema-v1',
    policyDigest: 'policy-v1',
    effects: policy.effectiveEffects,
    minimumApproval: policy.minimumApproval,
    providerDataPolicyRevision: 'provider-data-v1',
    idempotency: 'provider_key',
    reconciliation: 'required',
    rateLimitPerMinute: 5,
    timeoutMs: 15_000,
    evidenceObservedAt: '2026-08-01T00:00:00.000Z',
    evidenceExpiresAt: '2026-08-03T00:00:00.000Z',
  };
}

describe('MCP write production route matrix contract', () => {
  test('loads the source-owned registry as an explicit empty support set', () => {
    const registry = parseMcpWriteRouteRegistryV1(
      JSON.parse(readFileSync('release/mcp-write-routes-v1.json', 'utf8')),
    );
    expect(registry).toEqual({
      version: 1,
      registryId: 'mcp-write-routes-unconfigured-v1',
      routes: [],
    });
  });

  test('the repository-local matrix is empty and formal evidence is not observed', () => {
    expect(
      qualifyMcpWriteRouteV1({
        formalTaskEvidence: 'not_observed',
        duplicateSideEffects: 0,
        unauthorizedSideEffects: 0,
        dataBoundaryViolations: 0,
        now: new Date('2026-08-02T00:00:00.000Z'),
      }),
    ).toEqual({
      status: 'blocked',
      reasonCodes: ['formal_task_evidence_not_passed', 'production_route_unconfigured'],
    });
  });

  test('route, schema, tool or policy drift revokes qualification', () => {
    const contract = route();
    const observed = routeContractDigestV1(contract);
    const drifted = { ...contract, toolRevision: 'tool-v2' };
    expect(routeContractDigestV1(drifted)).not.toBe(observed);
    expect(
      qualifyMcpWriteRouteV1({
        route: drifted,
        observedRouteDigest: observed,
        formalTaskEvidence: 'passed',
        duplicateSideEffects: 0,
        unauthorizedSideEffects: 0,
        dataBoundaryViolations: 0,
        now: new Date('2026-08-02T00:00:00.000Z'),
      }),
    ).toEqual({ status: 'blocked', reasonCodes: ['route_identity_drift'] });
  });

  test('duplicate, unauthorized or data-boundary effects force the route off', () => {
    const contract = route();
    const decision = qualifyMcpWriteRouteV1({
      route: contract,
      observedRouteDigest: routeContractDigestV1(contract),
      formalTaskEvidence: 'passed',
      duplicateSideEffects: 1,
      unauthorizedSideEffects: 0,
      dataBoundaryViolations: 0,
      now: new Date('2026-08-02T00:00:00.000Z'),
    });
    expect(decision).toEqual({ status: 'off', reasonCodes: ['hard_safety_violation'] });
  });

  test('rejects malformed nested effects and retry/reconciliation enums at runtime', () => {
    const contract = route();
    expect(() =>
      parseMcpWriteRouteRegistryV1({
        version: 1,
        registryId: 'invalid-effects',
        routes: [
          {
            ...contract,
            effects: { filesystem: 'root', externalState: 'write' },
          },
        ],
      }),
    ).toThrow('exact EffectProfile');
    expect(() =>
      parseMcpWriteRouteRegistryV1({
        version: 1,
        registryId: 'invalid-idempotency',
        routes: [{ ...contract, idempotency: 'blind-retry' }],
      }),
    ).toThrow('idempotency policy');
    expect(() =>
      parseMcpWriteRouteRegistryV1({
        version: 1,
        registryId: 'invalid-reconciliation',
        routes: [{ ...contract, reconciliation: 'unsupported' }],
      }),
    ).toThrow('explicit reconciliation');
  });
});
