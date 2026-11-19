import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from '@kite-ai/agent';
import {
  createCredentialVault,
  createTemporaryCredentialBackend,
  type JsonObject,
} from '@kite-ai/agent/config';
import { selectProfile } from '@kite-ai/agent/profile';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../tests/fixtures/test-filesystem';
import { createConfigurationManagement } from '../../src/configuration-management';
import { createUserConfiguration } from '../../src/user-configuration';
import { webSearchCredentialScope } from '../../src/web-search-configuration';

async function rejected(promise: Promise<unknown>, expected: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error instanceof Error ? error.message : null).toBe(expected);
}

async function fixture(explicit: () => JsonObject = () => ({})) {
  const root = temporaryDirectory('kite-web-search-settings-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'config.jsonc');
  writeFileSync(file, '// keep this comment\n{"unrelated":17}\n', { mode: 0o600 });
  const user = createUserConfiguration(file);
  const backend = createTemporaryCredentialBackend();
  const counts = { writes: 0, reads: 0, removes: 0 };
  const vault = createCredentialVault({
    backend: {
      kind: 'temporary',
      async put(key, value) {
        counts.writes++;
        await backend.put(key, value);
      },
      async resolve(key) {
        counts.reads++;
        return backend.resolve(key);
      },
      async remove(key) {
        counts.removes++;
        await backend.remove(key);
      },
    },
  });
  const open = async () =>
    createRuntime({
      store: await openSqliteStore(profile),
      permissions: { authorize: async () => ({ allowed: false, revision: 'offline-settings' }) },
    });
  let runtime = await open();
  const manager = () =>
    createConfigurationManagement({
      profile,
      runtime,
      userConfiguration: user,
      vault,
      persistence: 'temporary',
      explicit,
    });
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const identity = (commandId: string) => ({ expectedStoreId, commandId, subjectId: 'owner' });
  return {
    file,
    profile,
    counts,
    vault,
    user,
    identity,
    manager,
    read: () => manager().readWebSearch({ expectedStoreId }),
    journal: (commandId: string) => runtime.getHostMutation(identity(commandId)),
    async reopen() {
      await runtime.close();
      runtime = await open();
    },
    async close() {
      await runtime.close();
      removeTemporaryDirectory(root);
    },
  };
}

const dedicated = {
  id: 'search-account',
  name: 'Research',
  adapter: 'perplexity-search',
  maxResults: 4,
  connection: { kind: 'dedicated', baseURL: 'https://api.perplexity.ai' },
} as const;
const selected = { mode: 'provider', providerId: dedicated.id } as const;
const syntheticKey = () => `owned-${randomUUID()}`;

test('automatic and disabled preferences survive cold replay and preserve dormant legacy account data', async () => {
  const f = await fixture();
  try {
    const credentialRef = `credential:${randomUUID()}`;
    const old = { ...dedicated, connection: { ...dedicated.connection, credentialRef } };
    const scope = webSearchCredentialScope(f.profile.profileAccessKey, old);
    const key = syntheticKey();
    await f.vault.writeOwned(scope, key);
    writeFileSync(
      f.file,
      '// keep this comment\n' +
        JSON.stringify({
          unrelated: 17,
          webSearch: selected,
          searchProviders: [old],
        }),
    );
    const initial = await f.read();
    expect(initial).toMatchObject({
      webSearch: { mode: 'auto' },
      searchProviders: [],
      derivedDeepSeek: { status: 'unavailable' },
      errors: [],
    });
    expect(JSON.stringify(initial).includes(credentialRef)).toBe(false);
    const input = {
      ...f.identity('disable'),
      expectedReadSet: initial.readSet!,
      webSearch: { mode: 'disabled' as const },
      searchProviders: [],
    };
    const saved = await f.manager().updateWebSearch(input);
    expect(saved).toMatchObject({ state: 'applied', kind: 'config.patch' });
    await f.reopen();
    expect(await f.manager().getMutation(input)).toEqual(saved);
    expect(await f.manager().updateWebSearch(input)).toEqual(saved);
    await rejected(
      f.manager().updateWebSearch({ ...input, webSearch: { mode: 'auto' } }),
      'host_mutation_conflict',
    );
    await rejected(
      f.manager().updateWebSearch({ ...input, ...f.identity('stale') }),
      'configuration_read_set_conflict',
    );
    const after = await f.read();
    expect(after.webSearch).toEqual({ mode: 'disabled' });
    expect(after.searchProviders).toEqual([]);
    expect(f.user.read().value.searchProviders).toEqual([old]);
    expect(readFileSync(f.file, 'utf8')).toContain('// keep this comment');
    expect(f.user.read().value.unrelated).toBe(17);
    expect(f.counts).toEqual({ writes: 1, reads: 0, removes: 0 });
    expect((await f.vault.readOwned(scope)) === key).toBe(true);
  } finally {
    await f.close();
  }
});

test('new search account, copied secrets, foreign references and legacy provider selectors are rejected before journaling', async () => {
  const f = await fixture();
  try {
    const { readSet } = await f.read();
    const base = {
      ...f.identity('bad'),
      expectedReadSet: readSet!,
      webSearch: { mode: 'auto' as const },
      searchProviders: [],
    };
    const generic = await f.vault.put(syntheticKey());
    const withRef = {
      ...dedicated,
      connection: { ...dedicated.connection, credentialRef: generic.id },
    };
    const before = { ...f.counts };
    for (const input of [
      { ...base, webSearch: selected },
      { ...base, webSearch: { mode: 'auto' as const, providerId: dedicated.id } },
      { ...base, searchProviders: [dedicated] },
      { ...base, searchProviders: [withRef] },
      {
        ...base,
        searchProviders: [
          { ...withRef, connection: { kind: 'provider' as const, providerAlias: 'other' } },
        ],
      },
      { ...base, credential: { providerId: dedicated.id, secret: syntheticKey() } },
      {
        ...base,
        searchProviders: [withRef],
        credential: { providerId: dedicated.id, secret: '*****' },
      },
    ]) {
      await rejected(f.manager().updateWebSearch(input), 'web_search_configuration_invalid');
      expect(await f.journal('bad')).toBeNull();
    }
    for (const value of [
      { webSearch: selected, searchProviders: [withRef] },
      { webSearch: null, searchProviders: [] },
      { webSearch: { mode: 'auto' }, searchProviders: null },
    ]) {
      await rejected(
        f.manager().repair({
          ...f.identity('bad-repair'),
          scope: 'user',
          ifMatch: readSet!.userEtag,
          value,
        }),
        'web_search_configuration_invalid',
      );
      expect(await f.journal('bad-repair')).toBeNull();
    }
    expect(f.counts).toEqual(before);
    expect((await f.read()).readSet).toEqual(readSet);
  } finally {
    await f.close();
  }
});

test('derived status follows the enabled official provider, configuration rotation and disablement without a vault or network read', async () => {
  const f = await fixture();
  try {
    const ref = await f.vault.put(syntheticKey());
    const official = {
      type: 'deepseek',
      name: 'Research model',
      baseURL: 'https://api.deepseek.com',
      credentialRef: ref.id,
      models: ['deepseek-flash'],
    };
    const configuration = {
      provider: {
        research: official,
        gateway: {
          ...official,
          baseURL: 'https://gateway.invalid',
          credentialRef: `credential:${randomUUID()}`,
        },
      },
      model: 'research:deepseek-flash',
    };
    writeFileSync(f.file, JSON.stringify(configuration));
    const first = await f.read();
    expect(first).toMatchObject({
      webSearch: { mode: 'auto' },
      searchProviders: [],
      derivedDeepSeek: { status: 'configured', label: 'Research model' },
      errors: [],
    });
    expect(JSON.stringify(first).includes(ref.id)).toBe(false);
    const newRef = await f.vault.put(syntheticKey());
    writeFileSync(
      f.file,
      JSON.stringify({
        ...configuration,
        provider: {
          ...configuration.provider,
          research: { ...official, credentialRef: newRef.id },
        },
      }),
    );
    const rotated = await f.read();
    expect(rotated.derivedDeepSeek).toEqual(first.derivedDeepSeek);
    expect(rotated.readSet).not.toEqual(first.readSet);
    expect(JSON.stringify(rotated).includes(newRef.id)).toBe(false);
    writeFileSync(
      f.file,
      JSON.stringify({
        ...configuration,
        disabledModels: ['research:deepseek-flash', 'gateway:deepseek-flash'],
      }),
    );
    const disabled = await f.read();
    expect(disabled.derivedDeepSeek).toEqual({ status: 'unavailable' });
    expect(f.counts).toEqual({ writes: 2, reads: 0, removes: 0 });
  } finally {
    await f.close();
  }
});

test('trusted explicit disable narrows search without introducing a host account or overriding a user disable', async () => {
  let override: JsonObject = {};
  const f = await fixture(() => override);
  try {
    const declared = {
      provider: {
        mine: {
          type: 'deepseek',
          name: 'My model',
          models: ['deepseek-flash'],
          credentialRef: `credential:${randomUUID()}`,
        },
      },
      webSearch: { mode: 'auto' },
    };
    writeFileSync(f.file, JSON.stringify(declared));
    const before = await f.read();
    override = { webSearch: { mode: 'disabled' } };
    const current = await f.read();
    expect(current.webSearch).toEqual({ mode: 'disabled' });
    expect(current.derivedDeepSeek).toEqual({ status: 'configured', label: 'My model' });
    expect(current.errors).toEqual([]);
    expect(current.readSet!.explicitDigest).not.toBe(before.readSet!.explicitDigest);
    const save = {
      ...f.identity('enable-host-disabled'),
      expectedReadSet: current.readSet!,
      webSearch: { mode: 'auto' as const },
      searchProviders: [],
    };
    await rejected(f.manager().updateWebSearch(save), 'web_search_settings_override');
    await rejected(
      f.manager().updateWebSearch({
        ...save,
        ...f.identity('stale-external'),
        expectedReadSet: before.readSet!,
      }),
      'configuration_read_set_conflict',
    );
    expect(f.user.read().value.webSearch).toEqual({ mode: 'auto' });
    const foreign = `credential:${randomUUID()}`;
    override = {
      webSearch: { mode: 'provider', providerId: 'foreign' },
      searchProviders: [
        {
          ...dedicated,
          id: 'foreign',
          connection: { ...dedicated.connection, credentialRef: foreign },
        },
      ],
    };
    writeFileSync(f.file, JSON.stringify({ webSearch: { mode: 'disabled' } }));
    const dormant = await f.read();
    expect(dormant.webSearch).toEqual({ mode: 'disabled' });
    expect(dormant.searchProviders).toEqual([]);
    expect(dormant.derivedDeepSeek).toEqual({ status: 'unavailable' });
    expect(JSON.stringify(dormant).includes(foreign)).toBe(false);
    expect(f.counts).toEqual({ writes: 0, reads: 0, removes: 0 });
  } finally {
    await f.close();
  }
});

for (const aliases of [
  ['primary', 'secondary'],
  ['secondary', 'primary'],
] as const)
  test(`settings read derives the paid DeepSeek fallback from explicit defaults, independent of provider order (${aliases.join(', ')})`, async () => {
    const f = await fixture();
    try {
      const provider = (name: string, credentialRef: string) => ({
        type: 'deepseek',
        name,
        baseURL: 'https://api.deepseek.com/v1',
        credentialRef,
        models: ['deepseek-flash'],
      });
      const primary = provider('Primary connection', (await f.vault.put(syntheticKey())).id);
      const secondary = provider('Secondary connection', (await f.vault.put(syntheticKey())).id);
      async function readConfiguration(
        options: {
          root?: string;
          primary?: JsonObject;
          secondary?: JsonObject;
          disabledModels?: string[];
        } = {},
      ) {
        const rows = {
          primary: { ...primary, ...options.primary },
          secondary: { ...secondary, ...options.secondary },
        };
        writeFileSync(
          f.file,
          JSON.stringify({
            provider: Object.fromEntries(aliases.map((alias) => [alias, rows[alias]])),
            ...(options.root ? { model: options.root } : {}),
            ...(options.disabledModels ? { disabledModels: options.disabledModels } : {}),
          }),
        );
        const view = await f.read();
        expect(view.errors).toEqual([]);
        expect(view.webSearch).toEqual({ mode: 'auto' });
        expect(view.searchProviders).toEqual([]);
        expect(JSON.stringify(view).includes('credential:')).toBe(false);
        return view;
      }
      const ambiguous = await readConfiguration();
      expect(ambiguous.derivedDeepSeek).toEqual({ status: 'ambiguous' });
      expect(JSON.parse(readFileSync(f.file, 'utf8'))).not.toHaveProperty('model');
      const selection = await f
        .manager()
        .readModels({ scope: 'user', expectedStoreId: ambiguous.storeId });
      expect(selection.defaultModelId).toBeTruthy();
      const receipt = await f.manager().updateModels({
        ...f.identity('accept-implicit-default'),
        scope: 'user',
        expectedReadSet: selection.readSet!,
        operation: { kind: 'default', modelId: selection.defaultModelId! },
      });
      expect(receipt.state).toBe('applied');
      const firstAlias = aliases[0];
      expect(JSON.parse(readFileSync(f.file, 'utf8')).model).toBe(`${firstAlias}:deepseek-flash`);
      const explicitlySelected = await f.read();
      expect(explicitlySelected.derivedDeepSeek).toEqual({
        status: 'configured',
        label: firstAlias === 'primary' ? primary.name : secondary.name,
      });
      expect(explicitlySelected.readSet!.userEtag).not.toBe(ambiguous.readSet!.userEtag);

      const localDefault = { model: 'deepseek-flash' };
      const metadataDefault = { models: [{ name: 'deepseek-flash', default: true }] };
      expect((await readConfiguration({ secondary: localDefault })).derivedDeepSeek).toEqual({
        status: 'configured',
        label: secondary.name,
      });
      expect((await readConfiguration({ primary: metadataDefault })).derivedDeepSeek).toEqual({
        status: 'configured',
        label: primary.name,
      });
      expect(
        (await readConfiguration({ secondary: localDefault, primary: metadataDefault }))
          .derivedDeepSeek,
      ).toEqual({ status: 'ambiguous' });
      const chosen = await readConfiguration({
        root: 'secondary:deepseek-flash',
        primary: metadataDefault,
      });
      expect(chosen.derivedDeepSeek).toEqual({ status: 'configured', label: secondary.name });
      const credentialRef = (await f.vault.put(syntheticKey())).id;
      const rotated = await readConfiguration({
        root: 'secondary:deepseek-flash',
        primary: metadataDefault,
        secondary: { credentialRef },
      });
      expect(rotated.derivedDeepSeek).toEqual(chosen.derivedDeepSeek);
      expect(rotated.readSet!.userEtag).not.toBe(chosen.readSet!.userEtag);
      const disabled = await readConfiguration({ disabledModels: ['secondary:deepseek-flash'] });
      expect(disabled.derivedDeepSeek).toEqual({ status: 'configured', label: primary.name });
      expect(f.counts).toEqual({ writes: 3, reads: 0, removes: 0 });
    } finally {
      await f.close();
    }
  });
