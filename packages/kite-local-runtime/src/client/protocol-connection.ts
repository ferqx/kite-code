import {
  RuntimeClient,
  type RuntimeClientInfo,
  type RuntimeClientTransport,
} from '@kite-ai/runtime-client';
import type { RuntimeProtocolMethod } from '@kite-ai/runtime-protocol';
import {
  decodeLocalRuntimeCredentialResult,
  encodeLocalRuntimeCredentialRequest,
  type NativeProviderCredentialRequest,
  type NativeProviderCredentialResult,
} from './codecs';
import type { NativeProviderCredentialClient } from './connection';
import { createProtocolKiteAppControlClient } from './protocol-app-control';

/** Environment-free composition for trusted native application transports. */
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
  'app/provider_model/set_enabled',
  'app/mcp/snapshot',
  'app/mcp/action',
  'app/skills/catalog',
  'app/execution/status',
  'app/release/status',
  'app/provider_credential/write',
] as const satisfies readonly RuntimeProtocolMethod[]);

export function createAppServerProtocolConnection(
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
