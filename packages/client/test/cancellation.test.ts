import { expect, test } from 'bun:test';
import {
  type CancelExecutionRequest,
  type CancelRunRequest,
  type CancelSessionRequest,
  createClient,
  type ServerInfo,
} from '../src';

const profile = { dataRoot: '/fixture', name: 'fixture', accessKey: 'fixture-key' };
const identity: ServerInfo = {
  profile,
  instanceId: 'instance',
  buildId: 'build',
  apiMajor: 1,
  capabilities: ['commands'],
  dataAvailability: 'available',
  storeId: 'store-a',
};
function fixture() {
  let info = identity;
  let output: unknown = { items: [], highWaterSeq: '0' };
  const posts: unknown[] = [];
  const urls: URL[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      expect(request.headers.get('authorization')).toBe('Bearer private-token');
      const url = new URL(request.url);
      urls.push(url);
      if (url.pathname === '/v1/server') return Response.json(info);
      if (request.method === 'POST') {
        const body = (await request.json()) as {
          expectedStoreId: string;
          commandId: string;
          kind: string;
        };
        posts.push(body);
        if (body.expectedStoreId !== info.storeId)
          return Response.json(
            {
              code: 'store_identity_mismatch',
              message: 'store_identity_mismatch',
              scope: 'request',
              requestId: 'fixture',
              retryable: false,
            },
            { status: 409 },
          );
        return Response.json(
          {
            id: body.commandId,
            sessionId: 's',
            kind: body.kind,
            status: 'accepted',
            receipt: { pending: true },
            originStoreId: info.storeId,
            cancelRequestedAt: null,
          },
          { status: 202 },
        );
      }
      return Response.json(output);
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private-token',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['commands'] },
  });
  return {
    client,
    posts,
    urls,
    setInfo(value: ServerInfo) {
      info = value;
    },
    setOutput(value: unknown) {
      output = value;
    },
    close() {
      client.disposeNetwork();
      server.stop(true);
    },
  };
}

test('named cancellation methods preserve original target, Store and command identity; receipt is only accepted', async () => {
  const f = fixture();
  try {
    const run: CancelRunRequest = {
      expectedStoreId: 'store-a',
      commandId: 'cancel-run',
      kind: 'run.cancel',
      runId: 'original-run',
    };
    expect(() => f.client.cancelRun('s', run)).toThrow('connection_not_admitted');
    expect(f.urls).toHaveLength(0);
    await f.client.connect();
    const execution: CancelExecutionRequest = {
      expectedStoreId: 'store-a',
      commandId: 'cancel-execution',
      kind: 'execution.cancel',
      executionId: 'original-execution',
    };
    const session: CancelSessionRequest = {
      expectedStoreId: 'store-a',
      commandId: 'cancel-session',
      kind: 'session.cancel',
      includeBackground: false,
    };
    for (const receipt of [
      await f.client.cancelRun('s', run),
      await f.client.cancelExecution('s', execution),
      await f.client.cancelSession('s', session),
    ]) {
      expect(receipt.status).toBe('accepted');
      expect(receipt.receipt).toEqual({ pending: true });
    }
    expect(f.posts).toEqual([run, execution, session]);
    f.setInfo({ ...identity, storeId: 'store-b' });
    await f.client.connect();
    await expect(f.client.cancelRun('s', run)).rejects.toMatchObject({
      code: 'store_identity_mismatch',
    });
    await expect(f.client.cancelRun('s', run)).rejects.toMatchObject({
      code: 'store_identity_mismatch',
    });
    expect(f.posts.slice(3)).toEqual([run, run]);
    expect(f.posts).toHaveLength(5); // exactly caller invocations; SDK never retries/rebinds.
  } finally {
    f.close();
  }
});

test('cancel requests are closed schema and invalid inputs make no business request', async () => {
  const f = fixture();
  try {
    await f.client.connect();
    expect(() =>
      f.client.cancelRun('s', {
        expectedStoreId: 'store-a',
        commandId: 'c',
        kind: 'run.cancel',
      } as CancelRunRequest),
    ).toThrow(/^Invalid .* request/);
    expect(() =>
      f.client.cancelExecution('s', {
        expectedStoreId: 'store-a',
        commandId: 'c',
        kind: 'execution.cancel',
        executionId: 'e',
        future: true,
      } as CancelExecutionRequest),
    ).toThrow(/^Invalid .* request/);
    expect(() =>
      f.client.cancelSession('s', {
        expectedStoreId: 'store-a',
        commandId: 'c',
        kind: 'session.cancel',
        includeBackground: 'false',
      } as unknown as CancelSessionRequest),
    ).toThrow(/^Invalid .* request/);
    expect(f.posts).toHaveLength(0);
    expect(f.urls).toHaveLength(1);
  } finally {
    f.close();
  }
});

test('output page preserves Decimal64 interval, clipped gap null and additive fields', async () => {
  const f = fixture();
  const page = {
    items: [
      {
        executionId: 'e-a',
        seq: '9007199254740993',
        throughSeq: '9007199254740995',
        stream: 'stdout' as const,
        content: '',
        droppedBytes: null,
        future: { detail: true },
      },
    ],
    highWaterSeq: '9007199254740999',
    futurePage: true,
  };
  try {
    expect(() => f.client.listExecutionOutput('e')).toThrow('connection_not_admitted');
    await f.client.connect();
    f.setOutput(page);
    expect(
      await f.client.listExecutionOutput('e/a', {
        afterSeq: '9007199254740992',
        upperSeq: '9007199254740998',
        limit: 200,
      }),
    ).toEqual(page);
    const url = f.urls.at(-1)!;
    expect(url.pathname).toBe('/v1/executions/e%2Fa/output');
    expect(url.searchParams.get('afterSeq')).toBe('9007199254740992');
    expect(url.searchParams.get('upperSeq')).toBe('9007199254740998');
    expect(f.client.lastAppliedCursor).toBeUndefined();
    const count = f.urls.length;
    for (const options of [
      { afterSeq: '01' },
      { afterSeq: '-1' },
      { upperSeq: '9223372036854775808' },
      { afterSeq: '3', upperSeq: '2' },
      { limit: 201 },
      { limit: 0 },
      { limit: 1.5 },
    ])
      expect(() => f.client.listExecutionOutput('e', options)).toThrow();
    expect(f.urls).toHaveLength(count);
    f.setOutput({
      ...page,
      items: [{ ...page.items[0], droppedBytes: Number('9007199254740993') }],
    });
    await expect(f.client.listExecutionOutput('e')).rejects.toMatchObject({
      code: 'invalid_response',
    });
    f.setOutput({ ...page, items: [{ ...page.items[0], throughSeq: 'invalid' }] });
    await expect(f.client.listExecutionOutput('e')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  } finally {
    f.close();
  }
});
