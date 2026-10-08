import type { ArtifactRef, ToolContext, ToolDefinition } from '../extensions';
import type { Json, JsonSchema } from '../storage/types';
import { AgentError } from '../storage/types';
import type { FileBaseline, FileSnapshot, WorkspaceFiles } from './files';

/** Optional trusted host capture. Tokens and evidence never come from Model input. */
export interface FileMutationCapture {
  before(
    input: { operation: 'write' | 'edit'; path: string; base: FileBaseline | null },
    context: ToolContext,
  ): Promise<unknown>;
  after(token: unknown, result: FileSnapshot, context: ToolContext): Promise<void>;
  failed(token: unknown, error: unknown, context: ToolContext): Promise<void>;
}

const base: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hash', 'size', 'device', 'inode'],
  properties: {
    hash: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    size: { type: 'integer', minimum: 0 },
    device: { type: 'string' },
    inode: { type: 'string' },
  },
};
const path = { type: 'string', maxLength: 4096 };
const artifactSchema: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'mediaType', 'size', 'scope'],
  properties: {
    id: { type: 'string', minLength: 1 },
    mediaType: { type: 'string', minLength: 1 },
    size: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
    scope: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'id'],
      properties: {
        kind: { enum: ['session', 'message', 'execution'] },
        id: { type: 'string', minLength: 1 },
      },
    },
  },
};
async function textInput(
  input: Record<string, Json>,
  name: string,
  context: ToolContext,
): Promise<string> {
  const artifact = input[`${name}Artifact`];
  if (artifact === undefined) return string(input[name]);
  if (input[name] !== undefined) throw new AgentError('file_input_invalid');
  if (!context.artifacts) throw new AgentError('artifact_read_unavailable');
  const value = object(artifact),
    scope = object(value.scope ?? null);
  if (!['session', 'message', 'execution'].includes(string(scope.kind)))
    throw new AgentError('file_input_invalid');
  const reference: ArtifactRef = {
    id: string(value.id),
    mediaType: string(value.mediaType),
    size: string(value.size),
    scope: { kind: scope.kind as 'session' | 'message' | 'execution', id: string(scope.id) },
  };
  const bytes = await context.artifacts.read(reference);
  context.signal.throwIfAborted();
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AgentError('file_encoding_invalid');
  }
}
function object(value: Json): Record<string, Json> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AgentError('file_input_invalid');
  return value;
}
function string(value: Json | undefined): string {
  if (typeof value !== 'string') throw new AgentError('file_input_invalid');
  return value;
}
function baseline(value: Json | undefined): FileBaseline | null {
  if (value === null) return null;
  const input = object(value ?? null);
  if (
    typeof input.size !== 'number' ||
    !Number.isSafeInteger(input.size) ||
    input.size < 0 ||
    !/^[a-f0-9]{64}$/.test(string(input.hash))
  )
    throw new AgentError('file_input_invalid');
  return {
    hash: string(input.hash),
    size: input.size,
    device: string(input.device),
    inode: string(input.inode),
  };
}
/** Ordinary Tools: permission, source freshness and execution receipts remain core responsibilities. */
export function createFileTools(
  files: WorkspaceFiles,
  options: { capture?: FileMutationCapture } = {},
): readonly ToolDefinition[] {
  const capture = options.capture;
  async function mutation(
    input: { operation: 'write' | 'edit'; path: string; base: FileBaseline | null },
    context: ToolContext,
    execute: () => Promise<FileSnapshot>,
  ): Promise<FileSnapshot> {
    if (!capture) return execute();
    const token = await capture.before(input, context);
    let published = false;
    try {
      context.signal.throwIfAborted();
      const result = await execute();
      published = true;
      await capture.after(token, result, context);
      return result;
    } catch (error) {
      const reported = published
        ? new AgentError(
            'file_publish_outcome_unknown',
            error instanceof Error ? error.message : String(error),
          )
        : error;
      try {
        await capture.failed(token, reported, context);
      } catch {
        /* An incomplete capture stays ineligible. */
      }
      throw reported;
    }
  }
  const definitions: {
    name: string;
    required: string[];
    properties: Record<string, Json>;
    call: (input: Record<string, Json>, context: ToolContext) => Promise<unknown>;
    oneOf?: Json[];
  }[] = [
    {
      name: 'read',
      required: ['path'],
      properties: {
        path,
        offset: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        limit: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      },
      call: (i) =>
        files.read(string(i.path), {
          ...(i.offset === undefined ? {} : { offset: Number(i.offset) }),
          ...(i.limit === undefined ? {} : { limit: Number(i.limit) }),
        }),
    },
    {
      name: 'write',
      required: ['path', 'base'],
      properties: {
        path,
        content: { type: 'string' },
        contentArtifact: artifactSchema,
        base: { anyOf: [base, { type: 'null' }] },
      },
      oneOf: [
        { required: ['content'], not: { required: ['contentArtifact'] } },
        { required: ['contentArtifact'], not: { required: ['content'] } },
      ],
      call: async (i, context) => {
        const content = await textInput(i, 'content', context);
        context.signal.throwIfAborted();
        const path = string(i.path),
          base = baseline(i.base);
        return mutation({ operation: 'write', path, base }, context, () =>
          files.write({ path, content, base }),
        );
      },
    },
    {
      name: 'edit',
      required: ['path', 'occurrences', 'base'],
      oneOf: [
        { required: ['find'], not: { required: ['findArtifact'] } },
        { required: ['findArtifact'], not: { required: ['find'] } },
      ],
      properties: {
        path,
        find: { type: 'string', minLength: 1 },
        replace: { type: 'string' },
        findArtifact: artifactSchema,
        replaceArtifact: artifactSchema,
        occurrences: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
        base,
      },
      call: async (i, context) => {
        const b = baseline(i.base);
        if (!b || typeof i.occurrences !== 'number') throw new AgentError('file_input_invalid');
        const find = await textInput(i, 'find', context),
          replace = await textInput(i, 'replace', context);
        context.signal.throwIfAborted();
        const path = string(i.path),
          occurrences = i.occurrences;
        return mutation({ operation: 'edit', path, base: b }, context, () =>
          files.edit({ path, base: b, find, replace, occurrences }),
        );
      },
    },
    {
      name: 'list',
      required: [],
      properties: {
        path,
        afterName: { type: 'string', maxLength: 255 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      call: (i) =>
        files.list({
          ...(i.path === undefined ? {} : { path: string(i.path) }),
          ...(i.afterName === undefined ? {} : { afterName: string(i.afterName) }),
          ...(i.limit === undefined ? {} : { limit: Number(i.limit) }),
        }),
    },
    {
      name: 'glob',
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', minLength: 1, maxLength: 1024 },
        path,
        after: { type: 'string', maxLength: 4096 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      call: (i) =>
        files.glob({
          pattern: string(i.pattern),
          ...(i.path === undefined ? {} : { path: string(i.path) }),
          ...(i.after === undefined ? {} : { after: string(i.after) }),
          ...(i.limit === undefined ? {} : { limit: Number(i.limit) }),
        }),
    },
    {
      name: 'search',
      required: ['text'],
      properties: {
        path,
        text: { type: 'string', minLength: 1, maxLength: 1024 },
        after: { type: 'string', maxLength: 4110 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      call: (i) =>
        files.search({
          text: string(i.text),
          ...(i.path === undefined ? {} : { path: string(i.path) }),
          ...(i.after === undefined ? {} : { after: string(i.after) }),
          ...(i.limit === undefined ? {} : { limit: Number(i.limit) }),
        }),
    },
  ];
  return definitions.map((d) => ({
    id: `files.${d.name}`,
    ...(capture && (d.name === 'write' || d.name === 'edit')
      ? { resources: { serial: { scope: 'workspace' as const, key: 'files.mutation' } } }
      : {}),
    version:
      d.name === 'read' ? '3' : ['write', 'edit', 'search', 'glob'].includes(d.name) ? '2' : '1',
    description: `Workspace ${d.name}; UTF-8, exact baseline for modifications, complete bodies or explicit immutable Artifact references.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: d.required,
      properties: d.properties,
      ...(d.oneOf
        ? {
            allOf: [
              { oneOf: d.oneOf },
              ...(d.name === 'edit'
                ? [
                    {
                      oneOf: [
                        { required: ['replace'], not: { required: ['replaceArtifact'] } },
                        { required: ['replaceArtifact'], not: { required: ['replace'] } },
                      ],
                    },
                  ]
                : []),
            ],
          }
        : {}),
    },
    async execute(input, context) {
      if (context.signal.aborted)
        return { outcome: 'cancelled', content: 'cancelled_before_file_io' };
      try {
        const value = await d.call(object(input), context);
        const publicValue =
          d.name === 'write' || d.name === 'edit'
            ? {
                path: (value as { path: string }).path,
                baseline: (value as { baseline: unknown }).baseline,
              }
            : value;
        const content = JSON.stringify(publicValue);
        if (Buffer.byteLength(content) > 1024 * 1024) {
          if (!context.artifacts) throw new AgentError('artifact_publication_unavailable');
          const snapshot = publicValue as {
            path?: string;
            content?: string;
            baseline?: FileBaseline;
            selection?: unknown;
          };
          const fileText = d.name === 'read' ? snapshot.content! : content;
          const reference = await context.artifacts.publish({
            key: `files.${d.name}.body`,
            content: Buffer.from(fileText),
            mediaType: d.name === 'read' ? 'text/plain' : 'application/json',
          });
          const summary =
            d.name === 'read'
              ? { path: snapshot.path, baseline: snapshot.baseline, selection: snapshot.selection }
              : { kind: d.name };
          return {
            outcome: 'succeeded',
            content: JSON.stringify({
              ...summary,
              body: {
                complete: true,
                encoding: 'utf-8',
                format: d.name === 'read' ? 'file_text' : 'json',
                reference,
              },
              inlineBody: false,
            }),
            artifactRefs: [reference],
            modelContent: { kind: 'artifact', reference, encoding: 'utf-8' },
          };
        }
        const change =
          d.name === 'write' || d.name === 'edit' ? (value as FileSnapshot).change : undefined;
        return {
          outcome: 'succeeded',
          content,
          ...(change ? { details: { fileChange: change } as unknown as Json } : {}),
        };
      } catch (error) {
        return {
          outcome:
            error instanceof AgentError && error.code === 'file_publish_outcome_unknown'
              ? 'outcome_unknown'
              : context.signal.aborted
                ? 'cancelled'
                : 'failed',
          content: error instanceof Error ? error.message : String(error),
          details: { code: error instanceof AgentError ? error.code : 'file_io_failed' },
        };
      }
    },
  }));
}
