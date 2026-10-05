import { afterEach, expect, spyOn, test } from 'bun:test';
import { createClient } from '../src';
import { createBrowserClient } from '../src/browser';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

const profile = { dataRoot: '/explicit-test-profile', name: 'test', accessKey: 'directory' },
  identity = 'a'.repeat(64);
const nativeInfo = {
  profile,
  instanceId: 'instance',
  buildId: 'build',
  apiMajor: 1,
  storeId: 'store',
  capabilities: ['sessions'],
  dataAvailability: 'available',
};
const browserInfo = {
  pageIdentity: identity,
  instanceId: 'instance',
  buildId: 'build',
  storeId: 'store',
  capabilities: ['sessions', 'workspaces'],
  dataAvailability: 'available',
};
function session(id: string) {
  return {
    id,
    workspaceId: 'w',
    parentSessionId: null,
    title: id,
    controlRevision: '1',
    contextSelectionId: 'selection',
    nextSeq: '0',
    deletedAt: null,
  };
}
function page(
  after: string | null,
  mode: 'valid' | 'duplicate' | 'wrong-store' | 'wrong-upper' = 'valid',
) {
  return {
    storeId: mode === 'wrong-store' ? 'other' : 'store',
    items: [
      {
        seq: after ? '9007199254740994' : '9007199254740993',
        session: session(after && mode !== 'duplicate' ? 'two' : 'one'),
      },
    ],
    highWaterSeq: '9007199254740994',
    upperSeq: after && mode === 'wrong-upper' ? '9007199254740993' : '9007199254740994',
    nextAfterSeq: after ? null : '9007199254740993',
    snapshotCursor: '1',
    future: { preserved: true },
  };
}
async function failure(work: Promise<unknown>) {
  try {
    await work;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'aborted';
  }
}
function fixture(browser: boolean) {
  let mode: 'valid' | 'duplicate' | 'wrong-store' | 'wrong-upper' = 'valid',
    reads = 0,
    release!: (response: Response) => void,
    held = false;
  const queries: string[] = [];
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/server'))
        return Response.json(browser ? browserInfo : nativeInfo, {
          headers: { 'x-kite-web-identity': identity },
        });
      reads++;
      queries.push(url.search);
      if (browser) {
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        expect(url.searchParams.has('storeId')).toBe(false);
      }
      const response = Response.json(page(url.searchParams.get('afterSeq'), mode), {
        headers: { 'x-kite-web-identity': identity },
      });
      if (held && url.searchParams.has('afterSeq'))
        return await new Promise<Response>((resolve) => (release = resolve));
      return response;
    },
    { preconnect() {} },
  ) as typeof fetch;
  if (!browser) {
    const spy = spyOn(globalThis, 'fetch').mockImplementation(transport);
    restore = () => spy.mockRestore();
  }
  const client = browser
    ? createBrowserClient({ origin: 'http://localhost', pageIdentity: identity, fetch: transport })
    : createClient({
        endpoint: 'http://localhost',
        token: 'private',
        expected: { profile, apiMajor: 1, requiredCapabilities: [] },
      });
  return {
    client,
    queries,
    get reads() {
      return reads;
    },
    setMode(value: typeof mode) {
      mode = value;
    },
    hold() {
      held = true;
    },
    release() {
      release(
        Response.json(page('9007199254740993'), { headers: { 'x-kite-web-identity': identity } }),
      );
    },
  };
}
for (const browser of [false, true])
  test(`${browser ? 'Browser' : 'Native'} directory freezes exact Decimal64 upper, rejects duplicate/wrong identity without publishing prefix and disposal refuses late page`, async () => {
    const f = fixture(browser);
    expect(await failure(f.client.listAllSessions())).toBe('connection_not_admitted');
    expect(f.reads).toBe(0);
    await f.client.connect();
    expect((await f.client.listAllSessions()).map((item) => item.id)).toEqual(['one', 'two']);
    expect(f.queries.at(-1)).toContain('upperSeq=9007199254740994');
    for (const mode of ['duplicate', 'wrong-store', 'wrong-upper'] as const) {
      f.setMode(mode);
      expect(await failure(f.client.listAllSessions())).not.toBeNull();
    }
    f.setMode('valid');
    f.hold();
    const pending = f.client.listAllSessions();
    const result = failure(pending);
    for (let i = 0; i < 20 && !f.queries.at(-1)?.includes('afterSeq'); i++) await Bun.sleep(1);
    // Wait until this invocation, rather than a previous query, has entered its held second page.
    await Bun.sleep(5);
    f.client.disposeNetwork();
    f.release();
    expect(await result).not.toBeNull();
  });

test('closed directory input rejects authority/cursor before fetch and response retains additive fields', async () => {
  const f = fixture(false);
  await f.client.connect();
  const client = f.client as ReturnType<typeof createClient>;
  const reads = f.reads;
  expect(
    await failure(client.listSessionDirectory({ storeId: 'store', subjectId: 'self' } as never)),
  ).toBe('invalid_request');
  expect(await failure(client.listSessionDirectory({ storeId: 'store', afterSeq: '01' }))).toBe(
    'invalid_request',
  );
  expect(await failure(client.listSessionDirectory({ storeId: 'store', limit: 201 }))).toBe(
    'invalid_request',
  );
  expect(
    await failure(client.listSessionDirectory({ storeId: 'store', afterSeq: '2', upperSeq: '1' })),
  ).toBe('invalid_cursor');
  expect(f.reads).toBe(reads);
  const result = await client.listSessionDirectory({ storeId: 'store' });
  expect((result as typeof result & { future: unknown }).future).toEqual({ preserved: true });
});
