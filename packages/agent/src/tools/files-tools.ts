import type { ArtifactRef, ToolContext, ToolDefinition } from '../extensions';
import type { Json, JsonSchema } from '../storage/types';
import { AgentError } from '../storage/types';
import type { FileBaseline, FileSnapshot, WorkspaceFiles } from './files';
import { formatFileReadResult } from './files/model-result';

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
  options: { capture?: FileMutationCapture; snapshot?: boolean } = {},
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
            'Maximum lines to return; defaults to 200. Continue by passing returned next_line as start_line (raw JSON fallback: selection.nextOffset), or request explicit max_lines.',
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
  ];
  const modelNames: Record<string, string> = {
    read: 'read_file',
    write: 'write_file',
    edit: 'edit_file',
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
    read: 'Read UTF-8 file lines. Line numbers start at 1; return at most 200 lines by default. Continue by passing returned next_line as start_line (raw JSON fallback: selection.nextOffset). The returned baseline describes the complete file and is required for later modifications.',
    write:
      'Create or replace a complete UTF-8 file. Pass base=null only to create a new file; missing workspace parent directories are created through the same protected no-follow boundary. Replacing a file requires its exact complete-file baseline and existing parents. Supply exactly one of content or content_artifact. If a call fails, correct the reported cause before another attempt; repeating the same path and input does not fix it. A failure may leave newly created empty parent directories. Each invocation has its own outcome; a baseline conflict does not report current file content or roll back other successful operations.',
    edit: 'Replace exact, non-overlapping literal text in a UTF-8 file using its complete-file baseline. expected_matches must equal the actual number of matches. Supply old_text and new_text, or the corresponding immutable Artifact references. Each invocation has its own outcome; a baseline conflict does not report current file content or roll back other successful operations.',
  };
  return definitions.map((d) => ({
    id: `files.${d.name}`,
    model: {
      name: modelNames[d.name]!,
      snakeCase: true,
      ...(d.name === 'read' ? { resultVersion: '1' } : {}),
      ...(modelParameters[d.name] ? { parameterNames: modelParameters[d.name] } : {}),
    },
    ...(d.name === 'read' ? { formatModelResult: formatFileReadResult } : {}),
    ...(capture && (d.name === 'write' || d.name === 'edit')
      ? { resources: { serial: { scope: 'workspace' as const, key: 'files.mutation' } } }
      : {}),
    version: d.name === 'read' ? '4' : d.name === 'write' ? '3' : '2',
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
    ...(d.name === 'read' ? { contextDiscovery: 'read_only' as const } : {}),
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
        if (d.name === 'read') context.signal.throwIfAborted();
        if (d.name === 'read') return await createFileReadResult(value as FileSnapshot, context);
        const mutationResult =
          d.name === 'write' || d.name === 'edit' ? (value as FileSnapshot) : undefined;
        let delivery: ArtifactRef | undefined;
        if (mutationResult && context.artifacts && options.snapshot !== false) {
          try {
            delivery = await context.artifacts.publish({
              key: 'output-file-version',
              content: Buffer.from(mutationResult.content),
              mediaType: 'text/plain',
            });
          } catch (error) {
            // The file already changed. Do not report a safe-to-retry failed write.
            throw new AgentError(
              'file_publish_outcome_unknown',
              error instanceof Error ? error.message : String(error),
            );
          }
        }
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
        const observedValue = publicValue;
        const content = JSON.stringify(
          ['read', 'write', 'edit'].includes(d.name)
            ? {
                ...(observedValue as Record<string, unknown>),
                executionId: context.executionId,
                runId: context.runId,
              }
            : observedValue,
        );
        if (Buffer.byteLength(content) > 1024 * 1024) {
          if (!context.artifacts) throw new AgentError('artifact_publication_unavailable');

          const reference = await context.artifacts.publish({
            key: `files.${d.name}.body`,
            content: Buffer.from(content),
            mediaType: 'application/json',
          });

          return {
            outcome: 'succeeded',
            content: JSON.stringify({
              kind: d.name,
              body: {
                complete: true,
                encoding: 'utf-8',
                format: 'json',
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
          ...(delivery ? { artifactRefs: [delivery] } : {}),
          ...(change || delivery
            ? {
                details: {
                  ...(change ? { fileChange: change } : {}),
                  ...(delivery
                    ? { fileOutput: { path: mutationResult!.path, snapshot: delivery } }
                    : {}),
                } as unknown as Json,
              }
            : {}),
        };
      } catch (error) {
        const baselineConflict =
          (d.name === 'write' || d.name === 'edit') &&
          error instanceof AgentError &&
          error.code === 'file_baseline_conflict';
        const mutationCode =
          (d.name === 'write' || d.name === 'edit') && error instanceof AgentError
            ? error.code
            : undefined;
        const mutationAdvice: Record<string, string> = {
          ENOENT:
            'The target file or a required parent directory does not exist. New workspace files with base=null create missing parents; replacement and edit require an existing file. An empty directory listing does not mean the workspace is unavailable. Verify the exact target and baseline before another attempt.',
          ENOTDIR:
            'A parent path component is a file or a link instead of a usable directory. Inspect the parent chain and choose an existing real directory; do not repeat the same target unchanged.',
          EACCES:
            'The operating system denied access to the target or a parent directory. Tool approval does not override filesystem permissions. Resolve access or choose an authorized writable location before another attempt.',
          EPERM:
            'The operating system does not permit this filesystem operation. Tool approval does not override system restrictions. Resolve the restriction before another attempt.',
          file_path_invalid:
            'The path is invalid or outside the fixed workspace. Use a workspace-relative path or an absolute path inside it without traversal, device names or invalid components. Correct the path before another attempt.',
          file_path_protected:
            'The target or a parent directory is protected. Approval does not bypass this boundary. Choose an allowed target within the user request; do not retry through an alias or another tool.',
          file_symlink:
            'The target or a parent directory is a symbolic link. File writes do not follow links. Select a real path inside the authorized workspace; do not retry through an alias.',
          file_not_regular:
            'The target is not a regular file; it may be a directory or a link. Inspect the exact target and choose a regular file or an unused filename before another attempt.',
          file_owner_invalid:
            'The target or a parent failed the owner or link-count checks. Inspect its ownership and identity before another attempt; approval does not bypass these checks.',
          file_root_changed:
            'The original workspace directory identity has changed. Reopen and verify the workspace before another attempt; do not retry against the replacement directory.',
          file_io_failed:
            'A filesystem operation failed. Inspect the target and parent directories before another attempt; repeating the same input without resolving the cause will not repair it.',
          file_publish_outcome_unknown:
            'A file or parent-directory operation could not be confirmed. Do not repeat the write. Inspect the original execution and filesystem outcome before any further mutation.',
        };
        const mutationNext = mutationCode ? mutationAdvice[mutationCode] : undefined;
        const failedPath =
          input &&
          typeof input === 'object' &&
          !Array.isArray(input) &&
          typeof input.path === 'string'
            ? input.path
            : undefined;
        const parentNotice =
          d.name === 'write'
            ? ' Newly created empty parent directories may remain after a failed write; they are not automatically removed.'
            : '';
        return {
          outcome:
            error instanceof AgentError && error.code === 'file_publish_outcome_unknown'
              ? 'outcome_unknown'
              : context.signal.aborted
                ? 'cancelled'
                : 'failed',
          content: baselineConflict
            ? 'file_baseline_conflict: This invocation did not publish its requested change because its supplied baseline or create-only precondition was rejected. The baseline describes the complete file identity and version; this conflict does not prove that another edit targeted the same text. Compare each invocation using its own requested change and receipt. Earlier read content is historical; this failure does not report the current file content. Other successful operations are not rolled back. Do not infer that the file still has its earlier values. Before any separately authorized new edit, read the current file and use its fresh complete-file baseline.' +
              parentNotice
            : mutationNext
              ? `${mutationCode}${failedPath === undefined ? '' : ` (${JSON.stringify(failedPath)})`}: ${error instanceof Error && error.message !== mutationCode ? `${error.message} ` : ''}${mutationNext}${parentNotice}`
              : error instanceof Error
                ? error.message
                : String(error),
          details: {
            code: error instanceof AgentError ? error.code : 'file_io_failed',
            ...(mutationNext ? { next_action: mutationNext } : {}),
            ...(mutationCode && failedPath !== undefined ? { path: failedPath } : {}),
          },
        };
      }
    },
  }));
}

/** Shared delivery for workspace snapshots and external read-only text (which has no baseline). */
export async function createFileReadResult(
  snapshot: Omit<FileSnapshot, 'baseline'> & { baseline?: FileBaseline },
  context: ToolContext,
  details?: Json,
): Promise<import('../extensions').ToolResult> {
  const observation = (() => {
    if (snapshot.baseline) {
      if (
        !snapshot.baseline ||
        typeof snapshot.baseline.hash !== 'string' ||
        typeof snapshot.content !== 'string'
      )
        return undefined;
      const selection = snapshot.selection;
      let excerptEnd = Math.min(snapshot.content.length, 2000);
      if (excerptEnd > 0 && /[\uD800-\uDBFF]/.test(snapshot.content[excerptEnd - 1]!)) excerptEnd--;
      const excerpt = {
        text: snapshot.content.slice(0, excerptEnd),
        truncated: excerptEnd < snapshot.content.length,
      };
      const complete =
        !selection ||
        (selection.fromLine === 1 &&
          selection.nextOffset === null &&
          (selection.toLine === selection.totalLines || selection.totalLines === 0));
      return {
        kind: 'inspection',
        scope: snapshot.path,
        sources: [
          {
            path: snapshot.path,
            version: snapshot.baseline.hash,
            ...(selection
              ? {
                  fromLine: selection.fromLine,
                  ...(selection.toLine === null ? {} : { toLine: selection.toLine }),
                }
              : {}),
          },
        ],
        complete,
        coverage: complete ? 'file' : 'window',
        windowComplete: true,
        excerpt,
      };
    }

    return undefined;
  })();
  const metadata = {
    path: snapshot.path,
    ...(snapshot.baseline ? { baseline: snapshot.baseline } : {}),
    selection: snapshot.selection,
    ...(observation ? { observation } : {}),
  };
  const content = JSON.stringify({
    ...metadata,
    content: snapshot.content,
    executionId: context.executionId,
    runId: context.runId,
  });
  if (Buffer.byteLength(content) <= 1024 * 1024)
    return { outcome: 'succeeded', content, ...(details ? { details } : {}) };
  if (!context.artifacts) throw new AgentError('artifact_publication_unavailable');
  const reference = await context.artifacts.publish({
    key: 'files.read.body',
    content: Buffer.from(snapshot.content),
    mediaType: 'text/plain',
  });
  context.signal.throwIfAborted();
  return {
    outcome: 'succeeded',
    content: JSON.stringify({
      ...metadata,
      body: { complete: true, encoding: 'utf-8', format: 'file_text', reference },
      inlineBody: false,
    }),
    artifactRefs: [reference],
    modelContent: { kind: 'artifact', reference, encoding: 'utf-8' },
    ...(details ? { details } : {}),
  };
}
