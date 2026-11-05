import { canonicalJson } from '../../json';
import { AgentError } from '../../storage/types';
import type { Extension, Json, ToolContext, ToolResult } from '../index';
import { isChildPreparationFailure } from './preparation-failure';

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
}
const extensionId = 'builtin.task';
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
    invalid_request: ['invalid_request', 'correct_request', false],
    task_role_unavailable: ['invalid_request', 'correct_request', false],
    invalid_cursor: ['invalid_cursor', 'restart_observation', false],
    cursor_expired: ['cursor_expired', 'restart_observation', false],
    cursor_ahead: ['invalid_cursor', 'restart_observation', false],
    invalid_mail_cursor: ['invalid_cursor', 'restart_observation', false],
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
    invalid_cursor:
      'The observation cursor is invalid or ahead of the current mailbox or directory. Restart observation from a valid returned cursor; this does not cancel existing Agent work.',
    cursor_expired:
      'The observation cursor is no longer retained. Resume from resume_after_seq when provided, or restart observation. Do not infer that existing Agent work was lost or stopped.',
    agent_unavailable:
      'The requested Agent is unavailable in this parent scope. Check its exact agent_id against list_agents; do not invent an ID or create a replacement to recover an unknown result.',
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
        const cancelledObservation = code === 'cancel_requested' && !command;
        const projected = preparationFailed
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
        const explanation = preparationFailed
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
                  error instanceof AgentError && /^(0|[1-9][0-9]*)$/.test(error.message)
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
    id: extensionId,
    version: '1',
    apiMajor: 1,
    tools: [
      make(
        'task.spawn',
        'spawn_agent',
        `Delegate a concrete scoped prompt to a reusable child Agent. Default role ${defaultRole}: ${roles.get(defaultRole)!.description} Choose a registered preset whose capabilities can perform the required steps; a role never adds tools or permissions beyond the parent selection and child ceiling. Include the exact targets, required content or format, once-only limits and fallback conditions the child needs; referring to user instructions not included in the prompt does not transmit them. Review the actual result against the original request before adopting completion claims. task_name is display only. Acceptance may remain queued. Parent normal completion does not cancel the child. No Provider, permission or Run identity can be supplied.`,
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
        'Continue the same owned collaborator for concrete remaining work, including from a later parent turn, subject to current tool authorization. State the exact discrepancy and correction, preserving successful effects and once-only limits; do not restart completed work. Running or queued work receives guidance at a safe boundary; idle starts one ordinary new turn in the same Session. The same agent_id spans turns. accepted and state describe this request at admission, not its completion; earlier results or completed events for that agent do not prove this follow-up finished. No preset change.',
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
        'Queue a complete message to a direct child or parent. Idle recipients stay idle; use follow_up_agent when an idle child must resume concrete remaining work. Accepted/received/prepared are distinct. If a child needs a reply to proceed, wait at most one explicit finite 30000ms observation window; without a valid reply, finish with an honest pending-decision result containing the complete question and completed/unfinished facts. Do not wait indefinitely for an idle parent.',
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
