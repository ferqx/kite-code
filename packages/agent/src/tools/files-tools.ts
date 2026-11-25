import type { ArtifactRef, ToolContext, ToolDefinition, ToolResult } from '../extensions';
import { modelReference, readModelReference } from '../model-reference';
import type { Json } from '../storage/types';
import { AgentError } from '../storage/types';
import type { FileBaseline, FileSnapshot, WorkspaceFiles } from './files';
import { formatFileReadResult } from './files/model-result';
import { isEngineeringTextPath, unsupportedFileRead } from './files/read-scope';

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
    'Workspace-relative or absolute file path. Omit .. segments and use paths allowed by the current file scope.',
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
  mutation: boolean,
): Promise<Record<string, Json>> {
  const value = { ...input };
  if (value.baseRef !== undefined) {
    if (value.base !== undefined) throw new AgentError('file_input_invalid');
    value.base = await fileBaselineReference(value.baseRef, context, string(value.path), (path) =>
      files.relativePath(path),
    );
    delete value.baseRef;
  } else if (mutation && context.readDecisionToolResults) {
    const selected = files.relativePath(string(value.path));
    for (const { execution } of await context.readDecisionToolResults()) {
      if (
        execution.status !== 'succeeded' ||
        !fileDefinitions[execution.definitionId as keyof typeof fileDefinitions]?.includes(
          execution.definitionVersion ?? '',
        )
      )
        continue;
      const result = execution.result as { content?: string } | null;
      let candidate: Record<string, Json>;
      try {
        candidate = object(JSON.parse(result?.content ?? 'null'));
        if (typeof candidate.path !== 'string' || files.relativePath(candidate.path) !== selected)
          continue;
      } catch {
        continue;
      }
      if (candidate.baseline !== undefined)
        value.base = baseline(candidate.baseline) as unknown as Json;
      break;
    }
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
      'The file request has invalid arguments. Check the declared field names, types and required fields before a separately authorized corrected request.',
    file_read_range_invalid:
      'The requested line range is invalid. offset and limit must be positive safe integers; omit them to use their declared defaults. Correct the range without changing the intended file.',
    file_edit_invalid:
      'Supply a nonempty old_string and a string new_string. Use replace_all only for a request to replace every exact match.',
    file_edit_match_conflict:
      'The old_string did not match exactly once. This edit did not publish a change. Check the exact text after reading the current file. Use replace_all only if every exact match should change.',
    file_baseline_invalid:
      'The file baseline is unavailable. Read the same path before requesting the change.',
    ENOENT:
      'The target file or a required parent directory does not exist. Verify the path. Use write_file to create a new file when the task calls for it.',
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
            'Maximum lines to return; defaults to 200. Continue by passing returned next_line as offset (raw JSON fallback: selection.nextOffset), or request explicit limit.',
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
      required: ['path'],
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
        replaceAll: { type: 'boolean' },
        baseRef: referenceSchema,
      },
      call: async (i, context) => {
        if (i.base === undefined) throw new AgentError('tool_reference_unavailable');
        const b = baseline(i.base);
        if (!b || (i.occurrences !== undefined && typeof i.occurrences !== 'number'))
          throw new AgentError('file_input_invalid');
        const find = await textInput(i, 'find', context),
          replace = await textInput(i, 'replace', context);
        context.signal.throwIfAborted();
        const path = string(i.path),
          occurrences = i.occurrences === undefined ? 1 : (i.occurrences as number);
        return mutation({ operation: 'edit', path, base: b }, context, () =>
          files.edit({
            path,
            base: b,
            find,
            replace,
            occurrences,
            ...(i.replaceAll === true ? { replaceAll: true } : {}),
          }),
        );
      },
    },
  ];
  const modelNames: Record<string, string> = {
    read: 'read_file',
    write: 'write_file',
    edit: 'edit_file',
  };
  const descriptions: Record<string, string> = {
    read: 'Read UTF-8 source, scripts, project configuration and engineering documentation. Use one-based offset and limit (default 200); pass next_line as offset to continue. Read document and data formats with their skills or exec_command, and use view_images for images. A missing ordinary file returns exists:false. The runtime retains the exact editable file baseline for later writes.',
    write:
      'Create a UTF-8 file or replace its complete content. To replace an existing file, read the same path first. Missing parent directories within the allowed file scope can be created. The runtime checks for concurrent changes before writing. Verify the original result before proceeding after a write with unknown outcome.',
    edit: 'Replace literal old_string with new_string after reading the same path. Use replace_all only when every exact match should change. Otherwise old_string must match exactly once. The runtime checks for concurrent changes before publishing. After a confirmed conflict, read the current file before deciding on a new edit.',
  };
  return definitions.map((d) => ({
    id: `files.${d.name}`,
    model: {
      name: modelNames[d.name]!,
      snakeCase: true,
      resultVersion: '1',
      ...(d.name === 'edit'
        ? { parameterNames: { find: 'old_string', replace: 'new_string' } }
        : {}),
      ...(d.name !== 'read'
        ? {
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: d.name === 'edit' ? ['path', 'find', 'replace'] : ['path', 'content'],
              properties: (d.name === 'edit'
                ? {
                    path,
                    find: d.properties.find!,
                    replace: d.properties.replace!,
                    replaceAll: d.properties.replaceAll!,
                  }
                : { path, content: d.properties.content! }) as Record<string, Json>,
            },
          }
        : {}),
    },
    formatModelResult:
      d.name === 'read'
        ? formatFileReadResult
        : ({ result }) => {
            if (result.outcome !== 'succeeded') return;
            const value = object(JSON.parse(result.content));
            if (typeof value.base_ref !== 'string') return;
            const { baseline: _baseline, base_ref: _reference, ...metadata } = value;
            return JSON.stringify(metadata);
          },
    ...(capture && (d.name === 'write' || d.name === 'edit')
      ? { resources: { serial: { scope: 'workspace' as const, key: 'files.mutation' } } }
      : {}),
    version: d.name === 'read' ? '4' : d.name === 'write' ? '3' : '2',
    description: `${descriptions[d.name]} Paths are relative to the fixed workspace root, independent of the Shell working directory. Absolute paths are subject to the current file permissions.`,
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
        const parameters = await fileParameters(object(input), context, files, d.name !== 'read');
        const selected =
          parameters.path === undefined
            ? parameters
            : { ...parameters, path: files.relativePath(string(parameters.path)) };
        let value: unknown;
        try {
          if (
            d.name === 'read' &&
            typeof selected.path === 'string' &&
            !isEngineeringTextPath(selected.path)
          ) {
            const identity = await files.inspectIdentity(selected.path);
            context.signal.throwIfAborted();
            if (!identity.file) throw new AgentError('ENOENT');
            throw unsupportedFileRead(string(parameters.path));
          }
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
            ? 'file_baseline_conflict: This invocation did not publish its requested change because the retained file baseline or create precondition no longer matched. This conflict does not prove that another edit targeted the same text. Earlier read content is historical; this failure does not report the current file content. Other successful operations are not rolled back. Before any separately authorized new edit, read the same path again so the runtime can use its current baseline.' +
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
