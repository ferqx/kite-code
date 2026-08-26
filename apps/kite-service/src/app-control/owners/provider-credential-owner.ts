import type { AppModelProviderType } from '@kite-ai/kite-app-contract';
import {
  decodeLocalRuntimeCredentialRequest,
  LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
  type LocalRuntimeCredentialErrorCode,
  type NativeProviderCredentialClient,
  type NativeProviderCredentialRequest,
  type NativeProviderCredentialResult,
} from '@kite-ai/kite-local-runtime/client';
import {
  type SaveProviderInput,
  saveProviderConfig as writeProviderConfig,
} from '#kite-service/config';

interface ProviderCredentialDefaults {
  readonly baseURL: string;
  readonly apiKey: 'required' | 'optional';
}

const PROVIDER_DEFAULTS: Readonly<Record<AppModelProviderType, ProviderCredentialDefaults>> =
  Object.freeze({
    deepseek: {
      baseURL: 'https://api.deepseek.com/v1',
      apiKey: 'required',
    },
    openai: {
      baseURL: 'https://api.openai.com/v1',
      apiKey: 'required',
    },
    'openai-compatible': {
      baseURL: 'http://localhost:8080/v1',
      apiKey: 'optional',
    },
    ollama: {
      baseURL: 'http://localhost:11434',
      apiKey: 'optional',
    },
  });

const MAX_MODEL_NAME_LENGTH = 256;
type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderCredentialOwnerOptions {
  /** Isolated tests can provide a transport without changing production policy. */
  readonly fetch?: ProviderFetch;
  /** Isolated tests can observe the safe config projection without writing user state. */
  readonly saveProviderConfig?: (input: SaveProviderInput) => boolean;
  /** Explicit Service-owned config path; never infer a home from ambient env. */
  readonly configPath?: string;
  readonly requestTimeoutMs?: number;
}

interface ModelListResponse {
  readonly models?: unknown;
  readonly data?: unknown;
}

interface ProviderModelItem {
  readonly name?: unknown;
  readonly id?: unknown;
}

type FetchResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly errorCode: LocalRuntimeCredentialErrorCode };

