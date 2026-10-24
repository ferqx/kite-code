import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectProfile } from '@kite-ai/agent/profile';
import { launchPairedService, type PairedServiceSpawner } from '../../src/paired';

const proxyKeys = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;
const secretEnvironment = {
  OPENAI_API_KEY: 'fixture-model-secret',
  ANTHROPIC_API_KEY: 'fixture-other-model-secret',
  OPENAI_ACCESS_TOKEN: 'fixture-access-token',
  CODEX_AUTH_TOKEN: 'fixture-codex-token',
  KITE_PAIRED_SECRET: 'fixture-arbitrary-secret',
  NODE_OPTIONS: '--trace-warnings',
  BUN_OPTIONS: '--smol',
  NODE_EXTRA_CA_CERTS: 'fixture-not-an-extra-ca.pem',
};
async function environment<T>(values: Record<string, string | undefined>, run: () => Promise<T>) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

test.each([
  'upper',
  'lower',
] as const)('paired child inherits only supported %s proxy inputs and honors NO_PROXY without publishing credentials', async (casing) => {
  const root = mkdtempSync(join(tmpdir(), 'kite-paired-proxy-'));
  const codexHome = join(root, 'explicit codex home');
  const profile = selectProfile({ dataRoot: join(root, 'data'), profile: 'disposable' });
  const requests: { url: string; authorization?: string }[] = [];
  const tunnels: { host: string; authorization?: string }[] = [];
  let originCalls = 0;
  const proxy = createServer((request, response) => {
    requests.push({ url: request.url!, authorization: request.headers['proxy-authorization'] });
    response.end('proxy-response');
  });
  proxy.on('connect', (request, socket) => {
    tunnels.push({ host: request.url!, authorization: request.headers['proxy-authorization'] });
    socket.end('HTTP/1.1 409 Fixture Proxy\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  const origin = createServer((_request, response) => {
    originCalls++;
    response.end('direct-response');
  });
  let service: Awaited<ReturnType<typeof launchPairedService>> | undefined;
  let captured: Readonly<Record<string, string>> | undefined;
  let expectedProxies: Record<string, string> = {};
  try {
    await Promise.all([
      new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve)),
      new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve)),
    ]);
    const proxyAddress = proxy.address();
    const originAddress = origin.address();
    if (!proxyAddress || typeof proxyAddress === 'string') throw new Error('proxy_address');
    if (!originAddress || typeof originAddress === 'string') throw new Error('origin_address');
    const proxyUrl = `http://fixture-proxy-user:fixture-proxy-password@127.0.0.1:${proxyAddress.port}`;
    const keys =
      casing === 'upper'
        ? ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']
        : ['http_proxy', 'https_proxy', 'no_proxy'];
    const selected = { [keys[0]!]: proxyUrl, [keys[1]!]: proxyUrl, [keys[2]!]: '127.0.0.1' };
    const httpUrl = 'http://paired-proxy.invalid/outbound';
    const httpsUrl = 'https://paired-proxy.invalid/outbound';
    const directUrl = `http://127.0.0.1:${originAddress.port}/bypass`;
    const spawnChild: PairedServiceSpawner = (command, { env }) => {
      captured = env;
      return Bun.spawn([...command], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    };
    await environment(
      {
        ...Object.fromEntries(proxyKeys.map((key) => [key, undefined])),
        ...secretEnvironment,
        ALL_PROXY: 'http://fixture-unused-all-proxy.invalid',
        all_proxy: 'http://fixture-unused-lower-all-proxy.invalid',
        ...selected,
        CODEX_HOME: codexHome,
      },
      async () => {
        // Windows may expose both spellings for one case-insensitive host key.
        expectedProxies = Object.fromEntries(
          proxyKeys.slice(0, 6).flatMap((key) => {
            const value = process.env[key];
            return value === undefined ? [] : [[key, value]];
          }),
        );
        service = await launchPairedService({
          entrypoint: join(import.meta.dir, '../fixtures/paired-proxy-child.ts'),
          profile,
          instanceId: `proxy-${casing}`,
          buildId: 'fixture-proxy-build',
          apiMajor: 1,
          requiredCapabilities: ['commands'],
          hostConfiguration: {
            report: join(root, 'report.json'),
            requests: [httpUrl, httpsUrl, directUrl],
          },
          ...(casing === 'lower' ? { spawnChild } : {}),
        });
      },
    );
    const report = JSON.parse(readFileSync(join(root, 'report.json'), 'utf8'));
    expect(report.pid).toBe(service!.pid);
    expect(report.pid).not.toBe(process.pid);
    expect(report.proxies).toEqual(
      Object.fromEntries(
        Object.entries(expectedProxies).map(([key, value]) => [key, digest(value)]),
      ),
    );
    expect(report.forbiddenPresent).toEqual([]);
    expect(report.codexHomeDigest).toBe(digest(codexHome));
    expect(report.startupContainsProxyCredential).toBe(false);
    expect(report.responses[0]).toEqual({ url: httpUrl, status: 200, text: 'proxy-response' });
    expect(report.responses[1].url).toBe(httpsUrl);
    expect(report.responses[2]).toEqual({ url: directUrl, status: 200, text: 'direct-response' });
    expect(requests).toEqual([
      {
        url: httpUrl,
        authorization: `Basic ${Buffer.from('fixture-proxy-user:fixture-proxy-password').toString('base64')}`,
      },
    ]);
    expect(tunnels).toEqual([
      {
        host: 'paired-proxy.invalid:443',
        authorization: `Basic ${Buffer.from('fixture-proxy-user:fixture-proxy-password').toString('base64')}`,
      },
    ]);
    expect(originCalls).toBe(1);
    expect(service!.diagnostics).toEqual([]);
    expect(
      JSON.stringify({ bootstrap: service!.bootstrap, info: service!.client.serverInfo }),
    ).not.toContain('fixture-proxy-password');
    if (captured) {
      expect(Object.keys(captured).sort()).toEqual(
        [
          'PATH',
          'LANG',
          'HOME',
          ...(process.platform === 'win32' ? ['USERPROFILE'] : []),
          ...Object.keys(expectedProxies),
          'CODEX_HOME',
        ].sort(),
      );
      for (const [key, value] of Object.entries(expectedProxies)) expect(captured[key]).toBe(value);
      expect(captured.CODEX_HOME).toBe(codexHome);
    }
    await service!.close();
    expect(await service!.exited).toBe(0);
  } finally {
    await service?.close();
    proxy.closeAllConnections();
    origin.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => origin.close(() => resolve())),
    ]);
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
