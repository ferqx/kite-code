import type { UserInputRequest } from '@kite/runtime-contract';
import type {
  CapabilityEffectsV1,
  CapabilityExecutionContextV1,
  CapabilityExecutionMechanismV1,
  CapabilityExecutorV1,
  ExecutionReceiptV1,
  RuntimeJsonValueV1,
  RuntimeModuleRegistryWriterV1,
  RuntimeModuleV1,
  SubagentRoleV1,
} from '@kite/runtime-spi';
import { defineRuntimeModuleV1 } from '@kite/runtime-spi';
import type { z } from 'zod';
import { digestCapabilityBindingValueV1 } from './capability-binding';
import {
  builtinExecutionTraitsV1,
  defineBuiltinCapabilityContractV1,
  parserForBuiltinOperationV1,
  staticEffectsClassifierV1,
  taskAvailabilityV1,
  taskEffectsClassifierV1,
  taskModelInputSchemaV1,
  taskModelParserV1,
  taskModelSchemaV1,
  taskRuntimeParserV1,
} from './catalog-contract';
import type {
  BuiltinOperationExecutionValueV1,
  BuiltinRuntimeEventValueV1,
} from './model-operations';
import {
  askUserBuiltinPolicyRuleV1,
  createBuiltinPolicyCompilerV1,
  planBuiltinPolicyRuleV1,
  taskBuiltinPolicyRuleV1,
} from './policy-compiler';
import { builtinToolDescriptionV1 } from './tool-contracts';
import {
  BUILTIN_JSON_SCHEMAS_V1,
  BUILTIN_READ_PLAN_SCHEMA_V1,
  BUILTIN_UPDATE_PLAN_SCHEMA_V1,
  BUILTIN_WRITE_PLAN_SCHEMA_V1,
  BUILTIN_ZOD_SCHEMAS_V1,
} from './tool-schemas';

export const RMV1_14_PROVIDER_ID_V1 = 'kite-builtin-runtime-rmv1-14' as const;

export const RMV1_14_OPERATION_IDS_V1 = Object.freeze([
  'builtin:ask_user',
  'builtin:read_plan',
  'builtin:update_plan',
  'builtin:write_plan',
  'builtin:task',
  'subagent:start',
  'subagent:resume',
  'verification:deterministic',
] as const);

export type Rmv114OperationIdV1 = (typeof RMV1_14_OPERATION_IDS_V1)[number];
export type Rmv114ToolOperationIdV1 = Extract<Rmv114OperationIdV1, `builtin:${string}`>;

export function isBuiltinSubagentTaskToolNameV1(value: unknown): value is 'task' {
  return value === RMV1_14_OPERATION_IDS_V1[4].slice('builtin:'.length);
}

export const ASK_USER_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:ask_user'];
export const READ_PLAN_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:read_plan'];
export const UPDATE_PLAN_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:update_plan'];
export const WRITE_PLAN_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:write_plan'];
export const TASK_INPUT_SCHEMA_V1 = BUILTIN_JSON_SCHEMAS_V1['builtin:task'];

/**
 * Normalize the Builtin-owned ask_user input into the Host interrupt payload.
 * The Runtime Controller remains the sole interrupt owner; this helper owns
 * only the Builtin format semantics already enforced by the canonical parser.
 */
export function normalizeAskUserRequestV1(input: RuntimeJsonValueV1): UserInputRequest {
  const parsed = BUILTIN_ZOD_SCHEMAS_V1['builtin:ask_user'].parse(input);
  const questions = parsed.questions.map((question, questionIndex) => {
    const id = `q${questionIndex + 1}`;
    const options = question.options.map((option, optionIndex) => ({
      id: `${id}-o${optionIndex + 1}`,
      label: option.label,
      description: option.description,
    }));
    const recommendedIndex = question.options.findIndex((option) => option.recommended === true);
    const recommended = options[recommendedIndex]!.id;
    return {
      id,
      question: question.question,
      options,
      recommended,
      allow_free_text: true,
    };
  });
  const first = questions[0]!;
  return {
    question: first.question,
    options: first.options,
    recommended: first.recommended,
    allow_free_text: true,
    questions,
  };
}

const INPUT_SCHEMAS_V1: Readonly<
  Record<Rmv114OperationIdV1, Readonly<Record<string, RuntimeJsonValueV1>>>
> = Object.freeze({
  'builtin:ask_user': ASK_USER_INPUT_SCHEMA_V1,
  'builtin:read_plan': READ_PLAN_INPUT_SCHEMA_V1,
  'builtin:update_plan': UPDATE_PLAN_INPUT_SCHEMA_V1,
  'builtin:write_plan': WRITE_PLAN_INPUT_SCHEMA_V1,
  'builtin:task': TASK_INPUT_SCHEMA_V1,
  'subagent:start': BUILTIN_JSON_SCHEMAS_V1['subagent:start'],
  'subagent:resume': BUILTIN_JSON_SCHEMAS_V1['subagent:resume'],
  'verification:deterministic': BUILTIN_JSON_SCHEMAS_V1['verification:deterministic'],
});

