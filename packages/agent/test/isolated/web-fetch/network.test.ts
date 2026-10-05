import { expect, test } from 'bun:test';
import { createServer, type RequestListener } from 'node:http';
import { gzipSync } from 'node:zlib';
import { createPinnedWebNetworkPort, type WebHop } from '@kite-ai/agent/web-fetch';

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
