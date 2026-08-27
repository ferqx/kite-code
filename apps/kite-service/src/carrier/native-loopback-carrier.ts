import { createHash, randomBytes as systemRandomBytes, timingSafeEqual } from 'node:crypto';
import {
  type ExactJsonCodec,
  executionStatusRequestCodec,
  executionStatusResponseCodec,
  type KiteWorkspaceIdentity,
  mcpActionRequestCodec,
  mcpActionResponseCodec,
  mcpSnapshotRequestCodec,
  mcpSnapshotResponseCodec,
  providerModelSelectRequestCodec,
  providerModelSelectResponseCodec,
  providerModelSnapshotRequestCodec,
  providerModelSnapshotResponseCodec,
  releaseStatusRequestCodec,
  releaseStatusResponseCodec,
  skillCatalogRequestCodec,
  skillCatalogResponseCodec,
  workspaceTrustDecisionRequestCodec,
  workspaceTrustDecisionResponseCodec,
  workspaceTrustQueryRequestCodec,
  workspaceTrustQueryResponseCodec,
} from '@kite-ai/kite-app-contract';
import {
  decodeLocalRuntimeCredentialRequest,
  decodeLocalRuntimeCredentialResult,
  encodeLocalRuntimeCredentialResult,
  type NativeProviderCredentialRequest,
} from '@kite-ai/kite-local-runtime/client';
import {
  decodeLocalRuntimeServiceDescriptor,
  decodeLocalRuntimeToken,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
  type LocalRuntimeServiceDescriptor,
} from '@kite-ai/kite-local-runtime/service';
import {
  assertListRuntimeLogEventsRequest,
  assertListRuntimeLogSessionsRequest,
  type ListRuntimeLogEventsRequest,
  type ListRuntimeLogSessionsRequest,
} from '@kite-ai/runtime-contract';
import {
  RUNTIME_PROTOCOL_ERROR_NUMBERS,
  RUNTIME_PROTOCOL_LIMITS,
  type RuntimeProtocolMessage,
} from '@kite-ai/runtime-protocol';
import type {
  RuntimeServer,
  RuntimeServerAdmissionDecision,
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
  RuntimeServerLogicalMessageConnection,
} from '@kite-ai/runtime-server';
import type { KiteServiceApplicationPort, ServiceWorkspaceAdmissionResult } from './ports';

export const KITE_SERVICE_LOOPBACK_HOST = '127.0.0.1' as const;
export const KITE_SERVICE_CONNECT_PATH = '/_kite/connect' as const;
export const KITE_SERVICE_INSTANCE_HANDSHAKE_PATH = '/_kite/instance' as const;
export const KITE_SERVICE_RPC_PATH = '/rpc' as const;
export const KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH = '/_kite/history/list-sessions' as const;
export const KITE_SERVICE_HISTORY_LIST_EVENTS_PATH = '/_kite/history/list-events' as const;
export const KITE_SERVICE_HISTORY_LOAD_SESSION_PATH = '/_kite/history/load-session' as const;
export const KITE_SERVICE_CONTROL_STOP_PATH = '/_kite/control/stop' as const;

export const KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME = 'Kite-Local-Access' as const;
export const KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME = 'Kite-Local-Control' as const;
export const KITE_SERVICE_TICKET_AUTHORIZATION_SCHEME = 'Kite-Local-Ticket' as const;

export const KITE_SERVICE_TICKET_TTL_MS = 30_000;

const MAX_CONNECT_BODY_BYTES = 16_384;
const DEFAULT_MAX_INCOMING_MESSAGES = RUNTIME_PROTOCOL_LIMITS.maxInFlightRequests;
const DEFAULT_MAX_INCOMING_BYTES = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 2;
const DEFAULT_MAX_OUTBOUND_MESSAGES = RUNTIME_PROTOCOL_LIMITS.maxOutboundMessages;
const DEFAULT_MAX_OUTBOUND_BYTES = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 2;
const DEFAULT_MAX_BUFFERED_AMOUNT = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 2;
const DEFAULT_DRAIN_DEADLINE_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_DEADLINE_MS = 45_000;
const DEFAULT_MAX_HTTP_BODY_BYTES = RUNTIME_PROTOCOL_LIMITS.maxMessageBytes;
const MAX_TICKETS = 1_024;
const HEARTBEAT_POLL_INTERVAL_MS = 10;

type RequestIp = Readonly<{ address: string }> | null;
type SocketData = Readonly<{ session: ServiceSocketSession }>;

export type KiteServiceCarrierDiagnosticCode =
  | 'socket_open'
  | 'socket_closed'
  | 'outbound_sent'
  | 'outbound_backpressure'
  | 'outbound_dropped'
  | 'route_rejected'
  | 'route_unavailable';

export interface KiteServiceCarrierLimits {
  readonly maxIncomingMessages?: number;
  readonly maxIncomingBytes?: number;
  readonly maxOutboundMessages?: number;
  readonly maxOutboundBytes?: number;
  readonly maxBufferedAmount?: number;
  readonly drainDeadlineMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatDeadlineMs?: number;
  readonly maxHttpBodyBytes?: number;
}

export interface KiteServiceCarrierOptions {
  /** Runtime Server is injected; the carrier never constructs Host/Store/Builtin. */
  readonly application: KiteServiceApplicationPort;
  readonly instanceId: string;
  readonly serverVersion: string;
  readonly buildId: string;
  /** Access and control material are supplied by the Service state owner. */
  readonly accessToken: string;
  readonly controlToken: string;
  /** The listener is created only after the injected application is ready. */
  readonly isReady?: () => boolean;
  readonly limits?: KiteServiceCarrierLimits;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
  /** Test-only replacement for Bun's peer address inspection. */
  readonly requestIp?: (request: Request, server: Bun.Server<SocketData>) => RequestIp;
  /** Test-only listener factory used to inject deterministic socket faults. */
  readonly serve?: typeof Bun.serve;
  /** Diagnostics contain codes only; request bodies and secrets never reach this callback. */
  readonly onDiagnostic?: (code: KiteServiceCarrierDiagnosticCode) => void;
}

export interface KiteServiceCarrier extends AsyncDisposable {
  readonly descriptor: LocalRuntimeServiceDescriptor;
  readonly origin: string;
  readonly rpcUrl: string;
  close(): Promise<void>;
}

interface NormalizedLimits {
  readonly maxIncomingMessages: number;
  readonly maxIncomingBytes: number;
  readonly maxOutboundMessages: number;
  readonly maxOutboundBytes: number;
  readonly maxBufferedAmount: number;
  readonly drainDeadlineMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatDeadlineMs: number;
  readonly maxHttpBodyBytes: number;
}