const EFFECTS_V1 = Object.freeze({
  'builtin:ask_user': Object.freeze({ filesystem: 'none', network: 'none', externalState: 'none' }),
  'builtin:read_plan': Object.freeze({
    filesystem: 'read',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:update_plan': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:write_plan': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:task': Object.freeze({
    filesystem: 'unknown',
    network: 'unknown',
    externalState: 'none',
  }),
  'subagent:start': Object.freeze({
    filesystem: 'unknown',
    network: 'unknown',
    externalState: 'none',
  }),
  'subagent:resume': Object.freeze({
    filesystem: 'unknown',
    network: 'unknown',
    externalState: 'none',
  }),
  'verification:deterministic': Object.freeze({
    filesystem: 'read',
    network: 'read',
    externalState: 'read',
  }),
});

const EXECUTION_MECHANISMS_V1: Readonly<
  Record<Rmv114OperationIdV1, CapabilityExecutionMechanismV1>
> = Object.freeze({
  'builtin:ask_user': 'user_input',
  'builtin:read_plan': 'planning',
  'builtin:update_plan': 'planning',
  'builtin:write_plan': 'planning',
  'builtin:task': 'subagent',
  'subagent:start': 'subagent',
  'subagent:resume': 'subagent',
  'verification:deterministic': 'verification',
});

export const RMV1_14_CAPABILITY_REVISIONS_V1: Readonly<Record<Rmv114OperationIdV1, string>> =
  Object.freeze(
    Object.fromEntries(
      RMV1_14_OPERATION_IDS_V1.map((operationId) => [
        operationId,
        digestCapabilityBindingValueV1({
          schema: 'kite.rmv1-14-operation-capability.v1',
          operationId,
          inputSchema: INPUT_SCHEMAS_V1[operationId],
          effects: EFFECTS_V1[operationId],
        }),
      ]),
    ) as Record<Rmv114OperationIdV1, string>,
  );

export const RMV1_14_EXECUTOR_REVISIONS_V1: Readonly<Record<Rmv114OperationIdV1, string>> =
  Object.freeze(
    Object.fromEntries(
      RMV1_14_OPERATION_IDS_V1.map((operationId) => [
        operationId,
        digestCapabilityBindingValueV1({
          schema: 'kite.rmv1-14-operation-executor.v1',
          operationId,
          capabilityRevision: RMV1_14_CAPABILITY_REVISIONS_V1[operationId],
        }),
      ]),
    ) as Record<Rmv114OperationIdV1, string>,
  );

export interface BuiltinPlanActionResultV1 {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly runtimeEvents?: readonly BuiltinRuntimeEventValueV1[];
}

export type BuiltinReadPlanInputV1 = z.infer<typeof BUILTIN_READ_PLAN_SCHEMA_V1>;
export type BuiltinUpdatePlanInputV1 = z.infer<typeof BUILTIN_UPDATE_PLAN_SCHEMA_V1>;
export type BuiltinWritePlanInputV1 = z.infer<typeof BUILTIN_WRITE_PLAN_SCHEMA_V1>;

export interface BuiltinPlanningExecutionMechanismV1 {
  read(input: BuiltinReadPlanInputV1): Promise<BuiltinPlanActionResultV1>;
  update(toolCallId: string, input: BuiltinUpdatePlanInputV1): Promise<BuiltinPlanActionResultV1>;
  write(toolCallId: string, input: BuiltinWritePlanInputV1): Promise<BuiltinPlanActionResultV1>;
}

export interface BuiltinSubagentExecutionMechanismV1 {
  readonly phase: 'planning' | 'building';
  executeTask(): Promise<Readonly<Record<string, unknown>>>;
}

export interface BuiltinVerificationExecutionMechanismV1 {
  execute(input: Readonly<Record<string, unknown>>): Promise<BuiltinOperationExecutionValueV1>;
}

export interface Rmv114ExecutionMechanismsV1 extends Readonly<Record<string, unknown>> {
  readonly planning?: BuiltinPlanningExecutionMechanismV1;
  readonly subagent?: BuiltinSubagentExecutionMechanismV1;
  readonly verification?: BuiltinVerificationExecutionMechanismV1;
}

export function createSubagentRuntimeModule(): RuntimeModuleV1 {
  return defineRuntimeModuleV1({
    moduleId: 'kite-builtin-runtime-rmv1-14',
    providerId: RMV1_14_PROVIDER_ID_V1,
    revision: 'rmv1-14',
    operationIds: RMV1_14_OPERATION_IDS_V1,
    register: registerRmv114OperationsV1,
  });
}

