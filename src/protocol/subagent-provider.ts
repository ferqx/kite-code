import type { AgentPhase, InteractionMode, SubAgentRole, WorkspaceAccess } from './events';
import type { JsonObject } from './subagent';

/** Protocol-first contract for the governed child lifecycle seam (ADR-0111). */
export const SUBAGENT_PROVIDER_SCHEMA_V1 = 'kite.subagent-provider.v1' as const;

export interface SubagentTaskArtifactV1 {
  readonly artifactId: string;
  readonly kind: 'subagent_task';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

export interface SubagentTaskRequestArtifactV1 {
  readonly artifactId: string;
  readonly kind: 'subagent_task_request';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

export interface SubagentHandleArtifactRefV1 {
  readonly artifactId: string;
  readonly kind: 'subagent_handle';
  readonly integrityIdentifier: string;
  readonly byteLength: number;
}

export interface SubagentCapabilityCeilingV1 {
  readonly allowedTools: readonly string[];
  readonly bindingIds: readonly string[];
  readonly bindingRevision: string;
  readonly ceilingDigest: string;
}

export interface SubagentAuthorizationContextV1 {
  readonly authorizationDigest: string;
  readonly interactionMode: InteractionMode;
  readonly phase: AgentPhase;
  readonly workspaceAccess: WorkspaceAccess;
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
  readonly responseSourceMode: 'live' | 'record' | 'replay';
  readonly replayContextDigest: string;
}

export interface SubagentGrantBindingV1 {
  readonly parentInvocationId: string;
  readonly parentToolCallId: string;
  readonly parentAttempt: number;
  readonly capabilityRevision: string;
  readonly admissionDigest: string;
  readonly effectiveEffectsDigest: string;
  readonly childInvocationId: string;
  readonly role: SubAgentRole;
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
  readonly role: SubAgentRole;
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
