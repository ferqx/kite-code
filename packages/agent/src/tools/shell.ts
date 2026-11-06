import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  Extension,
  JobDefinition,
  Json,
  OperationRef,
  ToolContext,
  ToolResult,
} from '../extensions';
import { canonicalJson } from '../json';
import { parseShellCommandInput, shellOperationKey } from '../shell-input';
import { AgentError } from '../storage/types';
import {
  createGitWorktreeTool,
  type GitWorktreeToolOptions,
  gitWorktreeRecordDefinition,
} from './git-worktree';
import { completeForegroundShell } from './shell-foreground';

export interface ShellToolsOptions {
  readonly job: JobDefinition;
  /** Only trusted scope-aware host assembly registers this optional request. */
  readonly permissionsSchema?: Json;
  readonly classifyPresentation?: (command: string) => Promise<'exploration' | 'standalone'>;
  readonly gitWorktree?: GitWorktreeToolOptions;
}
/** The source client uses built assets; it never executes a project-selected TS worker. */
export function gitWorktreeAssetDirectory(): string {
  if (!import.meta.url.endsWith('.js'))
    return fileURLToPath(new URL('../../dist/tools/git-worktree', import.meta.url));
  const module = dirname(fileURLToPath(import.meta.url));
  return join(basename(module) === 'tools' ? module : join(module, 'tools'), 'git-worktree');
}
const idSchema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.-]+$' };
const decimal = { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' };
const object = (properties: Record<string, Json>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const contentType = 'application/vnd.kite.shell-reference+json';
function args(input: Json): Record<string, Json> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new AgentError('invalid_shell_arguments');
  return input;
}
function text(input: Record<string, Json>, key: string): string {
  if (typeof input[key] !== 'string' || !input[key])
    throw new AgentError('invalid_shell_arguments');
  return input[key];
}
function result(details: Json): ToolResult {
  return { outcome: 'succeeded', content: canonicalJson(details), details };
}
function missingReference(shellId: string): ToolResult {
  return {
    outcome: 'failed',
    content: `Shell reference "${shellId}" was not found in the available history. Use the shell_id returned by a successful shell_execute or shell_launch call; do not invent an ID or restart an earlier command to recover its result. This lookup did not start or stop a command.`,
    details: { code: 'shell_reference_not_found', shellId },
  };
}
async function reference(context: ToolContext, key: string): Promise<{ ref: OperationRef } | null> {
  const record = await context.records.get(`shell/${key}`);
  if (!record || record.contentType !== contentType || record.contentVersion !== 1) return null;
  return { ref: args(record.value).ref as unknown as OperationRef };
}
/** Pure registrations. Only the ordinary Job.start path may start a process. */
export function createShellExtension(options: ShellToolsOptions): Extension {
  const job = Object.freeze({
    ...options.job,
    inputSchema: structuredClone(options.job.inputSchema),
    ...(options.job.resources ? { resources: structuredClone(options.job.resources) } : {}),
  });
  if (job.id !== 'shell.command') throw new AgentError('invalid_shell_job');
  const scopeGuidance = options.permissionsSchema
    ? ' filesystem and network are independent requested scopes, not authorization results. Omitted filesystem requests workspace_write; omitted network requests none. network:internet includes localhost, 127.0.0.1, ::1, LAN and Internet access. Risk approval does not grant networking to a network:none request. filesystem:full_access requests outside-workspace writes; it does not select Full approval mode or remove protected-path restrictions. In Request Approval and Auto, policy must authorize the requested scope. Ordinary Full sets its effective scope by mode; hard ceilings still apply. A failed command is never automatically rerun with wider permissions.'
    : '';
  const schema = (foreground: boolean) => ({
    ...object(
      {
        key: {
          ...idSchema,
          description:
            'A new unique key for each new execution. Do not reuse an earlier key for a different command or a new execution. To recover an earlier result, use shell_read with that key instead of running it again.',
        },
        command: { type: 'string', minLength: 1, maxLength: 262144 },
        description: {
          type: 'string',
          description:
            'A short sentence describing the purpose for display. Omit to use the command preview. This does not replace the command, grant permission or change execution identity.',
        },
        cancellation: {
          enum: ['attached', 'detached'],
          description:
            'Defaults to attached: cancelling the parent also cancels this command. Detached commands keep an independent lifecycle within the original task.',
        },
        ...(foreground
          ? {
              background: {
                type: 'boolean',
                default: false,
                description:
                  'False waits for the original command and output; true returns its handle and acceptance state. Background acceptance is not success or completion. Cancelling the parent still cancels this command. Cannot be combined with execution_timeout_ms.',
              },
              execution_timeout_ms: {
                type: 'integer',
                minimum: 1,
                maximum: 3600000,
                description:
                  'Foreground execution deadline in milliseconds, excluding approval and resource queues. Omit for no deadline. Expiry requests cancellation of the original command and waits for its actual stop result. Not supported with background:true.',
              },
              timeoutMs: {
                type: 'integer',
                minimum: 1,
                maximum: 3600000,
                description:
                  'Execution deadline in milliseconds. Expiry requests cancellation and waits for original stop evidence.',
              },
            }
          : {}),
        ...(options.permissionsSchema
          ? {
              permissions: options.permissionsSchema,
              filesystem: {
                enum: ['workspace_write', 'full_access'],
                description:
                  'Requested write scope; defaults to workspace_write. full_access requests external writes, not Full approval mode, and never removes protected-path limits.',
              },
              network: {
                enum: ['none', 'internet'],
                description:
                  'Requested network scope; defaults to none. internet includes localhost, 127.0.0.1, ::1, LAN and Internet access. Risk approval alone does not widen this request.',
              },
            }
          : {}),
      },
      foreground ? ['command'] : ['key', 'command'],
    ),
    ...(foreground
      ? {
          not: {
            properties: { background: { const: true } },
            required: ['background', 'execution_timeout_ms'],
          },
        }
      : {}),
  });
  async function launch(
    input: Json,
    context: ToolContext,
    kind: 'execute' | 'launch',
  ): Promise<
    | ToolResult
    | {
        accepted: true;
        shellId: string;
        shell_id: string;
        ref: Json;
        presentation: 'exploration' | 'standalone';
      }
  > {
    const inputArgs = args(input),
      key = shellOperationKey(inputArgs.key, context.executionId),
      command = text(inputArgs, 'command');
    const parsed = parseShellCommandInput(input, kind, !!options.permissionsSchema);
    if (!parsed)
      return {
        outcome: 'failed',
        content:
          'invalid_shell_arguments: No command was started. Use valid independent filesystem/network requests, do not mix them with legacy permissions, and do not combine background:true with a foreground execution deadline.',
        details: { code: 'invalid_shell_arguments' },
      };
    const presentation = (await options.classifyPresentation?.(command)) ?? 'standalone';
    let ref: OperationRef;
    try {
      ref = await context.operations.ensure({
        key,
        request: {
          kind: 'job',
          definitionId: job.id,
          definitionVersion: job.version,
          input: {
            command,
            ...(parsed.permissions !== undefined ? { permissions: parsed.permissions } : {}),
          },
        },
        cancellation: parsed.cancellation === 'detached' ? 'detached' : 'attached',
      });
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'operation_conflict') throw error;
      // ensure rejects the conflicting identity before creating a Command or Job.
      return {
        outcome: 'failed' as const,
        content: `The shell_id "${key}" already belongs to another request. This call did not start a new command. Use shell_read with this shell_id to inspect the original operation. Do not restart an unknown or completed command to recover its result.`,
        details: { code: 'operation_conflict', shellId: key },
      };
    }
    const saved = { ref: ref as unknown as Json },
      prior = await context.records.get(`shell/${key}`);
    if (prior) {
      if (canonicalJson(prior.value) !== canonicalJson(saved))
        throw new AgentError('shell_reference_conflict');
    } else
      await context.records.write({
        key: `shell/${key}`,
        expectedRevision: null,
        contentType,
        contentVersion: 1,
        value: saved,
      });
    return {
      accepted: true,
      shellId: key,
      shell_id: key,
      ref: ref as unknown as Json,
      presentation,
    };
  }
  return {
    id: 'builtin.shell',
    version: '1',
    apiMajor: 1,
    jobs: [job],
    records: [
      { contentType, contentVersion: 1, schema: object({ ref: { type: 'object' } }, ['ref']) },
      ...(options.gitWorktree ? [gitWorktreeRecordDefinition] : []),
    ],
    tools: [
      ...(options.gitWorktree ? [createGitWorktreeTool(options.gitWorktree)] : []),
      {
        id: 'shell.execute',
        model: {
          name: 'shell_execute',
          snakeCase: true,
          omitParameters: ['key', 'permissions', 'cancellation', 'timeoutMs'],
        },
        version: '1',
        description: `Execute one supervised command. Create Git worktrees only with git_worktree, never through this tool or scripts; if git_worktree is unavailable, report the limitation. By default wait for it to finish and return its retained output; background:true returns the original handle and acceptance state instead. Background acceptance is not completion. execution_timeout_ms is a foreground-only deadline (1–3600000 ms); omission means no execution deadline. Approval and resource queues do not consume it; expiry requests cancellation and waits for actual stop evidence. Ordinary model Shells remain attached to parent cancellation. The returned shell_id identifies this exact execution. A new call is a new execution even when command text is identical. Recover the original result with shell_read and its returned shell_id, without executing again. Large output is an explicit preview with the original shell_id.${scopeGuidance}`,
        inputSchema: schema(true),
        async execute(input, context) {
          const parsed = parseShellCommandInput(input, 'execute', !!options.permissionsSchema);
          if (!parsed)
            return {
              outcome: 'failed',
              content:
                'invalid_shell_arguments: No command was started. background:true cannot be combined with a foreground execution deadline. Use valid independent filesystem/network values; legacy permissions and timeoutMs cannot be mixed with their new fields.',
              details: { code: 'invalid_shell_arguments' },
            };
          const launched = await launch(input, context, 'execute');
          if ('outcome' in launched) return launched;
          if (parsed.background) return result(launched);
          const completed = await completeForegroundShell(
            launched.ref as unknown as OperationRef,
            context,
            parsed.timeoutMs ?? undefined,
            launched.presentation,
          );
          const details = { ...args(completed.details ?? {}), shell_id: launched.shell_id };
          return {
            ...completed,
            content:
              completed.details && completed.content === canonicalJson(completed.details)
                ? canonicalJson(details)
                : `${completed.content}\nShell handle: ${canonicalJson({ shell_id: launched.shell_id })}`,
            details,
          };
        },
      },
      {
        id: 'shell.launch',
        model: { name: 'shell_launch', snakeCase: true, hidden: true },
        version: '1',
        description: `Start one supervised command. Create Git worktrees only with git_worktree, never through Shell or scripts. Acceptance is not completion.${scopeGuidance}`,
        inputSchema: schema(false),
        async execute(input, context) {
          const launched = await launch(input, context, 'launch');
          return 'outcome' in launched ? launched : result(launched);
        },
      },
      {
        id: 'shell.read',
        model: { name: 'shell_read', snakeCase: true },
        version: '1',
        description: 'Read exact durable Shell status and keyset output; never restart it.',
        inputSchema: object(
          {
            shellId: idSchema,
            afterSeq: decimal,
            upperSeq: decimal,
            limit: { type: 'integer', minimum: 1, maximum: 200 },
          },
          ['shellId'],
        ),
        async execute(input, context) {
          const inputArgs = args(input);
          const shellId = text(inputArgs, 'shellId');
          const resolved = await reference(context, shellId);
          if (!resolved) return missingReference(shellId);
          const { ref } = resolved;
          const execution = await context.operations.get(ref);
          if (!execution) throw new AgentError('shell_unverifiable');
          const output = await context.operations.readOutput(ref, {
            ...(typeof inputArgs.afterSeq === 'string' ? { afterSeq: inputArgs.afterSeq } : {}),
            ...(typeof inputArgs.upperSeq === 'string' ? { upperSeq: inputArgs.upperSeq } : {}),
            ...(typeof inputArgs.limit === 'number' ? { limit: inputArgs.limit } : {}),
          });
          return result({
            ref: ref as unknown as Json,
            execution: execution as unknown as Json,
            output: output as unknown as Json,
          });
        },
      },
      {
        id: 'shell.wait',
        model: {
          name: 'shell_wait',
          snakeCase: true,
          parameterNames: { timeoutMs: 'wait_timeout_ms' },
        },
        version: '1',
        description:
          'Wait for this exact command for up to wait_timeout_ms milliseconds (0–30000; default 30000). Timeout returns its current durable state and does not stop the command.',
        inputSchema: object(
          { shellId: idSchema, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 } },
          ['shellId'],
        ),
        async execute(input, context) {
          const inputArgs = args(input);
          const shellId = text(inputArgs, 'shellId');
          const resolved = await reference(context, shellId);
          if (!resolved) return missingReference(shellId);
          const { ref } = resolved;
          try {
            const execution = await context.operations.wait(ref, {
              signal: context.signal,
              timeoutMs: typeof inputArgs.timeoutMs === 'number' ? inputArgs.timeoutMs : 30000,
            });
            return result({ ref: ref as unknown as Json, execution: execution as unknown as Json });
          } catch (error) {
            if (!(error instanceof AgentError) || error.code !== 'wait_timeout') throw error;
            const execution = await context.operations.get(ref);
            if (!execution) throw new AgentError('shell_unverifiable');
            return result({
              timedOut: true,
              ref: ref as unknown as Json,
              execution: execution as unknown as Json,
            });
          }
        },
      },
      {
        id: 'shell.stop',
        model: { name: 'shell_stop', snakeCase: true },
        version: '1',
        description:
          'Request cancellation of one exact command. shell_id is the returned Shell handle; command_id is a new unique ID chosen for this cancellation, not an ID copied from an earlier operation. Reuse command_id only to query/retry the same cancellation intent. Acceptance alone does not confirm that the command stopped.',
        inputSchema: object(
          {
            shellId: idSchema,
            commandId: {
              ...idSchema,
              description:
                'New unique cancellation intent ID. Do not copy ref.commandId or any existing command ID.',
            },
          },
          ['shellId', 'commandId'],
        ),
        async execute(input, context) {
          const inputArgs = args(input);
          const shellId = text(inputArgs, 'shellId');
          const resolved = await reference(context, shellId);
          if (!resolved) return missingReference(shellId);
          const { ref } = resolved;
          if (!context.operations.cancel) throw new AgentError('shell_stop_unavailable');
          await context.operations.cancel(ref, { commandId: text(inputArgs, 'commandId') });
          return result({
            cancelRequested: true,
            ref: ref as unknown as Json,
            execution: (await context.operations.get(ref)) as unknown as Json,
          });
        },
      },
    ],
  };
}
