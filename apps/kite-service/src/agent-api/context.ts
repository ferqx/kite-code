import { createHash, randomBytes as systemRandomBytes } from 'node:crypto';
import {
  AGENT_API_ARTIFACT_DIGEST,
  AGENT_API_LIMITS,
  AGENT_API_VERSION,
  type AgentApiCapability,
  type AgentApiProblem,
  agentApiContextSchema,
  agentApiExchangeRequestSchema,
  agentApiProblemSchema,
  agentApiServerInfoSchema,
  decodeAgentApiRequest,
  encodeAgentApiResponse,
} from '@kite-ai/agent-api-contract';
import {
  type AgentApiReadContext,
  dispatchAgentApiReadRequest,
  isAgentApiReadRequest,
} from './read-adapter';

export const AGENT_API_CONTEXT_TTL_MS = 60 * 60 * 1_000;
export const AGENT_API_MAX_CONTEXTS = 1_024;
export const AGENT_API_MAX_IN_FLIGHT_REQUESTS = 16;
export const AGENT_API_CONNECTION_AUTHORIZATION_SCHEME = 'Kite-Connection' as const;
export const AGENT_API_CONTEXT_AUTHORIZATION_SCHEME = 'Bearer' as const;

const MAX_REQUEST_TARGET_BYTES = 4_096;
const MAX_PATH_SEGMENT_BYTES = 128;
const MAX_HEADER_BYTES = 8 * 1_024;
const MAX_HEADERS_BYTES = 32 * 1_024;
const MAX_AUTHORIZATION_BYTES = 512;

export interface AgentApiCapabilityBinding {
  readonly workerScopeId: string;
  readonly workerInstanceId: string;
  readonly workspaceDigest: `sha256:${string}`;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly purpose: 'agent_api_observer' | 'agent_api_controller';
}

export interface AgentApiRouteHandler extends AsyncDisposable {
  handle(request: Request, browserAuth?: AgentApiBrowserSessionPort): Response | Promise<Response>;
  revokeClientGeneration(clientId: string, connectionGeneration: number): void;
  close(): Promise<void>;
}

export interface AgentApiRouteHandlerOptions {
  readonly serverVersion: string;
  readonly buildId: string;
  readonly consumeCapability: (secret: string) => AgentApiCapabilityBinding | undefined;
  readonly admitWorkspace: () => Promise<'admitted' | 'untrusted' | 'unavailable'>;
  readonly isClientGenerationCurrent: (clientId: string, connectionGeneration: number) => boolean;
  /** KASAPI-02B+ opens one private Runtime logical connection per Public context. */
  readonly openReadContext?: (binding: AgentApiCapabilityBinding) => Promise<AgentApiReadContext>;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly contextTtlMs?: number;
  readonly maxContexts?: number;
  /** KASAPI-02B+ replaces this empty set only when each advertised route is implemented. */
  readonly capabilities?: readonly AgentApiCapability[];
  /** Service-scoped read context used only after exact Browser cookie admission. */
  readonly browserReadContext?: AgentApiReadContext;
  readonly browserCapabilities?: readonly AgentApiCapability[];
}

export interface AgentApiBrowserSessionPort {
  readonly cookieName: string;
  inspectCookie(cookieHeader: string | null):
    | { readonly status: 'absent' | 'invalid' }
    | {
        readonly status: 'valid';
        readonly record: { readonly cookieHash: string; readonly expiresAt: number };
      };
  revokeSession(cookieHash: string): void;
}

interface ContextRecord {
  readonly digest: string;
  readonly binding: AgentApiCapabilityBinding;
  readonly role: 'observer' | 'controller';
  readonly expiresAtMs: number;
  readonly readContext?: AgentApiReadContext;
  activeRequests: number;
  revoked: boolean;
  closePromise?: Promise<void>;
}

/**
 * Worker-local Agent API authentication and route shell. It owns no Runtime,
 * Store, History or Controller authority; capability and generation facts are
 * injected by the Worker owner.
 */
