import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ModelProviderDispatchPurposeV1 } from '@/protocol/model-surface';
import { createRuntimeSecretDetectorV1 } from '../session-logger/content-inspector';
import type { SessionLoggingContentInspectorV1 } from '../session-logger/types';
import type { AgentConfig } from './index';
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
/** @deprecated Import ModelProviderDispatchPurposeV1 from the protocol contract. */
export type ProviderDispatchPurposeV1 = ModelProviderDispatchPurposeV1;

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
  | 'provider_content_evaluation_denied'
  | 'provider_content_inspection_unknown'
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
  purpose?: ProviderDispatchPurposeV1;
  now?: Date;
  expectedRegistryDigest?: string;
  contentInspector?: SessionLoggingContentInspectorV1;
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

export const APPROVED_PROVIDER_DATA_POLICY_REVISION_V1 = 'd14-deepseek-owner-accepted-2026-08-02.3';
export const APPROVED_PROVIDER_DATA_POLICY_DIGEST_V1 =
  'sha256:6d1a0c29d135e4cd6cee3a4ecb8b9e567078c2d2c530c6217fe1710dc5e3cb39';

/**
 * Production loader for the repository-controlled, release-pinned policy
 * artifact. It has no caller-supplied path or digest.
 */
export function loadApprovedProviderDataPolicyRegistryV1(
  loadedAt = new Date(),
): ProviderDataPolicyRegistryV1 {
  const approvedPath = new URL(
    '../../../release/provider-data-policies/approved-v1.json',
    import.meta.url,
  );
  const registry = loadProviderDataPolicyRegistryV1(fileURLToPath(approvedPath), loadedAt);
  if (
    registry.revision !== APPROVED_PROVIDER_DATA_POLICY_REVISION_V1 ||
    registry.digest !== APPROVED_PROVIDER_DATA_POLICY_DIGEST_V1
  ) {
    throw new Error('Approved Provider data policy artifact does not match the release pin.');
  }
  return registry;
}

/** Canonical route identity derived from resolved runtime config, never project overlays. */
export function providerRouteIdentityFromAgentConfigV1(
  config: AgentConfig,
): ProviderRouteIdentityV1 {
  if (isApprovedDeepSeekV4FlashRoute(config)) {
    return {
      providerType: 'deepseek',
      operatorId: 'hangzhou-deepseek-ai',
      endpointOrigin: 'https://api.deepseek.com',
      endpointClass: 'official_api',
      deploymentId: 'deepseek-api',
      region: 'unspecified',
    };
  }
  return {
    providerType: config.providerType,
    operatorId: config.providerName,
    endpointOrigin: config.baseURL,
    endpointClass:
      config.providerType === 'openai-compatible' ? 'custom_configured' : 'managed_default',
    deploymentId: config.modelName,
    region: 'unspecified',
  };
}

function isApprovedDeepSeekV4FlashRoute(config: AgentConfig): boolean {
  if (config.providerType !== 'deepseek' || config.modelName !== 'deepseek-v4-flash') return false;
  try {
    const endpoint = new URL(config.baseURL);
    const path = endpoint.pathname.replace(/\/+$/, '');
    return (
      endpoint.protocol === 'https:' &&
      endpoint.username === '' &&
      endpoint.password === '' &&
      endpoint.origin === 'https://api.deepseek.com' &&
      (path === '' || path === '/v1') &&
      endpoint.search === '' &&
      endpoint.hash === ''
    );
  } catch {
    return false;
  }
}

export type ProviderDataAdmissionGateV1 = (
  payload: ProviderPayloadPartV1[],
  purpose?: ProviderDispatchPurposeV1,
) => ProviderDataAdmissionDecisionV1;

/**
 * Sealed production gate. Limited clients can only use the release-pinned
 * registry; configuration may select a route but cannot add policy.
 */
export function createApprovedProviderDataAdmissionV1(
  config: AgentConfig,
  loadedAt = new Date(),
  contentInspector: SessionLoggingContentInspectorV1 = createRuntimeSecretDetectorV1({
    knownSecrets: [config.apiKey],
  }),
): ProviderDataAdmissionGateV1 {
  const registry = loadApprovedProviderDataPolicyRegistryV1(loadedAt);
  const route = providerRouteIdentityFromAgentConfigV1(config);
  return (payload, purpose = 'primary_model') =>
    evaluateProviderDataAdmissionV1({
      featureEnabled: true,
      profile: 'limited',
      registry,
      expectedRegistryDigest: APPROVED_PROVIDER_DATA_POLICY_DIGEST_V1,
      route,
      payload,
      purpose,
      contentInspector,
    });
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
  if (input.contentInspector) {
    for (const part of input.payload) {
      let verdict: 'clear' | 'secret' | 'unknown' = 'unknown';
      try {
        const inspection = input.contentInspector({
          text: part.text,
          provenance:
            part.label.provenance === 'generated_summary' ? 'model_visible_answer' : 'user_message',
        });
        if (inspection.schemaVersion === 1 && inspection.detector === 'runtime_secret_detector') {
          verdict = inspection.verdict;
        }
      } catch {
        verdict = 'unknown';
      }
      if (verdict !== 'clear') {
        return {
          admitted: false,
          reason:
            verdict === 'secret' ? 'provider_secret_denied' : 'provider_content_inspection_unknown',
          routeAlias,
          registryDigest: input.registry.digest,
        };
      }
    }
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
  if (
    (input.purpose === 'auto_review' || input.purpose === 'verification_review') &&
    !policy.allowProductionContentEvaluation
  ) {
    return {
      admitted: false,
      reason: 'provider_content_evaluation_denied',
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
        // Provider message objects do not retain workspace/admin labels.
        // Treat user/tool content conservatively as confidential; only
        // generated/runtime-owned system and assistant text is internal.
        classification:
          role === 'system' || role === 'assistant'
            ? ('internal' as const)
            : ('confidential' as const),
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
  readonly knownExternalEffects: 'none' | 'unknown';

  constructor(
    decision: ProviderDataAdmissionDecisionV1,
    options: { knownExternalEffects?: 'none' | 'unknown' } = {},
  ) {
    super(`Provider data admission denied: ${decision.reason}.`);
    this.name = 'ProviderDataAdmissionError';
    this.decision = decision;
    this.knownExternalEffects = options.knownExternalEffects ?? 'none';
  }
}
