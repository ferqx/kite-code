import type {
  Extension,
  JobDefinition,
  Json,
  OperationRef,
  ToolContext,
  ToolResult,
} from '../extensions';
import { canonicalJson } from '../json';
import { AgentError } from '../storage/types';

export interface ShellToolsOptions {
  readonly job: JobDefinition;
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
async function reference(context: ToolContext, key: string): Promise<OperationRef> {
  const record = await context.records.get(`shell/${key}`);
  if (!record || record.contentType !== contentType || record.contentVersion !== 1)
    throw new AgentError('shell_reference_not_found');
  return args(record.value).ref as unknown as OperationRef;
}
/** Pure registrations. Only the ordinary Job.start path may start a process. */
export function createShellExtension(options: ShellToolsOptions): Extension {
  const job = Object.freeze({
    ...options.job,
    inputSchema: structuredClone(options.job.inputSchema),
    ...(options.job.resources ? { resources: structuredClone(options.job.resources) } : {}),
  });
  if (job.id !== 'shell.command') throw new AgentError('invalid_shell_job');
  return {
    id: 'builtin.shell',
    version: '1',
    apiMajor: 1,
    jobs: [job],
    records: [
      { contentType, contentVersion: 1, schema: object({ ref: { type: 'object' } }, ['ref']) },
    ],
    tools: [
      {
        id: 'shell.launch',
        version: '1',
        description: 'Start one exact supervised Shell Job. Acceptance is not completion.',
        inputSchema: object(
          {
            key: idSchema,
            command: { type: 'string', minLength: 1, maxLength: 262144 },
            cancellation: { enum: ['attached', 'detached'] },
          },
          ['key', 'command'],
        ),
        async execute(input, context) {
          const inputArgs = args(input);
          const key = text(inputArgs, 'key');
          const ref = await context.operations.ensure({
            key,
            request: {
              kind: 'job',
              definitionId: job.id,
              definitionVersion: job.version,
              input: { command: text(inputArgs, 'command') },
            },
            cancellation: inputArgs.cancellation === 'detached' ? 'detached' : 'attached',
          });
          const saved = { ref: ref as unknown as Json };
          const prior = await context.records.get(`shell/${key}`);
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
          return result({ accepted: true, shellId: key, ref: ref as unknown as Json });
        },
      },
      {
        id: 'shell.read',
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
          const ref = await reference(context, text(inputArgs, 'shellId'));
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
        version: '1',
        description: 'Wait for this exact Shell Job; timeout does not stop it.',
        inputSchema: object(
          { shellId: idSchema, timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 } },
          ['shellId'],
        ),
        async execute(input, context) {
          const inputArgs = args(input);
          const ref = await reference(context, text(inputArgs, 'shellId'));
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
        version: '1',
        description:
          'Request cancellation of one exact Shell Job. Receipt does not prove group stop.',
        inputSchema: object({ shellId: idSchema, commandId: idSchema }, ['shellId', 'commandId']),
        async execute(input, context) {
          const inputArgs = args(input);
          const ref = await reference(context, text(inputArgs, 'shellId'));
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