export function createAgentApiRouteHandler(
  options: AgentApiRouteHandlerOptions,
): AgentApiRouteHandler {
  const now = options.now ?? Date.now;
  const randomBytes = options.randomBytes ?? systemRandomBytes;
  const ttlMs = options.contextTtlMs ?? AGENT_API_CONTEXT_TTL_MS;
  const maxContexts = options.maxContexts ?? AGENT_API_MAX_CONTEXTS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > AGENT_API_CONTEXT_TTL_MS) {
    throw new RangeError('Agent API context TTL is invalid.');
  }
  if (!Number.isSafeInteger(maxContexts) || maxContexts < 1 || maxContexts > 4_096) {
    throw new RangeError('Agent API context capacity is invalid.');
  }
  const serverInfo = encodeAgentApiResponse(agentApiServerInfoSchema, {
    schema: 'kite.agent-api.server-info.v1',
    api_version: AGENT_API_VERSION,
    server_version: options.serverVersion,
    build_id: options.buildId,
    capabilities: [...(options.capabilities ?? [])].sort(),
  });
  const browserServerInfo = encodeAgentApiResponse(agentApiServerInfoSchema, {
    schema: 'kite.agent-api.server-info.v1',
    api_version: AGENT_API_VERSION,
    server_version: options.serverVersion,
    build_id: options.buildId,
    capabilities: [...(options.browserCapabilities ?? [])].sort(),
  });
  const contexts = new Map<string, ContextRecord>();
  const pendingDigests = new Set<string>();
  const pendingReadContexts = new Set<Promise<void>>();
  const pendingRequests = new Set<Promise<void>>();
  let pendingContexts = 0;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const closeReadContext = (record: ContextRecord): Promise<void> => {
    record.closePromise ??= (async () => {
      try {
        await record.readContext?.close();
      } catch {
        // Revocation is fail-closed even when private connection cleanup reports an error.
      }
    })();
    return record.closePromise;
  };

  const revoke = (digest: string, record: ContextRecord): Promise<void> => {
    if (contexts.get(digest) === record) contexts.delete(digest);
    if (record.revoked) return record.closePromise ?? Promise.resolve();
    record.revoked = true;
    if (record.activeRequests > 0) return Promise.resolve();
    try {
      return closeReadContext(record);
    } catch {
      return Promise.resolve();
    }
  };

  const prune = (observedAt: number): void => {
    for (const [digest, record] of contexts) {
      if (
        record.expiresAtMs <= observedAt ||
        !options.isClientGenerationCurrent(
          record.binding.clientId,
          record.binding.connectionGeneration,
        )
      ) {
        void revoke(digest, record);
      }
    }
  };

  const handler: AgentApiRouteHandler = {
    async handle(request: Request, browserAuth?: AgentApiBrowserSessionPort) {
      const requestId = `req_${randomToken(randomBytes, 16, 'request identity')}`;
      try {
        if (closed) {
          return problemResponse(503, 'temporarily_unavailable', requestId, true, {
            retryAfter: 1,
          });
        }
        const url = new URL(request.url);
        if (!requestWithinLimits(request, url)) {
          return problemResponse(400, 'invalid_request', requestId, false);
        }
        if (hasBrowserCredentialSignals(request)) {
          return await handleBrowserRequest(request, url, requestId, browserAuth);
        }
        if (url.pathname === '/v1/auth/exchange') {
          return await exchange(request, requestId);
        }
        const context = authenticateContext(request, contexts, now, options, prune);
        if (!context) return problemResponse(401, 'unauthorized', requestId, false);
        if (context.activeRequests >= AGENT_API_MAX_IN_FLIGHT_REQUESTS) {
          return problemResponse(429, 'overloaded', requestId, true, { retryAfter: 1 });
        }
        context.activeRequests += 1;
        let finishPendingRequest!: () => void;
        const pendingRequest = new Promise<void>((resolve) => {
          finishPendingRequest = resolve;
        });
        pendingRequests.add(pendingRequest);
        try {
          if (url.pathname === '/v1/auth/session') {
            if (url.search.length !== 0) {
              return problemResponse(400, 'invalid_request', requestId, false);
            }
            if (request.method !== 'DELETE') {
              return problemResponse(405, 'method_not_allowed', requestId, false, {
                allow: 'DELETE',
              });
            }
            void revoke(context.digest, context);
            return emptyResponse(204, requestId);
          }
          const admission = await recheckWorkspaceAdmission(options.admitWorkspace);
          if (admission === 'untrusted') {
            void revoke(context.digest, context);
            return problemResponse(403, 'forbidden', requestId, false);
          }
          if (admission !== 'admitted') {
            return problemResponse(503, 'temporarily_unavailable', requestId, true, {
              retryAfter: 1,
            });
          }
          if (closed) {
            return problemResponse(503, 'temporarily_unavailable', requestId, true, {
              retryAfter: 1,
            });
          }
          if (context.revoked || contexts.get(context.digest) !== context) {
            return problemResponse(401, 'unauthorized', requestId, false);
          }
          if (url.pathname === '/v1') {
            if (request.method !== 'GET') {
              return problemResponse(405, 'method_not_allowed', requestId, false, {
                allow: 'GET',
              });
            }
            if (
              request.headers.get('accept') !== null &&
              !acceptsJson(request.headers.get('accept'))
            ) {
              return problemResponse(406, 'not_acceptable', requestId, false);
            }
            return jsonResponse(200, serverInfo, requestId);
          }
          if (context.readContext && isAgentApiReadRequest(request, url)) {
            if (
              request.headers.get('accept') !== null &&
              !acceptsJson(request.headers.get('accept'))
            ) {
              return problemResponse(406, 'not_acceptable', requestId, false);
            }
            const read = await dispatchAgentApiReadRequest({
              request,
              url,
              context: context.readContext,
            });
            if (read.matched) {
              if (!read.result.ok) {
                return problemResponse(
                  read.result.status,
                  read.result.code,
                  requestId,
                  read.result.retryable,
                  read.result.status === 503 ? { retryAfter: 1 } : {},
                );
              }
              return jsonResponse(200, read.result.body, requestId, {
                ...(read.result.etag ? { etag: read.result.etag } : {}),
              });
            }
          }
          return problemResponse(404, 'not_found', requestId, false);
        } finally {
          context.activeRequests -= 1;
          if (context.revoked && context.activeRequests === 0) {
            await closeReadContext(context);
          }
          finishPendingRequest();
          pendingRequests.delete(pendingRequest);
        }
      } catch {
        return problemResponse(503, 'temporarily_unavailable', requestId, true, {
          retryAfter: 1,
        });
      }
    },
    revokeClientGeneration(clientId: string, connectionGeneration: number) {
      for (const [digest, record] of contexts) {
        if (
          record.binding.clientId === clientId &&
          record.binding.connectionGeneration === connectionGeneration
        ) {
          void revoke(digest, record);
        }
      }
    },
    close() {
      closePromise ??= (async () => {
        if (closed) return;
        closed = true;
        const records = [...contexts.entries()];
        for (const [digest, record] of records) void revoke(digest, record);
        await Promise.allSettled([...pendingReadContexts]);
        await Promise.allSettled([...pendingRequests]);
        await Promise.allSettled(records.map(([, record]) => closeReadContext(record)));
      })();
      return closePromise;
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  };
  return Object.freeze(handler);

  async function exchange(request: Request, requestId: string): Promise<Response> {
    if (request.method !== 'POST') {
      return problemResponse(405, 'method_not_allowed', requestId, false, { allow: 'POST' });
    }
    const url = new URL(request.url);
    if (url.search.length !== 0) {
      return problemResponse(400, 'invalid_request', requestId, false);
    }
    if (request.headers.get('accept') !== null && !acceptsJson(request.headers.get('accept'))) {
      return problemResponse(406, 'not_acceptable', requestId, false);
    }
    if (!isJsonContentType(request.headers.get('content-type'))) {
      return problemResponse(415, 'unsupported_media_type', requestId, false);
    }
    const capability = authorizationToken(
      request.headers.get('authorization'),
      AGENT_API_CONNECTION_AUTHORIZATION_SCHEME,
    );
    if (!capability) return problemResponse(401, 'unauthorized', requestId, false);
    const body = await readBoundedJson(request, AGENT_API_LIMITS.maxMessageBytes);
    if (!body.ok) {
      return problemResponse(
        body.tooLarge ? 413 : 400,
        body.tooLarge ? 'payload_too_large' : 'invalid_request',
        requestId,
        false,
        {
          ...(body.tooLarge ? { limitBytes: AGENT_API_LIMITS.maxMessageBytes } : {}),
        },
      );
    }
    let decoded: ReturnType<typeof decodeAgentApiRequest<typeof agentApiExchangeRequestSchema>>;
    try {
      decoded = decodeAgentApiRequest(agentApiExchangeRequestSchema, body.value);
    } catch {
      return problemResponse(400, 'invalid_request', requestId, false);
    }
    const missing = decoded.required_capabilities.filter(
      (capabilityName) => !serverInfo.capabilities.includes(capabilityName),
    );
    if (missing.length > 0) {
      return problemResponse(426, 'incompatible', requestId, false, {
        missingCapabilities: missing,
      });
    }
    let admission: 'admitted' | 'untrusted' | 'unavailable';
    try {
      admission = await options.admitWorkspace();
    } catch {
      admission = 'unavailable';
    }
    if (admission === 'untrusted') {
      return problemResponse(403, 'forbidden', requestId, false);
    }
    if (admission !== 'admitted') {
      return problemResponse(503, 'temporarily_unavailable', requestId, true, {
        retryAfter: 1,
      });
    }
    // Admission can await filesystem-backed Trust state while Worker drain wins.
    // Do not consume a one-shot capability after the handler has closed.
    if (closed) {
      return problemResponse(503, 'temporarily_unavailable', requestId, true, {
        retryAfter: 1,
      });
    }
    const observedAt = safeNow(now);
    prune(observedAt);
    if (contexts.size + pendingContexts >= maxContexts) {
      return problemResponse(429, 'overloaded', requestId, true, { retryAfter: 1 });
    }
    const contextToken = mintUniqueContextToken(randomBytes, contexts, pendingDigests);
    if (!contextToken) {
      return problemResponse(503, 'temporarily_unavailable', requestId, true, {
        retryAfter: 1,
      });
    }
    pendingContexts += 1;
    pendingDigests.add(contextToken.digest);
    let finishPendingRead!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      finishPendingRead = resolve;
    });
    pendingReadContexts.add(pendingRead);
    try {
      const binding = options.consumeCapability(capability);
      if (!binding) return problemResponse(401, 'unauthorized', requestId, false);
      const expiresAtMs = observedAt + ttlMs;
      if (!Number.isSafeInteger(expiresAtMs)) {
        return problemResponse(503, 'temporarily_unavailable', requestId, true, {
          retryAfter: 1,
        });
      }
      let readContext: AgentApiReadContext | undefined;
      try {
        const opening = options.openReadContext?.(binding);
        if (opening) {
          readContext = await opening;
        }
      } catch {
        return problemResponse(503, 'temporarily_unavailable', requestId, true, {
          retryAfter: 1,
        });
      }
      if (
        closed ||
        !options.isClientGenerationCurrent(binding.clientId, binding.connectionGeneration)
      ) {
        await readContext?.close().catch(() => undefined);
        return problemResponse(503, 'temporarily_unavailable', requestId, true, {
          retryAfter: 1,
        });
      }
      const responseBody = encodeAgentApiResponse(agentApiContextSchema, {
        schema: 'kite.agent-api.context.v1',
        access_token: contextToken.token,
        token_type: 'Bearer',
        expires_at: new Date(expiresAtMs).toISOString(),
        role: binding.purpose === 'agent_api_controller' ? 'controller' : 'observer',
        api_version: AGENT_API_VERSION,
        capabilities: serverInfo.capabilities,
      });
      contexts.set(contextToken.digest, {
        digest: contextToken.digest,
        binding,
        role: binding.purpose === 'agent_api_controller' ? 'controller' : 'observer',
        expiresAtMs,
        activeRequests: 0,
        revoked: false,
        ...(readContext ? { readContext } : {}),
      });
      return jsonResponse(201, responseBody, requestId);
    } finally {
      pendingContexts -= 1;
      pendingDigests.delete(contextToken.digest);
      finishPendingRead();
      pendingReadContexts.delete(pendingRead);
    }
  }

  async function handleBrowserRequest(
    request: Request,
    url: URL,
    requestId: string,
    browserAuth: AgentApiBrowserSessionPort | undefined,
  ): Promise<Response> {
    if (!browserAuth || !options.browserReadContext || !browserRequestAllowed(request, url)) {
      return problemResponse(403, 'forbidden', requestId, false);
    }
    const inspected = browserAuth.inspectCookie(request.headers.get('cookie'));
    if (inspected.status !== 'valid') {
      return problemResponse(401, 'unauthorized', requestId, false);
    }
    if (url.pathname === '/v1/auth/browser/session') {
      if (url.search.length !== 0) {
        return problemResponse(400, 'invalid_request', requestId, false);
      }
      if (request.method !== 'DELETE') {
        return problemResponse(405, 'method_not_allowed', requestId, false, { allow: 'DELETE' });
      }
      browserAuth.revokeSession(inspected.record.cookieHash);
      return emptyResponse(204, requestId, {
        'set-cookie': `${browserAuth.cookieName}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`,
      });
    }
    if (request.method !== 'GET') {
      return problemResponse(404, 'not_found', requestId, false);
    }
    if (request.headers.get('accept') !== null && !acceptsJson(request.headers.get('accept'))) {
      return problemResponse(406, 'not_acceptable', requestId, false);
    }
    if (url.pathname === '/v1') {
      return jsonResponse(200, browserServerInfo, requestId);
    }
    if (url.pathname === '/v1/sessions') {
      return problemResponse(404, 'not_found', requestId, false);
    }
    if (!isAgentApiReadRequest(request, url)) {
      return problemResponse(404, 'not_found', requestId, false);
    }
    const read = await dispatchAgentApiReadRequest({
      request,
      url,
      context: options.browserReadContext,
    });
    if (!read.matched) return problemResponse(404, 'not_found', requestId, false);
    if (!read.result.ok) {
      return problemResponse(
        read.result.status,
        read.result.code,
        requestId,
        read.result.retryable,
        read.result.status === 503 ? { retryAfter: 1 } : {},
      );
    }
    return jsonResponse(200, read.result.body, requestId, {
      ...(read.result.etag ? { etag: read.result.etag } : {}),
    });
  }
}