function registerRmv114OperationsV1(registry: RuntimeModuleRegistryWriterV1): void {
  for (const operationId of RMV1_14_OPERATION_IDS_V1) {
    const capabilityRevision = RMV1_14_CAPABILITY_REVISIONS_V1[operationId];
    registry.registerCapability(
      defineBuiltinCapabilityContractV1(
        {
          capabilityId: operationId,
          revision: capabilityRevision,
          providerId: RMV1_14_PROVIDER_ID_V1,
          title: `Builtin Runtime operation ${operationId}`,
          executionMechanism: EXECUTION_MECHANISMS_V1[operationId],
          ...(operationId.startsWith('builtin:')
            ? {
                toolName: operationId.slice('builtin:'.length),
                description: builtinToolDescriptionV1(operationId.slice('builtin:'.length)),
                visibility: 'model' as const,
              }
            : { visibility: 'internal' as const }),
          effects: EFFECTS_V1[operationId],
          inputSchema: INPUT_SCHEMAS_V1[operationId],
          inputSchemaDigest: digestCapabilityBindingValueV1(INPUT_SCHEMAS_V1[operationId]),
        },
        rmv114ContractOptionsV1(operationId, capabilityRevision, EFFECTS_V1[operationId]),
      ),
    );
    registry.registerExecutor({
      providerId: RMV1_14_PROVIDER_ID_V1,
      capabilityId: operationId,
      capabilityRevision,
      executorRevision: RMV1_14_EXECUTOR_REVISIONS_V1[operationId],
      execute: (request, context) => executeRmv114OperationV1(operationId, request, context),
    } satisfies CapabilityExecutorV1);
  }
}

function rmv114ContractOptionsV1(
  operationId: Rmv114OperationIdV1,
  revision: string,
  effects: CapabilityEffectsV1,
) {
  const modelVisible = operationId.startsWith('builtin:');
  const planAction =
    operationId === 'builtin:read_plan' ||
    operationId === 'builtin:update_plan' ||
    operationId === 'builtin:write_plan';
  const task = operationId === 'builtin:task';
  const askUser = operationId === 'builtin:ask_user';
  const readOnly = operationId === 'builtin:read_plan';
  const parser = task
    ? taskRuntimeParserV1(revision)
    : parserForBuiltinOperationV1(operationId, revision);
  const policyRule = askUser
    ? askUserBuiltinPolicyRuleV1
    : task
      ? taskBuiltinPolicyRuleV1
      : planBuiltinPolicyRuleV1;
  return {
    parser,
    ...(task
      ? {
          modelParser: taskModelParserV1(`${revision}:model`),
          modelSchemaForContext: taskModelSchemaV1,
          modelInputSchemaForContext: taskModelInputSchemaV1,
        }
      : {}),
    kind: askUser
      ? ('interrupt' as const)
      : planAction
        ? ('runtime_action' as const)
        : modelVisible
          ? task
            ? ('coordination' as const)
            : ('runtime_action' as const)
          : ('internal_runtime' as const),
    ...(askUser ? { descriptorRevisionSource: 'content' as const } : {}),
    minimumApproval: task ? ('user' as const) : ('none' as const),
    ...(task ? { availability: taskAvailabilityV1 } : {}),
    effectsClassifier: task
      ? taskEffectsClassifierV1(effects)
      : staticEffectsClassifierV1(
          askUser || readOnly ? 'read_only' : planAction ? 'plan_only' : 'unknown',
          !askUser && !readOnly && !planAction,
          askUser
            ? 'Pauses execution for explicit user input.'
            : readOnly
              ? 'Reads the active immutable Plan Artifact.'
              : planAction
                ? operationId === 'builtin:update_plan'
                  ? 'Updates progress in the active approved Plan.'
                  : 'Creates or submits an immutable Plan Artifact.'
                : 'Internal RMV1-14 lifecycle operation is Host-routed.',
          effects,
        ),
    ...(modelVisible
      ? {
          policyCompiler: createBuiltinPolicyCompilerV1({
            operationId,
            capabilityRevision: revision,
            parserRevision: parser.parserRevision,
            declaredEffects: effects,
            minimumApproval: task ? 'user' : 'none',
            rule: policyRule,
          }),
        }
      : {}),
    ...(task
      ? {
          executionTraitsDeclaration: builtinExecutionTraitsV1({
            resourceScopes: [
              { kind: 'subagent', key: 'child' },
              { kind: 'workspace', key: 'workspace' },
            ],
            interactionBarrier: false,
            concurrencyGroup: 'parallel-subagent',
          }),
        }
      : {}),
    execution: readOnly ? { retry: 'safe_read' as const } : { retry: 'never' as const },
  };
}

async function executeRmv114OperationV1(
  operationId: Rmv114OperationIdV1,
  request: Parameters<CapabilityExecutorV1['execute']>[0],
  context: CapabilityExecutionContextV1,
): Promise<ExecutionReceiptV1> {
  const input = asRecord(request.input);
  if (!input || !validateInputV1(operationId, input)) {
    return failedReceipt(operationId, request.invocationId, context, 'invalid_input');
  }
  const mechanisms = context.environment.mechanisms as Rmv114ExecutionMechanismsV1 | undefined;
  let value: BuiltinOperationExecutionValueV1;
  switch (operationId) {
    case 'builtin:ask_user':
      value = operationFailure('ask_user must be handled by the user-input interrupt node.');
      break;
    case 'builtin:read_plan':
      value = await executePlanV1('read', input, undefined, mechanisms?.planning);
      break;
    case 'builtin:update_plan':
      value = await executePlanV1(
        'update',
        input,
        planToolCallIdV1(request.facts),
        mechanisms?.planning,
      );
      break;
    case 'builtin:write_plan':
      value = await executePlanV1(
        'write',
        input,
        planToolCallIdV1(request.facts),
        mechanisms?.planning,
      );
      break;
    case 'builtin:task':
      value = await executeTaskV1(input, mechanisms?.subagent);
      break;
    case 'verification:deterministic':
      value = mechanisms?.verification
        ? await mechanisms.verification.execute(input)
        : operationFailure('Deterministic Verification executor is unavailable.');
      break;
    case 'subagent:start':
    case 'subagent:resume':
      value = operationFailure('Subagent lifecycle operations require the governed child Driver.');
      break;
  }
  return succeededReceipt(operationId, request.invocationId, context, value);
}

