import { canonicalContextDigestV2 } from './context-preparation-v2';

export interface ContextReclaimRouteIdentityV1 {
  readonly providerName: string;
  readonly providerType: string;
  readonly modelName: string;
  readonly adapterRevision: string;
  readonly promptContractVersion: string;
  readonly projectionContractId: 'prepared-context-request:v2';
  readonly toolResultBudgetPolicyId: 'tool-result-budget-registry:v2';
  readonly reclaimPolicyId: 'context-reclaim-live:v2';
  readonly estimatorId: 'kite-count-tokens:v1';
  readonly runtimeSchemaVersion: 22;
}

export interface TrustedContextReclaimRouteEvidenceV1 {
  readonly version: 1;
  readonly routeIdentityDigest: string;
  readonly suiteDigest: string;
  readonly sourceRevision: string;
  readonly observedAt: string;
}

export type ContextReclaimRouteQualificationV1 =
  | {
      readonly status: 'qualified';
      readonly support: 'production';
      readonly evidence: TrustedContextReclaimRouteEvidenceV1;
    }
  | {
      readonly status: 'experimental_not_qualified';
      readonly support: 'development_only';
      readonly reason: 'trusted_route_evidence_missing';
    };

/**
 * Source-owned release registry. Slice A intentionally ships an empty support
 * set: synthetic, local and user-supplied observations cannot be promoted by
 * passing data to a resolver or by selecting a particular model name.
 */
const TRUSTED_CONTEXT_RECLAIM_ROUTE_EVIDENCE_V1: readonly TrustedContextReclaimRouteEvidenceV1[] =
  Object.freeze([]);

export function contextReclaimRouteIdentityDigestV1(
  identity: ContextReclaimRouteIdentityV1,
): string {
  return canonicalContextDigestV2('context-reclaim-route-identity:v1', identity);
}

export function resolveContextReclaimRouteQualificationV1(
  identity: ContextReclaimRouteIdentityV1,
): ContextReclaimRouteQualificationV1 {
  const routeIdentityDigest = contextReclaimRouteIdentityDigestV1(identity);
  const evidence = TRUSTED_CONTEXT_RECLAIM_ROUTE_EVIDENCE_V1.find(
    (candidate) => candidate.routeIdentityDigest === routeIdentityDigest,
  );
  return evidence
    ? { status: 'qualified', support: 'production', evidence }
    : {
        status: 'experimental_not_qualified',
        support: 'development_only',
        reason: 'trusted_route_evidence_missing',
      };
}

export function trustedContextReclaimRouteCountV1(): number {
  return TRUSTED_CONTEXT_RECLAIM_ROUTE_EVIDENCE_V1.length;
}
