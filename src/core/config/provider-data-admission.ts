import { readFileSync } from 'node:fs';
import {
  computeProviderDataPolicyBundleDigest,
  computeProviderEndpointIdentityDigest,
  type ProviderDataPolicyBundleV1,
  type ProviderDataPolicyV1,
  type ProviderRouteIdentityV1,
  parseProviderDataPolicyBundleV1,
  type WorkspaceDataLabelV1,
} from './provider-data-policy';

export type ProviderPayloadKindV1 = 'user_prompt' | 'file_snippet' | 'tool_result' | 'summary';

export interface ProviderPayloadPartV1 {
  kind: ProviderPayloadKindV1;
  text: string;
  label: WorkspaceDataLabelV1;
}

export interface ProviderDataPolicyRegistryV1 {
  version: 1;
  revision: string;
  digest: string;
  loadedAt: string;
  policiesByRouteDigest: Readonly<Record<string, ProviderDataPolicyV1>>;
}

export type ProviderDataAdmissionReasonV1 =
  | 'admitted'
  | 'feature_disabled'
  | 'mandatory_policy_unavailable'
  | 'provider_policy_missing'
  | 'provider_policy_not_yet_effective'
  | 'provider_policy_expired'
  | 'provider_route_identity_mismatch'
  | 'provider_payload_kind_denied'
  | 'provider_data_classification_denied'
  | 'provider_secret_denied';

export interface ProviderDataAdmissionDecisionV1 {
  admitted: boolean;
  reason: ProviderDataAdmissionReasonV1;
  routeAlias: string;
  registryDigest?: string;
  policyId?: string;
  policyRevision?: string;
  maxWorkspaceDataClassification?: ProviderDataPolicyV1['maxWorkspaceDataClassification'];
  allowedContentUses?: string[];
}

export interface ProviderDataAdmissionInputV1 {
  featureEnabled: boolean;
  profile: 'limited' | 'internal_experimental';
  registry?: ProviderDataPolicyRegistryV1;
  route: ProviderRouteIdentityV1;
  payload: ProviderPayloadPartV1[];
  now?: Date;
  expectedRegistryDigest?: string;
}

const CLASSIFICATION_RANK: Readonly<Record<WorkspaceDataLabelV1['classification'], number>> =
  Object.freeze({
    public: 0,
    internal: 1,
    confidential: 2,
    secret: 3,
  });

const POLICY_PAYLOAD_KEY: Readonly<
  Record<ProviderPayloadKindV1, keyof ProviderDataPolicyV1['allowedPayloadKinds']>
> = Object.freeze({
  user_prompt: 'userPrompt',
  file_snippet: 'fileSnippet',
  tool_result: 'toolResult',
  summary: 'summary',
});

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i,
  /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_=-]{16,}\b/,
] as const;

const PROTECTED_PATH_PATTERN =
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.kube|credentials?|secrets?)(?:$|[/\\])/i;

function safeRouteAlias(route: ProviderRouteIdentityV1): string {
  return `${route.providerType}:${route.operatorId}:${route.deploymentId}:${route.region}`;
}

function hasSecretMarker(part: ProviderPayloadPartV1): boolean {
  return (
    part.label.classification === 'secret' ||
    part.label.source === 'runtime_secret_detector' ||
    PROTECTED_PATH_PATTERN.test(part.text) ||
    SECRET_PATTERNS.some((pattern) => pattern.test(part.text))
  );
}

export function createProviderDataPolicyRegistryV1(
  bundle: ProviderDataPolicyBundleV1,
  loadedAt = new Date(),
): ProviderDataPolicyRegistryV1 {
  const parsed = parseProviderDataPolicyBundleV1(bundle);
  const policiesByRouteDigest: Record<string, ProviderDataPolicyV1> = {};
  for (const policy of parsed.policies) {
    if (policiesByRouteDigest[policy.endpointIdentityDigest]) {
      throw new Error(
        `Provider policy registry contains more than one policy for ${policy.endpointIdentityDigest}.`,
      );
    }
    policiesByRouteDigest[policy.endpointIdentityDigest] = policy;
  }
  return Object.freeze({
    version: 1 as const,
    revision: parsed.revision,
    digest: computeProviderDataPolicyBundleDigest(parsed),
    loadedAt: loadedAt.toISOString(),
    policiesByRouteDigest: Object.freeze(policiesByRouteDigest),
  });
}

export function loadProviderDataPolicyRegistryV1(
  filePath: string,
  loadedAt = new Date(),
): ProviderDataPolicyRegistryV1 {
  const source = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
  return createProviderDataPolicyRegistryV1(parseProviderDataPolicyBundleV1(source), loadedAt);
}

