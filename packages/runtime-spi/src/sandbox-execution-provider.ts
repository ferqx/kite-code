/** Protocol-first contract for the governed sandbox preparation seam (ADR-0111). */

import type {
  SandboxExecutionBackend as RuntimeContractSandboxExecutionBackend,
  SandboxPreparationArtifactRef as RuntimeContractSandboxPreparationArtifactRef,
  SandboxPreparationResourceSemantics as RuntimeContractSandboxPreparationResourceSemantics,
} from '@kite/runtime-contract';

export const SANDBOX_EXECUTION_PROVIDER_SCHEMA_ = 'kite.sandbox-execution-provider.v1' as const;

/** SPI-facing alias for the neutral Runtime Contract backend fact. */
export type SandboxExecutionBackend = RuntimeContractSandboxExecutionBackend;

export type SandboxBoundaryEnforcement = 'enforced' | 'unsupported';

/** Provider-returned, release-comparable backend evidence. */
export interface ExecutionBackendCapabilities {
  readonly backend: SandboxExecutionBackend;
  readonly filesystem: Readonly<
    Record<'read_only' | 'workspace_write' | 'full_access', SandboxBoundaryEnforcement>
  >;
  readonly network: Readonly<Record<'off' | 'allowlist', SandboxBoundaryEnforcement>>;
  readonly syscallFilter: SandboxBoundaryEnforcement;
  readonly processTreeLimit: SandboxBoundaryEnforcement;
  readonly childProcessInheritance: SandboxBoundaryEnforcement;
  readonly verifiedInProcessReadOnly: SandboxBoundaryEnforcement;
}

/** SPI-facing alias for the neutral Runtime Contract resource fact. */
export type SandboxPreparationResourceSemantics =
  RuntimeContractSandboxPreparationResourceSemantics;

export interface SandboxResourceLimits {
  readonly cpuTime: number;
  readonly virtualMemory: number;
  readonly fileSize: number;
  readonly fileDescriptors: number;
  readonly processes: number;
  readonly maxProcessTreeTasks: number | null;
}

/** Frozen facts selected by Policy/approval before the Provider is entered. */
export interface SandboxPreparation {
  readonly schema: typeof SANDBOX_EXECUTION_PROVIDER_SCHEMA_;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly invocationId: string;
  readonly attempt: number;
  readonly effectiveEffectsDigest: string;
  readonly admissionDigest: string;
  readonly canonicalWorkspace: string;
  readonly argv: readonly string[];
  readonly commandDigest: string;
  readonly executionBoundaryDigest: string;
  readonly protectedPathRevision: string;
  readonly filesystemMode: 'workspace_only' | 'allow_all';
  readonly networkMode: 'disabled' | 'allow_all';
  readonly executionTrust: 'policy_proven_read_only' | null;
  readonly resourceLimits: SandboxResourceLimits;
  readonly timeoutMs: number;
  readonly cancellationCorrelation: string;
}

/** Exact command authority; descriptions or shell strings cannot replace this identity. */
export interface ApprovedShellCommand {
  readonly schema: 'kite.approved-shell-command.v1';
  readonly invocationId: string;
  readonly attempt: number;
  readonly argv: readonly string[];
  readonly commandDigest: string;
  readonly grantId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly seal: string;
}

export interface SandboxPreparationGrant {
  readonly schema: typeof SANDBOX_EXECUTION_PROVIDER_SCHEMA_;
  readonly purpose: 'prepare';
  readonly preparation: SandboxPreparation;
  readonly approvedCommand: ApprovedShellCommand;
  readonly preparationDigest: string;
  readonly resourceSemantics: SandboxPreparationResourceSemantics;
  /** Required only for allocating preparation and issued after durable intent ack. */
  readonly preparationIntentDigest: string | null;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly seal: string;
}

export interface SandboxCleanupGrant {
  readonly schema: typeof SANDBOX_EXECUTION_PROVIDER_SCHEMA_;
  readonly purpose: 'dispose' | 'reconcile' | 'reconcile_preparation_intent';
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly invocationId: string;
  readonly attempt: number;
  readonly canonicalWorkspace: string;
  readonly effectiveEffectsDigest: string;
  readonly admissionDigest: string;
  readonly preparationDigest: string;
  readonly preparedPlanDigest: string | null;
  readonly cleanupDigest: string | null;
  readonly lifecycleIntentDigest: string;
  readonly cleanupGrantId: string;
  readonly cleanupAttempt: number;
  readonly cleanupConfirmed: boolean;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly seal: string;
}

/** SPI-facing alias for the neutral Runtime Contract artifact identity. */
export type SandboxPreparationArtifactRef = RuntimeContractSandboxPreparationArtifactRef;

export interface SandboxCleanupHandle {
  readonly kind: 'none' | 'runtime_directory' | 'windows_restricted_token';
  readonly resourceId: string;
  readonly recoveryPayload: Readonly<Record<string, string | number | boolean | null>>;
}

