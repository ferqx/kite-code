/**
 * The service app is deliberately defined in terms of ports.  The concrete Runtime Application
 * is owned by the service composition tranche and is injected here; this package must not import
 * the CLI application or copy a Host/Store implementation while the relocation is in progress.
 */

export type KiteServiceSignal = 'SIGINT' | 'SIGTERM';

export type KiteServicePhase = 'absent' | 'starting' | 'ready' | 'quiescing' | 'draining';

export type KiteServiceReadiness = 'starting' | 'ready' | 'unavailable';

export type KiteServiceDiagnostic =
  | 'service_busy'
  | 'startup_failed'
  | 'shutdown_failed'
  | 'service_unavailable';

export type KiteServiceLifecycleOutcome = 'applied' | 'service_busy' | 'unavailable';

export interface KiteRuntimeApplicationQuiesceLease {
  readonly activeOperations: boolean;
  /** Re-open mutation admission when ordinary stop cannot proceed. */
  resume(): void;
  /** Atomically reject new mutation admission and commit the drain barrier. */
  commitDrain(): Promise<void>;
}

/**
 * Minimal lifecycle surface shared with the app-local Runtime Application.  The service shell
 * never receives a SessionManager, Store handle, callback, or UI object through this port.
 */
export interface KiteRuntimeApplicationPort extends AsyncDisposable {
  start(options?: { readonly signal?: AbortSignal }): Promise<void>;
  quiesceMutations(): Promise<KiteRuntimeApplicationQuiesceLease>;
  cancelAll(reason: string): Promise<void>;
}

/**
 * State/descriptor/lock ownership is supplied by the Native infrastructure tranche.  These
 * methods intentionally describe lifecycle facts instead of filesystem details so tests can use
 * an in-memory owner and the shell cannot accidentally become a second Store or lock owner.
 */
export interface KiteServiceStatePort {
  prepareStart(options?: { readonly signal?: AbortSignal }): Promise<void>;
  publishReady(options?: { readonly signal?: AbortSignal }): Promise<void>;
  /** Keep descriptor/lock evidence after a failed startup or shutdown. */
  preserveFailure(): Promise<void>;
  /** Remove descriptor/token/lock only after every owner has closed successfully. */
  clear(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

/**
 * Listener ownership is supplied by a carrier adapter.  `stop` must reject new connections and
 * release listener resources; it must not dispose the Runtime Application or Store.
 */
export interface KiteServiceTransportPort {
  start(options?: { readonly signal?: AbortSignal }): Promise<void>;
  stop(): Promise<void>;
}

export interface KiteServiceReadinessEvent {
  readonly state: KiteServiceReadiness;
  readonly diagnostic?: KiteServiceDiagnostic;
}

export interface KiteServiceReadinessPort {
  publish(event: KiteServiceReadinessEvent): Promise<void> | void;
}

export interface KiteServiceSignalPort {
  subscribe(signal: KiteServiceSignal, listener: () => void): () => void;
}

export interface KiteServiceLifecycleResult {
  readonly operation: 'start' | 'stop' | 'signal_shutdown';
  readonly outcome: KiteServiceLifecycleOutcome;
  readonly state: KiteServicePhase;
  readonly diagnostic?: KiteServiceDiagnostic;
}

export interface KiteServiceShellOptions {
  readonly application: KiteRuntimeApplicationPort;
  /** Native state/descriptor/token/lock owner; required so missing infrastructure cannot look ready. */
  readonly state: KiteServiceStatePort;
  /** Runtime carrier/listener owner; required so missing infrastructure cannot look ready. */
  readonly transport: KiteServiceTransportPort;
  readonly readiness?: KiteServiceReadinessPort;
  readonly signals?: KiteServiceSignalPort;
  /** Bound for injected startup hooks; production callers cannot disable the bound. */
  readonly startupTimeoutMs?: number;
  /** Bound for injected shutdown hooks; production callers cannot disable the bound. */
  readonly shutdownTimeoutMs?: number;
}

export interface KiteServiceShell extends AsyncDisposable {
  readonly phase: KiteServicePhase;
  readonly readiness: KiteServiceReadiness;
  start(): Promise<KiteServiceLifecycleResult>;
  stop(): Promise<KiteServiceLifecycleResult>;
  /**
   * Quiesce an ordinary control request and, when idle, schedule owner cleanup after the caller
   * can flush its response.  Accepted requests return `applied` in `draining`; `stop()` can be
   * awaited by an owner that needs final settlement.
   */
  requestStop(): Promise<KiteServiceLifecycleResult>;
  /** Signal shutdown is owner shutdown, not ordinary `stop` and not a Runtime cancel command. */
  signal(signal: KiteServiceSignal): Promise<KiteServiceLifecycleResult>;
  /** Resolves when a signal shutdown has settled.  Useful for the internal executable only. */
  waitForSignalShutdown(): Promise<KiteServiceLifecycleResult>;
  /** Resolves for either authenticated control stop or signal shutdown. */
  waitForShutdown(): Promise<KiteServiceLifecycleResult>;
}
