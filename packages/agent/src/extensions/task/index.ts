import { canonicalJson } from '../../json';
import { AgentError, type RequirementEvaluation } from '../../storage/types';
import type { Extension, Json, OperationRef, ToolContext, ToolResult } from '../index';
import { completeForegroundTask } from './foreground';

export { createDefaultTaskRequestClassifier } from '../../permissions/task-request';
export {
  defaultTaskRoles,
  isReadOnlyTaskTool,
  isRootOnlyTaskTool,
  readOnlyTaskToolIds,
} from './roles';

export interface TaskRole {
  readonly id: string;
  /** A trusted, already registered child configuration; callers cannot supply configuration IDs. */
  readonly configurationId: string;
  readonly description: string;
}
export interface TaskOptions {
  readonly roles: readonly TaskRole[];
  /** Default trusted prompt configuration. No model-provided configuration identity. */
  readonly defaultRole?: string;
  readonly presets?: readonly string[];
  /** Trusted host registration, still requiring an independent Runtime policy. */
  readonly afterTurn?: { enabled: true };
}
const extensionId = 'builtin.task';
const resultType = 'application/vnd.kite.operation-result-requirement+json';
const contentType = 'application/vnd.kite.task-reference+json';
const idSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.-]+$' };
const object = (properties: Record<string, Json>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const refKey = (key: string) => `task/${key}`;
function value(input: Json): Record<string, Json> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AgentError('invalid_task_arguments');
  return input;
}
function text(input: Record<string, Json>, key: string): string {
  if (typeof input[key] !== 'string' || !input[key]) throw new AgentError('invalid_task_arguments');
  return input[key];
}
function result(details: Json): ToolResult {
  return { outcome: 'succeeded', content: canonicalJson(details), details };
}
async function reference(context: ToolContext, key: string): Promise<OperationRef> {
  const record = await context.records.get(refKey(key));
  if (!record) {
    const actual = await context.operations.getAgentRef?.(key);
    if (actual) return actual;
    throw new AgentError('task_not_found');
  }
  if (record.contentType !== contentType || record.contentVersion !== 1)
    throw new AgentError('task_not_found');
  return value(record.value).ref as unknown as OperationRef;
}