function result(
  request: NativeProviderCredentialRequest,
  outcome: NativeProviderCredentialResult['outcome'],
  errorCode?: LocalRuntimeCredentialErrorCode,
): NativeProviderCredentialResult {
  return {
    schema: LOCAL_RUNTIME_CREDENTIAL_RESULT_SCHEMA_,
    mutationId: request.mutationId,
    operation: request.operation,
    outcome,
    ...(outcome === 'applied' ? { credentialPresent: true } : {}),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

function normalizeBaseURL(
  provider: ProviderCredentialDefaults,
  supplied: string | undefined,
): string {
  const raw = (supplied ?? provider.baseURL).trim();
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Provider endpoint must use HTTP or HTTPS.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Provider endpoint must not contain credentials.');
  }
  return raw.replace(/\/+$/, '');
}

function modelName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_MODEL_NAME_LENGTH || /\p{Cc}/u.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function extractModelNames(response: unknown, provider: AppModelProviderType): string[] {
  if (!response || typeof response !== 'object') return [];
  const body = response as ModelListResponse;
  const rawItems = provider === 'ollama' ? body.models : body.data;
  if (!Array.isArray(rawItems)) return [];

  const seen = new Set<string>();
  const names: string[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== 'object') continue;
    const candidate =
      provider === 'ollama' ? (item as ProviderModelItem).name : (item as ProviderModelItem).id;
    const name = modelName(candidate);
    if (name !== undefined && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

function endpointFor(provider: AppModelProviderType, baseURL: string): string {
  return provider === 'ollama' ? `${baseURL}/api/tags` : `${baseURL}/models`;
}

async function fetchModelList(
  provider: AppModelProviderType,
  baseURL: string,
  apiKey: string,
  options: ProviderCredentialOwnerOptions,
  signal?: AbortSignal,
): Promise<FetchResult> {
  const request = options.fetch ?? globalThis.fetch;
  if (typeof request !== 'function') {
    return { ok: false, errorCode: 'temporarily_unavailable' };
  }

  const headers: Record<string, string> = {};
  if (provider !== 'ollama' && apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await request(endpointFor(provider, baseURL), {
      headers,
      signal: signal ?? AbortSignal.timeout(options.requestTimeoutMs ?? 8_000),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, errorCode: 'credential_unavailable' };
    }
    if (response.status === 404) {
      return { ok: false, errorCode: 'not_found' };
    }
    if (!response.ok) {
      return { ok: false, errorCode: 'provider_incompatible' };
    }
    try {
      return { ok: true, data: await response.json() };
    } catch {
      return { ok: false, errorCode: 'model_required' };
    }
  } catch {
    return { ok: false, errorCode: 'temporarily_unavailable' };
  }
}

function save(
  request: NativeProviderCredentialRequest,
  provider: AppModelProviderType,
  baseURL: string,
  defaultBaseURL: string,
  models: readonly string[],
  options: ProviderCredentialOwnerOptions,
): NativeProviderCredentialResult {
  const saveConfig =
    options.saveProviderConfig ??
    ((value: SaveProviderInput) => writeProviderConfig(value, options.configPath));
  // Config resolution has built-in URLs only for DeepSeek/Ollama. Persist
  // the endpoint for OpenAI and custom providers even when it equals the UI
  // default, otherwise the next probe cannot reconstruct the route.
  const persistBaseURL =
    (provider !== 'deepseek' && provider !== 'ollama') || baseURL !== defaultBaseURL;
  const input: SaveProviderInput = {
    name: request.providerId,
    type: provider,
    ...(request.apiKey.trim() ? { apiKey: request.apiKey } : {}),
    ...(persistBaseURL ? { baseURL } : {}),
    models: models.map((name, index) => ({ name, default: index === 0 })),
    // The current first-run definitions use "automatic" reasoning. Preserve
    // the previous saveProviderConfig projection instead of selecting a
    // provider policy inside this Native owner.
    reasoning: false,
  };
  try {
    return saveConfig(input)
      ? result(request, 'applied')
      : result(request, 'rejected', 'temporarily_unavailable');
  } catch {
    // A write that throws may have partially reached disk. Never ask the TUI
    // to replay it; report uncertainty for the query-and-decide flow.
    return result(request, 'outcome_unknown');
  }
}

/**
 * Native owner for the current first-run provider credential journey. Raw
 * credential material is accepted only here, used for the one discovery
 * request, and never returned in an error/result projection.
 */
export function createProviderCredentialOwner(
  options: ProviderCredentialOwnerOptions = {},
): NativeProviderCredentialClient {
  return Object.freeze({
    async writeProviderCredential(
      input: NativeProviderCredentialRequest,
      context?: { readonly signal?: AbortSignal },
    ): Promise<NativeProviderCredentialResult> {
      let request: NativeProviderCredentialRequest;
      try {
        const decoded = decodeLocalRuntimeCredentialRequest(input);
        if (decoded.operation !== 'write_provider_api_key') {
          throw new Error('Provider credential operation is not supported.');
        }
        request = decoded;
      } catch {
        // The request type is normally checked by the Native client codec. Keep
        // the owner fail-closed if an untyped transport calls it directly.
        throw new Error('Invalid provider credential request.');
      }

      const defaults = PROVIDER_DEFAULTS[request.providerId as AppModelProviderType];
      if (!defaults) return result(request, 'rejected', 'invalid_request');
      if (defaults.apiKey === 'required' && !request.apiKey.trim()) {
        return result(request, 'rejected', 'invalid_request');
      }

      let baseURL: string;
      try {
        baseURL = normalizeBaseURL(defaults, request.baseURL);
      } catch {
        return result(request, 'rejected', 'invalid_request');
      }

      // Manual model entry is an explicit continuation after discovery was
      // unavailable. It still writes through this owner, but never repeats a
      // network mutation or silently chooses a different model.
      if (request.modelName !== undefined) {
        const manual = modelName(request.modelName);
        if (manual === undefined) return result(request, 'rejected', 'invalid_request');
        if (context?.signal?.aborted) return result(request, 'rejected', 'temporarily_unavailable');
        return save(
          request,
          request.providerId as AppModelProviderType,
          baseURL,
          defaults.baseURL,
          [manual],
          options,
        );
      }

      const fetched = await fetchModelList(
        request.providerId as AppModelProviderType,
        baseURL,
        request.apiKey,
        options,
        context?.signal,
      );
      if (!fetched.ok) return result(request, 'rejected', fetched.errorCode);
      if (context?.signal?.aborted) return result(request, 'rejected', 'temporarily_unavailable');

      const models = extractModelNames(fetched.data, request.providerId as AppModelProviderType);
      if (models.length === 0) return result(request, 'rejected', 'model_required');
      return save(
        request,
        request.providerId as AppModelProviderType,
        baseURL,
        defaults.baseURL,
        models,
        options,
      );
    },
  });
}
