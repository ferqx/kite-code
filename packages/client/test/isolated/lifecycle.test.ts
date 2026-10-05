import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { createServiceLifecycleClient, type ServiceLifecycle } from '../../src';

const profile = { dataRoot: '/private-fixture', name: 'new', accessKey: 'fixed' };
function status(): ServiceLifecycle {
  return {
    lifecycleVersion: 1,
    profile,
    instanceId: 'original',
    buildId: 'older-build',
    apiMajor: 2,
    capabilities: [],
    dataAvailability: 'unavailable',
    state: 'accepting',
    busy: false,
    reasons: [],
  };
}

test('lifecycle status and one shutdown use original identity independently of business compatibility', async () => {
  const methods: string[] = [];
  let observed: unknown;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      methods.push(`${request.method} ${new URL(request.url).pathname}`);
      expect(request.headers.get('authorization')).toBe('Bearer private');
      expect(request.headers.get('origin')).toBeNull();
      expect(request.headers.get('cookie')).toBeNull();
      if (request.method === 'GET') return Response.json(status());
      observed = await request.json();
      return Response.json(
        { lifecycleVersion: 1, accepted: true, lifecycle: { ...status(), state: 'draining' } },
        { status: 202 },
      );
    },
  });
  const expected = { profile: { ...profile }, instanceId: 'original' };
  const client = createServiceLifecycleClient({
    endpoint: server.url.href,
    token: 'private',
    expected,
  });
  expected.instanceId = 'replacement';
  expected.profile.name = 'other';
  try {
    expect((await client.getStatus()).apiMajor).toBe(2);
    expect((await client.shutdown('if_idle')).accepted).toBe(true);
    expect(observed).toEqual({
      lifecycleVersion: 1,
      expectedProfile: profile,
      expectedInstanceId: 'original',
      mode: 'if_idle',
    });
    expect(methods).toEqual([
      'GET /v1/lifecycle',
      'GET /v1/lifecycle',
      'POST /v1/lifecycle/shutdown',
    ]);
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
});

test('identity, lifecycle version and invalid status reject before POST; busy remains an explicit failed request', async () => {
  let value: unknown = status();
  let posts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (request.method === 'GET') return Response.json(value);
      posts++;
      return Response.json(
        {
          code: 'lifecycle_busy',
          message: 'busy',
          scope: 'service',
          requestId: 'request',
          retryable: false,
        },
        { status: 409 },
      );
    },
  });
  const client = createServiceLifecycleClient({
    endpoint: server.url.href,
    token: 'private',
    expected: { profile, instanceId: 'original' },
  });
  try {
    for (const invalid of [
      { ...status(), instanceId: 'replacement' },
      { ...status(), profile: { ...profile, accessKey: 'foreign' } },
      { ...status(), profile: { ...profile, dataRoot: '/another-root' } },
      { ...status(), lifecycleVersion: 2 },
      { ...status(), busy: true },
      { ...status(), busy: true, reasons: ['cleanup', 'cleanup'] },
    ]) {
      value = invalid;
      await expect(client.shutdown('cancel')).rejects.toBeDefined();
    }
    expect(posts).toBe(0);
    value = status();
    await expect(client.shutdown('if_idle')).rejects.toMatchObject({
      code: 'lifecycle_busy',
      status: 409,
    });
    expect(posts).toBe(1);
    expect((await client.getStatus()).state).toBe('accepting');
    expect(posts).toBe(1);
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
});

test('physical response loss does not retry shutdown or rebind a replacement instance', async () => {
  let posts = 0;
  let reads = 0;
  let current = status();
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      posts++;
      request.resume();
      current = { ...current, state: 'draining' };
      request.socket.destroy();
      return;
    }
    reads++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(current));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing fixture address');
  const client = createServiceLifecycleClient({
    endpoint: `http://127.0.0.1:${address.port}`,
    token: 'private',
    expected: { profile, instanceId: 'original' },
  });
  try {
    await expect(client.shutdown('cancel')).rejects.toMatchObject({
      code: 'network_outcome_unknown',
    });
    expect(posts).toBe(1);
    expect(reads).toBe(1);
    expect((await client.getStatus()).state).toBe('draining');
    current = { ...status(), instanceId: 'replacement' };
    await expect(client.getStatus()).rejects.toMatchObject({ code: 'lifecycle_identity_mismatch' });
    expect(posts).toBe(1);
    expect(reads).toBe(3);
  } finally {
    client.disposeNetwork();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

test('network release while lifecycle admission waits cannot issue shutdown; oversized status stays local', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let large = false;
  let posts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (request.method === 'POST') posts++;
      if (large) return Response.json({ ...status(), padding: 'x'.repeat(70 * 1024) });
      entered();
      await gate;
      return Response.json(status());
    },
  });
  const client = createServiceLifecycleClient({
    endpoint: server.url.href,
    token: 'private',
    expected: { profile, instanceId: 'original' },
  });
  try {
    const pending = client.shutdown('cancel');
    const rejected = pending.then(
      () => false,
      () => true,
    );
    await active;
    client.disposeNetwork();
    release();
    expect(await rejected).toBe(true);
    expect(posts).toBe(0);
    large = true;
    await expect(client.getStatus()).rejects.toMatchObject({ code: 'response_too_large' });
    expect(posts).toBe(0);
  } finally {
    release();
    client.disposeNetwork();
    await server.stop(true);
  }
});

test('invalid accepted shutdown receipt stays unknown and never triggers an automatic query or retry', async () => {
  for (const lifecycle of [
    status(),
    { ...status(), state: 'draining', instanceId: 'replacement' },
    { ...status(), state: 'draining', profile: { ...profile, name: 'other' } },
  ]) {
    let posts = 0;
    let reads = 0;
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        if (request.method === 'GET') {
          reads++;
          return Response.json(status());
        }
        posts++;
        return Response.json({ lifecycleVersion: 1, accepted: true, lifecycle }, { status: 202 });
      },
    });
    const client = createServiceLifecycleClient({
      endpoint: server.url.href,
      token: 'private',
      expected: { profile, instanceId: 'original' },
    });
    try {
      await expect(client.shutdown('cancel')).rejects.toMatchObject({
        code: 'network_outcome_unknown',
      });
      expect(posts).toBe(1);
      expect(reads).toBe(1);
      expect((await client.getStatus()).instanceId).toBe('original');
      expect(posts).toBe(1);
      expect(reads).toBe(2);
    } finally {
      client.disposeNetwork();
      await server.stop(true);
    }
  }
});