/** Import and construction perform no I/O. Every child uses the ordinary controlled operation path. */
export function createTaskExtension(options: TaskOptions): Extension {
  const roles = new Map<string, TaskRole>();
  if (options.roles.length === 0 || options.roles.length > 64)
    throw new AgentError('invalid_task_roles');
  for (const supplied of options.roles) {
    const role = structuredClone(supplied);
    if (
      !/^[A-Za-z0-9_.-]{1,128}$/.test(role.id) ||
      !role.configurationId ||
      role.configurationId.length > 128 ||
      roles.has(role.id) ||
      !role.description ||
      role.description.length > 4096
    )
      throw new AgentError('invalid_task_roles');
    roles.set(role.id, Object.freeze(role));
  }
  const roleSchema = {
    type: 'string',
    enum: [...roles.keys()],
    description: `Type of sub-agent, selected from the trusted roles below.\n${[...roles.values()].map((role) => `${role.id}: ${role.description}`).join('\n')}`,
  };
  const delegationGuidance =
    'Delegate concrete scoped subtasks when independent work benefits from an isolated sub-agent; isolation here is a separate child Session with the same parent capability ceiling, not additional filesystem access. Retain direct work for small sequential tasks. Use code only when the user task calls for implementation; use plan for read-only architecture or design planning, explore for repository investigation, and review for read-only code inspection, when those roles are registered. For multiple independent sibling task calls, the shared Loop can execute them concurrently within the child-slot limit; avoid dependent or overlapping work. A role never grants tools or permission beyond the actual parent selection and child ceiling.';
  const extension: Extension = {
    id: extensionId,
    version: '1',
    apiMajor: 1,
    conditions: {
      async evaluate(refs, phase, context) {
        if (!context) throw new AgentError('necessary_condition_context_missing');
        return Promise.all(
          refs.map(async (ref): Promise<RequirementEvaluation> => {
            const read = await context.forRequirement(ref);
            const record = await read.records.get(ref.recordKey);
            const metadata = record ? value(record.value) : null;
            const evaluation = {
              requirement: ref,
              recordRevision: record?.revision ?? ref.revision,
              outcome: 'unsatisfied' as 'satisfied' | 'unsatisfied',
              evidence: {} as Json,
            };
            if (
              !record ||
              record.contentType !== resultType ||
              record.contentVersion !== 1 ||
              record.revision !== ref.revision ||
              record.originStoreId !== ref.originStoreId ||
              metadata?.kind !== 'operation_result' ||
              metadata.runId !== ref.runId ||
              metadata.sessionId !== ref.sessionId
            )
              return { ...evaluation, evidence: { reason: 'required_result_unverifiable' } };
            if (
              phase !== 'completion' ||
              context.boundary.runId !== ref.runId ||
              context.boundary.executionId !== null
            )
              return {
                ...evaluation,
                outcome: 'satisfied' as const,
                evidence: { reason: 'nonapplicable_run_boundary' },
              };
            const execution = await read.getExecution(String(metadata.executionId));
            if (
              !execution ||
              execution.originStoreId !== ref.originStoreId ||
              execution.originCommandId !== metadata.originCommandId ||
              execution.parentExecutionId !== metadata.parentExecutionId ||
              execution.rootWorkCommandId !== metadata.rootWorkCommandId ||
              execution.rootWorkSeq !== metadata.rootWorkSeq
            )
              return { ...evaluation, evidence: { reason: 'required_result_unverifiable' } };
            if (['planned', 'dispatching', 'running'].includes(execution.status))
              return {
                ...evaluation,
                evidence: { reason: 'required_result_pending', executionId: execution.id },
                wait: { executionIds: [execution.id] },
              };
            if (execution.status === 'outcome_unknown')
              return {
                ...evaluation,
                evidence: { reason: 'required_result_unknown', executionId: execution.id },
              };
            const accepted = execution.resultAcceptance;
            if (
              accepted?.runId !== ref.runId ||
              accepted.selectionId !== metadata.contextSelectionId ||
              accepted.resultRevision !== execution.resultRevision
            )
              return {
                ...evaluation,
                evidence: { reason: 'required_result_not_accepted', executionId: execution.id },
                wait: { executionIds: [execution.id] },
              };
            return {
              ...evaluation,
              outcome: 'satisfied' as const,
              evidence: {
                reason: 'required_result_settled',
                executionId: execution.id,
                status: execution.status,
                sourceId: accepted.sourceId,
                resultRevision: accepted.resultRevision,
              },
            };
          }),
        );
      },
    },
    records: [
      {
        contentType: resultType,
        contentVersion: 1,
        schema: {
          type: 'object',
          properties: {
            kind: { const: 'operation_result' },
            ...Object.fromEntries(
              [
                'executionId',
                'sessionId',
                'runId',
                'parentExecutionId',
                'originStoreId',
                'originCommandId',
                'rootWorkCommandId',
                'rootWorkSeq',
                'contextSelectionId',
              ].map((key) => [key, { type: 'string' }]),
            ),
          },
          additionalProperties: false,
          required: [
            'kind',
            'executionId',
            'sessionId',
            'runId',
            'parentExecutionId',
            'originStoreId',
            'originCommandId',
            'rootWorkCommandId',
            'rootWorkSeq',
            'contextSelectionId',
          ],
        },
      },
      {
        contentType,
        contentVersion: 1,
        schema: object({ role: idSchema, ref: { type: 'object' } }, ['role', 'ref']),
      },
    ],
    tools: [
      {
        id: 'task',
        model: { name: 'spawn_agent', snakeCase: true },
        version: '1',
        description: `Spawn a background child Agent using a trusted role and return its accepted task reference. Defaults to attached cancellation and required result delivery; acceptance is not completion. key identifies the exact operation, and input is the trusted role input JSON. ${delegationGuidance}`,
        inputSchema: object(
          {
            key: idSchema,
            role: roleSchema,
            input: {},
            cancellation: { enum: ['attached', 'detached'] },
            resultDisposition: {
              enum: options.afterTurn?.enabled
                ? ['required', 'background', 'after_turn']
                : ['required', 'background'],
            },
          },
          ['key', 'role', 'input'],
        ),
        async execute(input, context) {
          const args = value(input);
          const key = text(args, 'key');
          const role = roles.get(text(args, 'role'));
          if (!role) throw new AgentError('task_role_unavailable');
          let ref: OperationRef;
          try {
            ref = await context.operations.ensure({
              ...(args.resultDisposition === 'after_turn'
                ? { continuation: { kind: 'after_turn' as const } }
                : {}),
              key,
              request: { kind: 'agent', configurationId: role.configurationId, input: args.input! },
              cancellation: args.cancellation === 'detached' ? 'detached' : 'attached',
              ...(args.resultDisposition === 'background' || args.resultDisposition === 'after_turn'
                ? {}
                : {
                    resultRequirement: {
                      recordKey: `run/${context.runId}/task/${key}/required`,
                      requirementId: `task-${key}`,
                      definitionVersion: '1',
                      contentType: resultType,
                      contentVersion: 1,
                    },
                  }),
            });
          } catch (error) {
            if (
              error instanceof AgentError &&
              ['after_turn_not_authorized', 'after_turn_scope_unsupported'].includes(error.code)
            )
              return {
                outcome: 'failed',
                content: error.code,
                details: { code: error.code, childCreated: false },
              };
            if (error instanceof AgentError && error.code === 'child_capacity_full')
              return {
                outcome: 'failed',
                content: error.code,
                details: { code: error.code, childCreated: false },
              };
            throw error;
          }
          const saved = { role: role.id, ref: ref as unknown as Json };
          const prior = await context.records.get(refKey(key));
          if (prior) {
            if (canonicalJson(prior.value) !== canonicalJson(saved))
              throw new AgentError('task_reference_conflict');
          } else
            await context.records.write({
              key: refKey(key),
              expectedRevision: null,
              contentType,
              contentVersion: 1,
              value: saved,
            });
          return result({ accepted: true, taskId: key, ref: ref as unknown as Json });
        },
      },
      {
        id: 'task_read',
        model: { name: 'read_agent', snakeCase: true },
        version: '1',
        description:
          'Read the exact child task status and available result using task_id; does not start a new Model or child execution.',
        inputSchema: object({ taskId: idSchema }, ['taskId']),
        async execute(input, context) {
          const ref = await reference(context, text(value(input), 'taskId'));
          const agent = await context.operations.readAgent(ref);
          return result({ ref: ref as unknown as Json, agent: agent as unknown as Json });
        },
      },
      {
        id: 'task_wait',
        model: { name: 'task_wait', snakeCase: true, hidden: true },
        version: '1',
        description:
          'Wait for any of an exact current-owner child set; timeout/new input do not cancel children.',
        inputSchema: object(
          {
            taskId: idSchema,
            taskIds: {
              type: 'array',
              minItems: 1,
              maxItems: 64,
              uniqueItems: true,
              items: idSchema,
            },
            timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 },
          },
          [],
        ),
        async execute(input, context) {
          const args = value(input);
          if ((args.taskId === undefined) === (args.taskIds === undefined))
            throw new AgentError('invalid_wait_targets');
          const ids = args.taskId === undefined ? args.taskIds : [args.taskId];
          if (
            !Array.isArray(ids) ||
            !ids.length ||
            ids.length > 64 ||
            ids.some((id) => typeof id !== 'string') ||
            new Set(ids).size !== ids.length
          )
            throw new AgentError('invalid_wait_targets');
          const refs = await Promise.all(ids.map((id) => reference(context, String(id))));
          const waited = await context.operations.waitAny(refs, {
            signal: context.signal,
            timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : 30000,
          });
          return result({
            ...waited,
            timedOut: waited.reason === 'timeout',
            refs: refs as unknown as Json,
            ...(refs.length === 1 ? { ref: refs[0], execution: waited.executions[0] } : {}),
          } as unknown as Json);
        },
      },
      {
        id: 'send_message',
        model: { name: 'send_agent_message', snakeCase: true },
        version: '1',
        description:
          'Queue an Agent message to an exact direct child or parent. Idle recipients remain idle; acceptance does not prove Model input.',
        inputSchema: {
          ...object(
            {
              taskId: idSchema,
              target: { enum: ['parent'] },
              key: idSchema,
              targetRunId: idSchema,
              contextSelectionId: idSchema,
              content: { type: 'string', minLength: 1, maxLength: 1048576 },
            },
            ['key', 'content'],
          ),
          oneOf: [
            { required: ['taskId'], not: { required: ['target'] } },
            { required: ['target'], not: { required: ['taskId'] } },
          ],
        },
        async execute(input, context) {
          const args = value(input);
          if ((args.target === 'parent') === (typeof args.taskId === 'string'))
            throw new AgentError('invalid_agent_message');
          const ref =
            args.target === 'parent'
              ? ('parent' as const)
              : await reference(context, text(args, 'taskId'));
          if (!context.operations.sendAgentMessage)
            throw new AgentError('agent_message_unavailable');
          if (!context.operations.readAgentMessageTarget)
            throw new AgentError('agent_message_unavailable');
          const target = await context.operations.readAgentMessageTarget(ref);
          const receipt = await context.operations.sendAgentMessage(ref, {
            key: text(args, 'key'),
            ...(typeof args.targetRunId === 'string'
              ? { targetRunId: args.targetRunId }
              : target.targetRunId === null
                ? {}
                : { targetRunId: target.targetRunId }),
            contextSelectionId:
              typeof args.contextSelectionId === 'string'
                ? args.contextSelectionId
                : target.contextSelectionId,
            content: text(args, 'content'),
          });
          return result(receipt);
        },
      },
      {
        id: 'followup_task',
        model: { name: 'followup_agent', snakeCase: true },
        version: '1',
        description:
          'Create new child work after one exact predecessor ends, retaining its Session history. This is not resuming the old execution.',
        inputSchema: object(
          {
            taskId: idSchema,
            resultDisposition: {
              enum: [
                'required',
                'background',
                ...(options.afterTurn?.enabled ? ['after_turn'] : []),
              ],
            },
            key: idSchema,
            afterRunId: idSchema,
            contextSelectionId: idSchema,
            content: { type: 'string', minLength: 1, maxLength: 1048576 },
          },
          ['taskId', 'key', 'afterRunId', 'contextSelectionId', 'content'],
        ),
        async execute(input, context) {
          const args = value(input);
          const record = await context.records.get(refKey(text(args, 'taskId')));
          if (!record || record.contentType !== contentType || record.contentVersion !== 1)
            throw new AgentError('task_not_found');
          const stored = value(record.value);
          const receipt = await context.operations.sendAgentInput(
            stored.ref as unknown as OperationRef,
            {
              mode: 'follow_up',
              ...(args.resultDisposition === 'after_turn'
                ? { continuation: { kind: 'after_turn' as const } }
                : {}),
              ...(args.resultDisposition === 'background' || args.resultDisposition === 'after_turn'
                ? {}
                : {
                    resultRequirement: {
                      recordKey: `run/${context.runId}/task/${text(args, 'key')}/required`,
                      requirementId: `task-${text(args, 'key')}`,
                      definitionVersion: '1',
                      contentType: resultType,
                      contentVersion: 1,
                    },
                  }),
              key: text(args, 'key'),
              afterRunId: text(args, 'afterRunId'),
              contextSelectionId: text(args, 'contextSelectionId'),
              content: text(args, 'content'),
            },
          );
          const next = value(receipt.receipt).ref as unknown as OperationRef;
          const key = refKey(text(args, 'key'));
          const existing = await context.records.get(key);
          const nextValue = { role: stored.role!, ref: next as unknown as Json };
          if (existing && canonicalJson(existing.value) !== canonicalJson(nextValue))
            throw new AgentError('task_reference_conflict');
          if (!existing)
            await context.records.write({
              key,
              expectedRevision: null,
              contentType,
              contentVersion: 1,
              value: nextValue,
            });
          return result({ ...receipt, ref: next as unknown as Json });
        },
      },
      {
        id: 'task_cancel',
        model: { name: 'cancel_agent_task', snakeCase: true },
        version: '1',
        description:
          'Request cancellation of one exact child; this does not claim stopped confirmation.',
        inputSchema: object({ taskId: idSchema, commandId: idSchema }, ['taskId', 'commandId']),
        async execute(input, context) {
          const args = value(input);
          const ref = await reference(context, text(args, 'taskId'));
          if (!context.operations.cancel) throw new AgentError('task_cancel_unavailable');
          await context.operations.cancel(ref, { commandId: text(args, 'commandId') });
          const execution = await context.operations.get(ref);
          return result({
            outcome: 'cancel_requested',
            ref: ref as unknown as Json,
            execution: execution as unknown as Json,
          });
        },
      },
    ],
  };
  const create = extension.tools!.find((tool) => tool.id === 'task')!;
  const wait = extension.tools!.find((tool) => tool.id === 'task_wait')!;
  const foreground = async (input: Json, context: ToolContext): Promise<ToolResult> => {
    const args = value(input);
    if (args.cancellation !== undefined && args.cancellation !== 'attached')
      throw new AgentError('invalid_task_arguments');
    const created = await create.execute({ ...args, resultDisposition: 'background' }, context);
    if (created.outcome !== 'succeeded') return created;
    return completeForegroundTask(await reference(context, text(args, 'key')), context);
  };
  const legacy: Extension = {
    ...extension,
    tools: [
      ...extension.tools!,
      {
        ...create,
        id: 'task.execute',
        model: { name: 'run_agent', snakeCase: true },
        recovery: { version: '1' },
        resume: foreground,
        description: `Run a foreground attached child using a trusted role; wait and return its complete actual terminal summary before the next parent Model turn. key identifies the exact operation; input is the trusted role input JSON. Parent cancellation propagates to this child. ${delegationGuidance}`,
        inputSchema: object(
          {
            key: idSchema,
            role: roleSchema,
            input: {},
            cancellation: { enum: ['attached'] },
          },
          ['key', 'role', 'input'],
        ),
        execute: foreground,
      },
      {
        ...wait,
        id: 'wait_agents',
        model: {
          name: 'wait_agents',
          snakeCase: true,
          omitParameters: ['taskId'],
          requiredParameters: ['taskIds'],
        },
        description:
          'Wait for any of 1–64 unique exact child task_ids; use a one-item array for one child. timeout_ms is 0–30000 milliseconds, default 30000. New input or interaction may wake early; waiting does not consume messages or cancel targets.',
      },
      {
        ...wait,
        id: 'wait_agent',
        model: { name: 'wait_agent_event', snakeCase: true, omitParameters: ['taskId', 'taskIds'] },
        description:
          'Wait for own mailbox updates, input or interaction without consuming messages. after_seq selects the mailbox sequence. timeout_ms is 0–30000 milliseconds, default 30000. Use wait_agents to wait for specific child tasks; timeout never cancels work.',
        inputSchema: object(
          {
            taskId: idSchema,
            taskIds: {
              type: 'array',
              minItems: 1,
              maxItems: 64,
              uniqueItems: true,
              items: idSchema,
            },
            afterSeq: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
            timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 },
          },
          [],
        ),
        async execute(input, context) {
          const args = value(input);
          if (args.taskId !== undefined || args.taskIds !== undefined)
            return wait.execute(input, context);
          if (!context.operations.waitAgentMessages)
            throw new AgentError('agent_message_unavailable');
          return result(
            await context.operations.waitAgentMessages({
              ...(typeof args.afterSeq === 'string' ? { afterSeq: args.afterSeq } : {}),
              ...(typeof args.timeoutMs === 'number' ? { timeoutMs: args.timeoutMs } : {}),
              signal: context.signal,
            }),
          );
        },
      },
      {
        id: 'list_agents',
        model: { name: 'list_agents', snakeCase: true },
        version: '1',
        description:
          'Read a bounded identity/status page of own child carriers, preserving a fixed sequence upper bound. No Model, activation, or result body read.',
        inputSchema: object(
          {
            afterSeq: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
            upperSeq: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          [],
        ),
        async execute(input, context) {
          const args = value(input);
          if (!context.operations.listAgents) throw new AgentError('agent_listing_unavailable');
          const page = await context.operations.listAgents({
            ...(typeof args.afterSeq === 'string' ? { afterSeq: args.afterSeq } : {}),
            ...(typeof args.upperSeq === 'string' ? { upperSeq: args.upperSeq } : {}),
            ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          });
          return result(page as unknown as Json);
        },
      },
      {
        id: 'interrupt_agent',
        model: { name: 'interrupt_agent', snakeCase: true },
        version: '1',
        description:
          'Request interruption of one exact current child Run. This is not carrier/session cancellation or stopped confirmation.',
        inputSchema: object({ taskId: idSchema, targetRunId: idSchema, commandId: idSchema }, [
          'taskId',
          'targetRunId',
          'commandId',
        ]),
        async execute(input, context) {
          const args = value(input),
            ref = await reference(context, text(args, 'taskId'));
          if (!context.operations.interruptAgent)
            throw new AgentError('agent_interrupt_unavailable');
          const receipt = await context.operations.interruptAgent(ref, {
            commandId: text(args, 'commandId'),
            targetRunId: text(args, 'targetRunId'),
          });
          return result({ outcome: 'cancel_requested', ref: ref as unknown as Json, ...receipt });
        },
      },
    ],
  };
  return collaborationSurface(legacy, options, roles);
}