/** Data-first plan. It deliberately has no execute/spawn method. */
export interface PreparedSandboxExecution {
  readonly schema: typeof SANDBOX_EXECUTION_PROVIDER_SCHEMA_;
  readonly kind: 'prepared_sandbox_execution';
  readonly planId: string;
  readonly toolCallId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly invocationId: string;
  readonly attempt: number;
  readonly canonicalWorkspace: string;
  readonly effectiveEffectsDigest: string;
  readonly admissionDigest: string;
  readonly preparationDigest: string;
  readonly commandDigest: string;
  readonly approvedArgv: readonly string[];
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>> | null;
  readonly stdin: string | null;
  readonly transport: 'stdio' | 'windows_restricted_token_v1';
  readonly backend: SandboxExecutionBackend;
  readonly backendCapabilities: ExecutionBackendCapabilities;
  readonly enforcement: 'full' | 'partial';
  readonly resourceSemantics: SandboxPreparationResourceSemantics;
  readonly expiresAtMs: number;
  readonly cleanup: SandboxCleanupHandle;
}

/**
 * Durable sandbox lifecycle stages. Implementations own persistence and
 * authenticity; the SPI only carries the exact preparation objects and typed
 * acknowledgements between those owners.
 */
export type SandboxPreparationLifecycleStage =
  | 'preparation_intent'
  | 'preparation_ready'
  | 'execution_dispatch_intent'
  | 'execution_supervisor_started'
  | 'disposal_intent'
  | 'disposal_receipt';

export interface SandboxPreparationIntentAcknowledgement {
  readonly acknowledged: true;
  readonly stage: 'preparation_intent';
  readonly intentDigest: string;
}

export interface SandboxPreparationReadyAcknowledgement {
  readonly acknowledged: true;
  readonly stage: 'preparation_ready';
  readonly readyDigest: string;
  readonly preparationArtifact: Readonly<SandboxPreparationArtifactRef>;
}

export interface SandboxExecutionDispatchIntentAcknowledgement {
  readonly acknowledged: true;
  readonly stage: 'execution_dispatch_intent';
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
}

export interface SandboxExecutionSupervisorStartedAcknowledgement {
  readonly acknowledged: true;
  readonly stage: 'execution_supervisor_started';
  readonly dispatchId: string;
  readonly dispatchIntentDigest: string;
  readonly supervisorPid: number;
  readonly processGroupId: number;
  readonly processStartIdentity: string;
}

export type SandboxDisposalPurpose = 'dispose' | 'reconcile_preparation_intent';

export interface SandboxDisposalIntentAcknowledgement {
  readonly acknowledged: true;
  readonly stage: 'disposal_intent';
  readonly purpose: SandboxDisposalPurpose;
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
}

export interface SandboxDisposalReceiptAcknowledgement {
  readonly acknowledged: true;
  readonly stage: 'disposal_receipt';
  readonly purpose: SandboxDisposalPurpose;
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
  readonly disposed: boolean;
}

/**
 * Persistence-facing lifecycle for one exact preparation/prepared plan.
 * Rejection or unavailable persistence rejects the Promise; a bare boolean is
 * deliberately not an acknowledgement.
 */
export interface SandboxPreparationLifecycle {
  recordPreparationIntent(
    preparation: Readonly<SandboxPreparation>,
  ): Promise<Readonly<SandboxPreparationIntentAcknowledgement>>;
  recordPreparationReady(
    prepared: Readonly<PreparedSandboxExecution>,
  ): Promise<Readonly<SandboxPreparationReadyAcknowledgement>>;
  recordExecutionDispatchIntent(
    prepared: Readonly<PreparedSandboxExecution>,
    input: {
      readonly dispatchId: string;
      readonly supervisorNonce: string;
    },
  ): Promise<Readonly<SandboxExecutionDispatchIntentAcknowledgement>>;
  recordExecutionSupervisorStarted(
    prepared: Readonly<PreparedSandboxExecution>,
    input: {
      readonly dispatchId: string;
      readonly dispatchIntentDigest: string;
      readonly supervisorPid: number;
      readonly processGroupId: number;
      readonly processStartIdentity: string;
    },
  ): Promise<Readonly<SandboxExecutionSupervisorStartedAcknowledgement>>;
  recordDisposalIntent(
    prepared: Readonly<PreparedSandboxExecution> | null,
  ): Promise<Readonly<SandboxDisposalIntentAcknowledgement>>;
  recordDisposalReceipt(input: {
    readonly prepared: Readonly<PreparedSandboxExecution> | null;
    readonly purpose: SandboxDisposalPurpose;
    readonly lifecycleIntentDigest: string;
    readonly cleanupAttempt: number;
    readonly disposed: boolean;
  }): Promise<Readonly<SandboxDisposalReceiptAcknowledgement>>;
}