async function executePlanV1(
  action: 'read' | 'update' | 'write',
  input: Readonly<Record<string, unknown>>,
  toolCallId: string | undefined,
  mechanism: BuiltinPlanningExecutionMechanismV1 | undefined,
): Promise<BuiltinOperationExecutionValueV1> {
  if (action === 'read') {
    if (!mechanism) return operationFailure('Plan Runtime is unavailable.');
    const result = await mechanism.read(BUILTIN_READ_PLAN_SCHEMA_V1.parse(input));
    return operationResult(result.ok, result.stdout, result.stderr, result.runtimeEvents);
  }
  if (!toolCallId) {
    return operationFailure('Plan Runtime tool-call identity is unavailable.');
  }
  if (!mechanism) return operationFailure('Plan Runtime is unavailable.');
  const result =
    action === 'update'
      ? await mechanism.update(toolCallId, BUILTIN_UPDATE_PLAN_SCHEMA_V1.parse(input))
      : await mechanism.write(toolCallId, BUILTIN_WRITE_PLAN_SCHEMA_V1.parse(input));
  return operationResult(result.ok, result.stdout, result.stderr, result.runtimeEvents);
}

function planToolCallIdV1(facts: RuntimeJsonValueV1 | undefined): string | undefined {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return undefined;
  const toolCallId = (facts as Readonly<Record<string, RuntimeJsonValueV1>>).toolCallId;
  return typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : undefined;
}

async function executeTaskV1(
  input: Readonly<Record<string, unknown>>,
  mechanism: BuiltinSubagentExecutionMechanismV1 | undefined,
): Promise<BuiltinOperationExecutionValueV1> {
  if (!mechanism) return operationFailure('Sub-agent Runtime is unavailable.');
  const result = await mechanism.executeTask();
  return projectSubagentResultV1({
    input,
    result,
    phase: mechanism.phase,
  });
}

export function projectSubagentResultV1(input: {
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
  readonly phase: 'planning' | 'building';
}): BuiltinOperationExecutionValueV1 {
  try {
    const projected = projectSubagentResultPayloadV1(input.result);
    const role = subagentRoleV1(input.input.subagent_type);
    if (!role) throw new Error('Builtin subagent role is invalid.');
    const blocked = Object.hasOwn(projected, 'blocked');
    const terminalStatus = projected.terminalStatus;
    const nextActions = planningContinuationAfterPlanSubagentV1({
      phase: input.phase,
      role,
      childTerminal: true,
      childOk: projected.ok,
      childStatus: blocked ? 'suspended' : terminalStatus,
    });
    const modelContent = JSON.stringify({
      ok: projected.ok,
      summary: projected.summary,
      ...(typeof projected.error === 'string' ? { error: projected.error } : {}),
      ...(terminalStatus ? { terminalStatus } : {}),
      toolCallCount: projected.toolCallCount,
      durationMs: projected.durationMs,
      ...(nextActions.length > 0 ? { nextActions } : {}),
    });
    return Object.freeze({
      schema: 'kite.builtin-operation-result.v1',
      ok: projected.ok,
      stdout: projected.ok ? modelContent : '',
      stderr: projected.ok ? '' : modelContent,
      resultMeta: Object.freeze({}),
      subagentResult: projected,
    }) as BuiltinOperationExecutionValueV1;
  } catch {
    // A malformed child result must never become an empty or partially trusted
    // structuredContent value. The Host may classify this explicit operation
    // failure as an unknown post-ack outcome when the child already ran.
    return operationFailure('Builtin subagent result projection failed closed.');
  }
}

const SUBAGENT_RESULT_KEYS_V1 = Object.freeze([
  'blocked',
  'durationMs',
  'error',
  'executionJournal',
  'exhaustedFingerprints',
  'ok',
  'resourceAdmissionFailure',
  'steps',
  'summary',
  'terminalStatus',
  'toolCallCount',
  'toolRecovery',
] as const);

const SUBAGENT_TERMINAL_STATUSES_V1 = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'exhausted',
  'suspended',
] as const);

const SUBAGENT_BLOCKED_REASONS_V1 = Object.freeze([
  'SUBAGENT_TOOL_REQUIRES_APPROVAL',
  'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
] as const);

const SUBAGENT_RESOURCE_FAILURE_REASONS_V1 = Object.freeze([
  'budget_unconfigured',
  'persistence_unavailable',
  'budget_exhausted',
  'reconciliation_required',
  'tool_concurrency_saturated',
  'shell_concurrency_saturated',
] as const);

