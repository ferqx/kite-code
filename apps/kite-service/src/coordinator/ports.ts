import type {
  CoordinatorCarrier,
  CoordinatorCarrierAdapter,
  CoordinatorCatalog,
  CoordinatorCatalogStorageIdentity,
  CoordinatorControlPlane,
  CoordinatorDispatcher,
  CoordinatorEndpointDescriptor,
  CoordinatorIdentity,
  CoordinatorOsIdentity,
  CoordinatorProcessDescriptor,
  CoordinatorProcessLockLease,
  CoordinatorProcessReadySignal,
  CoordinatorProcessStatePort,
  CoordinatorReconcileInput,
  CoordinatorRegistry,
  CoordinatorWebGatewayControlPort,
  CoordinatorWorkerControlPort,
} from '@kite-ai/kite-local-runtime/coordinator';
import type { KiteHomeIdentity } from '@kite-ai/kite-local-runtime/service';

export type KiteCoordinatorPhase = 'absent' | 'starting' | 'reconciling' | 'ready' | 'draining';

export type KiteCoordinatorLifecycleOutcome = 'applied' | 'unavailable';

export interface KiteCoordinatorLifecycleResult {
  readonly operation: 'start' | 'stop' | 'signal_shutdown';
  readonly outcome: KiteCoordinatorLifecycleOutcome;
  readonly state: KiteCoordinatorPhase;
  readonly diagnostic?: 'busy' | 'startup_failed' | 'shutdown_failed' | 'identity_uncertain';
}

export interface KiteCoordinatorReadinessPort {
  publish(signal: CoordinatorProcessReadySignal): Promise<void> | void;
}

export type KiteCoordinatorSignal = 'SIGINT' | 'SIGTERM';

export interface KiteCoordinatorSignalPort {
  subscribe(signal: KiteCoordinatorSignal, listener: () => void): () => void;
}

export interface KiteCoordinatorReconcilePort {
  reconcile(): CoordinatorReconcileInput | Promise<CoordinatorReconcileInput>;
}

export interface KiteCoordinatorDirectorySyncPort {
  sync(input: {
    readonly catalog: CoordinatorCatalog;
    readonly registry: CoordinatorRegistry;
  }): Promise<void> | void;
}

export interface KiteCoordinatorCompositionOptions {
  /** Canonical, already validated Kite home supplied by the manager. */
  readonly home: KiteHomeIdentity;
  /** Active-layout identity supplied by the layout owner; no default path is inferred. */
  readonly catalogStorage: CoordinatorCatalogStorageIdentity;
  readonly identity: CoordinatorIdentity;
  /** Exact OS process-start token supplied by the manager/launcher. */
  readonly processStartIdentity: string;
  readonly peerOsIdentity: CoordinatorOsIdentity;
  readonly workers: CoordinatorWorkerControlPort;
  readonly gateway: CoordinatorWebGatewayControlPort;
  readonly reconcile: KiteCoordinatorReconcilePort;
  /** Authenticated Worker outbox reconciliation; never a Runtime data-plane port. */
  readonly directorySync?: KiteCoordinatorDirectorySyncPort;
  /** Optional shared registry used by the production Worker/Gateway lifecycle adapters. */
  readonly registry?: CoordinatorRegistry;
  readonly readiness: KiteCoordinatorReadinessPort;
  readonly endpoint?: CoordinatorEndpointDescriptor;
  readonly endpointId?: string;
  readonly pid?: number;
  readonly startedAt?: string;
  readonly carrierAdapter?: CoordinatorCarrierAdapter;
  readonly signals?: KiteCoordinatorSignalPort;
  readonly state?: CoordinatorProcessStatePort;
  readonly now?: () => number;
}

export interface KiteCoordinatorServer extends AsyncDisposable {
  readonly phase: KiteCoordinatorPhase;
  readonly descriptor: CoordinatorProcessDescriptor | undefined;
  readonly instanceLock: CoordinatorProcessLockLease | undefined;
  start(): Promise<KiteCoordinatorLifecycleResult>;
  stop(): Promise<KiteCoordinatorLifecycleResult>;
  waitForShutdown(): Promise<KiteCoordinatorLifecycleResult>;
}

export interface KiteCoordinatorComposition extends AsyncDisposable {
  readonly server: KiteCoordinatorServer;
  readonly state: CoordinatorProcessStatePort;
  readonly registry: CoordinatorRegistry;
  readonly catalog: CoordinatorCatalog | undefined;
  readonly controlPlane: CoordinatorControlPlane | undefined;
  readonly dispatcher: CoordinatorDispatcher | undefined;
  readonly carrier: CoordinatorCarrier | undefined;
}
