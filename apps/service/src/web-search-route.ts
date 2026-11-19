import { createHash } from 'node:crypto';
import type { ModelConfiguration } from '@kite-ai/agent/config';
import type { Json } from '@kite-ai/agent/extensions';
import { parseModelPreset } from './model-options';
import type { SearchProviderConfig, WebSearchSettings } from './web-search-configuration';

type ProviderAdapter = SearchProviderConfig['adapter'];
export type SearchRoute =
  | { kind: 'none'; reason: 'disabled' | 'policy' | 'unconfigured' | 'unavailable' | 'parent' }
  | { kind: 'native'; provider: 'openai'; accountDigest: string; bindingDigest: string }
  | { kind: 'provider'; providerId: string; adapter: ProviderAdapter; bindingDigest: string };

const sha = (fields: readonly unknown[]) =>
  createHash('sha256').update(JSON.stringify(fields)).digest('hex');
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nativeSerializer = 'openai-4.0.19-websearch-backport-v1';

export function nativeSearchIdentity(
  model: ModelConfiguration,
  profile: string,
  subjectId: string,
) {
  if (
    model.provider !== 'openai' ||
    model.protocol !== 'responses' ||
    !['https://api.openai.com/v1', 'https://api.openai.com/v1/'].includes(model.baseURL ?? '') ||
    typeof model.credentialRef !== 'string' ||
    !/^credential:[0-9a-f-]{36}$/.test(model.credentialRef)
  )
    return undefined;
  const accountDigest = sha([
    profile,
    subjectId,
    model.provider,
    'https://api.openai.com/v1',
    model.providerName ?? null,
    model.credentialRef,
  ]);
  return {
    kind: 'native' as const,
    provider: 'openai' as const,
    accountDigest,
    bindingDigest: sha([
      accountDigest,
      model.id,
      model.model,
      parseModelPreset(model.options),
      'openai-web-search',
      nativeSerializer,
    ]),
  };
}

/** Only Service-created Run manifests can narrow a child or reconstruct a previous route. */
export function savedSearchRoute(raw: Json | undefined): SearchRoute | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (
    raw.kind === 'none' &&
    ['disabled', 'policy', 'unconfigured', 'unavailable', 'parent'].some(
      (reason) => raw.reason === reason,
    )
  )
    return raw as SearchRoute;
  if (
    raw.kind === 'native' &&
    raw.provider === 'openai' &&
    digest(raw.accountDigest) &&
    digest(raw.bindingDigest)
  )
    return {
      kind: raw.kind,
      provider: 'openai',
      accountDigest: raw.accountDigest,
      bindingDigest: raw.bindingDigest,
    };
  if (
    raw.kind === 'provider' &&
    typeof raw.providerId === 'string' &&
    (raw.adapter === 'deepseek-search' ||
      raw.adapter === 'perplexity-search' ||
      raw.adapter === 'openai-search') &&
    digest(raw.bindingDigest)
  )
    return {
      kind: raw.kind,
      providerId: raw.providerId,
      adapter: raw.adapter,
      bindingDigest: raw.bindingDigest,
    };
  return undefined;
}
export function savedServiceSnapshot(configuration: Json | undefined) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration))
    return null;
  let saved = configuration.snapshot;
  if (
    saved &&
    typeof saved === 'object' &&
    !Array.isArray(saved) &&
    saved.kind === 'human_input_processing'
  )
    saved = saved.originalConfiguration;
  if (
    saved &&
    typeof saved === 'object' &&
    !Array.isArray(saved) &&
    typeof saved.roleId === 'string'
  )
    saved = saved.configuration;
  return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : null;
}

export function inheritedSearchRoute(configuration: Json | undefined): SearchRoute | null {
  return savedSearchRoute(savedServiceSnapshot(configuration)?.webSearch) ?? null;
}

export function selectSearchRoute(input: {
  settings: WebSearchSettings;
  enabled: boolean;
  native?: Extract<SearchRoute, { kind: 'native' }>;
  provider?: Extract<SearchRoute, { kind: 'provider' }>;
  parent?: SearchRoute | null;
}): SearchRoute {
  if (input.settings.mode === 'disabled') return { kind: 'none', reason: 'disabled' };
  if (!input.enabled) return { kind: 'none', reason: 'policy' };
  if (input.parent === null || input.parent?.kind === 'none')
    return { kind: 'none', reason: 'parent' };
  if (
    input.native &&
    (input.parent === undefined ||
      (input.parent.kind === 'native' && input.parent.accountDigest === input.native.accountDigest))
  )
    return input.native;
  if (
    input.provider?.adapter === 'deepseek-search' &&
    input.settings.providerId === input.provider.providerId &&
    (input.parent === undefined ||
      (input.parent.kind === 'provider' &&
        input.parent.bindingDigest === input.provider.bindingDigest))
  )
    return input.provider;
  return {
    kind: 'none',
    reason: input.parent ? 'parent' : input.settings.providerId ? 'unavailable' : 'unconfigured',
  };
}
