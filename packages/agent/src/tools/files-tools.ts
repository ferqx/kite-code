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
        respectIgnore: {
          type: 'boolean',
          default: true,
          description:
            'Apply .gitignore from the workspace root through the selected tree. false includes ordinarily ignored files; safety restrictions always apply.',
        },
      },
      call: (i, context) =>
        files.glob(
          {
            pattern: string(i.pattern),
            respectIgnore: i.respectIgnore === undefined ? true : (i.respectIgnore as boolean),
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
          description: `${directoryPath.description} Search one file or a directory tree. Explicit files bypass ordinary ignore rules; directory searches inherit .gitignore from the workspace root.`,
        },
        text: { type: 'string', minLength: 1, maxLength: 1024 },
        mode: {
          enum: ['files', 'content'],
          default: 'files',
          description:
            'files locates matching files without body text (limit counts files); content returns matching lines and context (limit counts matches).',
        },
        after: {
          type: 'string',
          maxLength: 32768,
          description:
            'Pass the returned next_cursor here as cursor, keeping mode, query, path and filters unchanged (raw JSON fallback: next).',
        },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        glob: {
          type: 'string',
          minLength: 1,
          maxLength: 1024,
          description:
            'Filter filenames, or paths relative to the search directory when the glob contains /. **/ matches zero or more directories.',
        },
        contextLines: {
          type: 'integer',
          minimum: 0,
          maximum: 10,
          default: 0,
          description:
            'Context lines before and after each matching line, used only in mode=content.',
        },
        maxLineChars: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
          default: 2000,
          description:
            'In mode=content, preview characters per matching or context line. Truncation is explicit; use read_file for complete lines.',
        },
        respectIgnore: {
          type: 'boolean',
          default: true,
          description:
            'Apply .gitignore from the workspace root through the selected tree. false includes ordinarily ignored files; safety restrictions always apply.',
        },
      },
      call: (i, context) =>
        files.search(
          {
            text: string(i.text),
            mode: i.mode === undefined ? 'files' : (i.mode as 'files' | 'content'),
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
    search: { after: 'cursor' },
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
    list: 'List immediate directory entries, with name-based pagination. Defaults to the workspace root and 100 entries; limit is 1–200. Continue using the returned name cursor.',
    glob: 'Find file paths matching a glob, including **/ for zero or more directory levels. Defaults to the workspace root and 100 paths; limit is 1–200. Respects .gitignore from the workspace root by default; respect_ignore=false includes ordinarily ignored files. Continue using the returned path cursor with the same scope, pattern and ignore option.',
    search:
      'Search literal text in one file or a directory tree. Defaults to mode=files, returning at most 100 matching files with their first matching line number and complete-file baseline, without body text. Use mode=content for matching line previews and optional context (default 2000 characters per line). limit counts files in files mode or matches in content mode. Continue by passing next_cursor as cursor (raw JSON fallback: next), keeping mode, query, scope and filters unchanged; truncated lines require read_file for full content. Binary and non-UTF-8 files are skipped with current-page scope diagnostics; no matches does not prove complete coverage when scope.complete is false. Directory searches inherit .gitignore from the workspace root; explicit files bypass ordinary ignore. Filtering never grants access.',
  };
  return definitions.map((d) => ({
    id: `files.${d.name}`,
    model: {
      name: modelNames[d.name]!,
      snakeCase: true,
      ...(['read', 'search'].includes(d.name)
        ? { resultVersion: d.name === 'read' ? '1' : '2' }
        : {}),
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
          ? '5'
          : d.name === 'glob'
            ? '3'
            : d.name === 'write'
              ? '3'
              : d.name === 'edit'
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
              matchCount:
                search.query.mode === 'files' ? search.files.length : search.matches.length,
              matchUnit: search.query.mode === 'files' ? 'files' : 'lines',
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
            'Use limit from 1 to 200 and copy next_cursor into cursor unchanged (raw next into after). Start a new search without cursor when changing mode, scope, query or filters.',
          file_changed:
            'A file changed while being read. Recheck the relevant scope before making a new search; this attempt did not provide a stable complete result.',
        };
        const advice = searchCode ? searchAdvice[searchCode] : undefined;
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
              : advice
                ? `${searchCode}: ${advice}`
                : error instanceof Error
                  ? error.message
                  : String(error),
          details: {
            code: error instanceof AgentError ? error.code : 'file_io_failed',
            ...(advice ? { next_action: advice } : {}),
            ...(mutationNext ? { next_action: mutationNext } : {}),
            ...(mutationCode && failedPath !== undefined ? { path: failedPath } : {}),
          },
        };
      }
    },
  }));
}
