import { expect, test } from 'bun:test';
import { createServer, type RequestListener } from 'node:http';
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib';
import type { ToolContext } from '@kite-ai/agent/extensions';
import {
  createPinnedWebNetworkPort,
  createWebFetchExtension,
  type WebHop,
} from '@kite-ai/agent/web-fetch';

const binding = (url: string): WebHop => ({
  url,
  originalUrl: url,
  hop: 0,
  resource: 'page',
  executionId: 'e',
  sessionId: 's',
  originStoreId: 'store',
});
async function failure(promise: Promise<unknown>, code: string) {
  let error: unknown;
  try {
    await promise;
  } catch (value) {
    error = value;
  }
  expect((error as { code?: string })?.code).toBe(code);
}
async function server(handler: RequestListener) {
  const value = createServer(handler);
  await new Promise<void>((resolve) => value.listen(0, '127.0.0.1', resolve));
  const port = (value.address() as { port: number }).port;
  return {
    url: `http://fixture.test:${port}`,
    close: async () => {
      value.closeAllConnections();
      await new Promise<void>((resolve) => value.close(() => resolve()));
    },
  };
}
async function bounded<T>(pending: Promise<T>, timeoutMs = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('cancelled_body_did_not_settle')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
test('pure port gates all DNS candidates, pins socket without re-resolution, preserves Host and refuses private/literal destinations', async () => {
  let requests = 0,
    resolutions = 0,
    admissions = 0;
  const f = await server((req, res) => {
    requests++;
    expect(req.headers.host).toBe(new URL(f.url).host);
    res.end('actual socket');
  });
  try {
    const port = createPinnedWebNetworkPort({
      policy: { mode: 'public' },
      allowLoopbackForTests: true,
      admitHop: async () => {
        admissions++;
        return { allowed: true, revision: 'policy1' };
      },
      resolveAddresses: async () => {
        resolutions++;
        return resolutions === 1
          ? [{ address: '127.0.0.1', family: 4 }]
          : [{ address: '169.254.169.254', family: 4 }];
      },
    });
    expect([requests, resolutions, admissions]).toEqual([0, 0, 0]);
    const response = await port.request(binding(f.url), {
      signal: new AbortController().signal,
      beforeConnect: async (facts) => {
        expect(requests).toBe(0);
        expect(facts.admissionRevision).toBe('policy1');
      },
    });
    expect(await new Response(response.body).text()).toBe('actual socket');
    expect([requests, resolutions, admissions]).toEqual([1, 1, 1]);
    const mixed = createPinnedWebNetworkPort({
      policy: { mode: 'public' },
      admitHop: async () => ({ allowed: true, revision: '1' }),
      resolveAddresses: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.1.2.3', family: 4 },
      ],
    });
    await failure(
      mixed.request(binding(f.url), { signal: new AbortController().signal }),
      'web_destination_denied',
    );
    for (const host of ['127.0.0.1', '[::ffff:127.0.0.1]', '169.254.169.254'])
      await failure(
        mixed.request(binding(`http://${host}/`), { signal: new AbortController().signal }),
        'web_destination_denied',
      );
    await failure(
      mixed.request(binding('http://username:secret@fixture.test/'), {
        signal: new AbortController().signal,
      }),
      'web_url_denied',
    );
    expect(requests).toBe(1);
  } finally {
    await f.close();
  }
});
test('single-hop port never follows redirects and enforces decompressed bytes, abort closes only owned socket', async () => {
  let followed = 0;
  let closed!: () => void;
  const socketClosed = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const f = await server((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/follow' }).end();
      return;
    }
    if (req.url === '/follow') {
      followed++;
      res.end('unexpected');
      return;
    }
    if (req.url === '/large') {
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync('x'.repeat(5_000_001)));
      return;
    }
    if (req.url === '/wait') {
      req.socket.once('close', closed);
      res.write('waiting');
      return;
    }
    res.end('independent');
  });
  const port = createPinnedWebNetworkPort({
    policy: { mode: 'allowlist', hosts: ['fixture.test'] },
    allowLoopbackForTests: true,
    admitHop: async () => ({ allowed: true, revision: '1' }),
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  try {
    const redirected = await port.request(binding(`${f.url}/redirect`), {
      signal: new AbortController().signal,
    });
    expect(redirected.status).toBe(302);
    await redirected.body.cancel();
    expect(followed).toBe(0);
    const large = await port.request(binding(`${f.url}/large`), {
      signal: new AbortController().signal,
    });
    await failure(new Response(large.body).text(), 'web_response_too_large');
    const abort = new AbortController();
    const waiting = await port.request(binding(`${f.url}/wait`), { signal: abort.signal });
    const reader = waiting.body.getReader();
    await reader.read();
    const pending = reader.read();
    abort.abort();
    let rejected = false;
    try {
      await pending;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    reader.releaseLock();
    await Promise.race([
      socketClosed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('socket_not_closed')), 2000),
      ),
    ]);
    const other = await port.request(binding(f.url), { signal: new AbortController().signal });
    expect(await new Response(other.body).text()).toBe('independent');
  } finally {
    await f.close();
  }
});

