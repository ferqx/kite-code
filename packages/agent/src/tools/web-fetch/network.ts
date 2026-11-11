import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { defaultWebDns, fakeIp, resolveWebDns, type WebDnsSettings } from './dns';
import { parsingLimit, WebFetchError } from './network-errors';
import { openProxyTunnel, proxyUrl, selectedProxy, type WebProxySettings } from './proxy';

export type { WebDnsSettings } from './dns';
export { parsingLimit, WebFetchError } from './network-errors';
export type { WebProxySettings } from './proxy';
export interface WebHop {
  readonly originalUrl: string;
  readonly url: string;
  readonly hop: number;
  readonly resource: 'page' | 'robots';
  readonly executionId: string;
  readonly sessionId: string;
  readonly originStoreId: string;
}
export interface WebResponse {
  readonly status: number;
  readonly contentType: string;
  readonly location?: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly addresses: readonly { address: string; family: 4 | 6 }[];
  readonly admissionRevision: string;
}
export interface WebAdmissionFacts {
  readonly addresses: readonly { address: string; family: 4 | 6 }[];
  readonly admissionRevision: string;
}
export type WebFetchStage =
  | 'prepare'
  | 'proxy_configuration'
  | 'queue'
  | 'admission'
  | 'system_dns'
  | 'https_dns'
  | 'destination_check'
  | 'audit'
  | 'request'
  | 'connect'
  | 'robots'
  | 'response_headers'
  | 'response_body'
  | 'extract'
  | 'artifact';
interface WebHopOptions {
  signal: AbortSignal;
  beforeConnect?: (facts: WebAdmissionFacts) => Promise<void>;
  onStage?: (stage: WebFetchStage) => void;
  /** Starts the initial robots transfer budget after admission and resolution. */
  startTransport?: () => AbortSignal;
}
export interface WebNetworkPort {
  request(binding: WebHop, options: WebHopOptions): Promise<WebResponse>;
  openRequest?(): Pick<WebNetworkPort, 'request'>;
}
export type WebNetworkPolicy =
  | { mode: 'off' | 'public' }
  | { mode: 'allowlist'; hosts: readonly string[] };
