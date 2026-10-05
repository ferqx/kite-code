import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import {
  type CredentialBackend,
  createCredentialVault,
  createTemporaryCredentialBackend,
} from '@kite-ai/agent/config';
import { createMcpOAuthSession, type McpOAuthSessionOptions } from '../../src/mcp-oauth-session';

const scope = { namespace: 'mcp.oauth' as const, ownerDigest: 'c'.repeat(64) };
async function asFixture() {
  const sockets = new Set<Socket>();
  const requests: { path: string; method: string; body: URLSearchParams }[] = [];
  const revokedTokens: string[] = [];
  let invalidRefresh = false,
    supportsRevoke = true,
    revokeStatus = 200,
    challenge: string | undefined,
    revokeBarrier: { entered(): void; released: Promise<void> } | undefined;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    requests.push({ path: request.url!, method: request.method!, body });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    if (request.url?.startsWith('/.well-known/oauth-protected-resource')) {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          scopes_supported: ['tools'],
        }),
      );
    } else if (request.url?.startsWith('/.well-known/')) {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          ...(supportsRevoke ? { revocation_endpoint: `${base}/revoke` } : {}),
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        }),
      );
    } else if (request.url === '/register') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          client_id: 'owned-client',
          ...JSON.parse(Buffer.concat(chunks).toString()),
        }),
      );
    } else if (request.url === '/token') {
      if (
        body.get('grant_type') === 'authorization_code' &&
        (!challenge ||
          createHash('sha256')
            .update(body.get('code_verifier') ?? '')
            .digest('base64url') !== challenge ||
          body.get('code') !== 'owned-code')
      ) {
        response
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      if (body.get('grant_type') === 'refresh_token' && invalidRefresh) {
        response
          .writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          access_token: 'owned-access',
          refresh_token: 'owned-refresh',
          token_type: 'Bearer',
          expires_in: 60,
        }),
      );
    } else if (request.url === '/revoke') {
      if (revokeBarrier) {
        revokeBarrier.entered();
        await revokeBarrier.released;
      }
      revokedTokens.push(body.get('token') ?? '');
      response.writeHead(revokeStatus).end('');
    } else response.writeHead(404).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
    requests,
    sockets,
    revokedTokens,
    challenge(value: string) {
      challenge = value;
    },
    invalidRefresh() {
      invalidRefresh = true;
    },
    noRevoke() {
      supportsRevoke = false;
    },
    failAfterRevoke() {
      revokeStatus = 500;
    },
    holdRevoke(value: { entered(): void; released: Promise<void> }) {
      revokeBarrier = value;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      expect(sockets.size).toBe(0);
    },
  };
}
function sessionOptions(
  f: Awaited<ReturnType<typeof asFixture>>,
  backend: CredentialBackend = createTemporaryCredentialBackend(),
) {
  const controller = new AbortController(),
    vault = createCredentialVault({ backend });
  let opened = 0,
    clock = 1000,
    callback: URL | undefined;
  const options: { -readonly [K in keyof McpOAuthSessionOptions]: McpOAuthSessionOptions[K] } = {
    vault,
    scope,
    serverUrl: f.url,
    signal: controller.signal,
    assertFresh() {},
    callbackTimeoutMs: 1000,
    now: () => clock,
    network: { allowLoopbackForTests: true },
    async openBrowser(url) {
      opened++;
      callback = new URL(url.searchParams.get('redirect_uri')!);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      f.challenge(url.searchParams.get('code_challenge')!);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set('code', 'owned-code');
      expect((await fetch(callback)).status).toBe(200);
    },
  };
  return {
    options,
    vault,
    controller,
    backend,
    opened: () => opened,
    callback: () => callback,
    advance(value = 57000) {
      clock = value;
    },
  };
}
async function callbackClosed(url: URL) {
  const result = await new Promise<string>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(url.port) });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve('unconfirmed');
    }, 1000);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve('still_open');
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(error.code ?? 'unavailable');
    });
  });
  expect(result).toBe('ECONNREFUSED');
}

