import { expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import {
  createPinnedWebNetworkPort,
  type PinnedWebNetworkOptions,
  type WebHop,
} from '@kite-ai/agent/web-fetch';
import { resolveWebDns } from '../../../src/tools/web-fetch/dns';
import { selectedProxy } from '../../../src/tools/web-fetch/proxy';
import { certificate, privateKey } from './tls.fixture';

const binding = (url: string): WebHop => ({
  url,
  originalUrl: url,
  hop: 0,
  resource: 'page',
  executionId: 'e',
  sessionId: 's',
  originStoreId: 'store',
});
const signal = () => AbortSignal.timeout(4000);
async function failure(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw Error('expected_failure');
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}
const options = (): PinnedWebNetworkOptions => ({
  policy: { mode: 'public' },
  admitHop: async () => ({ allowed: true, revision: '1' }),
  resolveAddresses: async () => [{ address: '8.8.8.8', family: 4 }],
});
async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
function dnsAnswer(question: Uint8Array, address = '8.8.8.8') {
  const query = Buffer.from(question),
    type = query.readUInt16BE(query.length - 4);
  const header = Buffer.from(query);
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(type === 1 ? 1 : 0, 6);
  if (type !== 1) return header;
  return Buffer.concat([
    header,
    Buffer.from([0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, ...address.split('.').map(Number)]),
  ]);
}
async function fixture(secureProxy = false) {
  const sockets = new Set<Socket>(),
    connects: string[] = [],
    requests: string[] = [],
    dnsRequests: Uint8Array[] = [];
  let dnsAddress = '8.8.8.8',
    mode = 'normal';
  const handler = (
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
  ) => {
    requests.push(`${request.headers.host}${request.url}`);
    if (request.url === '/dns-query') {
      const chunks: Uint8Array[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        dnsRequests.push(body);
        if (mode === 'dns-redirect')
          response.writeHead(302, { location: 'https://dns.fixture.test/other' }).end();
        else
          response
            .writeHead(200, { 'content-type': 'application/dns-message' })
            .end(dnsAnswer(body, dnsAddress));
      });
    } else if (request.url === '/wait') response.write('waiting');
    else response.end('verified socket');
  };
  const plain = createServer(handler),
    tls = createSecureServer({ key: privateKey, cert: certificate }, handler);
  tls.on('tlsClientError', () => {});
  const httpPort = await listen(plain),
    httpsPort = await listen(tls);
  const proxy = secureProxy
    ? createSecureServer({ key: privateKey, cert: certificate })
    : createServer();
  proxy.on('connect', (request, socket, head) => {
    connects.push(request.url!);
    if (mode === 'stall') {
      socket.once('end', () => socket.destroy());
      socket.resume();
      return;
    }
    if (mode === 'refuse') {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const port = request.url!.endsWith(':443') ? httpsPort : httpPort;
    const upstream = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  for (const server of [plain, tls, proxy])
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
  const proxyPort = await listen(proxy),
    endpoint = `${secureProxy ? 'https' : 'http'}://127.0.0.1:${proxyPort}`;
  return {
    connects,
    requests,
    dnsRequests,
    sockets,
    endpoint,
    setMode(value: string) {
      mode = value;
    },
    setDns(value: string) {
      dnsAddress = value;
    },
    settings: { http: endpoint, https: endpoint },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(
        [plain, tls, proxy].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve())),
        ),
      );
    },
  };
}
test('HTTP and HTTPS proxies tunnel the validated literal IP and preserve target Host, SNI and trusted TLS', async () => {
  for (const secureProxy of [false, true]) {
    const f = await fixture(secureProxy);
    try {
      const port = createPinnedWebNetworkPort({
        ...options(),
        proxy: f.settings,
        certificateAuthority: certificate,
      });
      for (const protocol of ['http', 'https']) {
        const response = await port.request(binding(`${protocol}://fixture.test/body`), {
          signal: signal(),
        });
        expect(await new Response(response.body).text()).toBe('verified socket');
      }
      expect(f.connects).toEqual(['8.8.8.8:80', '8.8.8.8:443']);
      expect(f.requests).toEqual(['fixture.test/body', 'fixture.test/body']);
      await failure(
        port.request(binding('https://wrong.test/body'), { signal: signal() }),
        'web_tls_failed',
      );
      const untrusted = createPinnedWebNetworkPort({ ...options(), proxy: { https: f.endpoint } });
      await failure(
        untrusted.request(binding('https://fixture.test/body'), { signal: signal() }),
        secureProxy ? 'web_proxy_connect_failed' : 'web_tls_failed',
      );
      expect(f.requests.length).toBe(2);
    } finally {
      await f.close();
    }
  }
});

