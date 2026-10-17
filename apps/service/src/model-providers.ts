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
export type ModelProtocol = 'chat-completions' | 'responses';
export function modelProtocol(provider: unknown, protocol: unknown): ModelProtocol {
  if (protocol === undefined) return 'chat-completions';
  if (protocol !== 'chat-completions' && protocol !== 'responses')
    throw new AgentError('invalid_model_protocol');
  if (protocol === 'responses' && provider !== 'openai' && provider !== 'compatible')
    throw new AgentError('model_protocol_unsupported');
  return protocol;
}

export type ProviderSettingsOperation = {
  kind?: 'upsert' | 'remove';
  name?: string;
  provider: ModelProvider;
  protocol?: ModelProtocol;
  connectionId: string | null;
  baseURL: string;
  modelNames: string[];
  credential: 'keep' | 'replace' | 'none';
};
export type ProviderDiscoveryOperation = Omit<ProviderSettingsOperation, 'modelNames' | 'kind'>;
export type ProviderSettingsConnection = {
  protocol: ModelProtocol;
  id: string;
  name?: string;
  modelIds?: string[];
  defaultModelIds?: string[];
  baseURL: string;
  hasCredential: boolean;
  modelNames: string[];
  canWrite: boolean;
};
export function providerConnectionId(model: JsonObject): string {
  // User-format aliases already own route identity; their display name is independent.
  if (typeof model.providerName === 'string')
    return createHash('sha256')
      .update(JSON.stringify(['user-provider-v1', model.providerName]))
      .digest('hex');
  if (typeof model.connectionId === 'string' && /^[a-f0-9]{64}$/.test(model.connectionId))
    return model.connectionId;
  return createHash('sha256')
    .update(
      JSON.stringify([
        model.provider,
        model.baseURL ?? null,
        model.credentialRef ?? null,
        ...(model.protocol === 'responses' ? ['responses'] : []),
      ]),
    )
    .digest('hex');
}
export function providerConnectionName(value: string): string {
  const name = value.trim();
  if (
    !name ||
    name.length > 120 ||
    [...name].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    Buffer.from(name, 'utf8').toString('utf8') !== name
  )
    throw new AgentError('invalid_provider_name');
  return name;
}
export function providerSettingsFacts(
  raw: JsonObject,
  models: readonly ModelConfiguration[],
  defaultModelId: string | null = null,
) {
  const declarations = Array.isArray(raw._providerConnections)
    ? (raw._providerConnections as JsonObject[])
    : [];
  const localModels = Array.isArray(raw.models)
    ? (raw.models as ModelConfiguration[]).filter((model) => model.remove !== true)
    : [];
  const owners = new Map<string, JsonObject>();
  const conflicting = new Set<string>();
  for (const entry of [...declarations, ...localModels, ...models]) {
    const id = providerConnectionId(entry);
    const owner = owners.get(id);
    if (
      owner &&
      ['provider', 'protocol', 'baseURL', 'credentialRef', 'providerName', 'providerLabel'].some(
        (key) => owner[key] !== entry[key],
      )
    )
      conflicting.add(id);
    else owners.set(id, entry);
  }
  return modelProviders.map((provider) => {
    const groups = new Map<string, ProviderSettingsConnection>();
    const family = (entry: JsonObject) =>
      isSupportedModelProvider(entry.provider) ? entry.provider : 'compatible';
    const add = (model: JsonObject) => {
      const id = providerConnectionId(model);
      let connection = groups.get(id);
      if (connection) return connection;
      let baseURL = '',
        protocol: ModelProtocol = 'chat-completions',
        canWrite =
          !conflicting.has(id) &&
          isSupportedModelProvider(model.provider) &&
          (model.credentialRef === undefined ||
            (typeof model.credentialRef === 'string' &&
              /^credential:[0-9a-f-]{36}$/.test(model.credentialRef)));
      try {
        baseURL = safeProviderEndpoint(String(model.baseURL ?? ''));
        protocol = modelProtocol(model.provider, model.protocol);
      } catch {
        canWrite = false;
      }
      let name = provider.label as string;
      try {
        name = providerConnectionName(
          String(model.providerLabel ?? model.providerName ?? provider.label),
        );
      } catch {
        /* Legacy labels are not trusted display or write targets. */
      }
      connection = {
        id,
        name,
        protocol,
        baseURL,
        hasCredential: typeof model.credentialRef === 'string',
        modelNames: [],
        modelIds: [],
        defaultModelIds: [],
        canWrite,
      };
      groups.set(id, connection);
      return connection;
    };
    // Include explicit declarations even when they currently have no model routes.
    for (const declaration of declarations)
      if (family(declaration) === provider.id) add(declaration);
    for (const model of localModels) {
      if (family(model) !== provider.id) continue;
      const connection = add(model);
      connection.modelNames.push(model.model);
      connection.modelIds!.push(model.id);
      if (model.id === defaultModelId || model.id === raw.modelId)
        connection.defaultModelIds!.push(model.id);
      const actual = models.find((entry) => entry.id === model.id);
      if (
        !actual ||
        providerConnectionId(actual) !== connection.id ||
        ['provider', 'protocol', 'baseURL', 'credentialRef', 'model'].some(
          (key) => actual[key] !== model[key],
        )
      )
        connection.canWrite = false;
    }
    for (const actual of models) {
      const connection = groups.get(providerConnectionId(actual));
      if (connection && !localModels.some((model) => model.id === actual.id))
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
export async function discoverProviderModels(
  baseURL: string,
  apiKey?: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const endpoint = `${safeProviderEndpoint(baseURL)}/models`;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      // Observe and reject redirects; never forward a Vault key to another endpoint.
      redirect: 'manual',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AgentError(
        response.status === 401 || response.status === 403
          ? 'provider_discovery_auth_failed'
          : 'provider_discovery_failed',
      );
    }
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
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      throw new AgentError('provider_discovery_invalid');
    }
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
    if (signal?.aborted) throw new AgentError('provider_discovery_cancelled');
    if (error instanceof AgentError) throw error;
    throw new AgentError('provider_discovery_unavailable');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