function mintUniqueContextToken(
  randomBytes: (size: number) => Uint8Array,
  contexts: ReadonlyMap<string, ContextRecord>,
  pendingDigests: ReadonlySet<string>,
): { readonly token: string; readonly digest: string } | undefined {
  const token = randomToken(randomBytes, 32, 'context token');
  const digest = digestToken(token);
  return contexts.has(digest) || pendingDigests.has(digest) ? undefined : { token, digest };
}

function authenticateContext(
  request: Request,
  contexts: Map<string, ContextRecord>,
  now: () => number,
  options: Pick<AgentApiRouteHandlerOptions, 'isClientGenerationCurrent'>,
  prune: (observedAt: number) => void,
): ContextRecord | undefined {
  const token = authorizationToken(
    request.headers.get('authorization'),
    AGENT_API_CONTEXT_AUTHORIZATION_SCHEME,
  );
  if (!token || !/^[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
  const observedAt = safeNow(now);
  prune(observedAt);
  const record = contexts.get(digestToken(token));
  if (
    !record ||
    record.expiresAtMs <= observedAt ||
    !options.isClientGenerationCurrent(record.binding.clientId, record.binding.connectionGeneration)
  ) {
    if (record) contexts.delete(record.digest);
    return undefined;
  }
  return record;
}

function problemResponse(
  status: AgentApiProblem['status'],
  code: AgentApiProblem['code'],
  requestId: string,
  retryable: boolean,
  options: {
    readonly allow?: string;
    readonly limitBytes?: number;
    readonly missingCapabilities?: readonly AgentApiCapability[];
    readonly retryAfter?: number;
  } = {},
): Response {
  const problem = encodeAgentApiResponse(agentApiProblemSchema, {
    schema: 'kite.agent-api.problem.v1',
    type: `urn:kite:agent-api:problem:${code}`,
    title: problemTitle(code),
    status,
    code,
    request_id: requestId,
    retryable,
    ...(options.limitBytes === undefined ? {} : { limit_bytes: options.limitBytes }),
    ...(code === 'incompatible'
      ? {
          supported_api_versions: ['v1'] as const,
          ...(options.missingCapabilities
            ? { missing_capabilities: [...options.missingCapabilities].sort() }
            : {}),
        }
      : {}),
  });
  return new Response(JSON.stringify(problem), {
    status,
    headers: responseHeaders(requestId, 'application/problem+json; charset=utf-8', {
      ...(options.allow ? { allow: options.allow } : {}),
      ...(options.retryAfter ? { 'retry-after': String(options.retryAfter) } : {}),
      ...(status === 401 ? { 'www-authenticate': 'Bearer realm="kite-agent-api"' } : {}),
    }),
  });
}

function jsonResponse(
  status: number,
  value: unknown,
  requestId: string,
  extra: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: responseHeaders(requestId, 'application/json; charset=utf-8', extra),
  });
}