/**
 * Neutral artifact transport for the exact prepared plan. It does not expose
 * a Store, event, codec, or integrity implementation.
 */
export interface SandboxPreparationArtifactPort {
  write(prepared: Readonly<PreparedSandboxExecution>): Readonly<SandboxPreparationArtifactRef>;
  read(reference: Readonly<SandboxPreparationArtifactRef>): Readonly<PreparedSandboxExecution>;
}

export interface SandboxPreparedProcessCleanup {
  readonly confirmedExited: boolean;
  readonly gracefulRequested: boolean;
  readonly forced: boolean;
  readonly unconfirmedDescendantCount: number;
}

export type SandboxPreparedProcessFailureCode =
  | 'invalid_prepared_execution'
  | 'dispatch_not_acknowledged'
  | 'supervisor_start_not_acknowledged'
  | 'spawn_failed'
  | 'transport_failed'
  | 'process_failed';

export interface SandboxPreparedProcessFailure {
  readonly code: SandboxPreparedProcessFailureCode;
  readonly message: string;
}

export type SandboxPreparedProcessUnknownCode =
  | 'post_go_terminal_unknown'
  | 'post_go_transport_lost'
  | 'post_go_cleanup_unknown';

export interface SandboxPreparedProcessUnknown {
  readonly code: SandboxPreparedProcessUnknownCode;
  readonly message: string;
}

export interface SandboxPreparedProcessCompletedResult {
  readonly kind: 'completed';
  readonly executionPhase: 'go_started';
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanup>;
}

export interface SandboxPreparedProcessTerminatedResult {
  readonly kind: 'terminated';
  readonly executionPhase: 'go_started';
  readonly terminationReason: 'timed_out' | 'cancelled';
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanup>;
}

export interface SandboxPreparedProcessFailedResult {
  readonly kind: 'failed';
  readonly executionPhase: 'not_started' | 'supervisor_started_before_go';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure: Readonly<SandboxPreparedProcessFailure>;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanup>;
}

/** A post-GO unknown is terminally distinct and is never retry-safe. */
export interface SandboxPreparedProcessUnknownResult {
  readonly kind: 'unknown';
  readonly executionPhase: 'unknown_after_go';
  readonly exitCode: null;
  readonly stdout: string;
  readonly stderr: string;
  readonly unknown: Readonly<SandboxPreparedProcessUnknown>;
  readonly retryable: false;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanup>;
}

/** JSON-safe process terminal facts returned across the neutral Host seam. */
export type SandboxPreparedProcessExecutionResult =
  | SandboxPreparedProcessCompletedResult
  | SandboxPreparedProcessTerminatedResult
  | SandboxPreparedProcessFailedResult
  | SandboxPreparedProcessUnknownResult;

export interface SandboxPreparedProcessExecutionPort {
  execute(input: {
    /** Exact prepared object already acknowledged by the lifecycle owner. */
    readonly prepared: Readonly<PreparedSandboxExecution>;
    readonly dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgement>;
    readonly lifecycle: SandboxPreparationLifecycle;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
    /** Caller-owned ephemeral facts; never part of the prepared artifact. */
    readonly ephemeralEnvironment?: Readonly<Record<string, string>>;
  }): Promise<Readonly<SandboxPreparedProcessExecutionResult>>;
}

export type SandboxExecutionProviderFailureCode =
  | 'invalid_grant'
  | 'expired_grant'
  | 'cancelled'
  | 'command_denied'
  | 'backend_unavailable'
  | 'runner_failed'
  | 'preparation_failed'
  | 'dispose_failed'
  | 'fake_denied'
  | 'fake_crashed';

export interface SandboxExecutionProviderFailure {
  readonly code: SandboxExecutionProviderFailureCode;
  readonly message: string;
}

export type SandboxExecutionProviderResult<Observation> =
  | { readonly ok: true; readonly observation: Observation }
  | { readonly ok: false; readonly failure: SandboxExecutionProviderFailure };

export interface SandboxExecutionProvider {
  readonly resourceSemantics: SandboxPreparationResourceSemantics;
  prepare(input: {
    readonly grant: SandboxPreparationGrant;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResult<PreparedSandboxExecution>>;
  dispose(input: {
    readonly grant: SandboxCleanupGrant;
    readonly prepared: PreparedSandboxExecution;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResult<{ readonly disposed: true }>>;
  /** Crash recovery consumes only durable artifact data, never a lost in-memory handle. */
  reconcile(input: {
    readonly grant: SandboxCleanupGrant;
    readonly prepared: PreparedSandboxExecution;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResult<{ readonly disposed: true }>>;
  /** Reclaims a deterministic allocation when the host crashed before ready publication. */
  reconcilePreparationIntent(input: {
    readonly grant: SandboxCleanupGrant;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResult<{ readonly disposed: true }>>;
}
