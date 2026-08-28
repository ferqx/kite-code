import { randomUUID } from 'node:crypto';
import {
  COORDINATOR_CLIENT_CONTRACT_REVISION_,
  COORDINATOR_PROTOCOL_REVISION_,
  COORDINATOR_PROTOCOL_VERSION,
  type CoordinatorError,
  type CoordinatorHandshakeRequest,
  type CoordinatorHandshakeResponse,
  type CoordinatorIdentity,
  type CoordinatorListSessionMetadataParams,
  type CoordinatorMethod,
  type CoordinatorMintWorkerConnectionCapabilityParams,
  type CoordinatorOsIdentity,
  type CoordinatorPeerIdentity,
  type CoordinatorRequestFrame,
  type CoordinatorResolveSessionWorkspaceParams,
  type CoordinatorResponseFor,
  type CoordinatorResponseFrame,
  type CoordinatorResultByMethod,
  type CoordinatorStatusParams,
  type CoordinatorSubscribeDirectoryChangesParams,
  type CoordinatorWorkspaceParams,
  decodeCoordinatorHandshakeRequest,
  decodeCoordinatorHandshakeResponse,
  decodeCoordinatorRequestFrame,
  decodeCoordinatorResponseFrame,
  encodeCoordinatorResponseFrame,
} from './codecs';

export type CoordinatorParamsByMethod = {
  readonly status: CoordinatorStatusParams;
  readonly resolveWorkspaceWorker: CoordinatorWorkspaceParams;
  readonly ensureWorkspaceWorker: CoordinatorWorkspaceParams;
  readonly resolveSessionWorkspace: CoordinatorResolveSessionWorkspaceParams;
  readonly listSessionMetadata: CoordinatorListSessionMetadataParams;
  readonly mintWorkerConnectionCapability: CoordinatorMintWorkerConnectionCapabilityParams;
  readonly ensureWebGateway: Record<never, never>;
  readonly discoverWebGateway: Record<never, never>;
  readonly stopWebGateway: Record<never, never>;
  readonly subscribeDirectoryChanges: CoordinatorSubscribeDirectoryChangesParams;
};

export interface CoordinatorDispatchContext<M extends CoordinatorMethod = CoordinatorMethod> {
  readonly method: M;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  /** Absolute local deadline; it is never sent back over the wire. */
  readonly deadlineAtMs: number;
  /** Authenticated by this connection's accepted handshake. */
  readonly peer: CoordinatorPeerIdentity;
}

export type CoordinatorHandler<M extends CoordinatorMethod> = (
  params: CoordinatorParamsByMethod[M],
  context: CoordinatorDispatchContext<M>,
) => CoordinatorResultByMethod[M] | Promise<CoordinatorResultByMethod[M]>;

export type CoordinatorDispatcherHandlers = {
  readonly [M in CoordinatorMethod]: CoordinatorHandler<M>;
};

export interface CoordinatorDispatcherOptions {
  readonly identity: CoordinatorIdentity;
  /** Actual peer identity obtained by the local carrier, not a claimed path. */
  readonly peerOsIdentity: CoordinatorOsIdentity;
  readonly handlers: CoordinatorDispatcherHandlers;
  readonly now?: () => number;
}

export class CoordinatorDispatcherError extends Error {
  readonly code: CoordinatorError['code'];

  constructor(code: CoordinatorError['code'], message: string) {
    super(message);
    this.name = 'CoordinatorDispatcherError';
    this.code = code;
  }
}

export interface CoordinatorDispatcher {
  handleHandshake(value: unknown): CoordinatorHandshakeResponse;
  dispatch(value: unknown, peer: CoordinatorPeerIdentity): Promise<CoordinatorResponseFrame>;
}

/**
 * Fixed-method Coordinator dispatcher.  It is intentionally a small method
 * switch, not a generic RPC registry: codecs decide which calls exist and the
 * dispatcher only invokes the corresponding typed handler.
 */
