/** Protocol-first contract for the governed sandbox preparation seam (ADR-0111). */

import type {
  SandboxExecutionBackendV1 as RuntimeContractSandboxExecutionBackendV1,
  SandboxPreparationArtifactRefV1 as RuntimeContractSandboxPreparationArtifactRefV1,
  SandboxPreparationResourceSemanticsV1 as RuntimeContractSandboxPreparationResourceSemanticsV1,
} from '@kite/runtime-contract';

export const SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1 = 'kite.sandbox-execution-provider.v1' as const;

/** SPI-facing alias for the neutral Runtime Contract backend fact. */
export type SandboxExecutionBackendV1 = RuntimeContractSandboxExecutionBackendV1;

export type SandboxBoundaryEnforcementV1 = 'enforced' | 'unsupported';

/** Provider-returned, release-comparable backend evidence. */
export interface ExecutionBackendCapabilitiesV1 {
  readonly backend: SandboxExecutionBackendV1;
  readonly filesystem: Readonly<
    Record<'read_only' | 'workspace_write' | 'full_access', SandboxBoundaryEnforcementV1>
  >;
  readonly network: Readonly<Record<'off' | 'allowlist', SandboxBoundaryEnforcementV1>>;
  readonly syscallFilter: SandboxBoundaryEnforcementV1;
  readonly processTreeLimit: SandboxBoundaryEnforcementV1;
  readonly childProcessInheritance: SandboxBoundaryEnforcementV1;
  readonly verifiedInProcessReadOnly: SandboxBoundaryEnforcementV1;
}

/** SPI-facing alias for the neutral Runtime Contract resource fact. */
export type SandboxPreparationResourceSemanticsV1 =
  RuntimeContractSandboxPreparationResourceSemanticsV1;

export interface SandboxResourceLimitsV1 {
  readonly cpuTime: number;
  readonly virtualMemory: number;
  readonly fileSize: number;
  readonly fileDescriptors: number;
  readonly processes: number;
  readonly maxProcessTreeTasks: number | null;
}

/** Frozen facts selected by Policy/approval before the Provider is entered. */
export interface SandboxPreparationV1 {
  readonly schema: typeof SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1;
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
  readonly resourceLimits: SandboxResourceLimitsV1;
  readonly timeoutMs: number;
  readonly cancellationCorrelation: string;
}

