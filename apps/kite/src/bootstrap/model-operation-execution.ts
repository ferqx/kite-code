import {
  type BuiltinToolCatalogProjection,
  createCapabilityBinding,
  digestCapabilityBindingValue,
} from '@kite/builtin-runtime';
import {
  BUILTIN_MODEL_OPERATION_BY_PURPOSE_,
  type BuiltinModelOperationExecutionPort,
} from '@kite/builtin-runtime/model';
import { RuntimeHostCapabilityExecutionError } from '@kite/runtime-host';
import type { CapabilityExecutionPort } from '@kite/runtime-spi';

/**
 * The single App composition seam between the Builtin Model gateway and the
 * Host capability execution port. It owns no Model semantics and never calls
 * the response source directly.
 */
export function createKiteModelOperationExecutionPort(
  capabilityExecution: CapabilityExecutionPort,
  builtinToolCatalog: BuiltinToolCatalogProjection,
): BuiltinModelOperationExecutionPort {
  return Object.freeze({
    async execute(input: Parameters<BuiltinModelOperationExecutionPort['execute']>[0]) {
      if (BUILTIN_MODEL_OPERATION_BY_PURPOSE_[input.purpose] !== input.operationId) {
        throw new Error(
          `Builtin Model operation purpose mismatch: ${input.purpose}:${input.operationId}`,
        );
      }
      const entry = builtinToolCatalog.entries.find(
        (candidate) => candidate.operationId === input.operationId,
      );
      if (
        entry?.visibility !== 'internal' ||
        entry.executionMechanism !== 'model' ||
        entry.availability !== 'available' ||
        !entry.inputSchema
      ) {
        throw new Error(`Builtin Model operation is unavailable: ${input.operationId}`);
      }
      const parsed = entry.parse(input.input);
      if (!parsed.success || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
        throw new Error(`Builtin Model operation input is invalid: ${input.operationId}`);
      }
      const canonicalInput = parsed.data;
      const inputDigest = digestCapabilityBindingValue(canonicalInput);
      const binding = createCapabilityBinding({
        capabilityId: entry.capabilityId,
        capabilityRevision: entry.revision,
        exposedToolName: entry.operationId,
        inputSchema: entry.inputSchema,
        turnId: input.turnId,
      });
      const operationInvocationId = `model-operation:${input.invocationId}:${input.attemptOrdinal}`;
      let mechanismCalls = 0;
      let observedOutcome: Awaited<ReturnType<typeof input.attempt>> | undefined;
      try {
        const receipt = await builtinToolCatalog.dispatch(input.operationId, capabilityExecution, {
          binding,
          request: {
            invocationId: operationInvocationId,
            capabilityId: entry.capabilityId,
            capabilityRevision: entry.revision,
            input: canonicalInput,
          },
          grant: {
            grantId: digestCapabilityBindingValue({
              schema: 'kite.model-operation-grant.current',
              operationInvocationId,
              operationId: entry.operationId,
              stateRevision: input.stateRevision,
            }),
            capabilityId: entry.capabilityId,
            capabilityRevision: entry.revision,
            authority: Object.freeze({
              owner: 'agent-kernel',
              purpose: input.purpose,
              state_revision: input.stateRevision,
              surface_digest: input.surfaceDigest,
            }),
          },
          requestDigest: inputDigest,
          environment: Object.freeze({
            environmentId: 'kite-model-operation-in-process',
            kind: 'in_process',
            mechanisms: Object.freeze({
              model: Object.freeze({
                execute: async (operationId: string, mechanismInput: unknown) => {
                  if (
                    operationId !== input.operationId ||
                    digestCapabilityBindingValue(mechanismInput) !== inputDigest ||
                    mechanismCalls !== 0
                  ) {
                    throw new Error('Builtin Model execution mechanism identity mismatch.');
                  }
                  mechanismCalls += 1;
                  observedOutcome = await input.attempt();
                  return observedOutcome;
                },
              }),
            }),
          }),
          attempt: {
            invocationId: operationInvocationId,
            attemptId: `${operationInvocationId}:attempt:1`,
          },
          signal: input.signal,
        });
        if (receipt.status !== 'succeeded' || mechanismCalls !== 1 || !observedOutcome) {
          throw new Error(
            receipt.failure?.message ?? `Builtin Model operation failed: ${input.operationId}`,
          );
        }
        return observedOutcome;
      } catch (error) {
        if (
          error instanceof RuntimeHostCapabilityExecutionError &&
          error.code === 'executor_failed' &&
          error.causeValue instanceof Error
        ) {
          throw error.causeValue;
        }
        throw error;
      }
    },
  });
}
