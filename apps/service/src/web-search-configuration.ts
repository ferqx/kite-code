import { createHash } from 'node:crypto';
import {
  ConfigurationError,
  type createCredentialVault,
  type JsonObject,
} from '@kite-ai/agent/config';
import { isWebSearchApiKey, webSearchProviderBaseURL } from './web-search-providers';

export { isWebSearchApiKey };

export type WebSearchSettings =
  | { mode: 'disabled' }
  | { mode: 'auto'; providerId?: string }
  | { mode: 'provider'; providerId: string };

export type SearchConnection =
  | { kind: 'provider'; providerAlias: string }
  | { kind: 'dedicated'; baseURL: string; credentialRef: string };

export type SearchProviderConfig = {
  id: string;
  name: string;
  connection: SearchConnection;
} & (
  | { adapter: 'deepseek-search' | 'perplexity-search'; maxResults?: number }
  | { adapter: 'openai-search'; modelId: string }
);

export type WebSearchConfiguration = {
  webSearch: WebSearchSettings;
  searchProviders: SearchProviderConfig[];
};
type Adapter = SearchProviderConfig['adapter'];
type Vault = ReturnType<typeof createCredentialVault>;
const ref = /^credential:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const modelId = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function fail(code = 'web_search_configuration_invalid'): never {
  throw new ConfigurationError(code);
}
function record(value: unknown, fields?: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value)) ||
    (fields && Object.keys(value).some((key) => !fields.includes(key)))
  )
    return fail();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  return typeof value === 'string' && id.test(value) ? value : fail();
}
function endpoint(adapter: Adapter, value: unknown): string {
  if (typeof value !== 'string') return fail('web_search_connection_invalid');
  try {
    return webSearchProviderBaseURL(adapter, value);
  } catch {
    return fail('web_search_connection_invalid');
  }
}
function provider(value: unknown): SearchProviderConfig {
  const candidate = record(value);
  const adapter = candidate.adapter;
  if (
    adapter !== 'deepseek-search' &&
    adapter !== 'perplexity-search' &&
    adapter !== 'openai-search'
  )
    return fail();
  record(candidate, [
    'id',
    'name',
    'adapter',
    'connection',
    adapter === 'openai-search' ? 'modelId' : 'maxResults',
  ]);
  const name = candidate.name;
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name !== name.trim() ||
    name.length > 120 ||
    [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    Buffer.from(name, 'utf8').toString('utf8') !== name
  )
    return fail();
  const input = record(candidate.connection);
  let connection: SearchConnection;
  if (input.kind === 'provider') {
    record(input, ['kind', 'providerAlias']);
    connection = { kind: 'provider', providerAlias: identifier(input.providerAlias) };
  } else if (input.kind === 'dedicated') {
    record(input, ['kind', 'baseURL', 'credentialRef']);
    if (typeof input.credentialRef !== 'string' || !ref.test(input.credentialRef))
      return fail('web_search_connection_invalid');
    connection = {
      kind: 'dedicated',
      baseURL: endpoint(adapter, input.baseURL),
      credentialRef: input.credentialRef,
    };
  } else return fail();
  const common = { id: identifier(candidate.id), name, connection };
  if (adapter === 'openai-search') {
    if (typeof candidate.modelId !== 'string' || !modelId.test(candidate.modelId)) return fail();
    return { ...common, adapter, modelId: candidate.modelId };
  }
  const limit = candidate.maxResults;
  if (
    limit !== undefined &&
    (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 10)
  )
    return fail();
  return { ...common, adapter, ...(limit === undefined ? {} : { maxResults: limit }) };
}

export function parseWebSearchConfiguration(raw: unknown): WebSearchConfiguration {
  const input = record(raw);
  const items = input.searchProviders === undefined ? [] : input.searchProviders;
  if (!Array.isArray(items) || items.length > 128) return fail();
  const searchProviders = items.map(provider);
  const ids = new Set(searchProviders.map((p) => p.id));
  if (ids.size !== searchProviders.length) return fail();
  const settings = record(input.webSearch === undefined ? { mode: 'auto' } : input.webSearch);
  const mode = settings.mode;
  if (mode !== 'auto' && mode !== 'provider' && mode !== 'disabled') return fail();
  record(settings, mode === 'disabled' ? ['mode'] : ['mode', 'providerId']);
  if (mode === 'disabled' || (mode === 'auto' && settings.providerId === undefined))
    return { webSearch: { mode }, searchProviders };
  const providerId = identifier(settings.providerId);
  if (!ids.has(providerId)) return fail('web_search_provider_unavailable');
  return { webSearch: { mode, providerId }, searchProviders };
}

