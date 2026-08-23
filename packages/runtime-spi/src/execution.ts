import type { RuntimeJsonValue } from './capability';

export interface CapabilityBinding {
  readonly bindingId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly exposedToolName: string;
  readonly schemaDigest: string;
  readonly issuedForTurnId: string;
}

export interface CapabilityDisclosure {
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly issuedForTurnId: string;
}

/** A model request remains an untrusted proposal until Policy authorizes it. */
export interface CapabilityRequestProposal<TInput extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly proposalId: string;
  readonly binding: CapabilityBinding;
  readonly input: TInput;
}

export interface CapabilityIntent {
  readonly intentId: string;
  readonly proposalId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly requestDigest: string;
}

/** RM authorization carrier with exact structural identity. */
export interface CapabilityAuthorizedEffect {
  readonly intent: CapabilityIntent;
  readonly grant: ExecutionGrant;
}

export interface ExecutionRequest<TInput extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly invocationId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly input: TInput;
  /** Frozen non-authority facts projected for this exact request. */
  readonly facts?: RuntimeJsonValue;
}

/** RM transport DTO with exact structural identity. */
export interface ExecutionGrant {
  readonly grantId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly authority: Readonly<Record<string, RuntimeJsonValue>>;
}

export interface ExecutionEnvironmentRef {
  readonly environmentId: string;
  readonly kind: string;
  /**
   * Trusted in-process mechanism handles for this selected environment.
   * They are neither persisted authority nor another Runtime Provider.
   */
  readonly mechanisms?: Readonly<Record<string, unknown>>;
}

export interface EffectAttemptIdentity {
  readonly invocationId: string;
  readonly attemptId: string;
}

export interface CapabilityExecutionContext {
  readonly grant: ExecutionGrant;
  readonly requestDigest: string;
  readonly signal: AbortSignal;
  readonly environment: ExecutionEnvironmentRef;
  readonly attempt: EffectAttemptIdentity;
}

export interface ClassifiedProviderFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ExecutionReceipt<TValue extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly invocationId: string;
  readonly attemptId: string;
  readonly providerId: string;
  readonly executorRevision: string;
  readonly requestDigest: string;
  readonly status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'unknown';
  readonly dispatchCertainty: 'none' | 'attempted' | 'unknown';
  readonly cleanupCertainty: 'not_required' | 'confirmed' | 'unknown';
  readonly failure?: ClassifiedProviderFailure;
  readonly value?: TValue;
  readonly diagnostics?: readonly string[];
}

/**
 * Generic in-process invocation accepted by the Host-owned registry port.
 * Policy has already authorized the request; the Host only checks identity,
 * claims the exact attempt once, materializes the execution context, and
 * invokes the registry-selected executor.
 */
export interface CapabilityExecutionInvocation<TInput extends RuntimeJsonValue = RuntimeJsonValue> {
  readonly binding: CapabilityBinding;
  readonly request: ExecutionRequest<TInput>;
  readonly grant: ExecutionGrant;
  readonly requestDigest: string;
  readonly environment: ExecutionEnvironmentRef;
  readonly attempt: EffectAttemptIdentity;
  readonly signal: AbortSignal;
}

export interface CapabilityExecutionPort {
  invoke(invocation: CapabilityExecutionInvocation): Promise<ExecutionReceipt>;
}

export interface CapabilityExecutor<
  TInput extends RuntimeJsonValue = RuntimeJsonValue,
  TValue extends RuntimeJsonValue = RuntimeJsonValue,
> {
  readonly providerId: string;
  readonly capabilityId: string;
  readonly capabilityRevision: string;
  readonly executorRevision: string;
  execute(
    request: ExecutionRequest<TInput>,
    context: CapabilityExecutionContext,
  ): Promise<ExecutionReceipt<TValue>>;
}
