import { afterEach, expect, spyOn, test } from 'bun:test';
import { createClient } from '../src';

const profile = { dataRoot: '/fixture', name: 'test', accessKey: 'background' };
const server = {
  profile,
  instanceId: 'instance',
  buildId: 'build',
  apiMajor: 1,
  storeId: 'store',
  capabilities: ['sessions'],
  dataAvailability: 'available',
};
const session = {
  id: 's',
  workspaceId: 'w',
  parentSessionId: null,
  rootSessionId: 's',
  title: 's',
  controlRevision: '1',
  contextSelectionId: 'selection',
  ownerInstanceId: null,
  ownerGeneration: '0',
  nextSeq: '0',
  deletedAt: null,
};
const item = (id: string, seq: string) => ({
  seq,
  session,
  rootSession: session,
  run: null,
  childRun: null,
  childSession: null,
  execution: {
    id,
    sessionId: 's',
    rootSessionId: 's',
    runId: null,
    originCommandId: 'work',
    originStoreId: 'store',
    rootWorkCommandId: 'work',
    rootWorkSeq: '1',
    parentExecutionId: null,
    childSessionId: null,
    cancelWithParent: false,
    stepId: 'step',
    callId: 'call',
    attempt: 1,
    kind: 'job',
    definitionId: 'fixture.job',
    definitionVersion: '1',
    status: 'succeeded',
    ownerGeneration: '1',
    cancelRequested: false,
    cancelRequestedAt: null,
    resultRevision: '1',
    delivery: 'pending',
    deliveryReason: null,
    deliveryTargetSessionId: 's',
    contextSelectionId: 'selection',
  },
});
let restore: () => void = () => {};
afterEach(() => restore());
function fixture(mode: string) {
  let scans = 0;
  const queries: string[] = [];
  const transport = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/server') return Response.json(server);
      queries.push(url.search);
      const after = url.searchParams.get('afterSeq');
      if (!after) scans++;
      if (after && mode === 'retry' && scans === 1)
        return Response.json(
          {
            code: 'directory_changed',
            message: 'directory_changed',
            scope: 'request',
            requestId: 'id',
            retryable: false,
          },
          { status: 409 },
        );

      const value = {
        storeId: 'store',
        highWaterSeq: '9007199254740994',
        upperSeq: '9007199254740994',
        snapshotCursor: scans === 1 ? '1' : '2',
        nextAfterSeq: after ? null : '9007199254740993',
        items: [
          item(
            after && mode !== 'duplicate' ? 'two' : 'one',
            after ? '9007199254740994' : '9007199254740993',
          ),
        ],
      };
      if (mode === 'scope') value.items[0]!.rootSession = { ...session, workspaceId: 'wrong' };
      if (mode === 'store') value.storeId = 'wrong';
      if (mode === 'origin') value.items[0]!.execution.originStoreId = 'other';
      if (mode === 'child') value.items[0]!.execution.childSessionId = 'unbound' as never;
      if (mode === 'body')
        (value.items[0]!.execution as unknown as Record<string, unknown>).input = {
          secret: 'body',
        };
      if (mode === 'order') value.items[0]!.seq = '0';
      return Response.json(value);
    },
    { preconnect() {} },
  ) as typeof fetch;
  const spy = spyOn(globalThis, 'fetch').mockImplementation(transport);
  restore = () => spy.mockRestore();
  const client = createClient({
    endpoint: 'http://localhost',
    token: 'private',
    expected: { profile, apiMajor: 1, requiredCapabilities: ['sessions'] },
  });
  return {
    client,
    queries,
    get scans() {
      return scans;
    },
  };
}
test('whole background scan retries from zero at a changed snapshot and retains original Store provenance', async () => {
  const f = fixture('retry');
  await f.client.connect();
  const result = await f.client.listAllBackgroundExecutions();
  expect(result.map((i) => i.execution.id)).toEqual(['one', 'two']);
  expect(f.scans).toBe(2);
  expect(f.queries[1]).toContain('snapshotCursor=1');
  expect(f.queries[3]).toContain('snapshotCursor=2');
  expect(f.queries[3]).toContain('upperSeq=9007199254740994');
  expect(result[0]!.execution.originStoreId).toBe('store');
});
for (const mode of ['duplicate', 'scope', 'store', 'origin', 'child', 'order', 'body'])
  test(`background scan rejects ${mode} without exposing a prefix`, async () => {
    const f = fixture(mode);
    await f.client.connect();
    await expect(f.client.listAllBackgroundExecutions({ workspaceId: 'w' })).rejects.toBeDefined();
  });
test('background query rejects authority injection before GET and already aborted collector performs no page read', async () => {
  const f = fixture('valid');
  await f.client.connect();
  await expect(
    f.client.listBackgroundExecutions({ storeId: 'store', subjectId: 'other' } as never),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  expect(f.queries).toHaveLength(0);
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.client.listAllBackgroundExecutions({ signal: abort.signal }),
  ).rejects.toBeDefined();
  expect(f.queries).toHaveLength(0);
});
