import { canonicalJson } from '../../json';
import { modelCursor, readModelCursor } from '../../model-cursor';
import { readModelIdentifier } from '../../model-identifier';
import { AgentError } from '../../storage/types';
import type { Extension, Json, ToolContext, ToolDefinition, ToolResult } from '../index';
import { isChildPreparationFailure } from './preparation-failure';
import { defaultTaskRoleId } from './roles';
import { agentWorkReference, readAgentWorkReference } from './work-reference';

export { createDefaultTaskRequestClassifier } from '../../permissions/task-request';
export {
  defaultTaskRoleId,
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
}
const extensionId = 'builtin.task';
const decimalPosition = /^(0|[1-9][0-9]*)$/;
const object = (properties: Record<string, Json>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
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
  const defaultRole =
    options.defaultRole ??
    (roles.has(defaultTaskRoleId) ? defaultTaskRoleId : [...roles.keys()][0]!);
  if (!roles.has(defaultRole) || options.presets?.some((id) => !roles.has(id)))
    throw new AgentError('invalid_task_roles');
  const presets = options.presets ?? [];
  const content = { type: 'string', minLength: 1, maxLength: 1048576 };
  const agentId = { type: 'string', minLength: 1, maxLength: 128 };
  const cursor = { type: 'string', minLength: 1, maxLength: 4096 };
  const shortTarget = { type: 'string', pattern: '^a[1-9][0-9]{0,18}$' };
  async function targetId(context: ToolContext, target: string) {
    if (!/^a[1-9][0-9]{0,18}$/.test(target)) return target;
    if (!context.operations.readAgentTargets) throw new AgentError('agent_unavailable');
    const seq = BigInt(target.slice(1));
    if (seq > 9223372036854775807n) throw new AgentError('agent_unavailable');
    try {
      const items = await context.operations.readAgentTargets({ anchor: String(seq) });
      if (items[0]?.seq === String(seq)) return items[0].agentId;
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'invalid_cursor') throw error;
    }
    throw new AgentError('agent_unavailable');
  }
  async function targets(context: ToolContext, ids: string[]) {
    const result = new Map<string, string>();
    if (ids.length && context.operations.readAgentTargets) {
      const items = await context.operations.readAgentTargets({ agentIds: [...new Set(ids)] });
      for (const item of items) result.set(item.agentId, `a${item.seq}`);
    }
    return result;
  }
  const workReference = {
    type: 'string',
    pattern: '^aw_(?:u[A-Za-z0-9_-]{22}|s[A-Za-z0-9_-]+)$',
    maxLength: 1027,
    description:
      'Exact opaque work_ref returned for that work. Copy the entire string verbatim; ordinary UUID-backed references have 26 characters. Never shorten, decode or reconstruct it.',
  };
  const errors: Record<string, [string, string, boolean | null]> = {
    invalid_task_arguments: ['invalid_request', 'correct_request', false],
    invalid_input_request: ['invalid_request', 'correct_request', false],
    invalid_agent_message: ['invalid_request', 'correct_request', false],
    invalid_wait_timeout: ['invalid_request', 'correct_request', false],
    child_configuration_unavailable: ['recovery_required', 'request_recovery', null],
    invalid_request: ['invalid_request', 'correct_request', false],
    task_role_unavailable: ['invalid_request', 'correct_request', false],
    invalid_cursor: ['invalid_cursor', 'restart_observation', false],
    cursor_expired: ['cursor_expired', 'restart_observation', false],
    cursor_ahead: ['invalid_cursor', 'restart_observation', false],
    invalid_mail_cursor: ['invalid_cursor', 'restart_observation', false],
    invalid_agent_work_reference: ['invalid_work_reference', 'copy_work_ref', false],
    agent_unavailable: ['agent_unavailable', 'check_agent_id', false],
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
  const errorMessages: Readonly<Record<string, string>> = {
    invalid_request:
      'The Agent request has invalid arguments or an unavailable role. Correct it using the declared tool schema and available presets.',
    invalid_work_reference:
      'The work_ref could not be verified in this parent scope. Copy the exact returned work_ref from spawn_agent, follow_up_agent or list_agents. This reference check did not change existing Agent work; it may still be running.',
    invalid_cursor:
      'The observation cursor is invalid or ahead of the current mailbox or directory. Reuse the last valid next_cursor from the same tool and observation scope. This failure does not cancel existing Agent work.',
    cursor_expired:
      'The observation cursor is no longer retained. Pass resume_after_seq as cursor when provided, or restart observation. Existing Agent work may still be running.',
    agent_unavailable:
      'The requested Agent is unavailable in this parent scope. Use a target returned by list_agents. Do not create a replacement to recover an unknown result.',
    target_changed:
      'The selected Agent work changed or ended before this request could be accepted. Observe its current state before making a new request.',
    operation_conflict:
      'This operation conflicts with an existing request identity. Inspect the original receipt and result; do not reuse an identity for a different request or create a new identity to repeat an unconfirmed effect.',
    permission_denied:
      'Current permissions do not allow this Agent operation. Respect the restriction; changing an Agent or operation identity does not bypass it.',
    operation_cancelled:
      'This Agent request was cancelled. This does not confirm that a previously running child has stopped.',
    recovery_required:
      'The original Agent work requires recovery before it can continue. Inspect its recorded state and use the supported recovery action; do not restart it under a new identity.',
    receipt_unverifiable:
      'The original Agent operation receipt could not be verified. Inspect the original receipt and current Agent state before proceeding.',
  };
  const safe =
    (command: boolean, execute: (input: Json, context: ToolContext) => Promise<ToolResult>) =>
    async (input: Json, context: ToolContext): Promise<ToolResult> => {
      try {
        return await execute(input, context);
      } catch (error) {
        const code = error instanceof AgentError ? error.code : '';
        const preparationFailed = command && isChildPreparationFailure(error);
        const creationDenied = preparationFailed && code === 'child_agent_creation_denied';
        const cancelledObservation = code === 'cancel_requested' && !command;
        const projected = creationDenied
          ? ['permission_denied', 'ask_parent_to_delegate', false]
          : preparationFailed
            ? ['preparation_failed', 'resolve_configuration', false]
            : cancelledObservation
              ? ['operation_cancelled', 'none', false]
              : (errors[code] ?? ['receipt_unverifiable', 'inspect_original', null]);
        const preparationMessages: Readonly<Record<string, string>> = {
          skill_capability_missing:
            'A selected skill requires a capability unavailable to this collaborator.',
          child_model_unavailable: 'The selected model is unavailable to this collaborator.',
          child_configuration_unavailable:
            'The selected collaborator configuration is unavailable.',
          child_tool_scope_exceeds_parent:
            'The selected collaborator tools exceed the available parent tools.',
        };
        const explanation = creationDenied
          ? 'Only the main Agent can create collaborators. Send the remaining work to your parent instead. Do not retry this creation through another tool, role or approval mode.'
          : preparationFailed
            ? `This request did not start new collaborator work or deliver new guidance. Existing collaborator work may still run or finish independently. ${Object.hasOwn(preparationMessages, code) ? preparationMessages[code] : 'The collaborator configuration could not be prepared.'} Check the selected skills, tools and model before deciding whether a separately authorized new request is appropriate.`
            : cancelledObservation
              ? 'Agent observation was cancelled.'
              : !command && projected[0] === 'receipt_unverifiable'
                ? 'The Agent observation could not be verified. Observe the current state again; this failure does not prove any child work stopped, failed or disappeared.'
                : errorMessages[projected[0] as string]!;
        const message =
          command && projected[2] === false
            ? `This Agent request was not accepted. ${explanation}`
            : command && projected[2] === null
              ? `Acceptance of this Agent request is unknown; it may already have been accepted. Do not repeat it or create a new operation identity to try again. ${explanation}`
              : explanation;
        const details: Json = {
          ...(command ? { accepted: projected[2] } : {}),
          ...(code === 'cursor_expired'
            ? {
                resume_after_seq:
                  error instanceof AgentError && decimalPosition.test(error.message)
                    ? error.message
                    : null,
              }
            : {}),
          error: {
            code: projected[0],
            message,
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
  ): ToolDefinition => {
    const guarded = safe(command, execute);
    const model: ToolDefinition['model'] = { name, snakeCase: true, resultVersion: '1' };
    const projections: Record<string, Omit<NonNullable<ToolDefinition['model']>, 'name'>> = {
      'task.spawn': {
        parameterNames: { prompt: 'message', ...(presets.length ? { preset: 'agent_type' } : {}) },
        requiredParameters: ['taskName'],
      },
      'task.follow_up': {
        parameterNames: { agentId: 'target', content: 'message' },
        inputSchema: object({ agentId: shortTarget, content }, ['agentId', 'content']),
      },
      'task.interrupt': {
        parameterNames: { agentId: 'target' },
        inputSchema: object({ agentId: shortTarget }, ['agentId']),
      },
      'task.message': {
        parameterNames: { agentId: 'target', content: 'message' },
        inputSchema: object(
          { agentId: { type: 'string', pattern: '^(?:parent|a[1-9][0-9]{0,18})$' }, content },
          ['agentId', 'content'],
        ),
      },
      'task.events': {
        parameterNames: { waitMs: 'timeout_ms' },
        inputSchema: object(
          { waitMs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } },
          [],
        ),
      },
      'task.list': { inputSchema: object({}, []) },
    };
    return {
      id,
      version: '1',
      model: { ...model, ...projections[id] },
      formatModelResult({ result }) {
        if (result.outcome !== 'succeeded' || !result.details) return;
        const details = value(result.details);
        const project = (row: Record<string, Json>) => {
          const { agent_id: _agentId, work_ref, last_result_work_ref, seq: _seq, ...visible } = row;
          return {
            ...visible,
            ...(typeof work_ref === 'string'
              ? { dispatch_id: readModelIdentifier(work_ref.slice(3)) }
              : {}),
            ...(typeof last_result_work_ref === 'string'
              ? { last_result_dispatch_id: readModelIdentifier(last_result_work_ref.slice(3)) }
              : {}),
          };
        };
        if (id === 'task.events')
          return canonicalJson({
            reason: details.reason!,
            ...(details.history_gap ? { history_gap: true } : {}),
            events: Array.isArray(details.events)
              ? details.events.map((event) => project(value(event)))
              : [],
          });
        if (id === 'task.list')
          return canonicalJson({
            items: Array.isArray(details.items)
              ? details.items.map((item) => project(value(item)))
              : [],
            ...(details.next_cursor ? { truncated: true } : {}),
          });
        return canonicalJson(project(details));
      },
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
      const selected = text(args, 'agentId');
      const agentId = await targetId(context, selected);
      const expectedWork =
        args.workRef === undefined
          ? undefined
          : await readAgentWorkReference(args.workRef, context);
      if (expectedWork && expectedWork.childSessionId !== agentId)
        throw new AgentError('input_target_changed');
      const receipt = await context.operations.applyAgentCommand({
        agentId,
        kind,
        ...(expectedWork ? { expectedWork } : {}),
        ...(kind === 'follow_up' ? { content: text(args, 'content') } : {}),
      });
      return result({
        accepted: receipt.accepted,
        agent_id: receipt.agentId,
        ...(/^a[1-9][0-9]*$/.test(selected) ? { target: selected } : {}),
        state: receipt.state,
        work_ref: agentWorkReference(receipt.ref),
        ...(receipt.mode ? { mode: receipt.mode } : {}),
        ...(receipt.outcome ? { outcome: receipt.outcome } : {}),
      });
    };
  return {
    id: extensionId,
    version: '1',
    apiMajor: 1,
    tools: [
      make(
        'task.spawn',
        'spawn_agent',
        `Delegate a concrete scoped message to a reusable child Agent. Default role ${defaultRole}: ${roles.get(defaultRole)!.description} Choose a registered agent_type capable of the required work within the parent tool and permission ceiling. Include exact targets, deliverables and once-only limits. The returned target identifies this child for later commands. Acceptance can be queued. The finished report arrives separately in the parent mailbox.`,
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
          const [agent] = await targets(context, ref.childSessionId ? [ref.childSessionId] : []);
          return result({
            accepted: true,
            agent_id: ref.childSessionId!,
            ...(agent ? { target: agent[1] } : {}),
            work_ref: agentWorkReference(ref),
            state: 'queued',
          });
        },
      ),
      make(
        'task.follow_up',
        'follow_up_agent',
        'Continue the child identified by target. Active work receives guidance at a safe boundary. An idle child starts a new turn in the same Session. Acceptance is separate from completion. Compare the dispatch identity with the resulting report before adopting the result.',
        object({ agentId, content }, ['agentId', 'content']),
        true,
        command('follow_up'),
      ),
      make(
        'task.interrupt',
        'interrupt_agent',
        'Request interruption of the exact current or queued child work selected atomically at admission. Idle stays idle. Acknowledgment is not stopped confirmation and the collaborator remains reusable.',
        object({ agentId, workRef: workReference }, ['agentId']),
        true,
        command('interrupt'),
      ),
      make(
        'task.message',
        'send_agent_message',
        'Queue a complete message to a direct child or parent. When a child worktree creation notice arrives, relay its exact path and relevant task facts only to the direct children that need them; use this tool for active children and follow_up_agent for concrete remaining work in an idle child. A worktree notice neither changes cwd nor grants permission: use the reported path explicitly within existing permissions. A successful result acknowledges queue acceptance only; it does not confirm that the recipient received, read or acted on the message. Do not wait for an additional message acknowledgment after success. Continue independent authorized work. If a child cannot proceed without an answer, finish with an honest pending-decision result containing the complete question and completed/unfinished facts, so the parent can resolve it and explicitly continue the same child. Idle recipients stay idle; use follow_up_agent when an idle child must resume concrete remaining work.',
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
          const selected = args.target === 'parent' ? 'parent' : text(args, 'agentId');
          await context.operations.sendStableAgentMessage(
            await targetId(context, selected),
            text(args, 'content'),
          );
          return result({ accepted: true, delivery: 'queued' });
        },
      ),
      make(
        'task.events',
        'wait_agent',
        'Wait for any new event in the parent mailbox. Defaults to 30000ms; zero returns immediately. The runtime remembers the mailbox position for the next call. Complete child reports are delivered separately. An empty timeout does not establish failure or completion. A timeout does not stop child work. If a child result is still needed, continue independent authorized work or call wait_agent again. An empty timeout by itself does not call for a user update.',
        object(
          {
            workRefs: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              uniqueItems: true,
              items: workReference,
            },
            cursor,
            waitMs: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
          [],
        ),
        false,
        async (input, context) => {
          const args = value(input);
          if (!context.operations.waitAgentEvents) throw new AgentError('operation_unverifiable');
          const refs = Array.isArray(args.workRefs)
            ? await Promise.all(args.workRefs.map((ref) => readAgentWorkReference(ref, context)))
            : undefined;
          let afterSeq = args.cursor;
          if (typeof afterSeq === 'string' && !decimalPosition.test(afterSeq))
            // Older saved receipts used a scoped token. Decode it only for the original mailbox.
            afterSeq = readModelCursor(afterSeq, {
              kind: 'agent_events',
              sessionId: context.sessionId,
            });
          if (
            afterSeq !== undefined &&
            (typeof afterSeq !== 'string' || !decimalPosition.test(afterSeq))
          )
            throw new AgentError('invalid_cursor');
          const waited = await context.operations.waitAgentEvents({
            ...(typeof afterSeq === 'string' ? { afterSeq } : {}),
            ...(refs ? { workRefs: refs } : {}),
            waitMs: typeof args.waitMs === 'number' ? args.waitMs : 30000,
          });
          const senderTargets = await targets(
            context,
            waited.events.map((event) => event.agentId),
          );
          const visible = {
            reason: waited.reason,
            ...(afterSeq === undefined ? {} : { next_cursor: waited.nextSeq }),
            ...(waited.historyGap ? { history_gap: true } : {}),
            events: waited.events.map((event) => ({
              seq: event.seq,
              agent_id: event.agentId,
              ...(senderTargets.has(event.agentId)
                ? { target: senderTargets.get(event.agentId)! }
                : {}),
              kind: event.kind,
              ...(event.workRef ? { work_ref: agentWorkReference(event.workRef) } : {}),
              ...(event.outcome ? { outcome: event.outcome } : {}),
              summary: event.summary,
            })),
          };
          const response = result(visible);
          return waited.observation
            ? {
                ...response,
                details: { ...visible, agentEventObservation: { ...waited.observation } },
              }
            : response;
        },
      ),
      make(
        'task.list',
        'list_agents',
        'List the current direct children, stable targets and last known work. A previous result can precede the current queued or running work. This is an observation only.',
        object(
          {
            agentIds: {
              type: 'array',
              minItems: 1,
              maxItems: 200,
              uniqueItems: true,
              items: agentId,
            },
            cursor,
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          [],
        ),
        false,
        async (input, context) => {
          const args = value(input);
          if (!context.operations.listStableAgents) throw new AgentError('operation_unverifiable');
          const scope = {
            kind: 'agents',
            sessionId: context.sessionId,
            agentIds: Array.isArray(args.agentIds) ? [...args.agentIds].sort() : null,
          };
          const position =
            args.cursor === undefined ? {} : value(readModelCursor(args.cursor, scope));
          if (
            Object.keys(position).some((key) => !['afterSeq', 'upperSeq'].includes(key)) ||
            Object.values(position).some(
              (v) => typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v),
            )
          )
            throw new AgentError('invalid_cursor');
          const page = await context.operations.listStableAgents({
            ...(args.agentIds ? { agentIds: args.agentIds as string[] } : {}),
            ...position,
            limit: typeof args.limit === 'number' ? args.limit : 200,
          });
          const details = {
            items: page.items.map((item) => ({
              agent_id: item.agentId,
              target: `a${item.seq}`,
              task_name: item.taskName,
              assignment_summary: item.assignmentSummary,
              assignment_source: item.assignmentSource,
              current_work_summary: item.currentWorkSummary,
              current_work_source: item.currentWorkSource,
              work_relation: item.workRelation,
              state: item.state,
              work_ref: agentWorkReference(item.ref),
              last_outcome: item.lastOutcome,
              last_result_source: item.lastResultSource,
              last_result_work_ref: item.lastResultRef
                ? agentWorkReference(item.lastResultRef)
                : null,
              last_result_summary: item.lastResultSource?.content.slice(0, 512) ?? null,
            })),
            next_cursor:
              page.nextAfterSeq === null
                ? null
                : modelCursor(scope, { afterSeq: page.nextAfterSeq, upperSeq: page.upperSeq }),
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