/** A compact public protocol over the original controlled operations, not a second Agent Loop. */
function collaborationSurface(
  legacy: Extension,
  options: TaskOptions,
  roles: ReadonlyMap<string, TaskRole>,
): Extension {
  const defaultRole =
    options.defaultRole ?? (roles.has('worker') ? 'worker' : [...roles.keys()][0]!);
  if (!roles.has(defaultRole) || options.presets?.some((id) => !roles.has(id)))
    throw new AgentError('invalid_task_roles');
  const presets = options.presets ?? [];
  const content = { type: 'string', minLength: 1, maxLength: 1048576 };
  const agentId = { type: 'string', minLength: 1, maxLength: 128 };
  const cursor = { type: 'string', pattern: '^(0|[1-9][0-9]*)$' };
  const errors: Record<string, [string, string, boolean | null]> = {
    invalid_task_arguments: ['invalid_request', 'correct_request', false],
    invalid_input_request: ['invalid_request', 'correct_request', false],
    invalid_agent_message: ['invalid_request', 'correct_request', false],
    invalid_wait_timeout: ['invalid_request', 'correct_request', false],
    child_configuration_unavailable: ['recovery_required', 'request_recovery', null],
    task_result_unverifiable: ['recovery_required', 'request_recovery', null],
    invalid_request: ['invalid_request', 'correct_request', false],
    task_role_unavailable: ['invalid_request', 'correct_request', false],
    invalid_cursor: ['invalid_cursor', 'restart_observation', false],
    cursor_expired: ['cursor_expired', 'restart_observation', false],
    cursor_ahead: ['invalid_cursor', 'restart_observation', false],
    invalid_mail_cursor: ['invalid_cursor', 'restart_observation', false],
    agent_unavailable: ['agent_unavailable', 'check_agent_id', false],
    task_not_found: ['agent_unavailable', 'check_agent_id', false],
    input_target_changed: ['target_changed', 'observe_then_new_call', false],
    input_target_stopped: ['target_changed', 'observe_then_new_call', false],
    operation_conflict: ['operation_conflict', 'inspect_original', false],
    command_conflict: ['operation_conflict', 'inspect_original', false],
    permission_denied: ['permission_denied', 'resolve_permission', false],
    input_cancelled: ['operation_cancelled', 'none', false],
    command_cancelled: ['operation_cancelled', 'none', false],
    operation_needs_review: ['recovery_required', 'request_recovery', false],
    operation_unverifiable: ['recovery_required', 'request_recovery', null],
  };
  const safe =
    (command: boolean, execute: (input: Json, context: ToolContext) => Promise<ToolResult>) =>
    async (input: Json, context: ToolContext): Promise<ToolResult> => {
      try {
        return await execute(input, context);
      } catch (error) {
        const code = error instanceof AgentError ? error.code : '';
        const cancelledObservation = code === 'cancel_requested' && !command;
        const projected = cancelledObservation
          ? ['operation_cancelled', 'none', false]
          : (errors[code] ?? ['receipt_unverifiable', 'inspect_original', null]);
        const details: Json = {
          ...(command ? { accepted: projected[2] } : {}),
          ...(code === 'cursor_expired'
            ? {
                resume_after_seq:
                  error instanceof AgentError && /^(0|[1-9][0-9]*)$/.test(error.message)
                    ? error.message
                    : null,
              }
            : {}),
          error: {
            code: projected[0],
            message: cancelledObservation
              ? 'Agent observation was cancelled.'
              : `Agent operation could not be verified (${projected[0]}).`,
            next_action: projected[1],
          },
        };
        return {
          outcome: 'failed',
          content: canonicalJson(details),
          details: {
            ...(details as Record<string, Json>),
            diagnostic: { code: code || 'internal_fault' },
          },
        };
      }
    };
  const make = (
    id: string,
    name: string,
    description: string,
    schema: Readonly<Record<string, Json>>,
    command: boolean,
    execute: (input: Json, context: ToolContext) => Promise<ToolResult>,
  ) => {
    const guarded = safe(command, execute);
    return {
      id,
      version: '1',
      model: { name, snakeCase: true },
      description,
      inputSchema: schema,
      ...(command ? { recovery: { version: '1' }, resume: guarded } : {}),
      execute: guarded,
    };
  };
  const command =
    (kind: 'follow_up' | 'interrupt') => async (input: Json, context: ToolContext) => {
      const args = value(input);
      if (!context.operations.applyAgentCommand) throw new AgentError('operation_unverifiable');
      const receipt = await context.operations.applyAgentCommand({
        agentId: text(args, 'agentId'),
        kind,
        ...(kind === 'follow_up' ? { content: text(args, 'content') } : {}),
      });
      return result({
        accepted: receipt.accepted,
        agent_id: receipt.agentId,
        state: receipt.state,
        ...(receipt.mode ? { mode: receipt.mode } : {}),
        ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
      });
    };
  return {
    ...legacy,
    tools: [
      ...(legacy.tools ?? []).map((tool) => ({ ...tool, model: { ...tool.model!, hidden: true } })),
      make(
        'task.spawn',
        'spawn_agent',
        `Delegate a concrete scoped prompt to a reusable child Agent. Default role ${defaultRole}: ${roles.get(defaultRole)!.description} Choose a registered preset whose capabilities can perform the required steps; a role never adds tools or permissions beyond the parent selection and child ceiling. Review the returned evidence for the current entry point and causal path before adopting conclusions; file or symbol existence alone does not establish that path. task_name is display only. Acceptance may remain queued. Parent normal completion does not cancel the child. No Provider, permission or Run identity can be supplied.`,
        object(
          {
            prompt: content,
            taskName: { type: 'string', minLength: 1, maxLength: 120 },
            ...(presets.length
              ? {
                  preset: {
                    type: 'string',
                    enum: [...presets],
                    description: `Optional trusted preset. Omit to use ${defaultRole}. Registered capabilities remain subject to the actual parent tools and child permissions.\n${presets.map((id) => `${id}: ${roles.get(id)!.description}`).join('\n')}`,
                  },
                }
              : {}),
          },
          ['prompt'],
        ),
        true,
        async (input, context) => {
          const args = value(input);
          const selected = typeof args.preset === 'string' ? args.preset : defaultRole;
          if ((args.preset !== undefined && !presets.includes(selected)) || !roles.has(selected))
            throw new AgentError('task_role_unavailable');
          const ref = await context.operations.ensure({
            key: `spawn-${context.executionId}`,
            request: {
              kind: 'agent',
              configurationId: roles.get(selected)!.configurationId,
              input: {
                content: text(args, 'prompt'),
                ...(typeof args.taskName === 'string' ? { name: args.taskName } : {}),
              },
            },
            cancellation: 'attached',
            continuation: { kind: 'agent_completion' },
          });
          return result({ accepted: true, agent_id: ref.childSessionId!, state: 'queued' });
        },
      ),
      make(
        'task.follow_up',
        'follow_up_agent',
        'Continue the same owned collaborator, including from a later parent turn, subject to current tool authorization. Running or queued work receives guidance at a safe boundary; idle starts one ordinary new turn in the same Session. The same agent_id spans turns. accepted and state describe this request at admission, not its completion; earlier results or completed events for that agent do not prove this follow-up finished. No preset change.',
        object({ agentId, content }, ['agentId', 'content']),
        true,
        command('follow_up'),
      ),
      make(
        'task.interrupt',
        'interrupt_agent',
        'Request interruption of the exact current or queued child work selected atomically at admission. Idle stays idle. Acknowledgment is not stopped confirmation and the collaborator remains reusable.',
        object({ agentId }, ['agentId']),
        true,
        command('interrupt'),
      ),
      make(
        'task.message',
        'send_agent_message',
        'Queue a complete message to a direct child or parent. Idle recipients stay idle. Accepted/received/prepared are distinct. If a child needs a reply to proceed, wait at most one explicit finite 30000ms observation window; without a valid reply, finish with an honest pending-decision result containing the complete question and completed/unfinished facts. Do not wait indefinitely for an idle parent.',
        {
          ...object({ agentId, target: { enum: ['parent'] }, content }, ['content']),
          oneOf: [
            { required: ['agentId'], not: { required: ['target'] } },
            { required: ['target'], not: { required: ['agentId'] } },
          ],
        },
        true,
        async (input, context) => {
          const args = value(input);
          if (!context.operations.sendStableAgentMessage)
            throw new AgentError('operation_unverifiable');
          await context.operations.sendStableAgentMessage(
            args.target === 'parent' ? 'parent' : text(args, 'agentId'),
            text(args, 'content'),
          );
          return result({ accepted: true, delivery: 'queued' });
        },
      ),
      make(
        'task.events',
        'wait_agent_events',
        'Observe only this Agent mailbox. after_seq defaults to "0" and may return historical events; continue from the last returned next_seq to avoid rereading returned events. seq is an observation position, not a turn identity; follow-up does not reset the mailbox. A completed event or its summary alone does not prove the latest request for that agent finished. Confirm using current work/state and an attributable complete result Source; if the relationship is not evidenced, leave completion unverified. Omitted/null wait_ms continuously waits in finite internal segments; zero takes a snapshot. Events do not acknowledge results; complete results/messages are adopted at ordinary safe checkpoints. Timeout does not cancel children.',
        object(
          {
            afterSeq: cursor,
            waitMs: { type: ['integer', 'null'], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
          [],
        ),
        false,
        async (input, context) => {
          const args = value(input);
          if (!context.operations.waitAgentEvents) throw new AgentError('operation_unverifiable');
          const waited = await context.operations.waitAgentEvents({
            ...(typeof args.afterSeq === 'string' ? { afterSeq: args.afterSeq } : {}),
            ...(args.waitMs === null || typeof args.waitMs === 'number'
              ? { waitMs: args.waitMs }
              : {}),
          });
          return result({
            reason: waited.reason,
            next_seq: waited.nextSeq,
            events: waited.events.map((event) => ({
              seq: event.seq,
              agent_id: event.agentId,
              kind: event.kind,
              ...(event.outcome ? { outcome: event.outcome } : {}),
              summary: event.summary,
            })),
          });
        },
      ),
      make(
        'task.list',
        'list_agents',
        'Read a stable direct-child directory anchored at first creation, with responsibility and recent-work sources. Fixed upper_seq bounds identities, each page reflects current status. current_work_source describes current work; last_outcome and last_result_source describe the most recent terminal result, which may precede current queued/running/waiting work. Do not label that older result as completion of a new follow-up. No activation, result consumption or Model request. Source content is the complete original text in this verified Tool body.',
        object(
          {
            agentIds: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              uniqueItems: true,
              items: agentId,
            },
            afterSeq: cursor,
            upperSeq: cursor,
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          [],
        ),
        false,
        async (input, context) => {
          const args = value(input);
          if (!context.operations.listStableAgents) throw new AgentError('operation_unverifiable');
          const page = await context.operations.listStableAgents(
            args as Parameters<NonNullable<typeof context.operations.listStableAgents>>[0],
          );
          const details = {
            items: page.items.map((item) => ({
              agent_id: item.agentId,
              task_name: item.taskName,
              assignment_summary: item.assignmentSummary,
              assignment_source: item.assignmentSource,
              current_work_summary: item.currentWorkSummary,
              current_work_source: item.currentWorkSource,
              work_relation: item.workRelation,
              state: item.state,
              last_outcome: item.lastOutcome,
              last_result_source: item.lastResultSource,
              last_result_summary: item.lastResultSource?.content.slice(0, 512) ?? null,
            })),
            upper_seq: page.upperSeq,
            next_after_seq: page.nextAfterSeq,
          } as unknown as Json;
          const complete = canonicalJson(details);
          if (new TextEncoder().encode(complete).byteLength > 32768 && context.artifacts) {
            const reference = await context.artifacts.publish({
              key: 'agents-directory',
              content: new TextEncoder().encode(complete),
              mediaType: 'application/json; charset=utf-8',
            });
            return {
              outcome: 'succeeded',
              content: 'Complete Agent directory and sources.',
              details,
              artifactRefs: [reference],
              modelContent: { kind: 'artifact', reference, encoding: 'utf-8' },
            };
          }
          return result(details);
        },
      ),
    ],
  };
}
