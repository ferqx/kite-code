import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import type { KiteAppServerConnection } from '@kite-ai/kite-local-runtime/client';
import type {
  RuntimeClient,
  RuntimeClientInfo,
  RuntimeHistoryClient,
  RuntimeSnapshotStore,
} from '@kite-ai/runtime-client';

export type KiteRuntimeModeConnection = KiteAppServerConnection;

/** Client-only view of one paired or explicit App Server connection. */
export interface KiteRuntimeModeAdapter extends AsyncDisposable {
  readonly connection: KiteRuntimeModeConnection;
  readonly runtime: RuntimeClient;
  readonly history: RuntimeHistoryClient;
  readonly appControl: KiteAppControlClient;
  readonly credentialClient: KiteAppServerConnection['credential'];
  readonly snapshotStore: RuntimeSnapshotStore;
  readonly status: KiteAppServerConnection['status'];
  readonly generation: number;
  subscribeSnapshot(listener: () => void): () => void;
  reconnect(): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface KiteRuntimeModeConnector {
  connect(input: {
    readonly workspace: string;
    readonly clientInfo?: RuntimeClientInfo;
  }): Promise<KiteRuntimeModeConnection>;
}

/** Adapt an already-created App Server connection without discovering or constructing authority. */
export function createKiteRuntimeModeAdapter(
  connection: KiteRuntimeModeConnection,
): KiteRuntimeModeAdapter {
  return new KiteRuntimeModeAdapterImpl(connection);
}

export async function connectKiteRuntimeMode(
  connector: KiteRuntimeModeConnector,
  input: { readonly workspace: string },
): Promise<KiteRuntimeModeAdapter> {
  return createKiteRuntimeModeAdapter(await connector.connect({ workspace: input.workspace }));
}

class KiteRuntimeModeAdapterImpl implements KiteRuntimeModeAdapter {
  readonly connection: KiteRuntimeModeConnection;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(connection: KiteRuntimeModeConnection) {
    this.connection = connection;
  }

  get runtime(): RuntimeClient {
    return this.connection.runtime;
  }

  get history(): RuntimeHistoryClient {
    return this.connection.history;
  }

  get appControl(): KiteAppControlClient {
    return this.connection.app;
  }

  get credentialClient(): KiteAppServerConnection['credential'] {
    return this.connection.credential;
  }

  get snapshotStore(): RuntimeSnapshotStore {
    return this.connection.snapshotStore;
  }

  get status(): KiteAppServerConnection['status'] {
    return this.connection.status;
  }

  get generation(): number {
    return this.connection.generation;
  }

  subscribeSnapshot(listener: () => void): () => void {
    return this.connection.subscribe(listener);
  }

  reconnect(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Kite Runtime mode adapter is closed.'));
    return this.connection.reconnect();
  }

  close(reason = 'runtime_mode_client_closed'): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.connection.close(reason);
    return this.#closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
