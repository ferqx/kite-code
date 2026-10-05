import { expect, test } from 'bun:test';
import {
  type CredentialBackend,
  createCredentialVault,
  createOsCredentialBackend,
  createTemporaryCredentialBackend,
  type OwnedCredentialScope,
} from '@kite-ai/agent/config';

const scope: OwnedCredentialScope = { namespace: 'mcp.oauth', ownerDigest: 'a'.repeat(64) };
const other: OwnedCredentialScope = { ...scope, ownerDigest: 'b'.repeat(64) };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('owned material uses the same backend, distinct closed keys, survives new vault and cannot be resolved as ordinary credentials', async () => {
  const backend = createTemporaryCredentialBackend(),
    keys: string[] = [];
  const selected: CredentialBackend = {
    ...backend,
    async put(key, value) {
      keys.push(key);
      await backend.put(key, value);
    },
  };
  const vault = createCredentialVault({ backend: selected });
  expect(await vault.readOwned(scope)).toBeNull();
  await vault.writeOwned(scope, '{"token":"private-fixture"}');
  expect(keys[0]).toMatch(/^owned-credential:[a-f0-9]{64}$/);
  expect(keys[0]).not.toContain(scope.ownerDigest);
  expect(await vault.statusOwned(scope)).toBe('available');
  expect(await createCredentialVault({ backend: selected }).readOwned(scope)).toBe(
    '{"token":"private-fixture"}',
  );
  expect(await vault.readOwned(other)).toBeNull();
  await expect(vault.resolve(keys[0]!)).rejects.toThrow('credential_unavailable');
  await expect(vault.revoke(keys[0]!)).rejects.toThrow('credential_unavailable');
  const ordinary = await vault.put('ordinary');
  await vault.removeOwned(scope);
  expect(await vault.readOwned(scope)).toBeNull();
  expect(await vault.resolve(ordinary)).toBe('ordinary');
  await vault.writeOwned(scope, 'new-login');
  expect(await vault.readOwned(scope)).toBe('new-login');
});
test('closed scope, invalid UTF16, empty and oversized owned bytes refuse before backend IO', async () => {
  let calls = 0;
  const vault = createCredentialVault({
    backend: {
      kind: 'temporary',
      async put() {
        calls++;
      },
      async resolve() {
        calls++;
        return null;
      },
      async remove() {
        calls++;
      },
    },
  });
  for (const invalid of [
    { ...scope, extra: true },
    { namespace: 'else', ownerDigest: scope.ownerDigest },
    { ...scope, ownerDigest: 'A'.repeat(64) },
  ])
    await expect(vault.readOwned(invalid as OwnedCredentialScope)).rejects.toThrow(
      'credential_owned_scope_invalid',
    );
  for (const value of ['', '\ud800', '界'.repeat(21846)])
    await expect(vault.writeOwned(scope, value)).rejects.toThrow(
      'credential_owned_material_invalid',
    );
  expect(calls).toBe(0);
});
test('owned async old read cannot survive remove and relogin to return stale material', async () => {
  const backend = createTemporaryCredentialBackend();
  await backend.put('unused', 'irrelevant');
  let hold = false;
  const entered = deferred<void>(),
    release = deferred<void>();
  const vault = createCredentialVault({
    backend: {
      ...backend,
      async resolve(key) {
        const value = await backend.resolve(key);
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return value;
      },
    },
  });
  await vault.writeOwned(scope, 'old');
  hold = true;
  const old = vault.readOwned(scope);
  void old.catch(() => {});
  await entered.promise;
  await vault.removeOwned(scope);
  await vault.writeOwned(scope, 'new');
  hold = false;
  release.resolve();
  await expect(old).rejects.toThrow('credential_owned_changed');
  expect(await vault.readOwned(scope)).toBe('new');
});
test('inflight owned write cannot resurrect after queued removal, and all promises retain their actual outcomes', async () => {
  const backend = createTemporaryCredentialBackend(),
    entered = deferred<void>(),
    release = deferred<void>();
  let hold = true;
  const vault = createCredentialVault({
    backend: {
      ...backend,
      async put(key, value) {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        await backend.put(key, value);
      },
    },
  });
  const write = vault.writeOwned(scope, 'old');
  void write.catch(() => {});
  await entered.promise;
  const removal = vault.removeOwned(scope);
  hold = false;
  release.resolve();
  await expect(write).rejects.toThrow('credential_owned_changed');
  await removal;
  expect(await vault.readOwned(scope)).toBeNull();
  await vault.writeOwned(scope, 'new');
  expect(await vault.readOwned(scope)).toBe('new');
});
test('native owned accounts are lazy, same namespace, and status preserves locked/unavailable without fallback', async () => {
  const values = new Map<string, string>(),
    accounts: string[] = [];
  let state: 'available' | 'locked' | 'unavailable' = 'available';
  const backend = createOsCredentialBackend({
    service: 'fixture',
    accountNamespace: 'owned-profile',
    nativeFactory(_service, account) {
      accounts.push(account);
      return {
        async setPassword(value) {
          values.set(account, value);
        },
        async getPassword() {
          if (state !== 'available')
            throw Object.assign(new Error('private-error-body'), {
              code: state === 'locked' ? 'LOCKED' : 'EIO',
            });
          return values.get(account);
        },
        async deleteCredential() {
          return values.delete(account);
        },
      };
    },
  });
  expect(accounts).toHaveLength(0);
  const vault = createCredentialVault({ backend });
  expect(await vault.statusOwned(scope)).toBe('available');
  await vault.writeOwned(scope, 'material');
  expect(await vault.readOwned(scope)).toBe('material');
  expect(
    accounts.every((account) => /^owned-profile\/owned-credential:[a-f0-9]{64}$/.test(account)),
  ).toBe(true);
  state = 'locked';
  expect(await vault.statusOwned(scope)).toBe('locked');
  await expect(vault.readOwned(scope)).rejects.toThrow('credential_unavailable');
  state = 'unavailable';
  expect(await vault.statusOwned(scope)).toBe('unavailable');
  state = 'available';
  await vault.removeOwned(scope);
  expect(values.size).toBe(0);
  expect(await createCredentialVault().statusOwned(scope)).toBe('unavailable');
});

test('failed owned removal reports failure, blocks the same authority, and does not claim physical deletion', async () => {
  const backend = createTemporaryCredentialBackend();
  const vault = createCredentialVault({
    backend: {
      ...backend,
      async remove() {
        throw Error('private-delete-failure');
      },
    },
  });
  await vault.writeOwned(scope, 'original');
  await expect(vault.removeOwned(scope)).rejects.toThrow('credential_unavailable');
  expect(await vault.readOwned(scope)).toBeNull();
  expect(await createCredentialVault({ backend }).readOwned(scope)).toBe('original');
  await vault.writeOwned(scope, 'explicit-new-login');
  expect(await vault.readOwned(scope)).toBe('explicit-new-login');
});
