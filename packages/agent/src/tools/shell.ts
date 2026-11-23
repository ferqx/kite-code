import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellOutputPreview } from '@kite-ai/trajectory';
import type {
  Extension,
  JobDefinition,
  Json,
  OperationRef,
  ToolContext,
  ToolResult,
} from '../extensions';
import { canonicalJson } from '../json';
import { modelCursor, readModelCursor } from '../model-cursor';
import { parseShellCommandInput, shellOperationKey, validShellOutputTokens } from '../shell-input';
import { AgentError } from '../storage/types';
import {
  createGitWorktreeTool,
  type GitWorktreeToolOptions,
  gitWorktreeRecordDefinition,
} from './git-worktree';
import { completeForegroundShell } from './shell-foreground';
import { retainShellOutput } from './shell-output';

export interface ShellToolsOptions {
  readonly job: JobDefinition;
  /** Only trusted scope-aware host assembly registers this optional request. */
  readonly permissionsSchema?: Json;
  readonly windows?: true;
  readonly windowsNativeGitBash?: true;
  readonly outputCollection?: true;
  readonly classifyPresentation?: (command: string) => Promise<'exploration' | 'standalone'>;
  /** Internal workers consume a machine-readable frame rather than a Shell preview. */
  readonly preserveJobOutput?: (input: Json) => boolean;
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
function savedOutput(
  outcome: ToolResult['outcome'],
  details: Record<string, Json>,
  ref: OperationRef,
  input: Json,
  context: ToolContext,
): ToolResult {
  if (!ref.executionId) throw new AgentError('shell_output_conflict');
  const preview = shellOutputPreview(
    details,
    ref.executionId,
    args(input).max_output_tokens,
    context.modelInputTokenLimit,
  );
  if (!preview) throw new AgentError('shell_output_conflict');
  const receipt = { ...details };
  delete receipt.output;
  return {
    outcome,
    content: preview.text,
    details: {
      ...receipt,
      outputFormat: 'model-preview',
      outputLimited: preview.limited,
      outputGaps: preview.gaps.map(({ stream, droppedBytes }) => ({ stream, droppedBytes })),
    },
  };
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
  const { preserveJobOutput } = options;
  const unbuffered = new WeakSet<Parameters<JobDefinition['observe']>[0]>();
  const job = Object.freeze({
    ...options.job,
    ...(preserveJobOutput
      ? {
          async start(input: Json, context: Parameters<JobDefinition['start']>[1]) {
            const preserve = preserveJobOutput(input);
            const handle = await options.job.start(input, context);
            if (preserve) unbuffered.add(handle);
            return handle;
          },
        }
      : {}),
    observe: (handle: Parameters<JobDefinition['observe']>[0]) =>
      unbuffered.has(handle)
        ? options.job.observe(handle)
        : retainShellOutput(options.job.observe(handle)),
    inputSchema: structuredClone(options.job.inputSchema),
    ...(options.job.resources ? { resources: structuredClone(options.job.resources) } : {}),
  });
  if (job.id !== 'shell.command') throw new AgentError('invalid_shell_job');
  const scopeGuidance = options.windowsNativeGitBash
    ? ' This command uses ordinary Windows user file and network access without confinement. Use it only when the task permits that scope.'
    : options.permissionsSchema
      ? ' Choose the filesystem request before composing the command. Authorization and host limits determine the effective scope. Before requesting wider access, verify the cause and any prior effects.'
      : '';
  const windowsGuidance = options.windows
    ? [
        'On Windows, resolve paths and perform file deletions or moves in the same shell. In PowerShell, use native cmdlets such as Remove-Item or Move-Item with -LiteralPath. Pass paths as arguments instead of building command strings.',
        'Before any recursive delete or move, verify that each resolved absolute target is within the intended workspace or a target directory explicitly authorized by the user.',
        'For a background helper or service started with PowerShell Start-Process, use -WindowStyle Hidden unless the user explicitly requests a visible interactive window.',
        'Kite stops remaining child processes when the command exits, including with background:true. Run helpers, flush changes, and close them within the same command. Reopen saved files in later Jobs.',
        options.windowsNativeGitBash
          ? ''
          : 'Bidirectional local named pipes may be denied under workspace_write. Prefer a supported single-process or standalone batch mode.',
        'After a sharing violation, verify what was saved and wait for the file to be released before retrying.',
      ]
        .filter(Boolean)
        .join(' ')
    : '';
  const windowsFilesystemGuidance =
    options.windows && !options.windowsNativeGitBash
      ? ' On Windows, request full_access for a required native helper when its startup or bidirectional local named pipe needs that scope, even for a workspace file.'
      : '';
  const outputGuidance = options.outputCollection
    ? 'KITE_OUTPUT_DIR belongs to the current Job. Keep the verified final file in the workspace or user-requested destination. If KITE_DOCUMENTS_BUN and KITE_DOCUMENTS_HELPER are available, run the helper with stage --input <saved-file>. It copies the saved file into KITE_OUTPUT_DIR and returns its actual absolutePath and a Markdown-ready absolute path in markdownTarget. Report the saved location with [filename](<markdownTarget>), using that value exactly. Otherwise resolve the actual absolute path in Shell before reporting it and copy the saved file to KITE_OUTPUT_DIR. Files from a failed Job are not delivered.'
    : '';
  const outputTokens = {
    type: 'integer',
    minimum: 1,
    description:
      'Model output preview budget in tokens (default 10000). The selected model can impose a lower budget.',
  };
  const schema = (foreground: boolean) => ({
    ...object(
      {
        key: {
          ...idSchema,
          description:
            'A new unique key for each new execution. Do not reuse an earlier key for a different command or a new execution. To recover an earlier result, use shell_read with that key instead of running it again.',
        },
        command: {
          type: 'string',
          minLength: 1,
          maxLength: 262144,
        },
        workdir: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          pattern: '^[^\\u0000]+$',
          description:
            'Working directory for this command, absolute or relative to the Session execution root. Defaults to that root.',
        },
        description: {
          type: 'string',
          description: 'Optional one-sentence purpose saved with the call.',
        },
        cancellation: {
          enum: ['attached', 'detached'],
          description:
            'Defaults to attached: cancelling the parent also cancels this command. Detached commands keep an independent lifecycle within the original task.',
        },
        ...(foreground
          ? {
              max_output_tokens: outputTokens,
              background: {
                type: 'boolean',
                default: false,
                description:
                  'Omit or use false to wait for completion. True returns the original shell_id and acceptance state. Confirm completion with shell_wait.',
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
                description: options.windowsNativeGitBash
                  ? 'The installed Git Bash uses normal user file access. A requested workspace scope is not a sandbox.'
                  : `Set "full_access" explicitly for commands required by the active skill, including its validation and delivery steps, when the user and task allow it. Use "workspace_write" for ordinary workspace commands and when the task limits you to that scope. Other external writes require task authorization and an explicit "full_access" request.${windowsFilesystemGuidance}`,
              },
              network: {
                enum: ['none', 'internet'],
                description: options.windowsNativeGitBash
                  ? 'Installed Git Bash is not network-isolated. Do not use it for tasks requiring an offline process.'
                  : 'Set "none" for local file work and local named-pipe IPC, including when requesting full_access. Set "internet" for required, authorized network access, including localhost, 127.0.0.1, ::1, LAN and the Internet.',
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
        execution_id: string;
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
            ...(parsed.workdir ? { workdir: parsed.workdir } : {}),
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
      execution_id: context.executionId,
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
        description: [
          `Execute one supervised command.${scopeGuidance} Foreground calls return retained output on completion.`,
          'Use the returned shell_id with shell_read, shell_wait, or shell_stop to recover output, wait, or stop the original Job. Repeating a command starts a new Job. Use execution_id for evidence and plan progress. Foreground and background calls follow parent cancellation. Create Git worktrees only with git_worktree. If it is unavailable, report the limitation.',
          windowsGuidance,
          outputGuidance,
        ]
          .filter(Boolean)
          .join('\n\n'),
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
          const ref = launched.ref as unknown as OperationRef;
          const completed = await completeForegroundShell(
            ref,
            context,
            parsed.timeoutMs ?? undefined,
            launched.presentation,
          );
          const details: Record<string, Json> = {
            ...args(completed.details ?? {}),
            shell_id: launched.shell_id,
            execution_id: launched.execution_id,
          };
          if (details.output !== undefined)
            return savedOutput(completed.outcome, details, ref, input, context);
          if (completed.content !== canonicalJson(completed.details ?? null))
            return {
              ...completed,
              content: `${completed.content}\nShell handle: ${canonicalJson({ shell_id: launched.shell_id, execution_id: launched.execution_id })}`,
              details,
            };
          return { ...completed, content: canonicalJson(details), details };
        },
      },
      {
        id: 'shell.launch',
        model: { name: 'shell_launch', snakeCase: true, hidden: true },
        version: '1',
        description: `Start one supervised command. Create Git worktrees only with git_worktree, never through Shell or scripts. Acceptance is not completion. execution_id identifies the original Tool call for evidence and plan progress; shell_id is its compact handle for shell_read, shell_wait and shell_stop. Copy returned identities exactly.${scopeGuidance}`,
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
            cursor: { type: 'string', minLength: 1, maxLength: 4096 },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            max_output_tokens: outputTokens,
          },
          ['shellId'],
        ),
        async execute(input, context) {
          const inputArgs = args(input);
          if (
            inputArgs.max_output_tokens !== undefined &&
            !validShellOutputTokens(inputArgs.max_output_tokens)
          )
            throw new AgentError('invalid_shell_arguments');
          const shellId = text(inputArgs, 'shellId');
          const resolved = await reference(context, shellId);
          if (!resolved) return missingReference(shellId);
          const { ref } = resolved;
          const execution = await context.operations.get(ref);
          if (!execution) throw new AgentError('shell_unverifiable');
          const scope = { kind: 'shell_output', ref: ref as unknown as Json };
          const position =
            inputArgs.cursor === undefined ? {} : args(readModelCursor(inputArgs.cursor, scope));
          if (
            Object.keys(position).some((key) => !['afterSeq', 'upperSeq'].includes(key)) ||
            Object.values(position).some(
              (value) => typeof value !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value),
            )
          )
            throw new AgentError('invalid_cursor');
          const output = await context.operations.readOutput(ref, {
            ...position,
            ...(typeof inputArgs.limit === 'number' ? { limit: inputArgs.limit } : {}),
          });
          const afterSeq = output.items.reduce(
            (latest, item) => (BigInt(item.throughSeq) > BigInt(latest) ? item.throughSeq : latest),
            String(position.afterSeq ?? '0'),
          );
          const upperSeq = String(position.upperSeq ?? output.highWaterSeq);
          const caughtUp = BigInt(afterSeq) >= BigInt(upperSeq);
          const details = {
            ref: ref as unknown as Json,
            execution: execution as unknown as Json,
            output: output as unknown as Json,
            next_cursor: modelCursor(scope, { afterSeq, ...(caughtUp ? {} : { upperSeq }) }),
            caught_up: caughtUp,
            terminal: ['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(
              execution.status,
            ),
          };
          return savedOutput('succeeded', details, ref, input, context);
        },
      },
      {
        id: 'shell.wait',
        model: {
          name: 'shell_wait',
          snakeCase: true,
          parameterNames: { timeoutMs: 'wait_ms' },
        },
        version: '1',
        description:
          'Wait for this exact command for up to wait_ms milliseconds (0–30000; default 30000). Timeout returns its current durable state and does not stop the command.',
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
          'Request cancellation of one exact shell_id. The host binds the cancellation intent and returns its receipt; acceptance alone does not confirm that the command stopped. Inspect the original Shell before any new execution.',
        inputSchema: object(
          {
            shellId: idSchema,
          },
          ['shellId'],
        ),
        async execute(input, context) {
          const inputArgs = args(input);
          const shellId = text(inputArgs, 'shellId');
          const resolved = await reference(context, shellId);
          if (!resolved) return missingReference(shellId);
          const { ref } = resolved;
          if (!context.operations.cancel) throw new AgentError('shell_stop_unavailable');
          const commandId = `shell-stop-${context.executionId}`;
          const receipt = await context.operations.cancel(ref, { commandId });
          return result({
            cancelRequested: true,
            command_id: commandId,
            cancellation_execution_id: context.executionId,
            receipt: (receipt as unknown as Json) ?? null,
            ref: ref as unknown as Json,
            execution: (await context.operations.get(ref)) as unknown as Json,
          });
        },
      },
    ],
  };
}
export { inspectWorktreeExecutionRoot } from './git-worktree/execution-root';
export { createShellToolBehaviors } from './shell-approval';
