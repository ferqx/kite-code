import { createHash } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { AgentError } from '@kite-ai/agent';
import { WebFetchError } from '@kite-ai/agent/web-fetch';
// Bind the pinned package explicitly rather than a host-provided Undici alias.
import undici from 'undici/index.js';
import { systemWebProxy } from './web-fetch-proxy';

type Proxy = Awaited<ReturnType<typeof systemWebProxy>>;
type Environment = Readonly<Record<string, string | undefined>>;

/** Windows/macOS bypass entries also permit host wildcards and <local>. */
function bypassed(target: URL, entries: string | undefined, envProxy = false): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return (entries ?? '').split(/[;,\s]+/).some((raw) => {
    const entry = raw.toLowerCase();
    if (!entry) return false;
    if (entry === '*' || (entry === '<local>' && !/[.:]/.test(host))) return true;
    const subnet = /^([^/]+)\/(\d+)$/.exec(entry);
    if (envProxy && subnet) {
      const family = isIP(host);
      const address = subnet[1]!;
      const prefix = Number(subnet[2]);
      if (!family || family !== isIP(address) || prefix > (family === 4 ? 32 : 128)) return false;
      const block = new BlockList();
      const type = family === 4 ? 'ipv4' : 'ipv6';
      block.addSubnet(address, prefix, type);
      return block.check(host, type);
    }
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!match || (match[2] && match[2] !== port)) return false;
    const name = match[1]!.replace(/^\[|\]$/g, '');
    if (name.startsWith('.')) return host === name.slice(1) || host.endsWith(name);
    const pattern = name
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(host) || (envProxy && host.endsWith(`.${name}`));
  });
}

const poolOptions = { keepAliveTimeout: 30_000, connections: 8 };

function createPool(endpoint: string | false) {
  const { Agent, ProxyAgent, Socks5ProxyAgent } = undici;
  if (!endpoint) return new Agent(poolOptions);
  try {
    const proxy = new URL(endpoint);
    if (proxy.protocol === 'socks:' || proxy.protocol === 'socks5:')
      return new Socks5ProxyAgent(proxy, poolOptions);
    if (!['http:', 'https:'].includes(proxy.protocol)) throw Error();
    const token =
      proxy.username || proxy.password
        ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`
        : undefined;
    proxy.username = '';
    proxy.password = '';
    return new ProxyAgent({
      ...poolOptions,
      uri: proxy.href,
      proxyTunnel: false,
      ...(token ? { token } : {}),
    });
  } catch {
    throw new AgentError('model_proxy_invalid');
  }
}

/** A trusted model binding owns its network choice; never mutate process.env. */
export async function resolveModelTransport(
  inputs: { env?: Environment; systemProxy?: () => Promise<Proxy>; fetch?: typeof fetch } = {},
) {
  const env = { ...(inputs.env ?? process.env) };
  const environment = Object.fromEntries(
    [
      'http_proxy',
      'HTTP_PROXY',
      'https_proxy',
      'HTTPS_PROXY',
      'no_proxy',
      'NO_PROXY',
      'all_proxy',
      'ALL_PROXY',
    ].map((key) => [key, env[key] ?? null]),
  );
  // Explicit proxy environment, including authenticated proxies and NO_PROXY/CIDR,
  // takes precedence over OS proxy discovery.
  const explicit = [
    'http_proxy',
    'HTTP_PROXY',
    'https_proxy',
    'HTTPS_PROXY',
    'all_proxy',
    'ALL_PROXY',
  ].some((key) => !!env[key]);
  let proxy: Proxy = {};
  if (!explicit)
    try {
      proxy = { ...(await (inputs.systemProxy ?? systemWebProxy)()) };
    } catch (error) {
      if (!(error instanceof WebFetchError)) throw error;
      throw new AgentError(error.code.replace(/^web_/, 'model_'));
    }
  const snapshot = {
    digest: createHash('sha256').update(JSON.stringify({ environment, proxy })).digest('hex'),
  };
  const bypass = env.no_proxy ?? env.NO_PROXY ?? proxy.noProxy;
  const pools = new Map<string | false, ReturnType<typeof createPool>>();
  function selectedProxy(target: URL): string | false {
    if (bypassed(target, bypass, explicit)) return false;
    if (!explicit) return (target.protocol === 'https:' ? proxy.https : proxy.http) || false;
    const http = env.http_proxy || env.HTTP_PROXY;
    const https = env.https_proxy || env.HTTPS_PROXY;
    const all = env.all_proxy || env.ALL_PROXY;
    return (target.protocol === 'https:' ? https || all : http || all) || false;
  }
  const dispatcher = new undici.Dispatcher();
  dispatcher.dispatch = (options, handler) => {
    if (closed) throw new AgentError('model_transport_closed');
    // Fetch can dispatch more than once on redirects. Select from the same
    // binding for each origin, including a redirect across NO_PROXY.
    const endpoint = selectedProxy(new URL(String(options.origin)));
    let pool = pools.get(endpoint);
    if (!pool) {
      pool = createPool(endpoint);
      pools.set(endpoint, pool);
    }
    return pool.dispatch(options, handler);
  };
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    snapshot,
    close() {
      closed = true;
      // Run disposal happens after Model settlement; aborting active requests remains
      // the original caller Signal's job. Retain the same cleanup result on retries.
      closing ??= Promise.resolve().then(async () => {
        const cleanup = await Promise.allSettled(
          [...pools.values()].map(async (pool) => pool.close()),
        );
        const failures = cleanup.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : [],
        );
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'model_transport_cleanup_unknown');
      });
      return closing;
    },
    fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (closed) throw new AgentError('model_transport_closed');
      if (inputs.fetch) {
        const target = new URL(input instanceof Request ? input.url : String(input));
        return inputs.fetch(input, { ...init, proxy: selectedProxy(target) } as RequestInit);
      }
      // The pinned Fetch implementation has its own Request constructor. Preserve
      // the caller's stream and options when it receives a native Web Request.
      const request =
        input instanceof Request
          ? new undici.Request(input.url, {
              method: input.method,
              headers: [...input.headers],
              body: input.body as import('undici').BodyInit | null,
              signal: input.signal,
              redirect: input.redirect,
              credentials: input.credentials,
              cache: input.cache,
              integrity: input.integrity,
              keepalive: input.keepalive,
              mode: input.mode,
              referrer: input.referrer,
              referrerPolicy: input.referrerPolicy,
              duplex: 'half',
            })
          : input;
      return undici.fetch(request, {
        ...(init as import('undici').RequestInit | undefined),
        dispatcher,
      }) as unknown as Promise<Response>;
    },
  };
}