async function recheckWorkspaceAdmission(
  admitWorkspace: AgentApiRouteHandlerOptions['admitWorkspace'],
): Promise<'admitted' | 'untrusted' | 'unavailable'> {
  try {
    return await admitWorkspace();
  } catch {
    return 'unavailable';
  }
}

function emptyResponse(
  status: number,
  requestId: string,
  extra: Readonly<Record<string, string>> = {},
): Response {
  return new Response(null, { status, headers: responseHeaders(requestId, undefined, extra) });
}

function responseHeaders(
  requestId: string,
  contentType?: string,
  extra: Readonly<Record<string, string>> = {},
): Headers {
  const headers = new Headers({
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    'kite-agent-api-schema-digest': AGENT_API_ARTIFACT_DIGEST,
    'kite-agent-api-version': AGENT_API_VERSION,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'x-request-id': requestId,
    ...extra,
  });
  if (contentType) headers.set('content-type', contentType);
  return headers;
}

async function readBoundedJson(
  request: Request,
  maximumBytes: number,
): Promise<
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly tooLarge: boolean }
> {
  const declared = request.headers.get('content-length');
  if (declared && !/^\d+$/u.test(declared)) {
    return { ok: false, tooLarge: false };
  }
  if (declared && Number(declared) > maximumBytes) {
    return { ok: false, tooLarge: true };
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return { ok: false, tooLarge: false };
  }
  if (bytes.byteLength > maximumBytes) return { ok: false, tooLarge: true };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, tooLarge: false };
  }
  if (hasDuplicateObjectKey(text)) return { ok: false, tooLarge: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, tooLarge: false };
  }
}