export function evaluateProviderDataAdmissionV1(
  input: ProviderDataAdmissionInputV1,
): ProviderDataAdmissionDecisionV1 {
  const routeAlias = safeRouteAlias(input.route);
  if (!input.featureEnabled) return { admitted: false, reason: 'feature_disabled', routeAlias };
  if (!input.registry) {
    return { admitted: false, reason: 'mandatory_policy_unavailable', routeAlias };
  }
  if (input.expectedRegistryDigest && input.expectedRegistryDigest !== input.registry.digest) {
    return {
      admitted: false,
      reason: 'provider_route_identity_mismatch',
      routeAlias,
      registryDigest: input.registry.digest,
    };
  }
  if (input.payload.some(hasSecretMarker)) {
    return {
      admitted: false,
      reason: 'provider_secret_denied',
      routeAlias,
      registryDigest: input.registry.digest,
    };
  }
  const routeDigest = computeProviderEndpointIdentityDigest(input.route);
  const policy = input.registry.policiesByRouteDigest[routeDigest];
  if (!policy) {
    const internalOnly = input.payload.every(
      (part) => CLASSIFICATION_RANK[part.label.classification] <= CLASSIFICATION_RANK.internal,
    );
    return {
      admitted: input.profile === 'internal_experimental' && internalOnly,
      reason:
        input.profile !== 'internal_experimental'
          ? 'provider_policy_missing'
          : internalOnly
            ? 'admitted'
            : 'provider_data_classification_denied',
      routeAlias,
      registryDigest: input.registry.digest,
    };
  }
  const now = (input.now ?? new Date()).getTime();
  if (now < Date.parse(policy.effectiveFrom)) {
    return {
      admitted: false,
      reason: 'provider_policy_not_yet_effective',
      routeAlias,
      registryDigest: input.registry.digest,
      policyId: policy.policyId,
      policyRevision: policy.revision,
    };
  }
  if (now >= Date.parse(policy.expiresAt)) {
    return {
      admitted: false,
      reason: 'provider_policy_expired',
      routeAlias,
      registryDigest: input.registry.digest,
      policyId: policy.policyId,
      policyRevision: policy.revision,
    };
  }
  if (policy.endpointIdentityDigest !== routeDigest) {
    return {
      admitted: false,
      reason: 'provider_route_identity_mismatch',
      routeAlias,
      registryDigest: input.registry.digest,
      policyId: policy.policyId,
      policyRevision: policy.revision,
    };
  }
  for (const part of input.payload) {
    if (!policy.allowedPayloadKinds[POLICY_PAYLOAD_KEY[part.kind]]) {
      return {
        admitted: false,
        reason: 'provider_payload_kind_denied',
        routeAlias,
        registryDigest: input.registry.digest,
        policyId: policy.policyId,
        policyRevision: policy.revision,
      };
    }
    if (
      CLASSIFICATION_RANK[part.label.classification] >
      CLASSIFICATION_RANK[policy.maxWorkspaceDataClassification]
    ) {
      return {
        admitted: false,
        reason: 'provider_data_classification_denied',
        routeAlias,
        registryDigest: input.registry.digest,
        policyId: policy.policyId,
        policyRevision: policy.revision,
      };
    }
  }
  return {
    admitted: true,
    reason: 'admitted',
    routeAlias,
    registryDigest: input.registry.digest,
    policyId: policy.policyId,
    policyRevision: policy.revision,
    maxWorkspaceDataClassification: policy.maxWorkspaceDataClassification,
    allowedContentUses: [
      `retention:${policy.contentRetention}`,
      `training:${policy.trainingUse}`,
      `request_logging:${policy.requestLogging}`,
    ],
  };
}

function promptPartText(part: unknown): string {
  if (typeof part === 'string') return part;
  if (part && typeof part === 'object') {
    if ('text' in part && typeof part.text === 'string') return part.text;
    if ('output' in part && typeof part.output === 'string') return part.output;
  }
  return JSON.stringify(part) ?? '';
}

/** Build provenance-bearing admission parts without mutating the provider prompt. */
export function providerPayloadFromModelPromptV1(
  prompt: readonly unknown[],
): ProviderPayloadPartV1[] {
  return prompt.flatMap((value) => {
    const message =
      value && typeof value === 'object' ? (value as Record<string, unknown>) : { content: value };
    const rawRole =
      typeof message.role === 'string'
        ? message.role
        : typeof message._getType === 'function'
          ? String((message._getType as () => unknown)())
          : typeof message.type === 'string'
            ? message.type
            : 'user';
    const role = rawRole === 'human' ? 'user' : rawRole === 'ai' ? 'assistant' : rawRole;
    const content = Array.isArray(message.content) ? message.content : [message.content];
    return content.map((part) => ({
      kind:
        role === 'tool'
          ? ('tool_result' as const)
          : role === 'system' || role === 'assistant'
            ? ('summary' as const)
            : ('user_prompt' as const),
      text: promptPartText(part),
      label: {
        classification: 'internal' as const,
        source: 'artifact' as const,
        provenance:
          role === 'tool'
            ? ('tool_result' as const)
            : role === 'system' || role === 'assistant'
              ? ('generated_summary' as const)
              : ('user_prompt' as const),
      },
    }));
  });
}

export class ProviderDataAdmissionError extends Error {
  readonly decision: ProviderDataAdmissionDecisionV1;

  constructor(decision: ProviderDataAdmissionDecisionV1) {
    super(`Provider data admission denied: ${decision.reason}.`);
    this.name = 'ProviderDataAdmissionError';
    this.decision = decision;
  }
}
