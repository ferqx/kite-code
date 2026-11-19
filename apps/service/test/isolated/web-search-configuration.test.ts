import { expect, spyOn, test } from 'bun:test';
import { createCredentialVault, createTemporaryCredentialBackend } from '@kite-ai/agent/config';
import { createUserConfiguration, withoutProjectModels } from '../../src/user-configuration';
import {
  automaticWebSearchConfiguration,
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

test('legacy dedicated credentials stay dormant and are never read or removed', async () => {
  const options = owned();
  const scope = webSearchCredentialScope(options.profileAccessKey, dedicated);
  await options.searchVault.writeOwned(scope, 'test-legacy-untouched');
  const read = spyOn(options.searchVault, 'readOwned');
  expect(() => freezeWebSearchProvider(dedicated, options)).toThrow(
    'web_search_connection_invalid',
  );
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  expect(await options.searchVault.readOwned(scope)).toBe('test-legacy-untouched');
  expect(
    automaticWebSearchConfiguration({
      webSearch: { mode: 'provider', providerId: dedicated.id },
      searchProviders: [dedicated],
    }),
  ).toEqual({
    webSearch: { mode: 'auto' },
    searchProviders: [],
    derivedDeepSeek: { status: 'unavailable' },
  });
});

test('official normalized DeepSeek account supplies a fallback without a manual search account or credential read', async () => {
  const config = createUserConfiguration('unused-synthetic-config');
  const source = {
    provider: {
      'team-ds': {
        type: 'deepseek',
        name: 'Team account',
        apiKey: 'test-deepseek-original',
        models: ['chat'],
      },
    },
    searchProviders: [dedicated],
    webSearch: { mode: 'provider', providerId: dedicated.id },
  };
  const user = config.normalize(source);
  const derived = automaticWebSearchConfiguration(user);
  expect(derived).toEqual({
    webSearch: { mode: 'auto', providerId: 'team-ds' },
    derivedDeepSeek: { status: 'configured', label: 'Team account' },
    searchProviders: [
      {
        id: 'team-ds',
        name: 'Team account',
        adapter: 'deepseek-search',
        connection: { kind: 'provider', providerAlias: 'team-ds' },
      },
    ],
  });
  const noModels = config.normalize({
    provider: { 'team-ds': { ...source.provider['team-ds'], models: [] } },
  });
  expect(automaticWebSearchConfiguration(noModels)).toEqual(derived);
  for (const models of [[], ['chat']]) {
    const disabledAccount = config.normalize({
      provider: { 'team-ds': { ...source.provider['team-ds'], models, enabled: false } },
    });
    expect(automaticWebSearchConfiguration(disabledAccount)).toEqual({
      webSearch: { mode: 'auto' },
      searchProviders: [],
      derivedDeepSeek: { status: 'unavailable' },
    });
  }
  const disabled = config.normalize({
    ...source,
    disabledModels: [{ provider: 'team-ds', name: 'chat' }],
  });
  expect(automaticWebSearchConfiguration(disabled).derivedDeepSeek.status).toBe('unavailable');
  expect(
    automaticWebSearchConfiguration({ ...user, webSearch: { mode: 'disabled' } }).webSearch,
  ).toEqual({ mode: 'disabled' });
  const rotated = config.normalize({
    provider: { 'team-ds': { ...source.provider['team-ds'], apiKey: 'test-deepseek-next' } },
  });
  let reads = 0;
  const vaults = {
    ...owned(),
    modelVault: {
      async resolve() {
        reads++;
        return 'test-ephemeral';
      },
    },
  };
  const first = freezeWebSearchProvider(derived.searchProviders[0]!, { ...vaults, user });
  const later = freezeWebSearchProvider(derived.searchProviders[0]!, { ...vaults, user: rotated });
  expect(first.bindingDigest).not.toBe(later.bindingDigest);
  expect(reads).toBe(0);
  expect(await first.resolveApiKey()).toBe('test-ephemeral');
  expect(reads).toBe(1);
});

test('current eligible alias then user default wins; independent unselected payment accounts stay ambiguous', () => {
  const connection = (providerName: string) => ({
    providerName,
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    credentialRef: `credential:${crypto.randomUUID()}`,
  });
  const a = connection('z-actual'),
    b = connection('a-actual');
  const models = [
    { ...a, id: 'z-model', model: 'chat' },
    { ...b, id: 'a-model', model: 'chat' },
  ];
  for (const listings of [models, [...models].reverse()]) {
    const user = { models: listings, _providerConnections: [a, b] };
    expect(automaticWebSearchConfiguration(user)).toEqual({
      webSearch: { mode: 'auto' },
      searchProviders: [],
      derivedDeepSeek: { status: 'ambiguous' },
    });
    expect(
      automaticWebSearchConfiguration({ ...user, modelId: 'a-model' }, a.providerName)
        .searchProviders[0]?.id,
    ).toBe(a.providerName);
    expect(
      automaticWebSearchConfiguration({ ...user, modelId: 'a-model' }, 'ineligible')
        .searchProviders[0]?.id,
    ).toBe(b.providerName);
    expect(
      automaticWebSearchConfiguration({
        ...user,
        models: [{ ...models[0]!, enabled: false }, models[1]!],
      }).searchProviders[0]?.id,
    ).toBe(b.providerName);
  }
  for (const _providerConnections of [
    [{ ...a, enabled: false }],
    [{ ...a, remove: true }],
    [{ ...a, provider: 'compatible' }],
    [{ ...a, baseURL: 'https://gateway.example' }],
    [{ ...a, protocol: 'responses' }],
    [{ ...a, credentialRef: 'invalid' }],
    [a, { ...a, providerName: b.providerName }],
  ])
    expect(automaticWebSearchConfiguration({ _providerConnections }).derivedDeepSeek.status).toBe(
      'unavailable',
    );
  expect(
    automaticWebSearchConfiguration({
      _providerConnections: [{ ...a, enabled: false }],
      models: [models[0]!],
    }).derivedDeepSeek.status,
  ).toBe('unavailable');
  const disabledDeclaration = { ...models[0]!, enabled: false };
  expect(
    automaticWebSearchConfiguration({
      _providerConnections: [disabledDeclaration],
      models: [disabledDeclaration, models[0]!],
    }).derivedDeepSeek.status,
  ).toBe('unavailable');
  expect(
    automaticWebSearchConfiguration({
      _providerConnections: [{ ...a, providerLabel: 'Research model' }],
    }).derivedDeepSeek,
  ).toEqual({ status: 'configured', label: 'Research model' });
  expect(
    automaticWebSearchConfiguration({
      _providerConnections: [{ ...a, providerLabel: 'Untrusted\u202elabel' }],
    }).derivedDeepSeek,
  ).toEqual({ status: 'configured', label: a.providerName });
  const { providerName: _alias, ...unnamed } = models[0]!;
  expect(automaticWebSearchConfiguration({ models: [unnamed] }).derivedDeepSeek.status).toBe(
    'unavailable',
  );
});