function hasDuplicateObjectKey(value: string): boolean {
  const keys = new Set<string>();
  const pattern = /"((?:\\.|[^"\\])*)"\s*:/gu;
  for (const match of value.matchAll(pattern)) {
    let key: string;
    try {
      key = JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return true;
    }
    if (keys.has(key)) return true;
    keys.add(key);
  }
  return false;
}

function hasBrowserCredentialSignals(request: Request): boolean {
  if (request.headers.get('origin') !== null || request.headers.get('cookie') !== null) return true;
  for (const [name] of request.headers) {
    if (name.toLowerCase().startsWith('sec-fetch-')) return true;
  }
  return false;
}

function browserRequestAllowed(request: Request, url: URL): boolean {
  if (request.headers.get('authorization') !== null) return false;
  const origin = request.headers.get('origin');
  if (request.method === 'GET') {
    if (origin !== null && origin !== url.origin) return false;
  } else if (origin !== url.origin) {
    return false;
  }
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return false;
  const mode = request.headers.get('sec-fetch-mode');
  return mode === 'cors' || mode === 'same-origin';
}

function requestWithinLimits(request: Request, url: URL): boolean {
  if (url.username || url.password) return false;
  const target = `${url.pathname}${url.search}`;
  if (utf8Bytes(target) > MAX_REQUEST_TARGET_BYTES) return false;
  for (const segment of url.pathname.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return false;
    }
    if (utf8Bytes(decoded) > MAX_PATH_SEGMENT_BYTES) return false;
  }
  let headersBytes = 0;
  for (const [name, value] of request.headers) {
    const headerBytes = utf8Bytes(name) + utf8Bytes(value);
    if (headerBytes > MAX_HEADER_BYTES) return false;
    headersBytes += headerBytes;
    if (headersBytes > MAX_HEADERS_BYTES) return false;
  }
  const authorization = request.headers.get('authorization');
  return authorization === null || utf8Bytes(authorization) <= MAX_AUTHORIZATION_BYTES;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function authorizationToken(value: string | null, scheme: string): string | undefined {
  const prefix = `${scheme} `;
  if (!value?.startsWith(prefix)) return undefined;
  const token = value.slice(prefix.length);
  return token.length > 0 && !/\s/u.test(token) ? token : undefined;
}

