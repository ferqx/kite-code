import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { NativeMcpCredentialStore } from '@kite/builtin-runtime/mcp';

const nativeSmoke = process.env.KITE_RUN_NATIVE_KEYRING_SMOKE === '1' ? test : test.skip;

nativeSmoke('native MCP keyring write/read/delete smoke', async () => {
  const store = new NativeMcpCredentialStore();
  const nonce = randomBytes(16).toString('hex');
  const key = {
    workspaceKey: `platform-smoke-${nonce}`,
    source: 'user' as const,
    server: 'keyring-smoke',
    profile: 'roundtrip',
  };
  const secret = randomBytes(32).toString('base64url');
  try {
    expect(await store.status()).toBe('available');
    await store.put(key, {
      version: 1,
      kind: 'bearer',
      secret,
      updatedAt: new Date().toISOString(),
    });
    expect(await store.get(key)).toMatchObject({ kind: 'bearer', secret });
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
  } finally {
    await store.delete(key);
  }
});
