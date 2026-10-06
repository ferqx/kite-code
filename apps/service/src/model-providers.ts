import { createHash } from 'node:crypto';
import { AgentError } from '@kite-ai/agent';
import type { JsonObject, ModelConfiguration } from '@kite-ai/agent/config';

/** Explicit protocol families; a discovered model name never chooses a Provider. */
export const modelProviders = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultBaseURL: 'https://api.openai.com/v1',
    requiresCredential: true,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    defaultBaseURL: 'https://api.deepseek.com',
    requiresCredential: true,
  },
  { id: 'compatible', label: 'OpenAI-compatible', defaultBaseURL: '', requiresCredential: false },
  {
    id: 'ollama',
    label: 'Ollama',
    defaultBaseURL: 'http://localhost:11434/v1',
    requiresCredential: false,
  },
] as const;
export type ModelProvider = (typeof modelProviders)[number]['id'];
export function isSupportedModelProvider(value: unknown): value is ModelProvider {
  return modelProviders.some((provider) => provider.id === value);
}
export function supportsReasoningEffort(provider: unknown): boolean {
  return provider === 'openai' || provider === 'compatible';
}

export type ProviderSettingsOperation = {
  provider: ModelProvider;
  connectionId: string | null;
  baseURL: string;
  modelNames: string[];
  credential: 'keep' | 'replace' | 'none';
};
export type ProviderSettingsConnection = {
  id: string;
  baseURL: string;
  hasCredential: boolean;
  modelNames: string[];
  canWrite: boolean;
};
export function providerConnectionId(model: JsonObject): string {
  return createHash('sha256')
    .update(JSON.stringify([model.provider, model.baseURL ?? null, model.credentialRef ?? null]))
    .digest('hex');
}
export function providerSettingsFacts(raw: JsonObject, models: readonly ModelConfiguration[]) {
  return modelProviders.map((provider) => {
    const groups = new Map<string, ProviderSettingsConnection>();
    for (const model of models) {
      if (model.provider !== provider.id || typeof model.baseURL !== 'string') continue;
      const id = providerConnectionId(model);
      let connection = groups.get(id);
      if (!connection) {
        connection = {
          id,
          baseURL: safeProviderEndpoint(model.baseURL),
          hasCredential: typeof model.credentialRef === 'string',
          modelNames: [],
          canWrite: true,
        };
        groups.set(id, connection);
      }
      connection.modelNames.push(model.model);
      const local = Array.isArray(raw.models)
        ? raw.models.find(
            (entry) =>
              entry && typeof entry === 'object' && !Array.isArray(entry) && entry.id === model.id,
          )
        : undefined;
      if (
        !local ||
        typeof local !== 'object' ||
        Array.isArray(local) ||
        providerConnectionId(local) !== id ||
        local.model !== model.model
      )
        connection.canWrite = false;
    }
    return { ...provider, connections: [...groups.values()] };
  });
}
/** Endpoints cannot smuggle a credential in URL userinfo, query or fragment. */
export function safeProviderEndpoint(value: string): string {
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error();
    return url.href.replace(/\/$/, '');
  } catch {
    throw new AgentError('invalid_provider_endpoint');
  }
}
export function providerModelNames(names: readonly string[]): string[] {
  const result = [...new Set(names.map((name) => name.trim()))];
  if (
    result.some(
      (name) =>
        !name ||
        Buffer.from(name, 'utf8').toString('utf8') !== name ||
        name.length > 256 ||
        /[\r\n]/.test(name) ||
        name.includes(String.fromCharCode(0)),
    )
  )
    throw new AgentError('invalid_provider_model_names');
  return result;
}
/** An explicit discovery request. Reads/cold startup never call this transport. */
export async function discoverProviderModels(baseURL: string, apiKey?: string): Promise<string[]> {
  const endpoint = `${safeProviderEndpoint(baseURL)}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) throw new AgentError('provider_discovery_failed');
    const reader = response.body?.getReader();
    if (!reader) throw new AgentError('provider_discovery_invalid');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 2 * 1048576) throw new AgentError('provider_discovery_too_large');
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !body ||
      typeof body !== 'object' ||
      !('data' in body) ||
      !Array.isArray(body.data) ||
      body.data.some(
        (item: unknown) =>
          !item || typeof item !== 'object' || !('id' in item) || typeof item.id !== 'string',
      )
    )
      throw new AgentError('provider_discovery_invalid');
    const names = providerModelNames(body.data.map((item: { id: string }) => item.id));
    if (!names.length) throw new AgentError('provider_discovery_empty');
    return names;
  } catch (error) {
    if (error instanceof AgentError) throw error;
    throw new AgentError('provider_discovery_unavailable');
  } finally {
    clearTimeout(timer);
  }
}
