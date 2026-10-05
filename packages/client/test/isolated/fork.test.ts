import { expect, test } from 'bun:test';
import { createClient, type ForkSessionRequest } from '../../src';

test('Fork SDK seals the explicit source/new Session and selection, rejects local authority/cursor drift, and treats an unverifiable committed receipt as unknown', async () => {
  const profile = { dataRoot: '/selected', name: 'new', accessKey: 'fixed' };
  let capabilities: string[] = [],
    posts = 0,
    business = 0,
    badReceipt = false,
    badReport = false;
  const original: ForkSessionRequest = {
    expectedStoreId: 'original-store',
    commandId: 'fork-original',
    expectedContextSelectionId: 'source-selection',
    newSessionId: 'branch',
    title: 'original title',
  };
  const received: ForkSessionRequest[] = [];
  const namespaceReport = [
    {
      extensionId: 'fixture',
      contentType: 'fixture.private',
      contentVersion: 1,
      mode: 'omit' as const,
      ruleVersion: null,
      copied: 0,
      rebuilt: 0,
      omitted: 1,
    },
  ];
  const receipt = {
    sessionId: 'branch',
    selectionId: 'branch-selection',
    sourceSessionId: 'source',
    sourceSelectionId: 'source-selection',
    sourceUpperSeq: '9007199254740993',
    omittedExtensionState: true,
    namespaceReport,
  };
  const command = {
    id: original.commandId,
    sessionId: 'branch',
    kind: 'session.create',
    status: 'applied',
    originStoreId: original.expectedStoreId,
    cancelRequestedAt: null,
    receipt,
  };
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/server')
        return Response.json({
          instanceId: 'fixed',
          buildId: 'fixed',
          apiMajor: 1,
          capabilities,
          profile,
          dataAvailability: 'available',
          storeId: 'original-store',
        });
      business++;
      if (request.method === 'GET') return Response.json(command);
      posts++;
      const body = (await request.json()) as ForkSessionRequest;
      received.push(body);
      return Response.json({
        command: {
          ...command,
          receipt: { ...receipt, sourceSessionId: badReceipt ? 'other-source' : 'source' },
        },
        session: {
          id: 'branch',
          workspaceId: 'w',
          parentSessionId: null,
          rootSessionId: 'branch',
          title: body.title,
          controlRevision: '0',
          contextSelectionId: 'branch-selection',
          nextSeq: receipt.sourceUpperSeq,
          deletedAt: null,
        },
        selection: {
          id: 'branch-selection',
          sessionId: 'branch',
          previousSelectionId: null,
          boundaryMessageId: null,
          boundarySeq: receipt.sourceUpperSeq,
          tailFromSeq: receipt.sourceUpperSeq,
          ranges: [{ afterSeq: '0', throughSeq: receipt.sourceUpperSeq }],
        },
        omittedExtensionState: true,
        namespaceReport: badReport ? [{ ...namespaceReport[0]!, omitted: 2 }] : namespaceReport,
        futureField: { preserved: true },
      });
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const failure = async (work: Promise<unknown>, code: string) => {
    let error: unknown;
    try {
      await work;
    } catch (caught) {
      error = caught;
    }
    expect((error as { code: string }).code).toBe(code);
  };
  try {
    await failure(client.forkSession('source', original), 'connection_not_admitted');
    await client.connect();
    await failure(client.forkSession('source', original), 'capability_unavailable');
    expect(business).toBe(0);
    capabilities = ['context', 'sessions', 'commands'];
    await client.connect();
    await failure(
      client.forkSession('source', { ...original, expectedStoreId: 'foreign' }),
      'store_identity_mismatch',
    );
    const invalidBoundary = await client
      .forkSession('source', {
        ...original,
        boundary: { messageId: 'm', seq: '9223372036854775808' },
      })
      .catch((error: unknown) => error);
    expect(invalidBoundary).toBeInstanceOf(RangeError);
    await failure(
      client.forkSession('source', { ...original, subjectId: 'untrusted' } as ForkSessionRequest),
      'invalid_request',
    );
    expect(posts).toBe(0);
    const pending = client.forkSession('source', original);
    original.title = 'changed alias';
    const applied = await pending;
    expect(received[0]!.title).toBe('original title');
    expect(applied.session.title).toBe('original title');
    expect(applied.selection.boundarySeq).toBe('9007199254740993');
    expect(applied.namespaceReport).toEqual(namespaceReport);
    expect((applied as typeof applied & { futureField: unknown }).futureField).toEqual({
      preserved: true,
    });
    await failure(
      client.forkSession('source', { ...original, title: 'original title', boundary: null }),
      'network_outcome_unknown',
    );
    expect(posts).toBe(2);
    badReceipt = true;
    await failure(
      client.forkSession('source', { ...original, title: 'original title' }),
      'network_outcome_unknown',
    );
    expect(posts).toBe(3);
    badReceipt = false;
    badReport = true;
    await failure(
      client.forkSession('source', { ...original, title: 'original title' }),
      'network_outcome_unknown',
    );
    expect(posts).toBe(4);
    expect((await client.getCommand(original.commandId)).receipt).toEqual(receipt);
    expect(posts).toBe(4);
  } finally {
    client.disposeNetwork();
    server.stop(true);
  }
});
