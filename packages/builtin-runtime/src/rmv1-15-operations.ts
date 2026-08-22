import type {
  CapabilityExecutionContextV1,
  CapabilityExecutionMechanismV1,
  CapabilityExecutorV1,
  ExecutionReceiptV1,
  RuntimeModuleRegistryWriterV1,
  RuntimeModuleV1,
} from '@kite/runtime-spi';
import { defineRuntimeModuleV1 } from '@kite/runtime-spi';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import {
  defineBuiltinCapabilityContractV1,
  parserForBuiltinOperationV1,
  staticEffectsClassifierV1,
} from './catalog-contract';
import { BUILTIN_MODEL_OPERATION_IDS_V1, type BuiltinModelOperationIdV1 } from './model/operation';
import type { BuiltinOperationExecutionValueV1 } from './rmv1-11-operations';
import { BUILTIN_JSON_SCHEMAS_V1 } from './tool-schemas';

export const RMV1_15_PROVIDER_ID_V1 = 'kite-builtin-runtime-rmv1-15' as const;

export const RMV1_15_OPERATION_IDS_V1 = BUILTIN_MODEL_OPERATION_IDS_V1;

export type Rmv115OperationIdV1 = BuiltinModelOperationIdV1;

const MODEL_OPERATION_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['model:primary'];

const MODEL_OPERATION_EFFECTS_V1 = Object.freeze({
  filesystem: 'none',
  network: 'write',
  externalState: 'none',
});

const EXECUTION_MECHANISMS_V1: Readonly<
  Record<Rmv115OperationIdV1, CapabilityExecutionMechanismV1>
> = Object.freeze({
  'model:primary': 'model',
  'model:compaction': 'model',
  'model:auto_review': 'model',
  'model:verification_review': 'model',
  'model:subagent': 'model',
});

export const RMV1_15_CAPABILITY_REVISIONS_V1: Readonly<Record<Rmv115OperationIdV1, string>> =
  Object.freeze(
    Object.fromEntries(
      RMV1_15_OPERATION_IDS_V1.map((operationId) => [
        operationId,
        digestCapabilityBindingValueV1({
          schema: 'kite.rmv1-15-model-operation-capability.v1',
          operationId,
          inputSchema: MODEL_OPERATION_INPUT_SCHEMA_V1,
          effects: MODEL_OPERATION_EFFECTS_V1,
        }),
      ]),
    ) as Record<Rmv115OperationIdV1, string>,
  );

export const RMV1_15_EXECUTOR_REVISIONS_V1: Readonly<Record<Rmv115OperationIdV1, string>> =
  Object.freeze(
    Object.fromEntries(
      RMV1_15_OPERATION_IDS_V1.map((operationId) => [
        operationId,
        digestCapabilityBindingValueV1({
          schema: 'kite.rmv1-15-model-operation-executor.v1',
          operationId,
          capabilityRevision: RMV1_15_CAPABILITY_REVISIONS_V1[operationId],
          gateway: 'kite.model-invocation-gateway.v1',
        }),
      ]),
    ) as Record<Rmv115OperationIdV1, string>,
  );

/** Host-provided effect lifecycle around the Builtin-owned Model invocation semantics. */
export interface BuiltinModelExecutionMechanismV1 {
  execute(
    operationId: Rmv115OperationIdV1,
    input: Readonly<Record<string, unknown>>,
  ): Promise<BuiltinOperationExecutionValueV1>;
}

export interface Rmv115ExecutionMechanismsV1 extends Readonly<Record<string, unknown>> {
  readonly model?: BuiltinModelExecutionMechanismV1;
}

export function createRmv115RuntimeModuleV1(): RuntimeModuleV1 {
  return defineRuntimeModuleV1({
    moduleId: RMV1_15_PROVIDER_ID_V1,
    providerId: RMV1_15_PROVIDER_ID_V1,
    revision: 'rmv1-15',
    operationIds: RMV1_15_OPERATION_IDS_V1,
    register: registerRmv115OperationsV1,
  });
}

function registerRmv115OperationsV1(registry: RuntimeModuleRegistryWriterV1): void {
  for (const operationId of RMV1_15_OPERATION_IDS_V1) {
    const capabilityRevision = RMV1_15_CAPABILITY_REVISIONS_V1[operationId];
    registry.registerCapability(
      defineBuiltinCapabilityContractV1(
        {
          capabilityId: operationId,
          revision: capabilityRevision,
          providerId: RMV1_15_PROVIDER_ID_V1,
          title: `Builtin Runtime Model operation ${operationId}`,
          executionMechanism: EXECUTION_MECHANISMS_V1[operationId],
          visibility: 'internal',
          effects: MODEL_OPERATION_EFFECTS_V1,
          inputSchema: MODEL_OPERATION_INPUT_SCHEMA_V1,
          inputSchemaDigest: digestCapabilityBindingValueV1(MODEL_OPERATION_INPUT_SCHEMA_V1),
        },
        {
          parser: parserForBuiltinOperationV1(operationId, capabilityRevision),
          kind: 'internal_runtime',
          minimumApproval: 'none',
          effectsClassifier: staticEffectsClassifierV1(
            'unknown',
            true,
            'Model gateway lifecycle is an internal Host-routed operation.',
            MODEL_OPERATION_EFFECTS_V1,
          ),
          execution: { retry: 'never' },
        },
      ),
    );
    registry.registerExecutor({
      providerId: RMV1_15_PROVIDER_ID_V1,
      capabilityId: operationId,
      capabilityRevision,
      executorRevision: RMV1_15_EXECUTOR_REVISIONS_V1[operationId],
      execute: (request, context) => executeRmv115OperationV1(operationId, request, context),
    } satisfies CapabilityExecutorV1);
  }
}

async function executeRmv115OperationV1(
  operationId: Rmv115OperationIdV1,
  request: Parameters<CapabilityExecutorV1['execute']>[0],
  context: CapabilityExecutionContextV1,
): Promise<ExecutionReceiptV1> {
  const input = asRecord(request.input);
  if (!input) return failedReceipt(operationId, request.invocationId, context, 'invalid_input');
  const mechanisms = context.environment.mechanisms as Rmv115ExecutionMechanismsV1 | undefined;
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
    providerId: RMV1_15_PROVIDER_ID_V1,
    executorRevision: RMV1_15_EXECUTOR_REVISIONS_V1[operationId],
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  operationId: Rmv115OperationIdV1,
  invocationId: string,
  context: CapabilityExecutionContextV1,
  code: string,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_15_PROVIDER_ID_V1,
    executorRevision: RMV1_15_EXECUTOR_REVISIONS_V1[operationId],
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