test('built public Web Fetch entry retains proxy and automatic Fake-IP transport without source fallback', async () => {
  const f = await fixture(true);
  try {
    const built = (await import(
      new URL('../../../dist/tools/web-fetch/index.js', import.meta.url).href
    )) as { createPinnedWebNetworkPort: typeof createPinnedWebNetworkPort };
    const port = built.createPinnedWebNetworkPort({
      ...options(),
      proxy: f.settings,
      certificateAuthority: certificate,
      recoverFakeIp: true,
      resolveAddresses: async () => [{ address: '198.18.0.31', family: 4 }],
    });
    const response = await port.request(binding('https://fixture.test/body'), { signal: signal() });
    expect(await new Response(response.body).text()).toBe('verified socket');
    expect(f.connects).toEqual(['1.1.1.1:443', '1.1.1.1:443', '8.8.8.8:443']);
  } finally {
    await f.close();
  }
});
test('all destination candidates remain gated before proxy contact; NO_PROXY only chooses transport', async () => {
  const f = await fixture();
  try {
    for (const addresses of [
      [{ address: '10.0.0.1', family: 4 }],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      [{ address: '::ffff:8.8.8.8', family: 6 }],
    ]) {
      const port = createPinnedWebNetworkPort({
        ...options(),
        proxy: f.settings,
        resolveAddresses: async () => addresses as { address: string; family: 4 | 6 }[],
      });
      await failure(
        port.request(binding('https://fixture.test'), { signal: signal() }),
        'web_destination_denied',
      );
      await failure(
        port.request(binding('http://169.254.169.254'), { signal: signal() }),
        'web_destination_denied',
      );
    }
    expect(f.connects).toEqual([]);
    expect(
      selectedProxy(
        { ...f.settings, noProxy: '.example.test, fixture.test:443' },
        new URL('https://fixture.test'),
      ),
    ).toBeUndefined();
    expect(
      selectedProxy(
        { ...f.settings, noProxy: '.example.test' },
        new URL('https://badexample.test'),
      ),
    ).toBe(f.endpoint);
  } finally {
    await f.close();
  }
});
test('Fake-IP recovery uses authenticated wire DoH through the same proxy, then rechecks real addresses', async () => {
  const f = await fixture();
  const network = {
    ...options(),
    proxy: f.settings,
    certificateAuthority: certificate,
    recoverFakeIp: true,
    dnsOverHttps: { url: 'https://dns.fixture.test/dns-query', addresses: ['1.1.1.1'] },
    resolveAddresses: async () => {
      throw Error('explicit_DoH_must_not_use_system_DNS');
    },
  };
  try {
    const port = createPinnedWebNetworkPort(network);
    const response = await port.request(binding('https://fixture.test/body'), { signal: signal() });
    expect(await new Response(response.body).text()).toBe('verified socket');
    expect(f.connects).toEqual(['1.1.1.1:443', '1.1.1.1:443', '8.8.8.8:443']);
    expect(f.dnsRequests).toHaveLength(2);
    f.setDns('10.0.0.1');
    await failure(
      port.request(binding('https://fixture.test/private'), { signal: signal() }),
      'web_destination_denied',
    );
    expect(f.requests.filter((path) => !path.includes('dns-query'))).toEqual(['fixture.test/body']);
    f.setMode('dns-redirect');
    await failure(
      port.request(binding('https://fixture.test/body'), { signal: signal() }),
      'web_dns_unavailable',
    );
    expect(f.requests.some((path) => path.endsWith('/other'))).toBe(false);
    const auto = createPinnedWebNetworkPort({
      ...options(),
      proxy: f.settings,
      recoverFakeIp: true,
      resolveAddresses: async () => [{ address: '10.0.0.1', family: 4 }],
    });
    const before = f.connects.length;
    await failure(
      auto.request(binding('https://fixture.test'), { signal: signal() }),
      'web_destination_denied',
    );
    expect(f.connects.length).toBe(before);
  } finally {
    await f.close();
  }
});
test('automatic recovery is limited to an all-Fake-IP DNS answer and needs no resolver configuration', async () => {
  const f = await fixture();
  try {
    const base = {
      ...options(),
      proxy: f.settings,
      certificateAuthority: certificate,
      recoverFakeIp: true,
    };
    const port = createPinnedWebNetworkPort({
      ...base,
      resolveAddresses: async () => [
        { address: '198.18.0.31', family: 4 },
        { address: '2001:2::1e', family: 6 },
      ],
    });
    const response = await port.request(binding('https://fixture.test/body'), { signal: signal() });
    expect(await new Response(response.body).text()).toBe('verified socket');
    expect(f.requests).toEqual([
      'cloudflare-dns.com/dns-query',
      'cloudflare-dns.com/dns-query',
      'fixture.test/body',
    ]);
    expect(f.connects).toEqual(['1.1.1.1:443', '1.1.1.1:443', '8.8.8.8:443']);
    const before = f.connects.length;
    for (const values of [
      [
        { address: '198.18.0.31', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      [
        { address: '198.18.0.31', family: 4 },
        { address: '8.8.8.8', family: 4 },
      ],
    ]) {
      const denied = createPinnedWebNetworkPort({
        ...base,
        resolveAddresses: async () => values as { address: string; family: 4 | 6 }[],
      });
      await failure(
        denied.request(binding('https://fixture.test'), { signal: signal() }),
        'web_destination_denied',
      );
    }
    await failure(
      port.request(binding('https://198.18.0.31'), { signal: signal() }),
      'web_destination_denied',
    );
    expect(f.connects.length).toBe(before);
  } finally {
    await f.close();
  }
});
test('proxy refusal has no direct retry and abort releases a stalled CONNECT without disturbing a sibling', async () => {
  const f = await fixture();
  try {
    const port = createPinnedWebNetworkPort({ ...options(), proxy: f.settings });
    f.setMode('refuse');
    await failure(
      port.request(binding('http://fixture.test'), { signal: signal() }),
      'web_proxy_connect_failed',
    );
    expect(f.requests).toEqual([]);
    expect(f.connects).toHaveLength(1);
    f.setMode('stall');
    const abort = new AbortController();
    const pending = port.request(binding('http://fixture.test/wait'), { signal: abort.signal });
    while (f.connects.length < 2) await Bun.sleep(5);
    abort.abort(new Error('owned_cancel'));
    await expect(pending).rejects.toThrow('owned_cancel');
    f.setMode('normal');
    const sibling = await port.request(binding('http://fixture.test'), { signal: signal() });
    expect(await new Response(sibling.body).text()).toBe('verified socket');
    const deadline = Date.now() + 1000;
    while (f.sockets.size && Date.now() < deadline) await Bun.sleep(5);
    expect(f.sockets.size).toBe(0);
  } finally {
    await f.close();
  }
});
test('wire DNS rejects forged identities, private results stay visible to the caller gate', async () => {
  expect(await resolveWebDns('fixture.test', async (query) => dnsAnswer(query))).toEqual([
    { address: '8.8.8.8', family: 4 },
  ]);
  await failure(
    resolveWebDns('fixture.test', async (query) => {
      const response = dnsAnswer(query);
      response[0] = response[0]! ^ 1;
      return response;
    }),
    'web_dns_unavailable',
  );
  await failure(
    resolveWebDns('fixture.test', async (query) => {
      const response = dnsAnswer(query);
      response[13] = 120;
      return response;
    }),
    'web_dns_unavailable',
  );
});