export function webSearchCredentialScope(
  profileAccessKey: string,
  configured: SearchProviderConfig,
) {
  const item = provider(configured);
  if (!profileAccessKey || item.connection.kind !== 'dedicated')
    return fail('web_search_connection_invalid');
  return {
    namespace: 'web.search' as const,
    ownerDigest: createHash('sha256')
      .update(
        JSON.stringify([
          profileAccessKey,
          item.id,
          item.adapter,
          item.connection.baseURL,
          item.connection.credentialRef,
        ]),
      )
      .digest('hex'),
  };
}

function userConnections(user: JsonObject) {
  const aliases = new Map<string, JsonObject[]>();
  const owners = new Map<string, Set<unknown>>();
  for (const list of [user._providerConnections, user.models]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      if (typeof entry.credentialRef === 'string') {
        const observed = owners.get(entry.credentialRef) ?? new Set();
        observed.add(entry.providerName);
        owners.set(entry.credentialRef, observed);
      }
      if (typeof entry.providerName !== 'string' || !id.test(entry.providerName)) continue;
      const group = aliases.get(entry.providerName) ?? [];
      group.push(entry);
      aliases.set(entry.providerName, group);
    }
  }
  return { aliases, owners };
}
function aliasBinding(
  alias: string,
  adapter: Adapter,
  connections: ReturnType<typeof userConnections>,
) {
  const group = connections.aliases.get(alias);
  const first = group?.[0];
  const service = adapter.slice(0, -'-search'.length);
  if (
    !first ||
    !group ||
    first.provider !== service ||
    typeof first.credentialRef !== 'string' ||
    !ref.test(first.credentialRef) ||
    connections.owners.get(first.credentialRef)?.size !== 1
  )
    return fail('web_search_connection_invalid');
  const baseURL = endpoint(adapter, first.baseURL);
  if (
    group.some(
      (entry) =>
        entry.provider !== service ||
        entry.credentialRef !== first.credentialRef ||
        endpoint(adapter, entry.baseURL) !== baseURL,
    )
  )
    return fail('web_search_connection_invalid');
  return { baseURL, credentialRef: first.credentialRef };
}
export function eligibleWebSearchConnections(user: JsonObject) {
  const connections = userConnections(user);
  const result: { providerAlias: string; name: string; adapter: Adapter }[] = [];
  for (const [providerAlias, group] of connections.aliases) {
    const first = group[0]!;
    const service = first.provider;
    if (service !== 'openai' && service !== 'deepseek' && service !== 'perplexity') continue;
    const adapter = `${service}-search` as const;
    try {
      aliasBinding(providerAlias, adapter, connections);
    } catch (error) {
      if (error instanceof ConfigurationError) continue;
      throw error;
    }
    const label = first.providerLabel;
    const name =
      typeof label === 'string' &&
      label.trim() &&
      label.length <= 120 &&
      !Array.from(label).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
        ? label.trim()
        : providerAlias;
    result.push({ providerAlias, name, adapter });
    if (result.length === 128) break;
  }
  return result;
}
export function freezeWebSearchProvider(
  configured: SearchProviderConfig,
  options: {
    user: JsonObject;
    profileAccessKey: string;
    modelVault: Pick<Vault, 'resolve'>;
    searchVault: Pick<Vault, 'readOwned'>;
  },
): Readonly<{
  bindingDigest: string;
  adapter: Adapter;
  baseURL: string;
  maxResults?: number;
  modelId?: string;
  resolveApiKey(): Promise<string>;
}> {
  const { profileAccessKey, modelVault, searchVault } = options;
  const item = provider(configured);
  const connection = item.connection;
  let baseURL: string;
  let credentialRef: string;
  let read: () => Promise<string | null>;
  if (connection.kind === 'dedicated') {
    const scope = webSearchCredentialScope(profileAccessKey, item);
    baseURL = connection.baseURL;
    credentialRef = connection.credentialRef;
    read = () => searchVault.readOwned(scope);
  } else {
    ({ baseURL, credentialRef } = aliasBinding(
      connection.providerAlias,
      item.adapter,
      userConnections(options.user),
    ));
    read = () => modelVault.resolve(credentialRef);
  }
  return Object.freeze({
    bindingDigest: createHash('sha256')
      .update(
        JSON.stringify([
          'kite-web-search-binding-v1',
          profileAccessKey,
          item.id,
          item.adapter,
          baseURL,
          connection.kind,
          connection.kind === 'provider' ? connection.providerAlias : null,
          credentialRef,
          item.adapter === 'openai-search' ? item.modelId : (item.maxResults ?? 5),
        ]),
      )
      .digest('hex'),
    adapter: item.adapter,
    baseURL,
    ...(item.adapter === 'openai-search'
      ? { modelId: item.modelId }
      : { maxResults: item.maxResults ?? 5 }),
    async resolveApiKey(): Promise<string> {
      try {
        const secret = await read();
        if (isWebSearchApiKey(secret)) return secret;
      } catch {
        /* Keep backend and credential diagnostics private. */
      }
      return fail('web_search_credential_unavailable');
    },
  });
}
