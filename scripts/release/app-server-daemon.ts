import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import {
  createKiteAppServerDaemonClient,
  KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_SCHEMA_,
  KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_CODEC_,
  KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
  KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_CODEC_,
  type KiteAppServerConnection,
} from '@kite-ai/kite-local-runtime/client';
import {
  clearDeadKiteLocalRuntimeEndpoint,
  createKiteHomeIdentity,
  createKiteLocalRuntimeProcessIdentityProbe,
  type KiteLocalRuntimeEndpoint,
  readKiteLocalRuntimeLifecycleReservation,
  resolveKiteAppServerDaemonEndpoint,
} from '@kite-ai/kite-local-runtime/service';
import { RuntimeClientError, type RuntimeClientInfo } from '@kite-ai/runtime-client';
import {
  type ManagedLocalAppServerOptions,
  type ManagedLocalAppServerTarget,
  prepareManagedLocalAppServerTarget,
  resolveManagedLocalAppServerTarget,
} from './app-server-client';
import { resolveLocalRuntimeParent } from './local-service-client';

export interface AppServerDaemonStatus {
  readonly state: 'absent' | 'ready' | 'draining' | 'incompatible' | 'unavailable';
  readonly buildId?: string;
  readonly instanceId?: string;
  readonly startedAt?: string;
  readonly workspace?: string;
  readonly webOrigin?: string;
  readonly endpoint: string;
}

export interface ManagedLocalAppServerDaemon {
  readonly target: ManagedLocalAppServerTarget;
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly connector: {
    connect(input: {
      readonly workspace: string;
      readonly clientInfo?: RuntimeClientInfo;
    }): Promise<KiteAppServerConnection>;
  };
  start(workspace: string): Promise<AppServerDaemonStatus>;
  status(): Promise<AppServerDaemonStatus>;
  stop(): Promise<AppServerDaemonStatus>;
  discoverWeb(): Promise<string>;
}

