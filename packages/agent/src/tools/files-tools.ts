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
const path = {
  type: 'string',
  maxLength: 4096,
  description:
    'Path relative to the fixed workspace root, or an absolute path inside that workspace. No .. segments; paths outside the workspace are rejected.',
};
const directoryPath = {
  ...path,
  description: `${path.description} Omit path or use "." or "" for the workspace root.`,
};
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
        offset: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'First line to return, numbered from 1; defaults to 1.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          default: 200,
          description:
            'Maximum lines to return; defaults to 200. Continue at selection.nextOffset to read the next page, or request explicit max_lines.',
        },
      },
      call: (i, context) =>
        files.read(string(i.path), {
          ...(i.offset === undefined ? {} : { offset: Number(i.offset) }),
          limit: i.limit === undefined ? 200 : Number(i.limit),
          signal: context.signal,
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
        path: directoryPath,
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
        path: directoryPath,
        after: { type: 'string', maxLength: 4096 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      call: (i, context) =>
        files.glob(
          {
            pattern: string(i.pattern),
            ...(i.path === undefined ? {} : { path: string(i.path) }),
            ...(i.after === undefined ? {} : { after: string(i.after) }),
            ...(i.limit === undefined ? {} : { limit: Number(i.limit) }),
          },
          { signal: context.signal },
        ),
    },
    {
      name: 'search',
      required: ['text'],
      properties: {
        path: directoryPath,
        text: { type: 'string', minLength: 1, maxLength: 1024 },
        after: { type: 'string', maxLength: 4110 },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      call: (i, context) =>
        files.search(
          {
            text: string(i.text),
            ...(i.path === undefined ? {} : { path: string(i.path) }),
            ...(i.after === undefined ? {} : { after: string(i.after) }),
            ...(i.limit === undefined ? {} : { limit: Number(i.limit) }),
          },
          { signal: context.signal },
        ),
    },
  ];
  const modelNames: Record<string, string> = {
    read: 'read_file',
    write: 'write_file',
    edit: 'edit_file',
    list: 'list_directory',
    glob: 'glob_files',
    search: 'search_content',
  };
  const modelParameters: Record<string, Record<string, string>> = {
    read: { offset: 'start_line', limit: 'max_lines' },
    edit: {
      find: 'old_text',
      replace: 'new_text',
      occurrences: 'expected_matches',
      findArtifact: 'old_text_artifact',
      replaceArtifact: 'new_text_artifact',
    },
  };
  const descriptions: Record<string, string> = {
    read: 'Read UTF-8 file lines. Line numbers start at 1; return at most 200 lines by default. Continue at selection.nextOffset. The returned baseline describes the complete file and is required for later modifications.',
    write:
      'Create or replace a complete UTF-8 file. Pass base=null only to create a new file; replacing a file requires its exact complete-file baseline. Supply exactly one of content or content_artifact. Each invocation has its own outcome; a baseline conflict does not report current file content or roll back other successful operations.',
    edit: 'Replace exact, non-overlapping literal text in a UTF-8 file using its complete-file baseline. expected_matches must equal the actual number of matches. Supply old_text and new_text, or the corresponding immutable Artifact references. Each invocation has its own outcome; a baseline conflict does not report current file content or roll back other successful operations.',
    list: 'List immediate directory entries, with name-based pagination. Defaults to the workspace root and 100 entries; limit is 1–200. Continue using the returned name cursor.',
    glob: 'Find file paths matching a glob, including **/ for zero or more directory levels. Defaults to the workspace root and 100 paths; limit is 1–200. Continue using the returned path cursor.',
    search:
      'Search file contents for literal text, not a regular expression. Defaults to the workspace root and all matches; an explicit limit selects 1–200 matches with a continuation cursor.',
  };
  return definitions.map((d) => ({
    id: `files.${d.name}`,
    model: {
      name: modelNames[d.name]!,
      snakeCase: true,
      ...(modelParameters[d.name] ? { parameterNames: modelParameters[d.name] } : {}),
    },
    ...(capture && (d.name === 'write' || d.name === 'edit')
      ? { resources: { serial: { scope: 'workspace' as const, key: 'files.mutation' } } }
      : {}),
    version:
      d.name === 'read' ? '4' : ['write', 'edit', 'search', 'glob'].includes(d.name) ? '2' : '1',
    description: `${descriptions[d.name]} Paths are relative to the fixed workspace root or absolute inside it, never relative to Shell cwd.`,
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
    ...(['read', 'list', 'glob', 'search'].includes(d.name)
      ? { contextDiscovery: 'read_only' as const }
      : {}),
    async execute(input, context) {
      if (context.signal.aborted)
        return { outcome: 'cancelled', content: 'cancelled_before_file_io' };
      try {
        const parameters = object(input);
        const value = await d.call(
          parameters.path === undefined
            ? parameters
            : { ...parameters, path: files.relativePath(string(parameters.path)) },
          context,
        );
        if (['read', 'list', 'glob', 'search'].includes(d.name)) context.signal.throwIfAborted();
        const mutationResult =
          d.name === 'write' || d.name === 'edit' ? (value as FileSnapshot) : undefined;
        const change = mutationResult?.change;
        const publicValue =
          d.name === 'write' || d.name === 'edit'
            ? {
                path: (value as { path: string }).path,
                baseline: (value as { baseline: unknown }).baseline,
                ...(change
                  ? {
                      fileChange: change,
                      summary: `Wrote ${mutationResult!.content.split('\n').length - Number(mutationResult!.content.endsWith('\n'))} lines to ${change.path}${
                        change.before?.hash === change.after.hash ? ' (content unchanged)' : ''
                      }`,
                    }
                  : {}),
              }
            : value;
        const content = JSON.stringify(
          ['read', 'write', 'edit'].includes(d.name)
            ? {
                ...(publicValue as Record<string, unknown>),
                executionId: context.executionId,
                runId: context.runId,
              }
            : publicValue,
        );
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
        return {
          outcome: 'succeeded',
          content,
          ...(change ? { details: { fileChange: change } as unknown as Json } : {}),
        };
      } catch (error) {
        const baselineConflict =
          (d.name === 'write' || d.name === 'edit') &&
          error instanceof AgentError &&
          error.code === 'file_baseline_conflict';
        return {
          outcome:
            error instanceof AgentError && error.code === 'file_publish_outcome_unknown'
              ? 'outcome_unknown'
              : context.signal.aborted
                ? 'cancelled'
                : 'failed',
          content: baselineConflict
            ? 'file_baseline_conflict: This invocation did not publish its requested change because its supplied baseline or create-only precondition was rejected. The baseline describes the complete file identity and version; this conflict does not prove that another edit targeted the same text. Compare each invocation using its own requested change and receipt. Earlier read content is historical; this failure does not report the current file content. Other successful operations are not rolled back. Do not infer that the file still has its earlier values. Before any separately authorized new edit, read the current file and use its fresh complete-file baseline.'
            : error instanceof Error
              ? error.message
              : String(error),
          details: { code: error instanceof AgentError ? error.code : 'file_io_failed' },
        };
      }
    },
  }));
}
