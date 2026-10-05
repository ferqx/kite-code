import { expect, test } from 'bun:test';
import { createClient, type SessionLogPage } from '../../src';
import { createBrowserClient } from '../../src/browser';
import { decodeResponse } from '../../src/decode';
import { verifySessionLogPage } from '../../src/session-logs';

const pageIdentity = 'a'.repeat(64);
const profile = { dataRoot: '/owned', name: 'owned', accessKey: 'owned' };
const query = { afterCursor: '9007199254740992', upperCursor: '9007199254740995', limit: 1 };
function page(): SessionLogPage {
  return {
    storeId: 'store',
    sessionId: 'session',
    upperCursor: query.upperCursor,
    replayFloor: '0',
    snapshotCursor: query.upperCursor,
    nextAfterCursor: '9007199254740993',
    complete: false,
    entries: [
      {
        cursor: '9007199254740993',
        sessionId: 'session',
        objectId: 'model',
        type: 'execution.planned',
        revision: '9007199254740993',
        occurredAt: 1791000000000,
        category: 'execution',
        recordedStatus: 'planned',
        summary: 'execution.planned: planned',
        details: { kind: 'model', executionId: 'model', runId: 'run', commandId: 'work' },
        modelExecutionId: 'model',
      },
    ],
  };
}

test('closed log DTO rejects private payload and finite field drift while Decimal64 pages retain exact order', () => {
  const original = page();
  expect(decodeResponse('SessionLogPage', original)).toEqual(original);
  expect(verifySessionLogPage(original, { storeId: 'store', sessionId: 'session' }, query)).toEqual(
    original,
  );
  for (const value of [
    { ...page(), payload: { private: 'SECRET' } },
    { ...page(), entries: [{ ...page().entries[0]!, payload: 'SECRET' }] },
    { ...page(), entries: [{ ...page().entries[0]!, details: { ownerGeneration: 'SECRET' } }] },
    { ...page(), entries: [{ ...page().entries[0]!, occurredAt: 'today' }] },
    { ...page(), entries: [{ ...page().entries[0]!, recordedStatus: 'pretend_completed' }] },
    { ...page(), entries: Array(201).fill(page().entries[0]!) },
  ])
    expect(() => decodeResponse('SessionLogPage', value)).toThrow(
      'Invalid SessionLogPage response.',
    );
  for (const value of [
    { ...page(), storeId: 'other' },
    { ...page(), sessionId: 'other' },
    { ...page(), upperCursor: '9007199254740994' },
    { ...page(), snapshotCursor: '9007199254740994' },
    { ...page(), replayFloor: '9007199254740993' },
    { ...page(), complete: true },
    { ...page(), nextAfterCursor: null },
    { ...page(), nextAfterCursor: query.afterCursor },
    { ...page(), entries: [] },
    { ...page(), entries: [page().entries[0]!, page().entries[0]!] },
    { ...page(), entries: [{ ...page().entries[0]!, sessionId: 'other' }] },
    { ...page(), entries: [{ ...page().entries[0]!, cursor: query.afterCursor }] },
    { ...page(), entries: [{ ...page().entries[0]!, cursor: '9007199254740996' }] },
    { ...page(), entries: [{ ...page().entries[0]!, revision: '9223372036854775808' }] },
    { ...page(), entries: [{ ...page().entries[0]!, modelExecutionId: 'other' }] },
    { ...page(), entries: [{ ...page().entries[0]!, category: 'command' as const }] },
    {
      ...page(),
      entries: [
        { ...page().entries[0]!, details: { kind: 'tool' as const, executionId: 'model' } },
      ],
    },
  ])
    expect(() =>
      verifySessionLogPage(value, { storeId: 'store', sessionId: 'session' }, query),
    ).toThrow();
  const old = page();
  old.entries[0]!.occurredAt = null;
  old.entries[0]!.recordedStatus = null;
  old.entries[0]!.modelExecutionId = null;
  old.entries[0]!.details = {};
  expect(
    verifySessionLogPage(
      decodeResponse('SessionLogPage', old),
      { storeId: 'store', sessionId: 'session' },
      query,
    ),
  ).toEqual(old);
});

