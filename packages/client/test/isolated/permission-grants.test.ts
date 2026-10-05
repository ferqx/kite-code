import { expect, test } from 'bun:test';
import {
  type ClearPermissionGrantsRequest,
  createClient,
  type PermissionGrantPage,
  type PermissionMutation,
  type ServerInfo,
} from '../../src';

const profile = { dataRoot: '/chosen/grants', name: 'new', accessKey: 'fixture-key' };
const identity: ServerInfo = {
  profile,
  instanceId: 'instance',
  buildId: 'grants',
  apiMajor: 1,
  capabilities: ['sessions', 'permission_controls', 'permission_grants'],
  dataAvailability: 'available',
  storeId: 'store',
};
const revision = '9007199254740993';
const items = Array.from({ length: 202 }, (_, index) => ({
  seq: String(index + 1),
  grant: {
    id: `interaction-${index}`,
    originStoreId: 'store',
    sessionId: 's',
    workspaceId: 'w',
    kind: 'tool' as const,
    definitionId: 'fixture.command',
    definitionVersion: '1',
    inputDigest: 'a'.repeat(64),
    commandDigest: 'b'.repeat(64),
    interactionId: `interaction-${index}`,
    decisionRevision: revision,
    executionId: `execution-${index}`,
  },
}));
function page(after = '0'): PermissionGrantPage {
  const batch = items.filter((row) => BigInt(row.seq) > BigInt(after)).slice(0, 200);
  return {
    storeId: 'store',
    sessionId: 's',
    revision,
    items: batch,
    upperSeq: '202',
    highWaterSeq: '203',
    nextAfterSeq: batch.at(-1)?.seq === '200' ? '200' : null,
    snapshotCursor: revision,
  };
}
function fixture(read: (request: Request) => Promise<Response> | Response) {
  const requests: { path: string; method: string }[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests.push({
        path: new URL(request.url).pathname + new URL(request.url).search,
        method: request.method,
      });
      if (new URL(request.url).pathname === '/v1/server') return Response.json(identity);
      return read(request);
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'fixture',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['permission_grants'] },
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
async function rejected(work: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await work;
  } catch (value) {
    error = value;
  }
  expect((error as { code?: string })?.code).toBe(code);
}

test('complete grant directory keeps one original epoch and fixed upper through 202 entries without rebinding caller aliases', async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture(async (request) => {
    const query = new URL(request.url).searchParams;
    if (!query.has('afterSeq')) {
      entered();
      await held;
    }
    return Response.json(page(query.get('afterSeq') ?? '0'));
  });
  try {
    await f.client.connect();
    const input = { storeId: 'store' };
    const read = f.client.listAllPermissionGrants('s', input);
    await waiting;
    input.storeId = 'replacement';
    release();
    expect(await read).toEqual(items);
    const pages = f.requests.filter((row) => row.path.includes('/permission-grants'));
    expect(pages).toHaveLength(2);
    expect(pages.every((row) => row.method === 'GET')).toBe(true);
    const last = new URL(pages[1]!.path, 'http://fixture');
    expect(Object.fromEntries(last.searchParams)).toEqual({
      storeId: 'store',
      limit: '200',
      afterSeq: '200',
      upperSeq: '202',
    });
  } finally {
    release();
    f.close();
  }
});

test('epoch drift and malformed original grant scope never publish a partial directory; invalid decimal input sends no business request', async () => {
  let value: PermissionGrantPage | undefined;
  const f = fixture((request) => {
    const after = new URL(request.url).searchParams.get('afterSeq');
    return Response.json(
      value ?? { ...page(after ?? '0'), ...(after ? { revision: '9007199254740994' } : {}) },
    );
  });
  try {
    await f.client.connect();
    await rejected(
      f.client.listAllPermissionGrants('s', { storeId: 'store' }),
      'directory_snapshot_changed',
    );
    const before = f.requests.length;
    await rejected(
      f.client.listPermissionGrants('s', { storeId: 'store', afterSeq: '9223372036854775808' }),
      'invalid_request',
    );
    expect(f.requests).toHaveLength(before);
    value = {
      ...page(),
      items: [{ ...items[0]!, grant: { ...items[0]!.grant, sessionId: 'other' } }],
    };
    await rejected(
      f.client.listPermissionGrants('s', { storeId: 'store' }),
      'permission_scope_mismatch',
    );
    value = { ...page(), snapshotCursor: '9223372036854775808' };
    await rejected(f.client.listPermissionGrants('s', { storeId: 'store' }), 'invalid_response');
  } finally {
    f.close();
  }
});

test('invalid clear receipt after a committed POST is unknown and only the original mutation lookup recovers its exact Session receipt', async () => {
  const original: ClearPermissionGrantsRequest = {
    expectedStoreId: 'store',
    commandId: 'clear',
    ifRevision: revision,
  };
  const applied: PermissionMutation = {
    commandId: 'clear',
    kind: 'permission.grants.clear',
    state: 'applied',
    receipt: { status: 'applied', sessionId: 's', revision: '9007199254740994' },
  };
  const posts: unknown[] = [];
  const f = fixture(async (request) => {
    if (request.method === 'POST') {
      posts.push(await request.json());
      return new Response('{', { headers: { 'content-type': 'application/json' } });
    }
    return Response.json(applied);
  });
  try {
    await f.client.connect();
    await rejected(f.client.clearPermissionGrants('s', original), 'network_outcome_unknown');
    expect(
      await f.client.getPermissionMutation(original.commandId, {
        storeId: original.expectedStoreId,
      }),
    ).toEqual(applied);
    expect(posts).toEqual([original]);
    expect(f.requests.filter((row) => row.method === 'POST')).toHaveLength(1);
  } finally {
    f.close();
  }
});
