import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { RuntimeClient, type RuntimeClientInfo } from '@kite-ai/runtime-client';
import type { RuntimeProtocolMethod } from '@kite-ai/runtime-protocol';
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
import { createProtocolKiteAppControlClient } from './protocol-app-control';

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

export function kiteAppServerVersion(buildId: string): string {
  if (!buildId || buildId.length > 4_096 || /\p{Cc}/u.test(buildId)) {
    throw new TypeError('App Server build identity must be a bounded non-empty string.');
  }
  return `kite-app-server-v1-${createHash('sha256').update(buildId).digest('hex')}`;
}

/** One parent-owned child and one initialized connection carrying Runtime, History and App Control. */
export function createKiteAppServerClient(options: KiteAppServerClientOptions) {
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
  const runtime = new RuntimeClient({
    transport,
    clientInfo: options.clientInfo,
    history: 'protocol',
    expectedServer: {
      version: kiteAppServerVersion(options.buildId),
      requiredMethods: KITE_APP_SERVER_PROTOCOL_METHODS_,
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
    connect: () => runtime.connect(),
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
