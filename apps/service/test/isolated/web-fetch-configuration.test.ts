import { expect, test } from 'bun:test';
import type { ToolContext } from '@kite-ai/agent/extensions';
import { createWebFetchConfiguration } from '../../src/web-fetch-configuration';
import {
  environmentWebProxy,
  macWebProxy,
  resolveWebTransport,
  windowsWebProxy,
} from '../../src/web-fetch-proxy';

test('trusted web configuration is pure, effects remain network/unknown and immutable host policy cannot be selected into broader access', () => {
  let dns = 0,
    admission = 0,
    parser = 0;
  const policy = { mode: 'allowlist' as const, hosts: ['docs.example.test'] };
  const configuration = createWebFetchConfiguration({
    network: {
      policy,
      resolveAddresses: async () => {
        dns++;
        return [];
      },
      admitHop: async () => {
        admission++;
        return { allowed: true, revision: '1' };
      },
    },
    extractor: {
      prepare: async () => {
        parser++;
        return { hash: 'a'.repeat(64) };
      },
      extract: async () => ({ title: '', content: 'body' }),
    },
  });
  policy.hosts.push('untrusted.example.test');
  expect([dns, admission, parser]).toEqual([0, 0, 0]);
  expect(configuration.toolIds).toEqual(['web_fetch']);
  expect(configuration.snapshot.defaultTimeoutMs).toBe(60_000);
  expect(configuration.snapshot.policy).toEqual({
    mode: 'allowlist',
    hosts: ['docs.example.test'],
  });
  expect(configuration.capabilities).toEqual([
    {
      kind: 'tool',
      definitionId: 'web_fetch',
      definitionVersion: '1',
      revision: 'builtin.web:1',
      hardAllowed: true,
      effects: ['network', 'unknown'],
      safeRead: false,
    },
  ]);
  const off = createWebFetchConfiguration({
    network: { policy: { mode: 'off' }, admitHop: async () => ({ allowed: true, revision: '1' }) },
  });
  expect(off.capabilities[0]?.hardAllowed).toBe(false);
  expect(off.extension.tools?.[0]?.version).toBe('1');
});

test('automatic proxy selection uses explicit environment before registered system settings, direct overrides discovery', async () => {
  let discovered = 0;
  const systemProxy = async () => {
    discovered++;
    return { http: 'http://127.0.0.1:7890', https: 'http://127.0.0.1:7890' };
  };
  const env = {
    http_proxy: 'http://127.0.0.1:8080',
    HTTP_PROXY: 'http://ignored.test:80',
    https_proxy: 'https://proxy.test:443',
    NO_PROXY: 'localhost,.example.test',
  };
  const selected = await resolveWebTransport(undefined, { env, systemProxy });
  expect(selected).toEqual({
    proxy: {
      http: 'http://127.0.0.1:8080',
      https: 'https://proxy.test',
      noProxy: 'localhost,.example.test',
    },
    recoverFakeIp: true,
  });
  env.http_proxy = 'http://changed.test:80';
  expect(selected.proxy?.http).toBe('http://127.0.0.1:8080');
  expect(discovered).toBe(0);
  expect((await resolveWebTransport(undefined, { env: {}, systemProxy })).proxy?.https).toBe(
    'http://127.0.0.1:7890',
  );
  expect(discovered).toBe(1);
  expect(await resolveWebTransport({ proxy: 'direct' }, { env, systemProxy })).toEqual({
    proxy: {},
    recoverFakeIp: true,
  });
  expect(discovered).toBe(1);
  expect(
    (await resolveWebTransport({ proxy: 'http://manual.test:88' }, { env, systemProxy })).proxy,
  ).toEqual({ http: 'http://manual.test:88', https: 'http://manual.test:88' });
  expect(environmentWebProxy({ HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: '' })).toBeUndefined();
  for (const [proxy, code] of [
    ['socks5://localhost:7890', 'web_proxy_protocol_unsupported'],
    ['http://user:secret@localhost:7890', 'web_proxy_auth_unsupported'],
    ['http://localhost:7890/path', 'web_proxy_invalid'],
  ])
    await expect(resolveWebTransport({ proxy }, { env, systemProxy })).rejects.toThrow(code);
  expect(
    await resolveWebTransport(undefined, {
      env: { HTTPS_PROXY: 'socks5://localhost:7890' },
      systemProxy,
    }),
  ).toMatchObject({ unavailableReason: 'web_proxy_protocol_unsupported' });
  expect(
    await resolveWebTransport(undefined, {
      env: {},
      systemProxy: async () => {
        throw new (await import('@kite-ai/agent/web-fetch')).WebFetchError(
          'web_proxy_discovery_failed',
        );
      },
    }),
  ).toMatchObject({ unavailableReason: 'web_proxy_discovery_failed' });
  await expect(resolveWebTransport({ proxy: 'direct', unsafe: true })).rejects.toThrow(
    'web_configuration_invalid',
  );
});

