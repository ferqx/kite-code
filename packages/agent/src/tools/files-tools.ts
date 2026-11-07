import type { ArtifactRef, ToolContext, ToolDefinition, ToolResult } from '../extensions';
import { modelReference, readModelReference } from '../model-reference';
import type { Json } from '../storage/types';
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

const path = {
  type: 'string',
  maxLength: 4096,
  description:
    'Path relative to the fixed workspace root, or an absolute path inside that workspace. No .. segments; paths outside the workspace are rejected.',
};
const referenceSchema = { type: 'string', minLength: 1, maxLength: 4096 };
const fileDefinitions = { 'files.read': ['4', '5'], 'files.write': ['3'], 'files.edit': ['2'] };

export async function fileBaselineReference(
  reference: Json,
  context: ToolContext,
  expectedPath: string,
  normalize: (path: string) => string = (path) => path,
): Promise<Json> {
  const { result } = await readModelReference(
    reference,
    'file',
    context,
    'builtin.files',
    fileDefinitions,
  );
  let original: Record<string, Json>;
  try {
    original = object(JSON.parse(String(result.content)));
  } catch {
    throw new AgentError('tool_reference_unavailable');
  }
  if (
    original.base_ref !== reference ||
    typeof original.path !== 'string' ||
    normalize(original.path) !== normalize(expectedPath)
  )
    throw new AgentError('tool_reference_target_mismatch');
  if (!baseline(original.baseline)) throw new AgentError('tool_reference_unavailable');
  return original.baseline!;
}

async function fileParameters(
  input: Record<string, Json>,
  context: ToolContext,
  files: WorkspaceFiles,
): Promise<Record<string, Json>> {
  const value = { ...input };
  if (value.baseRef !== undefined) {
    if (value.base !== undefined) throw new AgentError('file_input_invalid');
    value.base = await fileBaselineReference(value.baseRef, context, string(value.path), (path) =>
      files.relativePath(path),
    );
    delete value.baseRef;
  }
  for (const field of ['content', 'find', 'replace']) {
    const reference = value[`${field}Ref`];
    if (reference === undefined) continue;
    if (value[field] !== undefined || value[`${field}Artifact`] !== undefined)
      throw new AgentError('file_input_invalid');
    const { result, reference: selected } = await readModelReference(
      reference,
      'artifact',
      context,
    );
    const refs = result.artifactRefs;
    if (!Array.isArray(refs) || selected.index === undefined || !refs[selected.index])
      throw new AgentError('tool_reference_unavailable');
    value[`${field}Artifact`] = refs[selected.index]!;
    delete value[`${field}Ref`];
  }
  return value;
}
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