export function createCoordinatorDispatcher(
  options: CoordinatorDispatcherOptions,
): CoordinatorDispatcher {
  const now = options.now ?? Date.now;

  return Object.freeze({
    handleHandshake(value: unknown): CoordinatorHandshakeResponse {
      let request: CoordinatorHandshakeRequest;
      try {
        request = decodeCoordinatorHandshakeRequest(value);
      } catch {
        throw new CoordinatorDispatcherError('invalid_frame', 'Coordinator handshake is invalid.');
      }

      const responseBase = {
        schema: 'kite.local-coordinator-handshake.v1' as const,
        kind: 'handshake_response' as const,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        deadlineMs: request.deadlineMs,
        coordinator: options.identity,
      };
      const diagnostic = compareHandshake(request, options.identity, options.peerOsIdentity);
      return {
        ...responseBase,
        accepted: diagnostic === 'accepted',
        diagnostic,
      };
    },

    async dispatch(
      value: unknown,
      peer: CoordinatorPeerIdentity,
    ): Promise<CoordinatorResponseFrame> {
      let request: CoordinatorRequestFrame;
      try {
        request = decodeCoordinatorRequestFrame(value);
      } catch {
        throw new CoordinatorDispatcherError('invalid_frame', 'Coordinator request is invalid.');
      }

      if (!peerMayCall(peer, request)) {
        return encodeCoordinatorResponseFrame({
          schema: 'kite.local-coordinator-frame.v1',
          kind: 'response',
          protocolVersion: COORDINATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          deadlineMs: request.deadlineMs,
          method: request.method,
          outcome: 'error',
          error: { code: 'peer_identity_mismatch', diagnostic: 'wrong_peer' },
        });
      }

      const startedAtMs = now();
      const deadlineAtMs = startedAtMs + request.deadlineMs;
      const controller = new AbortController();
      const context = {
        method: request.method,
        requestId: request.requestId,
        idempotencyKey: request.idempotencyKey,
        deadlineMs: request.deadlineMs,
        signal: controller.signal,
        deadlineAtMs,
        peer,
      } as CoordinatorDispatchContext;

      let result: unknown;
      try {
        result = await withDeadline(
          getHandler(options.handlers, request.method)(request.params, context),
          request.deadlineMs,
          controller,
        );
      } catch (error) {
        const known = error instanceof CoordinatorDispatcherError ? error.code : undefined;
        const code =
          known === 'deadline_exceeded' ||
          known === 'outcome_unknown' ||
          known === 'unavailable' ||
          known === 'identity_mismatch'
            ? known
            : 'handler_failed';
        return encodeCoordinatorResponseFrame({
          schema: 'kite.local-coordinator-frame.v1',
          kind: 'response',
          protocolVersion: COORDINATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          deadlineMs: request.deadlineMs,
          method: request.method,
          outcome: 'error',
          error:
            code === 'deadline_exceeded'
              ? { code, diagnostic: 'expired' }
              : { code, diagnostic: 'handler_rejected' },
        });
      }

      try {
        return encodeCoordinatorResponseFrame({
          schema: 'kite.local-coordinator-frame.v1',
          kind: 'response',
          protocolVersion: COORDINATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          deadlineMs: request.deadlineMs,
          method: request.method,
          outcome: 'ok',
          result,
        } as never);
      } catch {
        return encodeCoordinatorResponseFrame({
          schema: 'kite.local-coordinator-frame.v1',
          kind: 'response',
          protocolVersion: COORDINATOR_PROTOCOL_VERSION,
          requestId: request.requestId,
          idempotencyKey: request.idempotencyKey,
          deadlineMs: request.deadlineMs,
          method: request.method,
          outcome: 'error',
          error: { code: 'invalid_response', diagnostic: 'handler_rejected' },
        });
      }
    },
  });
}

function peerMayCall(peer: CoordinatorPeerIdentity, request: CoordinatorRequestFrame): boolean {
  if (peer.role === 'worker') return request.method === 'status';
  if (peer.role === 'web_gateway') {
    if (
      request.method === 'status' ||
      request.method === 'resolveWorkspaceWorker' ||
      request.method === 'resolveSessionWorkspace' ||
      request.method === 'listSessionMetadata' ||
      request.method === 'subscribeDirectoryChanges'
    ) {
      return true;
    }
    return (
      request.method === 'mintWorkerConnectionCapability' &&
      request.params.purpose === 'web_observer'
    );
  }
  if (request.method === 'mintWorkerConnectionCapability') {
    return request.params.purpose === 'native_client';
  }
  return true;
}