test('Native and Browser log methods retain original query, fail closed before I/O and cap streamed metadata at 512KiB', async () => {
  const requests: Request[] = [];
  let responsePage: unknown = page();
  let capabilities = ['session_logs'];
  let oversized = false;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      requests.push(request.clone());
      const browser = new URL(request.url).pathname.startsWith('/browser/');
      const value = new URL(request.url).pathname.endsWith('/server')
        ? {
            instanceId: 'instance',
            buildId: 'build',
            ...(browser ? { pageIdentity } : { apiMajor: 1, profile }),
            storeId: 'store',
            dataAvailability: 'available',
            capabilities,
          }
        : responsePage;
      return new Response(`${oversized ? ' '.repeat(512 * 1024) : ''}${JSON.stringify(value)}`, {
        headers: { 'content-type': 'application/json', 'x-kite-web-identity': pageIdentity },
      });
    },
  });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const native = createClient({
    endpoint,
    token: 'native-secret',
    expected: { profile, apiMajor: 1, requiredCapabilities: [] },
  });
  const browser = createBrowserClient({ origin: endpoint, pageIdentity });
  try {
    await native.connect();
    await browser.connect();
    expect(await native.listSessionLogs('session', query)).toEqual(page());
    expect(await browser.listSessionLogs('session', query)).toEqual(page());
    const logRequests = requests.filter((request) =>
      new URL(request.url).pathname.endsWith('/logs'),
    );
    expect(logRequests).toHaveLength(2);
    for (const request of logRequests) {
      const url = new URL(request.url);
      expect(request.method).toBe('GET');
      expect(url.searchParams.get('afterCursor')).toBe(query.afterCursor);
      expect(url.searchParams.get('upperCursor')).toBe(query.upperCursor);
      expect(url.searchParams.get('limit')).toBe('1');
      expect(url.searchParams.has('subjectId')).toBe(false);
      if (url.pathname.startsWith('/browser/')) {
        expect(request.headers.has('authorization')).toBe(false);
        expect(url.searchParams.has('storeId')).toBe(false);
      } else expect(request.headers.get('authorization')).toBe('Bearer native-secret');
    }
    const beforeInvalid = requests.length;
    for (const invalid of [
      { afterCursor: '01' },
      { afterCursor: '-1' },
      { afterCursor: '9223372036854775808' },
      { afterCursor: '2', upperCursor: '1' },
      { afterCursor: '0', limit: 0 },
      { afterCursor: '0', limit: 201 },
      { afterCursor: '0', subjectId: 'other' },
    ]) {
      expect(() => native.listSessionLogs('session', invalid)).toThrow();
      expect(() => browser.listSessionLogs('session', invalid)).toThrow();
    }
    expect(() => native.listSessionLogs('session', { ...query, expectedStoreId: 'other' })).toThrow(
      'store_identity_mismatch',
    );
    expect(() => browser.listSessionLogs('bad/session', query)).toThrow(
      'invalid_session_log_target',
    );
    expect(requests).toHaveLength(beforeInvalid);
    for (const client of [native, browser]) {
      expect(
        await client.listSessionLogs('session', {
          afterCursor: query.afterCursor,
          upperCursor: undefined,
          limit: undefined,
        }),
      ).toEqual(page());
      const url = new URL(requests.at(-1)!.url);
      expect(url.searchParams.has('upperCursor')).toBe(false);
      expect(url.searchParams.has('limit')).toBe(false);
    }
    responsePage = {
      ...page(),
      entries: [{ ...page().entries[0]!, details: { rawInput: 'SECRET' } }],
    };
    for (const client of [native, browser]) {
      const failure = await client.listSessionLogs('session', query).then(
        () => null,
        (error: unknown) => error,
      );
      expect((failure as Error).message).toContain('Invalid SessionLogPage');
    }
    responsePage = page();
    oversized = true;
    for (const client of [native, browser]) {
      const failure = await client.listSessionLogs('session', query).then(
        () => null,
        (error: unknown) => error,
      );
      expect((failure as { code: string }).code).toBe('response_too_large');
    }
    oversized = false;
    const aborted = new AbortController();
    aborted.abort(new Error('observer closed'));
    const beforeAbort = requests.length;
    for (const client of [native, browser]) {
      const failure = await client
        .listSessionLogs('session', { ...query, signal: aborted.signal })
        .then(
          () => null,
          (error: unknown) => error,
        );
      expect(failure).toBe(aborted.signal.reason);
    }
    expect(requests).toHaveLength(beforeAbort);
    capabilities = [];
    await native.connect();
    await browser.connect();
    const beforeMissing = requests.length;
    expect(() => native.listSessionLogs('session', query)).toThrow('capability_unavailable');
    expect(() => browser.listSessionLogs('session', query)).toThrow('capability_unavailable');
    expect(requests).toHaveLength(beforeMissing);
    expect(requests.every((request) => request.method === 'GET')).toBe(true);
  } finally {
    native.disposeNetwork();
    browser.disposeNetwork();
    await server.stop(true);
  }
});
