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
  readonly dialect?: 'git-bash' | 'powershell';
  readonly powerShellVersion?: string;
  readonly powerShellEdition?: 'Desktop' | 'Core';
  readonly gitBashVersion?: string;
  readonly windowsUserLocale?: string;
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
  const scopeGuidance = options.permissionsSchema
    ? ' filesystem and network are independent requested scopes, not authorization results. Omitted filesystem requests workspace_write; omitted network requests none. network:internet includes localhost, 127.0.0.1, ::1, LAN and Internet access. Risk approval does not grant networking to a network:none request. filesystem:full_access requests outside-workspace writes; it does not select Full approval mode or remove protected-path restrictions. In Request Approval and Auto, policy must authorize the requested scope. Ordinary Full sets its effective scope by mode; hard ceilings still apply. A failed command is never automatically rerun with wider permissions.'
    : '';
  const powerShellVersion = options.powerShellVersion ?? '(version not reported)';
  const windowsPowerShell = options.powerShellEdition === 'Desktop';
  const gitBashVersion = options.gitBashVersion ? ` ${options.gitBashVersion}` : '';
  const locale = options.windowsUserLocale
    ? ` Windows user locale is ${options.windowsUserLocale}.`
    : '';
  const windowsTextGuidance = options.dialect
    ? `${locale} Kite reads stdout and stderr as UTF-8. Command messages, regional formats, and output encoding can vary by program. Prefer exit codes and structured output. Use the program's language or locale option when the task specifies one.`
    : '';
  const dialectGuidance =
    options.dialect === 'powershell'
      ? ` The command language is ${windowsPowerShell ? 'Windows ' : ''}PowerShell ${powerShellVersion}. Use PowerShell cmdlets and Windows paths, for example Get-ChildItem -Name, Get-Content -LiteralPath and rg.exe --files. For each required native step in a compound script or dynamic invocation, check $LASTEXITCODE immediately and exit with it on failure. Pass structured data by stdin or file when the program supports it.${windowsPowerShell ? ' Supply -UseBasicParsing for Invoke-WebRequest.' : ''} Request internet scope for network commands.`
      : options.dialect === 'git-bash'
        ? ` The command language is Git Bash${gitBashVersion} on Windows. Check required steps before continuing. Use pipefail when every stage of a pipeline must succeed.`
        : '';
  const environmentGuidance =
    ' Each execution starts a fresh process in the session execution root or requested workdir. Directory changes and environment assignments do not carry across calls. Keep intermediate files needed by later Jobs in the workspace.';
  const lookupGuidance = options.dialect
    ? ` To check an uncertain executable, run ${options.dialect === 'powershell' ? 'Get-Command NAME' : 'type NAME'} as a standalone probe and keep its diagnostics. If the result gives an absolute candidate path, check it with the program's supported version probe before considering installation.`
    : ' If a required program is uncertain, check command resolution and a supported version probe in the same Job before using it.';
  const windowsProcessGuidance = options.dialect
    ? ' On Windows, Kite stops remaining child processes when the command exits, including with background:true. Before splitting a stateful workflow, identify where each step will save its data to disk. Start and use local helpers within the same running command, then flush their changes and close them before it exits. Reopen the saved file from disk in the next call before further edits or delivery. Default local named pipes can deny bidirectional access under workspace_write. When available, select the CLI’s supported single-process or standalone batch mode before execution. After a sharing violation, verify what was saved and wait for the process holding the file to release it before retrying.'
    : '';
  const windowsPipeScopeGuidance =
    options.dialect && options.permissionsSchema
      ? ' If an operation requires bidirectional access to a local named pipe denied under workspace_write, request filesystem:full_access for that command through the existing authorization flow. Keep network:none for IPC that uses only local named pipes.'
      : '';
  const outputGuidance = options.outputCollection
    ? ' KITE_OUTPUT_DIR belongs to the current Job. Put only verified final files there in the delivery call. Use $env:KITE_OUTPUT_DIR in PowerShell and $KITE_OUTPUT_DIR in POSIX shells. Files from a failed Job are not delivered.'
    : '';
  const searchGuidance =
    'Prefer rg for text search and rg --files for file discovery. Use alternatives when rg is unavailable.';
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
          ...(dialectGuidance
            ? { description: (dialectGuidance + windowsTextGuidance).trim() }
            : {}),
        },
        workdir: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          pattern: '^[^\\u0000]+$',
          description:
            'Execution directory, absolute or relative to the host fixed workspace directory. Does not change Session cwd; existing filesystem/network scopes still apply.',
        },
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
              max_output_tokens: outputTokens,
              background: {
                type: 'boolean',
                default: false,
                description:
                  'Omit or use false when foreground execution is required. True returns the original command handle and acceptance state, not completion. After acceptance, use shell_wait or shell_read; never rerun the command merely to change foreground/background waiting. Cancelling the parent still cancels this command. Cannot be combined with execution_timeout_ms.',
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
        description: `Execute one supervised command.${dialectGuidance}${windowsTextGuidance}${environmentGuidance}${lookupGuidance}${windowsProcessGuidance}${outputGuidance} ${searchGuidance} Create Git worktrees only with git_worktree, never through this tool or scripts; if git_worktree is unavailable, report the limitation. By default wait for it to finish and return its retained output; background:true returns the original handle and acceptance state instead. Background acceptance is not completion. execution_timeout_ms is a foreground-only deadline (1–3600000 ms); omission means no execution deadline. Approval and resource queues do not consume it; expiry requests cancellation and waits for actual stop evidence. Ordinary model Shells remain attached to parent cancellation. The returned execution_id identifies this exact Tool call for execution evidence and plan progress. shell_id is its compact handle for shell_read, shell_wait and shell_stop; copy it exactly, without deriving another identity. A new call is a new execution even when command text is identical. Recover the original result with shell_read and its returned shell_id, without executing again. Large output is an explicit preview with the original shell_id.${scopeGuidance}${windowsPipeScopeGuidance}`,
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
        description: `Start one supervised command.${dialectGuidance}${windowsTextGuidance} Create Git worktrees only with git_worktree, never through Shell or scripts. Acceptance is not completion. execution_id identifies the original Tool call for evidence and plan progress; shell_id is its compact handle for shell_read, shell_wait and shell_stop. Copy returned identities exactly.${scopeGuidance}`,
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