type ProjectedSubagentResultV1 = Readonly<{
  readonly ok: boolean;
  readonly summary: string;
  readonly toolCallCount: number;
  readonly durationMs: number;
  readonly terminalStatus?: (typeof SUBAGENT_TERMINAL_STATUSES_V1)[number];
  readonly error?: string;
  readonly resourceAdmissionFailure?: RuntimeJsonValueV1;
  readonly steps?: RuntimeJsonValueV1;
  readonly executionJournal?: RuntimeJsonValueV1;
  readonly exhaustedFingerprints?: RuntimeJsonValueV1;
  readonly toolRecovery?: RuntimeJsonValueV1;
  readonly blocked?: RuntimeJsonValueV1;
}> &
  RuntimeJsonValueV1;

function projectSubagentResultPayloadV1(
  value: Readonly<Record<string, unknown>>,
): ProjectedSubagentResultV1 {
  assertPlainDataRecordV1(value);
  assertExactKeysV1(value, SUBAGENT_RESULT_KEYS_V1, [
    'ok',
    'summary',
    'toolCallCount',
    'durationMs',
  ]);

  const ok = requireBooleanV1(value.ok, 'result.ok');
  const summary = requireStringV1(value.summary, 'result.summary');
  const toolCallCount = requireNonNegativeSafeIntegerV1(
    value.toolCallCount,
    'result.toolCallCount',
  );
  const durationMs = requireNonNegativeFiniteNumberV1(value.durationMs, 'result.durationMs');
  const terminalStatus = Object.hasOwn(value, 'terminalStatus')
    ? requireOneOfV1(value.terminalStatus, SUBAGENT_TERMINAL_STATUSES_V1, 'result.terminalStatus')
    : undefined;

  if (ok && terminalStatus !== undefined && terminalStatus !== 'completed') {
    throw new Error('Successful subagent result has a non-completed terminal status.');
  }
  if (!ok && terminalStatus === 'completed') {
    throw new Error('Failed subagent result has a completed terminal status.');
  }

  const projected: Record<string, RuntimeJsonValueV1> = {
    ok,
    summary,
    toolCallCount,
    durationMs,
  };
  if (terminalStatus !== undefined) projected.terminalStatus = terminalStatus;
  if (Object.hasOwn(value, 'error')) {
    projected.error = requireStringV1(value.error, 'result.error');
  }
  if (Object.hasOwn(value, 'resourceAdmissionFailure')) {
    projected.resourceAdmissionFailure = projectResourceAdmissionFailureV1(
      value.resourceAdmissionFailure,
    );
  }
  if (Object.hasOwn(value, 'steps')) projected.steps = projectSubagentStepsV1(value.steps);
  if (Object.hasOwn(value, 'executionJournal')) {
    projected.executionJournal = projectExecutionJournalV1(value.executionJournal);
  }
  if (Object.hasOwn(value, 'exhaustedFingerprints')) {
    projected.exhaustedFingerprints = projectExhaustedFingerprintsV1(value.exhaustedFingerprints);
  }
  if (Object.hasOwn(value, 'toolRecovery')) {
    projected.toolRecovery = cloneRuntimeJsonV1(value.toolRecovery, 'result.toolRecovery');
    if (!isPlainRecordV1(projected.toolRecovery)) {
      throw new Error('Subagent tool recovery journal must be an object.');
    }
  }
  if (Object.hasOwn(value, 'blocked')) {
    if (ok || terminalStatus !== 'suspended') {
      throw new Error('Blocked subagent result must be a failed suspended result.');
    }
    projected.blocked = projectBlockedSubagentV1(value.blocked);
  }
  return freezeRuntimeJsonV1(projected) as ProjectedSubagentResultV1;
}

function projectResourceAdmissionFailureV1(value: unknown): RuntimeJsonValueV1 {
  const record = requirePlainRecordV1(value, 'result.resourceAdmissionFailure');
  assertExactKeysV1(record, SUBAGENT_RESOURCE_FAILURE_KEYS_V1, [
    'reason',
    'message',
    'parentInvocationId',
    'parentToolCallId',
    'childInvocationId',
  ]);
  return freezeRuntimeJsonV1({
    reason: requireOneOfV1(record.reason, SUBAGENT_RESOURCE_FAILURE_REASONS_V1, 'failure.reason'),
    message: requireStringV1(record.message, 'failure.message'),
    parentInvocationId: requireNonEmptyStringV1(
      record.parentInvocationId,
      'failure.parentInvocationId',
    ),
    parentToolCallId: requireNonEmptyStringV1(record.parentToolCallId, 'failure.parentToolCallId'),
    childInvocationId: requireNonEmptyStringV1(
      record.childInvocationId,
      'failure.childInvocationId',
    ),
  });
}

const SUBAGENT_RESOURCE_FAILURE_KEYS_V1 = Object.freeze([
  'childInvocationId',
  'message',
  'parentInvocationId',
  'parentToolCallId',
  'reason',
] as const);

