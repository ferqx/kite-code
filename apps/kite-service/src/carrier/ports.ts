import type { KiteAppControlClient, KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import type {
  WorkerControllerAbandonDetachedRequest,
  WorkerControllerCreateSessionRequest,
  WorkerControllerCreateSessionResponse,
  WorkerControllerDetachRequest,
  WorkerControllerIssueResumeCapabilityRequest,
  WorkerControllerMintDetachedRecoveryRequest,
  WorkerControllerOperationResponse,
  WorkerControllerReadRequest,
  WorkerControllerReadResponse,
  WorkerControllerReleaseControlRequest,
  WorkerControllerRequestControlRequest,
  WorkerControllerResumeCapabilityResponse,
  WorkerControllerResumeRequest,
  WorkerControllerValidateResumeRequest,
} from '@kite-ai/kite-app-contract/worker-controller';
import type {
  NativeProviderCredentialRequest,
  NativeProviderCredentialResult,
} from '@kite-ai/kite-local-runtime/client';
import type { RuntimeHistoryClient } from '@kite-ai/runtime-client';
import type { RuntimeServer, RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';

/**
 * The carrier never canonicalizes a workspace itself.  The injected service
 * owner performs realpath/trust/project identity validation before returning
 * this result, so a request path is never used as a Runtime authority.
 */
export type ServiceWorkspaceAdmissionResult =
  | Readonly<{ outcome: 'admitted'; workspace: KiteWorkspaceIdentity }>
  | Readonly<{ outcome: 'untrusted' | 'unavailable' }>;

export interface ServiceWorkspaceAdmissionPort {
  admitForConnect(requestedWorkspace: string): Promise<ServiceWorkspaceAdmissionResult>;
  /** Re-canonicalize a body identity for App Control; the body is not authority. */
  resolveIdentity(candidate: KiteWorkspaceIdentity): Promise<KiteWorkspaceIdentity | undefined>;
}

/**
 * RuntimeServer gets an App-owned admission port per connection.  The
 * connection id is supplied by RuntimeServer and is intentionally kept out
 * of every wire DTO.
 */
export interface ServiceRuntimeAdmissionPortFactory {
  create(
    workspace: KiteWorkspaceIdentity,
    connectionId: string,
    connectionKind?: 'native_client' | 'web_observer',
    binding?: ServiceRuntimeConnectionBinding,
  ): RuntimeServerAdmissionPort;
}

/** Native connection facts extracted from an authenticated Worker capability/ticket. */
export interface ServiceRuntimeConnectionBinding {
  readonly clientId: string;
  readonly connectionGeneration: number;
  readonly workerInstanceId: string;
  /** Untrusted request path; the Service re-runs canonical Workspace admission before use. */
  readonly requestedWorkspace?: string;
  /** Session selected by the native Controller binding headers, if any. */
  readonly controllerSessionId?: string;
  /** Generation observed when the one-shot connection ticket was minted. */
  readonly controllerGeneration?: number;
}

/** Explicit native-only Controller surface; no generic operation dispatcher is exposed. */
export interface ServiceControllerPort {
  createSession(
    request: WorkerControllerCreateSessionRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerCreateSessionResponse>;
  read(
    request: WorkerControllerReadRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerReadResponse>;
  requestControl(
    request: WorkerControllerRequestControlRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerOperationResponse>;
  releaseControl(
    request: WorkerControllerReleaseControlRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerOperationResponse>;
  detach(
    request: WorkerControllerDetachRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerOperationResponse>;
  issueResumeCapability(
    request: WorkerControllerIssueResumeCapabilityRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerOperationResponse>;
  resume(
    request: WorkerControllerResumeRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerOperationResponse>;
  mintDetachedRecoveryCapability(
    request: WorkerControllerMintDetachedRecoveryRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerOperationResponse>;
  abandonDetachedController(
    request: WorkerControllerAbandonDetachedRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerOperationResponse>;
  validateResumeCapability(
    request: WorkerControllerValidateResumeRequest,
    binding: ServiceRuntimeConnectionBinding,
  ): Promise<WorkerControllerResumeCapabilityResponse>;
}

/** Closed App Control surface selected after canonical Workspace admission. */
export interface ServiceAppControlPort {
  readonly discovery: KiteAppControlClient;
  forWorkspace(workspace: KiteWorkspaceIdentity): KiteAppControlClient;
}

/** Native secret route.  No result type contains the submitted secret. */
export interface ServiceCredentialPort {
  writeProviderCredential(
    request: NativeProviderCredentialRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<NativeProviderCredentialResult>;
}

export type ServiceStopOutcome = 'applied' | 'service_busy' | 'unavailable';

export interface ServiceStopResult {
  readonly outcome: ServiceStopOutcome;
  readonly state: 'absent' | 'starting' | 'ready' | 'quiescing' | 'draining';
}

export interface ServiceControlPort {
  stop(): Promise<ServiceStopResult>;
}

/**
 * Narrow injected application boundary for the carrier.  KLSV1-04 supplies
 * fake applications in process tests; the concrete Host/Store application is
 * relocated only in KLSV1-06.
 */
export interface KiteServiceApplicationPort {
  readonly server: RuntimeServer;
  readonly history: RuntimeHistoryClient;
  readonly workspaceAdmission: ServiceWorkspaceAdmissionPort;
  readonly runtimeAdmission: ServiceRuntimeAdmissionPortFactory;
  readonly appControl: ServiceAppControlPort;
  readonly credential?: ServiceCredentialPort;
  /** Native-only Controller routes; never part of the Web Observer contract. */
  readonly controller?: ServiceControllerPort;
  readonly control?: ServiceControlPort;
  readonly onConnectionBound?: (connectionId: string, workspace: KiteWorkspaceIdentity) => void;
  readonly onConnectionClosed?: (
    connectionId: string,
    binding?: ServiceRuntimeConnectionBinding,
  ) => void;
}
