import type { UserInputRequest } from '@kite-ai/runtime-contract';
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
} from '@kite-ai/runtime-spi';
import { defineRuntimeModule } from '@kite-ai/runtime-spi';
import type { z } from 'zod';
import { digestCapabilityBindingValue } from '../capability-binding';
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
} from '../catalog-contract';
import type {
  BuiltinOperationExecutionValue,
  BuiltinRuntimeEventValue,
} from '../model/runtime-module';
import {
  agentMailboxBuiltinPolicyRule,
  askUserBuiltinPolicyRule,
  createBuiltinPolicyCompiler,
  planBuiltinPolicyRule,
  readOnlyBuiltinPolicyRule,
  taskBuiltinPolicyRule,
} from '../policy-compiler';
import { builtinToolDescription } from '../tool-contracts';
import {
  BUILTIN_FOLLOWUP_TASK_SCHEMA_,
  BUILTIN_INTERRUPT_AGENT_SCHEMA_,
  BUILTIN_JSON_SCHEMAS_,
  BUILTIN_LIST_AGENTS_SCHEMA_,
  BUILTIN_READ_PLAN_SCHEMA_,
  BUILTIN_SEND_MESSAGE_SCHEMA_,
  BUILTIN_TASK_CANCEL_SCHEMA_,
  BUILTIN_TASK_READ_SCHEMA_,
  BUILTIN_TASK_WAIT_SCHEMA_,
  BUILTIN_UPDATE_PLAN_SCHEMA_,
  BUILTIN_WAIT_AGENT_SCHEMA_,
  BUILTIN_WRITE_PLAN_SCHEMA_,
  BUILTIN_ZOD_SCHEMAS_,
} from '../tool-schemas';

export const SUBAGENT_PROVIDER_ID_ = 'kite-builtin-runtime-subagent' as const;

