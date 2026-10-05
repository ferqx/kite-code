import { expect, test } from 'bun:test';
import {
  type CredentialBackend,
  createCredentialVault,
  createTemporaryCredentialBackend,
} from '@kite-ai/agent/config';
import {
  createMcpCredentialBroker,
  createMcpOAuthProvider,
  McpCredentialError,
} from '@kite-ai/agent/mcp';
import {
  exchangeAuthorization,
  refreshAuthorization,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const scope = { namespace: 'mcp.oauth' as const, ownerDigest: 'a'.repeat(64) };
const metadata = {
  issuer: 'https://auth.example.test',
  authorization_endpoint: 'https://auth.example.test/authorize',
  token_endpoint: 'https://auth.example.test/token',
  response_types_supported: ['code'],
  token_endpoint_auth_methods_supported: ['none'],
};
function fixture(backend: CredentialBackend = createTemporaryCredentialBackend()) {
  const vault = createCredentialVault({ backend }),
    controller = new AbortController();
  let fresh = true,
    redirects = 0;
  const options = {
    vault,
    scope,
    signal: controller.signal,
    assertFresh() {
      if (!fresh) throw Error('private-source-body');
    },
    redirectUrl: new URL('http://127.0.0.1:43210/oauth/callback'),
    now: () => 1000,
    onAuthorization() {
      redirects++;
    },
  };
  return {
    vault,
    controller,
    options,
    provider: createMcpOAuthProvider(options),
    change() {
      fresh = false;
    },
    redirects: () => redirects,
  };
}
test('actual SDK PKCE/code exchange and refresh use one owned vault; cold provider restores client/token/discovery but no verifier or authorization', async () => {
  const f = fixture();
  try {
    await f.provider.saveClientInformation({ client_id: 'client' });
    await f.provider.saveDiscoveryState({
      authorizationServerUrl: metadata.issuer,
      authorizationServerMetadata: metadata,
    });
    const flow = await startAuthorization(metadata.issuer, {
      metadata,
      clientInformation: { client_id: 'client' },
      redirectUrl: f.provider.redirectUrl,
      state: f.provider.state(),
    });
    f.provider.saveCodeVerifier(flow.codeVerifier);
    await f.provider.redirectToAuthorization(flow.authorizationUrl);
    expect(f.provider.verifyState(flow.authorizationUrl.searchParams.get('state')!)).toBe(true);
    expect(f.provider.verifyState('wrong')).toBe(false);
    expect(flow.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    const grants: string[] = [];
    const fetchFn: FetchLike = async (input, init) => {
      expect(String(input)).toBe(metadata.token_endpoint);
      const body = new URLSearchParams(String(init?.body));
      grants.push(body.get('grant_type')!);
      expect(String(input)).not.toContain('private-');
      if (grants.length === 1) {
        expect(body.get('code_verifier')).toBe(flow.codeVerifier);
        expect(body.get('code')).toBe('private-code');
      } else expect(body.get('refresh_token')).toBe('private-refresh');
      return Response.json({
        access_token: grants.length === 1 ? 'private-access' : 'private-new-access',
        refresh_token: 'private-refresh',
        token_type: 'Bearer',
        expires_in: 30,
      });
    };
    const tokens = await exchangeAuthorization(metadata.issuer, {
      metadata,
      clientInformation: { client_id: 'client' },
      authorizationCode: 'private-code',
      codeVerifier: f.provider.codeVerifier(),
      redirectUri: f.provider.redirectUrl,
      fetchFn,
    });
    await f.provider.saveTokens(tokens);
    const firstState = await f.provider.getTokenState();
    expect(firstState).toEqual({
      present: true,
      expiresAt: 31000,
      tokenRevision: expect.stringMatching(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
      ),
    });
    expect(() => f.provider.codeVerifier()).toThrow('mcp_oauth_verifier_unavailable');
    const cold = createMcpOAuthProvider({
      ...f.options,
      onAuthorization() {
        throw Error('must-not-open');
      },
    });
    expect(await cold.clientInformation()).toEqual({ client_id: 'client' });
    expect((await cold.discoveryState())?.authorizationServerUrl).toBe(`${metadata.issuer}/`);
    expect(() => cold.codeVerifier()).toThrow('mcp_oauth_verifier_unavailable');
    expect(cold.getPendingAuthorizationUrl()).toBeUndefined();
    const refreshed = await refreshAuthorization(metadata.issuer, {
      metadata,
      clientInformation: { client_id: 'client' },
      refreshToken: (await cold.tokens())!.refresh_token!,
      fetchFn,
    });
    await cold.saveTokens(refreshed);
    expect((await cold.getTokenState()).tokenRevision).not.toBe(firstState.tokenRevision);
    expect((await f.provider.tokens())?.access_token).toBe('private-new-access');
    expect(grants).toEqual(['authorization_code', 'refresh_token']);
    expect(f.redirects()).toBe(1);
    await cold.invalidateCredentials('tokens');
    expect(await cold.getTokenState()).toEqual({
      present: false,
      expiresAt: null,
      tokenRevision: null,
    });
    expect(await cold.clientInformation()).toEqual({ client_id: 'client' });
    await cold.invalidateCredentials('all');
    expect(await f.vault.readOwned(scope)).toBeNull();
    cold.cancel();
  } finally {
    f.provider.cancel();
  }
});

const unusableAccessTokens = [
  { label: 'non-Bearer type', access_token: 'owned-valid', token_type: 'DPoP' },
  { label: 'control character', access_token: 'owned\ninvalid', token_type: 'Bearer' },
  { label: 'over Broker limit', access_token: 'a'.repeat(8001), token_type: 'Bearer' },
  { label: 'wide Unicode', access_token: 'owned-😀', token_type: 'Bearer' },
  { label: 'embedded whitespace', access_token: 'owned invalid', token_type: 'Bearer' },
  { label: 'invalid padding', access_token: 'owned=invalid', token_type: 'Bearer' },
];
for (const invalid of unusableAccessTokens)
  test(`unusable OAuth ${invalid.label} refuses save and cold material without changing original bytes`, async () => {
    let value: string | null = null,
      writes = 0;
    const f = fixture({
      kind: 'temporary',
      async resolve() {
        return value;
      },
      async put(_id, material) {
        writes++;
        value = material;
      },
      async remove() {
        value = null;
      },
    });
    try {
      await f.provider.saveTokens({
        access_token: 'owned-original',
        token_type: 'Bearer',
        refresh_token: 'opaque refresh/% ü',
      });
      const original = value,
        state = await f.provider.getTokenState();
      let saveError: unknown;
      try {
        await f.provider.saveTokens({
          access_token: invalid.access_token,
          token_type: invalid.token_type,
        });
      } catch (error) {
        saveError = error;
      }
      expect(saveError).toMatchObject({ code: 'mcp_oauth_material_invalid' });
      expect(writes).toBe(1);
      expect(value === original).toBe(true);
      expect(await f.provider.getTokenState()).toEqual(state);
      const altered = JSON.parse(original!);
      altered.tokens = { access_token: invalid.access_token, token_type: invalid.token_type };
      await f.vault.writeOwned(scope, JSON.stringify(altered));
      const beforeRead = value;
      let readError: unknown;
      try {
        await f.provider.tokens();
      } catch (error) {
        readError = error;
      }
      expect(readError).toMatchObject({ code: 'mcp_oauth_material_invalid' });
      expect(value === beforeRead).toBe(true);
      expect(writes).toBe(2);
    } finally {
      f.provider.cancel();
    }
  });

test('Bearer 8000-character boundary preserves SDK refresh material and reaches the actual Broker header consumer', async () => {
  const f = fixture();
  try {
    const accessToken = `${'a'.repeat(7995)}+/~==`;
    expect(accessToken.length).toBe(8000);
    const material = {
      access_token: accessToken,
      token_type: 'bEaReR',
      refresh_token: 'opaque refresh/% ü',
      scope: 'tools read',
      expires_in: 30,
    };
    await f.provider.saveTokens(material);
    expect(await f.provider.tokens()).toEqual(material);
    const revision = (await f.provider.getTokenState()).tokenRevision!;
    const broker = createMcpCredentialBroker({ vault: f.vault, now: () => 1000 });
    const identity = {
      profileId: 'profile',
      originalStoreId: 'store',
      workspaceId: 'workspace',
      workspaceIdentity: 'owned-root',
      sessionId: 's',
      connectionExecutionId: 'e',
      source: { kind: 'user' as const, id: 'source', revision: 'source-revision' },
      serverId: 'server',
      configDigest: 'config',
      authProfileId: 'oauth',
      policyRevision: revision,
    };
    const ref = broker.issueOwned({
      identity,
      purpose: 'mcp.http',
      expiresAt: 31000,
      revocationRevision: 0,
      resolve: () => f.provider.readAccessToken(revision),
    });
    let uses = 0;
    await broker.withHeaders(
      ref,
      { identity, purpose: 'mcp.http', revocationRevision: 0, signal: f.controller.signal },
      (headers) => {
        uses++;
        expect(headers.authorization === `Bearer ${accessToken}`).toBe(true);
        expect(new Headers(headers).get('authorization') === `Bearer ${accessToken}`).toBe(true);
      },
    );
    expect(uses).toBe(1);
  } finally {
    f.provider.cancel();
  }
});
test('serialized material updates preserve all fields and isolate ownership; full bound token metadata has no verifier', async () => {
  const f = fixture();
  try {
    await Promise.all([
      f.provider.saveClientInformation({ client_id: 'client' }),
      f.provider.saveTokens({ access_token: 'private-access', token_type: 'Bearer' }),
      f.provider.saveDiscoveryState({ authorizationServerUrl: metadata.issuer }),
    ]);
    const stored = JSON.parse((await f.vault.readOwned(scope))!);
    expect(stored).toMatchObject({
      version: 1,
      kind: 'mcp.oauth',
      ownerDigest: scope.ownerDigest,
      issuedAt: 1000,
      expiresAt: null,
      clientInformation: { client_id: 'client' },
    });
    expect(stored).not.toHaveProperty('codeVerifier');
    const other = createMcpOAuthProvider({
      ...f.options,
      scope: { ...scope, ownerDigest: 'b'.repeat(64) },
    });
    expect(await other.tokens()).toBeUndefined();
    other.cancel();
    f.provider.saveCodeVerifier('a'.repeat(43));
    await f.provider.invalidateCredentials('verifier');
    expect(() => f.provider.codeVerifier()).toThrow('mcp_oauth_verifier_unavailable');
  } finally {
    f.provider.cancel();
  }
});
test('configured client secret uses ordinary vault reference without copying it into client metadata', async () => {
  const f = fixture();
  const ref = await f.vault.put('private-client-secret');
  const p = createMcpOAuthProvider({
    ...f.options,
    clientId: 'configured',
    clientSecretRef: ref.id,
  });
  try {
    expect(await p.clientInformation()).toEqual({
      client_id: 'configured',
      client_secret: 'private-client-secret',
    });
    expect(JSON.stringify(p.clientMetadata)).not.toContain('private-client-secret');
    expect(await f.vault.readOwned(scope)).toBeNull();
  } finally {
    p.cancel();
    f.provider.cancel();
  }
});
test('cancel and scope drift during delayed material read prevent late token persistence and authorization', async () => {
  for (const kind of ['cancel', 'drift'] as const) {
    const backend = createTemporaryCredentialBackend();
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((r) => {
        release = r;
      }),
      ready = new Promise<void>((r) => {
        entered = r;
      });
    const f = fixture({
      ...backend,
      async resolve(key) {
        entered();
        await blocked;
        return backend.resolve(key);
      },
    });
    const pending = f.provider.saveTokens({ access_token: 'late-private', token_type: 'Bearer' });
    void pending.catch(() => {});
    await ready;
    if (kind === 'cancel') f.controller.abort();
    else f.change();
    release();
    await expect(pending).rejects.toThrow(
      kind === 'cancel' ? 'mcp_oauth_cancelled' : 'mcp_oauth_scope_changed',
    );
    expect(await createCredentialVault({ backend }).readOwned(scope)).toBeNull();
    expect(f.redirects()).toBe(0);
    f.provider.cancel();
  }
});
test('malformed material and SDK inputs return finite credential errors, never secret bodies', async () => {
  const f = fixture();
  try {
    await f.vault.writeOwned(
      scope,
      '{"version":1,"kind":"mcp.oauth","ownerDigest":"foreign-private"}',
    );
    await expect(f.provider.tokens()).rejects.toThrow('mcp_oauth_material_invalid');
    try {
      await f.provider.saveTokens({
        access_token: 'private-secret',
        token_type: 'Bearer',
        expires_in: -1,
      });
      throw Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(McpCredentialError);
      expect(String(error)).not.toContain('private-secret');
    }
    expect(() =>
      createMcpOAuthProvider({
        ...f.options,
        redirectUrl: new URL('https://example.test/oauth/callback'),
      }),
    ).toThrow('mcp_oauth_configuration_invalid');
    f.provider.cancel();
    await expect(
      f.provider.saveTokens({ access_token: 'later', token_type: 'Bearer' }),
    ).rejects.toThrow('mcp_oauth_cancelled');
  } finally {
    f.provider.cancel();
  }
});

test('cancel after owned backend write began reports actual publication unknown and never claims zero persistence', async () => {
  const backend = createTemporaryCredentialBackend();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((r) => {
      release = r;
    }),
    ready = new Promise<void>((r) => {
      entered = r;
    });
  const f = fixture({
    ...backend,
    async put(key, value) {
      entered();
      await blocked;
      await backend.put(key, value);
    },
  });
  const pending = f.provider.saveTokens({
    access_token: 'actual-private-committed',
    token_type: 'Bearer',
  });
  void pending.catch(() => {});
  await ready;
  f.controller.abort();
  release();
  await expect(pending).rejects.toThrow('mcp_oauth_publication_unknown');
  const observed = await createCredentialVault({ backend }).readOwned(scope);
  expect(JSON.parse(observed!).tokens.access_token).toBe('actual-private-committed');
  await expect(f.provider.tokens()).rejects.toThrow('mcp_oauth_cancelled');
  expect(f.redirects()).toBe(0);
  f.provider.cancel();
});

test('stored expiry identity and finite storage budget reject corrupt or oversized material without replacing previous bytes', async () => {
  const f = fixture();
  try {
    await f.provider.saveTokens({ access_token: 'original', token_type: 'Bearer', expires_in: 30 });
    const original = (await f.vault.readOwned(scope))!;
    const malformed = JSON.parse(original);
    malformed.expiresAt = 32000;
    await f.vault.writeOwned(scope, JSON.stringify(malformed));
    await expect(f.provider.getTokenState()).rejects.toThrow('mcp_oauth_material_invalid');
    await f.vault.writeOwned(scope, original);
    await expect(
      Promise.resolve().then(() =>
        f.provider.saveTokens({ access_token: 'x'.repeat(65536), token_type: 'Bearer' }),
      ),
    ).rejects.toThrow('mcp_oauth_material_invalid');
    await expect(
      f.provider.saveTokens({
        access_token: 'original',
        token_type: 'Bearer',
        refresh_token: 'x'.repeat(65536),
      }),
    ).rejects.toThrow('mcp_oauth_material_invalid');
    expect(await f.vault.readOwned(scope)).toBe(original);
  } finally {
    f.provider.cancel();
  }
});

test('factory, state and verifier are local; failed owned removal returns finite unknown without pretending local or remote revoke completed', async () => {
  const backend = createTemporaryCredentialBackend();
  let calls = 0,
    failRemove = false;
  const f = fixture({
    ...backend,
    async resolve(key) {
      calls++;
      return backend.resolve(key);
    },
    async put(key, value) {
      calls++;
      await backend.put(key, value);
    },
    async remove(key) {
      calls++;
      if (failRemove) throw Error('private-removal-body');
      await backend.remove(key);
    },
  });
  try {
    expect(calls).toBe(0);
    expect(f.provider.verifyState(f.provider.state())).toBe(true);
    f.provider.saveCodeVerifier('b'.repeat(43));
    expect(f.provider.codeVerifier()).toBe('b'.repeat(43));
    expect(calls).toBe(0);
    await f.provider.saveTokens({ access_token: 'kept-private-material', token_type: 'Bearer' });
    failRemove = true;
    await expect(f.provider.invalidateCredentials('all')).rejects.toThrow(
      'mcp_oauth_publication_unknown',
    );
    expect(await f.vault.readOwned(scope)).toBeNull();
    expect(
      JSON.parse((await createCredentialVault({ backend }).readOwned(scope))!).tokens.access_token,
    ).toBe('kept-private-material');
  } finally {
    f.provider.cancel();
  }
});

test('token revisions change on every save and original-revision access reads cannot cross clear and login', async () => {
  const f = fixture();
  try {
    expect(await f.provider.getTokenState()).toEqual({
      present: false,
      expiresAt: null,
      tokenRevision: null,
    });
    await f.provider.saveTokens({ access_token: 'same-material', token_type: 'Bearer' });
    const first = (await f.provider.getTokenState()).tokenRevision!;
    expect(await f.provider.readAccessToken(first)).toBe('same-material');
    await f.provider.saveTokens({ access_token: 'same-material', token_type: 'Bearer' });
    const second = (await f.provider.getTokenState()).tokenRevision!;
    expect(second).not.toBe(first);
    expect(await f.provider.readAccessToken(first)).toBeNull();
    await f.provider.invalidateCredentials('all');
    expect(await f.provider.readAccessToken(second)).toBeNull();
    await f.provider.saveTokens({ access_token: 'new-login', token_type: 'Bearer' });
    const third = (await f.provider.getTokenState()).tokenRevision!;
    expect(third).not.toBe(second);
    expect(await f.provider.readAccessToken(second)).toBeNull();
    expect(await f.provider.readAccessToken(third)).toBe('new-login');
    await expect(f.provider.readAccessToken('bad-private-revision')).rejects.toThrow(
      'mcp_oauth_configuration_invalid',
    );
    const good = (await f.vault.readOwned(scope))!;
    const corrupted = JSON.parse(good);
    corrupted.tokenRevision = 'not-a-uuid';
    await f.vault.writeOwned(scope, JSON.stringify(corrupted));
    await expect(f.provider.tokens()).rejects.toThrow('mcp_oauth_material_invalid');
    const orphan = JSON.parse(good);
    delete orphan.tokens;
    delete orphan.issuedAt;
    delete orphan.expiresAt;
    await f.vault.writeOwned(scope, JSON.stringify(orphan));
    await expect(f.provider.getTokenState()).rejects.toThrow('mcp_oauth_material_invalid');
  } finally {
    f.provider.cancel();
  }
});
