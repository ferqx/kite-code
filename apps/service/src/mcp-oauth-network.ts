import { lookup } from 'node:dns/promises';
import { type ClientRequest, Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mcpTestCertificate } from './mcp-test-certificate';

export class McpOAuthNetworkError extends Error {
  readonly code: string;
  constructor(code: string, cause?: { code: string }) {
    super(code, { cause });
    this.code = code;
    this.name = 'McpOAuthNetworkError';
  }
}
export interface McpOAuthNetworkOptions {
  signal: AbortSignal;
  assertFresh(): void;
  resolveAddresses?(hostname: string): Promise<readonly { address: string; family: number }[]>;
  /** Trusted fixture option only; never sourced from JSONC or ambient environment. */
  allowLoopbackForTests?: boolean;
  /** Baked trusted local fixture certificate, never configuration/environment. */
  trustedTestCertificate?: string;
  limits?: { requestBytes?: number; responseBytes?: number; requests?: number; timeoutMs?: number };
}
const fail = (code: string) => new McpOAuthNetworkError(`mcp_oauth_${code}`);
function allowed(address: string, loopback: boolean) {
  if (isIP(address) === 4) {
    const x = address.split('.').map(Number);
    const n = (x[0]! * 0x1000000 + x[1]! * 0x10000 + x[2]! * 0x100 + x[3]!) >>> 0;
    const range = (base: number, bits: number) =>
      Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
    if (range(0x7f000000, 8)) return loopback;
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
    ].some(([base, bits]) => range(base!, bits!));
  }
  if (isIP(address) === 6) {
    const value = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    if (value === '::1') return loopback;
    return (
      /^[23][0-9a-f]{3}:/.test(value) &&
      !/^2002:|^2001:(?:[0-9a-f]{0,2}:|1[0-9a-f]{2}:|db8:)|^3fff:[0-9a-f]{0,3}:/.test(value)
    );
  }
  return false;
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(fail('request_aborted'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
/** Trusted OAuth network leaf, not a connection transport or credential/approval authority. */
export function createMcpOAuthNetwork(options: McpOAuthNetworkOptions): {
  fetch: FetchLike;
  close(): Promise<void>;
} {
  const testCertificate = mcpTestCertificate(
    options.trustedTestCertificate,
    options.allowLoopbackForTests === true,
  );
  const requestBytes = options.limits?.requestBytes ?? 65536,
    responseBytes = options.limits?.responseBytes ?? 1024 * 1024;
  const maxRequests = options.limits?.requests ?? 64,
    timeout = options.limits?.timeoutMs ?? 10000;
  if (
    ![requestBytes, responseBytes, maxRequests, timeout].every(
      (x) => Number.isSafeInteger(x) && x > 0,
    ) ||
    requestBytes > 1024 * 1024 ||
    responseBytes > 4 * 1024 * 1024 ||
    maxRequests > 256 ||
    timeout > 60000
  )
    throw fail('limits_invalid');
  const lifetime = new AbortController(),
    requests = new Set<ClientRequest>(),
    sockets = new Set<Socket>(),
    agents = new Set<HttpAgent | HttpsAgent>();
  let closed = false,
    count = 0,
    operations = 0;
  let ended!: () => void;
  const stopped = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const settle = () => {
    if (closed && !operations && !requests.size && !sockets.size) ended();
  };
  let closeResult: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closeResult) return closeResult;
    closeResult = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(fail('close_unconfirmed')), timeout);
      stopped.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    closed = true;
    lifetime.abort();
    for (const request of requests)
      request.destroy(fail(options.signal.aborted ? 'request_aborted' : 'closed'));
    for (const socket of sockets) socket.destroy();
    for (const agent of agents) agent.destroy();
    options.signal.removeEventListener('abort', onAbort);
    settle();
    return closeResult;
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) void close().catch(() => {});
  const fetch: FetchLike = async (input, init) => {
    if (closed) throw fail('closed');
    if (++count > maxRequests) throw fail('request_budget');
    operations++;
    let agent: HttpAgent | HttpsAgent | undefined;
    try {
      const original = input instanceof Request ? input : undefined;
      const raw = original?.url ?? String(input);
      if (
        raw.length > 8192 ||
        Array.from(raw).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127) ||
        raw.includes('#') ||
        /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(raw)
      )
        throw fail('url_invalid');
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw fail('url_invalid');
      }
      if (url.username || url.password || !['https:', 'http:'].includes(url.protocol))
        throw fail('url_invalid');
      for (const key of url.searchParams.keys())
        if (
          /^(?:token|access_token|refresh_token|client_secret|code|code_verifier|password|authorization)$/i.test(
            key,
          )
        )
          throw fail('secret_in_url');
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const testHTTP = url.protocol === 'http:' && options.allowLoopbackForTests === true;
      if (url.protocol !== 'https:' && !testHTTP) throw fail('https_required');
      const method = (init?.method ?? original?.method ?? 'GET').toUpperCase();
      if (!['GET', 'POST'].includes(method)) throw fail('method_denied');
      if (original?.body && init?.body === undefined) throw fail('body_unsupported');
      const body = init?.body;
      let bytes: Uint8Array | undefined;
      if (typeof body === 'string') bytes = new TextEncoder().encode(body);
      else if (body instanceof URLSearchParams) bytes = new TextEncoder().encode(body.toString());
      else if (body instanceof Uint8Array) bytes = new Uint8Array(body);
      else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body.slice(0));
      else if (body !== null && body !== undefined) throw fail('body_unsupported');
      if (method === 'GET' && bytes) throw fail('body_denied');
      if ((bytes?.length ?? 0) > requestBytes) throw fail('request_too_large');
      const headers = new Headers(init?.headers ?? original?.headers);
      if (method === 'GET' && (headers.has('authorization') || headers.has('cookie')))
        throw fail('sensitive_header_denied');
      for (const key of [
        'host',
        'cookie',
        'proxy-authorization',
        'proxy-connection',
        'connection',
        'content-length',
        'transfer-encoding',
      ])
        headers.delete(key);
      if (body instanceof URLSearchParams && !headers.has('content-type'))
        headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      headers.set('host', url.host);
      const signal = AbortSignal.any([
        options.signal,
        lifetime.signal,
        AbortSignal.timeout(timeout),
        ...(init?.signal ? [init.signal] : []),
        ...(original ? [original.signal] : []),
      ]);
      signal.throwIfAborted();
      options.assertFresh();
      let addresses: readonly { address: string; family: number }[];
      try {
        addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : await bounded(
              (options.resolveAddresses ?? ((h) => lookup(h, { all: true })))(hostname),
              signal,
            );
      } catch {
        if (signal.aborted) throw fail('request_aborted');
        throw fail('dns_unavailable');
      }
      signal.throwIfAborted();
      options.assertFresh();
      if (
        !addresses.length ||
        addresses.length > 64 ||
        addresses.some(
          (x) =>
            isIP(x.address) !== x.family ||
            !allowed(x.address, options.allowLoopbackForTests === true),
        ) ||
        (testHTTP &&
          addresses.some(
            (x) => !(x.family === 4 && x.address.startsWith('127.')) && x.address !== '::1',
          ))
      )
        throw fail('destination_denied');
      const pinned = { ...addresses[0]! };
      agent =
        url.protocol === 'https:'
          ? new HttpsAgent({ keepAlive: false, maxSockets: 1, proxyEnv: {}, ca: testCertificate })
          : new HttpAgent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
      agents.add(agent);
      const activeAgent = agent;
      return await new Promise<Response>((resolve, reject) => {
        signal.throwIfAborted();
        options.assertFresh();
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            agent: activeAgent,
            method,
            headers: Object.fromEntries(headers),
            servername: isIP(hostname) ? undefined : hostname,
            rejectUnauthorized: true,
            maxHeaderSize: 16384,
            lookup: (_host, lookupOptions, callback) => {
              try {
                signal.throwIfAborted();
                options.assertFresh();
                if (lookupOptions.all)
                  (
                    callback as unknown as (
                      error: Error | null,
                      value: { address: string; family: number }[],
                    ) => void
                  )(null, [pinned]);
                else callback(null, pinned.address, pinned.family);
              } catch {
                callback(fail('source_changed'), '');
              }
            },
          },
          (incoming) => {
            if ((incoming.statusCode ?? 500) >= 300 && (incoming.statusCode ?? 500) < 400) {
              incoming.destroy();
              request.destroy();
              reject(fail('redirect_denied'));
              return;
            }
            const parts: Buffer[] = [];
            let size = 0;
            incoming.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > responseBytes) {
                reject(fail('response_too_large'));
                incoming.destroy();
                request.destroy();
              } else parts.push(Buffer.from(chunk));
            });
            incoming.once('error', () => reject(fail('response_failed')));
            incoming.once('aborted', () => reject(fail('response_failed')));
            incoming.once('end', () => {
              try {
                const responseHeaders = new Headers();
                for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                  responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
                const status = incoming.statusCode ?? 500;
                resolve(
                  new Response(status === 204 || status === 304 ? null : Buffer.concat(parts), {
                    status,
                    headers: responseHeaders,
                  }),
                );
              } catch {
                reject(fail('response_invalid'));
              }
            });
          },
        );
        requests.add(request);
        const abort = () => request.destroy(fail('request_aborted'));
        signal.addEventListener('abort', abort, { once: true });
        request.once('socket', (socket) => {
          sockets.add(socket);
          socket.once('close', () => {
            sockets.delete(socket);
            settle();
          });
          try {
            signal.throwIfAborted();
            options.assertFresh();
          } catch {
            request.destroy(fail('source_changed'));
          }
        });
        request.once('error', (error) =>
          reject(
            error instanceof McpOAuthNetworkError
              ? error
              : new McpOAuthNetworkError('mcp_oauth_request_failed', {
                  code:
                    typeof (error as NodeJS.ErrnoException).code === 'string' &&
                    /^[A-Z0-9_]{1,64}$/.test((error as NodeJS.ErrnoException).code!)
                      ? (error as NodeJS.ErrnoException).code!
                      : 'UNAVAILABLE',
                }),
          ),
        );
        request.once('close', () => {
          signal.removeEventListener('abort', abort);
          requests.delete(request);
          settle();
        });
        if (signal.aborted) abort();
        else request.end(bytes);
      });
    } finally {
      if (agent) {
        agent.destroy();
        agents.delete(agent);
      }
      operations--;
      settle();
    }
  };
  return { fetch, close };
}