export interface PinnedWebNetworkOptions {
  readonly policy: WebNetworkPolicy;
  /** Exact current host admission. Ordinary Tool permission is checked independently by Core. */
  readonly admitHop: (
    binding: Readonly<WebHop>,
    options: { signal: AbortSignal },
  ) => Promise<{ allowed: boolean; revision: string }>;
  readonly resolveAddresses?: (
    hostname: string,
  ) => Promise<readonly { address: string; family: 4 | 6 }[]>;
  /** Explicit test qualification. Never accepted from JSONC or Tool input. */
  readonly allowLoopbackForTests?: boolean;
  /** Host-selected exit only. Never supplied by a page or model Tool input. */
  readonly proxy?: WebProxySettings;
  readonly dnsOverHttps?: WebDnsSettings;
  /** Default Service opts in; low-level custom hosts retain their original DNS policy. */
  readonly recoverFakeIp?: boolean;
  /** Re-resolve a system Teredo answer when the target and resolver use the same proxy. */
  readonly recoverProxiedTeredoDns?: boolean;
  /** Trusted host CA, including isolated TLS fixtures. Certificate and hostname checks stay on. */
  readonly certificateAuthority?: string;
}
export function webUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WebFetchError('web_url_invalid');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    ['metadata.google.internal', 'instance-data.ec2.internal'].includes(url.hostname.toLowerCase())
  )
    throw new WebFetchError('web_url_denied');
  url.hash = '';
  return url;
}
// 2001::/32 is a transition prefix, not a routable destination for this tool.
function isTeredoAddress(address: string): boolean {
  return isIP(address) === 6 && /^2001:(?::|0{1,4}:)/.test(address);
}
function publicAddress(address: string, loopback: boolean) {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    const n = (parts[0]! * 2 ** 24 + parts[1]! * 2 ** 16 + parts[2]! * 256 + parts[3]!) >>> 0;
    const inRange = (base: number, bits: number) =>
      Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
    if (inRange(0x7f000000, 8)) return loopback;
    return ![
      [0, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0000000, 24],
      [0xc0000200, 24],
      [0xc0586300, 24],
      [0xc0a80000, 16],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 3],
    ].some(([base, bits]) => inRange(base!, bits!));
  }
  if (isIP(address) === 6) {
    if (address.includes('%')) return false;
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    if (canonical === '::1') return loopback;
    // Reject mapped IPv4, transition, link-local, metadata, special-use and non-global ranges.
    return (
      /^[23][0-9a-f]{3}:/.test(canonical) &&
      !/^2002:|^2001:(?:[0-9a-f]{0,2}:|1[0-9a-f]{2}:|db8:)|^3fff:[0-9a-f]{0,3}:/.test(canonical)
    );
  }
  return false;
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
/** One owned connection per hop; exits are explicit host selections, never ambient here. */
export function createPinnedWebNetworkPort(options: PinnedWebNetworkOptions): WebNetworkPort {
  options = {
    ...options,
    ...(options.proxy
      ? {
          proxy: Object.freeze({
            ...options.proxy,
            ...(options.proxy.http ? { http: proxyUrl(options.proxy.http) } : {}),
            ...(options.proxy.https ? { https: proxyUrl(options.proxy.https) } : {}),
          }),
        }
      : {}),
    ...(options.dnsOverHttps ? { dnsOverHttps: structuredClone(options.dnsOverHttps) } : {}),
  };
  const dns = options.dnsOverHttps ?? defaultWebDns;
  const dnsUrl = webUrl(dns.url);
  if (
    dnsUrl.protocol !== 'https:' ||
    dnsUrl.search ||
    dns.url.includes('#') ||
    !Array.isArray(dns.addresses) ||
    !dns.addresses.length ||
    dns.addresses.length > 8 ||
    dns.addresses.some((address) => !publicAddress(address, false))
  )
    throw new WebFetchError('web_dns_configuration_invalid');
  const policy = structuredClone(options.policy);
  if (
    !['off', 'public', 'allowlist'].includes(policy.mode) ||
    (policy.mode === 'allowlist' &&
      (!Array.isArray(policy.hosts) ||
        policy.hosts.some((host) => !host || host.includes('/') || host.includes('*'))))
  )
    throw new WebFetchError('web_policy_invalid');
  const resolve =
    options.resolveAddresses ??
    (async (hostname: string) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((value) => ({
        address: value.address,
        family: value.family as 4 | 6,
      })));
  const admit = options.admitHop,
    loopback = options.allowLoopbackForTests === true;
  type ResolvedAddresses = WebAdmissionFacts['addresses'];
  async function resolveTarget(
    url: URL,
    hostname: string,
    literalFamily: number,
    signal: AbortSignal,
    onStage: WebHopOptions['onStage'],
  ): Promise<ResolvedAddresses> {
    let addresses: readonly { address: string; family: 4 | 6 }[];
    onStage?.('system_dns');
    try {
      addresses = literalFamily
        ? [{ address: hostname, family: literalFamily as 4 | 6 }]
        : options.dnsOverHttps
          ? []
          : await abortable(resolve(hostname), signal);
    } catch {
      signal.throwIfAborted();
      throw new WebFetchError('web_dns_unavailable');
    }
    signal.throwIfAborted();
    const validSystemAnswer =
      !literalFamily &&
      addresses.length > 0 &&
      addresses.length <= 64 &&
      addresses.every(({ address, family }) => !address.includes('%') && isIP(address) === family);
    const gateway =
      validSystemAnswer && options.recoverProxiedTeredoDns
        ? selectedProxy(options.proxy, url)
        : undefined;
    if (
      !literalFamily &&
      (options.dnsOverHttps ||
        (options.recoverFakeIp && validSystemAnswer && addresses.every((x) => fakeIp(x.address))) ||
        (gateway &&
          selectedProxy(options.proxy, dnsUrl) === gateway &&
          addresses.some((x) => isTeredoAddress(x.address)) &&
          addresses.every((x) => isTeredoAddress(x.address) || publicAddress(x.address, false))))
    ) {
      onStage?.('https_dns');
      addresses = await resolveWebDns(hostname, async (body) => {
        const response = await requestPinned(
          dnsUrl,
          dns.addresses[0]!,
          signal,
          options.proxy,
          options.certificateAuthority,
          {
            method: 'POST',
            headers: {
              accept: 'application/dns-message',
              'content-type': 'application/dns-message',
              'content-length': String(body.byteLength),
            },
            body,
          },
        );
        if (
          response.status !== 200 ||
          response.contentType.split(';')[0]!.trim().toLowerCase() !== 'application/dns-message'
        ) {
          await response.body.cancel();
          throw new WebFetchError('web_dns_unavailable');
        }
        const reader = response.body.getReader(),
          chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            size += next.value.byteLength;
            if (size > 65535) throw new WebFetchError('web_dns_unavailable');
            chunks.push(next.value);
          }
          return Buffer.concat(chunks);
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      });
    }
    onStage?.('destination_check');
    if (
      !addresses.length ||
      addresses.length > 64 ||
      addresses.some((x) => isIP(x.address) !== x.family || !publicAddress(x.address, loopback))
    )
      throw new WebFetchError('web_destination_denied');
    return Object.freeze(addresses.map((value) => Object.freeze({ ...value })));
  }
  interface RequestScope {
    initial?: { key: string; addresses: ResolvedAddresses };
  }
  async function request(
    input: WebHop,
    { signal, beforeConnect, onStage, startTransport }: WebHopOptions,
    scope?: RequestScope,
  ): Promise<WebResponse> {
    const binding = Object.freeze(structuredClone(input));
    const url = webUrl(binding.url),
      hostname = url.hostname.replace(/^\[|\]$/g, ''),
      literalFamily = isIP(hostname);
    onStage?.('admission');
    signal.throwIfAborted();
    if (
      !binding.executionId ||
      !binding.originStoreId ||
      !binding.sessionId ||
      policy.mode === 'off' ||
      (policy.mode === 'allowlist' &&
        !policy.hosts.some((host) => host.toLowerCase() === hostname.toLowerCase()))
    )
      throw new WebFetchError('web_network_denied');
    let admission: { allowed: boolean; revision: string };
    try {
      admission = await abortable(Promise.resolve(admit(binding, { signal })), signal);
    } catch {
      signal.throwIfAborted();
      throw new WebFetchError('web_network_denied');
    }
    if (!admission.allowed || !admission.revision || admission.revision.length > 256)
      throw new WebFetchError('web_network_denied');
    signal.throwIfAborted();
    const key =
      scope && binding.hop === 0 && url.origin === webUrl(binding.originalUrl).origin
        ? JSON.stringify([
            binding.originalUrl,
            binding.executionId,
            binding.sessionId,
            binding.originStoreId,
          ])
        : undefined;
    const previous = scope?.initial;
    let captured: ResolvedAddresses;
    if (scope && key && binding.resource === 'page' && previous?.key === key) {
      delete scope.initial;
      captured = previous.addresses;
    } else {
      captured = await resolveTarget(url, hostname, literalFamily, signal, onStage);
      if (scope && key && binding.resource === 'robots')
        scope.initial = { key, addresses: captured };
    }
    signal.throwIfAborted();
    if (startTransport) signal = startTransport();
    onStage?.('audit');
    if (beforeConnect)
      await abortable(
        beforeConnect({ addresses: captured, admissionRevision: admission.revision }),
        signal,
      );
    signal.throwIfAborted();
    onStage?.('connect');
    const response = await requestPinned(
      url,
      captured[0]!.address,
      signal,
      options.proxy,
      options.certificateAuthority,
    );
    return { ...response, addresses: captured, admissionRevision: admission.revision };
  }
  return {
    request,
    openRequest() {
      const scope: RequestScope = {};
      return { request: (input, options) => request(input, options, scope) };
    },
  };
}

