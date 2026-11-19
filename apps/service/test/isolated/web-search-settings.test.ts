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
import {
  freezeWebSearchProvider,
  webSearchCredentialScope,
} from '../../src/web-search-configuration';

async function rejected(promise: Promise<unknown>, expected: string) {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error instanceof Error ? error.message : null).toBe(expected);
}

async function fixture() {
  const root = temporaryDirectory('kite-web-search-settings-');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'owned' });
  privateDirectory(profile.profilePath);
  const file = join(profile.profilePath, 'config.jsonc');
  writeFileSync(file, '// keep this comment\n{"unrelated":17}\n', { mode: 0o600 });
  const user = createUserConfiguration(file);
  const backend = createTemporaryCredentialBackend();
  let onWrite: (() => void) | undefined;
  let failRemove = false;
  const counts = { writes: 0, reads: 0, removes: 0 };
  const searchVault = createCredentialVault({
    backend: {
      kind: 'temporary',
      async put(key, value) {
        counts.writes++;
        await backend.put(key, value);
        onWrite?.();
      },
      async resolve(key) {
        counts.reads++;
        return backend.resolve(key);
      },
      async remove(key) {
        counts.removes++;
        if (failRemove) throw Error('fixture cleanup failure');
        await backend.remove(key);
      },
    },
  });
  const modelVault = createCredentialVault({ backend });
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
      vault: modelVault,
      webSearchVault: searchVault,
      persistence: 'temporary',
      explicit: () => ({}),
    });
  const expectedStoreId = (await runtime.getMetadata()).storeId;
  const identity = (commandId: string) => ({ expectedStoreId, commandId, subjectId: 'owner' });
  return {
    file,
    profile,
    counts,
    modelVault,
    searchVault,
    user,
    identity,
    manager,
    read: () => manager().readWebSearch({ expectedStoreId }),
    journal: (commandId: string) => runtime.getHostMutation(identity(commandId)),
    async reopen() {
      await runtime.close();
      runtime = await open();
    },
    setWriteHook(hook: () => void) {
      onWrite = hook;
    },
    failCleanup() {
      failRemove = true;
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

test('search settings creation and rotation bind fresh credentials and survive cold command recovery', async () => {
  const f = await fixture();
  try {
    const initial = await f.read();
    expect(initial).toMatchObject({ webSearch: { mode: 'auto' }, searchProviders: [], errors: [] });
    const firstKey = syntheticKey();
    const input = {
      ...f.identity('create-search'),
      expectedReadSet: initial.readSet!,
      webSearch: selected,
      searchProviders: [dedicated],
      credential: { providerId: dedicated.id, secret: firstKey },
    };
    const saved = await f.manager().updateWebSearch(input);
    expect(saved).toMatchObject({ state: 'applied', kind: 'config.patch' });
    const firstView = await f.read();
    expect(firstView.webSearch).toEqual(selected);
    const first = firstView.searchProviders[0]!;
    const firstBinding = freezeWebSearchProvider(first, {
      user: f.user.read().value,
      profileAccessKey: f.profile.profileAccessKey,
      modelVault: f.modelVault,
      searchVault: f.searchVault,
    });
    expect((await firstBinding.resolveApiKey()) === firstKey).toBe(true);
    const before = { ...f.counts };
    await f.reopen();
    expect(await f.manager().getMutation(input)).toEqual(saved);
    expect(await f.manager().updateWebSearch(input)).toEqual(saved);
    expect(f.counts).toEqual(before);
    const rotatedKey = syntheticKey();
    await rejected(
      f.manager().updateWebSearch({
        ...input,
        credential: { providerId: dedicated.id, secret: rotatedKey },
      }),
      'host_mutation_conflict',
    );
    await rejected(
      f.manager().updateWebSearch({ ...input, ...f.identity('stale-search') }),
      'configuration_read_set_conflict',
    );
    expect(f.counts.writes).toBe(1);
    await f.manager().updateWebSearch({
      ...input,
      ...f.identity('rotate-search'),
      expectedReadSet: firstView.readSet!,
      credential: { providerId: dedicated.id, secret: rotatedKey },
    });
    const after = await f.read();
    await rejected(
      f.manager().updateWebSearch({
        ...f.identity('old-ref'),
        expectedReadSet: after.readSet!,
        webSearch: selected,
        searchProviders: [first],
      }),
      'web_search_credential_unavailable',
    );
    const latest = after.searchProviders[0]!;
    expect(latest.connection).not.toEqual(first.connection);
    const binding = freezeWebSearchProvider(latest, {
      user: f.user.read().value,
      profileAccessKey: f.profile.profileAccessKey,
      modelVault: f.modelVault,
      searchVault: f.searchVault,
    });
    expect((await binding.resolveApiKey()) === rotatedKey).toBe(true);
    expect((await firstBinding.resolveApiKey()) === firstKey).toBe(true);
    const disk = readFileSync(f.file, 'utf8');
    expect(disk.includes('// keep this comment')).toBe(true);
    expect(f.user.read().value.unrelated).toBe(17);
    const observed = JSON.stringify([
      disk,
      after,
      saved,
      await f.journal('create-search'),
      await f.journal('rotate-search'),
    ]);
    expect([firstKey, rotatedKey].some((secret) => observed.includes(secret))).toBe(false);
  } finally {
    await f.close();
  }
});

test('save rejects generic, foreign-profile and wrong-account refs; invalid settings never enter the journal', async () => {
  const f = await fixture();
  try {
    const { readSet } = await f.read();
    const generic = await f.modelVault.put(syntheticKey());
    const withRef = {
      ...dedicated,
      connection: { ...dedicated.connection, credentialRef: generic.id },
    };
    const base = { expectedReadSet: readSet!, webSearch: selected, searchProviders: [withRef] };
    await rejected(
      f.manager().updateWebSearch({ ...f.identity('generic'), ...base }),
      'web_search_credential_unavailable',
    );
    await f.searchVault.writeOwned(
      webSearchCredentialScope('other-profile', withRef),
      syntheticKey(),
    );
    await rejected(
      f.manager().updateWebSearch({ ...f.identity('foreign'), ...base }),
      'web_search_credential_unavailable',
    );
    await f.searchVault.writeOwned(
      webSearchCredentialScope(f.profile.profileAccessKey, { ...withRef, id: 'other-account' }),
      syntheticKey(),
    );
    await rejected(
      f.manager().updateWebSearch({ ...f.identity('other-account'), ...base }),
      'web_search_credential_unavailable',
    );
    await rejected(
      f.manager().updateWebSearch({
        ...f.identity('mismatched'),
        ...base,
        credential: { providerId: 'wrong', secret: syntheticKey() },
      }),
      'web_search_connection_invalid',
    );
    const inline = { ...withRef, connection: { ...withRef.connection, apiKey: syntheticKey() } };
    await rejected(
      f.manager().updateWebSearch({ ...f.identity('inline'), ...base, searchProviders: [inline] }),
      'web_search_configuration_invalid',
    );
    expect(await f.journal('inline')).toBeNull();
    await rejected(
      f.manager().updateWebSearch({
        ...f.identity('masked'),
        ...base,
        searchProviders: [dedicated],
        credential: { providerId: dedicated.id, secret: 'REDACTED' },
      }),
      'web_search_credential_unavailable',
    );
    expect(await f.journal('masked')).toBeNull();
    expect((await f.read()).readSet).toEqual(readSet);
    expect(f.counts.writes).toBe(2);
  } finally {
    await f.close();
  }
});

test('save validates existing provider account locally and preserves a model-free account declaration', async () => {
  const f = await fixture();
  try {
    const ref = await f.modelVault.put(syntheticKey());
    const config: JsonObject = {
      provider: {
        research: {
          type: 'deepseek',
          name: 'Research account',
          baseURL: 'https://api.deepseek.com',
          credentialRef: ref.id,
          models: [],
        },
        wrongOrigin: {
          type: 'deepseek',
          baseURL: 'https://unrelated.invalid',
          credentialRef: `credential:${randomUUID()}`,
          models: [],
        },
        localCodex: {
          type: 'codex',
          baseURL: 'https://api.openai.com/v1',
          credentialRef: `credential:${randomUUID()}`,
          models: [],
        },
      },
    };
    writeFileSync(f.file, JSON.stringify(config));
    const first = await f.read();
    expect(first.eligibleConnections).toEqual([
      { providerAlias: 'research', name: 'Research account', adapter: 'deepseek-search' },
    ]);
    expect(JSON.stringify(first).includes(ref.id)).toBe(false);
    const provider = {
      ...dedicated,
      adapter: 'deepseek-search' as const,
      connection: { kind: 'provider' as const, providerAlias: 'research' },
    };
    const input = {
      ...f.identity('alias'),
      expectedReadSet: first.readSet!,
      webSearch: selected,
      searchProviders: [provider],
    };
    expect((await f.manager().updateWebSearch(input)).state).toBe('applied');
    const after = await f.read();
    expect(after.searchProviders).toEqual([provider]);
    expect(f.counts.writes).toBe(0);
    expect(f.user.read().value.models).toEqual([]);
    await rejected(
      f.manager().updateWebSearch({
        ...input,
        ...f.identity('mismatch'),
        expectedReadSet: after.readSet!,
        searchProviders: [{ ...provider, adapter: 'perplexity-search' }],
      }),
      'web_search_connection_invalid',
    );
    expect((await f.read()).readSet).toEqual(after.readSet);
  } finally {
    await f.close();
  }
});

for (const failCleanup of [false, true])
  test(`stale publication ${failCleanup ? 'reports uncertain cleanup' : 'removes only the new unpublished credential'}`, async () => {
    const f = await fixture();
    try {
      const read = await f.read();
      f.setWriteHook(() => writeFileSync(f.file, '{"unrelated":19}'));
      if (failCleanup) f.failCleanup();
      const input = {
        ...f.identity('concurrent-write'),
        expectedReadSet: read.readSet!,
        webSearch: selected,
        searchProviders: [dedicated],
        credential: { providerId: dedicated.id, secret: syntheticKey() },
      };
      await rejected(
        f.manager().updateWebSearch(input),
        failCleanup ? 'web_search_credential_outcome_unknown' : 'configuration_conflict',
      );
      const receipt = await f.manager().getMutation(input);
      expect(receipt?.state).toBe(failCleanup ? 'outcome_unknown' : 'failed');
      expect(f.counts).toEqual({ writes: 1, reads: 1, removes: 1 });
      expect(await f.manager().updateWebSearch(input)).toEqual(receipt!);
      expect(f.counts.writes).toBe(1);
      expect(f.user.read().value.unrelated).toBe(19);
      expect((await f.read()).searchProviders).toEqual([]);
    } finally {
      await f.close();
    }
  });
