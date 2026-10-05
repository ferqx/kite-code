import { expect, test } from 'bun:test';
import { createClient, type IncludeResultRequest, type SelectContextRequest } from '../src';

test('context SDK admits before business, validates bounded closed requests and preserves original selection/Store/revision and future source fields', async () => {
  const profile = { dataRoot: '/selected', name: 'new', accessKey: 'selected-key' };
  let capabilities: string[] = [];
  let requests = 0;
  const writes: unknown[] = [];
  let search = '';
  const selection = {
    id: 'original-selection',
    sessionId: 's',
    previousSelectionId: null,
    boundaryMessageId: null,
    boundarySeq: '0',
    tailFromSeq: '0',
    ranges: [],
  };
  const source = {
    id: 'original-source',
    seq: '9007199254740993',
    sessionId: 's',
    createdSelectionId: selection.id,
    executionId: 'original-execution',
    resultRevision: '9007199254740995',
    originStoreId: 'original-store',
    inclusion: 'explicit' as const,
    result: { content: 'saved result', future: { preserved: true } },
    futureMetadata: 'retained',
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      requests++;
      const url = new URL(request.url);
      if (url.pathname === '/v1/server')
        return Response.json({
          instanceId: 'fixture',
          buildId: 'fixture',
          apiMajor: 1,
          capabilities,
          profile,
          dataAvailability: 'available',
          storeId: 'different-current-store',
        });
      if (request.method === 'GET') {
        search = url.search;
        return Response.json({
          selection,
          highWaterSeq: '9007199254740997',
          messages: [],
          resultSources: [source],
          nextAfterSeq: null,
          nextAfterSourceId: source.id,
          snapshotCursor: '9007199254740999',
          futurePage: true,
        });
      }
      const body = (await request.json()) as SelectContextRequest | IncludeResultRequest;
      writes.push(body);
      const command = {
        id: body.commandId,
        sessionId: 's',
        kind: 'context.select',
        status: 'applied',
        receipt: { outcome: 'fixture' },
        originStoreId: body.expectedStoreId,
        cancelRequestedAt: null,
      };
      return Response.json({
        command,
        ...(url.pathname.endsWith('/include') ? { source } : { selection }),
      });
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private-only-header',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const select: SelectContextRequest = {
    expectedStoreId: 'original-store',
    commandId: 'original-rewind',
    expectedContextSelectionId: selection.id,
    boundary: { messageId: 'original-message', seq: '9007199254740993' },
  };
  const include: IncludeResultRequest = {
    expectedStoreId: 'original-store',
    commandId: 'original-include',
    expectedContextSelectionId: selection.id,
    resultRevision: source.resultRevision,
  };
  const operations = [
    () => client.getContext('s', { storeId: 'original-store' }),
    () => client.rewind('s', select),
    () => client.includeResult('s', source.executionId, include),
  ];
  try {
    for (const operation of operations) expect(operation).toThrow('connection_not_admitted');
    expect(requests).toBe(0);
    await client.connect();
    for (const operation of operations) expect(operation).toThrow('capability_unavailable');
    expect(requests).toBe(1);
    capabilities = ['context'];
    await client.connect();
    expect(() =>
      client.rewind('s', { ...select, subjectId: 'forged' } as unknown as SelectContextRequest),
    ).toThrow('Invalid SelectContextRequest');
    expect(() =>
      client.rewind('s', { ...select, boundary: { messageId: 'm', seq: '9223372036854775808' } }),
    ).toThrow('signed SQLite 64-bit range');
    expect(() =>
      client.includeResult('s', source.executionId, {
        ...include,
        resultRevision: '9223372036854775808',
      }),
    ).toThrow('signed SQLite 64-bit range');
    expect(() => client.getContext('s', { storeId: 'original-store', sourceLimit: 101 })).toThrow(
      'Invalid ContextQuery',
    );
    expect(() => client.getContext('s', { storeId: 'original-store', byteLimit: 8388609 })).toThrow(
      'Invalid ContextQuery',
    );
    expect(requests).toBe(2);
    expect((await client.rewind('s', select)).command.originStoreId).toBe('original-store');
    expect((await client.includeResult('s', source.executionId, include)).source).toEqual(source);
    expect(writes).toEqual([select, include]);
    const page = await client.getContext('s', {
      storeId: 'original-store',
      contextSelectionId: selection.id,
      afterSeq: '9007199254740993',
      upperSeq: '9007199254740997',
      afterSourceId: source.id,
      messageLimit: 200,
      sourceLimit: 100,
      byteLimit: 8388608,
    });
    expect(search).toContain('afterSeq=9007199254740993');
    expect(page.highWaterSeq).toBe('9007199254740997');
    expect(page.resultSources[0]).toEqual(source);
    expect(page.nextAfterSourceId).toBe(source.id);
    expect(client.lastAppliedCursor).toBeUndefined();
    expect(select.expectedContextSelectionId).toBe(selection.id);
    expect(include.resultRevision).toBe(source.resultRevision);
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
});
