import { saveProviderConfig } from '@/core/config';
import type {
  AvailableModel,
  ConnectionError,
  ConnectProviderInput,
  ConnectProviderResult,
  ProviderDefinition,
} from './types';
import { chooseInitialModel, classifyError } from './types';

async function fetchModels(
  provider: ProviderDefinition,
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ models: AvailableModel[] | null; error?: ConnectionError }> {
  if (!provider.supportsModelDiscovery) {
    return { models: null };
  }

  const url = baseURL.replace(/\/+$/, '');
  const isOllama = provider.type === 'ollama';
  const endpoint = isOllama ? `${url}/api/tags` : `${url}/models`;
  const headers: Record<string, string> = {};
  if (!isOllama && apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(endpoint, {
      headers,
      signal: signal ?? AbortSignal.timeout(8000),
    });

    if (res.status === 401 || res.status === 403) {
      return { models: null, error: classifyError(res.status, '', url) };
    }

    if (!res.ok) {
      try {
        const body = await res.text();
        return {
          models: null,
          error: { kind: 'incompatible', message: body.slice(0, 200) },
        };
      } catch {
        return {
          models: null,
          error: { kind: 'incompatible', message: `HTTP ${res.status}` },
        };
      }
    }

    const data: any = await res.json();
    const items: any[] = isOllama ? (data?.models ?? []) : (data?.data ?? []);
    const names: AvailableModel[] = [];
    for (const it of items) {
      const rawName = isOllama ? it?.name : it?.id;
      if (typeof rawName === 'string' && rawName.length > 0) {
        names.push({ name: rawName, default: false });
      }
    }

    if (names.length === 0 && isOllama && data?.models === undefined) {
      return {
        models: null,
        error: { kind: 'incompatible', message: 'Could not read model list' },
      };
    }

    if (names.length > 0) {
      const first = names[0]!;
      names[0] = { name: first.name, default: true };
    }

    return { models: names };
  } catch (err: any) {
    // User-initiated abort — silently bail, caller handles cancellation
    if (signal?.aborted) {
      return { models: null, error: { kind: 'generic', message: 'Cancelled' } };
    }
    return {
      models: null,
      error: classifyError(null, err?.message ?? String(err), url),
    };
  }
}

async function validateCredentials(
  provider: ProviderDefinition,
  baseURL: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<{ valid: boolean; error?: ConnectionError }> {
  if (provider.type === 'ollama') {
    const url = baseURL.replace(/\/+$/, '');
    try {
      const res = await fetch(url, { signal: signal ?? AbortSignal.timeout(5000) });
      if (!res.ok) {
        return {
          valid: false,
          error: { kind: 'unreachable', message: `HTTP ${res.status}`, details: url },
        };
      }
      return { valid: true };
    } catch (err: any) {
      return {
        valid: false,
        error: classifyError(null, err?.message ?? String(err), url),
      };
    }
  }

  if (provider.apiKey === 'none') return { valid: true };

  if (provider.apiKey !== 'optional' && !apiKey.trim()) {
    return { valid: false, error: { kind: 'auth', message: 'API key is required' } };
  }

  const url = baseURL.replace(/\/+$/, '');
  try {
    const headers: Record<string, string> = {};
    if (apiKey.trim()) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const res = await fetch(`${url}/models`, {
      headers,
      signal: signal ?? AbortSignal.timeout(8000),
    });

    if (res.status === 401 || res.status === 403) {
      return { valid: false, error: classifyError(res.status, '', url) };
    }

    return { valid: true };
  } catch (err: any) {
    return {
      valid: false,
      error: classifyError(null, err?.message ?? String(err), url),
    };
  }
}

interface ConnectOptions {
  provider: ProviderDefinition;
  apiKey: string;
  baseURL: string;
  signal?: AbortSignal;
  saveApiKey?: boolean;
  saveBaseURL?: boolean;
}

async function connectAndSave(options: ConnectOptions): Promise<ConnectProviderResult> {
  const { provider, apiKey, baseURL, signal, saveApiKey, saveBaseURL } = options;

  const { valid, error } = await validateCredentials(provider, baseURL, apiKey, signal);
  if (!valid) return { status: 'failed', error: error! };

  const { models, error: fetchError } = await fetchModels(provider, baseURL, apiKey, signal);
  if (fetchError) return { status: 'failed', error: fetchError };

  if (!models || models.length === 0) {
    return { status: 'model-required', message: 'No models were detected at this endpoint.' };
  }

  const chosen = chooseInitialModel(provider, models);
  if (!chosen) {
    return { status: 'model-required', message: 'No models available.' };
  }

  const saved = saveProviderConfig({
    name: provider.type,
    type: provider.type,
    apiKey: saveApiKey ? apiKey : undefined,
    baseURL: saveBaseURL ? baseURL : undefined,
    models: models.map((m) => ({ name: m.name, default: m.name === chosen.name })),
    reasoning: provider.defaultReasoning === 'on',
    effort: provider.defaultReasoning === 'on' ? 'max' : undefined,
  });

  if (!saved) {
    return { status: 'failed', error: { kind: 'generic', message: 'Failed to write config file' } };
  }

  return { status: 'connected', modelName: chosen.name };
}

export async function connectProvider(input: ConnectProviderInput): Promise<ConnectProviderResult> {
  const { provider, signal } = input;

  return connectAndSave({
    provider,
    apiKey: '',
    baseURL: provider.defaultBaseURL,
    signal,
    saveApiKey: false,
    saveBaseURL: false,
  });
}

export async function connectProviderWithKey(
  provider: ProviderDefinition,
  apiKey: string,
  baseURL: string,
  signal?: AbortSignal,
): Promise<ConnectProviderResult> {
  return connectAndSave({
    provider,
    apiKey,
    baseURL,
    signal,
    saveApiKey: true,
    saveBaseURL: baseURL !== provider.defaultBaseURL,
  });
}
