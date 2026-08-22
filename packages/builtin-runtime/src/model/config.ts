import { createHash } from 'node:crypto';

export type ModelProviderTypeV1 = 'deepseek' | 'openai' | 'openai-compatible' | 'ollama';

/** Structural projection of AgentConfig consumed only by Builtin model semantics. */
export interface ModelRuntimeConfigV1 {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly modelName: string;
  readonly providerName: string;
  readonly providerType: ModelProviderTypeV1;
  readonly reasoningEffort?: string | null;
  readonly reasoning?: boolean;
  readonly reasoningExplicitlyDisabled?: boolean;
  readonly modelKwargs?: Readonly<Record<string, unknown>>;
  readonly modelCapabilities?: Readonly<{
    contextWindowTokens?: number;
    maxOutputTokens?: number;
    tokenizerFamily?: string;
    supportsUsageMetadata?: boolean;
    supportsPromptCache?: boolean;
    streaming?: boolean;
  }>;
  readonly features?: Readonly<Record<string, boolean | undefined>>;
  readonly sandbox: Readonly<{ enabled: boolean }>;
  readonly autoReview?: Readonly<{
    provider?: string;
    model?: string;
    timeoutMs?: number;
    failOpen?: boolean;
    doomLoopRepeatThreshold?: number;
    circuitBreakerMaxRejections?: number;
    circuitBreakerWindowMs?: number;
  }>;
  readonly compaction?: Readonly<{
    autoMode?: 'off' | 'shadow' | 'live';
    cohortSalt?: string;
    livePercentage?: number;
    localDebug?: Readonly<{ enabled: boolean; directory: string }>;
    triggerRatio?: number;
    compactAfterEstimatedTokens?: number;
    maxSummaryTokens?: number;
    maxSummaryInputTokens?: number;
    maxNarrativeTokens?: number;
    compactRatio?: number;
    hardRatio?: number;
    warningRatio?: number;
    minimumReductionRatio?: number;
    cooldownTurns?: number;
    providerSafetyRatio?: number;
  }>;
}

interface ProviderRouteIdentityV1 {
  readonly providerType: string;
  readonly operatorId: string;
  readonly endpointOrigin: string;
  readonly endpointClass: string;
  readonly deploymentId: string;
  readonly region: string;
}

export function providerRouteIdentityFromModelConfigV1(
  config: ModelRuntimeConfigV1,
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

export function computeProviderEndpointIdentityDigestV1(value: ProviderRouteIdentityV1): string {
  const canonical = canonicalJson(normalizeProviderRouteIdentityV1(value));
  return `sha256:${createHash('sha256')
    .update('kite.provider-route-identity.v1\0')
    .update(canonical)
    .digest('hex')}`;
}

function isApprovedDeepSeekV4FlashRoute(config: ModelRuntimeConfigV1): boolean {
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

function normalizeProviderRouteIdentityV1(value: ProviderRouteIdentityV1): ProviderRouteIdentityV1 {
  const endpoint = new URL(value.endpointOrigin);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('endpointOrigin must not include credentials, query parameters, or fragments.');
  }
  const pathname = endpoint.pathname.replace(/\/+$/, '');
  return {
    ...value,
    providerType: value.providerType.toLowerCase(),
    endpointOrigin: `${endpoint.protocol.toLowerCase()}//${endpoint.host.toLowerCase()}${pathname}`,
    endpointClass: value.endpointClass.toLowerCase(),
    region: value.region.toLowerCase(),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Canonical JSON does not allow non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error(`Unsupported canonical JSON value: ${typeof value}.`);
}
