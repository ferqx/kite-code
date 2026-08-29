import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, writeSync } from 'node:fs';
import {
  createLocalRuntimeServiceToken,
  decodeLocalRuntimeToken,
} from '@kite-ai/kite-local-runtime/service';
import { z } from 'zod';
import type {
  WorkspaceWorkerControlIdentity,
  WorkspaceWorkerControlLink,
  WorkspaceWorkerDirectoryOutboxPage,
  WorkspaceWorkerDirectoryOutboxRequest,
  WorkspaceWorkerProcessStopRequestResult,
} from './process-host';
import {
  isWorkerConnectionCapabilityPurpose,
  type WorkerConnectionCapabilityProof,
  type WorkerConnectionCapabilityRequest,
} from './worker';

export const KITE_WORKER_CONTROL_HOST = '127.0.0.1' as const;
export const KITE_WORKER_CONTROL_AUTHORIZATION_SCHEME = 'Kite-Worker-Control' as const;
export const KITE_WORKER_CONTROL_IDENTITY_PATH = '/_kite/worker/control/identity' as const;
export const KITE_WORKER_CONTROL_CAPABILITY_PATH = '/_kite/worker/control/capability' as const;
export const KITE_WORKER_CONTROL_STOP_PATH = '/_kite/worker/control/stop' as const;
export const KITE_WORKER_CONTROL_DIRECTORY_OUTBOX_PATH =
  '/_kite/worker/control/directory-outbox' as const;
export const KITE_WORKER_CONTROL_RESPONSE_SCHEMA_ = 'kite.workspace-worker-control.v1' as const;
export const KITE_WORKER_CLIENT_ID_HEADER = 'x-kite-worker-client-id' as const;
export const KITE_WORKER_CONNECTION_GENERATION_HEADER =
  'x-kite-worker-connection-generation' as const;
export const KITE_WORKER_PURPOSE_HEADER = 'x-kite-worker-purpose' as const;

const MAX_BODY_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
export const MAX_WORKSPACE_WORKER_CAPABILITIES = 1_024;
const CONTROL_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const LOOPBACK_ORIGIN_PATTERN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/u;
const boundedText = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => ![...value].some((character) => /\p{Cc}/u.test(character)));
const workspacePath = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value),
    'Workspace path must be absolute',
  );
const workspaceDigest = z.custom<`sha256:${string}`>(
  (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value),
  'Workspace digest is invalid',
);
const workspaceIdentitySchema = z
  .object({ canonicalPath: workspacePath, projectId: boundedText, workspaceDigest })
  .strict();
const controlIdentitySchema = z
  .object({
    workerScopeId: boundedText,
    workerInstanceId: boundedText,
    buildId: boundedText,
    workspace: workspaceIdentitySchema,
  })
  .strict();
const identityResponseSchema = z
  .object({
    schema: z.literal(KITE_WORKER_CONTROL_RESPONSE_SCHEMA_),
    operation: z.literal('describe_identity'),
    identity: controlIdentitySchema,
  })
  .strict();
