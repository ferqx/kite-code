import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import {
  KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_,
  KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_CODEC_,
  KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_SCHEMA_,
  KITE_APP_SERVER_DAEMON_STATUS_REQUEST_CODEC_,
  KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_,
  KITE_APP_SERVER_DAEMON_VERSION_,
  KITE_LIFECYCLE_SCHEMA,
  type KiteLifecycleResponse,
  type KiteLifecycleStatus,
} from '@kite-ai/kite-local-runtime/client';
import {
  KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
  type KiteLocalRuntimeEndpoint,
  readLocalProcessStartIdentity,
} from '@kite-ai/kite-local-runtime/service';
import { createAgentApiRouteHandler } from './agent-api';
import {
  createKiteAppServerRuntimeOwner,
  type KiteAppServerMainDependencies,
  resolveKiteAppServerEnvironment,
} from './app-server';
import { createKiteAppServerAgentApiReadContext } from './bootstrap';
import { serveKiteLifecycleOrRuntime } from './carrier/daemon-lifecycle';
import {
  createNodeRuntimeStdioOutput,
  createRuntimeStdioCarrier,
  type RuntimeStdioCarrier,
} from './carrier/runtime-server-stdio';
import { createKiteOwnedLocalEndpointServer } from './native-endpoint';
import { createWebGatewayCarrier, preflightWebGatewayStaticAssets } from './web-gateway';

export interface KiteAppServerDaemonDependencies
  extends Pick<
    KiteAppServerMainDependencies,
    'environment' | 'createStorage' | 'createComposition'
  > {
  readonly signals?: Pick<NodeJS.Process, 'on' | 'off'>;
}