test('abort settles decoded bodies after the encoded HTTP message completes, including a pending read', async () => {
  const body = Buffer.alloc(4_000_000, 65);
  const encoded = {
    gzip: gzipSync(body),
    deflate: deflateSync(body),
    br: brotliCompressSync(body),
  };
  const f = await server((req, res) => {
    const encoding = req.url!.slice(1) as keyof typeof encoded;
    if (encoded[encoding])
      res
        .writeHead(200, { 'content-encoding': encoding, connection: 'keep-alive' })
        .end(encoded[encoding]);
    else res.end('independent');
  });
  const port = createPinnedWebNetworkPort({
    policy: { mode: 'public' },
    allowLoopbackForTests: true,
    admitHop: async () => ({ allowed: true, revision: '1' }),
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  try {
    for (const encoding of Object.keys(encoded)) {
      for (const readFirst of [false, true]) {
        const abort = new AbortController();
        const response = await port.request(binding(`${f.url}/${encoding}`), {
          signal: abort.signal,
        });
        const reader = response.body.getReader();
        try {
          if (readFirst) await reader.read();
          const consumed = (async () => {
            while (!(await reader.read()).done) {}
          })();
          const sibling = port.request(binding(f.url), { signal: AbortSignal.timeout(2000) });
          abort.abort(new Error('owned_cancel'));
          await failure(bounded(consumed), 'web_response_failed');
          expect(await new Response((await sibling).body).text()).toBe('independent');
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
    }
  } finally {
    await f.close();
  }
});

test('ordinary Web Tool cancellation settles a pending decoded read without waiting for its deadline', async () => {
  const encoded = gzipSync(Buffer.alloc(4_000_000, 65));
  const f = await server((req, res) => {
    if (req.url === '/robots.txt') res.end('User-agent: *');
    else res.writeHead(200, { 'content-encoding': 'gzip', connection: 'keep-alive' }).end(encoded);
  });
  const abort = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const network = createPinnedWebNetworkPort({
    policy: { mode: 'public' },
    allowLoopbackForTests: true,
    admitHop: async () => ({ allowed: true, revision: '1' }),
    resolveAddresses: async () => [{ address: '127.0.0.1', family: 4 }],
  });
  const extension = createWebFetchExtension({
    extractor: { extract: async () => ({ title: '', content: 'unused' }) },
    networkPort: {
      async request(hop, options) {
        const response = await network.request(hop, options);
        if (hop.resource === 'page') {
          const getReader = response.body.getReader.bind(response.body);
          // Select the actual Tool's pending-read cancellation edge, without changing the socket.
          Object.defineProperty(response.body, 'getReader', {
            value() {
              reader = getReader();
              queueMicrotask(() => abort.abort(new Error('owned_cancel')));
              return reader;
            },
          });
        }
        return response;
      },
    },
  });
  try {
    const result = await bounded(
      extension.tools![0]!.execute({ url: f.url, timeout_ms: 5000 }, {
        signal: abort.signal,
        executionId: 'e',
        sessionId: 's',
        getExecution: async () => ({ originStoreId: 'store' }),
        records: { write: async () => ({}) },
      } as unknown as ToolContext),
      2000,
    );
    expect(result).toEqual({ outcome: 'cancelled', content: 'web_cancelled' });
  } finally {
    await reader?.cancel().catch(() => {});
    await f.close();
  }
});
