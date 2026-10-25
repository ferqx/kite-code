import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { type PinnedWebNetworkOptions, WebFetchError } from '@kite-ai/agent/web-fetch';

type Proxy = NonNullable<PinnedWebNetworkOptions['proxy']>;
type Transport = Pick<PinnedWebNetworkOptions, 'proxy' | 'dnsOverHttps' | 'recoverFakeIp'> & {
  unavailableReason?: string;
};
type Environment = Readonly<Record<string, string | undefined>>;
function endpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebFetchError('web_proxy_invalid');
  }
  if (url.username || url.password) throw new WebFetchError('web_proxy_auth_unsupported');
  if (!['http:', 'https:'].includes(url.protocol))
    throw new WebFetchError('web_proxy_protocol_unsupported');
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new WebFetchError('web_proxy_invalid');
  return url.origin;
}
export function environmentWebProxy(env: Environment): Proxy | undefined {
  const http = env.http_proxy ?? env.HTTP_PROXY;
  const https = env.https_proxy ?? env.HTTPS_PROXY;
  if (!http && !https) return;
  return {
    ...(http ? { http: endpoint(http) } : {}),
    ...(https ? { https: endpoint(https) } : {}),
    noProxy: env.no_proxy ?? env.NO_PROXY ?? '',
  };
}
/** Only registered manual endpoints. Never execute PAC/WPAD or guess local ports. */
export function windowsWebProxy(output: string): Proxy {
  const read = (key: string) =>
    new RegExp(`^\\s*${key}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'mi').exec(output)?.[1];
  if (read('ProxyEnable') !== '0x1') {
    if (read('AutoConfigURL')) throw new WebFetchError('web_proxy_pac_unsupported');
    return {};
  }
  const server = read('ProxyServer');
  if (!server) throw new WebFetchError('web_proxy_invalid');
  const routes: { http?: string; https?: string; noProxy?: string } = {
    noProxy: read('ProxyOverride') ?? '',
  };
  const parse = (value: string) => endpoint(value.includes('://') ? value : `http://${value}`);
  if (!server.includes('=')) routes.http = routes.https = parse(server);
  else
    for (const entry of server.split(';')) {
      const match = /^(http|https)=(.+)$/i.exec(entry.trim());
      if (match) routes[match[1]!.toLowerCase() as 'http' | 'https'] = parse(match[2]!);
    }
  if (!routes.http && !routes.https) throw new WebFetchError('web_proxy_unsupported');
  return routes;
}
export function macWebProxy(output: string): Proxy {
  const read = (key: string) =>
    new RegExp(`^\\s*${key}\\s*:\\s*(.*?)\\s*$`, 'mi').exec(output)?.[1];
  const routes: { http?: string; https?: string; noProxy?: string } = {};
  for (const [prefix, key] of [
    ['HTTP', 'http'],
    ['HTTPS', 'https'],
  ] as const) {
    if (read(`${prefix}Enable`) !== '1') continue;
    const host = read(`${prefix}Proxy`),
      port = read(`${prefix}Port`);
    if (!host || !port || !/^\d+$/.test(port)) throw new WebFetchError('web_proxy_invalid');
    routes[key] = endpoint(`http://${host.includes(':') ? `[${host}]` : host}:${port}`);
  }
  if (
    !routes.http &&
    !routes.https &&
    (read('ProxyAutoConfigEnable') === '1' || read('ProxyAutoDiscoveryEnable') === '1')
  )
    throw new WebFetchError('web_proxy_pac_unsupported');
  const exceptions = /ExceptionsList\s*:\s*<array>\s*\{([^}]*)\}/m.exec(output)?.[1];
  routes.noProxy = [...(exceptions?.matchAll(/^\s*\d+\s*:\s*(.*?)\s*$/gm) ?? [])]
    .map((match) => match[1]!)
    .join(',');
  if (read('ExcludeSimpleHostnames') === '1') routes.noProxy += ',<local>';
  return routes;
}
async function systemWebProxy(): Promise<Proxy> {
  if (!['win32', 'darwin'].includes(process.platform)) return {};
  const windows = process.platform === 'win32';
  const file = windows
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
    : '/usr/sbin/scutil';
  const args = windows
    ? ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']
    : ['--proxy'];
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: 1500, maxBuffer: 65536, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error) reject(new WebFetchError('web_proxy_discovery_failed'));
        else resolve(stdout);
      },
    );
  });
  return windows ? windowsWebProxy(output) : macWebProxy(output);
}
/** User authority only; project/model/page data must never select an exit or resolver. */
export async function resolveWebTransport(
  raw: unknown,
  inputs: { env?: Environment; systemProxy?: () => Promise<Proxy> } = {},
): Promise<Transport> {
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw)))
    throw new WebFetchError('web_configuration_invalid');
  const value = (raw ?? {}) as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['proxy', 'dns'].includes(key)))
    throw new WebFetchError('web_configuration_invalid');
  const mode = value.proxy ?? 'auto';
  if (typeof mode !== 'string') throw new WebFetchError('web_configuration_invalid');
  let proxy: Proxy = {},
    unavailableReason: string | undefined;
  if (mode === 'direct') proxy = {};
  else if (mode !== 'auto') proxy = { http: endpoint(mode), https: endpoint(mode) };
  else {
    const env = inputs.env ?? { ...process.env };
    try {
      proxy = environmentWebProxy(env) ?? (await (inputs.systemProxy ?? systemWebProxy)());
      const bypass = env.no_proxy ?? env.NO_PROXY;
      if (bypass !== undefined) proxy = { ...proxy, noProxy: bypass };
    } catch (error) {
      if (!(error instanceof WebFetchError)) throw error;
      // An unsupported automatic exit fails only the dispatched Web Tool, not a file-only task.
      unavailableReason = error.code;
    }
  }
  let dns: Transport['dnsOverHttps'];
  if (value.dns !== undefined) {
    const rawDns = value.dns as Record<string, unknown>;
    if (
      !rawDns ||
      typeof rawDns !== 'object' ||
      Array.isArray(rawDns) ||
      Object.keys(rawDns).some((key) => !['url', 'addresses'].includes(key)) ||
      typeof rawDns.url !== 'string' ||
      !Array.isArray(rawDns.addresses) ||
      rawDns.addresses.some((address) => typeof address !== 'string')
    )
      throw new WebFetchError('web_dns_configuration_invalid');
    dns = { url: rawDns.url, addresses: [...rawDns.addresses] };
  }
  return {
    proxy: { ...proxy },
    recoverFakeIp: true,
    ...(dns ? { dnsOverHttps: dns } : {}),
    ...(unavailableReason ? { unavailableReason } : {}),
  };
}