export function createManagedLocalAppServerDaemon(
  options: ManagedLocalAppServerOptions & { readonly endpoint?: string } = {},
): ManagedLocalAppServerDaemon {
  const target = resolveManagedLocalAppServerTarget(options);
  const runtimeParent = resolveLocalRuntimeParent(options.environment ?? process.env);
  const canonicalEndpoint = resolveKiteAppServerDaemonEndpoint({
    home: createKiteHomeIdentity(target.runtimeRoot, 'explicit_argument'),
    ...(process.platform === 'win32' ? {} : { runtimeParent }),
  });
  const endpoint = options.endpoint
    ? endpointFromArgument(options.endpoint, canonicalEndpoint)
    : canonicalEndpoint;
  const connect = (clientInfo?: RuntimeClientInfo) =>
    createKiteAppServerDaemonClient({
      endpoint,
      clientInfo:
        clientInfo ??
        Object.freeze({
          name: 'kite-daemon-client',
          version: '0.1.0',
          instanceId: `daemon_client_${randomUUID()}`,
        }),
    });
  const readStatus = async (): Promise<AppServerDaemonStatus> => {
    const client = connect();
    try {
      await client.connect();
      return decodeStatus(
        await client.runtime.requestServerControl('server/status', {
          schema: KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
        }),
        endpoint,
      );
    } catch (error) {
      if (isVersionMismatch(error)) {
        return { state: 'incompatible', endpoint: endpointLabel(endpoint) };
      }
      if (endpoint.kind === 'unix') {
        try {
          if (readKiteLocalRuntimeLifecycleReservation(endpoint)) {
            return { state: 'unavailable', endpoint: endpointLabel(endpoint) };
          }
          if (pathExists(endpoint.socket) || pathExists(endpoint.lifecycleReservation)) {
            return { state: 'unavailable', endpoint: endpointLabel(endpoint) };
          }
        } catch {
          return { state: 'unavailable', endpoint: endpointLabel(endpoint) };
        }
      }
      return { state: 'absent', endpoint: endpointLabel(endpoint) };
    } finally {
      await client.close('daemon-status').catch(() => undefined);
    }
  };
  return Object.freeze({
    target,
    endpoint,
    connector: Object.freeze({
      async connect(input: {
        readonly workspace: string;
        readonly clientInfo?: RuntimeClientInfo;
      }): Promise<KiteAppServerConnection> {
        const client = connect(input.clientInfo);
        try {
          await client.connect();
          const status = decodeStatus(
            await client.runtime.requestServerControl('server/status', {
              schema: KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
            }),
            endpoint,
          );
          if (
            status.state !== 'ready' ||
            status.workspace !== realpathSync.native(input.workspace)
          ) {
            throw new Error('Selected App Server daemon serves a different Workspace.');
          }
          return client;
        } catch (error) {
          await client.close('daemon-connect-failed').catch(() => undefined);
          throw error;
        }
      },
    }),
    async start(workspace: string): Promise<AppServerDaemonStatus> {
      const canonicalWorkspace = realpathSync.native(workspace);
      let existing = await readStatus();
      if (existing.state === 'unavailable' && endpoint.kind === 'unix') {
        await clearDeadEndpoint(endpoint);
        existing = await readStatus();
      }
      if (existing.state !== 'absent') {
        return existing.state === 'ready' && existing.workspace !== canonicalWorkspace
          ? { ...existing, state: 'incompatible' }
          : existing;
      }
      const preparedTarget = prepareManagedLocalAppServerTarget(target);
      if (!options.endpoint) {
        const preparedEndpoint = resolveKiteAppServerDaemonEndpoint({
          home: createKiteHomeIdentity(preparedTarget.runtimeRoot, 'explicit_argument'),
          ...(process.platform === 'win32' ? {} : { runtimeParent }),
        });
        if (endpointLabel(preparedEndpoint) !== endpointLabel(endpoint)) {
          throw new Error('App Server daemon endpoint identity changed during validation.');
        }
      }
      validateWebStaticRoot(preparedTarget.webStaticRoot);
      await clearDeadEndpoint(endpoint);
      const env = daemonEnvironment(preparedTarget, endpoint, canonicalWorkspace);
      const child = Bun.spawn({
        cmd: [
          preparedTarget.executable,
          ...preparedTarget.argumentsPrefix,
          'app-server',
          'run-daemon',
        ],
        cwd: runtimeParent,
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
        detached: true,
      });
      child.unref();
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const status = await readStatus();
        if (
          status.state === 'ready' ||
          status.state === 'draining' ||
          status.state === 'incompatible'
        ) {
          return status;
        }
        await Bun.sleep(50);
      }
      throw new Error('App Server daemon did not become ready.');
    },
    status: readStatus,
    async discoverWeb(): Promise<string> {
      const status = await readStatus();
      if (status.state === 'incompatible') {
        throw new Error('App Server daemon protocol is incompatible; use its matching client.');
      }
      if (status.state === 'unavailable') {
        throw new Error('App Server daemon identity is unavailable.');
      }
      if (status.state !== 'ready' || !status.webOrigin) {
        throw new Error('App Server daemon is absent; run `kite server start` first.');
      }
      return `${status.webOrigin}/`;
    },
    async stop(): Promise<AppServerDaemonStatus> {
      const current = await readStatus();
      if (
        current.state === 'absent' ||
        current.state === 'incompatible' ||
        current.state === 'unavailable'
      ) {
        return current;
      }
      const client = connect();
      try {
        await client.connect();
        const response = await client.runtime.requestServerControl('server/shutdown', {
          schema: KITE_APP_SERVER_DAEMON_SHUTDOWN_REQUEST_SCHEMA_,
        });
        KITE_APP_SERVER_DAEMON_SHUTDOWN_RESPONSE_CODEC_.parse(response);
      } finally {
        await client.close('daemon-stop').catch(() => undefined);
      }
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const status = await readStatus();
        if (status.state === 'absent') return status;
        await Bun.sleep(50);
      }
      throw new Error('App Server daemon shutdown did not settle.');
    },
  });
}

