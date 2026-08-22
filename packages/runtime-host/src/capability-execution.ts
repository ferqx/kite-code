import {
  arbitrateCapabilityV1,
  type CapabilityExecutionInvocationV1,
  type CapabilityExecutionPortV1,
  type CapabilityRegistrySnapshotV1,
  type ExecutionReceiptV1,
  type RuntimeModuleRegistryV1,
} from '@kite/runtime-spi';

export type RuntimeHostCapabilityExecutionFailureCodeV1 =
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

export class RuntimeHostCapabilityExecutionErrorV1 extends Error {
  readonly code: RuntimeHostCapabilityExecutionFailureCodeV1;
  readonly causeValue: unknown | undefined;

  constructor(
    code: RuntimeHostCapabilityExecutionFailureCodeV1,
    message: string,
    causeValue?: unknown,
  ) {
    super(message);
    this.name = 'RuntimeHostCapabilityExecutionErrorV1';
    this.code = code;
    this.causeValue = causeValue;
  }
}

/**
 * Host mechanism only: immutable arbitration, exact identity checks, and one
 * in-process claim per invocation/attempt. It never interprets provider facts
 * or grants additional authority.
 */
export function createRuntimeHostCapabilityExecutionPortV1(
  registry: RuntimeModuleRegistryV1,
): CapabilityExecutionPortV1 {
  return createRuntimeHostCapabilityExecutionPortFromSnapshotV1(registry.snapshot());
}

/**
 * Internal Host seam: execute against the exact immutable snapshot captured by
 * the owning Runtime Host. Keeping this separate from the registry-taking
 * compatibility factory prevents the Host from making a second snapshot for
 * its production execution port.
 */
export function createRuntimeHostCapabilityExecutionPortFromSnapshotV1(
  snapshot: Readonly<CapabilityRegistrySnapshotV1>,
): CapabilityExecutionPortV1 {
  const claimedAttempts = new Set<string>();
  return Object.freeze({
    async invoke(invocation: CapabilityExecutionInvocationV1): Promise<ExecutionReceiptV1> {
      const resolved = arbitrateCapabilityV1(snapshot, invocation.binding);
      if (resolved.status === 'failed') {
        throw new RuntimeHostCapabilityExecutionErrorV1(
          resolved.code,
          `Runtime capability arbitration failed: ${resolved.code}.`,
        );
      }
      const { definition, executor } = resolved;
      if (
        invocation.request.capabilityId !== definition.capabilityId ||
        invocation.request.capabilityRevision !== definition.revision
      ) {
        throw new RuntimeHostCapabilityExecutionErrorV1(
          'request_identity_mismatch',
          'Runtime capability request identity does not match the exact binding.',
        );
      }
      if (
        invocation.grant.capabilityId !== definition.capabilityId ||
        invocation.grant.capabilityRevision !== definition.revision
      ) {
        throw new RuntimeHostCapabilityExecutionErrorV1(
          'grant_identity_mismatch',
          'Runtime capability grant identity does not match the exact binding.',
        );
      }
      if (invocation.attempt.invocationId !== invocation.request.invocationId) {
        throw new RuntimeHostCapabilityExecutionErrorV1(
          'attempt_identity_mismatch',
          'Runtime capability attempt does not belong to the invocation request.',
        );
      }
      const claimKey = `${invocation.attempt.invocationId}\0${invocation.attempt.attemptId}`;
      if (claimedAttempts.has(claimKey)) {
        throw new RuntimeHostCapabilityExecutionErrorV1(
          'attempt_already_claimed',
          'Runtime capability attempt has already been claimed.',
        );
      }
      claimedAttempts.add(claimKey);

      let receipt: ExecutionReceiptV1;
      try {
        receipt = await executor.execute(invocation.request, {
          grant: invocation.grant,
          requestDigest: invocation.requestDigest,
          signal: invocation.signal,
          environment: invocation.environment,
          attempt: invocation.attempt,
        });
      } catch (error) {
        throw new RuntimeHostCapabilityExecutionErrorV1(
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
        throw new RuntimeHostCapabilityExecutionErrorV1(
          'receipt_identity_mismatch',
          'Runtime capability receipt identity does not match the claimed attempt.',
        );
      }
      return receipt;
    },
  });
}