/** Explicit foreground daemon. Client disconnect closes only its connection, never the daemon. */
export async function runKiteAppServerDaemonMain(
  args: readonly string[] = process.argv.slice(2),
  dependencies: KiteAppServerDaemonDependencies = {},
): Promise<void> {
  if (args.length !== 2 || args[0] !== 'app-server' || args[1] !== 'run-daemon') {
    throw new Error('Kite App Server daemon requires exact `app-server run-daemon` arguments.');
  }
  const source = dependencies.environment ?? process.env;
  const environment = resolveKiteAppServerEnvironment(source);
  const workspace = requiredAbsolute(source, 'KITE_APP_SERVER_WORKSPACE');
  const endpoint = resolveDaemonEndpoint(source);
  const webStaticRoot = preflightWebGatewayStaticAssets(
    requiredAbsolute(source, 'KITE_APP_SERVER_WEB_STATIC_ROOT'),
  );
  const instanceId = `app-server_${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const processStartIdentity = await readLocalProcessStartIdentity(process.pid, process.platform);
  if (!processStartIdentity) throw new Error('App Server daemon process identity is unavailable.');
  let owner: ReturnType<typeof createKiteAppServerRuntimeOwner> | undefined;
  let webOwners: Awaited<ReturnType<typeof createDaemonWebOwners>> | undefined;
  let phase: KiteLifecycleStatus['phase'] = 'starting';
  const carriers = new Map<Socket, RuntimeStdioCarrier>();
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  let shutdownTail: Promise<unknown> = Promise.resolve();
  let drain: Promise<void> | undefined;
  const status = (): KiteLifecycleStatus => ({
    instanceId,
    pid: process.pid,
    processStartIdentity,
    homeDigest: endpoint.homeDigest,
    workspace,
    buildId: environment.buildId,
    startedAt,
    protocol: KITE_APP_SERVER_DAEMON_VERSION_,
    capabilities: [...KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_],
    phase,
    activeOperations: owner?.composition.application.activeOperations ?? false,
    ...(webOwners ? { webOrigin: webOwners.webGateway.origin } : {}),
  });
  const shutdown = (expected: string, mode: 'if_idle' | 'cancel') => {
    const result = shutdownTail.then(
      async (): Promise<'accepted' | 'busy' | 'instance_changed' | 'already_draining'> => {
        if (expected !== instanceId) return 'instance_changed';
        if (phase === 'draining') return 'already_draining';
        if (phase === 'starting' && mode === 'if_idle') return 'busy';
        const lease = await owner?.composition.application.quiesceMutations();
        if (mode === 'if_idle' && lease?.activeOperations) {
          lease.resume();
          return 'busy';
        }
        phase = 'draining';
        // Keep the gate closed. Cancellation must precede waiting for in-flight mutations.
        drain = (async () => {
          if (mode === 'cancel')
            await owner?.composition.application.cancelAll('app_server_daemon_shutdown');
          await lease?.commitDrain();
        })();
        drain.catch(() => undefined);
        resolveShutdown();
        return 'accepted';
      },
    );
    shutdownTail = result.catch(() => undefined);
    return result;
  };
  const serverControl = Object.freeze({
    async dispatch(
      method: 'server/status' | 'server/shutdown',
      request: Readonly<Record<string, unknown>>,
    ) {
      if (method === 'server/status') {
        KITE_APP_SERVER_DAEMON_STATUS_REQUEST_CODEC_.parse(request);
        return {
          schema: KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_,
          state: phase === 'draining' ? 'draining' : 'ready',
          instanceId,
          buildId: environment.buildId,
          startedAt,
          workspace: environment.workspace,
          webOrigin: webOwners!.webGateway.origin,
        };
      }
      KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_CODEC_.parse(request);
      await shutdown(instanceId, 'cancel');
      return { schema: KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_SCHEMA_, outcome: 'accepted' };
    },
  });
  const endpointServer = createKiteOwnedLocalEndpointServer({
    endpoint,
    lifecycleIdentity: {
      schema: KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
      pid: process.pid,
      processStartIdentity,
      instanceId,
      buildId: environment.buildId,
      startedAt,
    },
    closeActiveConnections: true,
    handleConnection: (socket) =>
      serveKiteLifecycleOrRuntime(
        socket,
        async (request): Promise<KiteLifecycleResponse> => {
          const base = { schema: KITE_LIFECYCLE_SCHEMA, requestId: request.requestId };
          return request.operation === 'status'
            ? { ...base, operation: 'status', status: status() }
            : {
                ...base,
                operation: 'shutdown',
                outcome: await shutdown(request.expectedInstanceId, request.mode),
              };
        },
        async () => {
          if (phase !== 'ready' || !owner) {
            socket.destroy();
            return;
          }
          const carrier = createSocketCarrier(socket, owner, serverControl);
          carriers.set(socket, carrier);
          try {
            await carrier.done;
          } finally {
            carriers.delete(socket);
          }
        },
      ),
  });
  const signals = dependencies.signals ?? process;
  const onSignal = () => {
    void shutdown(instanceId, 'cancel').catch(() => resolveShutdown());
  };
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  let primaryError: unknown;
  try {
    // Exclusive ownership precedes any mutable storage/Host initialization.
    await endpointServer.start();
    if (status().phase !== 'draining') {
      owner = createKiteAppServerRuntimeOwner(environment, dependencies, {
        daemonProtocol: true,
        instanceId,
      });
      webOwners = await createDaemonWebOwners(owner, webStaticRoot, environment.buildId);
      if (status().phase !== 'draining') phase = 'ready';
    }
    await shutdownRequested;
    await drain;
    // Allow the accepted response to flush before closing business carriers.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } catch (error) {
    primaryError = error;
  } finally {
    phase = 'draining';
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
    const clean = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        primaryError ??= error;
      }
    };
    await clean(() => webOwners?.webGateway.close());
    await clean(() => webOwners?.agentApi.close());
    await clean(() => webOwners?.browserReadContext.close());
    await clean(() => owner?.composition.application.cancelAll('app_server_daemon_shutdown'));
    const closingCarriers = [...carriers.values()];
    for (const socket of carriers.keys()) socket.destroy();
    await clean(() => Promise.all(closingCarriers.map((carrier) => carrier.shutdown())));
    await clean(() => owner?.composition[Symbol.asyncDispose]());
    // Endpoint is released last, after every mutable owner has settled.
    await clean(() => endpointServer.close());
  }
  if (primaryError !== undefined) throw primaryError;
}

async function createDaemonWebOwners(
  owner: ReturnType<typeof createKiteAppServerRuntimeOwner>,
  webStaticRoot: string,
  buildId: string,
): Promise<{
  readonly browserReadContext: ReturnType<typeof createKiteAppServerAgentApiReadContext>;
  readonly agentApi: ReturnType<typeof createAgentApiRouteHandler>;
  readonly webGateway: ReturnType<typeof createWebGatewayCarrier>;
}> {
  const browserReadContext = createKiteAppServerAgentApiReadContext({
    directory: owner.storageOwner.directory,
    runtime: owner.composition.runtime,
    history: owner.composition.history,
    storage: owner.composition.storage,
    artifactStore: owner.storageOwner.artifactStore,
    checkpoints: owner.composition.storage.checkpoints,
  });
  const agentApi = createAgentApiRouteHandler({
    serverVersion: KITE_APP_SERVER_DAEMON_VERSION_,
    buildId,
    consumeCapability: () => undefined,
    admitWorkspace: async () => 'unavailable',
    isClientGenerationCurrent: () => false,
    capabilities: [],
    browserReadContext,
    browserCapabilities: ['checkpoints', 'history', 'sessions', 'workspaces'],
  });
  try {
    const webGateway = createWebGatewayCarrier({
      staticAssetRoot: webStaticRoot,
      instanceId: owner.instanceId,
      buildId,
      agentApi,
    });
    return { browserReadContext, agentApi, webGateway };
  } catch (error) {
    await agentApi.close().catch(() => undefined);
    await Promise.resolve(browserReadContext.close()).catch(() => undefined);
    throw error;
  }
}

function createSocketCarrier(
  socket: Socket,
  owner: ReturnType<typeof createKiteAppServerRuntimeOwner>,
  serverControl: NonNullable<Parameters<typeof createRuntimeStdioCarrier>[0]['serverControl']>,
): RuntimeStdioCarrier {
  socket.setNoDelay(true);
  return createRuntimeStdioCarrier({
    server: owner.composition.server,
    admission: owner.admission,
    stdin: socket,
    stdout: createNodeRuntimeStdioOutput(socket),
    history: owner.composition.history,
    appControl: owner.appControl,
    credential: owner.composition.appControl.credentialClient,
    serverControl,
  });
}

function resolveDaemonEndpoint(
  source: Readonly<Record<string, string | undefined>>,
): KiteLocalRuntimeEndpoint {
  const homeDigest = required(source, 'KITE_APP_SERVER_DAEMON_HOME_DIGEST');
  if (process.platform === 'win32') {
    return Object.freeze({
      kind: 'named_pipe',
      homeDigest,
      pipeName: required(source, 'KITE_APP_SERVER_DAEMON_PIPE'),
    });
  }
  const root = requiredAbsolute(source, 'KITE_APP_SERVER_DAEMON_ROOT');
  const socket = requiredAbsolute(source, 'KITE_APP_SERVER_DAEMON_SOCKET');
  const lifecycleReservation = requiredAbsolute(source, 'KITE_APP_SERVER_DAEMON_LOCK');
  return Object.freeze({ kind: 'unix', homeDigest, root, socket, lifecycleReservation });
}

function required(source: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = source[name];
  if (!value || value.length > 4_096 || /\p{Cc}/u.test(value)) {
    throw new Error(`Kite App Server daemon requires ${name}.`);
  }
  return value;
}

function requiredAbsolute(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = required(source, name);
  if (!isAbsolute(value)) throw new Error(`Kite App Server daemon ${name} must be absolute.`);
  return value;
}
