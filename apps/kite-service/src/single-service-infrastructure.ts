import { randomBytes as systemRandomBytes } from 'node:crypto';
import {
  createLocalRuntimeServiceToken,
  KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
  KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
  KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
  type KiteHomeIdentity,
  type KiteLocalNativeRequest,
  type KiteLocalNativeResponse,
  type KiteLocalRuntimeEndpoint,
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  resolveKiteLocalRuntimeEndpoint,
} from '@kite-ai/kite-local-runtime/service';
import {
  createKiteServiceCarrier,
  type KiteServiceApplicationPort,
  type KiteServiceCarrier,
  type KiteServiceCarrierLimits,
  type KiteServiceWebGatewayRouteOptions,
} from './carrier';
import {
  KITE_SERVICE_CONTROLLER_GENERATION_HEADER,
  KITE_SERVICE_CONTROLLER_SESSION_HEADER,
} from './carrier/native-loopback-carrier';
import { createKiteNativeEndpointServer, type KiteNativeEndpointServer } from './native-endpoint';
import type { NativeKiteServiceApplicationPort } from './native-infrastructure';
import type {
  KiteRuntimeApplicationPort,
  KiteServiceLifecycleResult,
  KiteServiceReadinessPort,
  KiteServiceShell,
  KiteServiceSignalPort,
  KiteServiceStatePort,
  KiteServiceTransportPort,
} from './ports';
import { createKiteServiceShell } from './shell';
import {
  createSingleServiceWebLifecycle,
  type SingleServiceWebLifecycle,
} from './web-gateway/service-lifecycle';

export interface SingleServiceInfrastructureOptions {
  readonly home: KiteHomeIdentity;
  /** Already owner-verified OS runtime parent; not used for Windows named pipes. */
  readonly runtimeParent?: string;
  readonly platform?: NodeJS.Platform;
  readonly application: NativeKiteServiceApplicationPort;
  readonly instanceId: string;
  readonly serverVersion: string;
  readonly buildId: string;
  readonly processStartIdentity: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly webGateway?: Omit<KiteServiceWebGatewayRouteOptions, 'staticAssetRoot'>;
  readonly readiness?: KiteServiceReadinessPort;
  readonly signals?: KiteServiceSignalPort;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly carrierLimits?: KiteServiceCarrierLimits;
  readonly now?: () => number;
  readonly randomBytes?: (size: number) => Uint8Array;
  /** Runs only after this exact process owns the native lifecycle reservation, before ready. */
  readonly onEndpointReserved?: () => void | Promise<void>;
}

export interface SingleServiceInfrastructure extends AsyncDisposable {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly shell: KiteServiceShell;
  readonly web: SingleServiceWebLifecycle | undefined;
  readonly httpOrigin: string | undefined;
  start(): Promise<KiteServiceLifecycleResult>;
  stop(): Promise<KiteServiceLifecycleResult>;
  requestStop(): Promise<KiteServiceLifecycleResult>;
}

const SINGLE_SERVICE_CLIENT_ID_HEADER = 'x-kite-worker-client-id';
const SINGLE_SERVICE_CONNECTION_GENERATION_HEADER = 'x-kite-worker-connection-generation';
const SINGLE_SERVICE_PURPOSE_HEADER = 'x-kite-worker-purpose';
const SINGLE_SERVICE_WORKSPACE_HEADER = 'x-kite-workspace';

/**
 * Accepted target infrastructure: one Service HTTP listener plus one native discovery endpoint.
 * Tokens and Browser lifecycle stay in memory; Kite Home receives no process state.
 */
