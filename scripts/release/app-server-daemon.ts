import { randomUUID } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  createKiteAppServerClient,
  createKiteAppServerDaemonClient,
  KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_,
  KITE_APP_SERVER_DAEMON_STATUS_REQUEST_SCHEMA_,
  KITE_APP_SERVER_DAEMON_STATUS_RESPONSE_CODEC_,
  KITE_APP_SERVER_DAEMON_VERSION_,
  type KiteAppServerConnection,
  type KiteLifecycleStatus,
  requestKiteLifecycle,
} from '@kite-ai/kite-local-runtime/client';
import {
  clearDeadKiteLocalRuntimeEndpoint,
  createKiteHomeIdentity,
  createKiteLocalRuntimeProcessIdentityProbe,
  type KiteLocalRuntimeEndpoint,
  readKiteLocalRuntimeLifecycleReservation,
  resolveKiteAppServerDaemonEndpoint,
} from '@kite-ai/kite-local-runtime/service';
import {
  describeServiceStartupFailure,
  formatServiceStartupReport,
  MAX_SERVICE_STARTUP_STDERR_BYTES,
  parseServiceStartupDiagnostic,
  parseServiceStartupProgress,
  type ServiceStartupDiagnostic,
  type ServiceStartupProgress,
} from '@kite-ai/kite-local-runtime/startup-diagnostic';
import { RuntimeClientError, type RuntimeClientInfo } from '@kite-ai/runtime-client';
import {
  assertKiteSessionStoreSourcesReconciled,
  validateKiteSessionStoreDatabase,
} from '@kite-ai/runtime-storage-sqlite';
import { preflightWebGatewayStaticAssets } from '../../apps/kite-service/src/web-gateway';
import {
  type ManagedLocalAppServerOptions,
  type ManagedLocalAppServerTarget,
  prepareManagedLocalAppServerTarget,
  resolveManagedLocalAppServerTarget,
} from './app-server-client';
import { resolveLocalRuntimeParent } from './local-service-client';

