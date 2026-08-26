import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import type {
  RuntimeClient,
  RuntimeClientConnection,
  RuntimeClientInfo,
  RuntimeClientTransport,
  RuntimeHistoryClient,
} from '@kite-ai/runtime-client';
import type {
  LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_,
  LocalRuntimeServiceDescriptor,
} from '../service/codecs';
import type {
  LocalRuntimeCredentialRequest,
  LocalRuntimeCredentialResult,
  LocalRuntimeLifecycleRequest,
  LocalRuntimeLifecycleResult,
  NativeProviderCredentialRequest,
  NativeProviderCredentialResult,
} from './codecs';

export type LocalKiteConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'active'
  | 'reconnecting'
  | 'closed';

/**
 * Native connection resources only. Control credentials and process handles deliberately do not
 * cross this interface; reconnect is explicit and RuntimeClient owns its no-replay semantics.
 */
export interface LocalKiteConnection extends AsyncDisposable {
  readonly runtime: RuntimeClient;
  readonly history: RuntimeHistoryClient;
  readonly app: KiteAppControlClient;
  /** Native-only provider credential route; it never returns the submitted secret. */
  readonly credential: NativeProviderCredentialClient;
  readonly service: LocalRuntimeServiceDescriptor;
  readonly status: LocalKiteConnectionStatus;
  readonly generation: number;
  /** The RuntimeClient snapshot is the only observable connection/index seam. */
  readonly snapshotStore: RuntimeClient['snapshotStore'];
  subscribe(listener: () => void): () => void;
  /** Ensure/discover descriptor+access for pre-admission Trust/App Control; opens no Runtime. */
  prepareAppControl(): Promise<void>;
  /** Acquire a trusted Workspace ticket and establish the Runtime connection. */
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface LocalRuntimeWebSocketTransport extends RuntimeClientTransport {
  readonly descriptor: LocalRuntimeServiceDescriptor;
  readonly accessToken: string;
  connect(): Promise<RuntimeClientConnection>;
}

export interface LocalRuntimeHistoryTransport {
  readonly descriptor: LocalRuntimeServiceDescriptor;
  readonly accessToken: string;
  listSessions(
    request: Parameters<RuntimeHistoryClient['listSessions']>[0],
  ): ReturnType<RuntimeHistoryClient['listSessions']>;
  listEvents(
    request: Parameters<RuntimeHistoryClient['listEvents']>[0],
  ): ReturnType<RuntimeHistoryClient['listEvents']>;
  loadSession(sessionId: string): ReturnType<RuntimeHistoryClient['loadSession']>;
}

export interface LocalRuntimeAppControlTransport {
  readonly descriptor: LocalRuntimeServiceDescriptor;
  readonly accessToken: string;
  connect(): Promise<KiteAppControlClient>;
}

/**
 * Narrow Native-only credential capability used by the current first-run TUI.
 * The request is codec-checked and deliberately carries no generic command or
 * provider configuration object across the client boundary.
 */
export interface NativeProviderCredentialClient {
  writeProviderCredential(
    request: NativeProviderCredentialRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<NativeProviderCredentialResult>;
}

export interface LocalRuntimeClientOptions {
  readonly clientInfo: RuntimeClientInfo;
  readonly clientContractRevision: typeof LOCAL_RUNTIME_CLIENT_CONTRACT_REVISION_;
}

/**
 * Manager owns discovery/ensure and the control-token lifecycle. It returns a connection only
 * after descriptor, protocol, contract-revision, and instance identity checks succeed.
 */
export interface LocalRuntimeServiceManager {
  discover(): Promise<LocalRuntimeServiceDescriptor | undefined>;
  ensure(options?: LocalRuntimeClientOptions): Promise<LocalRuntimeServiceDescriptor>;
  status(options?: LocalRuntimeClientOptions): Promise<LocalRuntimeLifecycleResult>;
  stop(request?: LocalRuntimeLifecycleRequest): Promise<LocalRuntimeLifecycleResult>;
  restart(request?: LocalRuntimeLifecycleRequest): Promise<LocalRuntimeLifecycleResult>;
  connect(options?: LocalRuntimeClientOptions): Promise<LocalKiteConnection>;
  writeCredential(request: LocalRuntimeCredentialRequest): Promise<LocalRuntimeCredentialResult>;
}
