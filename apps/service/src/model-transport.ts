import { createHash } from 'node:crypto';
import { AgentError } from '@kite-ai/agent';
import { WebFetchError } from '@kite-ai/agent/web-fetch';
import { systemWebProxy } from './web-fetch-proxy';

type Proxy = Awaited<ReturnType<typeof systemWebProxy>>;
type Environment = Readonly<Record<string, string | undefined>>;

/** Windows/macOS bypass entries also permit host wildcards and <local>. */
function bypassed(target: URL, entries: string | undefined): boolean {
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  return (entries ?? '').split(/[;,\s]+/).some((raw) => {
    const entry = raw.toLowerCase();
    if (!entry) return false;
    if (entry === '*' || (entry === '<local>' && !/[.:]/.test(host))) return true;
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry);
    if (!match || (match[2] && match[2] !== port)) return false;
    const name = match[1]!.replace(/^\[|\]$/g, '');
    if (name.startsWith('.')) return host === name.slice(1) || host.endsWith(name);
    const pattern = name
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${pattern}$`).test(host);
  });
}

/** A trusted model binding owns its network choice; never mutate process.env. */
export async function resolveModelTransport(
  inputs: { env?: Environment; systemProxy?: () => Promise<Proxy>; fetch?: typeof fetch } = {},
) {
  const env = inputs.env ?? { ...process.env };
  const transportFetch = inputs.fetch ?? globalThis.fetch;
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
  // Preserve Bun's existing environment semantics, including authenticated proxies,
  // NO_PROXY/CIDR and explicit values. Only absent proxy environment uses the OS.
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
  if (explicit) return { fetch: transportFetch, snapshot };
  const bypass = env.no_proxy ?? env.NO_PROXY ?? proxy.noProxy;
  return {
    snapshot,
    fetch: Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const target = new URL(input instanceof Request ? input.url : String(input));
        const endpoint = bypassed(target, bypass)
          ? undefined
          : target.protocol === 'https:'
            ? proxy.https
            : proxy.http;
        return transportFetch(input, { ...init, proxy: endpoint ?? false } as RequestInit);
      },
      { preconnect: transportFetch.preconnect },
    ),
  };
}
