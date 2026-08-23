import type { UserInputRequest } from '@kite/runtime-contract';
import type {
  CapabilityEffects,
  CapabilityExecutionContext,
  CapabilityExecutionMechanism,
  CapabilityExecutor,
  ExecutionReceipt,
  RuntimeJsonValue,
  RuntimeModule,
  RuntimeModuleRegistryWriter,
  SubagentRole,
} from '@kite/runtime-spi';
import { defineRuntimeModule } from '@kite/runtime-spi';
import type { z } from 'zod';
import { digestCapabilityBindingValue } from './capability-binding';
import {
  builtinExecutionTraits,
  defineBuiltinCapabilityContract,
  parserForBuiltinOperation,
  staticEffectsClassifier,
  taskAvailability,
  taskEffectsClassifier,
  taskModelInputSchema,
  taskModelParser,
  taskModelSchema,
  taskRuntimeParser,
} from './catalog-contract';
import type { BuiltinOperationExecutionValue, BuiltinRuntimeEventValue } from './model-operations';
import {
  askUserBuiltinPolicyRule,
  createBuiltinPolicyCompiler,
  planBuiltinPolicyRule,
  taskBuiltinPolicyRule,
} from './policy-compiler';
import { builtinToolDescription } from './tool-contracts';
import {
  BUILTIN_JSON_SCHEMAS_,
  BUILTIN_READ_PLAN_SCHEMA_,
  BUILTIN_UPDATE_PLAN_SCHEMA_,
  BUILTIN_WRITE_PLAN_SCHEMA_,
  BUILTIN_ZOD_SCHEMAS_,
} from './tool-schemas';

export const SUBAGENT_PROVIDER_ID_ = 'kite-builtin-runtime-rmv1-14' as const;

export const SUBAGENT_OPERATION_IDS_ = Object.freeze([
  'builtin:ask_user',
  'builtin:read_plan',
  'builtin:update_plan',
  'builtin:write_plan',
  'builtin:task',
  'subagent:start',
  'subagent:resume',
  'verification:deterministic',
] as const);

export type SubagentOperationId = (typeof SUBAGENT_OPERATION_IDS_)[number];
export type SubagentToolOperationId = Extract<SubagentOperationId, `builtin:${string}`>;

export function isBuiltinSubagentTaskToolName(value: unknown): value is 'task' {
  return value === SUBAGENT_OPERATION_IDS_[4].slice('builtin:'.length);
}

export const ASK_USER_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:ask_user'];
export const READ_PLAN_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:read_plan'];
export const UPDATE_PLAN_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:update_plan'];
export const WRITE_PLAN_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:write_plan'];
export const TASK_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:task'];

/**
 * Normalize the Builtin-owned ask_user input into the Host interrupt payload.
 * The Runtime Controller remains the sole interrupt owner; this helper owns
 * only the Builtin format semantics already enforced by the canonical parser.
 */
