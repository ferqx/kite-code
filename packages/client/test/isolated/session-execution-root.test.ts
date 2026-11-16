import { expect, test } from 'bun:test';
import { createClient, type ServerInfo, type SessionExecutionRoot } from '../../src';

const profile = { dataRoot: '/fixture', name: 'root', accessKey: 'fixture' };
const identity: ServerInfo = {
  apiMajor: 1,
  profile,
  instanceId: 'instance',
  buildId: 'root',
  capabilities: ['sessions'],
  dataAvailability: 'available',
  storeId: 'store',
};
const root: SessionExecutionRoot = {
  storeId: 'store',
  sessionId: 's',
  workspaceId: 'w',
  rootUri: 'file:///fixture/selected',
  revision: 'a'.repeat(64),
};
function fixture(read: (request: Request) => Promise<Response> | Response) {
  const requests: Request[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/server') return Response.json(identity);
      requests.push(request);
      return read(request);
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'fixture',
    expected: { apiMajor: 1, profile, requiredCapabilities: ['sessions'] },
  });
  return {
    client,
    requests,
    close() {
      client.disposeNetwork();
      server.stop(true);
    },
  };
}

test('execution root SDK fixes the requested scope before asynchronous reads and performs GET only', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture(async () => {
    entered();
    await held;
    return Response.json(root);
  });
  try {
    await f.client.connect();
    const scope = { storeId: 'store', workspaceId: 'w' };
    const read = f.client.getSessionExecutionRoot('s', scope);
    await waiting;
    scope.storeId = 'other';
    scope.workspaceId = 'other';
    release();
    expect(await read).toEqual(root);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]!.method).toBe('GET');
    expect(new URL(f.requests[0]!.url).pathname).toBe('/v1/sessions/s/execution-root');
    expect(Object.fromEntries(new URL(f.requests[0]!.url).searchParams)).toEqual({
      storeId: 'store',
      workspaceId: 'w',
    });
  } finally {
    release();
    f.close();
  }
});

test('execution root SDK rejects unadmitted reads, wrong scope, malformed revision and invalid query', async () => {
  let value = root;
  const f = fixture(() => Response.json(value));
  const read = () => f.client.getSessionExecutionRoot('s', { storeId: 'store', workspaceId: 'w' });
  try {
    await expect(read()).rejects.toMatchObject({ code: 'connection_not_admitted' });
    expect(f.requests).toHaveLength(0);
    await f.client.connect();
    for (const key of ['storeId', 'sessionId', 'workspaceId'] as const) {
      value = { ...root, [key]: 'other' };
      await expect(read()).rejects.toMatchObject({ code: 'execution_root_scope_mismatch' });
    }
    value = { ...root, revision: 'unverified' };
    await expect(read()).rejects.toMatchObject({ code: 'invalid_response' });
    const before = f.requests.length;
    await expect(
      f.client.getSessionExecutionRoot('s', { storeId: 'other', workspaceId: 'w' }),
    ).rejects.toMatchObject({ code: 'store_identity_mismatch' });
    await expect(
      f.client.getSessionExecutionRoot('s', { storeId: 'store', workspaceId: '' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(f.requests).toHaveLength(before);
  } finally {
    f.close();
  }
});

test('execution root SDK discards an old response after the connection is readmitted', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture(async () => {
    entered();
    await held;
    return Response.json(root);
  });
  try {
    await f.client.connect();
    const read = f.client.getSessionExecutionRoot('s', { storeId: 'store', workspaceId: 'w' });
    const settled = read.then(
      () => ({ accepted: true }),
      (error: unknown) => ({ error }),
    );
    await waiting;
    const connection = f.client.connect();
    release();
    await connection;
    const result = await settled;
    expect(result).not.toHaveProperty('accepted');
    expect(result).toHaveProperty('error');
  } finally {
    release();
    f.close();
  }
});
