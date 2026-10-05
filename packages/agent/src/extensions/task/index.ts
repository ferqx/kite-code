import { canonicalJson } from '../../json';
import { AgentError, type RequirementEvaluation } from '../../storage/types';
import type { Extension, Json, OperationRef, ToolContext, ToolResult } from '../index';

export interface TaskRole {
  readonly id: string;
  /** A trusted, already registered child configuration; callers cannot supply configuration IDs. */
  readonly configurationId: string;
  readonly description: string;
}
export interface TaskOptions {
  readonly roles: readonly TaskRole[];
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
        version: '1',
        description: 'Create a child Agent using a trusted role. Creation is not completion.',
        inputSchema: object(
          {
            key: idSchema,
            role: { type: 'string', enum: [...roles.keys()] },
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
              admission: 'fail_if_full',
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
        version: '1',
        description: 'Read the exact child carrier; no new Model or child execution is started.',
        inputSchema: object({ taskId: idSchema }, ['taskId']),
        async execute(input, context) {
          const ref = await reference(context, text(value(input), 'taskId'));
          const agent = await context.operations.readAgent(ref);
          return result({ ref: ref as unknown as Json, agent: agent as unknown as Json });
        },
      },
      {
        id: 'task_wait',
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
  const wait = extension.tools!.find((tool) => tool.id === 'task_wait')!;
  return {
    ...extension,
    tools: [
      ...extension.tools!,
      {
        ...wait,
        id: 'wait_agents',
        description:
          'Event-driven wait-any for exact child task IDs; does not consume messages or cancel targets.',
      },
      {
        ...wait,
        id: 'wait_agent',
        description:
          'Wait for own mailbox updates, input or interaction without consuming messages; optional exact task targets retain wait-any behavior.',
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
}