export interface AppServerDaemonStatus {
  readonly state: 'absent' | 'starting' | 'ready' | 'draining' | 'incompatible' | 'unavailable';
  readonly buildId?: string;
  readonly targetBuildId?: string;
  readonly businessCompatibility?: 'compatible' | 'incompatible' | 'unknown';
  readonly lifecycle?: KiteLifecycleStatus;
  readonly diagnostic?: string;
  readonly availableActions?: readonly string[];
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
  restart(workspace?: string, cancel?: boolean): Promise<AppServerDaemonStatus>;
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
  const readLegacyStatus = async (): Promise<AppServerDaemonStatus> => {
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
  const readStatus = async (): Promise<AppServerDaemonStatus> => {
    try {
      const response = await requestKiteLifecycle(endpoint, { operation: 'status' });
      if (response.operation !== 'status') throw new Error('Lifecycle status is unavailable.');
      const life = response.status;
      if (life.homeDigest !== endpoint.homeDigest)
        throw new Error('Lifecycle profile identity mismatch.');
      const compatible =
        life.protocol === KITE_APP_SERVER_DAEMON_VERSION_ &&
        KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_.every((method) =>
          life.capabilities.includes(method),
        );
      return {
        state: compatible ? life.phase : 'incompatible',
        endpoint: endpointLabel(endpoint),
        buildId: life.buildId,
        targetBuildId: target.buildId,
        businessCompatibility: compatible ? 'compatible' : 'incompatible',
        lifecycle: life,
        availableActions:
          life.phase === 'draining'
            ? []
            : life.phase === 'starting'
              ? ['stop']
              : [
                  'stop',
                  ...(life.activeOperations ? [] : ['restart']),
                  'restart --cancel',
                  ...(compatible && life.webOrigin ? ['web'] : []),
                ],
        instanceId: life.instanceId,
        workspace: life.workspace,
        startedAt: life.startedAt,
        ...(life.webOrigin ? { webOrigin: life.webOrigin } : {}),
      };
    } catch {
      // Read-only diagnosis of pre-release instances; never use their business shutdown as a fallback.
      const legacy = await readLegacyStatus();
      return {
        ...legacy,
        targetBuildId: target.buildId,
        businessCompatibility:
          legacy.state === 'incompatible'
            ? 'incompatible'
            : legacy.state === 'ready'
              ? 'compatible'
              : 'unknown',
        availableActions:
          legacy.state === 'absent'
            ? ['start']
            : legacy.state === 'ready' && legacy.webOrigin
              ? ['web']
              : [],
        ...(legacy.state === 'absent' ? {} : { diagnostic: 'lifecycle_unavailable' }),
      };
    }
  };
  const stopInstance = async (current: AppServerDaemonStatus, cancel: boolean): Promise<void> => {
    const life = current.lifecycle;
    if (!life)
      throw new Error(
        'Daemon lifecycle is unavailable; use its matching client or verify the old development instance before stopping it.',
      );
    const response = await requestKiteLifecycle(endpoint, {
      operation: 'shutdown',
      expectedInstanceId: life.instanceId,
      mode: cancel ? 'cancel' : 'if_idle',
    });
    if (response.operation !== 'shutdown')
      throw new Error('Daemon lifecycle shutdown is unavailable.');
    if (response.outcome === 'busy')
      throw new Error(
        'App Server is busy; wait for tasks to finish or use `server restart --cancel`.',
      );
    if (response.outcome === 'instance_changed')
      throw new Error('App Server instance changed; inspect status before retrying.');
    const probe = createKiteLocalRuntimeProcessIdentityProbe();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const observed = await readStatus();
      if (observed.instanceId && observed.instanceId !== life.instanceId)
        throw new Error('App Server changed concurrently.');
      if (
        observed.state === 'absent' &&
        (await probe.inspect(life.pid, life.processStartIdentity)) === 'dead'
      )
        return;
      await Bun.sleep(50);
    }
    throw new Error(
      'App Server stop_timeout; shutdown may still be completing. No replacement was started.',
    );
  };
  const daemon: ManagedLocalAppServerDaemon = {
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
      preflightWebGatewayStaticAssets(preparedTarget.webStaticRoot);
      // The CLI-owned stdio Service has the qualified writer admission. Initialize only:
      // Store preparation finishes before any Session command, then its process and leases close.
      const preparation = createKiteAppServerClient({
        startupSignals: process,
        executable: preparedTarget.executable,
        argumentsPrefix: preparedTarget.argumentsPrefix,
        buildId: preparedTarget.buildId,
        runtimeRoot: preparedTarget.runtimeRoot,
        configRoot: preparedTarget.configRoot,
        osHome: preparedTarget.systemHome,
        workspace: canonicalWorkspace,
        cwd: runtimeParent,
        environment: preparedTarget.environment,
        clientInfo: {
          name: 'kite-daemon-preparation',
          version: '0.1.0',
          instanceId: `daemon_preparation_${randomUUID()}`,
        },
        ...(options.onStartupProgress ? { onStartupProgress: options.onStartupProgress } : {}),
      });
      try {
        await preparation.prepareAppControl();
      } finally {
        // Even a successful initialize cannot license daemon spawn until the
        // temporary Service has released every connection and maintenance lock.
        await preparation.close('daemon-preparation-complete');
      }
      const afterPreparation = await readStatus();
      if (afterPreparation.state !== 'absent') {
        return afterPreparation.state === 'ready' &&
          (afterPreparation.workspace !== canonicalWorkspace ||
            afterPreparation.buildId !== target.buildId)
          ? { ...afterPreparation, state: 'incompatible' }
          : afterPreparation;
      }
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
        stderr: 'pipe',
        detached: true,
      });
      child.unref();
      const stderr = captureStartupStderr(child.stderr, options.onStartupProgress);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const status = await readStatus();
        if (
          status.state === 'ready' ||
          status.state === 'draining' ||
          status.state === 'incompatible'
        ) {
          await stderr.stop();
          return status.state === 'ready' &&
            (status.buildId !== target.buildId || status.workspace !== canonicalWorkspace)
            ? { ...status, state: 'incompatible' }
            : status;
        }
        if (child.exitCode !== null) {
          const diagnostic = await stderr.finish();
          throw new Error(
            describeServiceStartupFailure(diagnostic, child.exitCode) +
              (diagnostic
                ? `\n可将以下脱敏诊断保存，用于排查：\n${formatServiceStartupReport(diagnostic)}`
                : ''),
          );
        }
        await Bun.sleep(50);
      }
      await stderr.stop();
      throw new Error('App Server start_timeout; inspect server status before retrying.');
    },
    async restart(workspace?: string, cancel = false): Promise<AppServerDaemonStatus> {
      const current = await readStatus();
      const canonicalWorkspace = realpathSync.native(
        workspace ?? current.workspace ?? process.cwd(),
      );
      if (current.workspace && current.workspace !== canonicalWorkspace)
        throw new Error('Selected App Server daemon serves a different Workspace.');
      const prepared = prepareManagedLocalAppServerTarget(target);
      validateWebStaticRoot(prepared.webStaticRoot);
      preflightWebGatewayStaticAssets(prepared.webStaticRoot);
      if (current.state !== 'absent') {
        // Existing Service is drained only after its current Store and every known source
        // are fully validated. Historical conversion here would require a separate
        // candidate and retired-writer admission before stopping the old instance.
        const storePath = join(prepared.runtimeRoot, 'kite-session.sqlite');
        validateKiteSessionStoreDatabase(storePath);
        assertKiteSessionStoreSourcesReconciled(storePath);
        if (pathExists(join(prepared.runtimeRoot, 'kite-session-publication.json')))
          throw new Error('Store publication is pending; the existing App Server was preserved.');
      }
      if (current.state !== 'absent') await stopInstance(current, cancel);
      const started = await daemon.start(canonicalWorkspace);
      if (
        started.state !== 'ready' ||
        started.buildId !== target.buildId ||
        started.workspace !== canonicalWorkspace
      ) {
        throw new Error(
          'App Server restart did not reach the selected build and Workspace; inspect status.',
        );
      }
      return started;
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
      if (current.state === 'absent') return current;
      await stopInstance(current, true);
      return readStatus();
    },
  };
  return Object.freeze(daemon);
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