function daemonEnvironment(
  target: ManagedLocalAppServerTarget,
  endpoint: KiteLocalRuntimeEndpoint,
  workspace: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ...target.environment,
    KITE_CODE_HOME: target.runtimeRoot,
    KITE_CODE_CONFIG_HOME: target.configRoot,
    KITE_APP_SERVER_WORKSPACE: workspace,
    KITE_APP_SERVER_BUILD_ID: target.buildId,
    KITE_APP_SERVER_WEB_STATIC_ROOT: target.webStaticRoot,
    KITE_APP_SERVER_DAEMON_HOME_DIGEST: endpoint.homeDigest,
    HOME: target.systemHome,
    USERPROFILE: target.systemHome,
  };
  if (endpoint.kind === 'named_pipe') {
    env.KITE_APP_SERVER_DAEMON_PIPE = endpoint.pipeName;
  } else {
    env.KITE_APP_SERVER_DAEMON_ROOT = endpoint.root;
    env.KITE_APP_SERVER_DAEMON_SOCKET = endpoint.socket;
    env.KITE_APP_SERVER_DAEMON_LOCK = endpoint.lifecycleReservation;
  }
  return env;
}

async function clearDeadEndpoint(endpoint: KiteLocalRuntimeEndpoint): Promise<void> {
  const reservation = readKiteLocalRuntimeLifecycleReservation(endpoint);
  if (!reservation) return;
  const result = await clearDeadKiteLocalRuntimeEndpoint({
    endpoint,
    expected: reservation,
    process: createKiteLocalRuntimeProcessIdentityProbe(),
  });
  if (result.outcome === 'blocked') {
    throw new Error(`App Server daemon endpoint is blocked: ${result.diagnostic}.`);
  }
}

function decodeStatus(
  value: Readonly<Record<string, unknown>>,
  endpoint: KiteLocalRuntimeEndpoint,
): AppServerDaemonStatus {
  const decoded = KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_CODEC_.parse(value);
  return {
    state: decoded.state,
    buildId: decoded.buildId,
    instanceId: decoded.instanceId,
    startedAt: decoded.startedAt,
    workspace: decoded.workspace,
    webOrigin: decoded.webOrigin,
    endpoint: endpointLabel(endpoint),
  };
}

function endpointFromArgument(
  value: string,
  canonical: KiteLocalRuntimeEndpoint,
): KiteLocalRuntimeEndpoint {
  if (process.platform === 'win32') {
    if (!value.startsWith('\\\\.\\pipe\\') || value.length > 4_096 || /\p{Cc}/u.test(value)) {
      throw new Error('--server requires an absolute named-pipe endpoint.');
    }
    return Object.freeze({ kind: 'named_pipe', homeDigest: canonical.homeDigest, pipeName: value });
  }
  if (!isAbsolute(value) || value.length > 4_096 || /\p{Cc}/u.test(value)) {
    throw new Error('--server requires an absolute Unix socket path.');
  }
  const root = dirname(value);
  const stat = lstatSync(root);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    realpathSync.native(root) !== root ||
    (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('--server Unix socket parent must be a canonical owner-only directory.');
  }
  return Object.freeze({
    kind: 'unix',
    homeDigest: canonical.homeDigest,
    root,
    socket: value,
    lifecycleReservation: `${value}.lock`,
  });
}

function endpointLabel(endpoint: KiteLocalRuntimeEndpoint): string {
  return endpoint.kind === 'unix' ? endpoint.socket : endpoint.pipeName;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateWebStaticRoot(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync.native(path) !== path) {
      throw new Error();
    }
  } catch {
    throw new Error(
      'App Server Web assets are unavailable; build the Web bundle before `kite server start`.',
    );
  }
}

function isVersionMismatch(error: unknown): boolean {
  return error instanceof RuntimeClientError && error.code === 'server_mismatch';
}