test('registered Windows and macOS manual settings are parsed without PAC execution or port guessing', () => {
  expect(
    windowsWebProxy(
      'ProxyEnable    REG_DWORD    0x1\n ProxyServer    REG_SZ    127.0.0.1:7890\n ProxyOverride    REG_SZ    <local>;*.example.test',
    ),
  ).toEqual({
    http: 'http://127.0.0.1:7890',
    https: 'http://127.0.0.1:7890',
    noProxy: '<local>;*.example.test',
  });
  expect(
    windowsWebProxy(
      'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=proxy.test:80;https=https://secure.test:443;socks=ignored.test:1080',
    ),
  ).toEqual({ http: 'http://proxy.test', https: 'https://secure.test', noProxy: '' });
  expect(windowsWebProxy('ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ stale.test:80')).toEqual(
    {},
  );
  expect(() =>
    windowsWebProxy('ProxyEnable REG_DWORD 0x0\nAutoConfigURL REG_SZ http://config.test/proxy.pac'),
  ).toThrow('web_proxy_pac_unsupported');
  expect(
    macWebProxy(
      '<dictionary> {\n HTTPEnable : 1\n HTTPProxy : localhost\n HTTPPort : 7890\n HTTPSEnable : 1\n HTTPSProxy : localhost\n HTTPSPort : 7890\n ExceptionsList : <array> {\n 0 : *.example.test\n }\n ExcludeSimpleHostnames : 1\n}',
    ),
  ).toEqual({
    http: 'http://localhost:7890',
    https: 'http://localhost:7890',
    noProxy: '*.example.test,<local>',
  });
  expect(() => macWebProxy('ProxyAutoConfigEnable : 1')).toThrow('web_proxy_pac_unsupported');
});

test('enabled macOS SOCKS settings fail closed even alongside manual HTTP routes', async () => {
  const socks = 'SOCKSEnable : 1\n SOCKSProxy : proxy.test\n SOCKSPort : 1080';
  const http = 'HTTPEnable : 1\n HTTPProxy : proxy.test\n HTTPPort : 8080';
  const https = 'HTTPSEnable : 1\n HTTPSProxy : proxy.test\n HTTPSPort : 8080';
  for (const output of [
    socks,
    `${socks}\n${http}`,
    `${socks}\n${https}`,
    `${socks}\n${http}\n${https}`,
  ]) {
    expect(() => macWebProxy(output)).toThrow('web_proxy_protocol_unsupported');
    const { unavailableReason, ...transport } = await resolveWebTransport(undefined, {
      env: {},
      systemProxy: async () => macWebProxy(output),
    });
    expect(unavailableReason).toBe('web_proxy_protocol_unsupported');
    let admission = 0,
      dns = 0,
      audit = 0;
    const configuration = createWebFetchConfiguration({
      unavailableReason,
      network: {
        ...transport,
        policy: { mode: 'public' },
        admitHop: async () => {
          admission++;
          return { allowed: true, revision: 'fixture' };
        },
        resolveAddresses: async () => {
          dns++;
          throw new Error('unexpected_network_resolution');
        },
      },
      extractor: { extract: async () => ({ title: '', content: 'unused' }) },
    });
    expect(configuration.snapshot.transport?.unavailableReason).toBe(unavailableReason);
    const binding = configuration.bind();
    try {
      // This synthetic dispatched Tool context performs no Core, OS discovery or socket I/O.
      const result = await binding.extension.tools![0]!.execute({ url: 'https://fixture.test' }, {
        executionId: 'e',
        sessionId: 's',
        signal: AbortSignal.timeout(2000),
        getExecution: async () => ({ originStoreId: 'store' }),
        records: {
          write: async () => {
            audit++;
            throw new Error('unexpected_network_audit');
          },
        },
      } as unknown as ToolContext);
      expect(result).toEqual({ outcome: 'failed', content: 'web_proxy_protocol_unsupported' });
      expect([admission, dns, audit]).toEqual([0, 0, 0]);
    } finally {
      await binding.dispose();
    }
  }
  expect(macWebProxy('SOCKSEnable : 0\n SOCKSProxy : stale.test\n SOCKSPort : 1080')).toEqual({
    noProxy: '',
  });
  expect(macWebProxy(`${http}\n SOCKSEnable : 0`)).toEqual({
    http: 'http://proxy.test:8080',
    noProxy: '',
  });
});