/** Exact command authority; descriptions or shell strings cannot replace this identity. */
export interface ApprovedShellCommandV1 {
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

export interface SandboxPreparationGrantV1 {
  readonly schema: typeof SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1;
  readonly purpose: 'prepare';
  readonly preparation: SandboxPreparationV1;
  readonly approvedCommand: ApprovedShellCommandV1;
  readonly preparationDigest: string;
  readonly resourceSemantics: SandboxPreparationResourceSemanticsV1;
  /** Required only for allocating preparation and issued after durable intent ack. */
  readonly preparationIntentDigest: string | null;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly seal: string;
}

export interface SandboxCleanupGrantV1 {
  readonly schema: typeof SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1;
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
export type SandboxPreparationArtifactRefV1 = RuntimeContractSandboxPreparationArtifactRefV1;

export interface SandboxCleanupHandleV1 {
  readonly kind: 'none' | 'runtime_directory' | 'windows_restricted_token';
  readonly resourceId: string;
  readonly recoveryPayload: Readonly<Record<string, string | number | boolean | null>>;
}

/** Data-first plan. It deliberately has no execute/spawn method. */
export interface PreparedSandboxExecutionV1 {
  readonly schema: typeof SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1;
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
  readonly backend: SandboxExecutionBackendV1;
  readonly backendCapabilities: ExecutionBackendCapabilitiesV1;
  readonly enforcement: 'full' | 'partial';
  readonly resourceSemantics: SandboxPreparationResourceSemanticsV1;
  readonly expiresAtMs: number;
  readonly cleanup: SandboxCleanupHandleV1;
}

/**
 * Durable sandbox lifecycle stages. Implementations own persistence and
 * authenticity; the SPI only carries the exact preparation objects and typed
 * acknowledgements between those owners.
 */
export type SandboxPreparationLifecycleStageV1 =
  | 'preparation_intent'
  | 'preparation_ready'
  | 'execution_dispatch_intent'
  | 'execution_supervisor_started'
  | 'disposal_intent'
  | 'disposal_receipt';

export interface SandboxPreparationIntentAcknowledgementV1 {
  readonly acknowledged: true;
  readonly stage: 'preparation_intent';
  readonly intentDigest: string;
}

export interface SandboxPreparationReadyAcknowledgementV1 {
  readonly acknowledged: true;
  readonly stage: 'preparation_ready';
  readonly readyDigest: string;
  readonly preparationArtifact: Readonly<SandboxPreparationArtifactRefV1>;
}

export interface SandboxExecutionDispatchIntentAcknowledgementV1 {
  readonly acknowledged: true;
  readonly stage: 'execution_dispatch_intent';
  readonly dispatchId: string;
  readonly supervisorNonce: string;
  readonly dispatchIntentDigest: string;
}

export interface SandboxExecutionSupervisorStartedAcknowledgementV1 {
  readonly acknowledged: true;
  readonly stage: 'execution_supervisor_started';
  readonly dispatchId: string;
  readonly dispatchIntentDigest: string;
  readonly supervisorPid: number;
  readonly processGroupId: number;
  readonly processStartIdentity: string;
}

export type SandboxDisposalPurposeV1 = 'dispose' | 'reconcile_preparation_intent';

export interface SandboxDisposalIntentAcknowledgementV1 {
  readonly acknowledged: true;
  readonly stage: 'disposal_intent';
  readonly purpose: SandboxDisposalPurposeV1;
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
}

export interface SandboxDisposalReceiptAcknowledgementV1 {
  readonly acknowledged: true;
  readonly stage: 'disposal_receipt';
  readonly purpose: SandboxDisposalPurposeV1;
  readonly lifecycleIntentDigest: string;
  readonly cleanupAttempt: number;
  readonly disposed: boolean;
}

/**
 * Persistence-facing lifecycle for one exact preparation/prepared plan.
 * Rejection or unavailable persistence rejects the Promise; a bare boolean is
 * deliberately not an acknowledgement.
 */
export interface SandboxPreparationLifecycleV1 {
  recordPreparationIntent(
    preparation: Readonly<SandboxPreparationV1>,
  ): Promise<Readonly<SandboxPreparationIntentAcknowledgementV1>>;
  recordPreparationReady(
    prepared: Readonly<PreparedSandboxExecutionV1>,
  ): Promise<Readonly<SandboxPreparationReadyAcknowledgementV1>>;
  recordExecutionDispatchIntent(
    prepared: Readonly<PreparedSandboxExecutionV1>,
    input: {
      readonly dispatchId: string;
      readonly supervisorNonce: string;
    },
  ): Promise<Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>>;
  recordExecutionSupervisorStarted(
    prepared: Readonly<PreparedSandboxExecutionV1>,
    input: {
      readonly dispatchId: string;
      readonly dispatchIntentDigest: string;
      readonly supervisorPid: number;
      readonly processGroupId: number;
      readonly processStartIdentity: string;
    },
  ): Promise<Readonly<SandboxExecutionSupervisorStartedAcknowledgementV1>>;
  recordDisposalIntent(
    prepared: Readonly<PreparedSandboxExecutionV1> | null,
  ): Promise<Readonly<SandboxDisposalIntentAcknowledgementV1>>;
  recordDisposalReceipt(input: {
    readonly prepared: Readonly<PreparedSandboxExecutionV1> | null;
    readonly purpose: SandboxDisposalPurposeV1;
    readonly lifecycleIntentDigest: string;
    readonly cleanupAttempt: number;
    readonly disposed: boolean;
  }): Promise<Readonly<SandboxDisposalReceiptAcknowledgementV1>>;
}

/**
 * Neutral artifact transport for the exact prepared plan. It does not expose
 * a Store, event, codec, or integrity implementation.
 */
export interface SandboxPreparationArtifactPortV1 {
  write(prepared: Readonly<PreparedSandboxExecutionV1>): Readonly<SandboxPreparationArtifactRefV1>;
  read(reference: Readonly<SandboxPreparationArtifactRefV1>): Readonly<PreparedSandboxExecutionV1>;
}

export interface SandboxPreparedProcessCleanupV1 {
  readonly confirmedExited: boolean;
  readonly gracefulRequested: boolean;
  readonly forced: boolean;
  readonly unconfirmedDescendantCount: number;
}

export type SandboxPreparedProcessFailureCodeV1 =
  | 'invalid_prepared_execution'
  | 'dispatch_not_acknowledged'
  | 'supervisor_start_not_acknowledged'
  | 'spawn_failed'
  | 'transport_failed'
  | 'process_failed';

export interface SandboxPreparedProcessFailureV1 {
  readonly code: SandboxPreparedProcessFailureCodeV1;
  readonly message: string;
}

export type SandboxPreparedProcessUnknownCodeV1 =
  | 'post_go_terminal_unknown'
  | 'post_go_transport_lost'
  | 'post_go_cleanup_unknown';

export interface SandboxPreparedProcessUnknownV1 {
  readonly code: SandboxPreparedProcessUnknownCodeV1;
  readonly message: string;
}

export interface SandboxPreparedProcessCompletedResultV1 {
  readonly kind: 'completed';
  readonly executionPhase: 'go_started';
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanupV1>;
}

export interface SandboxPreparedProcessTerminatedResultV1 {
  readonly kind: 'terminated';
  readonly executionPhase: 'go_started';
  readonly terminationReason: 'timed_out' | 'cancelled';
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanupV1>;
}

export interface SandboxPreparedProcessFailedResultV1 {
  readonly kind: 'failed';
  readonly executionPhase: 'not_started' | 'supervisor_started_before_go';
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly failure: Readonly<SandboxPreparedProcessFailureV1>;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanupV1>;
}

/** A post-GO unknown is terminally distinct and is never retry-safe. */
export interface SandboxPreparedProcessUnknownResultV1 {
  readonly kind: 'unknown';
  readonly executionPhase: 'unknown_after_go';
  readonly exitCode: null;
  readonly stdout: string;
  readonly stderr: string;
  readonly unknown: Readonly<SandboxPreparedProcessUnknownV1>;
  readonly retryable: false;
  readonly processCleanup: Readonly<SandboxPreparedProcessCleanupV1>;
}

/** JSON-safe process terminal facts returned across the neutral Host seam. */
export type SandboxPreparedProcessExecutionResultV1 =
  | SandboxPreparedProcessCompletedResultV1
  | SandboxPreparedProcessTerminatedResultV1
  | SandboxPreparedProcessFailedResultV1
  | SandboxPreparedProcessUnknownResultV1;

export interface SandboxPreparedProcessExecutionPortV1 {
  execute(input: {
    /** Exact prepared object already acknowledged by the lifecycle owner. */
    readonly prepared: Readonly<PreparedSandboxExecutionV1>;
    readonly dispatchIntent: Readonly<SandboxExecutionDispatchIntentAcknowledgementV1>;
    readonly lifecycle: SandboxPreparationLifecycleV1;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
    readonly onProgress?: (chunk: string, stream: 'stdout' | 'stderr') => void;
    /** Caller-owned ephemeral facts; never part of the prepared artifact. */
    readonly ephemeralEnvironment?: Readonly<Record<string, string>>;
  }): Promise<Readonly<SandboxPreparedProcessExecutionResultV1>>;
}

export type SandboxExecutionProviderFailureCodeV1 =
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

export interface SandboxExecutionProviderFailureV1 {
  readonly code: SandboxExecutionProviderFailureCodeV1;
  readonly message: string;
}

export type SandboxExecutionProviderResultV1<Observation> =
  | { readonly ok: true; readonly observation: Observation }
  | { readonly ok: false; readonly failure: SandboxExecutionProviderFailureV1 };

export interface SandboxExecutionProviderV1 {
  readonly resourceSemantics: SandboxPreparationResourceSemanticsV1;
  prepare(input: {
    readonly grant: SandboxPreparationGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResultV1<PreparedSandboxExecutionV1>>;
  dispose(input: {
    readonly grant: SandboxCleanupGrantV1;
    readonly prepared: PreparedSandboxExecutionV1;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResultV1<{ readonly disposed: true }>>;
  /** Crash recovery consumes only durable artifact data, never a lost in-memory handle. */
  reconcile(input: {
    readonly grant: SandboxCleanupGrantV1;
    readonly prepared: PreparedSandboxExecutionV1;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResultV1<{ readonly disposed: true }>>;
  /** Reclaims a deterministic allocation when the host crashed before ready publication. */
  reconcilePreparationIntent(input: {
    readonly grant: SandboxCleanupGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<SandboxExecutionProviderResultV1<{ readonly disposed: true }>>;
}