test('actual SDK DCR/PKCE accepts only exact callback; cold vault resumes and proactive refresh never opens browser or registers', async () => {
  const f = await asFixture(),
    v = sessionOptions(f);
  let callback: URL | undefined;
  const original = v.options.openBrowser;
  v.options.openBrowser = async (url, signal) => {
    callback = new URL(url.searchParams.get('redirect_uri')!);
    const invalid = new URL(callback);
    invalid.searchParams.set('code', 'owned-code');
    invalid.searchParams.set('state', 'wrong');
    expect((await fetch(invalid)).status).toBe(400);
    invalid.searchParams.set('state', url.searchParams.get('state')!);
    const wrongPath = new URL(invalid);
    wrongPath.pathname = '/wrong';
    expect((await fetch(wrongPath)).status).toBe(400);
    expect((await fetch(invalid, { method: 'POST' })).status).toBe(400);
    const duplicate = new URL(invalid);
    duplicate.searchParams.append('code', 'owned-code');
    expect((await fetch(duplicate)).status).toBe(400);
    expect(f.requests.filter((x) => x.path === '/token')).toHaveLength(0);
    await original(url, signal);
    expect((await fetch(invalid)).status).toBe(400);
  };
  try {
    const session = createMcpOAuthSession(v.options);
    await session.login();
    await callbackClosed(callback!);
    const material = JSON.parse((await v.vault.readOwned(scope))!);
    expect(material.tokens.access_token).toBe('owned-access');
    expect(material.codeVerifier).toBeUndefined();
    expect(material.state).toBeUndefined();
    const first = await session.credential();
    expect(first?.tokenRevision).toMatch(/^[a-f0-9-]{36}$/);
    expect(Object.keys(first!).sort()).toEqual(['expiresAt', 'tokenRevision']);
    const registrations = f.requests.filter((x) => x.path === '/register').length;
    const cold = createMcpOAuthSession({
      ...v.options,
      vault: createCredentialVault({ backend: v.backend }),
      openBrowser: async () => {
        throw Error('unexpected_browser');
      },
    });
    expect(await cold.credential()).toEqual(first);
    v.advance();
    const refreshed = await cold.credential();
    expect(refreshed?.tokenRevision).not.toBe(first?.tokenRevision);
    expect(refreshed?.expiresAt).toBe(117000);
    expect(v.opened()).toBe(1);
    expect(f.requests.filter((x) => x.path === '/register')).toHaveLength(registrations);
    const grants = f.requests.filter((x) => x.path === '/token');
    expect(grants).toHaveLength(2);
    expect(grants.map((x) => x.body.get('grant_type'))).toEqual([
      'authorization_code',
      'refresh_token',
    ]);
    expect(grants.every((x) => x.method === 'POST' && !x.path.includes('owned-'))).toBe(true);
    expect(grants[0]!.body.get('code')).toBe('owned-code');
    expect(grants[1]!.body.get('refresh_token')).toBe('owned-refresh');
    f.invalidRefresh();
    await expect(cold.refresh()).rejects.toThrow('mcp_oauth_reauth_required');
    v.advance(113000);
    await expect(cold.credential()).rejects.toThrow('mcp_oauth_reauth_required');
    expect(f.requests.filter((x) => x.path === '/register')).toHaveLength(registrations);
    expect(v.opened()).toBe(1);
  } finally {
    v.controller.abort();
    await f.close();
  }
}, 10000);

test('actual remote revoke effect followed by HTTP 500 remains unknown and retains the original local tokens', async () => {
  const f = await asFixture(),
    underlying = createTemporaryCredentialBackend();
  let removals = 0;
  const v = sessionOptions(f, {
    ...underlying,
    async remove(id) {
      removals++;
      await underlying.remove(id);
    },
  });
  try {
    const session = createMcpOAuthSession(v.options);
    await session.login();
    const before = JSON.parse((await v.vault.readOwned(scope))!);
    f.failAfterRevoke();
    const error = await session.revoke().catch((error: unknown) => error);
    expect(f.revokedTokens).toEqual(['owned-refresh']);
    expect(f.requests.filter((request) => request.path === '/revoke')).toHaveLength(1);
    expect(error).toMatchObject({ code: 'mcp_oauth_revocation_unknown' });
    expect(String(error)).not.toContain('owned-refresh');
    expect(removals).toBe(0);
    const after = JSON.parse((await v.vault.readOwned(scope))!);
    expect(after.tokens).toEqual(before.tokens);
    expect(after.tokenRevision).toBe(before.tokenRevision);
    expect(v.opened()).toBe(1);
    await callbackClosed(v.callback()!);
  } finally {
    v.controller.abort();
    await f.close();
  }
}, 10000);

