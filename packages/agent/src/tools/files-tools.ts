import type { ArtifactRef, ToolContext, ToolDefinition } from '../extensions';
import type { Json, JsonSchema } from '../storage/types';
import { AgentError } from '../storage/types';
import type { FileBaseline, FileSearchResult, FileSnapshot, WorkspaceFiles } from './files';
import { formatFileReadResult, formatFileSearchResult } from './files/model-result';

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
        path: {
          ...directoryPath,
          description: `${directoryPath.description} Search one file or a directory tree. Explicit files bypass ordinary ignore rules; explicit directories start their own ignore scope.`,
        },
        text: { type: 'string', minLength: 1, maxLength: 1024 },
        after: { type: 'string', maxLength: 4110 },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        glob: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description:
            'Filter filenames, or paths relative to the search directory when the glob contains /. **/ matches zero or more directories.',
        },
        contextLines: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
        maxLineChars: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          default: 2000,
          description:
            'Preview characters per matching or context line. Truncation is explicit; use read_file for complete lines.',
        },
        respectIgnore: {
          type: 'boolean',
          default: true,
          description:
            'Apply .gitignore inside the selected directory tree. false includes ordinarily ignored files; safety restrictions always apply.',
        },
      },
      call: (i, context) =>
        files.search(
          {
            text: string(i.text),
            ...(i.path === undefined ? {} : { path: string(i.path) }),
            ...(i.after === undefined ? {} : { after: string(i.after) }),
            limit: i.limit === undefined ? 100 : Number(i.limit),
            maxLineChars: i.maxLineChars === undefined ? 2000 : Number(i.maxLineChars),
            respectIgnore: i.respectIgnore === undefined ? true : (i.respectIgnore as boolean),
            ...(i.glob === undefined ? {} : { glob: string(i.glob) }),
            ...(i.contextLines === undefined ? {} : { contextLines: Number(i.contextLines) }),
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
      'Search literal text in one file or a directory tree. Defaults to 100 matches per page and 2000 characters per line preview. Continue using next; truncated lines require read_file for full content. Binary and non-UTF-8 files are skipped with current-page scope diagnostics; no matches does not prove complete coverage when scope.complete is false. Root searches respect .gitignore; explicit files bypass ordinary ignore and explicit directories do not inherit ancestor ignore rules. Filtering never grants access.',
  };
  return definitions.map((d) => ({
    id: `files.${d.name}`,
    model: {
      name: modelNames[d.name]!,
      snakeCase: true,
      ...(['read', 'search'].includes(d.name) ? { resultVersion: '1' } : {}),
      ...(modelParameters[d.name] ? { parameterNames: modelParameters[d.name] } : {}),
    },
    ...(d.name === 'read'
      ? { formatModelResult: formatFileReadResult }
      : d.name === 'search'
        ? { formatModelResult: formatFileSearchResult }
        : {}),
    ...(capture && (d.name === 'write' || d.name === 'edit')
      ? { resources: { serial: { scope: 'workspace' as const, key: 'files.mutation' } } }
      : {}),
    version:
      d.name === 'read'
        ? '4'
        : d.name === 'search'
          ? '3'
          : ['write', 'edit', 'glob'].includes(d.name)
            ? '2'
            : '1',
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
        const observation = (() => {
          if (d.name === 'read') {
            const snapshot = value as FileSnapshot;
            if (
              !snapshot.baseline ||
              typeof snapshot.baseline.hash !== 'string' ||
              typeof snapshot.content !== 'string'
            )
              return undefined;
            const selection = snapshot.selection;
            let excerptEnd = Math.min(snapshot.content.length, 2000);
            if (excerptEnd > 0 && /[\uD800-\uDBFF]/.test(snapshot.content[excerptEnd - 1]!))
              excerptEnd--;
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
          if (d.name === 'search') {
            const search = value as FileSearchResult;
            if (!search.query || !search.files) return undefined;
            return {
              kind: 'lookup',
              scope: search.query.path,
              query: JSON.stringify(search.query),
              sources: search.files.map((file) => ({
                path: file.path,
                version: file.baseline.hash,
              })),
              matchCount: search.matches.length,
              complete:
                search.query.after === null &&
                search.next === null &&
                search.scope?.complete !== false,
              coverage: 'page',
              next: search.next,
            };
          }
          return undefined;
        })();
        const observedValue = observation
          ? { ...(publicValue as Record<string, unknown>), observation }
          : publicValue;
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
              ...(observation ? { observation } : {}),
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
        const searchCode =
          d.name === 'search' && error instanceof AgentError ? error.code : undefined;
        const searchAdvice: Record<string, string> = {
          ENOENT:
            'The selected search path does not exist. Locate an existing path with glob_files or list_directory, then search it.',
          ENOTDIR:
            'A path component is not a directory. Verify the selected path with list_directory; search_content accepts an existing file or directory.',
          file_not_regular:
            'The selected search path is not a regular file or directory. Choose a real workspace path; links are not followed.',
          file_path_protected:
            'The selected search scope is protected. Choose an allowed workspace scope; ignore options cannot grant access.',
          file_path_invalid:
            'Choose a path inside the fixed workspace without parent traversal. File tools do not follow the Shell working directory.',
          file_search_invalid:
            'Supply nonempty literal text up to 1024 UTF-8 bytes. For filenames use glob_files; content search is not a regular expression.',
          file_search_filter_invalid:
            'respect_ignore must be true or false. It never overrides protected paths or link restrictions.',
          file_glob_invalid:
            'Use a relative filename/path glob, without parent traversal or absolute paths. This filter is not a regular expression.',
          file_search_context_invalid: 'context_lines must be an integer from 0 to 10.',
          file_search_preview_invalid: 'max_line_chars must be a positive integer.',
          file_page_invalid:
            'Use limit from 1 to 200 and copy the previous next cursor unchanged. Start a new search without after when changing scope or pattern.',
          file_changed:
            'A file changed while being read. Recheck the relevant scope before making a new search; this attempt did not provide a stable complete result.',
        };
        const advice = searchCode ? searchAdvice[searchCode] : undefined;
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
            : advice
              ? `${searchCode}: ${advice}`
              : error instanceof Error
                ? error.message
                : String(error),
          details: {
            code: error instanceof AgentError ? error.code : 'file_io_failed',
            ...(advice ? { next_action: advice } : {}),
          },
        };
      }
    },
  }));
}