function getHandler(
  handlers: CoordinatorDispatcherHandlers,
  method: CoordinatorMethod,
): CoordinatorHandler<CoordinatorMethod> {
  return handlers[method] as CoordinatorHandler<CoordinatorMethod>;
}

async function withDeadline<T>(
  operation: T | Promise<T>,
  deadlineMs: number,
  controller: AbortController,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(
        new CoordinatorDispatcherError(
          'deadline_exceeded',
          'Coordinator request deadline exceeded.',
        ),
      );
    }, deadlineMs);
  });
  try {
    return await Promise.race([Promise.resolve(operation), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function compareHandshake(
  request: CoordinatorHandshakeRequest,
  identity: CoordinatorIdentity,
  peerOsIdentity: CoordinatorOsIdentity,
): NonNullable<CoordinatorHandshakeResponse['diagnostic']> {
  if (request.expectedCoordinator.instanceId !== identity.instanceId) return 'wrong_instance';
  if (request.expectedCoordinator.buildId !== identity.buildId) return 'wrong_build';
  if (request.peer.buildId !== identity.buildId) return 'wrong_build';
  if (
    request.expectedCoordinator.protocolVersion !== identity.protocolVersion ||
    request.expectedCoordinator.protocolRevision !== COORDINATOR_PROTOCOL_REVISION_ ||
    request.expectedCoordinator.clientContractRevision !== COORDINATOR_CLIENT_CONTRACT_REVISION_ ||
    request.peer.protocolVersion !== COORDINATOR_PROTOCOL_VERSION ||
    request.peer.protocolRevision !== COORDINATOR_PROTOCOL_REVISION_ ||
    request.peer.clientContractRevision !== COORDINATOR_CLIENT_CONTRACT_REVISION_
  ) {
    return 'wrong_protocol';
  }
  if (!sameOsIdentity(request.peerOsIdentity, peerOsIdentity)) return 'wrong_peer';
  return 'accepted';
}

function sameOsIdentity(left: CoordinatorOsIdentity, right: CoordinatorOsIdentity): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === 'posix_uid'
    ? right.kind === 'posix_uid' && left.uid === right.uid
    : right.kind === 'windows_sid' && left.sid === right.sid;
}

/** A named transport shape keeps carrier ownership explicit without becoming generic RPC. */
export interface CoordinatorRequestTransport {
  handshake(frame: CoordinatorHandshakeRequest): Promise<unknown>;
  request(frame: CoordinatorRequestFrame): Promise<unknown>;
  close?(): Promise<void> | void;
}

export interface CoordinatorRequestClientOptions {
  readonly transport: CoordinatorRequestTransport;
  readonly identity: CoordinatorPeerIdentity;
  readonly expectedCoordinator: CoordinatorIdentity;
  readonly peerOsIdentity: CoordinatorOsIdentity;
  readonly requestId?: () => string;
  readonly idempotencyKey?: () => string;
  readonly deadlineMs?: number;
}

export interface CoordinatorRequestClient {
  handshake(): Promise<CoordinatorHandshakeResponse>;
  status(): Promise<CoordinatorResponseFor<'status'>>;
  resolveWorkspaceWorker(
    params: CoordinatorWorkspaceParams,
  ): Promise<CoordinatorResponseFor<'resolveWorkspaceWorker'>>;
  ensureWorkspaceWorker(
    params: CoordinatorWorkspaceParams,
  ): Promise<CoordinatorResponseFor<'ensureWorkspaceWorker'>>;
  resolveSessionWorkspace(
    params: CoordinatorResolveSessionWorkspaceParams,
  ): Promise<CoordinatorResponseFor<'resolveSessionWorkspace'>>;
  listSessionMetadata(
    params: CoordinatorListSessionMetadataParams,
  ): Promise<CoordinatorResponseFor<'listSessionMetadata'>>;
  mintWorkerConnectionCapability(
    params: CoordinatorMintWorkerConnectionCapabilityParams,
  ): Promise<CoordinatorResponseFor<'mintWorkerConnectionCapability'>>;
  ensureWebGateway(): Promise<CoordinatorResponseFor<'ensureWebGateway'>>;
  discoverWebGateway(): Promise<CoordinatorResponseFor<'discoverWebGateway'>>;
  stopWebGateway(): Promise<CoordinatorResponseFor<'stopWebGateway'>>;
  subscribeDirectoryChanges(
    params: CoordinatorSubscribeDirectoryChangesParams,
  ): Promise<CoordinatorResponseFor<'subscribeDirectoryChanges'>>;
}

export function createCoordinatorRequestClient(
  options: CoordinatorRequestClientOptions,
): CoordinatorRequestClient {
  const requestId = options.requestId ?? (() => randomUUID());
  const idempotencyKey = options.idempotencyKey ?? (() => randomUUID());
  const deadlineMs = options.deadlineMs ?? 30_000;

  async function call<M extends CoordinatorMethod>(
    method: M,
    params: CoordinatorParamsByMethod[M],
  ): Promise<CoordinatorResponseFor<M>> {
    const frame = decodeCoordinatorRequestFrame({
      schema: 'kite.local-coordinator-frame.v1' as const,
      kind: 'request' as const,
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      requestId: requestId(),
      idempotencyKey: idempotencyKey(),
      deadlineMs,
      method,
      params,
    } as CoordinatorRequestFrame);
    const response = decodeCoordinatorResponseFrame(await options.transport.request(frame));
    if (
      response.requestId !== frame.requestId ||
      response.idempotencyKey !== frame.idempotencyKey ||
      response.method !== frame.method
    ) {
      throw new CoordinatorDispatcherError(
        'invalid_response',
        'Coordinator response identity mismatch.',
      );
    }
    return response as CoordinatorResponseFor<M>;
  }

  return Object.freeze({
    async handshake(): Promise<CoordinatorHandshakeResponse> {
      const frame = decodeCoordinatorHandshakeRequest({
        schema: 'kite.local-coordinator-handshake.v1' as const,
        kind: 'handshake_request' as const,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        requestId: requestId(),
        idempotencyKey: idempotencyKey(),
        deadlineMs,
        expectedCoordinator: options.expectedCoordinator,
        peer: options.identity,
        peerOsIdentity: options.peerOsIdentity,
      });
      const response = decodeCoordinatorHandshakeResponse(await options.transport.handshake(frame));
      if (
        response.requestId !== frame.requestId ||
        response.idempotencyKey !== frame.idempotencyKey ||
        response.coordinator.instanceId !== options.expectedCoordinator.instanceId
      ) {
        throw new CoordinatorDispatcherError(
          'invalid_response',
          'Coordinator handshake identity mismatch.',
        );
      }
      return response;
    },
    status: () => call('status', {}),
    resolveWorkspaceWorker: (params: CoordinatorWorkspaceParams) =>
      call('resolveWorkspaceWorker', params),
    ensureWorkspaceWorker: (params: CoordinatorWorkspaceParams) =>
      call('ensureWorkspaceWorker', params),
    resolveSessionWorkspace: (params: CoordinatorResolveSessionWorkspaceParams) =>
      call('resolveSessionWorkspace', params),
    listSessionMetadata: (params: CoordinatorListSessionMetadataParams) =>
      call('listSessionMetadata', params),
    mintWorkerConnectionCapability: (params: CoordinatorMintWorkerConnectionCapabilityParams) =>
      call('mintWorkerConnectionCapability', params),
    ensureWebGateway: () => call('ensureWebGateway', {}),
    discoverWebGateway: () => call('discoverWebGateway', {}),
    stopWebGateway: () => call('stopWebGateway', {}),
    subscribeDirectoryChanges: (params: CoordinatorSubscribeDirectoryChangesParams) =>
      call('subscribeDirectoryChanges', params),
  });
}
