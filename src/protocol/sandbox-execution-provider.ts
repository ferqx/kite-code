/** Protocol-first contract for the governed sandbox preparation seam (ADR-0111). */

export const SANDBOX_EXECUTION_PROVIDER_SCHEMA_V1 = 'kite.sandbox-execution-provider.v1' as const;

export type SandboxExecutionBackendV1 =
  | 'seatbelt'
  | 'bubblewrap'
  | 'windows_restricted_token'
  | 'none';

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

export type SandboxPreparationResourceSemanticsV1 = 'pure' | 'allocating';

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

export interface SandboxPreparationArtifactRefV1 {
  readonly artifactId: string;
  readonly kind: 'sandbox_preparation';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

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