export const SUBAGENT_OPERATION_IDS_ = Object.freeze([
  'builtin:ask_user',
  'builtin:read_plan',
  'builtin:update_plan',
  'builtin:write_plan',
  'builtin:task',
  'builtin:task_read',
  'builtin:task_wait',
  'builtin:task_cancel',
  'builtin:list_agents',
  'builtin:wait_agent',
  'builtin:send_message',
  'builtin:followup_task',
  'builtin:interrupt_agent',
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
export const TASK_READ_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:task_read'];
export const TASK_WAIT_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:task_wait'];
export const TASK_CANCEL_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:task_cancel'];
export const LIST_AGENTS_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:list_agents'];
export const WAIT_AGENT_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:wait_agent'];
export const SEND_MESSAGE_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:send_message'];
export const FOLLOWUP_TASK_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:followup_task'];
export const INTERRUPT_AGENT_INPUT_SCHEMA_ = BUILTIN_JSON_SCHEMAS_['builtin:interrupt_agent'];

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
    const explicitRecommendedIndex = question.options.findIndex(
      (option) => option.recommended === true,
    );
    const recommendedIndex = explicitRecommendedIndex >= 0 ? explicitRecommendedIndex : 0;
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
  'builtin:task_read': TASK_READ_INPUT_SCHEMA_,
  'builtin:task_wait': TASK_WAIT_INPUT_SCHEMA_,
  'builtin:task_cancel': TASK_CANCEL_INPUT_SCHEMA_,
  'builtin:list_agents': LIST_AGENTS_INPUT_SCHEMA_,
  'builtin:wait_agent': WAIT_AGENT_INPUT_SCHEMA_,
  'builtin:send_message': SEND_MESSAGE_INPUT_SCHEMA_,
  'builtin:followup_task': FOLLOWUP_TASK_INPUT_SCHEMA_,
  'builtin:interrupt_agent': INTERRUPT_AGENT_INPUT_SCHEMA_,
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
  'builtin:task_read': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:task_wait': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:task_cancel': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:list_agents': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:wait_agent': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:send_message': Object.freeze({
    filesystem: 'none',
    network: 'none',
    externalState: 'none',
  }),
  'builtin:followup_task': Object.freeze({
    filesystem: 'unknown',
    network: 'unknown',
    externalState: 'none',
  }),
  'builtin:interrupt_agent': Object.freeze({
    filesystem: 'none',
    network: 'none',
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
    'builtin:task_read': 'task_control',
    'builtin:task_wait': 'task_control',
    'builtin:task_cancel': 'task_control',
    'builtin:list_agents': 'task_control',
    'builtin:wait_agent': 'task_control',
    'builtin:send_message': 'task_control',
    'builtin:followup_task': 'task_control',
    'builtin:interrupt_agent': 'task_control',
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
          schema: 'kite.subagent-operation-capability.current',
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
          schema: 'kite.subagent-operation-executor.current',
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

export interface BuiltinTaskControlExecutionMechanism {
  readTask(taskId: string): Promise<Readonly<Record<string, unknown>>>;
  waitTasks(
    taskIds: readonly string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Readonly<Record<string, unknown>>>;
  cancelTask(
    taskId: string,
    options?: Readonly<{ waitMs?: number; abortCause?: 'user' | 'error' }>,
  ): Promise<Readonly<Record<string, unknown>>>;
}

/** Service-supplied caller facts; IDs are checked again by the Host mailbox owner. */
export interface AgentMailboxCaller {
  readonly sessionId: string;
  readonly sourceAgentId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly modelInvocationId: string;
  readonly sourceTaskId?: string;
  readonly childGrantId?: string;
}

export interface AgentMailboxInvocationScope extends AgentMailboxCaller {
  /** Exact prepared Tool call and attempt, never parsed from model arguments. */
  readonly toolCallId: string;
  readonly effectAttemptId: string;
}

export interface AgentMailboxPort {
  /** Service binds this base to the exact active model invocation; Host revalidates it. */
  readonly caller: AgentMailboxCaller;
  listAgents(input: {
    readonly scope: AgentMailboxInvocationScope;
    readonly signal: AbortSignal;
  }): Promise<
    Readonly<{ ok: boolean; agents?: readonly Readonly<Record<string, unknown>>[]; code?: string }>
  >;
  waitAgent(input: {
    readonly scope: AgentMailboxInvocationScope;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }): Promise<Readonly<{ ok: boolean; timed_out?: boolean; reason?: string; code?: string }>>;
  /** `ok: true` means the command and receipt were atomically persisted. */
  submitMessage(input: {
    readonly scope: AgentMailboxInvocationScope;
    readonly agentId: string;
    readonly message: string;
    readonly mode: 'queue_only' | 'trigger_turn';
    readonly signal: AbortSignal;
  }): Promise<Readonly<{ ok: boolean; code?: string }>>;
  interruptAgent(input: {
    readonly scope: AgentMailboxInvocationScope;
    readonly agentId: string;
    readonly signal: AbortSignal;
  }): Promise<
    Readonly<{
      ok: boolean;
      agent_id?: string;
      status?: string;
      current_task_id?: string;
      cancel_requested?: boolean;
      cleanup_confirmed?: boolean;
      code?: string;
    }>
  >;
}

export interface BuiltinVerificationExecutionMechanism {
  execute(input: Readonly<Record<string, unknown>>): Promise<BuiltinOperationExecutionValue>;
}

export interface SubagentExecutionMechanisms extends Readonly<Record<string, unknown>> {
  readonly planning?: BuiltinPlanningExecutionMechanism;
  readonly subagent?: BuiltinSubagentExecutionMechanism;
  readonly taskControl?: BuiltinTaskControlExecutionMechanism;
  readonly agentMailbox?: AgentMailboxPort;
  readonly verification?: BuiltinVerificationExecutionMechanism;
}

export function createSubagentRuntimeModule(): RuntimeModule {
  return defineRuntimeModule({
    moduleId: 'kite-builtin-runtime-subagent',
    providerId: SUBAGENT_PROVIDER_ID_,
    revision: 'subagent-current',
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
  const taskControl =
    operationId === 'builtin:task_read' ||
    operationId === 'builtin:task_wait' ||
    operationId === 'builtin:task_cancel';
  const agentMailbox =
    operationId === 'builtin:list_agents' ||
    operationId === 'builtin:wait_agent' ||
    operationId === 'builtin:send_message' ||
    operationId === 'builtin:followup_task' ||
    operationId === 'builtin:interrupt_agent';
  const askUser = operationId === 'builtin:ask_user';
  const readOnly =
    operationId === 'builtin:read_plan' ||
    taskControl ||
    operationId === 'builtin:list_agents' ||
    operationId === 'builtin:wait_agent';
  const parser = task
    ? taskRuntimeParser(revision)
    : parserForBuiltinOperation(operationId, revision);
  const policyRule = askUser
    ? askUserBuiltinPolicyRule
    : task
      ? taskBuiltinPolicyRule
      : agentMailbox
        ? agentMailboxBuiltinPolicyRule
        : taskControl
          ? readOnlyBuiltinPolicyRule
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
    ...(task || taskControl
      ? { availability: taskAvailability }
      : agentMailbox
        ? { availability: agentMailboxAvailability(operationId) }
        : {}),
    effectsClassifier: task
      ? taskEffectsClassifier(effects)
      : staticEffectsClassifier(
          askUser || readOnly
            ? 'read_only'
            : planAction || (agentMailbox && operationId !== 'builtin:followup_task')
              ? 'plan_only'
              : 'unknown',
          !askUser && !readOnly && !planAction,
          askUser
            ? 'Pauses execution for explicit user input.'
            : agentMailbox
              ? 'Uses the Host-owned Agent mailbox under exact caller scope.'
              : readOnly
                ? taskControl
                  ? 'Reads, waits for, or stops Runtime-owned background sub-agents.'
                  : 'Reads the active immutable Plan Artifact.'
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
      : taskControl
        ? {
            executionTraitsDeclaration: builtinExecutionTraits({
              resourceScopes: [{ kind: 'subagent', key: 'child' }],
              interactionBarrier: false,
            }),
          }
        : {}),
    execution:
      readOnly && !agentMailbox ? { retry: 'safe_read' as const } : { retry: 'never' as const },
  };
}

const agentMailboxAvailability =
  (operationId: SubagentOperationId) =>
  (context: import('@kite-ai/runtime-spi').CapabilityTurnContext) => {
    // QueueOnly is the tighter cross-Session surface even if a Tool port is
    // present and the general mailbox flag was also projected for this turn.
    const available =
      context.featureFlags?.agentMailboxQueueOnly === true
        ? operationId === 'builtin:list_agents' ||
          operationId === 'builtin:wait_agent' ||
          operationId === 'builtin:send_message'
        : context.featureFlags?.agentMailbox === true;
    return available
      ? Object.freeze({ status: 'available' as const })
      : Object.freeze({ status: 'hidden' as const, reason: 'agent_mailbox_unavailable' });
  };

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
    case 'builtin:task_read':
      value = await executeTaskControl('read', input, mechanisms?.taskControl, context.signal);
      break;
    case 'builtin:task_wait':
      value = await executeTaskControl('wait', input, mechanisms?.taskControl, context.signal);
      break;
    case 'builtin:task_cancel':
      value = await executeTaskControl('cancel', input, mechanisms?.taskControl, context.signal);
      break;
    case 'builtin:list_agents':
    case 'builtin:wait_agent':
    case 'builtin:send_message':
    case 'builtin:followup_task':
    case 'builtin:interrupt_agent':
      value = await executeAgentMailboxOperation(
        operationId,
        input,
        request.facts,
        context,
        mechanisms?.agentMailbox,
      );
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

async function executeTaskControl(
  action: 'read' | 'wait' | 'cancel',
  input: Readonly<Record<string, unknown>>,
  mechanism: BuiltinTaskControlExecutionMechanism | undefined,
  signal?: AbortSignal,
): Promise<BuiltinOperationExecutionValue> {
  if (!mechanism) return operationFailure('Background sub-agent control Runtime is unavailable.');
  if (action === 'wait') {
    const parsed = BUILTIN_TASK_WAIT_SCHEMA_.parse(input);
    const result = await mechanism.waitTasks(parsed.task_ids, parsed.timeout_ms ?? 30_000, signal);
    const ok = result.ok === true;
    const content = JSON.stringify(result);
    const status = typeof result.status === 'string' ? result.status : 'unknown';
    return operationResult(ok, ok ? content : '', ok ? '' : content, undefined, {
      taskIds: parsed.task_ids,
      taskStatus: status,
      ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
      ...(typeof result.cursor === 'string' || typeof result.cursor === 'number'
        ? { cursor: result.cursor }
        : {}),
    });
  }
  const taskId =
    action === 'read'
      ? BUILTIN_TASK_READ_SCHEMA_.parse(input).task_id
      : BUILTIN_TASK_CANCEL_SCHEMA_.parse(input).task_id;
  const result =
    action === 'read' ? await mechanism.readTask(taskId) : await mechanism.cancelTask(taskId);
  const ok = result.ok === true;
  const content = JSON.stringify(result);
  const status = typeof result.status === 'string' ? result.status : 'unknown';
  return operationResult(ok, ok ? content : '', ok ? '' : content, undefined, {
    taskId,
    taskStatus: status,
  });
}

async function executeAgentMailboxOperation(
  operationId: Extract<
    SubagentOperationId,
    | 'builtin:list_agents'
    | 'builtin:wait_agent'
    | 'builtin:send_message'
    | 'builtin:followup_task'
    | 'builtin:interrupt_agent'
  >,
  input: Readonly<Record<string, unknown>>,
  facts: RuntimeJsonValue | undefined,
  context: CapabilityExecutionContext,
  port: AgentMailboxPort | undefined,
): Promise<BuiltinOperationExecutionValue> {
  if (!port) return operationFailure('Agent mailbox Runtime is unavailable.');
  const scope = agentMailboxScope(port.caller, facts, context);
  if (!scope) return operationFailure('Agent mailbox caller identity is unavailable.');
  if (operationId === 'builtin:list_agents') {
    BUILTIN_LIST_AGENTS_SCHEMA_.parse(input);
    const result = await port.listAgents({ scope, signal: context.signal });
    if (result.ok !== true) return agentMailboxRejection(result.code);
    if (!Array.isArray(result.agents)) return operationFailure('Agent tree projection is invalid.');
    const agents = result.agents.slice(0, 64).map((entry) => {
      const record = asRecord(entry);
      return record ? projectAgentListEntry(record) : undefined;
    });
    if (agents.some((entry) => !entry))
      return operationFailure('Agent tree projection is invalid.');
    return operationResult(true, JSON.stringify({ ok: true, agents }), '');
  }
  if (operationId === 'builtin:wait_agent') {
    const parsed = BUILTIN_WAIT_AGENT_SCHEMA_.parse(input);
    const result = await port.waitAgent({
      scope,
      timeoutMs: parsed.timeout_ms ?? 30_000,
      signal: context.signal,
    });
    if (result.ok !== true) return agentMailboxRejection(result.code);
    if (
      typeof result.timed_out !== 'boolean' ||
      (result.reason !== 'mailbox_update' &&
        result.reason !== 'agent_update' &&
        result.reason !== 'user_input' &&
        result.reason !== 'timeout') ||
      result.timed_out !== (result.reason === 'timeout')
    ) {
      return operationFailure('Agent mailbox wait result is invalid.');
    }
    return operationResult(
      true,
      JSON.stringify({ timed_out: result.timed_out, reason: result.reason }),
      '',
    );
  }
  if (operationId === 'builtin:send_message' || operationId === 'builtin:followup_task') {
    const parsed =
      operationId === 'builtin:send_message'
        ? BUILTIN_SEND_MESSAGE_SCHEMA_.parse(input)
        : BUILTIN_FOLLOWUP_TASK_SCHEMA_.parse(input);
    const result = await port.submitMessage({
      scope,
      agentId: parsed.agent_id,
      message: parsed.message,
      mode: operationId === 'builtin:send_message' ? 'queue_only' : 'trigger_turn',
      signal: context.signal,
    });
    return result.ok === true ? operationResult(true, '', '') : agentMailboxRejection(result.code);
  }
  const parsed = BUILTIN_INTERRUPT_AGENT_SCHEMA_.parse(input);
  const result = await port.interruptAgent({
    scope,
    agentId: parsed.agent_id,
    signal: context.signal,
  });
  if (result.ok !== true) return agentMailboxRejection(result.code);
  if (
    result.agent_id !== parsed.agent_id ||
    typeof result.status !== 'string' ||
    (result.cancel_requested !== undefined && typeof result.cancel_requested !== 'boolean') ||
    (result.cleanup_confirmed !== undefined && typeof result.cleanup_confirmed !== 'boolean')
  ) {
    return operationFailure('Agent interrupt result is invalid.');
  }
  return operationResult(
    true,
    JSON.stringify({
      ok: true,
      agent_id: result.agent_id,
      status: result.status,
      ...(result.current_task_id ? { current_task_id: result.current_task_id } : {}),
      ...(result.cancel_requested === undefined
        ? {}
        : { cancel_requested: result.cancel_requested }),
      ...(result.cleanup_confirmed === undefined
        ? {}
        : { cleanup_confirmed: result.cleanup_confirmed }),
    }),
    '',
  );
}

function agentMailboxScope(
  caller: AgentMailboxCaller | undefined,
  facts: RuntimeJsonValue | undefined,
  context: CapabilityExecutionContext,
): AgentMailboxInvocationScope | undefined {
  const toolCallId = planToolCallId(facts);
  const effectAttemptId = context.attempt.attemptId;
  if (
    !caller ||
    !toolCallId ||
    !effectAttemptId ||
    (caller.sourceTaskId !== undefined &&
      (typeof caller.sourceTaskId !== 'string' || caller.sourceTaskId.length === 0)) ||
    (caller.childGrantId !== undefined &&
      (typeof caller.childGrantId !== 'string' || caller.childGrantId.length === 0)) ||
    ![
      caller.sessionId,
      caller.sourceAgentId,
      caller.runId,
      caller.turnId,
      caller.modelInvocationId,
    ].every((value) => typeof value === 'string' && value.length > 0)
  ) {
    return undefined;
  }
  return Object.freeze({ ...caller, toolCallId, effectAttemptId });
}

function agentMailboxRejection(code: unknown): BuiltinOperationExecutionValue {
  return operationFailure(
    JSON.stringify({ ok: false, code: typeof code === 'string' ? code : 'mailbox_rejected' }),
  );
}

function projectAgentListEntry(
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, RuntimeJsonValue>> | undefined {
  if (typeof value.agent_id !== 'string' || typeof value.status !== 'string') return undefined;
  const followupReason = value.last_followup_reason;
  const recent = Array.isArray(value.recent_updates)
    ? value.recent_updates.slice(0, 4).flatMap((item) => {
        const update = asRecord(item);
        if (!update || typeof update.message_id !== 'string' || typeof update.summary !== 'string')
          return [];
        return [
          {
            message_id: update.message_id,
            summary: update.summary.slice(0, 400),
            ...(typeof update.sender_agent_id === 'string'
              ? { sender_agent_id: update.sender_agent_id }
              : {}),
            ...(typeof update.source_task_id === 'string'
              ? { source_task_id: update.source_task_id }
              : {}),
          },
        ];
      })
    : undefined;
  return Object.freeze({
    agent_id: value.agent_id,
    status: value.status,
    ...(typeof value.parent_agent_id === 'string'
      ? { parent_agent_id: value.parent_agent_id }
      : {}),
    ...(typeof value.current_task_id === 'string'
      ? { current_task_id: value.current_task_id }
      : {}),
    ...(typeof value.unread_count === 'number' && Number.isSafeInteger(value.unread_count)
      ? { unread_count: value.unread_count }
      : {}),
    ...(value.last_followup_status === 'failed' &&
    typeof value.last_followup_submission_id === 'string'
      ? {
          last_followup_status: 'failed',
          last_followup_submission_id: value.last_followup_submission_id,
          ...(typeof followupReason === 'string' &&
          [
            'tool_failed',
            'expired',
            'context_unavailable',
            'authorization_changed',
            'source_cancelled',
          ].includes(followupReason)
            ? { last_followup_reason: followupReason }
            : {}),
        }
      : {}),
    ...(recent ? { recent_updates: recent } : {}),
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
      childTerminal: blocked || terminalStatus !== undefined,
      childOk: projected.ok,
      childStatus: blocked ? 'suspended' : terminalStatus,
    });
    const modelContent = JSON.stringify({
      ok: projected.ok,
      summary: projected.summary,
      ...(typeof projected.error === 'string' ? { error: projected.error } : {}),
      ...(projected.backgroundTaskId ? { task_id: projected.backgroundTaskId } : {}),
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
      resultMeta: Object.freeze({
        ...(projected.backgroundTaskId
          ? {
              taskId: projected.backgroundTaskId,
              taskStatus: 'running',
              taskDisposition:
                input.input.result_disposition === 'after_turn' ? 'after_turn' : 'required',
            }
          : {}),
      }),
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
  'backgroundTaskId',
  'checkpointRef',
  'blocked',
  'durationMs',
  'error',
  'executionJournal',
  'exhaustedFingerprints',
  'failureDiagnostic',
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
  'interrupted',
  'exhausted',
  'suspended',
  'unknown',
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
  readonly backgroundTaskId?: string;
  readonly error?: string;
  readonly failureDiagnostic?: RuntimeJsonValue;
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
  if (Object.hasOwn(value, 'backgroundTaskId')) {
    projected.backgroundTaskId = requireString(value.backgroundTaskId, 'result.backgroundTaskId');
  }
  if (Object.hasOwn(value, 'error')) {
    projected.error = requireString(value.error, 'result.error');
  }
  if (Object.hasOwn(value, 'failureDiagnostic')) {
    projected.failureDiagnostic = projectFailureDiagnostic(value.failureDiagnostic);
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

function projectFailureDiagnostic(value: unknown): RuntimeJsonValue {
  const record = requirePlainRecord(value, 'result.failureDiagnostic');
  assertExactKeys(record, SUBAGENT_FAILURE_DIAGNOSTIC_KEYS_, ['code', 'stage']);
  const code = requireOneOf(record.code, SUBAGENT_FAILURE_CODES_, 'diagnostic.code');
  const stage = requireOneOf(record.stage, SUBAGENT_FAILURE_STAGES_, 'diagnostic.stage');
  const projected: Record<string, RuntimeJsonValue> = {
    code,
    stage,
  };
  if (Object.hasOwn(record, 'modelInvocationId')) {
    projected.modelInvocationId = requireString(
      record.modelInvocationId,
      'diagnostic.modelInvocationId',
    );
  }
  if (Object.hasOwn(record, 'admissionReason')) {
    throw new Error('Subagent failure diagnostics cannot contain an admission reason.');
  }
  return freezeRuntimeJson(projected);
}

const SUBAGENT_FAILURE_DIAGNOSTIC_KEYS_ = Object.freeze([
  'code',
  'stage',
  'modelInvocationId',
] as const);

const SUBAGENT_FAILURE_CODES_ = Object.freeze([
  'aborted',
  'timed_out',
  'invalid_input',
  'consumer_protocol',
  'model_step_failed',
  'internal_error',
] as const);

const SUBAGENT_FAILURE_STAGES_ = Object.freeze([
  'initialization',
  'next_round_preparation',
  'model_step',
  'model_response_validation',
  'tool_consumption',
  'transcript_validation',
  'terminal_projection',
] as const);

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
        ['status', 'stepId', 'toolArgs', 'toolCallId', 'toolName', 'totalLines'],
        ['status', 'stepId', 'toolArgs', 'toolCallId', 'toolName'],
      );
      const projected: Record<string, RuntimeJsonValue> = {
        stepId: requireNonEmptyString(record.stepId, `result.steps[${index}].stepId`),
        toolCallId: requireNonEmptyString(record.toolCallId, `result.steps[${index}].toolCallId`),
        toolName: requireNonEmptyString(record.toolName, `result.steps[${index}].toolName`),
        toolArgs: cloneRecordJson(record.toolArgs, `result.steps[${index}].toolArgs`),
        status: requireOneOf(
          record.status,
          ['pending', 'awaiting_approval', 'success', 'rejected', 'error', 'cancelled'] as const,
          `result.steps[${index}].status`,
        ),
      };
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
      'name',
      'projectInstructions',
      'role',
      'steps',
      'task',
      'toolCallCount',
      'toolRecovery',
    ],
    ['id', 'messages', 'name', 'role', 'steps', 'task', 'toolCallCount', 'toolRecovery'],
  );
  const id = requireNonEmptyString(continuation.id, 'result.blocked.continuation.id');
  const name = requireNonEmptyString(continuation.name, 'result.blocked.continuation.name');
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
    name,
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
  return BUILTIN_ZOD_SCHEMAS_[operationId].safeParse(input).success;
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
  resultMeta: Readonly<Record<string, RuntimeJsonValue>> = {},
): BuiltinOperationExecutionValue {
  return Object.freeze({
    schema: 'kite.builtin-operation-result.v1',
    ok,
    stdout: ok ? stdout : '',
    stderr: ok ? '' : stderr,
    resultMeta: Object.freeze({ ...resultMeta }),
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
