import type {
  SubagentHandleArtifactRefV1 as RuntimeContractSubagentHandleArtifactRefV1,
  SubagentTaskArtifactV1 as RuntimeContractSubagentTaskArtifactV1,
} from '@kite/runtime-contract';
import type { JsonObject } from './subagent';

/** JSON-safe authority context values crossing the private Subagent SPI. */
export type SubagentAgentPhaseV1 = 'planning' | 'building';
export type SubagentInteractionModeV1 = 'accept_edits' | 'auto' | 'full';
export type SubagentRoleV1 = 'explore' | 'plan' | 'code' | 'review';
export type SubagentWorkspaceAccessV1 = 'write';

/** Protocol-first contract for the governed child lifecycle seam (ADR-0111). */
export const SUBAGENT_PROVIDER_SCHEMA_V1 = 'kite.subagent-provider.v1' as const;

/** SPI-facing alias for the neutral Runtime Contract task artifact identity. */
export type SubagentTaskArtifactV1 = RuntimeContractSubagentTaskArtifactV1;

export interface SubagentTaskRequestArtifactV1 {
  readonly artifactId: string;
  readonly kind: 'subagent_task_request';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

/** SPI-facing alias for the neutral Runtime Contract handle artifact identity. */
export type SubagentHandleArtifactRefV1 = RuntimeContractSubagentHandleArtifactRefV1;

export interface SubagentCapabilityCeilingV1 {
  readonly allowedTools: readonly string[];
  readonly bindingIds: readonly string[];
  readonly bindingRevision: string;
  readonly ceilingDigest: string;
}

export interface SubagentAuthorizationContextV1 {
  readonly authorizationDigest: string;
  readonly interactionMode: SubagentInteractionModeV1;
  readonly phase: SubagentAgentPhaseV1;
  readonly workspaceAccess: SubagentWorkspaceAccessV1;
}

export interface SubagentExecutionBoundaryV1 {
  readonly canonicalWorkspace: string;
  readonly executionBoundaryDigest: string;
}

export interface SubagentResourceContextV1 {
  readonly parentReservationId: string | null;
  readonly budgetDigest: string;
}

export interface SubagentModelContextV1 {
  readonly parentModelInvocationId: string;
  readonly parentToolCallId: string;
}

export interface SubagentGrantBindingV1 {
  readonly parentInvocationId: string;
  readonly parentToolCallId: string;
  readonly parentAttempt: number;
  readonly capabilityRevision: string;
  readonly admissionDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly childInvocationId: string;
  readonly role: SubagentRoleV1;
  readonly taskArtifact: SubagentTaskArtifactV1;
  readonly taskDigest: string;
  readonly capabilityCeiling: SubagentCapabilityCeilingV1;
  readonly authorization: SubagentAuthorizationContextV1;
  readonly executionBoundary: SubagentExecutionBoundaryV1;
  readonly resource: SubagentResourceContextV1;
  readonly cancellationCorrelation: string;
  readonly model: SubagentModelContextV1;
}

interface SubagentGrantBaseV1 extends SubagentGrantBindingV1 {
  readonly schema: typeof SUBAGENT_PROVIDER_SCHEMA_V1;
  readonly grantId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly seal: string;
}

export interface SubagentDelegationGrantV1 extends SubagentGrantBaseV1 {
  readonly purpose: 'start';
}

export interface SubagentResumeGrantV1 extends SubagentGrantBaseV1 {
  readonly purpose: 'resume';
  readonly continuationId: string;
  readonly continuationDigest: string;
  readonly blockedToolCallId: string;
  readonly blockedRuntimeToolCallId: string;
  readonly resumeAttempt: number;
}

export interface SubagentHandleV1 {
  readonly schema: typeof SUBAGENT_PROVIDER_SCHEMA_V1;
  readonly handleId: string;
  readonly grantId: string;
  readonly purpose: 'start' | 'resume';
  readonly childInvocationId: string;
  readonly parentInvocationId: string;
  readonly parentToolCallId: string;
  readonly parentAttempt: number;
  readonly role: SubagentRoleV1;
  readonly taskArtifact: SubagentTaskArtifactV1;
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

export interface SubagentObservationV1 {
  readonly schema: typeof SUBAGENT_PROVIDER_SCHEMA_V1;
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

export type SubagentProviderFailureCodeV1 =
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

export interface SubagentProviderFailureV1 {
  readonly code: SubagentProviderFailureCodeV1;
  readonly message: string;
}

export type SubagentProviderResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: SubagentProviderFailureV1 };

export interface SubagentProviderV1 {
  start(input: {
    readonly grant: SubagentDelegationGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<SubagentProviderResultV1<SubagentHandleV1>>;
  resume(input: {
    readonly grant: SubagentResumeGrantV1;
    readonly signal?: AbortSignal;
  }): Promise<SubagentProviderResultV1<SubagentHandleV1>>;
  /** Consume a durably acknowledged prepared handle and only then enter the Driver. */
  activate(input: {
    readonly handle: SubagentHandleV1;
    readonly signal?: AbortSignal;
  }): Promise<SubagentProviderResultV1<{ readonly activated: true }>>;
  observe(input: {
    readonly handle: SubagentHandleV1;
    readonly signal?: AbortSignal;
  }): Promise<SubagentProviderResultV1<SubagentObservationV1>>;
  cancel(input: {
    readonly handle: SubagentHandleV1;
    readonly reason: string;
  }): Promise<SubagentProviderResultV1<{ readonly cancelled: true }>>;
  reconcile(input: { readonly handle: SubagentHandleV1 }): Promise<
    SubagentProviderResultV1<{
      readonly status: 'running' | 'stopped';
      readonly cleanupConfirmed: boolean;
    }>
  >;
}
