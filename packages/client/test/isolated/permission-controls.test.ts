import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import {
  createClient,
  type PermissionMutation,
  type ServerInfo,
  type SetPermissionModeRequest,
} from '../../src';

const profile = { dataRoot: '/chosen/permission-test', name: 'new', accessKey: 'fixture-key' };
const identity: ServerInfo = {
  profile,
  instanceId: 'instance',
  buildId: 'permission-test',
  apiMajor: 1,
  capabilities: ['permission_controls', 'sessions'],
  dataAvailability: 'available',
  storeId: 'store',
};
const expected = { profile, apiMajor: 1, requiredCapabilities: ['sessions'] };
const large = '9007199254740993';
const choice: SetPermissionModeRequest = {
  expectedStoreId: 'store',
  commandId: 'mode',
  mode: 'ask',
  ifRevision: large,
  makeDefault: true,
  ifDefaultRevision: '0',
};
const applied: PermissionMutation = {
  commandId: 'mode',
  kind: 'permission.mode',
  state: 'applied',
  receipt: {
    status: 'applied',
    mode: 'ask',
    revision: '9007199254740994',
    makeDefault: true,
    defaultRevision: '9007199254740994',
  },
};
const initial = {
  storeId: 'store',
  sessionId: 's',
  scopeSessionId: 's',
  mode: 'auto',
  revision: large,
  defaultMode: 'auto',
  defaultRevision: '0',
};
async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (caught) {
    error = caught;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const requests: { path: string; method: string; body?: unknown }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push({
        path: url.pathname,
        method: request.method,
        ...(request.method === 'POST' ? { body: await request.clone().json() } : {}),
      });
      return handler(request);
    },
  });
  const client = createClient({ endpoint: server.url.href, token: 'fixture-token', expected });
  return {
    client,
    requests,
    close: () => {
      client.disposeNetwork();
      server.stop(true);
    },
  };
}

test('permission operations need admission/capability/original Store and validate closed choices before business network', async () => {
  const f = fixture(() => Response.json({ ...identity, capabilities: ['sessions'] }));
  try {
    await rejected(
      f.client.getPermissionMode('s', { storeId: 'store' }),
      'connection_not_admitted',
    );
    await rejected(f.client.setPermissionMode('s', choice), 'connection_not_admitted');
    expect(f.requests).toHaveLength(0);
    await f.client.connect();
    await rejected(f.client.getWorkspaceTrust('w', { storeId: 'store' }), 'capability_unavailable');
    expect(f.requests).toHaveLength(1);
  } finally {
    f.close();
  }
  const supported = fixture(() => Response.json(identity));
  try {
    await supported.client.connect();
    await rejected(
      supported.client.setPermissionMode('s', { ...choice, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await rejected(
      supported.client.setPermissionMode('s', { ...choice, ifRevision: '9223372036854775808' }),
      'invalid_request',
    );
    await rejected(
      supported.client.setPermissionMode('s', {
        ...choice,
        allowed: true,
      } as SetPermissionModeRequest),
      'invalid_request',
    );
    expect(supported.requests).toHaveLength(1);
  } finally {
    supported.close();
  }
});

test('permission reads keep decimal64 and additive facts; writes seal the exact user choice and send it once', async () => {
  let probe = 0,
    entered!: () => void,
    release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/v1/server') {
      if (++probe === 5) {
        entered();
        await held;
      }
      return Response.json(identity);
    }
    if (path.endsWith('/permission-mode') && request.method === 'GET')
      return Response.json({ ...initial, future: { retained: true } });
    if (request.method === 'POST') return Response.json(applied);
    if (path.endsWith('/mode')) return Response.json(applied);
    throw Error('unexpected_permission_path');
  });
  try {
    await f.client.connect();
    const mode = await f.client.getPermissionMode('s', { storeId: 'store' });
    expect(mode.revision).toBe(large);
    expect((mode as typeof mode & { future: unknown }).future).toEqual({ retained: true });
    // The next identity probe after connect+read's two probes is #4; pause a write before its body.
    probe = 4;
    const input = structuredClone(choice);
    const result = f.client.setPermissionMode('s', input);
    await waiting;
    input.commandId = 'mutated';
    input.mode = 'full';
    input.expectedStoreId = 'foreign';
    release();
    expect(await result).toEqual(applied);
    expect(f.requests.filter((r) => r.method === 'POST')).toEqual([
      { path: '/v1/sessions/s/permission-mode', method: 'POST', body: choice },
    ]);
    expect(await f.client.getPermissionMutation('mode', { storeId: 'store' })).toEqual(applied);
  } finally {
    release();
    f.close();
  }
});

test('wrong scope, contradictory trust, malformed terminal receipt and changed admitted identity never publish permission facts', async () => {
  let value: unknown = { ...initial, sessionId: 'other' },
    current = identity;
  const f = fixture((request) =>
    Response.json(new URL(request.url).pathname === '/v1/server' ? current : value),
  );
  try {
    await f.client.connect();
    await rejected(
      f.client.getPermissionMode('s', { storeId: 'store' }),
      'permission_scope_mismatch',
    );
    value = {
      storeId: 'store',
      workspaceId: 'w',
      status: 'untrusted',
      trusted: true,
      revision: '0',
      canonicalIdentity: 'a'.repeat(64),
      externalReadScopeDigest: 'b'.repeat(64),
      readScopes: [{ kind: 'workspace', description: 'Observed scope' }],
    };
    await rejected(f.client.getWorkspaceTrust('w', { storeId: 'store' }), 'invalid_response');
    value = { ...applied, commandId: 'other' };
    await rejected(f.client.setPermissionMode('s', choice), 'permission_scope_mismatch');
    value = { ...applied, receipt: { ...applied.receipt, revision: '9223372036854775808' } };
    await rejected(
      f.client.getPermissionMutation('mode', { storeId: 'store' }),
      'invalid_response',
    );
    value = { ...applied, receipt: { status: 'failed', code: 'forged' } };
    await rejected(
      f.client.getPermissionMutation('mode', { storeId: 'store' }),
      'invalid_response',
    );
    current = { ...identity, storeId: 'replacement' };
    const before = f.requests.filter((r) => !r.path.endsWith('/server')).length;
    await rejected(
      f.client.getPermissionMode('s', { storeId: 'store' }),
      'store_identity_mismatch',
    );
    expect(f.requests.filter((r) => !r.path.endsWith('/server'))).toHaveLength(before);
  } finally {
    f.close();
  }
});

test('a physically lost write response is never retried; original command lookup returns the one committed receipt', async () => {
  const sockets = new Set<Socket>(),
    posts: unknown[] = [];
  let saved: PermissionMutation | undefined;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    if (path === '/v1/server') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(identity));
      return;
    }
    if (request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      posts.push(JSON.parse(Buffer.concat(chunks).toString()));
      saved = applied;
      response.destroy();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(saved));
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('fixture_address_invalid');
  const client = createClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    token: 'fixture-token',
    expected,
  });
  try {
    await client.connect();
    await rejected(client.setPermissionMode('s', choice), 'network_outcome_unknown');
    expect(posts).toEqual([choice]);
    expect(await client.getPermissionMutation('mode', { storeId: 'store' })).toEqual(applied);
    expect(posts).toHaveLength(1);
  } finally {
    client.disposeNetwork();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
