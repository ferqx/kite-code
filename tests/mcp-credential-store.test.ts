import { describe, expect, test } from 'bun:test';
import {
  credentialAccount,
  type McpCredentialKey,
  McpCredentialStoreError,
  MemoryMcpCredentialStore,
  NativeMcpCredentialStore,
} from '@/core/mcp';

const KEY: McpCredentialKey = {
  workspaceKey: 'workspace-a',
  source: 'local',
  server: 'remote',
  profile: 'oauth',
};

describe('MCP credential store', () => {
  test('round-trips OAuth material without exposing identity in the keyring account', async () => {
    const entries = new Map<string, Uint8Array>();
    let observedAccount = '';
    const store = new NativeMcpCredentialStore({
      service: 'test.kite-code.mcp',
      entryFactory: (_service, account) => {
        observedAccount = account;
        return {
          getSecret: async () => entries.get(account)?.slice(),
          setSecret: async (secret) => {
            entries.set(account, secret.slice());
          },
          deleteCredential: async () => entries.delete(account),
        };
      },
    });
    const material = {
      version: 1 as const,
      kind: 'oauth' as const,
      tokens: { access_token: 'access-secret', token_type: 'Bearer' },
      codeVerifier: 'pkce-secret',
      updatedAt: '2026-07-16T00:00:00.000Z',
    };

    await store.put(KEY, material);
    await expect(store.get(KEY)).resolves.toEqual(material);
    expect(observedAccount).toMatch(/^mcp:[a-f0-9]{64}$/);
    expect(observedAccount).not.toContain(KEY.workspaceKey);
    expect(observedAccount).not.toContain(KEY.server);
    await store.delete(KEY);
    await expect(store.get(KEY)).resolves.toBeNull();
  });

  test('uses a domain-separated stable account identity', () => {
    expect(credentialAccount(KEY)).toBe(credentialAccount({ ...KEY }));
    expect(credentialAccount(KEY)).not.toBe(
      credentialAccount({ ...KEY, workspaceKey: 'workspace-b' }),
    );
    expect(credentialAccount(KEY)).not.toBe(credentialAccount({ ...KEY, source: 'user' }));
    expect(credentialAccount(KEY)).not.toBe(credentialAccount({ ...KEY, profile: 'bearer' }));
  });

  test('fails closed when the store is locked or unavailable', async () => {
    const locked = new MemoryMcpCredentialStore('locked');
    await expect(locked.get(KEY)).rejects.toMatchObject({
      name: 'McpCredentialStoreError',
      status: 'locked',
    });
    expect(await locked.status()).toBe('locked');

    const native = new NativeMcpCredentialStore({
      entryFactory: () => ({
        getSecret: async () => {
          throw new Error('User interaction is not allowed because the vault is locked');
        },
        setSecret: async () => {},
        deleteCredential: async () => false,
      }),
    });
    expect(await native.status()).toBe('locked');
    await expect(native.get(KEY)).rejects.toBeInstanceOf(McpCredentialStoreError);
  });

  test('rejects corrupt material instead of returning partial secrets', async () => {
    const store = new NativeMcpCredentialStore({
      entryFactory: () => ({
        getSecret: async () => new TextEncoder().encode('{"kind":"oauth"}'),
        setSecret: async () => {},
        deleteCredential: async () => false,
      }),
    });
    await expect(store.get(KEY)).rejects.toMatchObject({ status: 'unavailable' });
  });
});
