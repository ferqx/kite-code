import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { AuthorizationRequest, ToolDefinition, ToolResult } from '../extensions';
import type { CapabilityDescription } from '../permissions';
import { AgentError, type Json } from '../storage/types';
import { createFileReadResult } from './files-tools';

const normalized = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
function within(path: string, root: string) {
  const scope = relative(normalized(root), normalized(path));
  return scope === '' || (!isAbsolute(scope) && scope !== '..' && !scope.startsWith(`..${sep}`));
}
function codeOf(error: unknown) {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : 'file_read_failed';
}

/** Shared exact-path classification; this performs no content read or new authorization. */
export async function externalReadTarget(
  path: string,
  workspace: string,
  roots: readonly string[],
  signal: AbortSignal,
) {
  if (!isAbsolute(path)) return null;
  path = resolve(path);
  if (path.includes('\0')) throw new AgentError('file_path_invalid');
  if (within(path, workspace)) return null;
  const actual = await realpath(path);
  for (const root of roots) {
    const protectedRoot = resolve(root);
    const actualRoot = await realpath(protectedRoot).catch((error) => {
      if (codeOf(error) === 'ENOENT') return protectedRoot;
      throw error;
    });
    if (within(path, protectedRoot) || within(actual, actualRoot))
      throw new AgentError('file_path_protected');
  }
  signal.throwIfAborted();
  return { path, actual };
}

/** Ordinary external reads share the existing permission policy and result delivery.
 * Saved input/plan/output adapters wrap this layer and retain their scoped private references.
 */
export function withExternalFileReads(options: {
  tools: readonly ToolDefinition[];
  workspaceRoot(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
  ): Promise<string>;
  protectedRoots(): readonly string[];
}) {
  async function target(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    input: Json,
  ) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.path !== 'string' ||
      !isAbsolute(input.path)
    )
      return null;
    const workspace = await options.workspaceRoot(request);
    return externalReadTarget(input.path, workspace, options.protectedRoots(), request.signal);
  }
  return {
    tools: options.tools.map(
      (tool): ToolDefinition =>
        tool.id !== 'files.read'
          ? tool
          : {
              ...tool,
              description:
                'Read UTF-8 file lines, at most 200 by default. Paths are relative to the fixed workspace root or absolute, including outside the workspace. Continue with start_line/max_lines. Workspace reads return a complete-file baseline for later edits; external reads are read-only and have no baseline or workspace checkpoint. Permission rules and protected private/runtime paths still apply. External reads do not load project instructions.',
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema.properties as Record<string, Json>),
                  path: {
                    type: 'string',
                    maxLength: 4096,
                    description:
                      'Workspace-relative or absolute file path, including files outside the workspace.',
                  },
                },
              },
              async execute(input, context): Promise<ToolResult> {
                try {
                  context.signal.throwIfAborted();
                  const selected = await target(context, input);
                  if (!selected) return await tool.execute(input, context);
                  const parameters = input as Record<string, Json>;
                  const offset = parameters.offset ?? 1,
                    limit = parameters.limit ?? 200;
                  if (
                    !Number.isSafeInteger(offset) ||
                    Number(offset) < 1 ||
                    !Number.isSafeInteger(limit) ||
                    Number(limit) < 1
                  )
                    throw new AgentError('file_input_invalid');
                  const file = await open(selected.actual, 'r');
                  let bytes: Buffer;
                  try {
                    if (!(await file.stat()).isFile()) throw new AgentError('file_not_regular');
                    if ((await realpath(selected.path)) !== selected.actual)
                      throw new AgentError('file_changed');
                    bytes = await file.readFile({ signal: context.signal });
                  } finally {
                    await file.close();
                  }
                  let text: string;
                  try {
                    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
                  } catch {
                    throw new AgentError('file_encoding_invalid');
                  }
                  if (bytes.subarray(0, 8192).includes(0)) throw new AgentError('file_binary');
                  const lines = text === '' ? [] : text.match(/[^\n]*\n|[^\n]+$/g)!;
                  const from = Number(offset) - 1,
                    through = Math.min(lines.length, from + Number(limit));
                  context.signal.throwIfAborted();
                  return await createFileReadResult(
                    {
                      path: selected.path,
                      content: lines.slice(from, through).join(''),
                      selection: {
                        fromLine: Number(offset),
                        toLine: from >= lines.length ? null : through,
                        totalLines: lines.length,
                        nextOffset: through < lines.length ? through + 1 : null,
                      },
                    },
                    context,
                    { fileScope: 'external_path', workspaceCheckpoint: false },
                  );
                } catch (error) {
                  const code = codeOf(error);
                  return {
                    outcome: context.signal.aborted ? 'cancelled' : 'failed',
                    content: code,
                    details: { code },
                  };
                }
              },
            },
    ),
    async describeRequest(request: AuthorizationRequest): Promise<CapabilityDescription | null> {
      if (request.kind !== 'tool' || request.definitionId !== 'files.read') return null;
      const identity = {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
      };
      try {
        if (!(await target(request, request.input))) return null;
        return {
          ...identity,
          revision: 'builtin.files:external-read',
          effects: ['read'],
          safeRead: true,
          hardAllowed: true,
        };
      } catch (error) {
        request.signal.throwIfAborted();
        return {
          ...identity,
          revision: 'builtin.files:external-read',
          effects: ['read'],
          safeRead: false,
          hardAllowed: false,
          denialReason: codeOf(error),
        };
      }
    },
  };
}
