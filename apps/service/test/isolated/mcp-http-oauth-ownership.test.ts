import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import {
  type CredentialBackend,
  createCredentialVault,
  type OwnedCredentialScope,
} from '@kite-ai/agent/config';
import {
  createMcpAdapter,
  createMcpCredentialBroker,
  createMcpOAuthProvider,
  McpCredentialError,
} from '@kite-ai/agent/mcp';
import { createMcpHttpTransportPort, type McpHttpPortOptions } from '../../src/mcp-http-port';
import { createMcpOAuthSession, McpOAuthSessionError } from '../../src/mcp-oauth-session';

function gate() {
  let enter!: () => void, release!: () => void;
  return {
    seen: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
async function until(read: () => boolean) {
  const end = Date.now() + 5000;
  while (!read()) {
    if (Date.now() >= end) throw Error('owned_bind_deadline');
    await Bun.sleep(2);
  }
}
type Bind = NonNullable<McpHttpPortOptions['servers'][number]['credential']>['bind'];
async function fixture(bind: Bind, canWriteOwned = true, timeoutMs = 50) {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('owned_peer_address');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const adapter = createMcpAdapter({ id: 'owned', transport: { type: 'http', url } });
  const configDigest = adapter.getCatalogue().configDigest;
  const broker = createMcpCredentialBroker({
    vault: {
      async resolve() {
        throw Error('manual_not_used');
      },
    },
  });
  const port = createMcpHttpTransportPort({
    servers: [
      {
        id: 'owned',
        url,
        credential: { broker, ...(canWriteOwned ? { canWriteOwned: true as const } : {}), bind },
      },
    ],
    async admit() {},
    assertFresh() {},
    allowLoopbackForTests: true,
    limits: { timeoutMs },
  });
  return {
    requests: () => requests,
    open: () =>
      port.open(
        {
          originalStoreId: 'store',
          sessionId: 's',
          executionId: 'e',
          serverId: 'owned',
          scopeId: JSON.stringify(['store', 's', 'owned']),
          configDigest,
          configuration: { type: 'http', url },
        },
        { signal: new AbortController().signal },
      ),
    async close() {
      await adapter.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
const scope: OwnedCredentialScope = { namespace: 'mcp.oauth', ownerDigest: 'a'.repeat(64) };
const tokens = { access_token: 'owned-synthetic-access', token_type: 'Bearer', expires_in: 60 };

for (const phase of ['read', 'put'] as const)
  test(`owned ${phase} timeout aborts actual provider and waits for original finally`, async () => {
    const native = gate(),
      lease = gate();
    let writes = 0,
      value: string | null = null,
      signal: AbortSignal | undefined;
    let finallyEntered = false,
      released = false,
      settled = false;
    const backend: CredentialBackend = {
      kind: 'temporary',
      async resolve() {
        if (phase === 'read') {
          native.enter();
          await native.wait;
        }
        return value;
      },
      async put(_id, material) {
        if (phase === 'put') {
          native.enter();
          await native.wait;
        }
        writes++;
        value = material;
      },
      async remove() {
        value = null;
      },
    };
    const vault = createCredentialVault({ backend });
    const f = await fixture(async (_binding, options) => {
      signal = options.signal;
      const provider = createMcpOAuthProvider({
        vault,
        scope,
        redirectUrl: new URL('http://127.0.0.1/oauth/callback'),
        signal,
        assertFresh: () => signal!.throwIfAborted(),
      });
      try {
        await provider.saveTokens(tokens);
        return null;
      } catch (error) {
        if (error instanceof McpCredentialError) throw new McpOAuthSessionError(error.code);
        throw error;
      } finally {
        provider.cancel();
        finallyEntered = true;
        lease.enter();
        await lease.wait;
        released = true;
      }
    });
    let failure: unknown;
    const work = f.open().then(
      (handle) => {
        settled = true;
        return handle;
      },
      (error) => {
        failure = error;
        settled = true;
        return null;
      },
    );
    try {
      await native.seen;
      await until(() => signal?.aborted === true);
      expect(settled).toBe(false);
      expect(finallyEntered).toBe(false);
      native.release();
      await lease.seen;
      expect(settled).toBe(false);
      expect(released).toBe(false);
      expect(writes).toBe(phase === 'put' ? 1 : 0);
      lease.release();
      expect(await work).toBeNull();
      expect(failure).toMatchObject({ code: 'mcp_oauth_publication_unknown' });
      expect(released).toBe(true);
      expect(f.requests()).toBe(0);
      expect(value !== null).toBe(phase === 'put');
    } finally {
      native.release();
      lease.release();
      const handle = await work;
      if (handle) await handle.stop();
      await vault.removeOwned(scope);
      await f.close();
    }
  }, 10000);

test('real Session clear plus coordinator release failure remains finite cleanup unknown', async () => {
  let removes = 0;
  const vault = createCredentialVault({
    backend: {
      kind: 'temporary',
      async put() {},
      async resolve() {
        return null;
      },
      async remove() {
        removes++;
      },
      async status() {
        return 'available';
      },
    },
  });
  const f = await fixture(async (_binding, { signal }) => {
    const release = () => {
      throw new McpOAuthSessionError('mcp_oauth_cleanup_unknown');
    };
    const session = createMcpOAuthSession({
      vault,
      scope,
      serverUrl: 'https://controlled.invalid/mcp',
      signal,
      assertFresh: () => signal.throwIfAborted(),
      async openBrowser() {
        throw Error('browser_forbidden');
      },
    });
    try {
      await session.clear();
      return null;
    } finally {
      release();
    }
  });
  try {
    await expect(f.open()).rejects.toMatchObject({ code: 'mcp_oauth_cleanup_unknown' });
    expect(removes).toBe(1);
    expect(f.requests()).toBe(0);
  } finally {
    await f.close();
  }
}, 10000);

test('real Session credential refresh through owned AS retains native publication unknown at bind deadline', async () => {
  const native = gate();
  let value: string | null = null,
    commits = 0,
    tokenRequests = 0,
    browserCalls = 0;
  let signal: AbortSignal | undefined,
    settled = false,
    released = false;
  const backend: CredentialBackend = {
    kind: 'temporary',
    async status() {
      return 'available';
    },
    async resolve() {
      return value;
    },
    async remove() {
      value = null;
    },
    async put(_id, material) {
      const current = JSON.parse(material) as { tokens?: { access_token?: string } };
      if (current.tokens?.access_token === 'owned-refreshed-access') {
        native.enter();
        await native.wait;
        commits++;
      }
      value = material;
    },
  };
  const vault = createCredentialVault({ backend });
  const seed = createMcpOAuthProvider({
    vault,
    scope,
    redirectUrl: new URL('http://127.0.0.1/oauth/callback'),
    signal: new AbortController().signal,
    assertFresh() {},
    now: () => Date.now() - 10000,
  });
  await seed.saveTokens({
    access_token: 'owned-expired-access',
    refresh_token: 'owned-refresh',
    token_type: 'Bearer',
    expires_in: 1,
  });
  seed.cancel();
  const as = createServer(async (request, response) => {
    const address = as.address();
    if (!address || typeof address === 'string') throw Error('owned_as_address');
    const base = `http://127.0.0.1:${address.port}`;
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/.well-known/oauth-protected-resource'))
      response.end(JSON.stringify({ resource: `${base}/mcp`, authorization_servers: [base] }));
    else if (request.url?.startsWith('/.well-known/'))
      response.end(
        JSON.stringify({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
        }),
      );
    else if (request.url === '/token') {
      tokenRequests++;
      const chunks: Buffer[] = [];
      for await (const part of request) chunks.push(Buffer.from(part));
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('client_id')).toBe('owned-client');
      response.end(
        JSON.stringify({
          access_token: 'owned-refreshed-access',
          refresh_token: 'owned-refresh',
          token_type: 'Bearer',
          expires_in: 60,
        }),
      );
    } else response.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => as.listen(0, '127.0.0.1', resolve));
  const address = as.address();
  if (!address || typeof address === 'string') throw Error('owned_as_address');
  const f = await fixture(
    async (_binding, options) => {
      signal = options.signal;
      const session = createMcpOAuthSession({
        vault,
        scope,
        serverUrl: `http://127.0.0.1:${address.port}/mcp`,
        clientId: 'owned-client',
        signal,
        assertFresh: () => signal!.throwIfAborted(),
        network: { allowLoopbackForTests: true },
        async openBrowser() {
          browserCalls++;
          throw Error('refresh_browser_forbidden');
        },
      });
      try {
        await session.credential();
        return null;
      } finally {
        released = true;
      }
    },
    true,
    250,
  );
  let failure: unknown;
  const work = f.open().then(
    (handle) => {
      settled = true;
      return handle;
    },
    (error) => {
      settled = true;
      failure = error;
      return null;
    },
  );
  try {
    await native.seen;
    await until(() => signal?.aborted === true);
    expect(settled).toBe(false);
    expect(released).toBe(false);
    native.release();
    expect(await work).toBeNull();
    expect(failure).toMatchObject({ code: 'mcp_oauth_publication_unknown' });
    expect(commits).toBe(1);
    expect(tokenRequests).toBe(1);
    expect(browserCalls).toBe(0);
    expect(released).toBe(true);
    expect(f.requests()).toBe(0);
  } finally {
    native.release();
    const handle = await work;
    if (handle) await handle.stop();
    await vault.removeOwned(scope);
    await f.close();
    await new Promise<void>((resolve, reject) =>
      as.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 10000);

test('ordinary manual read-only bind preserves bounded timeout without owned publication semantics', async () => {
  const native = gate(),
    complete = gate();
  let signal: AbortSignal | undefined;
  const f = await fixture(async (_binding, options) => {
    signal = options.signal;
    native.enter();
    await native.wait;
    complete.enter();
    return null;
  }, false);
  try {
    const work = f.open();
    await native.seen;
    await expect(work).rejects.toMatchObject({ code: 'mcp_http_credential_unavailable' });
    expect(signal?.aborted).toBe(false);
    expect(f.requests()).toBe(0);
  } finally {
    native.release();
    await complete.seen;
    await f.close();
  }
}, 10000);
