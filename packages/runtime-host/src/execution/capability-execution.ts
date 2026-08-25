import {
  arbitrateCapability,
  type CapabilityExecutionInvocation,
  type CapabilityExecutionPort,
  type CapabilityRegistrySnapshot,
  type ExecutionReceipt,
} from '@kite-ai/runtime-spi';

export type RuntimeHostCapabilityExecutionFailureCode =
  | 'binding_invalid'
  | 'capability_missing'
  | 'capability_revision_mismatch'
  | 'schema_digest_mismatch'
  | 'executor_missing'
  | 'executor_binding_mismatch'
  | 'exposed_tool_name_mismatch'
  | 'request_identity_mismatch'
  | 'grant_identity_mismatch'
  | 'attempt_identity_mismatch'
  | 'attempt_already_claimed'
  | 'executor_failed'
  | 'receipt_identity_mismatch';

export class RuntimeHostCapabilityExecutionError extends Error {
  readonly code: RuntimeHostCapabilityExecutionFailureCode;
  readonly causeValue: unknown | undefined;

  constructor(
    code: RuntimeHostCapabilityExecutionFailureCode,
    message: string,
    causeValue?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeHostCapabilityExecutionError';
    this.code = code;
    this.causeValue = causeValue;
  }
}

/**
 * Host mechanism only: immutable arbitration, exact identity checks, and one
 * in-process claim per invocation/attempt. It never interprets provider facts
 * or grants additional authority.
 */
/** Execute against the exact immutable snapshot captured by the owning Runtime Host. */
export function createRuntimeHostCapabilityExecutionPortFromSnapshot(
  snapshot: Readonly<CapabilityRegistrySnapshot>,
): CapabilityExecutionPort {
  const claimedAttempts = new Set<string>();
  return Object.freeze({
    async invoke(invocation: CapabilityExecutionInvocation): Promise<ExecutionReceipt> {
      const resolved = arbitrateCapability(snapshot, invocation.binding);
      if (resolved.status === 'failed') {
        throw new RuntimeHostCapabilityExecutionError(
          resolved.code,
          `Runtime capability arbitration failed: ${resolved.code}.`,
        );
      }
      const { definition, executor } = resolved;
      if (
        invocation.request.capabilityId !== definition.capabilityId ||
        invocation.request.capabilityRevision !== definition.revision
      ) {
        throw new RuntimeHostCapabilityExecutionError(
          'request_identity_mismatch',
          'Runtime capability request identity does not match the exact binding.',
        );
      }
      if (
        invocation.grant.capabilityId !== definition.capabilityId ||
        invocation.grant.capabilityRevision !== definition.revision
      ) {
        throw new RuntimeHostCapabilityExecutionError(
          'grant_identity_mismatch',
          'Runtime capability grant identity does not match the exact binding.',
        );
      }
      if (invocation.attempt.invocationId !== invocation.request.invocationId) {
        throw new RuntimeHostCapabilityExecutionError(
          'attempt_identity_mismatch',
          'Runtime capability attempt does not belong to the invocation request.',
        );
      }
      const claimKey = `${invocation.attempt.invocationId}\0${invocation.attempt.attemptId}`;
      if (claimedAttempts.has(claimKey)) {
        throw new RuntimeHostCapabilityExecutionError(
          'attempt_already_claimed',
          'Runtime capability attempt has already been claimed.',
        );
      }
      claimedAttempts.add(claimKey);

      let receipt: ExecutionReceipt;
      try {
        receipt = await executor.execute(invocation.request, {
          grant: invocation.grant,
          requestDigest: invocation.requestDigest,
          signal: invocation.signal,
          environment: invocation.environment,
          attempt: invocation.attempt,
        });
      } catch (error) {
        throw new RuntimeHostCapabilityExecutionError(
          'executor_failed',
          error instanceof Error ? error.message : 'Runtime capability executor failed.',
          error,
        );
      }
      if (
        receipt.invocationId !== invocation.request.invocationId ||
        receipt.attemptId !== invocation.attempt.attemptId ||
        receipt.providerId !== executor.providerId ||
        receipt.executorRevision !== executor.executorRevision ||
        receipt.requestDigest !== invocation.requestDigest
      ) {
        throw new RuntimeHostCapabilityExecutionError(
          'receipt_identity_mismatch',
          'Runtime capability receipt identity does not match the claimed attempt.',
        );
      }
      return receipt;
    },
  });
}