export function normalizeAskUserRequest(input: RuntimeJsonValue): UserInputRequest {
  const parsed = BUILTIN_ZOD_SCHEMAS_['builtin:ask_user'].parse(input);
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

const INPUT_SCHEMAS_: Readonly<
  Record<SubagentOperationId, Readonly<Record<string, RuntimeJsonValue>>>
> = Object.freeze({
  'builtin:ask_user': ASK_USER_INPUT_SCHEMA_,
  'builtin:read_plan': READ_PLAN_INPUT_SCHEMA_,
  'builtin:update_plan': UPDATE_PLAN_INPUT_SCHEMA_,
  'builtin:write_plan': WRITE_PLAN_INPUT_SCHEMA_,
  'builtin:task': TASK_INPUT_SCHEMA_,
  'subagent:start': BUILTIN_JSON_SCHEMAS_['subagent:start'],
  'subagent:resume': BUILTIN_JSON_SCHEMAS_['subagent:resume'],
  'verification:deterministic': BUILTIN_JSON_SCHEMAS_['verification:deterministic'],
});

const EFFECTS_ = Object.freeze({
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

const EXECUTION_MECHANISMS_: Readonly<Record<SubagentOperationId, CapabilityExecutionMechanism>> =
  Object.freeze({
    'builtin:ask_user': 'user_input',
    'builtin:read_plan': 'planning',
    'builtin:update_plan': 'planning',
    'builtin:write_plan': 'planning',
    'builtin:task': 'subagent',
    'subagent:start': 'subagent',
    'subagent:resume': 'subagent',
    'verification:deterministic': 'verification',
  });

export const SUBAGENT_CAPABILITY_REVISIONS_: Readonly<Record<SubagentOperationId, string>> =
  Object.freeze(
    Object.fromEntries(
      SUBAGENT_OPERATION_IDS_.map((operationId) => [
        operationId,
        digestCapabilityBindingValue({
          schema: 'kite.rmv1-14-operation-capability.v1',
          operationId,
          inputSchema: INPUT_SCHEMAS_[operationId],
          effects: EFFECTS_[operationId],
        }),
      ]),
    ) as Record<SubagentOperationId, string>,
  );

export const SUBAGENT_EXECUTOR_REVISIONS_: Readonly<Record<SubagentOperationId, string>> =
  Object.freeze(
    Object.fromEntries(
      SUBAGENT_OPERATION_IDS_.map((operationId) => [
        operationId,
        digestCapabilityBindingValue({
          schema: 'kite.rmv1-14-operation-executor.v1',
          operationId,
          capabilityRevision: SUBAGENT_CAPABILITY_REVISIONS_[operationId],
        }),
      ]),
    ) as Record<SubagentOperationId, string>,
  );

export interface BuiltinPlanActionResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly runtimeEvents?: readonly BuiltinRuntimeEventValue[];
}

export type BuiltinReadPlanInput = z.infer<typeof BUILTIN_READ_PLAN_SCHEMA_>;
export type BuiltinUpdatePlanInput = z.infer<typeof BUILTIN_UPDATE_PLAN_SCHEMA_>;
export type BuiltinWritePlanInput = z.infer<typeof BUILTIN_WRITE_PLAN_SCHEMA_>;

export interface BuiltinPlanningExecutionMechanism {
  read(input: BuiltinReadPlanInput): Promise<BuiltinPlanActionResult>;
  update(toolCallId: string, input: BuiltinUpdatePlanInput): Promise<BuiltinPlanActionResult>;
  write(toolCallId: string, input: BuiltinWritePlanInput): Promise<BuiltinPlanActionResult>;
}

export interface BuiltinSubagentExecutionMechanism {
  readonly phase: 'planning' | 'building';
  executeTask(): Promise<Readonly<Record<string, unknown>>>;
}

export interface BuiltinVerificationExecutionMechanism {
  execute(input: Readonly<Record<string, unknown>>): Promise<BuiltinOperationExecutionValue>;
}

export interface SubagentExecutionMechanisms extends Readonly<Record<string, unknown>> {
  readonly planning?: BuiltinPlanningExecutionMechanism;
  readonly subagent?: BuiltinSubagentExecutionMechanism;
  readonly verification?: BuiltinVerificationExecutionMechanism;
}

export function createSubagentRuntimeModule(): RuntimeModule {
  return defineRuntimeModule({
    moduleId: 'kite-builtin-runtime-rmv1-14',
    providerId: SUBAGENT_PROVIDER_ID_,
    revision: 'rmv1-14',
    operationIds: SUBAGENT_OPERATION_IDS_,
    register: registerSubagentOperations,
  });
}

function registerSubagentOperations(registry: RuntimeModuleRegistryWriter): void {
  for (const operationId of SUBAGENT_OPERATION_IDS_) {
    const capabilityRevision = SUBAGENT_CAPABILITY_REVISIONS_[operationId];
    registry.registerCapability(
      defineBuiltinCapabilityContract(
        {
          capabilityId: operationId,
          revision: capabilityRevision,
          providerId: SUBAGENT_PROVIDER_ID_,
          title: `Builtin Runtime operation ${operationId}`,
          executionMechanism: EXECUTION_MECHANISMS_[operationId],
          ...(operationId.startsWith('builtin:')
            ? {
                toolName: operationId.slice('builtin:'.length),
                description: builtinToolDescription(operationId.slice('builtin:'.length)),
                visibility: 'model' as const,
              }
            : { visibility: 'internal' as const }),
          effects: EFFECTS_[operationId],
          inputSchema: INPUT_SCHEMAS_[operationId],
          inputSchemaDigest: digestCapabilityBindingValue(INPUT_SCHEMAS_[operationId]),
        },
        subagentContractOptions(operationId, capabilityRevision, EFFECTS_[operationId]),
      ),
    );
    registry.registerExecutor({
      providerId: SUBAGENT_PROVIDER_ID_,
      capabilityId: operationId,
      capabilityRevision,
      executorRevision: SUBAGENT_EXECUTOR_REVISIONS_[operationId],
      execute: (request, context) => executeSubagentOperation(operationId, request, context),
    } satisfies CapabilityExecutor);
  }
}

function subagentContractOptions(
  operationId: SubagentOperationId,
  revision: string,
  effects: CapabilityEffects,
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
    ? taskRuntimeParser(revision)
    : parserForBuiltinOperation(operationId, revision);
  const policyRule = askUser
    ? askUserBuiltinPolicyRule
    : task
      ? taskBuiltinPolicyRule
      : planBuiltinPolicyRule;
  return {
    parser,
    ...(task
      ? {
          modelParser: taskModelParser(`${revision}:model`),
          modelSchemaForContext: taskModelSchema,
          modelInputSchemaForContext: taskModelInputSchema,
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
    ...(task ? { availability: taskAvailability } : {}),
    effectsClassifier: task
      ? taskEffectsClassifier(effects)
      : staticEffectsClassifier(
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
                : 'Internal RM-14 lifecycle operation is Host-routed.',
          effects,
        ),
    ...(modelVisible
      ? {
          policyCompiler: createBuiltinPolicyCompiler({
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
          executionTraitsDeclaration: builtinExecutionTraits({
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

async function executeSubagentOperation(
  operationId: SubagentOperationId,
  request: Parameters<CapabilityExecutor['execute']>[0],
  context: CapabilityExecutionContext,
): Promise<ExecutionReceipt> {
  const input = asRecord(request.input);
  if (!input || !validateInput(operationId, input)) {
    return failedReceipt(operationId, request.invocationId, context, 'invalid_input');
  }
  const mechanisms = context.environment.mechanisms as SubagentExecutionMechanisms | undefined;
  let value: BuiltinOperationExecutionValue;
  switch (operationId) {
    case 'builtin:ask_user':
      value = operationFailure('ask_user must be handled by the user-input interrupt node.');
      break;
    case 'builtin:read_plan':
      value = await executePlan('read', input, undefined, mechanisms?.planning);
      break;
    case 'builtin:update_plan':
      value = await executePlan(
        'update',
        input,
        planToolCallId(request.facts),
        mechanisms?.planning,
      );
      break;
    case 'builtin:write_plan':
      value = await executePlan(
        'write',
        input,
        planToolCallId(request.facts),
        mechanisms?.planning,
      );
      break;
    case 'builtin:task':
      value = await executeTask(input, mechanisms?.subagent);
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

async function executePlan(
  action: 'read' | 'update' | 'write',
  input: Readonly<Record<string, unknown>>,
  toolCallId: string | undefined,
  mechanism: BuiltinPlanningExecutionMechanism | undefined,
): Promise<BuiltinOperationExecutionValue> {
  if (action === 'read') {
    if (!mechanism) return operationFailure('Plan Runtime is unavailable.');
    const result = await mechanism.read(BUILTIN_READ_PLAN_SCHEMA_.parse(input));
    return operationResult(result.ok, result.stdout, result.stderr, result.runtimeEvents);
  }
  if (!toolCallId) {
    return operationFailure('Plan Runtime tool-call identity is unavailable.');
  }
  if (!mechanism) return operationFailure('Plan Runtime is unavailable.');
  const result =
    action === 'update'
      ? await mechanism.update(toolCallId, BUILTIN_UPDATE_PLAN_SCHEMA_.parse(input))
      : await mechanism.write(toolCallId, BUILTIN_WRITE_PLAN_SCHEMA_.parse(input));
  return operationResult(result.ok, result.stdout, result.stderr, result.runtimeEvents);
}

function planToolCallId(facts: RuntimeJsonValue | undefined): string | undefined {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return undefined;
  const toolCallId = (facts as Readonly<Record<string, RuntimeJsonValue>>).toolCallId;
  return typeof toolCallId === 'string' && toolCallId.length > 0 ? toolCallId : undefined;
}

async function executeTask(
  input: Readonly<Record<string, unknown>>,
  mechanism: BuiltinSubagentExecutionMechanism | undefined,
): Promise<BuiltinOperationExecutionValue> {
  if (!mechanism) return operationFailure('Sub-agent Runtime is unavailable.');
  const result = await mechanism.executeTask();
  return projectSubagentResult({
    input,
    result,
    phase: mechanism.phase,
  });
}

export function projectSubagentResult(input: {
  readonly input: Readonly<Record<string, unknown>>;
  readonly result: Readonly<Record<string, unknown>>;
  readonly phase: 'planning' | 'building';
}): BuiltinOperationExecutionValue {
  try {
    const projected = projectSubagentResultPayload(input.result);
    const role = subagentRole(input.input.subagent_type);
    if (!role) throw new Error('Builtin subagent role is invalid.');
    const blocked = Object.hasOwn(projected, 'blocked');
    const terminalStatus = projected.terminalStatus;
    const nextActions = planningContinuationAfterPlanSubagent({
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
    }) as BuiltinOperationExecutionValue;
  } catch {
    // A malformed child result must never become an empty or partially trusted
    // structuredContent value. The Host may classify this explicit operation
    // failure as an unknown post-ack outcome when the child already ran.
    return operationFailure('Builtin subagent result projection failed closed.');
  }
}

const SUBAGENT_RESULT_KEYS_ = Object.freeze([
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

const SUBAGENT_TERMINAL_STATUSES_ = Object.freeze([
  'completed',
  'failed',
  'cancelled',
  'exhausted',
  'suspended',
] as const);

const SUBAGENT_BLOCKED_REASONS_ = Object.freeze([
  'SUBAGENT_TOOL_REQUIRES_APPROVAL',
  'SUBAGENT_TOOL_REQUIRES_AUTO_REVIEW',
] as const);

const SUBAGENT_RESOURCE_FAILURE_REASONS_ = Object.freeze([
  'budget_unconfigured',
  'persistence_unavailable',
  'budget_exhausted',
  'reconciliation_required',
  'tool_concurrency_saturated',
  'shell_concurrency_saturated',
] as const);

type ProjectedSubagentResult = Readonly<{
  readonly ok: boolean;
  readonly summary: string;
  readonly toolCallCount: number;
  readonly durationMs: number;
  readonly terminalStatus?: (typeof SUBAGENT_TERMINAL_STATUSES_)[number];
  readonly error?: string;
  readonly resourceAdmissionFailure?: RuntimeJsonValue;
  readonly steps?: RuntimeJsonValue;
  readonly executionJournal?: RuntimeJsonValue;
  readonly exhaustedFingerprints?: RuntimeJsonValue;
  readonly toolRecovery?: RuntimeJsonValue;
  readonly blocked?: RuntimeJsonValue;
}> &
  RuntimeJsonValue;

function projectSubagentResultPayload(
  value: Readonly<Record<string, unknown>>,
): ProjectedSubagentResult {
  assertPlainDataRecord(value);
  assertExactKeys(value, SUBAGENT_RESULT_KEYS_, ['ok', 'summary', 'toolCallCount', 'durationMs']);

  const ok = requireBoolean(value.ok, 'result.ok');
  const summary = requireString(value.summary, 'result.summary');
  const toolCallCount = requireNonNegativeSafeInteger(value.toolCallCount, 'result.toolCallCount');
  const durationMs = requireNonNegativeFiniteNumber(value.durationMs, 'result.durationMs');
  const terminalStatus = Object.hasOwn(value, 'terminalStatus')
    ? requireOneOf(value.terminalStatus, SUBAGENT_TERMINAL_STATUSES_, 'result.terminalStatus')
    : undefined;

  if (ok && terminalStatus !== undefined && terminalStatus !== 'completed') {
    throw new Error('Successful subagent result has a non-completed terminal status.');
  }
  if (!ok && terminalStatus === 'completed') {
    throw new Error('Failed subagent result has a completed terminal status.');
  }

  const projected: Record<string, RuntimeJsonValue> = {
    ok,
    summary,
    toolCallCount,
    durationMs,
  };
  if (terminalStatus !== undefined) projected.terminalStatus = terminalStatus;
  if (Object.hasOwn(value, 'error')) {
    projected.error = requireString(value.error, 'result.error');
  }
  if (Object.hasOwn(value, 'resourceAdmissionFailure')) {
    projected.resourceAdmissionFailure = projectResourceAdmissionFailure(
      value.resourceAdmissionFailure,
    );
  }
  if (Object.hasOwn(value, 'steps')) projected.steps = projectSubagentSteps(value.steps);
  if (Object.hasOwn(value, 'executionJournal')) {
    projected.executionJournal = projectExecutionJournal(value.executionJournal);
  }
  if (Object.hasOwn(value, 'exhaustedFingerprints')) {
    projected.exhaustedFingerprints = projectExhaustedFingerprints(value.exhaustedFingerprints);
  }
  if (Object.hasOwn(value, 'toolRecovery')) {
    projected.toolRecovery = cloneRuntimeJson(value.toolRecovery, 'result.toolRecovery');
    if (!isPlainRecord(projected.toolRecovery)) {
      throw new Error('Subagent tool recovery journal must be an object.');
    }
  }
  if (Object.hasOwn(value, 'blocked')) {
    if (ok || terminalStatus !== 'suspended') {
      throw new Error('Blocked subagent result must be a failed suspended result.');
    }
    projected.blocked = projectBlockedSubagent(value.blocked);
  }
  return freezeRuntimeJson(projected) as ProjectedSubagentResult;
}

function projectResourceAdmissionFailure(value: unknown): RuntimeJsonValue {
  const record = requirePlainRecord(value, 'result.resourceAdmissionFailure');
  assertExactKeys(record, SUBAGENT_RESOURCE_FAILURE_KEYS_, [
    'reason',
    'message',
    'parentInvocationId',
    'parentToolCallId',
    'childInvocationId',
  ]);
  return freezeRuntimeJson({
    reason: requireOneOf(record.reason, SUBAGENT_RESOURCE_FAILURE_REASONS_, 'failure.reason'),
    message: requireString(record.message, 'failure.message'),
    parentInvocationId: requireNonEmptyString(
      record.parentInvocationId,
      'failure.parentInvocationId',
    ),
    parentToolCallId: requireNonEmptyString(record.parentToolCallId, 'failure.parentToolCallId'),
    childInvocationId: requireNonEmptyString(record.childInvocationId, 'failure.childInvocationId'),
  });
}

const SUBAGENT_RESOURCE_FAILURE_KEYS_ = Object.freeze([
  'childInvocationId',
  'message',
  'parentInvocationId',
  'parentToolCallId',
  'reason',
] as const);

function projectSubagentSteps(value: unknown): RuntimeJsonValue {
  if (!Array.isArray(value)) throw new Error('Subagent steps must be an array.');
  return freezeRuntimeJson(
    value.map((step, index) => {
      const record = requirePlainRecord(step, `result.steps[${index}]`);
      assertExactKeys(
        record,
        ['ok', 'status', 'toolArgs', 'toolName', 'totalLines'],
        ['status', 'toolArgs', 'toolName'],
      );
      const projected: Record<string, RuntimeJsonValue> = {
        toolName: requireNonEmptyString(record.toolName, `result.steps[${index}].toolName`),
        toolArgs: cloneRecordJson(record.toolArgs, `result.steps[${index}].toolArgs`),
        status: requireOneOf(
          record.status,
          ['pending', 'awaiting_approval', 'success', 'rejected', 'error'] as const,
          `result.steps[${index}].status`,
        ),
      };
      if (Object.hasOwn(record, 'ok')) {
        projected.ok = requireBoolean(record.ok, `result.steps[${index}].ok`);
      }
      if (Object.hasOwn(record, 'totalLines')) {
        projected.totalLines = requireNonNegativeSafeInteger(
          record.totalLines,
          `result.steps[${index}].totalLines`,
        );
      }
      return projected;
    }),
  );
}

function projectExecutionJournal(value: unknown): RuntimeJsonValue {
  if (!Array.isArray(value)) throw new Error('Subagent execution journal must be an array.');
  return freezeRuntimeJson(
    value.map((entry, index) => {
      const record = requirePlainRecord(entry, `result.executionJournal[${index}]`);
      assertExactKeys(
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
      const projected: Record<string, RuntimeJsonValue> = {
        toolCallId: requireNonEmptyString(
          record.toolCallId,
          `result.executionJournal[${index}].toolCallId`,
        ),
        toolName: requireNonEmptyString(
          record.toolName,
          `result.executionJournal[${index}].toolName`,
        ),
        status: requireOneOf(
          record.status,
          ['running', 'applied', 'failed', 'cancelled'] as const,
          `result.executionJournal[${index}].status`,
        ),
        startedAt: requireFiniteNumber(
          record.startedAt,
          `result.executionJournal[${index}].startedAt`,
        ),
      };
      for (const key of ['finishedAt', 'errorCode', 'fingerprint', 'stderrDigest'] as const) {
        if (!Object.hasOwn(record, key)) continue;
        projected[key] =
          key === 'finishedAt'
            ? requireFiniteNumber(record[key], `result.executionJournal[${index}].${key}`)
            : requireString(record[key], `result.executionJournal[${index}].${key}`);
      }
      return projected;
    }),
  );
}

function projectExhaustedFingerprints(value: unknown): RuntimeJsonValue {
  const record = requirePlainRecord(value, 'result.exhaustedFingerprints');
  const projected: Record<string, RuntimeJsonValue> = {};
  for (const key of ownStringKeys(record)) {
    if (record[key] !== true) throw new Error('Exhausted fingerprint values must be true.');
    projected[key] = true;
  }
  return freezeRuntimeJson(projected);
}

function projectBlockedSubagent(value: unknown): RuntimeJsonValue {
  const blocked = requirePlainRecord(value, 'result.blocked');
  assertExactKeys(
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
  const reasonCode = requireOneOf(
    blocked.reasonCode,
    SUBAGENT_BLOCKED_REASONS_,
    'result.blocked.reasonCode',
  );
  const toolCallId = requireNonEmptyString(blocked.toolCallId, 'result.blocked.toolCallId');
  const toolName = requireNonEmptyString(blocked.toolName, 'result.blocked.toolName');
  const args = cloneRecordJson(blocked.args, 'result.blocked.args');
  const command = requireString(blocked.command, 'result.blocked.command');
  const runtimeToolCallId = Object.hasOwn(blocked, 'runtimeToolCallId')
    ? requireNonEmptyString(blocked.runtimeToolCallId, 'result.blocked.runtimeToolCallId')
    : undefined;
  const projected: Record<string, RuntimeJsonValue> = {
    reasonCode,
    toolCallId,
    toolName,
    args,
    command,
    continuation: projectBlockedContinuation(blocked.continuation, {
      reasonCode,
      toolCallId,
      toolName,
      args,
      command,
      runtimeToolCallId,
    }),
  };
  if (runtimeToolCallId !== undefined) projected.runtimeToolCallId = runtimeToolCallId;
  return freezeRuntimeJson(projected);
}

function projectBlockedContinuation(
  value: unknown,
  blocked: {
    readonly reasonCode: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: Readonly<Record<string, RuntimeJsonValue>>;
    readonly command: string;
    readonly runtimeToolCallId: string | undefined;
  },
): RuntimeJsonValue {
  const continuation = requirePlainRecord(value, 'result.blocked.continuation');
  assertExactKeys(
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
  const id = requireNonEmptyString(continuation.id, 'result.blocked.continuation.id');
  const roleRecord = requirePlainRecord(continuation.role, 'result.blocked.continuation.role');
  const role = subagentRole(roleRecord.role);
  if (!role) throw new Error('Blocked continuation role is invalid.');
  if (!Array.isArray(continuation.messages) || !Array.isArray(continuation.steps)) {
    throw new Error('Blocked continuation private arrays are malformed.');
  }
  requireString(continuation.task, 'result.blocked.continuation.task');
  requireNonNegativeSafeInteger(
    continuation.toolCallCount,
    'result.blocked.continuation.toolCallCount',
  );
  requirePlainRecord(continuation.toolRecovery, 'result.blocked.continuation.toolRecovery');
  const modelInvocationOrdinal = Object.hasOwn(continuation, 'modelInvocationOrdinal')
    ? requireNonNegativeSafeInteger(
        continuation.modelInvocationOrdinal,
        'result.blocked.continuation.modelInvocationOrdinal',
      )
    : 0;
  const blockedTool = continuationBlockedTool(continuation, blocked);
  return freezeRuntimeJson({
    id,
    role,
    modelInvocationOrdinal,
    blockedTool,
  });
}

function continuationBlockedTool(
  continuation: Readonly<Record<string, unknown>>,
  blocked: {
    readonly reasonCode: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly args: Readonly<Record<string, RuntimeJsonValue>>;
    readonly command: string;
    readonly runtimeToolCallId: string | undefined;
  },
): RuntimeJsonValue {
  const source = continuation.blockedTool;
  if (source !== undefined) throw new Error('Continuation contains an unexpected blockedTool.');
  const projected: Record<string, RuntimeJsonValue> = {
    reasonCode: blocked.reasonCode,
    toolCallId: blocked.toolCallId,
    toolName: blocked.toolName,
    args: blocked.args,
    command: blocked.command,
  };
  if (blocked.runtimeToolCallId !== undefined) {
    projected.runtimeToolCallId = blocked.runtimeToolCallId;
  }
  return freezeRuntimeJson(projected);
}

function subagentRole(value: unknown): SubagentRole | undefined {
  return value === 'explore' || value === 'plan' || value === 'code' || value === 'review'
    ? value
    : undefined;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const keys = ownStringKeys(value);
  if (
    keys.some((key) => !allowedSet.has(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error('Builtin subagent result contains an unsupported field shape.');
  }
}

function requirePlainRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) throw new Error(`${path} must be a plain object.`);
  assertPlainDataRecord(value);
  return value;
}

function assertPlainDataRecord(value: Readonly<Record<string, unknown>>): void {
  if (!isPlainRecord(value)) throw new Error('Value must be a plain object.');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw new Error('JSON projection cannot contain symbol keys.');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error('JSON projection cannot invoke accessor properties.');
    }
  }
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownStringKeys(value: Readonly<Record<string, unknown>>): readonly string[] {
  return Reflect.ownKeys(value).map((key) => {
    if (typeof key !== 'string') throw new Error('JSON projection cannot contain symbol keys.');
    return key;
  });
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} must be boolean.`);
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`${path} must be string.`);
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  const string = requireString(value, path);
  if (string.length === 0) throw new Error(`${path} must not be empty.`);
  return string;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be finite.`);
  }
  return value;
}

function requireNonNegativeFiniteNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number < 0) throw new Error(`${path} must not be negative.`);
  return number;
}

function requireNonNegativeSafeInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative safe integer.`);
  }
  return value;
}

function requireOneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${path} has an unsupported value.`);
  }
  return value as T[number];
}

function cloneRecordJson(value: unknown, path: string): Readonly<Record<string, RuntimeJsonValue>> {
  const cloned = cloneRuntimeJson(value, path);
  if (!isPlainRecord(cloned)) throw new Error(`${path} must be a JSON object.`);
  return cloned;
}

function cloneRuntimeJson(value: unknown, path: string): RuntimeJsonValue {
  return cloneRuntimeJsonValue(value, path, new WeakSet<object>());
}

function cloneRuntimeJsonValue(
  value: unknown,
  path: string,
  active: WeakSet<object>,
): RuntimeJsonValue {
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
        if (typeof key === 'symbol' || (key !== 'length' && !arrayIndexKey(key))) {
          throw new Error(`${path} contains an unsupported array field.`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) {
          throw new Error(`${path} contains an accessor.`);
        }
      }
      const result: RuntimeJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error(`${path} contains a sparse array.`);
        result.push(cloneRuntimeJsonValue(value[index], `${path}[${index}]`, active));
      }
      return result;
    }
    if (!isPlainRecord(value)) throw new Error(`${path} is not a plain JSON object.`);
    const result: Record<string, RuntimeJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') throw new Error(`${path} contains a symbol key.`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor))
        throw new Error(`${path}.${key} is an accessor.`);
      result[key] = cloneRuntimeJsonValue(descriptor.value, `${path}.${key}`, active);
    }
    return result;
  } finally {
    active.delete(value);
  }
}

function arrayIndexKey(value: string): boolean {
  const index = Number(value);
  return (
    Number.isSafeInteger(index) && index >= 0 && index < 4_294_967_295 && String(index) === value
  );
}

function freezeRuntimeJson(value: RuntimeJsonValue): RuntimeJsonValue {
  if (Array.isArray(value)) {
    value.forEach(freezeRuntimeJson);
  } else if (isPlainRecord(value)) {
    Object.values(value).forEach(freezeRuntimeJson);
  }
  return Object.freeze(value);
}

export function planningContinuationAfterPlanSubagent(input: {
  readonly phase: 'planning' | 'building';
  readonly role: SubagentRole;
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

export function validateDelegatedTask(input: {
  readonly delegatedTask: string;
}): Readonly<{ valid: boolean; reason: 'valid' | 'task_not_bounded' }> {
  const task = input.delegatedTask.trim();
  return task.length >= 8 && task.length <= 8_000
    ? { valid: true, reason: 'valid' }
    : { valid: false, reason: 'task_not_bounded' };
}

function validateInput(
  operationId: SubagentOperationId,
  input: Readonly<Record<string, unknown>>,
): boolean {
  const schema =
    operationId === 'builtin:ask_user'
      ? BUILTIN_ZOD_SCHEMAS_['builtin:ask_user']
      : operationId === 'builtin:read_plan'
        ? BUILTIN_ZOD_SCHEMAS_['builtin:read_plan']
        : operationId === 'builtin:update_plan'
          ? BUILTIN_ZOD_SCHEMAS_['builtin:update_plan']
          : operationId === 'builtin:write_plan'
            ? BUILTIN_ZOD_SCHEMAS_['builtin:write_plan']
            : operationId === 'builtin:task'
              ? BUILTIN_ZOD_SCHEMAS_['builtin:task']
              : BUILTIN_ZOD_SCHEMAS_['subagent:start'];
  return schema.safeParse(input).success;
}

function succeededReceipt(
  operationId: SubagentOperationId,
  invocationId: string,
  context: CapabilityExecutionContext,
  value: BuiltinOperationExecutionValue,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: SUBAGENT_PROVIDER_ID_,
    executorRevision: SUBAGENT_EXECUTOR_REVISIONS_[operationId],
    requestDigest: context.requestDigest,
    status: 'succeeded',
    dispatchCertainty: 'attempted',
    cleanupCertainty: 'not_required',
    value,
  });
}

function failedReceipt(
  operationId: SubagentOperationId,
  invocationId: string,
  context: CapabilityExecutionContext,
  code: string,
): ExecutionReceipt {
  return Object.freeze({
    invocationId,
    attemptId: context.attempt.attemptId,
    providerId: SUBAGENT_PROVIDER_ID_,
    executorRevision: SUBAGENT_EXECUTOR_REVISIONS_[operationId],
    requestDigest: context.requestDigest,
    status: 'failed',
    dispatchCertainty: 'none',
    cleanupCertainty: 'not_required',
    failure: Object.freeze({
      code,
      message: 'RM-14 operation input is invalid.',
      retryable: false,
    }),
  });
}

function operationResult(
  ok: boolean,
  stdout: string,
  stderr: string,
  runtimeEvents?: readonly BuiltinRuntimeEventValue[],
): BuiltinOperationExecutionValue {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok,
    stdout: ok ? stdout : '',
    stderr: ok ? '' : stderr,
    resultMeta: Object.freeze({}),
    ...(ok && runtimeEvents ? { runtimeEvents } : {}),
  }) as BuiltinOperationExecutionValue;
}

function operationFailure(stderr: string): BuiltinOperationExecutionValue {
  return operationResult(false, '', stderr);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