function randomToken(
  randomBytes: (size: number) => Uint8Array,
  size: number,
  label: string,
): string {
  const bytes = randomBytes(size);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== size) {
    throw new Error(`Agent API ${label} source returned invalid material.`);
  }
  const token = Buffer.from(bytes).toString('base64url');
  bytes.fill(0);
  return token;
}

function digestToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Agent API clock is invalid.');
  return value;
}

function isJsonContentType(value: string | null): boolean {
  return value === 'application/json' || value === 'application/json; charset=utf-8';
}

function acceptsJson(value: string | null): boolean {
  if (value === null) return true;
  return value
    .split(',')
    .map((entry) => entry.trim().split(';', 1)[0])
    .some((mediaType) => mediaType === '*/*' || mediaType === 'application/json');
}

function problemTitle(code: AgentApiProblem['code']): string {
  const titles: Readonly<Record<AgentApiProblem['code'], string>> = {
    checkpoint_unavailable: 'Checkpoint unavailable',
    controller_conflict: 'Controller binding conflict',
    cursor_invalidated: 'Cursor invalidated',
    forbidden: 'Forbidden',
    idempotency_conflict: 'Idempotency conflict',
    incompatible: 'Incompatible Agent API contract',
    interaction_mismatch: 'Interaction mismatch',
    invalid_cursor: 'Invalid cursor',
    invalid_request: 'Invalid request',
    method_not_allowed: 'Method not allowed',
    not_acceptable: 'Not acceptable',
    not_found: 'Not found',
    outcome_unknown: 'Outcome unknown',
    overloaded: 'Agent API overloaded',
    payload_too_large: 'Payload too large',
    precondition_required: 'Precondition required',
    revision_conflict: 'Revision conflict',
    run_not_active: 'Run is not active',
    session_busy: 'Session is busy',
    temporarily_unavailable: 'Agent API temporarily unavailable',
    unauthorized: 'Unauthorized',
    unsupported_media_type: 'Unsupported media type',
  };
  return titles[code];
}
