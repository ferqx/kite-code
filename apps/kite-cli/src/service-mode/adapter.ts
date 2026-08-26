import type { KiteAppControlClient } from '@kite-ai/kite-app-contract';
import type {
  LocalKiteConnection,
  LocalKiteConnectionStatus,
} from '@kite-ai/kite-local-runtime/client';
import type { LocalRuntimeServiceDescriptor } from '@kite-ai/kite-local-runtime/service';
import type {
  RuntimeClient,
  RuntimeHistoryClient,
  RuntimeSnapshotStore,
} from '@kite-ai/runtime-client';

/**
 * The only CLI-owned object in the opt-in Service path.  It is a typed view
 * over one Native connection; discovery, auth, reconnect transport and every
 * remote owner remain in `@kite-ai/kite-local-runtime/client`.
 */
export interface KiteServiceModeAdapter extends AsyncDisposable {
  /** The opaque Native connection; tokens and process handles are not exposed. */
  readonly connection: LocalKiteConnection;
  /** Existing Runtime Client facade; no Runtime Host/Store is created here. */
  readonly runtime: RuntimeClient;
  /** Existing authenticated durable History facade. */
  readonly history: RuntimeHistoryClient;
  /** Existing exact App Control facade. */
  readonly appControl: KiteAppControlClient;
  /** Optional Native-only credential capability for first-run composition. */
  readonly credentialClient: LocalKiteConnection['credential'];
  readonly service: LocalRuntimeServiceDescriptor;
  readonly snapshotStore: RuntimeSnapshotStore;
  readonly status: LocalKiteConnectionStatus;
  readonly generation: number;
  /** Snapshot observers are presentation-only and cannot alter Runtime state. */
  subscribeSnapshot(listener: () => void): () => void;
  reconnect(): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface KiteServiceModeAdapterOptions {
  readonly connection: LocalKiteConnection;
}

/**
 * Compose an adapter from an already authenticated typed connection.  This
 * function never discovers files, reads tokens, opens SQLite, starts a Host,
 * or falls back to the InProcess composition.
 */
export function createKiteServiceModeAdapter(
  options: KiteServiceModeAdapterOptions | LocalKiteConnection,
): KiteServiceModeAdapter {
  const connection = isOptions(options) ? options.connection : options;
  return new KiteServiceModeAdapterImpl(connection);
}

/** Descriptive alias used by foreground CLI integration code. */
export const createKiteServiceModeClient = createKiteServiceModeAdapter;

export interface KiteServiceModeConnector {
  /** Discovery/ensure is intentionally outside this CLI adapter. */
  connect(input: { readonly workspace: string }): Promise<LocalKiteConnection>;
}

/**
 * Explicit connector entry point for future opt-in wiring.  A failed
 * connection rejects; it is never replaced with an embedded/InProcess client.
 */
export async function connectKiteServiceMode(
  connector: KiteServiceModeConnector,
  input: { readonly workspace: string },
): Promise<KiteServiceModeAdapter> {
  const connection = await connector.connect({ workspace: input.workspace });
  return createKiteServiceModeAdapter(connection);
}

class KiteServiceModeAdapterImpl implements KiteServiceModeAdapter {
  readonly connection: LocalKiteConnection;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(connection: LocalKiteConnection) {
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

  get credentialClient(): LocalKiteConnection['credential'] {
    return this.connection.credential;
  }

  get service(): LocalRuntimeServiceDescriptor {
    return this.connection.service;
  }

  get snapshotStore(): RuntimeSnapshotStore {
    return this.connection.snapshotStore;
  }

  get status(): LocalKiteConnectionStatus {
    return this.connection.status;
  }

  get generation(): number {
    return this.connection.generation;
  }

  subscribeSnapshot(listener: () => void): () => void {
    return this.connection.subscribe(listener);
  }

  reconnect(): Promise<void> {
    if (this.#closed) return Promise.reject(new Error('Kite Service mode adapter is closed.'));
    return this.connection.reconnect();
  }

  close(reason = 'service_mode_client_closed'): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    // Closing the Native connection only tears down this Client's connection,
    // subscriptions and local snapshot store.  It never sends Runtime cancel
    // or close-session commands and cannot dispose the Service Host.
    this.#closePromise = this.connection.close(reason);
    return this.#closePromise;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

function isOptions(
  value: KiteServiceModeAdapterOptions | LocalKiteConnection,
): value is KiteServiceModeAdapterOptions {
  return 'connection' in value;
}