export function createSingleServiceInfrastructure(
  options: SingleServiceInfrastructureOptions,
): SingleServiceInfrastructure {
  const random = options.randomBytes ?? ((size: number) => systemRandomBytes(size));
  const platform = options.platform ?? process.platform;
  const lifecyclePid = options.pid ?? process.pid;
  const lifecycleStartedAt = options.startedAt ?? new Date().toISOString();
  const endpoint = resolveKiteLocalRuntimeEndpoint({
    home: options.home,
    platform,
    ...(platform === 'win32' ? {} : { runtimeParent: options.runtimeParent }),
  });
  let accessToken: string | undefined;
  let controlToken: string | undefined;
  let carrier: KiteServiceCarrier | undefined;
  let nativeEndpoint: KiteNativeEndpointServer | undefined;
  let publishedReady = false;
  let shell!: KiteServiceShell;

  const web = options.webGateway
    ? createSingleServiceWebLifecycle({
        createRouteOwner: (assets) => {
          if (!carrier || !publishedReady) throw new Error('Service listener is not ready.');
          return carrier.attachWebGateway({
            ...options.webGateway!,
            staticAssetRoot: assets.root,
          });
        },
      })
    : undefined;

  const carrierApplication: KiteServiceApplicationPort = {
    server: options.application.server,
    history: options.application.history,
    workspaceAdmission: options.application.workspaceAdmission,
    runtimeAdmission: options.application.runtimeAdmission,
    appControl: options.application.appControl,
    ...(options.application.credential ? { credential: options.application.credential } : {}),
    ...(options.application.controller ? { controller: options.application.controller } : {}),
    ...(options.application.onConnectionBound
      ? { onConnectionBound: options.application.onConnectionBound }
      : {}),
    ...(options.application.onConnectionClosed
      ? { onConnectionClosed: options.application.onConnectionClosed }
      : {}),
  };

  const state: KiteServiceStatePort = {
    async prepareStart(startOptions) {
      if (startOptions?.signal?.aborted) throw new Error('Service startup was cancelled.');
      if (accessToken || controlToken || nativeEndpoint) {
        throw new Error('Single-Service in-memory state is already prepared.');
      }
      accessToken = createLocalRuntimeServiceToken();
      controlToken = createLocalRuntimeServiceToken();
      if (accessToken === controlToken) throw new Error('Service token source repeated material.');
    },
    async publishReady(startOptions) {
      if (startOptions?.signal?.aborted) throw new Error('Service startup was cancelled.');
      if (!carrier || !accessToken || !controlToken || nativeEndpoint) {
        throw new Error('Single-Service infrastructure is incomplete.');
      }
      nativeEndpoint = createKiteNativeEndpointServer({
        endpoint,
        dispatch: dispatchNativeRequest,
        lifecycleIdentity: {
          schema: KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
          pid: lifecyclePid,
          processStartIdentity: options.processStartIdentity,
          instanceId: options.instanceId,
          buildId: options.buildId,
          startedAt: lifecycleStartedAt,
        },
      });
      await nativeEndpoint.start();
      await options.onEndpointReserved?.();
      publishedReady = true;
    },
    async preserveFailure() {
      publishedReady = false;
      await nativeEndpoint?.close().catch(() => undefined);
      nativeEndpoint = undefined;
    },
    async clear(clearOptions) {
      if (clearOptions?.signal?.aborted) throw new Error('Service cleanup was cancelled.');
      await nativeEndpoint?.close();
      nativeEndpoint = undefined;
      publishedReady = false;
      accessToken = undefined;
      controlToken = undefined;
    },
  };

  const transport: KiteServiceTransportPort = {
    async start(startOptions) {
      if (startOptions?.signal?.aborted) throw new Error('Service startup was cancelled.');
      if (carrier || !accessToken || !controlToken) {
        throw new Error('Single-Service transport state is invalid.');
      }
      carrier = createKiteServiceCarrier({
        application: carrierApplication,
        instanceId: options.instanceId,
        serverVersion: options.serverVersion,
        buildId: options.buildId,
        accessToken,
        controlToken,
        isReady: () => publishedReady,
        ...(options.carrierLimits ? { limits: options.carrierLimits } : {}),
        ...(options.now ? { now: options.now } : {}),
        randomBytes: random,
        connectionKindForRequest: (request) =>
          request.headers.get(SINGLE_SERVICE_PURPOSE_HEADER) === 'native_client'
            ? 'native_client'
            : undefined,
        connectionBindingForRequest: (request) => {
          if (request.headers.get(SINGLE_SERVICE_PURPOSE_HEADER) !== 'native_client') {
            return undefined;
          }
          const clientId = request.headers.get(SINGLE_SERVICE_CLIENT_ID_HEADER);
          const generation = Number(
            request.headers.get(SINGLE_SERVICE_CONNECTION_GENERATION_HEADER),
          );
          if (!boundedText(clientId) || !Number.isSafeInteger(generation) || generation < 1) {
            return undefined;
          }
          const requestedWorkspace = request.headers.get(SINGLE_SERVICE_WORKSPACE_HEADER);
          const controllerSessionId = request.headers.get(KITE_SERVICE_CONTROLLER_SESSION_HEADER);
          const controllerGeneration = Number(
            request.headers.get(KITE_SERVICE_CONTROLLER_GENERATION_HEADER),
          );
          return Object.freeze({
            clientId,
            connectionGeneration: generation,
            workerInstanceId: options.instanceId,
            ...(boundedText(requestedWorkspace, 4_096) ? { requestedWorkspace } : {}),
            ...(boundedText(controllerSessionId) &&
            Number.isSafeInteger(controllerGeneration) &&
            controllerGeneration >= 1
              ? { controllerSessionId, controllerGeneration }
              : {}),
          });
        },
      });
    },
    async stop() {
      const current = carrier;
      if (!current) return;
      if (web) await web.stop();
      await current.close();
      carrier = undefined;
    },
  };

  shell = createKiteServiceShell({
    application: options.application as KiteRuntimeApplicationPort,
    state,
    transport,
    ...(options.readiness ? { readiness: options.readiness } : {}),
    ...(options.signals ? { signals: options.signals } : {}),
    ...(options.startupTimeoutMs !== undefined
      ? { startupTimeoutMs: options.startupTimeoutMs }
      : {}),
    ...(options.shutdownTimeoutMs !== undefined
      ? { shutdownTimeoutMs: options.shutdownTimeoutMs }
      : {}),
  });

  const infrastructure: SingleServiceInfrastructure = {
    endpoint,
    shell,
    web,
    get httpOrigin() {
      return carrier?.origin;
    },
    start: () => shell.start(),
    stop: () => shell.stop(),
    requestStop: () => shell.requestStop(),
    [Symbol.asyncDispose]: async () => shell[Symbol.asyncDispose](),
  };
  return Object.freeze(infrastructure);

  async function dispatchNativeRequest(
    request: KiteLocalNativeRequest,
  ): Promise<KiteLocalNativeResponse> {
    if (request.expectedBuildId !== options.buildId) {
      return rejected(request.requestId, 'incompatible');
    }
    if (!publishedReady || !carrier || !accessToken) {
      return rejected(request.requestId, 'unavailable');
    }
    switch (request.operation) {
      case 'describe':
        return {
          schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
          requestId: request.requestId,
          operation: 'describe',
          outcome: 'ready',
          service: {
            instanceId: options.instanceId,
            pid: lifecyclePid,
            startedAt: lifecycleStartedAt,
            protocolVersion: KITE_LOCAL_NATIVE_PROTOCOL_VERSION,
            clientContractRevision: LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
            serverVersion: options.serverVersion,
            buildId: options.buildId,
            httpOrigin: carrier.origin,
          },
          accessToken,
        };
      case 'web_ensure': {
        if (!web) {
          return {
            schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
            requestId: request.requestId,
            operation: 'web_ensure',
            outcome: 'unavailable',
            state: 'absent',
            diagnostic: 'web_readiness_failed',
          };
        }
        const result = await web.ensure(request.staticAssetRoot);
        return result.outcome === 'ready'
          ? {
              schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
              requestId: request.requestId,
              operation: 'web_ensure',
              outcome: 'ready',
              origin: result.origin,
              launchUrl: result.launchUrl,
              assetDigest: result.assetDigest,
            }
          : {
              schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
              requestId: request.requestId,
              operation: 'web_ensure',
              outcome: 'unavailable',
              state: result.state,
              diagnostic: result.diagnostic,
            };
      }
      case 'web_status': {
        const result = web ? await web.status() : ({ outcome: 'ready', state: 'absent' } as const);
        return {
          schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
          requestId: request.requestId,
          operation: 'web_status',
          ...result,
        };
      }
      case 'web_stop': {
        const result = web ? await web.stop() : ({ outcome: 'noop', state: 'absent' } as const);
        return {
          schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
          requestId: request.requestId,
          operation: 'web_stop',
          ...result,
        };
      }
      case 'service_stop': {
        const result = await shell.requestStop();
        return {
          schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
          requestId: request.requestId,
          operation: 'service_stop',
          outcome: result.outcome,
          state: result.state,
        };
      }
    }
  }
}

function rejected(
  requestId: string,
  diagnostic: 'incompatible' | 'unavailable',
): KiteLocalNativeResponse {
  return {
    schema: KITE_LOCAL_NATIVE_RESPONSE_SCHEMA_,
    requestId,
    operation: 'rejected',
    outcome: 'rejected',
    diagnostic,
  };
}

function boundedText(value: string | null, maximum = 512): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    !/\p{Cc}/u.test(value)
  );
}
