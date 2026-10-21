import { expect, test } from 'bun:test';
import { createBrowserClient } from '../src/browser';
import {
  backgroundItem as item,
  backgroundSession as session,
} from './fixtures/background-directory';

const response = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'x-kite-web-identity': 'a'.repeat(64) } });
function fixture(mode: string) {
  let scans = 0;
  const queries: string[] = [];
  const transport = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/browser/v1/server')
        return response({
          instanceId: 'instance',
          buildId: 'build',
          pageIdentity: 'a'.repeat(64),
          storeId: 'store',
          capabilities: ['sessions'],
          dataAvailability: 'available',
        });
      queries.push(url.search);
      const after = url.searchParams.get('afterSeq');
      if (!after) scans++;
      if (after && mode === 'retry' && scans === 1)
        return response(
          {
            code: 'directory_changed',
            message: 'directory_changed',
            scope: 'request',
            requestId: 'id',
            retryable: false,
          },
          409,
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
      if (mode === 'bound-child') {
        const entry = value.items[0]!;
        entry.execution.childSessionId = 'exact-child' as never;
        entry.childSession = { ...session, id: 'exact-child', parentSessionId: 's' } as never;
      }

      if (mode === 'body')
        (value.items[0]!.execution as unknown as Record<string, unknown>).input = {
          secret: 'body',
        };
      if (mode.startsWith('source-')) {
        const entry = value.items[0]!;
        entry.execution.parentExecutionId = 'source-tool' as never;
        (entry as unknown as Record<string, unknown>).sourceTool = {
          id: mode === 'source-mismatch' ? 'another-tool' : 'source-tool',
          definitionId: mode === 'source-foreground' ? 'shell.execute' : 'shell.launch',
          definitionVersion: '1',
          ...(mode === 'source-body' ? { input: { secret: 'private command' } } : {}),
        };
      }
      if (mode === 'order') value.items[0]!.seq = '0';
      return response(value);
    },
    { preconnect() {} },
  ) as typeof fetch;
  const client = createBrowserClient({
    origin: 'http://localhost',
    pageIdentity: 'a'.repeat(64),
    fetch: transport,
  });
  return {
    client,
    queries,
    get scans() {
      return scans;
    },
  };
}
for (const mode of ['source-background', 'source-foreground'])
  test(`background directory retains exact Tool origin: ${mode}`, async () => {
    const f = fixture(mode);
    await f.client.connect();
    const rows = await f.client.listAllBackgroundExecutions({ includeSourceTool: true });
    expect(f.queries.every((query) => query.includes('includeSourceTool=true'))).toBe(true);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.sourceTool).toEqual({
      id: 'source-tool',
      definitionId: mode === 'source-foreground' ? 'shell.execute' : 'shell.launch',
      definitionVersion: '1',
    });
  });

test('an opted-in legacy directory without Tool metadata stays readable', async () => {
  const f = fixture('valid');
  await f.client.connect();
  const rows = await f.client.listAllBackgroundExecutions({ includeSourceTool: true });
  expect(rows).toHaveLength(2);
  expect(rows.every((row) => row.sourceTool === undefined)).toBe(true);
});

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
for (const mode of [
  'duplicate',
  'scope',
  'store',
  'child',
  'order',
  'body',
  'source-mismatch',
  'source-body',
])
  test(`background scan rejects ${mode} without exposing a prefix`, async () => {
    const f = fixture(mode);
    await f.client.connect();
    await expect(f.client.listAllBackgroundExecutions({ workspaceId: 'w' })).rejects.toBeDefined();
  });
test('background query rejects authority injection before GET and already aborted collector performs no page read', async () => {
  const f = fixture('valid');
  await f.client.connect();
  await expect(
    f.client.listBackgroundExecutions({ subjectId: 'other' } as never),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  await expect(
    f.client.listBackgroundExecutions({ storeId: 'forged' } as never),
  ).rejects.toMatchObject({ code: 'invalid_request' });
  expect(f.queries).toHaveLength(0);
  const abort = new AbortController();
  abort.abort();
  await expect(
    f.client.listAllBackgroundExecutions({ signal: abort.signal }),
  ).rejects.toBeDefined();
  expect(f.queries).toHaveLength(0);
});

test('background scan accepts restored Job provenance under the current snapshot Store', async () => {
  const f = fixture('origin');
  await f.client.connect();
  const result = await f.client.listAllBackgroundExecutions();
  expect(result).toHaveLength(2);
  expect(result.every((i) => i.execution.originStoreId === 'other')).toBe(true);
});

test('Browser background directory preserves an exact child relationship without synthesizing a control method', async () => {
  const f = fixture('bound-child');
  await f.client.connect();
  const items = await f.client.listAllBackgroundExecutions({ rootSessionId: 's' });
  expect(items[0]!.childSession!.id).toBe('exact-child');
  expect(items[0]!.execution.childSessionId).toBe('exact-child');
  expect(f.queries.every((query) => !query.includes('storeId'))).toBe(true);
  expect('cancelExecution' in f.client).toBe(false);
});