test('cancel after actual remote revoke POST reaches the peer preserves unknown and does not remove local material', async () => {
  const f = await asFixture(),
    underlying = createTemporaryCredentialBackend();
  let removals = 0,
    entered!: () => void,
    release!: () => void;
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  const backend: CredentialBackend = {
    ...underlying,
    async remove(id) {
      removals++;
      await underlying.remove(id);
    },
  };
  const v = sessionOptions(f, backend);
  let pending: Promise<unknown> | undefined;
  try {
    const session = createMcpOAuthSession(v.options);
    await session.login();
    const original = JSON.parse((await v.vault.readOwned(scope))!);
    f.holdRevoke({ entered, released });
    pending = session.revoke().catch((error: unknown) => error);
    await reached;
    expect(f.requests.filter((request) => request.path === '/revoke')).toHaveLength(1);
    const before = await v.vault.readOwned(scope);
    expect(JSON.parse(before!).tokens).toEqual(original.tokens);
    expect(JSON.parse(before!).tokenRevision).toBe(original.tokenRevision);
    v.controller.abort();
    release();
    const error = await pending;
    expect(removals).toBe(0);
    expect(await createCredentialVault({ backend: underlying }).readOwned(scope)).toBe(before);
    expect(error).toMatchObject({ code: 'mcp_oauth_revocation_unknown' });
  } finally {
    release();
    v.controller.abort();
    await pending;
    await f.close();
  }
}, 10000);

test('cancel after remote revoke success and actual native removal starts preserves publication unknown and the real deletion', async () => {
  const f = await asFixture(),
    underlying = createTemporaryCredentialBackend();
  let removals = 0,
    entered!: () => void,
    release!: () => void;
  const reached = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    released = new Promise<void>((resolve) => {
      release = resolve;
    });
  const backend: CredentialBackend = {
    ...underlying,
    kind: 'os',
    async remove(id) {
      removals++;
      entered();
      await released;
      await underlying.remove(id);
    },
  };
  const v = sessionOptions(f, backend);
  let pending: Promise<unknown> | undefined;
  try {
    const session = createMcpOAuthSession(v.options);
    await session.login();
    pending = session.revoke().catch((error: unknown) => error);
    await reached;
    expect(f.requests.filter((request) => request.path === '/revoke')).toHaveLength(1);
    expect(removals).toBe(1);
    v.controller.abort();
    release();
    const error = await pending;
    expect(await createCredentialVault({ backend: underlying }).readOwned(scope)).toBeNull();
    expect(error).toMatchObject({ code: 'mcp_oauth_publication_unknown' });
  } finally {
    release();
    v.controller.abort();
    await pending;
    await f.close();
  }
}, 10000);

test('vault status precedes listener/network/browser; callback timeout and cancel close listener without publishing tokens', async () => {
  const f = await asFixture();
  try {
    for (const status of ['locked', 'unavailable'] as const) {
      const backend = { ...createTemporaryCredentialBackend(), status: async () => status };
      const v = sessionOptions(f, backend);
      await expect(createMcpOAuthSession(v.options).login()).rejects.toThrow(
        status === 'locked' ? 'mcp_credential_store_locked' : 'mcp_credential_store_unavailable',
      );
      expect(v.opened()).toBe(0);
      expect(f.requests).toHaveLength(0);
    }
    for (const kind of ['timeout', 'cancel'] as const) {
      const v = sessionOptions(f);
      let callback: URL | undefined;
      v.options.callbackTimeoutMs = 100;
      v.options.openBrowser = async (url) => {
        callback = new URL(url.searchParams.get('redirect_uri')!);
        if (kind === 'cancel') v.controller.abort();
      };
      await expect(createMcpOAuthSession(v.options).login()).rejects.toThrow(
        kind === 'cancel' ? 'mcp_oauth_cancelled' : 'mcp_oauth_timeout',
      );
      await callbackClosed(callback!);
      const material = JSON.parse((await v.vault.readOwned(scope))!);
      expect(material.tokens).toBeUndefined();
      expect(material.codeVerifier).toBeUndefined();
    }
  } finally {
    await f.close();
  }
}, 10000);