interface TicketRecord {
  readonly hash: Buffer;
  readonly workspace: KiteWorkspaceIdentity;
  readonly instanceId: string;
  readonly expiresAt: number;
}

/**
 * Production Native loopback carrier.  It has no cookie or browser session
 * model: access-token HTTP routes issue a one-shot ticket, and the ticket is
 * consumed by exactly one WebSocket upgrade.
 */
export function createKiteServiceCarrier(options: KiteServiceCarrierOptions): KiteServiceCarrier {
  const limits = normalizeLimits(options.limits);
  const now = options.now ?? Date.now;
  const random = options.randomBytes ?? ((size: number) => systemRandomBytes(size));
  const accessToken = decodeLocalRuntimeToken(options.accessToken);
  const controlToken = decodeLocalRuntimeToken(options.controlToken);
  if (secretsEqual(accessToken, controlToken)) {
    throw new TypeError('Service access and control tokens must be distinct.');
  }
  const startedAt = new Date(safeNow(now)).toISOString();
  const tickets = new TicketAuthority(random, now);
  const sessions = new Set<ServiceSocketSession>();
  let closed = false;
  let closing: Promise<void> | undefined;
  let bunServer: Bun.Server<SocketData> | undefined;

  const closeAllSockets = (): unknown[] => {
    const failures: unknown[] = [];
    for (const session of [...sessions]) {
      try {
        session.forceClose(1012, 'service_restart');
      } catch (error) {
        failures.push(error);
      }
    }
    return failures;
  };

  const serve = options.serve ?? Bun.serve;
  bunServer = serve<SocketData>({
    hostname: KITE_SERVICE_LOOPBACK_HOST,
    port: 0,
    development: false,
    fetch(request, server) {
      const port = server.port;
      if (!port || closed) return fixedResponse(503, 'unavailable');
      const binding = bindingFor(port);
      const requestIp = (options.requestIp ?? defaultRequestIp)(request, server);
      if (!isLoopbackRequest(requestIp) || request.headers.get('host') !== binding.host) {
        emitDiagnostic(options.onDiagnostic, 'route_rejected');
        return fixedResponse(403, 'forbidden');
      }
      const url = new URL(request.url);
      if (url.search.length !== 0) {
        emitDiagnostic(options.onDiagnostic, 'route_rejected');
        return fixedResponse(403, 'forbidden');
      }
      if (url.pathname === '/healthz' || url.pathname === '/readyz') {
        if (
          request.method !== 'GET' ||
          !originAbsentOrExact(request, binding.origin) ||
          hasCredentialHeaders(request)
        ) {
          emitDiagnostic(options.onDiagnostic, 'route_rejected');
          return fixedResponse(403, 'forbidden');
        }
        if (url.pathname === '/readyz' && !(options.isReady?.() ?? true)) {
          return fixedResponse(503, 'unavailable');
        }
        return fixedResponse(200, url.pathname === '/healthz' ? 'ok' : 'ready');
      }
      if (!(options.isReady?.() ?? true)) return fixedResponse(503, 'unavailable');
      if (url.pathname === KITE_SERVICE_INSTANCE_HANDSHAKE_PATH) {
        return afterDispatchCloseBarrier(
          handleInstanceHandshake(request, binding, options, limits),
          () => closed,
        );
      }
      if (url.pathname === KITE_SERVICE_CONNECT_PATH) {
        return afterDispatchCloseBarrier(
          handleConnect(request, binding, options, tickets, limits),
          () => closed,
        );
      }
      if (url.pathname === KITE_SERVICE_RPC_PATH) {
        return handleRpcUpgrade(
          request,
          server,
          binding,
          options,
          tickets,
          sessions,
          limits,
          () => closed,
        );
      }
      if (isHistoryPath(url.pathname)) {
        return afterDispatchCloseBarrier(
          handleHistoryRoute(request, binding, options, url.pathname, limits),
          () => closed,
        );
      }
      if (isAppControlPath(url.pathname)) {
        return afterDispatchCloseBarrier(
          handleAppControlRoute(request, binding, options, url.pathname, limits),
          () => closed,
        );
      }
      if (url.pathname === KITE_SERVICE_CONTROL_STOP_PATH) {
        return afterDispatchCloseBarrier(handleControlStop(request, options, limits), () => closed);
      }
      emitDiagnostic(options.onDiagnostic, 'route_rejected');
      return fixedResponse(request.method === 'OPTIONS' ? 405 : 404, 'not_found');
    },
    websocket: {
      data: {} as SocketData,
      maxPayloadLength: RUNTIME_PROTOCOL_LIMITS.maxMessageBytes * 2,
      backpressureLimit: limits.maxBufferedAmount,
      closeOnBackpressureLimit: true,
      sendPings: false,
      open(socket) {
        socket.data.session.open(socket);
      },
      message(socket, message) {
        socket.data.session.message(socket, message);
      },
      drain(socket) {
        socket.data.session.drain();
      },
      ping(socket, data) {
        socket.pong(data);
      },
      pong(socket) {
        socket.data.session.heartbeat();
      },
      close(socket) {
        socket.data.session.closedByPeer();
      },
    },
  });

  try {
    const port = bunServer.port;
    if (!port) throw new Error('Service carrier did not obtain an ephemeral loopback port.');
    const binding = bindingFor(port);
    const decodedDescriptor = decodeLocalRuntimeServiceDescriptor({
      schema: LOCAL_RUNTIME_SERVICE_DESCRIPTOR_SCHEMA_,
      instanceId: options.instanceId,
      pid: process.pid,
      startedAt,
      endpoint: {
        origin: binding.origin,
        websocketUrl: `ws://${binding.host}${KITE_SERVICE_RPC_PATH}`,
      },
      protocolVersion: 1,
      clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
      serverVersion: options.serverVersion,
      buildId: options.buildId,
    });
    const descriptor: LocalRuntimeServiceDescriptor = Object.freeze({
      ...decodedDescriptor,
      endpoint: Object.freeze({ ...decodedDescriptor.endpoint }),
    });
    return Object.freeze({
      descriptor,
      origin: binding.origin,
      rpcUrl: descriptor.endpoint.websocketUrl,
      close(): Promise<void> {
        closing ??= (async () => {
          closed = true;
          tickets.close();
          const failures: unknown[] = [];
          try {
            await options.application.server.beginDraining();
          } catch (error) {
            failures.push(error);
          } finally {
            failures.push(...closeAllSockets());
            sessions.clear();
            try {
              if (bunServer)
                await stopListenerAfterActiveResponses(bunServer, limits.drainDeadlineMs);
            } catch (error) {
              failures.push(error);
            }
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures);
        })();
        return closing;
      },
      [Symbol.asyncDispose](): Promise<void> {
        return this.close();
      },
    });
  } catch (error) {
    closed = true;
    tickets.close();
    closeAllSockets();
    if (bunServer) void bunServer.stop(true);
    throw error;
  }
}

