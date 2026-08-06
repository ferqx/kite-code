import type { DiagnosticRouteIdentityV1 } from './evidence/live-observation-schema-v1';
import {
  L3_LIVE_AUTO_COMPACTION_BLOCKED_REASON_CODES_V1,
  L3_LIVE_AUTO_COMPACTION_POLICY_V1,
  L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1,
  type L3LiveAutoCompactionBlockedReasonCodeV1,
  l3LiveAutoCompactionPolicyIsClosedV1,
} from './live-auto-compaction-policy-v1';
import {
  L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1,
  L3_QWEN_LIVE_ROUTE_DECLARATION_V1,
  type LiveRouteModelBoundaryLeaseV1,
  resolveRegisteredLiveRouteLeaseV1,
} from './live-route-resolver-v1';

export interface ResolveL3LiveAutoCompactionRouteInputV1 {
  readonly explicitOptIn: boolean;
  /** Parent-supplied only; normal config/workspace/session loading has no path here. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now: string;
}

export interface L3LiveAutoCompactionRouteReadyV1 {
  readonly status: 'ready';
  readonly authority: 'diagnostic';
  readonly evidenceEligible: false;
  readonly route: DiagnosticRouteIdentityV1;
  readonly policyId: typeof L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyId;
  readonly policyDigest: typeof L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest;
  readonly governance: typeof L3_LIVE_AUTO_COMPACTION_POLICY_V1.governance;
  readonly credentialSource: 'environment';
  /** Non-enumerable on the returned result; never becomes report metadata. */
  readonly modelBoundary: LiveRouteModelBoundaryLeaseV1;
}

export interface L3LiveAutoCompactionRouteBlockedV1 {
  readonly status: 'blocked';
  readonly authority: 'diagnostic';
  readonly evidenceEligible: false;
  readonly reasonCode: L3LiveAutoCompactionBlockedReasonCodeV1;
  readonly route?: DiagnosticRouteIdentityV1;
  readonly policyId?: typeof L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyId;
  readonly policyDigest?: typeof L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest;
}

export type L3LiveAutoCompactionRouteResolutionV1 =
  | L3LiveAutoCompactionRouteReadyV1
  | L3LiveAutoCompactionRouteBlockedV1;

function blocked(
  reasonCode: L3LiveAutoCompactionBlockedReasonCodeV1,
  route?: DiagnosticRouteIdentityV1,
): L3LiveAutoCompactionRouteBlockedV1 {
  return Object.freeze({
    status: 'blocked' as const,
    authority: 'diagnostic' as const,
    evidenceEligible: false as const,
    reasonCode,
    ...(route ? { route } : {}),
    policyId: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyId,
    policyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest,
  });
}

function exactRoutePolicyBinding(): boolean {
  const policy = L3_LIVE_AUTO_COMPACTION_POLICY_V1;
  const declaration = L3_QWEN_LIVE_ROUTE_DECLARATION_V1;
  return (
    policy.routeId === declaration.routeId &&
    policy.routeDeclarationDigest === declaration.declarationDigest &&
    policy.routeIdentityDigest === L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1.routeIdentityDigest &&
    policy.providerDataPolicyDigest === L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.policyDigest &&
    policy.capabilityDeclarationDigest === declaration.capabilityDeclarationDigest &&
    policy.capabilitySourceBindingDigest === declaration.capabilitySourceBindingDigest &&
    policy.promptEnvironmentDigest === declaration.promptEnvironmentDigest &&
    policy.routeToolCatalogDigest === declaration.toolCatalogDigest &&
    policy.governance.profileId === declaration.governance.profileId &&
    policy.governance.profileDigest === declaration.governance.profileDigest &&
    policy.governance.retentionClass === declaration.governance.retentionClass
  );
}

/**
 * AQ-9B exact route binding. This accepts no caller-provided policy and first
 * validates the separate auto-compaction closure before it asks the common
 * registered-route resolver for a credential-only model lease.
 */
export function resolveL3LiveAutoCompactionRouteForModelBoundaryV1(
  input: ResolveL3LiveAutoCompactionRouteInputV1,
): L3LiveAutoCompactionRouteResolutionV1 {
  if (!l3LiveAutoCompactionPolicyIsClosedV1() || !exactRoutePolicyBinding()) {
    return blocked('route_policy_mismatch', L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1);
  }
  if (Date.parse(input.now) < Date.parse(L3_LIVE_AUTO_COMPACTION_POLICY_V1.issuedAt)) {
    return blocked('policy_not_active', L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1);
  }
  if (Date.parse(input.now) >= Date.parse(L3_LIVE_AUTO_COMPACTION_POLICY_V1.expiresAt)) {
    return blocked('policy_expired', L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1);
  }
  const registered = resolveRegisteredLiveRouteLeaseV1({
    explicitOptIn: input.explicitOptIn,
    routeId: L3_LIVE_AUTO_COMPACTION_POLICY_V1.routeId,
    environment: input.environment,
    now: input.now,
  });
  if (registered.status === 'blocked') {
    const reason = L3_LIVE_AUTO_COMPACTION_BLOCKED_REASON_CODES_V1.includes(
      registered.reasonCode as L3LiveAutoCompactionBlockedReasonCodeV1,
    )
      ? (registered.reasonCode as L3LiveAutoCompactionBlockedReasonCodeV1)
      : 'policy_invalid';
    return blocked(reason, registered.route);
  }
  if (
    registered.route.routeIdentityDigest !==
      L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1.routeIdentityDigest ||
    registered.governance.profileId !== L3_LIVE_AUTO_COMPACTION_POLICY_V1.governance.profileId ||
    registered.governance.profileDigest !==
      L3_LIVE_AUTO_COMPACTION_POLICY_V1.governance.profileDigest
  ) {
    return blocked('route_policy_mismatch', registered.route);
  }

  const result: Omit<L3LiveAutoCompactionRouteReadyV1, 'modelBoundary'> = {
    status: 'ready',
    authority: 'diagnostic',
    evidenceEligible: false,
    route: L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1,
    policyId: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyId,
    policyDigest: L3_LIVE_AUTO_COMPACTION_POLICY_V1.policyDigest,
    governance: L3_LIVE_AUTO_COMPACTION_POLICY_V1.governance,
    credentialSource: 'environment',
  };
  Object.defineProperty(result, 'modelBoundary', {
    enumerable: false,
    value: registered.modelBoundary,
  });
  return Object.freeze(result as L3LiveAutoCompactionRouteReadyV1);
}