test('supported remote revoke sends token only in POST body then removes owned material; unsupported retains it until explicit clear', async () => {
  const f = await asFixture(),
    v = sessionOptions(f);
  try {
    const session = createMcpOAuthSession(v.options);
    await session.login();
    expect(await session.revoke()).toBe('completed');
    expect(await v.vault.readOwned(scope)).toBeNull();
    const revoke = f.requests.filter((x) => x.path === '/revoke');
    expect(revoke).toHaveLength(1);
    expect(revoke[0]!.method).toBe('POST');
    expect(revoke[0]!.body.get('token')).toBe('owned-refresh');
    expect(revoke[0]!.body.get('token_type_hint')).toBe('refresh_token');
    await session.login();
    f.noRevoke();
    const before = JSON.parse((await v.vault.readOwned(scope))!);
    expect(await session.revoke()).toBe('not_supported');
    const after = JSON.parse((await v.vault.readOwned(scope))!);
    expect(after.tokens).toEqual(before.tokens);
    expect(after.tokenRevision).toBe(before.tokenRevision);
    expect(after.clientInformation).toEqual(before.clientInformation);
    expect(f.requests.filter((x) => x.path === '/revoke')).toHaveLength(1);
    await session.clear();
    expect(await session.credential()).toBeNull();
  } finally {
    v.controller.abort();
    await f.close();
  }
}, 10000);

test('cancel during injected owned native-backend put reports publication unknown while actual published token remains inspectable', async () => {
  const f = await asFixture(),
    underlying = createTemporaryCredentialBackend();
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  const backend: CredentialBackend = {
    ...underlying,
    kind: 'os',
    async put(id, value) {
      if (JSON.parse(value).tokens) {
        entered();
        await blocked;
      }
      await underlying.put(id, value);
    },
  };
  const v = sessionOptions(f, backend);
  try {
    const pending = createMcpOAuthSession(v.options)
      .login()
      .catch((error) => error);
    await ready;
    v.controller.abort();
    release();
    const error = await pending;
    expect(error.code).toBe('mcp_oauth_publication_unknown');
    expect(String(error)).not.toContain('owned-access');
    const material = JSON.parse(
      (await createCredentialVault({ backend: underlying }).readOwned(scope))!,
    );
    expect(material.tokens.access_token).toBe('owned-access');
    await callbackClosed(v.callback()!);
  } finally {
    release?.();
    v.controller.abort();
    await f.close();
  }
}, 10000);

test('owned backend token put failure remains finite publication unknown and never fabricates a usable credential', async () => {
  const f = await asFixture(),
    underlying = createTemporaryCredentialBackend();
  const backend: CredentialBackend = {
    ...underlying,
    kind: 'os',
    async put(id, value) {
      if (JSON.parse(value).tokens) throw Error('owned-private-backend-detail');
      await underlying.put(id, value);
    },
  };
  const v = sessionOptions(f, backend);
  try {
    const error = await createMcpOAuthSession(v.options)
      .login()
      .catch((error) => error);
    expect(error.code).toBe('mcp_oauth_publication_unknown');
    expect(String(error)).not.toContain('owned-private-backend-detail');
    const material = JSON.parse(
      (await createCredentialVault({ backend: underlying }).readOwned(scope))!,
    );
    expect(material.tokens).toBeUndefined();
    await callbackClosed(v.callback()!);
  } finally {
    v.controller.abort();
    await f.close();
  }
}, 10000);

test('actual OAuth callback after Source freshness drift rejects immediately and closes its listener without exchanging or publishing tokens', async () => {
  const f = await asFixture(),
    underlying = createTemporaryCredentialBackend();
  let tokenWrites = 0;
  const backend: CredentialBackend = {
    ...underlying,
    async put(id, value) {
      if (JSON.parse(value).tokens) tokenWrites++;
      await underlying.put(id, value);
    },
  };
  const v = sessionOptions(f, backend);
  let fresh = true,
    callback: URL | undefined,
    callbackResponse: Promise<Response> | undefined,
    submittedAt = 0;
  v.options.assertFresh = () => {
    if (!fresh) throw Error('owned-source-freshness-changed');
  };
  v.options.openBrowser = async (url) => {
    callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'owned-code');
    f.challenge(url.searchParams.get('code_challenge')!);
    fresh = false;
    submittedAt = performance.now();
    callbackResponse = fetch(callback);
    await callbackResponse;
  };
  try {
    const error = await createMcpOAuthSession(v.options)
      .login()
      .catch((error: unknown) => error);
    const elapsed = performance.now() - submittedAt;
    expect((await callbackResponse!).status).toBe(409);
    expect(error).toMatchObject({ code: 'mcp_oauth_scope_changed' });
    expect(elapsed).toBeLessThan(500);
    expect(f.requests.filter((request) => request.path === '/token')).toHaveLength(0);
    expect(tokenWrites).toBe(0);
    const material = JSON.parse((await v.vault.readOwned(scope))!);
    expect(material.tokens).toBeUndefined();
    expect(material.tokenRevision).toBeUndefined();
    await callbackClosed(callback!);
  } finally {
    v.controller.abort();
    await f.close();
  }
}, 10000);