const capabilityResponseSchema = z
  .object({
    schema: z.literal(KITE_WORKER_CONTROL_RESPONSE_SCHEMA_),
    operation: z.literal('mint_connection_capability'),
    workerScopeId: boundedText,
    workerInstanceId: boundedText,
    capability: z.string().regex(/^[A-Za-z0-9_-]{32,512}$/u),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict();
const stopResponseSchema = z
  .object({
    schema: z.literal(KITE_WORKER_CONTROL_RESPONSE_SCHEMA_),
    operation: z.literal('request_idle_stop'),
    workerScopeId: boundedText,
    workerInstanceId: boundedText,
    outcome: z.enum(['closed', 'busy', 'outcome_unknown', 'unavailable']),
  })
  .strict();
const directoryRequestSchema = z
  .object({
    cursor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const directoryEntrySchema = z
  .object({
    sessionId: boundedText,
    workerScopeId: boundedText,
    revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    tombstone: z.boolean(),
  })
  .strict();
const directoryResponseSchema = z
  .object({
    schema: z.literal(KITE_WORKER_CONTROL_RESPONSE_SCHEMA_),
    operation: z.literal('read_directory_outbox'),
    workerScopeId: boundedText,
    workerInstanceId: boundedText,
    entries: z.array(directoryEntrySchema).max(200),
    nextCursor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
    hasMore: z.boolean(),
  })
  .strict();

export type WorkspaceWorkerControlAuthority = WorkspaceWorkerControlLink & {
  readonly identity: WorkspaceWorkerControlIdentity;
};

export interface WorkspaceWorkerCapabilityVerifier {
  verifyConnectionCapability(
    input: WorkerConnectionCapabilityProof,
    options?: { readonly consume?: boolean },
  ): boolean;
  consumeAgentApiCapability(secret: string): AgentApiCapabilityBinding | undefined;
  isClientGenerationCurrent(clientId: string, connectionGeneration: number): boolean;
}

export interface AgentApiCapabilityBinding {
  readonly workerScopeId: string;
  readonly workerInstanceId: string;
  readonly workspaceDigest: `sha256:${string}`;
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly purpose: 'agent_api_observer' | 'agent_api_controller';
}

export type WorkspaceWorkerCapabilityAuthority = WorkspaceWorkerControlLink &
  WorkspaceWorkerCapabilityVerifier & {
    readonly close: () => void;
  };

export interface WorkspaceWorkerControlCarrier extends AsyncDisposable {
  readonly origin: string;
  /** Internal only; never persisted, returned by readiness, or exposed to Browser. */
  readonly credential: string;
  close(): Promise<void>;
}

export interface WorkspaceWorkerControlCarrierOptions {
  readonly identity: WorkspaceWorkerControlIdentity;
  readonly authority: WorkspaceWorkerControlLink;
  readonly credential?: string;
  /** Current Store 8 outbox reader on the Worker's already-open connection. */
  readonly directoryOutbox?: {
    list(request: WorkspaceWorkerDirectoryOutboxRequest): WorkspaceWorkerDirectoryOutboxPage;
  };
  readonly serve?: typeof Bun.serve;
  readonly requestIp?: (
    request: Request,
    server: Bun.Server<Record<string, never>>,
  ) => Readonly<{ address: string }> | null;
}

export interface WorkspaceWorkerControlLinkOptions {
  readonly origin: string;
  readonly credential: string;
  /** Full identity for an in-process caller that already owns the Workspace path. */
  readonly expectedIdentity?: WorkspaceWorkerControlIdentity;
  /** Path-free identity binding used by a restarted Coordinator before handshake recovery. */
  readonly expectedWorker?: WorkspaceWorkerControlBinding;
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  readonly deadlineMs?: number;
}

export interface WorkspaceWorkerControlBinding {
  readonly workerScopeId: string;
  readonly workerInstanceId: string;
  readonly buildId: string;
  readonly workspaceDigest: `sha256:${string}`;
}

/**
 * A separate native-only control listener. Its closed route set is deliberately smaller than the
 * Runtime data plane: identity, connection-capability mint, and idle-stop only.
 */
export function createWorkspaceWorkerControlCarrier(
  options: WorkspaceWorkerControlCarrierOptions,
): WorkspaceWorkerControlCarrier {
  assertControlIdentity(options.identity);
  const credential = options.credential ?? createLocalRuntimeServiceToken();
  assertCredential(credential);
  const serve = options.serve ?? Bun.serve;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const server = serve<Record<string, never>>({
    hostname: KITE_WORKER_CONTROL_HOST,
    port: 0,
    development: false,
    fetch(request, instance) {
      if (closed || !instance.port) return fixedResponse(503, 'unavailable');
      const origin = `http://${KITE_WORKER_CONTROL_HOST}:${instance.port}`;
      const requestIp = (options.requestIp ?? defaultRequestIp)(request, instance);
      if (
        requestIp?.address !== KITE_WORKER_CONTROL_HOST ||
        request.headers.get('host') !== `${KITE_WORKER_CONTROL_HOST}:${instance.port}` ||
        request.headers.get('origin') !== null ||
        request.headers.get('cookie') !== null
      ) {
        return fixedResponse(403, 'forbidden');
      }
      const url = new URL(request.url);
      if (url.origin !== origin || url.search.length !== 0 || url.username || url.password) {
        return fixedResponse(403, 'forbidden');
      }
      if (
        request.method !== 'POST' ||
        !matchesCredential(request.headers.get('authorization'), credential) ||
        request.headers.get('content-type') !== 'application/json'
      ) {
        return fixedResponse(401, 'unauthorized');
      }
      if (url.pathname === KITE_WORKER_CONTROL_IDENTITY_PATH) {
        return dispatchJsonBody(
          request,
          async () =>
            jsonResponse(200, {
              schema: KITE_WORKER_CONTROL_RESPONSE_SCHEMA_,
              operation: 'describe_identity',
              identity: options.identity,
            }),
          true,
        );
      }
      if (url.pathname === KITE_WORKER_CONTROL_CAPABILITY_PATH) {
        return dispatchJsonBody(
          request,
          async (body) => {
            const requestValue = decodeCapabilityRequest(body);
            if (!requestValue) return fixedResponse(400, 'invalid_request');
            const result = await options.authority.mintConnectionCapability(requestValue);
            if (result.outcome === 'outcome_unknown') {
              return jsonResponse(200, {
                schema: KITE_WORKER_CONTROL_RESPONSE_SCHEMA_,
                operation: 'mint_connection_capability',
                workerScopeId: options.identity.workerScopeId,
                workerInstanceId: options.identity.workerInstanceId,
                outcome: 'outcome_unknown',
              });
            }
            if (result.outcome === 'unavailable') return fixedResponse(503, 'unavailable');
            return jsonResponse(200, {
              schema: KITE_WORKER_CONTROL_RESPONSE_SCHEMA_,
              operation: 'mint_connection_capability',
              workerScopeId: options.identity.workerScopeId,
              workerInstanceId: options.identity.workerInstanceId,
              capability: result.capability,
              expiresAt: result.expiresAt,
            });
          },
          false,
        );
      }
      if (url.pathname === KITE_WORKER_CONTROL_STOP_PATH) {
        return dispatchJsonBody(
          request,
          async () => {
            const outcome = await options.authority.requestIdleStop();
            return jsonResponse(200, {
              schema: KITE_WORKER_CONTROL_RESPONSE_SCHEMA_,
              operation: 'request_idle_stop',
              workerScopeId: options.identity.workerScopeId,
              workerInstanceId: options.identity.workerInstanceId,
              outcome,
            });
          },
          true,
        );
      }
      if (url.pathname === KITE_WORKER_CONTROL_DIRECTORY_OUTBOX_PATH) {
        if (!options.directoryOutbox) return fixedResponse(503, 'unavailable');
        return dispatchJsonBody(
          request,
          async (body) => {
            const requestValue = decodeDirectoryRequest(body);
            if (!requestValue) return fixedResponse(400, 'invalid_request');
            const page = options.directoryOutbox!.list(requestValue);
            return jsonResponse(200, {
              schema: KITE_WORKER_CONTROL_RESPONSE_SCHEMA_,
              operation: 'read_directory_outbox',
              workerScopeId: options.identity.workerScopeId,
              workerInstanceId: options.identity.workerInstanceId,
              entries: page.entries,
              ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
              hasMore: page.hasMore,
            });
          },
          false,
        );
      }
      return fixedResponse(404, 'not_found');
    },
  });
  if (!server.port) {
    try {
      server.stop(true);
    } catch {
      // Port creation failed; no externally visible listener was published.
    }
    throw new Error('Worker control carrier did not obtain an ephemeral loopback port.');
  }
  const origin = `http://${KITE_WORKER_CONTROL_HOST}:${server.port}`;
  return Object.freeze({
    origin,
    credential,
    close() {
      closePromise ??= (async () => {
        closed = true;
        await server.stop(true);
      })();
      return closePromise;
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  });
}

/** Client side of the closed Worker control protocol. */
export function createWorkspaceWorkerControlLink(
  options: WorkspaceWorkerControlLinkOptions,
): WorkspaceWorkerControlLink {
  if (options.expectedIdentity === undefined && options.expectedWorker === undefined) {
    throw new TypeError('Worker control link requires an expected identity binding.');
  }
  if (options.expectedIdentity !== undefined) assertControlIdentity(options.expectedIdentity);
  const expectedWorker =
    options.expectedWorker ?? controlBindingFromIdentity(options.expectedIdentity!);
  assertControlBinding(expectedWorker);
  assertOrigin(options.origin);
  assertCredential(options.credential);
  const deadlineMs = options.deadlineMs ?? 2_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 30_000) {
    throw new RangeError('Worker control deadline is invalid.');
  }
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  return Object.freeze({
    async describeIdentity() {
      try {
        const value = await request(KITE_WORKER_CONTROL_IDENTITY_PATH, '{}');
        const decoded = identityResponseSchema.parse(value);
        return controlIdentityMatchesBinding(decoded.identity, expectedWorker) &&
          (options.expectedIdentity === undefined ||
            sameControlIdentity(decoded.identity, options.expectedIdentity))
          ? decoded.identity
          : undefined;
      } catch {
        return undefined;
      }
    },
    async mintConnectionCapability(requestValue: WorkerConnectionCapabilityRequest) {
      try {
        const value = await request(
          KITE_WORKER_CONTROL_CAPABILITY_PATH,
          JSON.stringify(requestValue),
        );
        if (isOutcomeUnknown(value)) return { outcome: 'outcome_unknown' as const };
        const decoded = capabilityResponseSchema.parse(value);
        if (
          decoded.workerScopeId !== expectedWorker.workerScopeId ||
          decoded.workerInstanceId !== expectedWorker.workerInstanceId
        ) {
          return { outcome: 'outcome_unknown' as const };
        }
        return {
          outcome: 'applied' as const,
          capability: decoded.capability,
          expiresAt: decoded.expiresAt,
        };
      } catch {
        return { outcome: 'outcome_unknown' as const };
      }
    },
    async requestIdleStop(): Promise<WorkspaceWorkerProcessStopRequestResult> {
      try {
        const value = await request(KITE_WORKER_CONTROL_STOP_PATH, '{}');
        const decoded = stopResponseSchema.parse(value);
        if (
          decoded.workerScopeId !== expectedWorker.workerScopeId ||
          decoded.workerInstanceId !== expectedWorker.workerInstanceId
        ) {
          return 'outcome_unknown';
        }
        return decoded.outcome;
      } catch {
        return 'outcome_unknown';
      }
    },
    async readDirectoryOutbox(
      requestValue: WorkspaceWorkerDirectoryOutboxRequest,
    ): Promise<WorkspaceWorkerDirectoryOutboxPage | undefined> {
      try {
        const decodedRequest = decodeDirectoryRequest(requestValue);
        if (!decodedRequest) return undefined;
        const value = await request(
          KITE_WORKER_CONTROL_DIRECTORY_OUTBOX_PATH,
          JSON.stringify(decodedRequest),
        );
        const decoded = directoryResponseSchema.parse(value);
        if (
          decoded.workerScopeId !== expectedWorker.workerScopeId ||
          decoded.workerInstanceId !== expectedWorker.workerInstanceId ||
          decoded.entries.some((entry) => entry.workerScopeId !== expectedWorker.workerScopeId) ||
          (decoded.nextCursor !== undefined &&
            decoded.nextCursor <= (decodedRequest.cursor ?? 0)) ||
          (decoded.hasMore && (decoded.entries.length === 0 || decoded.nextCursor === undefined))
        ) {
          return undefined;
        }
        return Object.freeze({
          entries: Object.freeze(decoded.entries),
          ...(decoded.nextCursor === undefined ? {} : { nextCursor: decoded.nextCursor }),
          hasMore: decoded.hasMore,
        });
      } catch {
        return undefined;
      }
    },
  });

  async function request(pathname: string, body: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadlineMs);
    try {
      const response = await fetchImpl(`${options.origin}${pathname}`, {
        method: 'POST',
        headers: {
          authorization: `${KITE_WORKER_CONTROL_AUTHORIZATION_SCHEME} ${options.credential}`,
          'content-type': 'application/json',
        },
        body,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      });
      if (
        response.status !== 200 ||
        response.headers.get('content-type') !== 'application/json; charset=utf-8'
      ) {
        throw new Error('Worker control response is unavailable.');
      }
      const responseBody = await readBoundedJson(response);
      if (!responseBody.ok) throw new Error('Worker control response body is invalid.');
      return responseBody.value;
    } finally {
      clearTimeout(timer);
    }
  }
}

function decodeCapabilityRequest(value: unknown): WorkerConnectionCapabilityRequest | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join('\0') !== 'clientId\0connectionGeneration\0purpose') return undefined;
  if (
    typeof record.clientId !== 'string' ||
    record.clientId.length === 0 ||
    record.clientId.length > 512 ||
    !Number.isSafeInteger(record.connectionGeneration) ||
    (record.connectionGeneration as number) < 1 ||
    !isWorkerConnectionCapabilityPurpose(record.purpose)
  ) {
    return undefined;
  }
  return {
    clientId: record.clientId,
    connectionGeneration: record.connectionGeneration as number,
    purpose: record.purpose,
  };
}

function decodeDirectoryRequest(value: unknown): WorkspaceWorkerDirectoryOutboxRequest | undefined {
  const parsed = directoryRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

async function dispatchJsonBody(
  request: Request,
  operation: (body?: unknown) => Promise<Response>,
  requireEmpty: boolean,
): Promise<Response> {
  const body = await readBoundedJson(request);
  if (!body.ok) return fixedResponse(400, 'invalid_request');
  try {
    if (
      requireEmpty &&
      (typeof body.value !== 'object' ||
        body.value === null ||
        Array.isArray(body.value) ||
        Object.keys(body.value).length !== 0)
    ) {
      return fixedResponse(400, 'invalid_request');
    }
    return await operation(body.value);
  } catch {
    return fixedResponse(503, 'unavailable');
  }
}

async function readBoundedJson(
  response: Response | Request,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return { ok: false };
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { ok: false };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function assertControlIdentity(identity: WorkspaceWorkerControlIdentity): void {
  if (
    !safeText(identity.workerScopeId) ||
    !safeText(identity.workerInstanceId) ||
    !safeText(identity.buildId) ||
    !identity.workspace ||
    !safeText(identity.workspace.canonicalPath) ||
    !safeText(identity.workspace.projectId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(identity.workspace.workspaceDigest)
  ) {
    throw new TypeError('Worker control identity is invalid.');
  }
}

function sameControlIdentity(
  left: WorkspaceWorkerControlIdentity,
  right: WorkspaceWorkerControlIdentity,
): boolean {
  return (
    left.workerScopeId === right.workerScopeId &&
    left.workerInstanceId === right.workerInstanceId &&
    left.buildId === right.buildId &&
    left.workspace.canonicalPath === right.workspace.canonicalPath &&
    left.workspace.projectId === right.workspace.projectId &&
    left.workspace.workspaceDigest === right.workspace.workspaceDigest
  );
}

function controlBindingFromIdentity(
  identity: WorkspaceWorkerControlIdentity,
): WorkspaceWorkerControlBinding {
  return {
    workerScopeId: identity.workerScopeId,
    workerInstanceId: identity.workerInstanceId,
    buildId: identity.buildId,
    workspaceDigest: identity.workspace.workspaceDigest,
  };
}

function assertControlBinding(binding: WorkspaceWorkerControlBinding): void {
  if (
    !safeText(binding.workerScopeId) ||
    !safeText(binding.workerInstanceId) ||
    !safeText(binding.buildId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(binding.workspaceDigest)
  ) {
    throw new TypeError('Worker control binding is invalid.');
  }
}

function controlIdentityMatchesBinding(
  identity: WorkspaceWorkerControlIdentity,
  binding: WorkspaceWorkerControlBinding,
): boolean {
  return (
    identity.workerScopeId === binding.workerScopeId &&
    identity.workerInstanceId === binding.workerInstanceId &&
    identity.buildId === binding.buildId &&
    identity.workspace.workspaceDigest === binding.workspaceDigest
  );
}

function assertOrigin(value: string): void {
  const port = value.match(LOOPBACK_ORIGIN_PATTERN)?.[0];
  if (!port) throw new TypeError('Worker control origin is invalid.');
  const numericPort = Number(value.slice(value.lastIndexOf(':') + 1));
  if (!Number.isSafeInteger(numericPort) || numericPort < 1 || numericPort > 65_535) {
    throw new TypeError('Worker control origin port is invalid.');
  }
}

function assertCredential(value: string): void {
  try {
    decodeLocalRuntimeToken(value);
  } catch {
    throw new TypeError('Worker control credential is invalid.');
  }
  if (!CONTROL_CREDENTIAL_PATTERN.test(value))
    throw new TypeError('Worker control credential is invalid.');
}

function matchesCredential(value: string | null, expected: string): boolean {
  const prefix = `${KITE_WORKER_CONTROL_AUTHORIZATION_SCHEME} `;
  if (!value?.startsWith(prefix)) return false;
  const candidate = createHash('sha256').update(value.slice(prefix.length), 'utf8').digest();
  const target = createHash('sha256').update(expected, 'utf8').digest();
  const matched = candidate.byteLength === target.byteLength && timingSafeEqual(candidate, target);
  candidate.fill(0);
  target.fill(0);
  return matched;
}

function safeText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4_096 &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function isOutcomeUnknown(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.schema === KITE_WORKER_CONTROL_RESPONSE_SCHEMA_ &&
    record.operation === 'mint_connection_capability' &&
    record.outcome === 'outcome_unknown'
  );
}

function defaultRequestIp(
  request: Request,
  server: Bun.Server<Record<string, never>>,
): Readonly<{ address: string }> | null {
  return server.requestIP(request);
}

function fixedResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'content-type': 'text/plain; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}

function jsonResponse(status: number, value: unknown): Response {
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > MAX_RESPONSE_BYTES) {
    return fixedResponse(503, 'unavailable');
  }
  return new Response(encoded, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}

/** Build a Worker-local hash-only connection capability authority for restart-scoped use. */
export function createWorkspaceWorkerCapabilityAuthority(options: {
  readonly identity: WorkspaceWorkerControlIdentity;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly ttlMs?: number;
  readonly requestIdleStop?: () => Promise<WorkspaceWorkerProcessStopRequestResult>;
}): WorkspaceWorkerCapabilityAuthority {
  assertControlIdentity(options.identity);
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? randomBytes;
  const ttlMs = options.ttlMs ?? 30_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 120_000) {
    throw new RangeError('Worker capability TTL is invalid.');
  }
  const issued = new Map<
    string,
    {
      readonly hash: Buffer;
      readonly expiresAtMs: number;
      readonly request: WorkerConnectionCapabilityRequest;
      connectConsumed: boolean;
    }
  >();
  const latestGeneration = new Map<string, number>();
  let closed = false;
  const keyFor = (request: WorkerConnectionCapabilityRequest) =>
    `${request.clientId}\0${request.connectionGeneration}\0${request.purpose}`;
  return Object.freeze({
    async describeIdentity() {
      return closed ? undefined : options.identity;
    },
    async mintConnectionCapability(request: WorkerConnectionCapabilityRequest) {
      if (closed) return { outcome: 'unavailable' as const };
      if (
        !safeText(request.clientId) ||
        !Number.isSafeInteger(request.connectionGeneration) ||
        request.connectionGeneration < 1 ||
        !isWorkerConnectionCapabilityPurpose(request.purpose)
      ) {
        return { outcome: 'unavailable' as const };
      }
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) {
        return { outcome: 'outcome_unknown' as const };
      }
      for (const [key, record] of issued) {
        if (currentTime >= record.expiresAtMs) {
          record.hash.fill(0);
          issued.delete(key);
        }
      }
      const latest = latestGeneration.get(request.clientId);
      if (latest !== undefined && request.connectionGeneration < latest) {
        return { outcome: 'unavailable' as const };
      }
      if (latest === undefined && latestGeneration.size >= MAX_WORKSPACE_WORKER_CAPABILITIES) {
        return { outcome: 'unavailable' as const };
      }
      if (latest === undefined || request.connectionGeneration > latest) {
        latestGeneration.set(request.clientId, request.connectionGeneration);
        for (const [key, record] of issued) {
          if (
            record.request.clientId === request.clientId &&
            record.request.connectionGeneration < request.connectionGeneration
          ) {
            record.hash.fill(0);
            issued.delete(key);
          }
        }
      }
      const key = keyFor(request);
      if (issued.size >= MAX_WORKSPACE_WORKER_CAPABILITIES && !issued.has(key)) {
        return { outcome: 'unavailable' as const };
      }
      const material = random(32);
      if (!(material instanceof Uint8Array) || material.byteLength !== 32) {
        return { outcome: 'outcome_unknown' as const };
      }
      const capability = Buffer.from(material).toString('base64url');
      material.fill(0);
      const expiresAtMs = currentTime + ttlMs;
      if (!Number.isSafeInteger(expiresAtMs)) return { outcome: 'outcome_unknown' as const };
      const hash = createHash('sha256').update(capability).digest();
      for (const record of issued.values()) {
        if (hash.byteLength === record.hash.byteLength && timingSafeEqual(hash, record.hash)) {
          hash.fill(0);
          return { outcome: 'outcome_unknown' as const };
        }
      }
      const previous = issued.get(key);
      previous?.hash.fill(0);
      issued.set(key, { hash, expiresAtMs, request: { ...request }, connectConsumed: false });
      return {
        outcome: 'applied' as const,
        capability,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },
    verifyConnectionCapability(
      input: WorkerConnectionCapabilityProof,
      verifyOptions: { readonly consume?: boolean } = {},
    ) {
      if (
        closed ||
        input.workerScopeId !== options.identity.workerScopeId ||
        input.workerInstanceId !== options.identity.workerInstanceId ||
        input.workspaceDigest !== options.identity.workspace.workspaceDigest ||
        !safeText(input.clientId) ||
        !Number.isSafeInteger(input.connectionGeneration) ||
        input.connectionGeneration < 1 ||
        !isWorkerConnectionCapabilityPurpose(input.purpose) ||
        !/^[A-Za-z0-9_-]{32,512}$/u.test(input.secret)
      ) {
        return false;
      }
      const record = issued.get(keyFor(input));
      const currentTime = now();
      if (!record || currentTime >= record.expiresAtMs) {
        if (record && currentTime >= record.expiresAtMs) {
          record.hash.fill(0);
          issued.delete(keyFor(input));
        }
        return false;
      }
      if (verifyOptions.consume && record.connectConsumed) return false;
      const actual = createHash('sha256').update(input.secret, 'utf8').digest();
      const valid =
        actual.byteLength === record.hash.byteLength && timingSafeEqual(actual, record.hash);
      actual.fill(0);
      if (valid && (verifyOptions.consume ?? false)) {
        record.connectConsumed = true;
      }
      return valid;
    },
    consumeAgentApiCapability(secret: string) {
      if (closed || !/^[A-Za-z0-9_-]{43}$/u.test(secret)) return undefined;
      const currentTime = now();
      if (!Number.isSafeInteger(currentTime) || currentTime < 0) return undefined;
      const actual = createHash('sha256').update(secret, 'utf8').digest();
      try {
        for (const [key, record] of issued) {
          if (currentTime >= record.expiresAtMs) {
            record.hash.fill(0);
            issued.delete(key);
            continue;
          }
          if (
            record.request.purpose !== 'agent_api_observer' &&
            record.request.purpose !== 'agent_api_controller'
          ) {
            continue;
          }
          if (
            actual.byteLength !== record.hash.byteLength ||
            !timingSafeEqual(actual, record.hash)
          ) {
            continue;
          }
          issued.delete(key);
          record.hash.fill(0);
          return Object.freeze({
            workerScopeId: options.identity.workerScopeId,
            workerInstanceId: options.identity.workerInstanceId,
            workspaceDigest: options.identity.workspace.workspaceDigest,
            clientId: record.request.clientId,
            connectionGeneration: record.request.connectionGeneration,
            purpose: record.request.purpose,
          });
        }
        return undefined;
      } finally {
        actual.fill(0);
      }
    },
    isClientGenerationCurrent(clientId: string, connectionGeneration: number) {
      return (
        !closed &&
        safeText(clientId) &&
        Number.isSafeInteger(connectionGeneration) &&
        connectionGeneration >= 1 &&
        latestGeneration.get(clientId) === connectionGeneration
      );
    },
    close() {
      if (closed) return;
      closed = true;
      for (const record of issued.values()) record.hash.fill(0);
      issued.clear();
      latestGeneration.clear();
    },
    async requestIdleStop() {
      if (closed) return 'unavailable' as const;
      return options.requestIdleStop?.() ?? ('unavailable' as const);
    },
  });
}

export function writeWorkspaceWorkerControlReadySignal(
  value: WorkspaceWorkerControlIdentity,
  fd: number,
): void {
  assertControlIdentity(value);
  if (!Number.isSafeInteger(fd) || fd < 0 || fd > 1_024)
    throw new TypeError('Control fd is invalid.');
  const encoded = Buffer.from(
    `${JSON.stringify({
      schema: KITE_WORKER_CONTROL_RESPONSE_SCHEMA_,
      operation: 'describe_identity',
      identity: value,
    })}\n`,
    'utf8',
  );
  try {
    writeSync(fd, encoded);
    closeSync(fd);
  } catch {
    throw new Error('Worker control identity could not be published.');
  }
}
