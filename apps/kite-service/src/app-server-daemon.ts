import type { Socket } from 'node:net';
import { isAbsolute } from 'node:path';
import {
  KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_CODEC_,
  KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_SCHEMA_,
  KITE_APP_SERVER_DAEMON_STATUS_REQUEST_CODEC_,
  KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_,
} from '@kite-ai/kite-local-runtime/client';
import {
  KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
  type KiteLocalRuntimeEndpoint,
  readLocalProcessStartIdentity,
} from '@kite-ai/kite-local-runtime/service';
import {
  createKiteAppServerRuntimeOwner,
  type KiteAppServerMainDependencies,
  resolveKiteAppServerEnvironment,
} from './app-server';
import {
  createNodeRuntimeStdioOutput,
  createRuntimeStdioCarrier,
  type RuntimeStdioCarrier,
} from './carrier/runtime-server-stdio';
import { createKiteOwnedLocalEndpointServer } from './native-endpoint';

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
  const endpoint = resolveDaemonEndpoint(source);
  const owner = createKiteAppServerRuntimeOwner(environment, dependencies, {
    daemonProtocol: true,
  });
  const startedAt = new Date().toISOString();
  const processStartIdentity = await readLocalProcessStartIdentity(process.pid, process.platform);
  if (!processStartIdentity) {
    await owner.composition[Symbol.asyncDispose]();
    throw new Error('App Server daemon process identity is unavailable.');
  }
  const carriers = new Set<RuntimeStdioCarrier>();
  let resolveShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });
  let stopping = false;
  const requestShutdown = () => {
    if (stopping) return;
    stopping = true;
    resolveShutdown();
  };
  const serverControl = Object.freeze({
    async dispatch(
      method: 'server/status' | 'server/shutdown',
      request: Readonly<Record<string, unknown>>,
    ) {
      if (method === 'server/status') {
        KITE_APP_SERVER_DAEMON_STATUS_REQUEST_CODEC_.parse(request);
        return Object.freeze({
          schema: KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_SCHEMA_,
          state: stopping ? 'draining' : 'ready',
          instanceId: owner.instanceId,
          buildId: environment.buildId,
          startedAt,
          workspace: environment.workspace,
        });
      }
      KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_CODEC_.parse(request);
      queueMicrotask(requestShutdown);
      return Object.freeze({
        schema: KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_SCHEMA_,
        outcome: 'accepted',
      });
    },
  });
  const endpointServer = createKiteOwnedLocalEndpointServer({
    endpoint,
    lifecycleIdentity: {
      schema: KITE_LOCAL_RUNTIME_LIFECYCLE_SCHEMA_,
      pid: process.pid,
      processStartIdentity,
      instanceId: owner.instanceId,
      buildId: environment.buildId,
      startedAt,
    },
    closeActiveConnections: true,
    handleConnection: (socket) => {
      const carrier = createSocketCarrier(socket, owner, serverControl);
      carriers.add(carrier);
      return carrier.done.finally(() => carriers.delete(carrier));
    },
  });
  const signals = dependencies.signals ?? process;
  const onSignal = () => requestShutdown();
  signals.on('SIGINT', onSignal);
  signals.on('SIGTERM', onSignal);
  let primaryError: unknown;
  try {
    await endpointServer.start();
    await shutdownRequested;
    await owner.composition.application.cancelAll('app_server_daemon_shutdown');
    await Promise.all([...carriers].map((carrier) => carrier.shutdown()));
    await endpointServer.close();
  } catch (error) {
    primaryError = error;
  } finally {
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
    await endpointServer.close().catch((error) => {
      primaryError ??= error;
    });
    await Promise.resolve(owner.composition[Symbol.asyncDispose]()).catch((error: unknown) => {
      primaryError ??= error;
    });
  }
  if (primaryError !== undefined) throw primaryError;
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
