import type {
  CapabilityExecutionContext,
  CapabilityExecutionMechanism,
  CapabilityExecutor,
  ExecutionReceipt,
  RuntimeModule,
  RuntimeModuleRegistryWriter,
} from '@kite-ai/runtime-spi';
import { defineRuntimeModule } from '@kite-ai/runtime-spi';
import { digestCapabilityBindingValue } from '../capability-binding';
import {
  defineBuiltinCapabilityContract,
  parserForBuiltinOperation,
  staticEffectsClassifier,
} from '../catalog-contract';
import { BUILTIN_MODEL_OPERATION_IDS_, type BuiltinModelOperationId } from '../model/operation';
import type { BuiltinOperationExecutionValue } from '../model/runtime-module';
import { BUILTIN_JSON_SCHEMAS_ } from '../tool-schemas';

export const VERIFICATION_PROVIDER_ID_ = 'kite-builtin-runtime-verification' as const;

export const VERIFICATION_OPERATION_IDS_ = BUILTIN_MODEL_OPERATION_IDS_;

export type VerificationOperationId = BuiltinModelOperationId;

const MODEL_OPERATION_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['model:primary'];

const MODEL_OPERATION_EFFECTS_ = Object.freeze({
  filesystem: 'none',
  network: 'write',
  externalState: 'none',
});

const EXECUTION_MECHANISMS_: Readonly<
  Record<VerificationOperationId, CapabilityExecutionMechanism>
> = Object.freeze({
  'model:primary': 'model',
  'model:compaction': 'model',
  'model:auto_review': 'model',
  'model:subagent': 'model',
});

export const VERIFICATION_CAPABILITY_REVISIONS_: Readonly<Record<VerificationOperationId, string>> =
  Object.freeze(
    Object.fromEntries(
      VERIFICATION_OPERATION_IDS_.map((operationId) => [
        operationId,
        digestCapabilityBindingValue({
          schema: 'kite.verification-operation-capability.current',
          operationId,
          inputSchema: MODEL_OPERATION_INPUT_SCHEMA_,
          effects: MODEL_OPERATION_EFFECTS_,
        }),
      ]),
    ) as Record<VerificationOperationId, string>,
  );

export const VERIFICATION_EXECUTOR_REVISIONS_: Readonly<Record<VerificationOperationId, string>> =
  Object.freeze(
    Object.fromEntries(
      VERIFICATION_OPERATION_IDS_.map((operationId) => [
        operationId,
        digestCapabilityBindingValue({
          schema: 'kite.verification-operation-executor.current',
          operationId,
          capabilityRevision: VERIFICATION_CAPABILITY_REVISIONS_[operationId],
          gateway: 'kite.model-invocation-gateway.v1',
        }),
      ]),
    ) as Record<VerificationOperationId, string>,
  );

/** Host-provided effect lifecycle around the Builtin-owned Model invocation semantics. */
export interface BuiltinModelExecutionMechanism {
  execute(
    operationId: VerificationOperationId,
    input: Readonly<Record<string, unknown>>,
  ): Promise<BuiltinOperationExecutionValue>;
}

export interface VerificationExecutionMechanisms extends Readonly<Record<string, unknown>> {
  readonly model?: BuiltinModelExecutionMechanism;
}

export function createVerificationRuntimeModule(): RuntimeModule {
  return defineRuntimeModule({
    moduleId: VERIFICATION_PROVIDER_ID_,
    providerId: VERIFICATION_PROVIDER_ID_,
    revision: 'verification-current',
    operationIds: VERIFICATION_OPERATION_IDS_,
    register: registerVerificationOperations,
  });
}

function registerVerificationOperations(registry: RuntimeModuleRegistryWriter): void {
  for (const operationId of VERIFICATION_OPERATION_IDS_) {
    const capabilityRevision = VERIFICATION_CAPABILITY_REVISIONS_[operationId];
    registry.registerCapability(
      defineBuiltinCapabilityContract(
        {
          capabilityId: operationId,
          revision: capabilityRevision,
          providerId: VERIFICATION_PROVIDER_ID_,
          title: `Builtin Runtime Model operation ${operationId}`,
          executionMechanism: EXECUTION_MECHANISMS_[operationId],
          visibility: 'internal',
          effects: MODEL_OPERATION_EFFECTS_,
          inputSchema: MODEL_OPERATION_INPUT_SCHEMA_,
          inputSchemaDigest: digestCapabilityBindingValue(MODEL_OPERATION_INPUT_SCHEMA_),
        },
        {
          parser: parserForBuiltinOperation(operationId, capabilityRevision),
          kind: 'internal_runtime',
          minimumApproval: 'none',
          effectsClassifier: staticEffectsClassifier(
            'unknown',
            true,
            'Model gateway lifecycle is an internal Host-routed operation.',
            MODEL_OPERATION_EFFECTS_,
          ),
          execution: { retry: 'never' },
        },
      ),
    );
    registry.registerExecutor({
      providerId: VERIFICATION_PROVIDER_ID_,
      capabilityId: operationId,
      capabilityRevision,
      executorRevision: VERIFICATION_EXECUTOR_REVISIONS_[operationId],
      execute: (request, context) => executeVerificationOperation(operationId, request, context),
    } satisfies CapabilityExecutor);
  }
}

async function executeVerificationOperation(
  operationId: VerificationOperationId,
  request: Parameters<CapabilityExecutor['execute']>[0],
  context: CapabilityExecutionContext,
): Promise<ExecutionReceipt> {
  const input = asRecord(request.input);
  if (!input) return failedReceipt(operationId, request.invocationId, context, 'invalid_input');
  const mechanisms = context.environment.mechanisms as VerificationExecutionMechanisms | undefined;
  if (!mechanisms?.model) {
    return failedReceipt(
      operationId,
      request.invocationId,
      context,
      'model_execution_mechanism_unavailable',
    );
  }
  const value = await mechanisms.model.execute(operationId, input);
  return Object.freeze({
    invocationId: request.invocationId,
    attemptId: context.attempt.attemptId,
    providerId: VERIFICATION_PROVIDER_ID_,
    executorRevision: VERIFICATION_EXECUTOR_REVISIONS_[operationId],
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  operationId: VerificationOperationId,
  invocationId: string,
  context: CapabilityExecutionContext,
  code: string,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: VERIFICATION_PROVIDER_ID_,
    executorRevision: VERIFICATION_EXECUTOR_REVISIONS_[operationId],
    requestDigest: context.requestDigest,
    status: 'failed',
    dispatchCertainty: 'none',
    cleanupCertainty: 'not_required',
    failure: Object.freeze({
      code,
      message: `Builtin Model operation ${operationId} is unavailable.`,
      retryable: false,
    }),
  });
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