function projectSubagentStepsV1(value: unknown): RuntimeJsonValueV1 {
  if (!Array.isArray(value)) throw new Error('Subagent steps must be an array.');
  return freezeRuntimeJsonV1(
    value.map((step, index) => {
      const record = requirePlainRecordV1(step, `result.steps[${index}]`);
      assertExactKeysV1(
        record,
        ['ok', 'status', 'toolArgs', 'toolName', 'totalLines'],
        ['status', 'toolArgs', 'toolName'],
      );
      const projected: Record<string, RuntimeJsonValueV1> = {
        toolName: requireNonEmptyStringV1(record.toolName, `result.steps[${index}].toolName`),
        toolArgs: cloneRecordJsonV1(record.toolArgs, `result.steps[${index}].toolArgs`),
        status: requireOneOfV1(
          record.status,
          ['pending', 'awaiting_approval', 'success', 'rejected', 'error'] as const,
          `result.steps[${index}].status`,
        ),
      };
      if (Object.hasOwn(record, 'ok')) {
        projected.ok = requireBooleanV1(record.ok, `result.steps[${index}].ok`);
      }
      if (Object.hasOwn(record, 'totalLines')) {
        projected.totalLines = requireNonNegativeSafeIntegerV1(
          record.totalLines,
          `result.steps[${index}].totalLines`,
        );
      }
      return projected;
    }),
  );
}

function projectExecutionJournalV1(value: unknown): RuntimeJsonValueV1 {
  if (!Array.isArray(value)) throw new Error('Subagent execution journal must be an array.');
  return freezeRuntimeJsonV1(
    value.map((entry, index) => {
      const record = requirePlainRecordV1(entry, `result.executionJournal[${index}]`);
      assertExactKeysV1(
        record,
        [
          'errorCode',
          'fingerprint',
          'finishedAt',
          'startedAt',
          'status',
          'stderrDigest',
          'toolCallId',
          'toolName',
        ],
        ['startedAt', 'status', 'toolCallId', 'toolName'],
      );
      const projected: Record<string, RuntimeJsonValueV1> = {
        toolCallId: requireNonEmptyStringV1(
          record.toolCallId,
          `result.executionJournal[${index}].toolCallId`,
        ),
        toolName: requireNonEmptyStringV1(
          record.toolName,
          `result.executionJournal[${index}].toolName`,
        ),
        status: requireOneOfV1(
          record.status,
          ['running', 'applied', 'failed', 'cancelled'] as const,
          `result.executionJournal[${index}].status`,
        ),
        startedAt: requireFiniteNumberV1(
          record.startedAt,
          `result.executionJournal[${index}].startedAt`,
        ),
      };
      for (const key of ['finishedAt', 'errorCode', 'fingerprint', 'stderrDigest'] as const) {
        if (!Object.hasOwn(record, key)) continue;
        projected[key] =
          key === 'finishedAt'
            ? requireFiniteNumberV1(record[key], `result.executionJournal[${index}].${key}`)
            : requireStringV1(record[key], `result.executionJournal[${index}].${key}`);
      }
      return projected;
    }),
  );
}

function projectExhaustedFingerprintsV1(value: unknown): RuntimeJsonValueV1 {
  const record = requirePlainRecordV1(value, 'result.exhaustedFingerprints');
  const projected: Record<string, RuntimeJsonValueV1> = {};
  for (const key of ownStringKeysV1(record)) {
    if (record[key] !== true) throw new Error('Exhausted fingerprint values must be true.');
    projected[key] = true;
  }
  return freezeRuntimeJsonV1(projected);
}

function projectBlockedSubagentV1(value: unknown): RuntimeJsonValueV1 {
  const blocked = requirePlainRecordV1(value, 'result.blocked');
  assertExactKeysV1(
    blocked,
    [
      'approvalBinding',
      'args',
      'command',
      'continuation',
      'message',
      'reasonCode',
      'runtimeToolCallId',
      'toolCallId',
      'toolName',
    ],
    ['args', 'command', 'continuation', 'reasonCode', 'toolCallId', 'toolName'],
  );
  const reasonCode = requireOneOfV1(
    blocked.reasonCode,
    SUBAGENT_BLOCKED_REASONS_V1,
    'result.blocked.reasonCode',
  );
  const toolCallId = requireNonEmptyStringV1(blocked.toolCallId, 'result.blocked.toolCallId');
  const toolName = requireNonEmptyStringV1(blocked.toolName, 'result.blocked.toolName');
  const args = cloneRecordJsonV1(blocked.args, 'result.blocked.args');
  const command = requireStringV1(blocked.command, 'result.blocked.command');
  const runtimeToolCallId = Object.hasOwn(blocked, 'runtimeToolCallId')
    ? requireNonEmptyStringV1(blocked.runtimeToolCallId, 'result.blocked.runtimeToolCallId')
    : undefined;
  const projected: Record<string, RuntimeJsonValueV1> = {
    reasonCode,
    toolCallId,
    toolName,
    args,
    command,
    continuation: projectBlockedContinuationV1(blocked.continuation, {
      reasonCode,
      toolCallId,
      toolName,
      args,
      command,
      runtimeToolCallId,
    }),
  };
  if (runtimeToolCallId !== undefined) projected.runtimeToolCallId = runtimeToolCallId;
  return freezeRuntimeJsonV1(projected);
}

