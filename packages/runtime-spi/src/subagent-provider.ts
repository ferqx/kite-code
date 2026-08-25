import type {
  SubagentHandleArtifactRef as RuntimeContractSubagentHandleArtifactRef,
  SubagentTaskArtifact as RuntimeContractSubagentTaskArtifact,
} from '@kite-ai/runtime-contract';
import type { JsonObject } from './subagent';

/** JSON-safe authority context values crossing the private Subagent SPI. */
export type SubagentAgentPhase = 'planning' | 'building';
export type SubagentInteractionMode = 'accept_edits' | 'auto' | 'full';
export type SubagentRole = 'explore' | 'plan' | 'code' | 'review';
export type SubagentWorkspaceAccess = 'write';

/** Protocol-first contract for the governed child lifecycle seam (ADR-0111). */
export const SUBAGENT_PROVIDER_SCHEMA_ = 'kite.subagent-provider.v1' as const;

/** SPI-facing alias for the neutral Runtime Contract task artifact identity. */
export type SubagentTaskArtifact = RuntimeContractSubagentTaskArtifact;

export interface SubagentTaskRequestArtifact {
  readonly artifactId: string;
  readonly kind: 'subagent_task_request';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

/** SPI-facing alias for the neutral Runtime Contract handle artifact identity. */
export type SubagentHandleArtifactRef = RuntimeContractSubagentHandleArtifactRef;

export interface SubagentCapabilityCeiling {
  readonly allowedTools: readonly string[];
  readonly bindingIds: readonly string[];
  readonly bindingRevision: string;
  readonly ceilingDigest: string;
}

export interface SubagentAuthorizationContext {
  readonly authorizationDigest: string;
  readonly interactionMode: SubagentInteractionMode;
  readonly phase: SubagentAgentPhase;
  readonly workspaceAccess: SubagentWorkspaceAccess;
}

export interface SubagentExecutionBoundary {
  readonly canonicalWorkspace: string;
  readonly executionBoundaryDigest: string;
}

export interface SubagentResourceContext {
  readonly parentReservationId: string | null;
  readonly budgetDigest: string;
}

export interface SubagentModelContext {
  readonly parentModelInvocationId: string;
  readonly parentToolCallId: string;
}

export interface SubagentGrantBinding {
  readonly parentInvocationId: string;
  readonly parentToolCallId: string;
  readonly parentAttempt: number;
  readonly capabilityRevision: string;
  readonly admissionDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly childInvocationId: string;
  readonly role: SubagentRole;
  readonly taskArtifact: SubagentTaskArtifact;
  readonly taskDigest: string;
  readonly capabilityCeiling: SubagentCapabilityCeiling;
  readonly authorization: SubagentAuthorizationContext;
  readonly executionBoundary: SubagentExecutionBoundary;
  readonly resource: SubagentResourceContext;
  readonly cancellationCorrelation: string;
  readonly model: SubagentModelContext;
}

interface SubagentGrantBase extends SubagentGrantBinding {
  readonly schema: typeof SUBAGENT_PROVIDER_SCHEMA_;
  readonly grantId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly seal: string;
}

export interface SubagentDelegationGrant extends SubagentGrantBase {
  readonly purpose: 'start';
}

export interface SubagentResumeGrant extends SubagentGrantBase {
  readonly purpose: 'resume';
  readonly continuationId: string;
  readonly continuationDigest: string;
  readonly blockedToolCallId: string;
  readonly blockedRuntimeToolCallId: string;
  readonly resumeAttempt: number;
}

export interface SubagentHandle {
  readonly schema: typeof SUBAGENT_PROVIDER_SCHEMA_;
  readonly handleId: string;
  readonly grantId: string;
  readonly purpose: 'start' | 'resume';
  readonly childInvocationId: string;
  readonly parentInvocationId: string;
  readonly parentToolCallId: string;
  readonly parentAttempt: number;
  readonly role: SubagentRole;
  readonly taskArtifact: SubagentTaskArtifact;
  readonly taskDigest: string;
  readonly continuationId: string | null;
  readonly continuationDigest: string | null;
  readonly blockedToolCallId: string | null;
  readonly blockedRuntimeToolCallId: string | null;
  readonly resumeAttempt: number | null;
  /** Local in-process owner identity used only for bounded restore reconciliation. */
  readonly ownerProcessId: number;
  readonly ownerProcessStartIdentity: string;
  readonly providerInstanceId: string;
  readonly lifecycle: 'running';
  readonly integrityIdentifier: string;
}

export interface SubagentObservation {
  readonly schema: typeof SUBAGENT_PROVIDER_SCHEMA_;
  readonly handleId: string;
  readonly childInvocationId: string;
  readonly status: 'completed' | 'failed' | 'cancelled' | 'exhausted' | 'blocked';
  readonly summary: string;
  readonly toolCallCount: number;
  readonly durationMs: number;
  readonly observationDigest: string;
  /** Parent-Pipeline-only payload. It is never part of the model projection. */
  readonly privatePayload: JsonObject;
}

export type SubagentProviderFailureCode =
  | 'invalid_grant'
  | 'expired_grant'
  | 'consumed_grant'
  | 'cancelled'
  | 'stale_handle'
  | 'driver_crashed'
  | 'observation_too_large'
  | 'fake_denied'
  | 'fake_crashed'
  | 'recovery_required';

export interface SubagentProviderFailure {
  readonly code: SubagentProviderFailureCode;
  readonly message: string;
}

export type SubagentProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: SubagentProviderFailure };

export interface SubagentProvider {
  start(input: {
    readonly grant: SubagentDelegationGrant;
    readonly signal?: AbortSignal;
  }): Promise<SubagentProviderResult<SubagentHandle>>;
  resume(input: {
    readonly grant: SubagentResumeGrant;
    readonly signal?: AbortSignal;
  }): Promise<SubagentProviderResult<SubagentHandle>>;
  /** Consume a durably acknowledged prepared handle and only then enter the Driver. */
  activate(input: {
    readonly handle: SubagentHandle;
    readonly signal?: AbortSignal;
  }): Promise<SubagentProviderResult<{ readonly activated: true }>>;
  observe(input: {
    readonly handle: SubagentHandle;
    readonly signal?: AbortSignal;
  }): Promise<SubagentProviderResult<SubagentObservation>>;
  cancel(input: {
    readonly handle: SubagentHandle;
    readonly reason: string;
  }): Promise<SubagentProviderResult<{ readonly cancelled: true }>>;
  reconcile(input: { readonly handle: SubagentHandle }): Promise<
    SubagentProviderResult<{
      readonly status: 'running' | 'stopped';
      readonly cleanupConfirmed: boolean;
    }>
  >;
}
