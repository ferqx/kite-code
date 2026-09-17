import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import type { RuntimeClientInfo } from '@kite-ai/runtime-client';
import type { RuntimeProtocolMethod } from '@kite-ai/runtime-protocol';
import type { KiteLocalRuntimeEndpoint } from '../service';
import type { ServiceStartupProgress } from '../service-startup-diagnostic';
import {
  type BunStdioChildSpawnFactory,
  type BunStdioStartupSignals,
  createBunStdioChildRuntimeClientTransport,
} from './bun-stdio-child-transport';
import { createNodeSocketRuntimeClientTransport } from './node-socket-transport';
import {
  createAppServerProtocolConnection,
  KITE_APP_SERVER_PROTOCOL_METHODS_,
  type KiteAppServerConnection,
} from './protocol-connection';

export {
  KITE_APP_SERVER_PROTOCOL_METHODS_,
  type KiteAppServerConnection,
} from './protocol-connection';

export const KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_ = Object.freeze([
  ...KITE_APP_SERVER_PROTOCOL_METHODS_,
  'server/status',
  'server/shutdown',
] as const satisfies readonly RuntimeProtocolMethod[]);
export const KITE_APP_SERVER_DAEMON_VERSION_ = 'kite-app-server-daemon-v2' as const;

export interface KiteAppServerClientOptions {
  readonly executable: string;
  /** Source mode may place an exact checked-in entrypoint before the internal App Server args. */
  readonly argumentsPrefix?: readonly string[];
  readonly buildId: string;
  readonly runtimeRoot: string;
  readonly configRoot: string;
  readonly osHome: string;
  readonly workspace: string;
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly clientInfo: RuntimeClientInfo;
  readonly spawn?: BunStdioChildSpawnFactory;
  readonly onStartupProgress?: (progress: ServiceStartupProgress) => void;
  readonly startupSignals?: BunStdioStartupSignals;
}

export interface KiteAppServerDaemonClientOptions {
  readonly endpoint: KiteLocalRuntimeEndpoint;
  readonly clientInfo: RuntimeClientInfo;
}

export function kiteAppServerVersion(buildId: string): string {
  if (!buildId || buildId.length > 4_096 || /\p{Cc}/u.test(buildId)) {
    throw new TypeError('App Server build identity must be a bounded non-empty string.');
  }
  return `kite-app-server-v1-${createHash('sha256').update(buildId).digest('hex')}`;
}

/** One parent-owned child and one initialized connection carrying Runtime, History and App Control. */
export function createKiteAppServerClient(
  options: KiteAppServerClientOptions,
): KiteAppServerConnection {
  const executable = absolute(options.executable, 'executable');
  const runtimeRoot = absolute(options.runtimeRoot, 'runtimeRoot');
  const configRoot = absolute(options.configRoot, 'configRoot');
  const osHome = absolute(options.osHome, 'osHome');
  const workspace = absolute(options.workspace, 'workspace');
  const cwd = absolute(options.cwd, 'cwd');
  const argumentsPrefix = options.argumentsPrefix ?? [];
  if (
    argumentsPrefix.some(
      (argument) => !argument || argument.length > 4_096 || /\p{Cc}/u.test(argument),
    )
  ) {
    throw new TypeError('App Server argument prefix must contain bounded strings.');
  }
  const transport = createBunStdioChildRuntimeClientTransport({
    argv: [executable, ...argumentsPrefix, 'app-server', 'run-stdio'],
    cwd,
    env: {
      ...options.environment,
      KITE_CODE_HOME: runtimeRoot,
      KITE_CODE_CONFIG_HOME: configRoot,
      KITE_APP_SERVER_WORKSPACE: workspace,
      KITE_APP_SERVER_BUILD_ID: options.buildId,
      HOME: osHome,
      USERPROFILE: osHome,
    },
    ...(options.spawn ? { spawn: options.spawn } : {}),
    ...(options.onStartupProgress ? { onStartupProgress: options.onStartupProgress } : {}),
    ...(options.startupSignals ? { startupSignals: options.startupSignals } : {}),
  });
  return createAppServerProtocolConnection(
    transport,
    kiteAppServerVersion(options.buildId),
    options.clientInfo,
    KITE_APP_SERVER_PROTOCOL_METHODS_,
  );
}

/** Connect only to the caller-selected daemon endpoint; no discovery or spawn occurs. */
export function createKiteAppServerDaemonClient(
  options: KiteAppServerDaemonClientOptions,
): KiteAppServerConnection {
  return createAppServerProtocolConnection(
    createNodeSocketRuntimeClientTransport({ endpoint: options.endpoint }),
    KITE_APP_SERVER_DAEMON_VERSION_,
    options.clientInfo,
    KITE_APP_SERVER_DAEMON_PROTOCOL_METHODS_,
  );
}

function absolute(value: string, label: string): string {
  if (!value || !isAbsolute(value) || /\p{Cc}/u.test(value)) {
    throw new TypeError(`App Server ${label} must be an absolute path.`);
  }
  return resolve(value);
}
