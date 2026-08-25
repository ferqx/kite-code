import { describe, expect, test } from 'bun:test';
import {
  createBuiltinCredentialBroker,
  KiteMcpOAuthProvider,
  type McpCredentialKey,
  MemoryMcpCredentialStore,
  revokeMcpOAuthToken,
} from '@kite-ai/builtin-runtime/mcp';

const KEY: McpCredentialKey = {
  workspaceKey: 'workspace',
  source: 'user',
  server: 'remote',
  profile: 'oauth',
};

const broker = (store: MemoryMcpCredentialStore) => createBuiltinCredentialBroker({ store });

describe('KiteMcpOAuthProvider', () => {
  test('persists SDK client, token, verifier, and discovery state in one isolated profile', async () => {
    const store = new MemoryMcpCredentialStore();
    const redirects: string[] = [];
    const provider = new KiteMcpOAuthProvider({
      credentialBroker: broker(store),
      credentialKey: KEY,
      redirectUrl: new URL('http://127.0.0.1:43119/oauth/callback'),
      scopes: ['mcp:tools', 'profile'],
      onAuthorization: (url) => {
        redirects.push(url.toString());
      },
      state: 'fixed-high-entropy-state',
    });

    await provider.saveClientInformation({ client_id: 'client-id' });
    await provider.saveCodeVerifier('pkce-secret');
    await provider.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.example.com',
    });
    await provider.saveTokens({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      token_type: 'Bearer',
    });
    await provider.redirectToAuthorization(new URL('https://auth.example.com/authorize?opaque=1'));

    expect(provider.clientMetadata.scope).toBe('mcp:tools profile');
    expect(provider.state()).toBe('fixed-high-entropy-state');
    expect(provider.verifyState('fixed-high-entropy-state')).toBe(true);
    expect(provider.verifyState('fixed-high-entropy-statf')).toBe(false);
    expect(await provider.clientInformation()).toEqual({ client_id: 'client-id' });
    expect(await provider.tokens()).toMatchObject({ access_token: 'access-secret' });
    expect(await provider.discoveryState()).toMatchObject({
      authorizationServerUrl: 'https://auth.example.com',
    });
    await expect(provider.codeVerifier()).rejects.toThrow('verifier is unavailable');
    expect(redirects).toEqual(['https://auth.example.com/authorize?opaque=1']);
    expect(provider.getPendingAuthorizationUrl()?.origin).toBe('https://auth.example.com');
  });

  test('isolates server and workspace credential profiles', async () => {
    const store = new MemoryMcpCredentialStore();
    const first = provider(store, KEY);
    const second = provider(store, { ...KEY, server: 'other' });
    await first.saveTokens({ access_token: 'first', token_type: 'Bearer' });
    await second.saveTokens({ access_token: 'second', token_type: 'Bearer' });
    expect((await first.tokens())?.access_token).toBe('first');
    expect((await second.tokens())?.access_token).toBe('second');
  });

  test('loads a configured OAuth client secret only through its vault reference', async () => {
    const store = new MemoryMcpCredentialStore();
    const secretKey = { ...KEY, profile: 'client-secret' };
    await store.put(secretKey, {
      version: 1,
      kind: 'bearer',
      secret: 'client-secret-value',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    const oauth = new KiteMcpOAuthProvider({
      credentialBroker: broker(store),
      credentialKey: KEY,
      redirectUrl: new URL('http://127.0.0.1:43119/oauth/callback'),
      clientId: 'configured-client',
      clientSecretKey: secretKey,
    });
    expect(await oauth.clientInformation()).toEqual({
      client_id: 'configured-client',
      client_secret: 'client-secret-value',
    });
    expect(JSON.stringify(oauth.clientMetadata)).not.toContain('client-secret-value');
  });

  test('invalidates only the requested credential category', async () => {
    const store = new MemoryMcpCredentialStore();
    const oauth = provider(store, KEY);
    await oauth.saveClientInformation({ client_id: 'client-id' });
    await oauth.saveTokens({ access_token: 'token', token_type: 'Bearer' });
    await oauth.invalidateCredentials('tokens');
    expect(await oauth.tokens()).toBeUndefined();
    expect(await oauth.clientInformation()).toEqual({ client_id: 'client-id' });
    await oauth.invalidateCredentials('all');
    expect(await store.get(KEY)).toBeNull();
  });

  test('rejects non-loopback callbacks', () => {
    expect(
      () =>
        new KiteMcpOAuthProvider({
          credentialBroker: broker(new MemoryMcpCredentialStore()),
          credentialKey: KEY,
          redirectUrl: new URL('https://example.com/oauth/callback'),
        }),
    ).toThrow('loopback');
  });

  test('revokes refresh tokens without placing them in the endpoint URL', async () => {
    const store = new MemoryMcpCredentialStore();
    const oauth = provider(store, KEY);
    await oauth.saveClientInformation({ client_id: 'client-id' });
    await oauth.saveTokens({
      access_token: 'access-secret',
      refresh_token: 'refresh-secret',
      token_type: 'Bearer',
    });
    await oauth.saveDiscoveryState({
      authorizationServerUrl: 'https://auth.example.com',
      authorizationServerMetadata: {
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        revocation_endpoint: 'https://auth.example.com/revoke',
        response_types_supported: ['code'],
      },
    });
    let requestUrl = '';
    let body = '';
    const revoked = await revokeMcpOAuthToken(
      oauth,
      new URL('https://mcp.example.com/mcp'),
      (async (input, init) => {
        requestUrl = String(input);
        body = String(init?.body);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    );
    expect(revoked).toBe(true);
    expect(requestUrl).toBe('https://auth.example.com/revoke');
    expect(requestUrl).not.toContain('refresh-secret');
    expect(new URLSearchParams(body).get('token')).toBe('refresh-secret');
  });
});

function provider(store: MemoryMcpCredentialStore, key: McpCredentialKey) {
  return new KiteMcpOAuthProvider({
    credentialBroker: broker(store),
    credentialKey: key,
    redirectUrl: new URL('http://127.0.0.1:43119/oauth/callback'),
  });
}