async function requestPinned(
  url: URL,
  address: string,
  signal: AbortSignal,
  proxy?: WebProxySettings,
  ca?: string,
  extra?: { method: string; headers: Record<string, string>; body: Uint8Array },
) {
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const pinned = { address, family: isIP(address) };
  const gateway = selectedProxy(proxy, url);
  const tunnel = gateway ? await openProxyTunnel(gateway, url, address, signal, ca) : undefined;
  if (signal.aborted) {
    tunnel?.destroy();
    signal.throwIfAborted();
  }
  const agentOptions = { keepAlive: false, proxyEnv: {} };
  const agent =
    url.protocol === 'https:'
      ? new HttpsAgent({ ...agentOptions, ...(ca ? { ca } : {}) })
      : new HttpAgent(agentOptions);
  if (tunnel)
    agent.createConnection = (_options, callback) => {
      callback?.(null, tunnel);
      return tunnel;
    };
  return new Promise<Omit<WebResponse, 'addresses' | 'admissionRevision'>>(
    (resolveResponse, reject) => {
      let failBody: (() => void) | undefined;
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          agent,
          method: extra?.method ?? 'GET',
          headers: {
            host: url.host,
            accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
            'accept-encoding': 'gzip,deflate,br',
            'user-agent': 'KiteCode/1.0 WebFetchBot',
            ...extra?.headers,
          },
          servername: hostname,
          rejectUnauthorized: true,
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all)
              (
                callback as unknown as (
                  error: null,
                  values: { address: string; family: number }[],
                ) => void
              )(null, [pinned]);
            else callback(null, pinned.address, pinned.family);
          },
        },
        (incoming) => {
          const encoding = String(incoming.headers['content-encoding'] ?? 'identity').toLowerCase();
          const source =
            encoding === 'gzip'
              ? incoming.pipe(createGunzip())
              : encoding === 'deflate'
                ? incoming.pipe(createInflate())
                : encoding === 'br'
                  ? incoming.pipe(createBrotliDecompress())
                  : incoming;
          let finished = false,
            size = 0;
          const cleanup = () => {
            streamAbort?.();
            signal.removeEventListener('abort', abort);
            source.destroy();
            incoming.destroy();
            request.destroy();
            agent.destroy();
            tunnel?.destroy();
          };
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const fail = () => {
                if (!finished) {
                  finished = true;
                  controller.error(new WebFetchError('web_response_failed'));
                }
                cleanup();
              };
              // A completed encoded message may not emit aborted when its decoder is destroyed.
              // Settle the Web body before cleanup removes its abort listener.
              failBody = fail;
              source.on('data', (chunk: Buffer) => {
                if (finished) return;
                size += chunk.byteLength;
                if (size > parsingLimit) {
                  finished = true;
                  controller.error(new WebFetchError('web_response_too_large'));
                  cleanup();
                  return;
                }
                controller.enqueue(new Uint8Array(chunk));
                if ((controller.desiredSize ?? 0) <= 0) source.pause();
              });
              source.once('end', () => {
                if (!finished) {
                  finished = true;
                  controller.close();
                }
                cleanup();
              });
              source.once('error', fail);
              incoming.once('aborted', fail);
              incoming.once('error', fail);
              signal.addEventListener('abort', fail, { once: true });
              streamAbort = () => signal.removeEventListener('abort', fail);
              if (signal.aborted) fail();
            },
            pull() {
              source.resume();
            },
            cancel() {
              finished = true;
              cleanup();
            },
          });
          if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) {
            cleanup();
            reject(new WebFetchError('web_encoding_unsupported'));
            return;
          }
          resolveResponse({
            status: incoming.statusCode ?? 500,
            contentType: String(incoming.headers['content-type'] ?? 'text/plain'),
            ...(incoming.headers.location ? { location: incoming.headers.location } : {}),
            body: stream,
          });
        },
      );
      let streamAbort: (() => void) | undefined;
      const abort = () => {
        failBody?.();
        request.destroy();
        agent.destroy();
        tunnel?.destroy();
        reject(signal.reason ?? new WebFetchError('web_cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      request.once('error', () => {
        agent.destroy();
        tunnel?.destroy();
        reject(new WebFetchError('web_request_failed'));
      });
      request.once('close', () => {
        signal.removeEventListener('abort', abort);
        agent.destroy();
      });
      if (signal.aborted) abort();
      else request.end(extra?.body);
    },
  );
}
