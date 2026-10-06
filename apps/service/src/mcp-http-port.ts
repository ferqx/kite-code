import { lookup } from 'node:dns/promises';
import { type ClientRequest, Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { isIP, type Socket } from 'node:net';
import {
  createMcpAdapter,
  McpAdapterError,
  type McpCredentialBroker,
  McpCredentialError,
  type McpCredentialIdentity,
  type McpCredentialRef,
  type McpLifecycleTransportPort,
} from '@kite-ai/agent/mcp';
import { extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { mcpTestCertificate } from './mcp-test-certificate';

export class McpHttpPortError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = 'McpHttpPortError';
  }
}
type Binding = Parameters<McpLifecycleTransportPort['open']>[0];
export interface McpHttpPortOptions {
  servers: readonly {
    id: string;
    url: string;
    headers?: Readonly<Record<string, string>>;
    /** Host resolves from the admitted SQL Job and canonical Workspace/source, never HTTP payload. */
    credential?: {
      broker: McpCredentialBroker;
      /** Private owned OAuth resume may publish tokens; never detach it on a read timeout. */
      canWriteOwned?: true;
      bind(
        binding: Binding,
        options: { signal: AbortSignal },
      ): Promise<{
        ref: McpCredentialRef;
        identity: McpCredentialIdentity;
        revocationRevision: number;
      } | null>;
    };
    /** Actual 401 only; observes the failed request and never grants a retry. */
    onUnauthorized?(
      binding: Binding,
      options: {
        signal: AbortSignal;
        authenticated: boolean;
        resourceMetadataUrl?: string;
        scopes?: readonly string[];
      },
    ): void;
  }[];
  /** Actual host checks the original durable Job/Store identity; never remote self-report. */
  admit(binding: Binding, options: { signal: AbortSignal }): Promise<void>;
  /** Host-only synchronous check after async admission/lookup and immediately before socket IO. */
  assertFresh?(binding: Binding, options: { signal: AbortSignal }): void;
  resolveAddresses?: (hostname: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;
  /** Explicit localhost test qualification, never read from configuration/environment. */
  allowLoopbackForTests?: boolean;
  /** Baked trusted fixture certificate; unavailable to source files and ordinary callers. */
  trustedTestCertificate?: string;
  limits?: {
    requestBytes?: number;
    responseBytes?: number;
    timeoutMs?: number;
    maxSockets?: number;
  };
}
function allowedAddress(address: string, allowLoopback: boolean) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split('.').map(Number);
    const n =
      (octets[0]! * 0x1000000 + octets[1]! * 0x10000 + octets[2]! * 0x100 + octets[3]!) >>> 0;
    const range = (base: number, bits: number) =>
      Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits));
    if (range(0x7f000000, 8)) return allowLoopback;
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
  if (family === 6) {
    const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
    if (canonical === '::1') return allowLoopback;
    // Only ordinary global unicast. Exclude transition, documentation, benchmark and special-use ranges.
    return (
      /^[23][0-9a-f]{3}:/.test(canonical) &&
      !/^2002:|^2001:(?:[0-9a-f]{0,2}:|1[0-9a-f]{2}:|db8:)|^3fff:[0-9a-f]{0,3}:/.test(canonical)
    );
  }
  return false;
}
/** Explicit host port. Factory/import does no DNS/network; owned Job open is the only admission point. */
export function createMcpHttpTransportPort(options: McpHttpPortOptions): McpLifecycleTransportPort {
  const assertFresh = options.assertFresh;
  const requestLimit = options.limits?.requestBytes ?? 1024 * 1024,
    responseLimit = options.limits?.responseBytes ?? 1024 * 1024,
    timeout = options.limits?.timeoutMs ?? 10000,
    maxSockets = options.limits?.maxSockets ?? 4;
  if (
    [requestLimit, responseLimit, timeout, maxSockets].some(
      (x) => !Number.isSafeInteger(x) || x < 1,
    ) ||
    requestLimit > 64 * 1024 * 1024 ||
    responseLimit > 64 * 1024 * 1024 ||
    timeout > 60000 ||
    maxSockets > 32 ||
    options.servers.length > 32
  )
    throw new McpHttpPortError('mcp_http_configuration_invalid');
  const servers = new Map(
    options.servers.map((server) => {
      let url: URL;
      try {
        url = new URL(server.url);
      } catch {
        throw new McpHttpPortError('mcp_http_configuration_invalid');
      }
      if (
        !/^[A-Za-z0-9_-]{1,128}$/.test(server.id) ||
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.href.length > 8192 ||
        ['metadata.google.internal', 'instance-data.ec2.internal'].includes(
          url.hostname.toLowerCase(),
        )
      )
        throw new McpHttpPortError('mcp_http_configuration_invalid');
      let headers: Headers;
      try {
        headers = new Headers(server.headers);
      } catch {
        throw new McpHttpPortError('mcp_http_configuration_invalid');
      }
      if (
        [...headers].length > 64 ||
        [...headers].some(
          ([name, value]) =>
            [
              'host',
              'content-length',
              'proxy-authorization',
              'proxy-connection',
              'connection',
              'transfer-encoding',
            ].includes(name) || name.length + value.length > 8192,
        )
      )
        throw new McpHttpPortError('mcp_http_configuration_invalid');
      const configDigest = createMcpAdapter({
        id: server.id,
        transport: { type: 'http', url: server.url },
      }).getCatalogue().configDigest;
      if (server.credential && (headers.has('authorization') || headers.has('cookie')))
        throw new McpHttpPortError('mcp_http_configuration_invalid');
      return [
        server.id,
        {
          url,
          rawUrl: server.url,
          headers,
          configDigest,
          credential: server.credential
            ? {
                broker: server.credential.broker,
                bind: server.credential.bind,
                canWriteOwned: server.credential.canWriteOwned,
              }
            : undefined,
          onUnauthorized: server.onUnauthorized,
        },
      ];
    }),
  );
  if (servers.size !== options.servers.length)
    throw new McpHttpPortError('mcp_http_configuration_invalid');
  const resolveAddresses =
    options.resolveAddresses ??
    (async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((x) => ({
        address: x.address,
        family: x.family as 4 | 6,
      })));
  const admit = options.admit,
    allowLoopback = options.allowLoopbackForTests === true;
  const testCertificate = mcpTestCertificate(options.trustedTestCertificate, allowLoopback);
  async function bounded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new McpHttpPortError('mcp_http_request_aborted');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort!: () => void;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new McpHttpPortError('mcp_http_timeout')), timeout);
          abort = () => reject(new McpHttpPortError('mcp_http_request_aborted'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
  return {
    async open(binding, { signal }) {
      binding = Object.freeze({
        ...binding,
        configuration: Object.freeze(structuredClone(binding.configuration)),
      });
      const server = servers.get(binding.serverId);
      if (
        !server ||
        binding.configuration.type !== 'http' ||
        binding.configuration.url !== server.rawUrl ||
        Object.keys(binding.configuration).some((k) => !['type', 'url'].includes(k)) ||
        binding.configDigest !== server.configDigest ||
        !binding.originalStoreId ||
        !binding.sessionId ||
        !binding.executionId ||
        binding.scopeId !==
          JSON.stringify([binding.originalStoreId, binding.sessionId, binding.serverId])
      )
        throw new McpHttpPortError('mcp_http_binding_invalid');
      if (signal.aborted) throw new McpHttpPortError('mcp_http_request_aborted');
      try {
        await bounded(
          () =>
            admit(
              Object.freeze({
                ...binding,
                configuration: Object.freeze(structuredClone(binding.configuration)),
              }),
              { signal },
            ),
          signal,
        );
      } catch {
        throw new McpHttpPortError('mcp_http_admission_denied');
      }
      if (signal.aborted) throw new McpHttpPortError('mcp_http_request_aborted');
      assertFresh?.(binding, { signal });
      let credential:
        | Exclude<Awaited<ReturnType<NonNullable<typeof server.credential>['bind']>>, null>
        | undefined;
      if (server.credential) {
        try {
          if (server.credential.canWriteOwned) {
            const deadline = new AbortController(),
              ownedSignal = AbortSignal.any([signal, deadline.signal]);
            let timedOut = false;
            const timer = setTimeout(() => {
              timedOut = true;
              deadline.abort();
            }, timeout);
            try {
              // A native write already in progress cannot be atomically cancelled. Its lease stays owned until it settles.
              credential =
                (await server.credential.bind(binding, { signal: ownedSignal })) ?? undefined;
              if (timedOut) throw new McpAdapterError('mcp_oauth_publication_unknown');
            } catch (error) {
              if (
                timedOut &&
                !(
                  (error instanceof McpCredentialError || error instanceof McpAdapterError) &&
                  error.code.endsWith('_unknown')
                )
              )
                throw new McpAdapterError('mcp_oauth_publication_unknown');
              throw error;
            } finally {
              clearTimeout(timer);
            }
          } else
            credential =
              (await bounded(() => server.credential!.bind(binding, { signal }), signal)) ??
              undefined;
        } catch (error) {
          if (
            (error instanceof McpAdapterError || error instanceof McpCredentialError) &&
            [
              'mcp_credential_store_locked',
              'mcp_credential_store_unavailable',
              'mcp_oauth_reauth_required',
              'mcp_oauth_scope_changed',
              'mcp_oauth_publication_unknown',
              'mcp_oauth_cleanup_unknown',
            ].includes(error.code)
          )
            throw new McpAdapterError(error.code);
          throw new McpHttpPortError('mcp_http_credential_unavailable');
        }
        if (credential) {
          const identity = credential.identity;
          if (
            identity.originalStoreId !== binding.originalStoreId ||
            identity.sessionId !== binding.sessionId ||
            identity.connectionExecutionId !== binding.executionId ||
            identity.serverId !== binding.serverId ||
            identity.configDigest !== binding.configDigest
          )
            throw new McpHttpPortError('mcp_http_credential_binding_invalid');
          if (signal.aborted) throw new McpHttpPortError('mcp_http_request_aborted');
          credential = {
            ref: Object.freeze({ ...credential.ref }),
            identity: structuredClone(identity),
            revocationRevision: credential.revocationRevision,
          };
        }
      }
      const hostname = server.url.hostname.replace(/^\[|\]$/g, '');
      let addresses: readonly { address: string; family: 4 | 6 }[];
      try {
        addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
          : await bounded(() => resolveAddresses(hostname), signal);
      } catch {
        throw new McpHttpPortError('mcp_http_dns_unavailable');
      }
      if (signal.aborted) throw new McpHttpPortError('mcp_http_request_aborted');
      assertFresh?.(binding, { signal });
      if (
        !addresses.length ||
        addresses.length > 64 ||
        addresses.some(
          (x) => isIP(x.address) !== x.family || !allowedAddress(x.address, allowLoopback),
        )
      )
        throw new McpHttpPortError('mcp_http_destination_denied');
      const agentOptions = { keepAlive: true, maxSockets, proxyEnv: {} };
      const pinned = Object.freeze({ ...addresses[0]! }),
        agent =
          server.url.protocol === 'https:'
            ? new HttpsAgent({ ...agentOptions, ca: testCertificate })
            : new HttpAgent(agentOptions);
      const sockets = new Set<Socket>(),
        requests = new Set<ClientRequest>();
      let closed = false;
      const lifetime = new AbortController();
      let ended!: (x: { supervision: 'ended' }) => void;
      const stopped = new Promise<{ supervision: 'ended' }>((resolve) => (ended = resolve));
      const endIfClosed = () => {
        if (closed && !sockets.size && !requests.size) ended({ supervision: 'ended' });
      };
      const fetchPinned: FetchLike = async (input, init) => {
        if (closed) throw new McpHttpPortError('mcp_http_transport_closed');
        const target = new URL(String(input));
        if (target.href !== server.url.href)
          throw new McpHttpPortError('mcp_http_endpoint_changed');
        const requestSignal = AbortSignal.any([
          signal,
          lifetime.signal,
          AbortSignal.timeout(timeout),
          ...(init?.signal ? [init.signal] : []),
        ]);
        if (requestSignal?.aborted) throw new McpHttpPortError('mcp_http_request_aborted');
        assertFresh?.(binding, { signal: requestSignal });
        const body = init?.body;
        let bytes: Uint8Array | undefined;
        if (body !== undefined && body !== null) {
          if (typeof body === 'string') bytes = new TextEncoder().encode(body);
          else if (body instanceof Uint8Array) bytes = new Uint8Array(body as Uint8Array);
          else throw new McpHttpPortError('mcp_http_body_unsupported');
          if (bytes.byteLength > requestLimit)
            throw new McpHttpPortError('mcp_http_request_too_large');
        }
        const headers = new Headers(init?.headers);
        for (const name of [
          'host',
          'authorization',
          'cookie',
          'proxy-authorization',
          'proxy-connection',
          'connection',
          'content-length',
          'transfer-encoding',
        ])
          headers.delete(name);
        for (const [name, value] of server.headers) headers.set(name, value);
        headers.set('host', server.url.host);
        let authorizationFailure: string | undefined;
        const send = () =>
          new Promise<Response>((resolve, reject) => {
            assertFresh?.(binding, { signal: requestSignal });
            const request = (server.url.protocol === 'https:' ? httpsRequest : httpRequest)(
              server.url,
              {
                agent,
                method: init?.method ?? 'GET',
                headers: Object.fromEntries(headers),
                servername: isIP(hostname) ? undefined : hostname,
                rejectUnauthorized: true,
                lookup: (_host, lookupOptions, callback) => {
                  if (lookupOptions.all)
                    (
                      callback as unknown as (
                        error: Error | null,
                        addresses: { address: string; family: number }[],
                      ) => void
                    )(null, [pinned]);
                  else callback(null, pinned.address, pinned.family);
                },
              },
              (incoming) => {
                if (incoming.statusCode === 401 && server.onUnauthorized) {
                  let code = credential ? 'mcp_oauth_reauth_required' : 'mcp_oauth_login_required';
                  try {
                    assertFresh?.(binding, { signal: requestSignal });
                    const header = String(incoming.headers['www-authenticate'] ?? '');
                    const challenge = extractWWWAuthenticateParams(
                      new Response(null, {
                        status: 401,
                        headers: header.length <= 8192 ? { 'www-authenticate': header } : {},
                      }),
                    );
                    const scopes = challenge.scope?.split(' ');
                    const validScopes =
                      scopes &&
                      scopes.length <= 128 &&
                      scopes.every(
                        (scope) =>
                          scope.length > 0 &&
                          scope.length <= 256 &&
                          /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
                      );
                    server.onUnauthorized(binding, {
                      signal: requestSignal,
                      authenticated: !!credential,
                      ...(challenge.resourceMetadataUrl
                        ? { resourceMetadataUrl: challenge.resourceMetadataUrl.href }
                        : {}),
                      ...(validScopes ? { scopes } : {}),
                    });
                  } catch {
                    code = 'mcp_oauth_scope_changed';
                  }
                  authorizationFailure = code;
                  reject(new McpAdapterError(code));
                  incoming.destroy();
                  request.destroy();
                  return;
                }
                if ((incoming.statusCode ?? 500) >= 300 && (incoming.statusCode ?? 500) < 400) {
                  incoming.destroy();
                  request.destroy();
                  reject(new McpHttpPortError('mcp_http_redirect_denied'));
                  return;
                }
                let size = 0;
                let finished = false;
                const responseHeaders = new Headers();
                for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                  responseHeaders.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!);
                const stream = new ReadableStream<Uint8Array>({
                  start(controller) {
                    incoming.on('data', (chunk: Buffer) => {
                      if (finished) return;
                      size += chunk.byteLength;
                      if (size > responseLimit) {
                        finished = true;
                        incoming.destroy();
                        request.destroy();
                        controller.error(new McpHttpPortError('mcp_http_response_too_large'));
                        return;
                      }
                      controller.enqueue(new Uint8Array(chunk));
                      if ((controller.desiredSize ?? 0) <= 0) incoming.pause();
                    });
                    incoming.once('end', () => {
                      if (!finished) {
                        finished = true;
                        controller.close();
                      }
                    });
                    incoming.once('error', () => {
                      if (!finished) {
                        finished = true;
                        controller.error(new McpHttpPortError('mcp_http_response_failed'));
                      }
                    });
                    incoming.once('aborted', () => {
                      if (!finished) {
                        finished = true;
                        controller.error(new McpHttpPortError('mcp_http_response_failed'));
                      }
                    });
                  },
                  pull() {
                    incoming.resume();
                  },
                  cancel() {
                    finished = true;
                    incoming.destroy();
                    request.destroy();
                  },
                });
                resolve(
                  new Response(
                    incoming.statusCode === 204 || incoming.statusCode === 304 ? null : stream,
                    { status: incoming.statusCode ?? 500, headers: responseHeaders },
                  ),
                );
              },
            );
            requests.add(request);
            request.once('socket', (socket) => {
              sockets.add(socket);
              socket.once('close', () => {
                sockets.delete(socket);
                endIfClosed();
              });
              if (closed) socket.destroy();
            });
            const abort = () => request.destroy(new McpHttpPortError('mcp_http_request_aborted'));
            requestSignal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(
              () => request.destroy(new McpHttpPortError('mcp_http_timeout')),
              timeout,
            );
            request.once('error', () => reject(new McpHttpPortError('mcp_http_request_failed')));
            request.once('close', () => {
              clearTimeout(timer);
              requestSignal?.removeEventListener('abort', abort);
              requests.delete(request);
              endIfClosed();
            });
            if (closed || requestSignal?.aborted) abort();
            else request.end(bytes);
          });
        if (credential && server.credential) {
          try {
            assertFresh?.(binding, { signal: requestSignal });
            return await server.credential.broker.withHeaders(
              credential.ref,
              {
                identity: credential.identity,
                purpose: 'mcp.http',
                revocationRevision: credential.revocationRevision,
                signal: requestSignal,
              },
              (material) => {
                if (closed || requestSignal.aborted)
                  throw new McpHttpPortError('mcp_http_request_aborted');
                headers.set('authorization', material.authorization);
                return send();
              },
            );
          } catch {
            if (authorizationFailure) throw new McpAdapterError(authorizationFailure);
            throw new McpHttpPortError('mcp_http_credential_unavailable');
          }
        }
        return send();
      };
      const transport = new StreamableHTTPClientTransport(server.url, {
        fetch: fetchPinned,
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1,
          maxReconnectionDelay: 1,
          reconnectionDelayGrowFactor: 1,
        },
      });
      const originalClose = transport.close.bind(transport);
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= (async () => {
          closed = true;
          lifetime.abort();
          for (const request of requests) request.destroy();
          agent.destroy();
          for (const socket of sockets) socket.destroy();
          await originalClose();
          endIfClosed();
        })());
      transport.close = close;
      const abort = () => {
        void close();
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) await close();
      return {
        transport,
        stopped,
        async stop() {
          await close();
          signal.removeEventListener('abort', abort);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              stopped.then(() => ({ status: 'stopped' as const })),
              new Promise<{ status: 'unknown' }>((resolve) => {
                timer = setTimeout(() => resolve({ status: 'unknown' }), timeout);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        },
      };
    },
  };
}
