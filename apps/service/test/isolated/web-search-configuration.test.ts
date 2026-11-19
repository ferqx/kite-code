import { expect, test } from 'bun:test';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { withoutProjectModels } from '../../src/user-configuration';
import {
  freezeWebSearchProvider,
  parseWebSearchConfiguration,
  type SearchProviderConfig,
  webSearchCredentialScope,
} from '../../src/web-search-configuration';

const dedicated = {
  id: 'my-search',
  name: '独立搜索',
  adapter: 'perplexity-search',
  connection: {
    kind: 'dedicated',
    baseURL: 'https://api.perplexity.ai',
    credentialRef: `credential:${crypto.randomUUID()}`,
  },
} as const;
function owned() {
  return {
    profileAccessKey: 'isolated-owner',
    user: {},
    modelVault: createCredentialVault({ backend: createTemporaryCredentialBackend() }),
    searchVault: createCredentialVault({ backend: createTemporaryCredentialBackend() }),
  };
}

test('web search accepts the three user policies and rejects malformed or unbound selections', () => {
  expect(parseWebSearchConfiguration({})).toEqual({
    webSearch: { mode: 'auto' },
    searchProviders: [],
  });
  for (const mode of ['auto', 'provider'] as const)
    expect(
      parseWebSearchConfiguration({
        webSearch: { mode, providerId: dedicated.id },
        searchProviders: [dedicated],
      }).webSearch,
    ).toEqual({ mode, providerId: dedicated.id });
  expect(parseWebSearchConfiguration({ webSearch: { mode: 'disabled' } }).webSearch).toEqual({
    mode: 'disabled',
  });
  for (const value of [
    { webSearch: { mode: 'provider' } },
    { webSearch: { mode: 'provider', providerId: 'missing' } },
    { webSearch: { mode: 'disabled', providerId: dedicated.id }, searchProviders: [dedicated] },
    { searchProviders: [dedicated, dedicated] },
    { searchProviders: [{ ...dedicated, maxResults: 11 }] },
    { searchProviders: [{ ...dedicated, adapter: 'openai-search' }] },
    {
      searchProviders: [
        { ...dedicated, connection: { ...dedicated.connection, apiKey: 'synthetic' } },
      ],
    },
    {
      searchProviders: [
        { ...dedicated, connection: { ...dedicated.connection, credentialRef: 'synthetic' } },
      ],
    },
  ])
    expect(() => parseWebSearchConfiguration(value)).toThrow();
  for (const baseURL of [
    'http://api.perplexity.ai',
    'https://api.perplexity.ai.example',
    'https://api.perplexity.ai:8443',
    'https://account@api.perplexity.ai',
    'https://api.perplexity.ai?token=x',
    'https://api.perplexity.ai/#fragment',
    'https://api.perplexity.ai/other',
  ])
    expect(() =>
      parseWebSearchConfiguration({
        searchProviders: [{ ...dedicated, connection: { ...dedicated.connection, baseURL } }],
      }),
    ).toThrow('web_search_connection_invalid');
  expect(
    withoutProjectModels({
      webSearch: { mode: 'provider' },
      searchProviders: [dedicated],
      _providerConnections: [],
      tools: [],
    }),
  ).toEqual({ tools: [] });
});

test('a frozen provider alias reuses only its original, matching API account', async () => {
  const options = owned();
  const original = await options.modelVault.put('test-search-original'),
    next = await options.modelVault.put('test-search-next');
  const declaration = {
    providerName: 'main',
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    credentialRef: original.id,
  };
  const user = {
    _providerConnections: [declaration],
    models: [{ ...declaration, id: 'model', model: 'test' }],
  };
  const p: SearchProviderConfig = {
    id: 'fallback',
    name: 'Fallback',
    adapter: 'deepseek-search',
    connection: { kind: 'provider', providerAlias: 'main' },
  };
  let reads = 0;
  const modelVault = {
    async resolve(reference: string) {
      reads++;
      return options.modelVault.resolve(reference);
    },
  };
  const frozen = freezeWebSearchProvider(p, { ...options, modelVault, user });
  expect(reads).toBe(0);
  const changed = { _providerConnections: [{ ...declaration, credentialRef: next.id }] };
  const later = freezeWebSearchProvider(p, { ...options, user: changed });
  expect(frozen.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(frozen.bindingDigest).not.toBe(later.bindingDigest);
  expect((await frozen.resolveApiKey()) === 'test-search-original').toBe(true);
  expect((await later.resolveApiKey()) === 'test-search-next').toBe(true);
  expect(frozen.maxResults).toBe(5);
  expect(JSON.stringify(frozen).includes(original.id)).toBe(false);
  for (const entries of [
    [{ ...declaration, provider: 'codex' }],
    [{ ...declaration, provider: 'compatible' }],
    [{ ...declaration, baseURL: 'https://api.openai.com/v1' }],
    [{ ...declaration, credentialRef: 'raw' }],
    [declaration, { ...declaration, credentialRef: next.id }],
    [declaration, { ...declaration, providerName: 'other' }],
  ])
    expect(() =>
      freezeWebSearchProvider(p, {
        ...options,
        modelVault,
        user: { _providerConnections: entries },
      }),
    ).toThrow('web_search_connection_invalid');
  expect(reads).toBe(1);
});

test('dedicated references require the original profile, account, adapter and endpoint binding', async () => {
  const options = owned();
  const generic = await options.modelVault.put('test-generic');
  const connection = { ...dedicated.connection, credentialRef: generic.id };
  const p = { ...dedicated, connection };
  const frozen = freezeWebSearchProvider(p, options);
  await expect(frozen.resolveApiKey()).rejects.toThrow('web_search_credential_unavailable');
  const scope = webSearchCredentialScope(options.profileAccessKey, p);
  await options.searchVault.writeOwned(scope, 'test-owned-search');
  expect((await frozen.resolveApiKey()) === 'test-owned-search').toBe(true);
  const otherProfile = freezeWebSearchProvider(p, { ...options, profileAccessKey: 'different' });
  const otherAccount = freezeWebSearchProvider({ ...p, id: 'another' }, options);
  const otherAdapter = freezeWebSearchProvider(
    {
      ...p,
      adapter: 'deepseek-search',
      connection: { ...connection, baseURL: 'https://api.deepseek.com' },
    },
    options,
  );
  for (const candidate of [otherProfile, otherAccount, otherAdapter])
    await expect(candidate.resolveApiKey()).rejects.toThrow('web_search_credential_unavailable');
  // biome-ignore lint/suspicious/noTemplateCurlyInString: An environment reference in stored material is literal.
  for (const masked of ['*****', '[redacted]', '${SEARCH_KEY}']) {
    await options.searchVault.writeOwned(scope, masked);
    await expect(frozen.resolveApiKey()).rejects.toThrow('web_search_credential_unavailable');
  }
  await options.searchVault.removeOwned(scope);
  await expect(frozen.resolveApiKey()).rejects.toThrow('web_search_credential_unavailable');
});