function projectBlockedContinuationV1(
  value: unknown,
  blocked: {
    readonly reasonCode: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: Readonly<Record<string, RuntimeJsonValueV1>>;
    readonly command: string;
    readonly runtimeToolCallId: string | undefined;
  },
): RuntimeJsonValueV1 {
  const continuation = requirePlainRecordV1(value, 'result.blocked.continuation');
  assertExactKeysV1(
    continuation,
    [
      'allowedTools',
      'executionJournal',
      'exhaustedFingerprints',
      'id',
      'mcpBindingIds',
      'messages',
      'modelInvocationOrdinal',
      'projectInstructions',
      'role',
      'steps',
      'task',
      'toolCallCount',
      'toolRecovery',
    ],
    ['id', 'messages', 'role', 'steps', 'task', 'toolCallCount', 'toolRecovery'],
  );
  const id = requireNonEmptyStringV1(continuation.id, 'result.blocked.continuation.id');
  const roleRecord = requirePlainRecordV1(continuation.role, 'result.blocked.continuation.role');
  const role = subagentRoleV1(roleRecord.role);
  if (!role) throw new Error('Blocked continuation role is invalid.');
  if (!Array.isArray(continuation.messages) || !Array.isArray(continuation.steps)) {
    throw new Error('Blocked continuation private arrays are malformed.');
  }
  requireStringV1(continuation.task, 'result.blocked.continuation.task');
  requireNonNegativeSafeIntegerV1(
    continuation.toolCallCount,
    'result.blocked.continuation.toolCallCount',
  );
  requirePlainRecordV1(continuation.toolRecovery, 'result.blocked.continuation.toolRecovery');
  const modelInvocationOrdinal = Object.hasOwn(continuation, 'modelInvocationOrdinal')
    ? requireNonNegativeSafeIntegerV1(
        continuation.modelInvocationOrdinal,
        'result.blocked.continuation.modelInvocationOrdinal',
      )
    : 0;
  const blockedTool = continuationBlockedToolV1(continuation, blocked);
  return freezeRuntimeJsonV1({
    id,
    role,
    modelInvocationOrdinal,
    blockedTool,
  });
}

function continuationBlockedToolV1(
  continuation: Readonly<Record<string, unknown>>,
  blocked: {
    readonly reasonCode: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: Readonly<Record<string, RuntimeJsonValueV1>>;
    readonly command: string;
    readonly runtimeToolCallId: string | undefined;
  },
): RuntimeJsonValueV1 {
  const source = continuation.blockedTool;
  if (source !== undefined) throw new Error('Continuation contains an unexpected blockedTool.');
  const projected: Record<string, RuntimeJsonValueV1> = {
    reasonCode: blocked.reasonCode,
    toolCallId: blocked.toolCallId,
    toolName: blocked.toolName,
    args: blocked.args,
    command: blocked.command,
  };
  if (blocked.runtimeToolCallId !== undefined) {
    projected.runtimeToolCallId = blocked.runtimeToolCallId;
  }
  return freezeRuntimeJsonV1(projected);
}

function subagentRoleV1(value: unknown): SubagentRoleV1 | undefined {
  return value === 'explore' || value === 'plan' || value === 'code' || value === 'review'
    ? value
    : undefined;
}

function assertExactKeysV1(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const keys = ownStringKeysV1(value);
  if (
    keys.some((key) => !allowedSet.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error('Builtin subagent result contains an unsupported field shape.');
  }
}

function requirePlainRecordV1(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isPlainRecordV1(value)) throw new Error(`${path} must be a plain object.`);
  assertPlainDataRecordV1(value);
  return value;
}

function assertPlainDataRecordV1(value: Readonly<Record<string, unknown>>): void {
  if (!isPlainRecordV1(value)) throw new Error('Value must be a plain object.');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('JSON projection cannot contain symbol keys.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error('JSON projection cannot invoke accessor properties.');
    }
  }
}

function isPlainRecordV1(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownStringKeysV1(value: Readonly<Record<string, unknown>>): readonly string[] {
  return Reflect.ownKeys(value).map((key) => {
    if (typeof key !== 'string') throw new Error('JSON projection cannot contain symbol keys.');
    return key;
  });
}

function requireBooleanV1(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be boolean.`);
  return value;
}

function requireStringV1(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be string.`);
  return value;
}

function requireNonEmptyStringV1(value: unknown, path: string): string {
  const string = requireStringV1(value, path);
  if (string.length === 0) throw new Error(`${path} must not be empty.`);
  return string;
}

function requireFiniteNumberV1(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be finite.`);
  }
  return value;
}

function requireNonNegativeFiniteNumberV1(value: unknown, path: string): number {
  const number = requireFiniteNumberV1(value, path);
  if (number < 0) throw new Error(`${path} must not be negative.`);
  return number;
}

function requireNonNegativeSafeIntegerV1(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }
  return value;
}

function requireOneOfV1<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${path} has an unsupported value.`);
  }
  return value as T[number];
}

function cloneRecordJsonV1(
  value: unknown,
  path: string,
): Readonly<Record<string, RuntimeJsonValueV1>> {
  const cloned = cloneRuntimeJsonV1(value, path);
  if (!isPlainRecordV1(cloned)) throw new Error(`${path} must be a JSON object.`);
  return cloned;
}

function cloneRuntimeJsonV1(value: unknown, path: string): RuntimeJsonValueV1 {
  return cloneRuntimeJsonValueV1(value, path, new WeakSet<object>());
}

