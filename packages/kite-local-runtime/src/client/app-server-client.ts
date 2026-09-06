import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import {
  RuntimeClient,
  type RuntimeClientInfo,
  type RuntimeClientTransport,
} from '@kite-ai/runtime-client';
import type { RuntimeProtocolMethod } from '@kite-ai/runtime-protocol';
import type { KiteLocalRuntimeEndpoint } from '../service';
import {
  type BunStdioChildSpawnFactory,
  createBunStdioChildRuntimeClientTransport,
} from './bun-stdio-child-transport';
import {
  decodeLocalRuntimeCredentialResult,
  encodeLocalRuntimeCredentialRequest,
  type NativeProviderCredentialRequest,
  type NativeProviderCredentialResult,
} from './codecs';
import type { NativeProviderCredentialClient } from './connection';
import { createNodeSocketRuntimeClientTransport } from './node-socket-transport';
import { createProtocolKiteAppControlClient } from './protocol-app-control';

export interface KiteAppServerConnection extends AsyncDisposable {
  readonly runtime: RuntimeClient;
  readonly history: NonNullable<RuntimeClient['history']>;
  readonly app: ReturnType<typeof createProtocolKiteAppControlClient>;
  readonly credential: NativeProviderCredentialClient;
  /** Session execution authority is carried by Runtime commands, never a side-channel controller. */
  readonly controller?: undefined;
  readonly snapshotStore: RuntimeClient['snapshotStore'];
  readonly status: 'disconnected' | 'connecting' | 'active' | 'reconnecting' | 'closed';
  readonly generation: number;
  subscribe(listener: () => void): () => void;
  /** Opens the one exact protocol connection so Trust/App methods can run before Runtime mutation. */
  prepareAppControl(): Promise<void>;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  close(reason?: string): Promise<void>;
}

export const KITE_APP_SERVER_PROTOCOL_METHODS_ = Object.freeze([
  'history/list_sessions',
  'history/list_events',
  'history/load_session',
  'app/workspace_trust/query',
  'app/workspace_trust/decide',
  'app/provider_model/snapshot',
  'app/provider_model/select',
  'app/mcp/snapshot',
  'app/mcp/action',
  'app/skills/catalog',
  'app/execution/status',
  'app/release/status',
  'app/provider_credential/write',
] as const satisfies readonly RuntimeProtocolMethod[]);

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

function createAppServerProtocolConnection(
  transport: RuntimeClientTransport,
  expectedServerVersion: string,
  clientInfo: RuntimeClientInfo,
  requiredMethods: readonly RuntimeProtocolMethod[],
): KiteAppServerConnection {
  const runtime = new RuntimeClient({
    transport,
    clientInfo,
    history: 'protocol',
    expectedServer: {
      version: expectedServerVersion,
      requiredMethods,
    },
  });
  const credential: NativeProviderCredentialClient = Object.freeze({
    writeProviderCredential: async (
      request: NativeProviderCredentialRequest,
      requestOptions?: { readonly signal?: AbortSignal },
    ): Promise<NativeProviderCredentialResult> => {
      if (requestOptions?.signal?.aborted) throw new Error('Provider credential write cancelled.');
      const response = await runtime.requestApp(
        'app/provider_credential/write',
        encodeLocalRuntimeCredentialRequest(request),
      );
      const decoded = decodeLocalRuntimeCredentialResult(response);
      if (decoded.operation !== 'write_provider_api_key') {
        throw new TypeError('App Server returned the wrong credential operation.');
      }
      return decoded as NativeProviderCredentialResult;
    },
  });
  return Object.freeze({
    runtime,
    history: runtime.history!,
    app: createProtocolKiteAppControlClient(runtime),
    credential,
    controller: undefined,
    snapshotStore: runtime.snapshotStore,
    get status() {
      const status = runtime.snapshotStore.getSnapshot().status;
      if (status === 'connecting') return 'connecting' as const;
      if (status === 'reconnecting') return 'reconnecting' as const;
      if (status === 'active') return 'active' as const;
      if (status === 'closed' || status === 'draining') return 'closed' as const;
      return 'disconnected' as const;
    },
    get generation() {
      return runtime.connectionGeneration;
    },
    subscribe: (listener: () => void) => runtime.snapshotStore.subscribe(listener),
    prepareAppControl: () => runtime.connect(),
    connect: () => runtime.connect(),
    reconnect: () => runtime.reconnect(),
    close: (reason?: string) => runtime.close(reason),
    [Symbol.asyncDispose]: () => runtime[Symbol.asyncDispose](),
  });
}

function absolute(value: string, label: string): string {
  if (!value || !isAbsolute(value) || /\p{Cc}/u.test(value)) {
    throw new TypeError(`App Server ${label} must be an absolute path.`);
  }
  return resolve(value);
}
