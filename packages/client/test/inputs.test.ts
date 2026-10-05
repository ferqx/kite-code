import { expect, test } from 'bun:test';
import { createClient, type FollowUpCommandRequest, type SteerCommandRequest } from '../src';

test('additional input SDK keeps explicit original intent, rejects authority/content/cursor errors and makes zero business calls before admission', async () => {
  let requests = 0;
  let capabilities = ['commands'];
  const writes: unknown[] = [];
  let query = '';
  const profile = { dataRoot: '/selected-disposable', name: 'new', accessKey: 'selected-access' };
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
          storeId: 'current-new-store',
        });
      if (url.pathname.endsWith('/inputs')) {
        query = url.search;
        return Response.json({
          commands: [],
          nextAfterSeq: null,
          snapshotCursor: '9007199254740997',
        });
      }
      const body = (await request.json()) as {
        commandId: string;
        expectedStoreId: string;
        kind: string;
      };
      writes.push(body);
      return Response.json(
        {
          id: body.commandId,
          sessionId: 's',
          kind: body.kind,
          status: 'accepted',
          receipt: null,
          originStoreId: body.expectedStoreId,
          cancelRequestedAt: null,
          future: { retained: true },
        },
        { status: 202 },
      );
    },
  });
  const client = createClient({
    endpoint: server.url.href,
    token: 'private-header-only',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const steer: SteerCommandRequest = {
    expectedStoreId: 'original-store',
    commandId: 'original-steer',
    kind: 'input.steer',
    content: 'exact content\n',
    targetRunId: 'original-run',
    contextSelectionId: 'original-context',
  };
  const follow: FollowUpCommandRequest = {
    expectedStoreId: 'original-store',
    commandId: 'original-follow',
    kind: 'input.follow_up',
    content: 'later content',
    afterRunId: 'original-run',
    contextSelectionId: 'original-context',
  };
  const operations = [
    () => client.steer('s', steer),
    () => client.followUp('s', follow),
    () => client.listPendingInputs('s', { storeId: 'original-store' }),
  ];
  try {
    for (const operation of operations) expect(operation).toThrow('connection_not_admitted');
    expect(requests).toBe(0);
    await client.connect();
    for (const operation of operations) expect(operation).toThrow('capability_unavailable');
    expect(requests).toBe(1);
    capabilities = ['commands', 'inputs'];
    await client.connect();
    expect(() =>
      client.steer('s', {
        ...steer,
        subjectId: 'caller-authority',
      } as unknown as SteerCommandRequest),
    ).toThrow('Invalid SteerCommandRequest');
    expect(() => client.steer('s', { ...steer, content: '   ' })).toThrow('Invalid input content');
    expect(() => client.followUp('s', { ...follow, content: '界'.repeat(400000) })).toThrow(
      'Invalid input content',
    );
    expect(() =>
      client.listPendingInputs('s', { storeId: 'original-store', afterSeq: '9223372036854775808' }),
    ).toThrow('signed SQLite 64-bit range');
    expect(requests).toBe(2);
    expect(writes).toHaveLength(0);
    const receipt = await client.steer('s', steer);
    expect(receipt.status).toBe('accepted');
    expect(receipt.originStoreId).toBe('original-store');
    expect(await client.followUp('s', follow)).toMatchObject({
      id: 'original-follow',
      status: 'accepted',
    });
    expect(writes).toEqual([steer, follow]);
    expect(steer.targetRunId).toBe('original-run');
    expect(follow.afterRunId).toBe('original-run');
    const page = await client.listPendingInputs('s', {
      storeId: 'original-store',
      afterSeq: '9007199254740993',
      limit: 200,
    });
    expect(query).toContain('afterSeq=9007199254740993');
    expect(page.snapshotCursor).toBe('9007199254740997');
    expect(client.lastAppliedCursor).toBeUndefined();
  } finally {
    client.disposeNetwork();
    await server.stop(true);
  }
});