function cloneRuntimeJsonValueV1(
  value: unknown,
  path: string,
  active: WeakSet<object>,
): RuntimeJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number.`);
    return value;
  }
  if (typeof value !== 'object') throw new Error(`${path} contains a non-JSON value.`);
  if (active.has(value)) throw new Error(`${path} contains a cycle.`);
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new Error(`${path} is not a plain JSON array.`);
      }
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (typeof key === 'symbol' || (key !== 'length' && !arrayIndexKeyV1(key))) {
          throw new Error(`${path} contains an unsupported array field.`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(`${path} contains an accessor.`);
        }
      }
      const result: RuntimeJsonValueV1[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error(`${path} contains a sparse array.`);
        result.push(cloneRuntimeJsonValueV1(value[index], `${path}[${index}]`, active));
      }
      return result;
    }
    if (!isPlainRecordV1(value)) throw new Error(`${path} is not a plain JSON object.`);
    const result: Record<string, RuntimeJsonValueV1> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(`${path} contains a symbol key.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor))
        throw new Error(`${path}.${key} is an accessor.`);
      result[key] = cloneRuntimeJsonValueV1(descriptor.value, `${path}.${key}`, active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

function arrayIndexKeyV1(value: string): boolean {
  const index = Number(value);
  return (
    Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === value
  );
}

function freezeRuntimeJsonV1(value: RuntimeJsonValueV1): RuntimeJsonValueV1 {
  if (Array.isArray(value)) {
    value.forEach(freezeRuntimeJsonV1);
  } else if (isPlainRecordV1(value)) {
    Object.values(value).forEach(freezeRuntimeJsonV1);
  }
  return Object.freeze(value);
}

export function planningContinuationAfterPlanSubagentV1(input: {
  readonly phase: 'planning' | 'building';
  readonly role: SubagentRoleV1;
  readonly childTerminal: boolean;
  readonly childOk?: boolean;
  readonly childStatus?: string;
}): readonly ['write_plan:save', 'write_plan:submit'] | readonly [] {
  return input.phase === 'planning' &&
    input.role === 'plan' &&
    input.childTerminal &&
    input.childOk !== false &&
    (input.childStatus === undefined || input.childStatus === 'completed')
    ? (['write_plan:save', 'write_plan:submit'] as const)
    : [];
}

export function validateDelegatedTaskV1(input: {
  readonly delegatedTask: string;
}): Readonly<{ valid: boolean; reason: 'valid' | 'task_not_bounded' }> {
  const task = input.delegatedTask.trim();
  return task.length >= 8 && task.length <= 8_000
    ? { valid: true, reason: 'valid' }
    : { valid: false, reason: 'task_not_bounded' };
}

function validateInputV1(
  operationId: Rmv114OperationIdV1,
  input: Readonly<Record<string, unknown>>,
): boolean {
  const schema =
    operationId === 'builtin:ask_user'
      ? BUILTIN_ZOD_SCHEMAS_V1['builtin:ask_user']
      : operationId === 'builtin:read_plan'
        ? BUILTIN_ZOD_SCHEMAS_V1['builtin:read_plan']
        : operationId === 'builtin:update_plan'
          ? BUILTIN_ZOD_SCHEMAS_V1['builtin:update_plan']
          : operationId === 'builtin:write_plan'
            ? BUILTIN_ZOD_SCHEMAS_V1['builtin:write_plan']
            : operationId === 'builtin:task'
              ? BUILTIN_ZOD_SCHEMAS_V1['builtin:task']
              : BUILTIN_ZOD_SCHEMAS_V1['subagent:start'];
  return schema.safeParse(input).success;
}

function succeededReceipt(
  operationId: Rmv114OperationIdV1,
  invocationId: string,
  context: CapabilityExecutionContextV1,
  value: BuiltinOperationExecutionValueV1,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_14_PROVIDER_ID_V1,
    executorRevision: RMV1_14_EXECUTOR_REVISIONS_V1[operationId],
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  operationId: Rmv114OperationIdV1,
  invocationId: string,
  context: CapabilityExecutionContextV1,
  code: string,
): ExecutionReceiptV1 {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: RMV1_14_PROVIDER_ID_V1,
    executorRevision: RMV1_14_EXECUTOR_REVISIONS_V1[operationId],
    requestDigest: context.requestDigest,
    status: 'failed',
    dispatchCertainty: 'none',
    cleanupCertainty: 'not_required',
    failure: Object.freeze({
      code,
      message: 'RMV1-14 operation input is invalid.',
      retryable: false,
    }),
  });
}

function operationResult(
  ok: boolean,
  stdout: string,
  stderr: string,
  runtimeEvents?: readonly BuiltinRuntimeEventValueV1[],
): BuiltinOperationExecutionValueV1 {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok,
    stdout: ok ? stdout : '',
    stderr: ok ? '' : stderr,
    resultMeta: Object.freeze({}),
    ...(ok && runtimeEvents ? { runtimeEvents } : {}),
  }) as BuiltinOperationExecutionValueV1;
}

function operationFailure(stderr: string): BuiltinOperationExecutionValueV1 {
  return operationResult(false, '', stderr);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