export const createNativeLoopbackCarrier = createKiteServiceCarrier;

async function stopListenerAfterActiveResponses(
  server: Bun.Server<SocketData>,
  deadlineMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const drained = await Promise.race([
      Promise.resolve(server.stop(false)).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), deadlineMs);
      }),
    ]);
    if (!drained) await server.stop(true);
  } catch (error) {
    try {
      await server.stop(true);
    } catch (forceError) {
      throw new AggregateError([error, forceError]);
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function afterDispatchCloseBarrier(
  response: Response | Promise<Response>,
  isClosing: () => boolean,
): Response | Promise<Response> {
  if (!(response instanceof Promise)) return response;
  return response.then((resolved) => (isClosing() ? fixedResponse(503, 'unavailable') : resolved));
}

function handleInstanceHandshake(
  request: Request,
  binding: Readonly<{ host: string; origin: string }>,
  options: KiteServiceCarrierOptions,
  limits: NormalizedLimits,
): Response | Promise<Response> {
  if (
    request.method !== 'POST' ||
    !originAbsentOrExact(request, binding.origin) ||
    request.headers.get('cookie') !== null ||
    !matchesAuthorization(
      request.headers.get('authorization'),
      options.accessToken,
      KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
    ) ||
    !isJsonContentType(request.headers.get('content-type'))
  ) {
    emitDiagnostic(options.onDiagnostic, 'route_rejected');
    return fixedResponse(401, 'unauthorized');
  }
  return readJsonBody(request, limits.maxHttpBodyBytes).then((body) => {
    if (!body.ok) return fixedResponse(400, 'invalid_request');
    try {
      assertExactKeys(body.value, []);
    } catch {
      return fixedResponse(400, 'invalid_request');
    }
    return jsonResponse(
      200,
      {
        schema: 'kite.local-runtime.instance-handshake.v1',
        instanceId: options.instanceId,
        protocolVersion: 1,
        clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
        serverVersion: options.serverVersion,
        buildId: options.buildId,
      },
      limits.maxHttpBodyBytes,
    );
  });
}

function normalizeLimits(input: KiteServiceCarrierLimits | undefined): NormalizedLimits {
  const limits: NormalizedLimits = {
    maxIncomingMessages: input?.maxIncomingMessages ?? DEFAULT_MAX_INCOMING_MESSAGES,
    maxIncomingBytes: input?.maxIncomingBytes ?? DEFAULT_MAX_INCOMING_BYTES,
    maxOutboundMessages: input?.maxOutboundMessages ?? DEFAULT_MAX_OUTBOUND_MESSAGES,
    maxOutboundBytes: input?.maxOutboundBytes ?? DEFAULT_MAX_OUTBOUND_BYTES,
    maxBufferedAmount: input?.maxBufferedAmount ?? DEFAULT_MAX_BUFFERED_AMOUNT,
    drainDeadlineMs: input?.drainDeadlineMs ?? DEFAULT_DRAIN_DEADLINE_MS,
    heartbeatIntervalMs: input?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatDeadlineMs: input?.heartbeatDeadlineMs ?? DEFAULT_HEARTBEAT_DEADLINE_MS,
    maxHttpBodyBytes: input?.maxHttpBodyBytes ?? DEFAULT_MAX_HTTP_BODY_BYTES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive safe integer.`);
    }
  }
  const ceilings: NormalizedLimits = {
    maxIncomingMessages: DEFAULT_MAX_INCOMING_MESSAGES,
    maxIncomingBytes: DEFAULT_MAX_INCOMING_BYTES,
    maxOutboundMessages: DEFAULT_MAX_OUTBOUND_MESSAGES,
    maxOutboundBytes: DEFAULT_MAX_OUTBOUND_BYTES,
    maxBufferedAmount: DEFAULT_MAX_BUFFERED_AMOUNT,
    drainDeadlineMs: 30_000,
    heartbeatIntervalMs: 60_000,
    heartbeatDeadlineMs: 300_000,
    maxHttpBodyBytes: DEFAULT_MAX_HTTP_BODY_BYTES,
  };
  for (const [name, value] of Object.entries(limits) as Array<[keyof NormalizedLimits, number]>) {
    if (value > ceilings[name]) throw new RangeError(`${name} exceeds the Service hard ceiling.`);
  }
  if (limits.maxIncomingBytes < RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) {
    throw new RangeError('maxIncomingBytes must fit one Runtime Protocol message.');
  }
  if (limits.maxOutboundBytes < RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) {
    throw new RangeError('maxOutboundBytes must fit one Runtime Protocol message.');
  }
  if (limits.maxHttpBodyBytes < MAX_CONNECT_BODY_BYTES) {
    throw new RangeError('maxHttpBodyBytes must fit the exact connect body limit.');
  }
  if (limits.heartbeatDeadlineMs < limits.heartbeatIntervalMs) {
    throw new RangeError('heartbeatDeadlineMs must not be shorter than heartbeatIntervalMs.');
  }
  return Object.freeze(limits);
}

function handleConnect(
  request: Request,
  binding: Readonly<{ host: string; origin: string }>,
  options: KiteServiceCarrierOptions,
  tickets: TicketAuthority,
  limits: NormalizedLimits,
): Response | Promise<Response> {
  if (
    request.method !== 'POST' ||
    !originAbsentOrExact(request, binding.origin) ||
    request.headers.get('cookie') !== null ||
    !matchesAuthorization(
      request.headers.get('authorization'),
      options.accessToken,
      KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
    ) ||
    !isJsonContentType(request.headers.get('content-type'))
  ) {
    emitDiagnostic(options.onDiagnostic, 'route_rejected');
    return fixedResponse(401, 'unauthorized');
  }
  return readJsonBody(request, Math.min(MAX_CONNECT_BODY_BYTES, limits.maxHttpBodyBytes)).then(
    async (body) => {
      if (!body.ok) return fixedResponse(400, 'invalid_request');
      const workspacePath = decodeConnectBody(body.value);
      if (workspacePath === undefined) return fixedResponse(400, 'invalid_request');
      let admitted: ServiceWorkspaceAdmissionResult;
      try {
        admitted = await options.application.workspaceAdmission.admitForConnect(workspacePath);
      } catch {
        emitDiagnostic(options.onDiagnostic, 'route_unavailable');
        return fixedResponse(503, 'workspace_unavailable');
      }
      if (admitted.outcome === 'untrusted') return fixedResponse(403, 'workspace_untrusted');
      if (admitted.outcome !== 'admitted') return fixedResponse(503, 'workspace_unavailable');
      let ticket: string | undefined;
      try {
        ticket = tickets.issue(admitted.workspace, options.instanceId, KITE_SERVICE_TICKET_TTL_MS);
      } catch {
        emitDiagnostic(options.onDiagnostic, 'route_unavailable');
        return fixedResponse(503, 'unavailable');
      }
      if (ticket === undefined) return fixedResponse(503, 'unavailable');
      return jsonResponse(200, { ticket }, limits.maxHttpBodyBytes);
    },
  );
}

function handleRpcUpgrade(
  request: Request,
  server: Bun.Server<SocketData>,
  binding: Readonly<{ host: string; origin: string }>,
  options: KiteServiceCarrierOptions,
  tickets: TicketAuthority,
  sessions: Set<ServiceSocketSession>,
  limits: NormalizedLimits,
  isClosing: () => boolean,
): Response | undefined {
  if (
    request.method !== 'GET' ||
    !originAbsentOrExact(request, binding.origin) ||
    request.headers.get('cookie') !== null ||
    request.headers.get('sec-websocket-protocol') !== null ||
    !isWebSocketUpgrade(request)
  ) {
    emitDiagnostic(options.onDiagnostic, 'route_rejected');
    return fixedResponse(403, 'forbidden');
  }
  if (isClosing()) return fixedResponse(503, 'unavailable');
  const ticket = authorizationToken(
    request.headers.get('authorization'),
    KITE_SERVICE_TICKET_AUTHORIZATION_SCHEME,
  );
  const workspace = ticket ? tickets.consume(ticket, options.instanceId) : undefined;
  if (!workspace) return fixedResponse(401, 'unauthorized');
  if (isClosing()) return fixedResponse(503, 'unavailable');
  const session = new ServiceSocketSession({
    server: options.application.server,
    application: options.application,
    workspace,
    limits,
    now: options.now ?? Date.now,
    sessions,
    onDiagnostic: options.onDiagnostic,
  });
  if (isClosing()) {
    session.forceClose(1012, 'service_restart');
    return fixedResponse(503, 'unavailable');
  }
  sessions.add(session);
  let upgraded = false;
  try {
    upgraded = server.upgrade(request, { data: { session } });
  } catch {
    cleanupRejectedSession(sessions, session);
    return fixedResponse(503, 'unavailable');
  }
  if (!upgraded) {
    cleanupRejectedSession(sessions, session);
    return fixedResponse(400, 'bad_request');
  }
  return undefined;
}

function cleanupRejectedSession(
  sessions: Set<ServiceSocketSession>,
  session: ServiceSocketSession,
): void {
  sessions.delete(session);
  try {
    session.forceClose(4000, 'upgrade_failed');
  } catch {
    // Upgrade cleanup is best-effort; the rejected session is no longer retained.
  }
}

function handleHistoryRoute(
  request: Request,
  binding: Readonly<{ host: string; origin: string }>,
  options: KiteServiceCarrierOptions,
  pathname: string,
  limits: NormalizedLimits,
): Response | Promise<Response> {
  if (
    request.method !== 'POST' ||
    !originAbsentOrExact(request, binding.origin) ||
    request.headers.get('cookie') !== null ||
    !matchesAuthorization(
      request.headers.get('authorization'),
      options.accessToken,
      KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
    ) ||
    !isJsonContentType(request.headers.get('content-type'))
  ) {
    emitDiagnostic(options.onDiagnostic, 'route_rejected');
    return fixedResponse(401, 'unauthorized');
  }
  return readJsonBody(request, limits.maxHttpBodyBytes).then(async (body) => {
    if (!body.ok) return fixedResponse(400, 'invalid_request');
    if (pathname === KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH) {
      let value: ListRuntimeLogSessionsRequest;
      try {
        assertAllowedKeys(body.value, ['cursor', 'limit', 'query']);
        if (isPlainRecord(body.value) && body.value.cursor !== undefined)
          assertAllowedKeys(body.value.cursor, ['sessionId', 'updatedAt']);
        value = body.value as ListRuntimeLogSessionsRequest;
        assertListRuntimeLogSessionsRequest(value);
      } catch {
        return fixedResponse(400, 'invalid_request');
      }
      return invokeHistoryRoute(
        () => options.application.history.listSessions(value),
        limits.maxHttpBodyBytes,
      );
    }
    if (pathname === KITE_SERVICE_HISTORY_LIST_EVENTS_PATH) {
      let value: ListRuntimeLogEventsRequest;
      try {
        assertAllowedKeys(body.value, [
          'afterSequence',
          'beforeSequence',
          'direction',
          'eventTypes',
          'limit',
          'sessionId',
        ]);
        value = body.value as ListRuntimeLogEventsRequest;
        assertListRuntimeLogEventsRequest(value);
      } catch {
        return fixedResponse(400, 'invalid_request');
      }
      return invokeHistoryRoute(
        () => options.application.history.listEvents(value),
        limits.maxHttpBodyBytes,
      );
    }
    let value: { readonly sessionId: string };
    try {
      assertExactKeys(body.value, ['sessionId']);
      if (!isPlainRecord(body.value) || !boundedString(body.value.sessionId, 512))
        throw new TypeError('invalid session id');
      value = { sessionId: body.value.sessionId as string };
    } catch {
      return fixedResponse(400, 'invalid_request');
    }
    return invokeHistoryRoute(
      () => options.application.history.loadSession(value.sessionId),
      limits.maxHttpBodyBytes,
    );
  });
}

async function invokeHistoryRoute<T>(
  operation: () => Promise<T>,
  maxBytes: number,
): Promise<Response> {
  try {
    const result = await operation();
    return jsonResponse(200, result, maxBytes);
  } catch {
    return fixedResponse(503, 'temporarily_unavailable');
  }
}

function handleAppControlRoute(
  request: Request,
  binding: Readonly<{ host: string; origin: string }>,
  options: KiteServiceCarrierOptions,
  pathname: string,
  limits: NormalizedLimits,
): Response | Promise<Response> {
  if (
    request.method !== 'POST' ||
    !originAbsentOrExact(request, binding.origin) ||
    request.headers.get('cookie') !== null ||
    !matchesAuthorization(
      request.headers.get('authorization'),
      options.accessToken,
      KITE_SERVICE_ACCESS_AUTHORIZATION_SCHEME,
    ) ||
    !isJsonContentType(request.headers.get('content-type'))
  ) {
    emitDiagnostic(options.onDiagnostic, 'route_rejected');
    return fixedResponse(401, 'unauthorized');
  }
  return readJsonBody(request, limits.maxHttpBodyBytes).then((body) => {
    if (!body.ok) return fixedResponse(400, 'invalid_request');
    return dispatchAppControlRoute(
      options.application,
      pathname,
      body.value,
      limits.maxHttpBodyBytes,
      request.signal,
    );
  });
}

async function dispatchAppControlRoute(
  application: KiteServiceApplicationPort,
  pathname: string,
  body: unknown,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Response> {
  switch (pathname) {
    case '/_kite/app/workspace-trust/query':
      return invokeCodecRoute(
        body,
        workspaceTrustQueryRequestCodec,
        workspaceTrustQueryResponseCodec,
        (request) => application.appControl.discovery.queryWorkspaceTrust(request),
        maxBytes,
      );
    case '/_kite/app/workspace-trust/decide':
      return invokeCodecRoute(
        body,
        workspaceTrustDecisionRequestCodec,
        workspaceTrustDecisionResponseCodec,
        (request) => application.appControl.discovery.decideWorkspaceTrust(request),
        maxBytes,
      );
    case '/_kite/app/provider-model/snapshot':
      return invokeWorkspaceCodecRoute(
        application,
        body,
        providerModelSnapshotRequestCodec,
        providerModelSnapshotResponseCodec,
        (request) =>
          application.appControl.forWorkspace(request.workspace).getProviderModelSnapshot(request),
        (response) => response.workspace,
        maxBytes,
      );
    case '/_kite/app/provider-model/select':
      return invokeWorkspaceCodecRoute(
        application,
        body,
        providerModelSelectRequestCodec,
        providerModelSelectResponseCodec,
        (request) =>
          application.appControl.forWorkspace(request.workspace).selectProviderModel(request),
        (response) => response.snapshot.workspace,
        maxBytes,
      );
    case '/_kite/app/mcp/snapshot':
      return invokeWorkspaceCodecRoute(
        application,
        body,
        mcpSnapshotRequestCodec,
        mcpSnapshotResponseCodec,
        (request) => application.appControl.forWorkspace(request.workspace).getMcpSnapshot(request),
        (response) => response.workspace,
        maxBytes,
      );
    case '/_kite/app/mcp/action':
      return invokeWorkspaceCodecRoute(
        application,
        body,
        mcpActionRequestCodec,
        mcpActionResponseCodec,
        (request) => application.appControl.forWorkspace(request.workspace).applyMcpAction(request),
        (response) => response.snapshot.workspace,
        maxBytes,
      );
    case '/_kite/app/skills/catalog':
      return invokeWorkspaceCodecRoute(
        application,
        body,
        skillCatalogRequestCodec,
        skillCatalogResponseCodec,
        (request) =>
          application.appControl.forWorkspace(request.workspace).getSkillCatalog(request),
        (response) => response.workspace,
        maxBytes,
      );
    case '/_kite/app/execution/status':
      return invokeWorkspaceCodecRoute(
        application,
        body,
        executionStatusRequestCodec,
        executionStatusResponseCodec,
        (request) =>
          application.appControl.forWorkspace(request.workspace).getExecutionStatus(request),
        (response) => response.workspace,
        maxBytes,
      );
    case '/_kite/app/release/status':
      return invokeCodecRoute(
        body,
        releaseStatusRequestCodec,
        releaseStatusResponseCodec,
        (request) => application.appControl.discovery.getReleaseStatus(request),
        maxBytes,
      );
    case '/_kite/app/provider-credential/write':
      return invokeCredentialRoute(application, body, maxBytes, signal);
    default:
      return fixedResponse(404, 'not_found');
  }
}

async function invokeCodecRoute<Request, ResponseValue>(
  body: unknown,
  requestCodec: ExactJsonCodec<Request>,
  responseCodec: ExactJsonCodec<ResponseValue>,
  operation: (request: Request) => Promise<ResponseValue>,
  maxBytes: number,
): Promise<globalThis.Response> {
  let request: Request;
  try {
    request = requestCodec.decode(body);
  } catch {
    return fixedResponse(400, 'invalid_request');
  }
  try {
    const response = await operation(request);
    return jsonResponse(200, responseCodec.encode(response), maxBytes);
  } catch {
    return fixedResponse(503, 'temporarily_unavailable');
  }
}

async function invokeWorkspaceCodecRoute<
  Request extends { readonly workspace: KiteWorkspaceIdentity },
  ResponseValue,
>(
  application: KiteServiceApplicationPort,
  body: unknown,
  requestCodec: ExactJsonCodec<Request>,
  responseCodec: ExactJsonCodec<ResponseValue>,
  operation: (request: Request) => Promise<ResponseValue>,
  responseWorkspace: (response: ResponseValue) => KiteWorkspaceIdentity,
  maxBytes: number,
): Promise<globalThis.Response> {
  let request: Request;
  try {
    request = requestCodec.decode(body);
  } catch {
    return fixedResponse(400, 'invalid_request');
  }
  let admitted: KiteWorkspaceIdentity | undefined;
  try {
    admitted = await application.workspaceAdmission.resolveIdentity(request.workspace);
  } catch {
    return fixedResponse(503, 'workspace_unavailable');
  }
  if (!admitted || !sameWorkspace(admitted, request.workspace)) {
    return fixedResponse(403, 'forbidden');
  }
  try {
    const response = await operation(request);
    if (!sameWorkspace(responseWorkspace(response), admitted)) {
      return fixedResponse(503, 'temporarily_unavailable');
    }
    return jsonResponse(200, responseCodec.encode(response), maxBytes);
  } catch {
    return fixedResponse(503, 'temporarily_unavailable');
  }
}

async function invokeCredentialRoute(
  application: KiteServiceApplicationPort,
  body: unknown,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Response> {
  let request: NativeProviderCredentialRequest;
  try {
    const decoded = decodeLocalRuntimeCredentialRequest(body);
    if (decoded.operation !== 'write_provider_api_key')
      return fixedResponse(400, 'invalid_request');
    request = decoded;
  } catch {
    return fixedResponse(400, 'invalid_request');
  }
  if (!application.credential) return fixedResponse(503, 'unavailable');
  try {
    const result = await application.credential.writeProviderCredential(request, { signal });
    return jsonResponse(
      200,
      encodeLocalRuntimeCredentialResult(decodeLocalRuntimeCredentialResult(result)),
      maxBytes,
    );
  } catch {
    return fixedResponse(503, 'temporarily_unavailable');
  }
}

function handleControlStop(
  request: Request,
  options: KiteServiceCarrierOptions,
  limits: NormalizedLimits,
): Response | Promise<Response> {
  if (
    request.method !== 'POST' ||
    request.headers.get('origin') !== null ||
    request.headers.get('cookie') !== null ||
    !matchesAuthorization(
      request.headers.get('authorization'),
      options.controlToken,
      KITE_SERVICE_CONTROL_AUTHORIZATION_SCHEME,
    ) ||
    !isJsonContentType(request.headers.get('content-type'))
  ) {
    emitDiagnostic(options.onDiagnostic, 'route_rejected');
    return fixedResponse(401, 'unauthorized');
  }
  return readJsonBody(request, limits.maxHttpBodyBytes).then(async (body) => {
    if (!body.ok) return fixedResponse(400, 'invalid_request');
    try {
      assertExactKeys(body.value, []);
    } catch {
      return fixedResponse(400, 'invalid_request');
    }
    if (!options.application.control) return fixedResponse(503, 'unavailable');
    try {
      const result = await options.application.control.stop();
      return jsonResponse(200, result, limits.maxHttpBodyBytes);
    } catch {
      return fixedResponse(503, 'temporarily_unavailable');
    }
  });
}

class TicketAuthority {
  readonly #random: (size: number) => Uint8Array;
  readonly #now: () => number;
  readonly #tickets = new Map<string, TicketRecord>();
  #closed = false;

  constructor(random: (size: number) => Uint8Array, now: () => number) {
    this.#random = random;
    this.#now = now;
  }

  issue(workspace: KiteWorkspaceIdentity, instanceId: string, ttlMs: number): string | undefined {
    if (this.#closed) return undefined;
    this.cleanup();
    if (this.#tickets.size >= MAX_TICKETS) return undefined;
    const bytes = this.#random(32);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
      throw new TypeError('Service ticket random source must return exactly 32 bytes.');
    }
    const token = Buffer.from(bytes).toString('base64url');
    bytes.fill(0);
    const hash = hashToken(token);
    const key = hash.toString('hex');
    if (this.#tickets.has(key)) {
      hash.fill(0);
      return undefined;
    }
    const current = safeNow(this.#now);
    const expiresAt = current + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) {
      hash.fill(0);
      throw new RangeError('Service ticket expiry exceeds safe time.');
    }
    this.#tickets.set(key, {
      hash,
      workspace,
      instanceId,
      expiresAt,
    });
    return token;
  }

  consume(token: string, instanceId: string): KiteWorkspaceIdentity | undefined {
    const hash = hashToken(token);
    const key = hash.toString('hex');
    const record = this.#tickets.get(key);
    if (!record) {
      hash.fill(0);
      return undefined;
    }
    this.#tickets.delete(key);
    const same = timingSafeEqual(record.hash, hash);
    const valid = record.instanceId === instanceId && safeNow(this.#now) < record.expiresAt && same;
    hash.fill(0);
    record.hash.fill(0);
    return valid ? record.workspace : undefined;
  }

  cleanup(): void {
    const current = safeNow(this.#now);
    for (const [key, record] of this.#tickets) {
      if (current >= record.expiresAt) {
        record.hash.fill(0);
        this.#tickets.delete(key);
      }
    }
  }

  close(): void {
    this.#closed = true;
    for (const record of this.#tickets.values()) record.hash.fill(0);
    this.#tickets.clear();
  }
}

class ServiceRuntimeAdmission implements RuntimeServerAdmissionPort {
  readonly #application: KiteServiceApplicationPort;
  readonly #workspace: KiteWorkspaceIdentity;
  readonly #onBound: (connectionId: string) => void;
  #delegate: RuntimeServerAdmissionPort | undefined;
  #closed = false;
  #bound = false;

  constructor(
    application: KiteServiceApplicationPort,
    workspace: KiteWorkspaceIdentity,
    onBound: (connectionId: string) => void,
  ) {
    this.#application = application;
    this.#workspace = workspace;
    this.#onBound = onBound;
  }

  async authorize(input: RuntimeServerAdmissionInput): Promise<RuntimeServerAdmissionDecision> {
    if (this.#closed) return { allowed: false, reason: 'unauthorized' };
    let decision: RuntimeServerAdmissionDecision;
    try {
      this.#delegate ??= this.#application.runtimeAdmission.create(
        this.#workspace,
        input.connectionId,
      );
      decision = await this.#delegate.authorize(input);
    } catch {
      return { allowed: false, reason: 'unavailable' };
    }
    if (this.#closed) return { allowed: false, reason: 'unauthorized' };
    if (!decision.allowed) return decision;
    if (decision.workspace !== this.#workspace.canonicalPath) {
      return { allowed: false, reason: 'unauthorized' };
    }
    if (!this.#bound) {
      this.#bound = true;
      this.#onBound(input.connectionId);
    }
    return decision;
  }

  close(): void {
    this.#closed = true;
  }
}

class ServiceSocketSession implements RuntimeServerLogicalMessageConnection {
  readonly incoming: AsyncIterable<unknown>;
  readonly #queue: BoundedMessageQueue;
  readonly #server: RuntimeServer;
  readonly #application: KiteServiceApplicationPort;
  readonly #workspace: KiteWorkspaceIdentity;
  readonly #limits: NormalizedLimits;
  readonly #now: () => number;
  readonly #sessions: Set<ServiceSocketSession>;
  readonly #onDiagnostic: ((code: KiteServiceCarrierDiagnosticCode) => void) | undefined;
  readonly #outbound: OutboundSocketQueue;
  #socket: Bun.ServerWebSocket<SocketData> | undefined;
  #connection: ReturnType<RuntimeServer['open']> | undefined;
  #admission: ServiceRuntimeAdmission | undefined;
  #closed = false;
  #lastPong = 0;
  #heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(input: {
    readonly server: RuntimeServer;
    readonly application: KiteServiceApplicationPort;
    readonly workspace: KiteWorkspaceIdentity;
    readonly limits: NormalizedLimits;
    readonly now: () => number;
    readonly sessions: Set<ServiceSocketSession>;
    readonly onDiagnostic?: (code: KiteServiceCarrierDiagnosticCode) => void;
  }) {
    this.#server = input.server;
    this.#application = input.application;
    this.#workspace = input.workspace;
    this.#limits = input.limits;
    this.#now = input.now;
    this.#sessions = input.sessions;
    this.#onDiagnostic = input.onDiagnostic;
    this.#queue = new BoundedMessageQueue(
      input.limits.maxIncomingMessages,
      input.limits.maxIncomingBytes,
    );
    this.incoming = this.#queue;
    this.#outbound = new OutboundSocketQueue(
      input.limits,
      () => this.forceClose(1013, 'outbound_queue_full'),
      input.now,
      (code) => emitDiagnostic(this.#onDiagnostic, code),
    );
  }

  open(socket: Bun.ServerWebSocket<SocketData>): void {
    if (this.#closed) {
      socket.close(1012, 'service_restart');
      return;
    }
    this.#socket = socket;
    this.#lastPong = safeNow(this.#now);
    this.#heartbeatTimer = setInterval(
      () => this.#tickHeartbeat(),
      this.#limits.heartbeatIntervalMs,
    );
    this.#admission = new ServiceRuntimeAdmission(
      this.#application,
      this.#workspace,
      (connectionId) => this.#application.onConnectionBound?.(connectionId, this.#workspace),
    );
    this.#connection = this.#server.open(this, {
      admission: this.#admission,
      onClose: (connectionId) => {
        this.#admission?.close();
        this.#sessions.delete(this);
        this.#application.onConnectionClosed?.(connectionId);
      },
    });
    if (this.#connection.state === 'closed') this.forceClose(1013, 'server_unavailable');
    emitDiagnostic(this.#onDiagnostic, 'socket_open');
  }

  message(socket: Bun.ServerWebSocket<SocketData>, message: string | Buffer): void {
    if (this.#closed || socket !== this.#socket) return;
    if (typeof message !== 'string') {
      this.forceClose(1003, 'binary_unsupported');
      return;
    }
    const bytes = byteLength(message);
    if (bytes > RUNTIME_PROTOCOL_LIMITS.maxMessageBytes) {
      this.forceClose(1009, 'message_too_big');
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message) as unknown;
    } catch {
      void this.sendParseError();
      return;
    }
    if (!this.#queue.push(value, bytes)) this.forceClose(1013, 'message_queue_full');
  }

  drain(): void {
    this.#outbound.drain();
  }

  heartbeat(): void {
    this.#lastPong = safeNow(this.#now);
  }

  closedByPeer(): void {
    emitDiagnostic(this.#onDiagnostic, 'socket_closed');
    if (this.#closed) {
      this.#sessions.delete(this);
      return;
    }
    this.#closed = true;
    this.#admission?.close();
    this.#clearHeartbeat();
    this.#queue.close();
    this.#outbound.close();
    this.#sessions.delete(this);
  }

  forceClose(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#admission?.close();
    this.#clearHeartbeat();
    this.#queue.close();
    this.#outbound.close();
    this.#socket?.close(code, reason);
  }

  async send(message: RuntimeProtocolMessage): Promise<void> {
    await this.#outbound.send(message, this.#socket, this.#closed);
  }

  close(reason = 'connection_closed'): void {
    this.forceClose(1000, reason);
  }

  private async sendParseError(): Promise<void> {
    try {
      await this.send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: RUNTIME_PROTOCOL_ERROR_NUMBERS.parse_error,
          message: 'Parse error',
          data: { code: 'parse_error' },
        },
      });
    } catch {
      this.forceClose(1011, 'parse_response_failed');
    }
  }

  #tickHeartbeat(): void {
    const socket = this.#socket;
    if (!socket || this.#closed) return;
    if (safeNow(this.#now) - this.#lastPong >= this.#limits.heartbeatDeadlineMs) {
      this.forceClose(1001, 'heartbeat_timeout');
      return;
    }
    socket.ping();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== undefined) clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
  }
}

class OutboundSocketQueue {
  readonly #limits: NormalizedLimits;
  readonly #onOverflow: () => void;
  readonly #now: () => number;
  readonly #onDiagnostic: (code: KiteServiceCarrierDiagnosticCode) => void;
  readonly #waiters = new Set<() => void>();
  #tail = Promise.resolve();
  #pending = 0;
  #bytes = 0;
  #closed = false;

  constructor(
    limits: NormalizedLimits,
    onOverflow: () => void,
    now: () => number,
    onDiagnostic: (code: KiteServiceCarrierDiagnosticCode) => void,
  ) {
    this.#limits = limits;
    this.#onOverflow = onOverflow;
    this.#now = now;
    this.#onDiagnostic = onDiagnostic;
  }

  send(
    message: RuntimeProtocolMessage,
    socket: Bun.ServerWebSocket<SocketData> | undefined,
    closed: boolean,
  ): Promise<void> {
    if (this.#closed || closed || !socket) return Promise.reject(new Error('socket is closed'));
    const payload = JSON.stringify(message);
    const bytes = byteLength(payload);
    if (
      bytes > this.#limits.maxOutboundBytes ||
      this.#pending >= this.#limits.maxOutboundMessages ||
      this.#bytes + bytes > this.#limits.maxOutboundBytes
    ) {
      this.#onOverflow();
      return Promise.reject(new Error('socket outbound queue is full'));
    }
    this.#pending += 1;
    this.#bytes += bytes;
    const action = async (): Promise<void> => {
      if (this.#closed) throw new Error('socket is closed');
      await this.#waitForWritable(socket);
      const result = socket.sendText(payload);
      if (result === 0) {
        this.#onDiagnostic('outbound_dropped');
        this.#onOverflow();
        throw new Error('socket rejected outbound payload');
      }
      if (result < 0) {
        this.#onDiagnostic('outbound_backpressure');
        await this.#waitForWritable(socket);
      } else this.#onDiagnostic('outbound_sent');
      await nextIoTurn();
    };
    const current = this.#tail.then(action, action);
    this.#tail = current.catch(() => undefined);
    return current.finally(() => {
      this.#pending -= 1;
      this.#bytes -= bytes;
    });
  }

  drain(): void {
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  close(): void {
    this.#closed = true;
    this.drain();
  }

  async #waitForWritable(socket: Bun.ServerWebSocket<SocketData>): Promise<void> {
    const deadline = safeNow(this.#now) + this.#limits.drainDeadlineMs;
    while (!this.#closed && socket.getBufferedAmount() > this.#limits.maxBufferedAmount) {
      if (safeNow(this.#now) >= deadline) {
        this.#onOverflow();
        throw new Error('socket drain deadline exceeded');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            this.#waiters.delete(wake);
            resolve();
          },
          Math.min(HEARTBEAT_POLL_INTERVAL_MS, Math.max(1, deadline - safeNow(this.#now))),
        );
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.#waiters.add(wake);
      });
    }
    if (this.#closed) throw new Error('socket is closed');
  }
}

class BoundedMessageQueue implements AsyncIterable<unknown> {
  readonly #items: Array<{ readonly value: unknown; readonly bytes: number }> = [];
  readonly #waiters = new Set<(result: IteratorResult<unknown>) => void>();
  readonly #maxMessages: number;
  readonly #maxBytes: number;
  #bytes = 0;
  #closed = false;

  constructor(maxMessages: number, maxBytes: number) {
    this.#maxMessages = maxMessages;
    this.#maxBytes = maxBytes;
  }

  push(value: unknown, bytes: number): boolean {
    if (
      this.#closed ||
      this.#items.length >= this.#maxMessages ||
      this.#bytes + bytes > this.#maxBytes
    )
      return false;
    const waiter = this.#waiters.values().next().value;
    if (waiter) {
      this.#waiters.delete(waiter);
      waiter({ done: false, value });
      return true;
    }
    this.#items.push({ value, bytes });
    this.#bytes += bytes;
    return true;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.length = 0;
    this.#bytes = 0;
    for (const resolve of this.#waiters) resolve({ done: true, value: undefined });
    this.#waiters.clear();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    return {
      next: () => {
        const item = this.#items.shift();
        if (item) {
          this.#bytes -= item.bytes;
          return Promise.resolve({ done: false, value: item.value });
        }
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        if (this.#waiters.size > 0)
          return Promise.reject(new Error('Only one Runtime Server consumer is supported.'));
        return new Promise<IteratorResult<unknown>>((resolve) => this.#waiters.add(resolve));
      },
      return: async () => {
        this.close();
        return { done: true, value: undefined };
      },
    };
  }
}

function isHistoryPath(pathname: string): boolean {
  return (
    pathname === KITE_SERVICE_HISTORY_LIST_SESSIONS_PATH ||
    pathname === KITE_SERVICE_HISTORY_LIST_EVENTS_PATH ||
    pathname === KITE_SERVICE_HISTORY_LOAD_SESSION_PATH
  );
}

function isAppControlPath(pathname: string): boolean {
  return pathname.startsWith('/_kite/app/');
}

function decodeConnectBody(value: unknown): string | undefined {
  try {
    assertExactKeys(value, ['workspace']);
  } catch {
    return undefined;
  }
  if (!isPlainRecord(value) || !boundedString(value.workspace, 4_096)) return undefined;
  return value.workspace as string;
}

function readJsonBody(
  request: Request,
  maximumBytes: number,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const value = Number(contentLength);
    if (!Number.isSafeInteger(value) || value < 0 || value > maximumBytes)
      return Promise.resolve({ ok: false });
  }
  if (!request.body) return Promise.resolve({ ok: false });
  return (async () => {
    const reader = request.body?.getReader();
    if (!reader) return { ok: false } as const;
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel();
          return { ok: false } as const;
        }
        chunks.push(next.value);
      }
    } catch {
      return { ok: false } as const;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return { ok: false } as const;
    }
    try {
      return { ok: true, value: JSON.parse(text) as unknown } as const;
    } catch {
      return { ok: false } as const;
    }
  })();
}

function assertExactKeys(value: unknown, keys: readonly string[]): void {
  if (!isPlainRecord(value)) throw new TypeError('Expected a plain object.');
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index]))
    throw new TypeError('Unexpected request fields.');
}

function assertAllowedKeys(value: unknown, keys: readonly string[]): void {
  if (!isPlainRecord(value)) throw new TypeError('Expected a plain object.');
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw new TypeError('Unexpected request fields.');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => /\p{Cc}/u.test(character))
  );
}

function sameWorkspace(left: KiteWorkspaceIdentity, right: KiteWorkspaceIdentity): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

function authorizationToken(value: string | null, scheme: string): string | undefined {
  const prefix = `${scheme} `;
  if (typeof value !== 'string' || !value.startsWith(prefix)) return undefined;
  const token = value.slice(prefix.length);
  try {
    decodeLocalRuntimeToken(token);
    return token;
  } catch {
    return undefined;
  }
}

function matchesAuthorization(value: string | null, expected: string, scheme: string): boolean {
  const token = authorizationToken(value, scheme);
  const candidate = hashToken(token ?? '');
  const target = hashToken(expected);
  const match = candidate.byteLength === target.byteLength && timingSafeEqual(candidate, target);
  candidate.fill(0);
  target.fill(0);
  return match;
}

function secretsEqual(left: string, right: string): boolean {
  const leftHash = hashToken(left);
  const rightHash = hashToken(right);
  const equal = timingSafeEqual(leftHash, rightHash);
  leftHash.fill(0);
  rightHash.fill(0);
  return equal;
}

function hashToken(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function isJsonContentType(value: string | null): boolean {
  return value === 'application/json';
}

function hasCredentialHeaders(request: Request): boolean {
  return request.headers.get('authorization') !== null || request.headers.get('cookie') !== null;
}

function originAbsentOrExact(request: Request, origin: string): boolean {
  const value = request.headers.get('origin');
  return value === null || value === origin;
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function isLoopbackRequest(value: RequestIp): boolean {
  return value?.address === KITE_SERVICE_LOOPBACK_HOST;
}

function defaultRequestIp(request: Request, server: Bun.Server<SocketData>): RequestIp {
  return server.requestIP(request);
}

function bindingFor(port: number): Readonly<{ host: string; origin: string }> {
  const host = `${KITE_SERVICE_LOOPBACK_HOST}:${port}`;
  return Object.freeze({ host, origin: `http://${host}` });
}

function fixedResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: securityHeaders('text/plain; charset=utf-8'),
  });
}

function jsonResponse(status: number, value: unknown, maximumBytes: number): Response {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return fixedResponse(503, 'temporarily_unavailable');
  }
  if (byteLength(encoded) > maximumBytes) return fixedResponse(503, 'temporarily_unavailable');
  return new Response(encoded, {
    status,
    headers: securityHeaders('application/json; charset=utf-8'),
  });
}

function securityHeaders(contentType: string): HeadersInit {
  return {
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError('Clock must be non-negative.');
  return value;
}

function emitDiagnostic(
  listener: ((code: KiteServiceCarrierDiagnosticCode) => void) | undefined,
  code: KiteServiceCarrierDiagnosticCode,
): void {
  try {
    listener?.(code);
  } catch {
    // Diagnostic observation cannot retain sockets, admission, tickets or listener resources.
  }
}

function nextIoTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
