import { lookup } from 'node:dns/promises';
import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

export const parsingLimit = 5_000_000;
export class WebFetchError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'WebFetchError';
  }
}
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
export interface WebNetworkPort {
  request(
    binding: WebHop,
    options: { signal: AbortSignal; beforeConnect?: (facts: WebAdmissionFacts) => Promise<void> },
  ): Promise<WebResponse>;
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
/** One real socket per hop. No proxy/environment headers and no implicit redirect/fetch fallback. */
export function createPinnedWebNetworkPort(options: PinnedWebNetworkOptions): WebNetworkPort {
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
  return {
    async request(input, { signal, beforeConnect }) {
      const binding = Object.freeze(structuredClone(input));
      const url = webUrl(binding.url),
        hostname = url.hostname.replace(/^\[|\]$/g, '');
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
      let addresses: readonly { address: string; family: 4 | 6 }[];
      try {
        addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
          : await abortable(resolve(hostname), signal);
      } catch {
        signal.throwIfAborted();
        throw new WebFetchError('web_dns_unavailable');
      }
      signal.throwIfAborted();
      if (
        !addresses.length ||
        addresses.length > 64 ||
        addresses.some((x) => isIP(x.address) !== x.family || !publicAddress(x.address, loopback))
      )
        throw new WebFetchError('web_destination_denied');
      const captured = Object.freeze(addresses.map((value) => Object.freeze({ ...value }))),
        pinned = captured[0]!;
      if (beforeConnect)
        await abortable(
          beforeConnect({ addresses: captured, admissionRevision: admission.revision }),
          signal,
        );
      signal.throwIfAborted();
      const agentOptions = { keepAlive: false, proxyEnv: {} };
      const agent =
        url.protocol === 'https:' ? new HttpsAgent(agentOptions) : new HttpAgent(agentOptions);
      return new Promise<WebResponse>((resolveResponse, reject) => {
        let cleanBody: (() => void) | undefined;
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            agent,
            method: 'GET',
            headers: {
              host: url.host,
              accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
              'accept-encoding': 'gzip,deflate,br',
              'user-agent': 'KiteCode/1.0 WebFetchBot',
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
            const encoding = String(
              incoming.headers['content-encoding'] ?? 'identity',
            ).toLowerCase();
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
            };
            cleanBody = cleanup;
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                const fail = () => {
                  if (!finished) {
                    finished = true;
                    controller.error(new WebFetchError('web_response_failed'));
                  }
                  cleanup();
                };
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
              addresses: captured,
              admissionRevision: admission.revision,
            });
          },
        );
        let streamAbort: (() => void) | undefined;
        const abort = () => {
          cleanBody?.();
          request.destroy();
          agent.destroy();
          reject(signal.reason ?? new WebFetchError('web_cancelled'));
        };
        signal.addEventListener('abort', abort, { once: true });
        request.once('error', () => {
          agent.destroy();
          reject(new WebFetchError('web_request_failed'));
        });
        request.once('close', () => {
          signal.removeEventListener('abort', abort);
          agent.destroy();
        });
        if (signal.aborted) abort();
        else request.end();
      });
    },
  };
}