/** Public cause and recovery guidance only; the caller retains the original outcome and scope. */
export function fileFailureAdvice(code: string): string | undefined {
  const advice: Readonly<Record<string, string>> = {
    file_input_invalid:
      'The file request has invalid arguments. Check the declared field names, types, required fields and mutually exclusive text or Artifact inputs before a separately authorized corrected request.',
    file_read_range_invalid:
      'The requested line range is invalid. start_line and max_lines must be positive safe integers; omit them to use their declared defaults. Correct the range without changing the intended file.',
    file_edit_invalid:
      'Supply a nonempty old_text, a string new_text and the exact base_ref from a successful read or mutation. expected_matches defaults to 1; explicitly set the exact positive count for multiple matches. Use declared text or content references, never reconstruct baseline objects.',
    file_edit_match_conflict:
      'The exact old_text occurrence count does not equal expected_matches. This edit did not publish a change. Check the exact text and intended match count against an authorized current read and its complete-file baseline before a separately authorized corrected edit; do not broaden the requested replacement.',
    file_baseline_invalid:
      'The file version reference could not be resolved. Copy base_ref from a successful authorized read of this exact path; do not construct a baseline object.',
    ENOENT:
      'The target file or a required parent directory does not exist. Omit base_ref to create a new file and missing accepted parents; never pass null. Replacement and edit require an existing file and its exact base_ref. Verify the exact target before another authorized attempt.',
    ENOTDIR:
      'A parent path component is a file or a link instead of a usable directory. Inspect the exact parent chain; do not repeat the same target unchanged or select a different target without task authorization.',
    EACCES:
      'The operating system denied access to the target or a parent directory. Tool approval does not override filesystem permissions. Resolve access within the original task and policy before another attempt.',
    EPERM:
      'The operating system does not permit this filesystem operation. Tool approval does not override system restrictions. Resolve the restriction before another authorized attempt.',
    file_path_invalid:
      'The path is invalid for this file tool. Check the exact requested path against its declared scope and path syntax, including traversal, device names and invalid components. Correct the path before another attempt within the current task and policy; this error does not grant a different target or broader scope.',
    file_path_protected:
      'The target or a parent directory is protected. Approval does not bypass this boundary. Do not retry through an alias or another tool; report the restriction if the authorized target cannot be used.',
    file_symlink:
      'The target or a parent directory is a symbolic link. This file operation does not follow links. Verify the exact real target within the current task and accepted scope; do not use an alias to bypass the boundary.',
    file_not_regular:
      'The target is not a regular file; it may be a directory or another unsupported object. Check the exact requested target and report the mismatch; do not silently substitute a different file.',
    file_owner_invalid:
      'The target or a parent failed the owner or link-count checks. Inspect its ownership and identity before another authorized attempt; approval does not bypass these checks.',
    file_root_changed:
      'The original bound directory identity has changed. Verify the original scope before further operations; do not retry against a replacement directory.',
    file_dispatch_scope_changed:
      'The accepted file authorization or target identity changed before this invocation could publish. Inspect the original receipt and current scope; an earlier approval does not authorize a changed target.',
    file_binary:
      'The requested data is not supported as ordinary text by this file operation. Do not invent decoded contents or silently alter the intended data.',
    file_encoding_invalid:
      'The requested text is not valid in the supported encoding. Check the original source or text input; do not substitute a partial or guessed decoding.',
    file_too_large:
      "The requested content exceeds this file tool's supported size. Preserve the intended content and report the limit; do not silently truncate it.",
    artifact_read_unavailable:
      'The Artifact reader required by this file request is unavailable. No replacement text was obtained; do not invent its contents or replace the original Artifact reference.',
    file_io_failed:
      'A filesystem operation failed. Inspect the exact target, parent directories and original receipt before another authorized attempt; repeating the same input without resolving the cause will not repair it.',
    file_publish_outcome_unknown:
      'A file or parent-directory operation could not be confirmed. Do not repeat the write. Inspect the original execution and filesystem outcome before any further mutation.',
  };
  return advice[code];
}
/** Ordinary Tools: permission, source freshness and execution receipts remain core responsibilities. */
export function createFileTools(
  files: WorkspaceFiles,
  options: {
    capture?: FileMutationCapture;
    snapshot?: boolean;
    missingRead?: 'observation' | 'error';
  } = {},
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
      required: ['path'],
      properties: {
        path,
        content: { type: 'string' },
        contentRef: referenceSchema,
        baseRef: {
          ...referenceSchema,
          description:
            'Exact reference from a successful read or mutation of this path. Omit this field entirely to create a new file; never pass null or a baseline object.',
        },
      },
      oneOf: [
        { required: ['content'], not: { required: ['contentRef'] } },
        { required: ['contentRef'], not: { required: ['content'] } },
      ],
      call: async (i, context) => {
        const content = await textInput(i, 'content', context);
        context.signal.throwIfAborted();
        const path = string(i.path),
          base = i.base === undefined ? null : baseline(i.base);
        return mutation({ operation: 'write', path, base }, context, () =>
          files.write({ path, content, base }),
        );
      },
    },
    {
      name: 'edit',
      required: ['path', 'baseRef'],
      oneOf: [
        { required: ['find'], not: { required: ['findRef'] } },
        { required: ['findRef'], not: { required: ['find'] } },
      ],
      properties: {
        path,
        find: { type: 'string', minLength: 1 },
        replace: { type: 'string' },
        findRef: referenceSchema,
        replaceRef: referenceSchema,
        occurrences: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, default: 1 },
        baseRef: referenceSchema,
      },
      call: async (i, context) => {
        const b = baseline(i.base);
        if (!b || (i.occurrences !== undefined && typeof i.occurrences !== 'number'))
          throw new AgentError('file_input_invalid');
        const find = await textInput(i, 'find', context),
          replace = await textInput(i, 'replace', context);
        context.signal.throwIfAborted();
        const path = string(i.path),
          occurrences = i.occurrences === undefined ? 1 : (i.occurrences as number);
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
      findRef: 'old_text_ref',
      replaceRef: 'new_text_ref',
    },
  };
  const descriptions: Record<string, string> = {
    read: 'Read UTF-8 file lines. Line numbers start at 1; return at most 200 lines by default. Continue by passing returned next_line as start_line (raw JSON fallback: selection.nextOffset). The returned base_ref binds the complete file identity and version and is required for later modifications.',
    write:
      'Create or replace a complete UTF-8 file. Omit base_ref only to create a new file; missing parent directories within the accepted file scope are created through the same protected no-follow boundary. Replacing a file requires the exact base_ref returned by its successful read or previous mutation and existing parents. Supply exactly one of content or content_ref. If a call fails, correct the reported cause before another authorized attempt; repeating the same path and input does not fix it. Only a call that attempts parent-directory creation may leave new empty directories. Each invocation has its own outcome; a baseline conflict does not report current file content or roll back other successful operations.',
    edit: 'Replace exact, non-overlapping literal text in a UTF-8 file using its exact base_ref. expected_matches defaults to 1 and must equal the actual number of matches. Supply old_text and new_text, or the corresponding immutable old_text_ref and new_text_ref returned for Artifact bodies. Each invocation has its own outcome; a baseline conflict does not report current file content or roll back other successful operations.',
  };
  return definitions.map((d) => ({
    id: `files.${d.name}`,
    model: {
      name: modelNames[d.name]!,
      snakeCase: true,
      resultVersion: '1',
      ...(modelParameters[d.name] ? { parameterNames: modelParameters[d.name] } : {}),
    },
    formatModelResult:
      d.name === 'read'
        ? formatFileReadResult
        : ({ result }) => {
            if (result.outcome !== 'succeeded') return;
            const value = object(JSON.parse(result.content));
            if (typeof value.base_ref !== 'string') return;
            const { baseline: _baseline, ...metadata } = value;
            return JSON.stringify(metadata);
          },
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
                        { required: ['replace'], not: { required: ['replaceRef'] } },
                        { required: ['replaceRef'], not: { required: ['replace'] } },
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
        const parameters = await fileParameters(object(input), context, files);
        const selected =
          parameters.path === undefined
            ? parameters
            : { ...parameters, path: files.relativePath(string(parameters.path)) };
        let value: unknown;
        try {
          value = await d.call(selected, context);
        } catch (error) {
          if (
            d.name === 'read' &&
            options.missingRead !== 'error' &&
            error instanceof AgentError &&
            error.code === 'ENOENT'
          ) {
            context.signal.throwIfAborted();
            return createMissingFileReadResult(string(parameters.path));
          }
          throw error;
        }
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
                base_ref: modelReference('file', context.executionId),
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
        const mutationNext = mutationCode ? fileFailureAdvice(mutationCode) : undefined;
        const failedPath =
          input &&
          typeof input === 'object' &&
          !Array.isArray(input) &&
          typeof input.path === 'string'
            ? input.path
            : undefined;
        return {
          outcome:
            error instanceof AgentError && error.code === 'file_publish_outcome_unknown'
              ? 'outcome_unknown'
              : context.signal.aborted
                ? 'cancelled'
                : 'failed',
          content: baselineConflict
            ? 'file_baseline_conflict: This invocation did not publish its requested change because its supplied baseline or create-only precondition was rejected. The baseline describes the complete file identity and version; this conflict does not prove that another edit targeted the same text. Compare each invocation using its own requested change and receipt. Earlier read content is historical; this failure does not report the current file content. Other successful operations are not rolled back. Do not infer that the file still has its earlier values. Before any separately authorized new edit, read the current file and use its fresh complete-file baseline.' +
              (error instanceof Error && error.message !== mutationCode ? ` ${error.message}` : '')
            : mutationNext
              ? `${mutationCode}${failedPath === undefined ? '' : ` (${JSON.stringify(failedPath)})`}: ${error instanceof Error && error.message !== mutationCode ? `${error.message} ` : ''}${mutationNext}`
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

/** A known missing ordinary target is an observation, never an empty file or an edit baseline. */
export function createMissingFileReadResult(path: string): ToolResult {
  return {
    outcome: 'succeeded',
    content: `File does not exist: ${JSON.stringify(path)}.`,
    details: { path, exists: false },
  };
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
    ...(snapshot.baseline
      ? { baseline: snapshot.baseline, base_ref: modelReference('file', context.executionId) }
      : {}),
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