/** Keep only the bounded trusted startup envelope; never surface arbitrary Service stderr. */
function captureStartupStderr(
  stream: ReadableStream<Uint8Array>,
  onStartupProgress?: (progress: ServiceStartupProgress) => void,
): {
  finish(): Promise<ServiceStartupDiagnostic | undefined>;
  stop(): Promise<void>;
} {
  const reader = stream.getReader();
  const line = new Uint8Array(MAX_SERVICE_STARTUP_STDERR_BYTES);
  let length = 0;
  let discard = false;
  let diagnostic: ServiceStartupDiagnostic | undefined;
  let acceptingProgress = true;
  const completed = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        for (const byte of chunk.value) {
          if (byte === 0x0a) {
            if (!discard) {
              try {
                const payloadLength = length > 0 && line[length - 1] === 0x0d ? length - 1 : length;
                const text = new TextDecoder('utf-8', { fatal: true }).decode(
                  line.subarray(0, payloadLength),
                );
                const progress = parseServiceStartupProgress(text);
                if (progress) {
                  try {
                    if (acceptingProgress) onStartupProgress?.(progress);
                  } catch {
                    // A display callback cannot change daemon startup.
                  }
                } else {
                  diagnostic = parseServiceStartupDiagnostic(text) ?? diagnostic;
                }
              } catch {
                // Never expose malformed or arbitrary Service stderr.
              }
            }
            length = 0;
            discard = false;
          } else if (!discard) {
            if (length === line.length) {
              length = 0;
              discard = true;
            } else {
              line[length++] = byte;
            }
          }
        }
      }
    } catch {
      // Startup diagnostics are optional; an unreadable pipe never supplies authority.
    }
    return diagnostic;
  })();
  return {
    async finish() {
      await Promise.race([completed, Bun.sleep(1_000)]);
      await reader.cancel().catch(() => undefined);
      return diagnostic;
    },
    async stop() {
      acceptingProgress = false;
      await reader.cancel().catch(() => undefined);
    },
  };
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
  return (
    error instanceof RuntimeClientError &&
    (error.code === 'server_mismatch' ||
      (error.code === 'protocol_error' &&
        error.protocol?.data.code === 'protocol_version_mismatch'))
  );
}
