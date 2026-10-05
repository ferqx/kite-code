import { expect, test } from 'bun:test';
import { type CompressContextRequest, createClient, validateRequest } from '../../src';
import { createBrowserClient } from '../../src/browser';

test('compression SDK seals full original intent, rejects hidden authority before POST and only queries an unverifiable receipt by its original ID', async () => {
  const profile = { dataRoot: '/selected', name: 'new', accessKey: 'owned' };
  let capabilities: string[] = [],
    posts = 0,
    lookups = 0,
    tamper = '';
  const received: unknown[] = [],
    saved = new Map<string, object>();
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/server')
        return Response.json({
          instanceId: 'owned',
          buildId: 'owned',
          apiMajor: 1,
          capabilities,
          profile,
          storeId: 'store',
          dataAvailability: 'available',
        });
      if (request.method === 'GET') {
        lookups++;
        return Response.json(saved.get(path.split('/').at(-1)!));
      }
      posts++;
      const body = (await request.json()) as CompressContextRequest;
      received.push(body);
      const command = {
        id: body.commandId,
        sessionId: 's',
        originStoreId: 'store',
        kind: path.endsWith('/reset') ? 'context.compression.reset' : 'context.compress',
        status: 'accepted',
        receipt: null,
        cancelRequestedAt: null,
        futureReceipt: { preserved: true },
      };
      saved.set(command.id, command);
      return Response.json(
        tamper ? { ...command, [tamper]: tamper === 'status' ? 'succeeded' : 'other' } : command,
        { status: 202 },
      );
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const failed = async (work: Promise<unknown>, code: string) => {
    const error = await work.catch((error: unknown) => error);
    expect((error as { code: string }).code).toBe(code);
  };
  const focus = `${'Complete focus '.repeat(1000)}ORIGINAL_FOCUS_TAIL`,
    intent: CompressContextRequest = {
      expectedStoreId: 'store',
      commandId: 'original',
      expectedContextSelectionId: 'selection',
      focus,
    };
  try {
    expect(() => validateRequest('CompressContextRequest', intent)).not.toThrow();
    expect(() =>
      validateRequest('CompressContextRequest', { ...intent, subjectId: 'self-claimed' }),
    ).toThrow('Invalid CompressContextRequest');
    await failed(client.compressContext('s', intent), 'connection_not_admitted');
    await client.connect();
    await failed(client.compressContext('s', intent), 'capability_unavailable');
    expect(posts).toBe(0);
    capabilities = ['context', 'commands'];
    await client.connect();
    await failed(
      client.compressContext('s', { ...intent, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    await failed(
      client.compressContext('s', { ...intent, automatic: true } as CompressContextRequest),
      'invalid_request',
    );
    await failed(
      client.resetCompressionContext('s', {
        expectedStoreId: 'store',
        commandId: 'reset',
        expectedContextSelectionId: 'selection',
      } as Parameters<typeof client.resetCompressionContext>[1]),
      'invalid_request',
    );
    expect(posts).toBe(0);
    const pending = client.compressContext('s', intent);
    intent.focus = 'Changed caller alias';
    const accepted = await pending;
    expect(received[0]).toEqual({ ...intent, focus });
    expect(accepted.status).toBe('accepted');
    expect((accepted as typeof accepted & { futureReceipt: unknown }).futureReceipt).toEqual({
      preserved: true,
    });
    expect(
      (
        await client.resetCompressionContext('s', {
          expectedStoreId: 'store',
          commandId: 'reset',
          expectedContextSelectionId: 'selection',
          expectedCompressionId: null,
        })
      ).kind,
    ).toBe('context.compression.reset');
    for (const field of ['id', 'sessionId', 'originStoreId', 'kind', 'status']) {
      tamper = field;
      const commandId = `original-${field}`;
      await failed(
        client.compressContext('s', { ...intent, commandId }),
        'network_outcome_unknown',
      );
      expect(posts).toBe(3 + lookups);
      const original = await client.getCommand(commandId);
      expect(original).toMatchObject({
        id: commandId,
        originStoreId: 'store',
        sessionId: 's',
        kind: 'context.compress',
        status: 'accepted',
      });
      expect(posts).toBe(2 + lookups);
    }
    expect(lookups).toBe(5);
    expect(posts).toBe(7);
  } finally {
    client.disposeNetwork();
    server.stop(true);
  }
});

test('Native and Cookie Context readers preserve original compression provenance and reject uncommitted, foreign-selection and overflowing publication facts', async () => {
  const profile = { dataRoot: '/selected', name: 'new', accessKey: 'owned' },
    identity = 'b'.repeat(64),
    compression = {
      id: 'compression',
      originSessionId: 'original-session',
      originCompressionId: 'original-compression',
      sessionId: 's',
      contextSelectionId: 'selection',
      originStoreId: 'before-restore-store',
      modelExecutionId: 'model',
      runId: 'run',
      coveredThroughSeq: '9007199254740993',
      publishedSeq: '9007199254740994',
      previousCompressionId: null,
      compressor: { id: 'algorithm', version: '1', snapshot: {} },
      trigger: 'manual' as const,
      futureFact: { preserved: true },
    };
  let patch: Partial<typeof compression> = {},
    posts = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== 'GET') posts++;
      const response = (body: unknown) =>
        Response.json(body, { headers: { 'x-kite-web-identity': identity } });
      if (path === '/v1/server')
        return response({
          instanceId: 'owned',
          buildId: 'owned',
          apiMajor: 1,
          capabilities: ['context'],
          profile,
          storeId: 'current-store',
          dataAvailability: 'available',
        });
      if (path === '/browser/v1/server')
        return response({
          pageIdentity: identity,
          instanceId: 'owned',
          buildId: 'owned',
          capabilities: ['context'],
          storeId: 'current-store',
          dataAvailability: 'available',
        });
      return response({
        selection: {
          id: 'selection',
          sessionId: 's',
          previousSelectionId: null,
          boundaryMessageId: null,
          boundarySeq: '0',
          tailFromSeq: '0',
          ranges: [],
        },
        compression: { ...compression, ...patch },
        highWaterSeq: '9007199254740995',
        messages: [],
        resultSources: [],
        nextAfterSeq: null,
        nextAfterSourceId: null,
        snapshotCursor: '9007199254740996',
      });
    },
  });
  const native = createClient({
      endpoint: server.url.href,
      token: 'private',
      expected: { profile, apiMajor: 1, requiredCapabilities: ['context'] },
    }),
    browser = createBrowserClient({ origin: server.url.origin, pageIdentity: identity });
  try {
    await native.connect();
    await browser.connect();
    const readers = [
      () => native.getContext('s', { storeId: 'current-store' }),
      () => browser.getContext('s'),
    ];
    for (const read of readers) {
      expect((await read()).compression).toEqual(compression);
      for (const invalid of [
        { sessionId: 'other' },
        { contextSelectionId: 'other' },
        { publishedSeq: '0' },
        { publishedSeq: '9007199254740993' },
        { publishedSeq: '9007199254740996' },
        { coveredThroughSeq: '9223372036854775808' },
      ]) {
        patch = invalid;
        const error = await read().catch((error: unknown) => error);
        expect((error as { code?: string }).code).toBe('invalid_compression_response');
      }
      patch = {};
    }
    expect(native.lastAppliedCursor).toBeUndefined();
    expect(posts).toBe(0);
  } finally {
    native.disposeNetwork();
    browser.disposeNetwork();
    server.stop(true);
  }
});
