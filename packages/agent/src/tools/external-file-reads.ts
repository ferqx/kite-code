import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AuthorizationRequest, ToolDefinition, ToolResult } from '../extensions';
import { canonicalJson } from '../json';
import type { CapabilityDescription } from '../permissions';
import { dispatchScopeLeaves } from '../permissions/dispatch-scope';
import { AgentError, type Json } from '../storage/types';
import type { FileSnapshot } from './files';
import { createFileReadResult, createMissingFileReadResult } from './files-tools';

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

/** Resolve missing suffixes through existing ancestors before checking protected scopes.
 * A dangling link is not proof that the requested ordinary target is absent.
 */
async function resolvedTarget(path: string): Promise<{ actual: string; exists: boolean }> {
  try {
    return { actual: await realpath(path), exists: true };
  } catch (error) {
    if (codeOf(error) !== 'ENOENT' || dirname(path) === path) throw error;
    try {
      await lstat(path);
    } catch (inspectionError) {
      if (codeOf(inspectionError) !== 'ENOENT') throw inspectionError;
      const parent = await resolvedTarget(dirname(path));
      return { actual: resolve(parent.actual, basename(path)), exists: false };
    }
    throw new AgentError('file_changed');
  }
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
  const selected = await resolvedTarget(path);
  for (const root of roots) {
    const protectedRoot = resolve(root);
    const actualRoot = (await resolvedTarget(protectedRoot)).actual;
    if (within(path, protectedRoot) || within(selected.actual, actualRoot))
      throw new AgentError('file_path_protected');
  }
  signal.throwIfAborted();
  return { path, ...selected };
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
  const revision = (selected: unknown, input: Json) =>
    `external-read:1:${createHash('sha256')
      .update(canonicalJson({ selected, input } as Json))
      .digest('hex')}`;
  /** Read into a private value. This does not create a result or publish an Artifact. */
  async function readSnapshot(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    input: Json,
  ): Promise<{ path: string; value: Omit<FileSnapshot, 'baseline'> | null } | null> {
    const selected = await target(request, input);
    if (!selected) return null;
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
    request.signal.throwIfAborted();
    // Even a metadata-missing target is opened: only an actual ENOENT establishes
    // absence. NONBLOCK prevents a substituted FIFO from blocking before fstat.
    let file: Awaited<ReturnType<typeof open>>;
    try {
      file = await open(
        selected.actual,
        constants.O_RDONLY |
          (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW),
      );
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
      const current = await target(request, input);
      if (!current || current.exists || current.actual !== selected.actual)
        throw new AgentError('file_changed');
      request.signal.throwIfAborted();
      return { path: selected.path, value: null };
    }
    let bytes: Buffer;
    try {
      const before = await file.stat({ bigint: true });
      const current = await target(request, input);
      const actual = current && (await lstat(current.actual, { bigint: true }));
      if (!before.isFile()) throw new AgentError('file_not_regular');
      if (
        !current?.exists ||
        current.actual !== selected.actual ||
        !actual?.isFile() ||
        before.dev !== actual.dev ||
        before.ino !== actual.ino
      )
        throw new AgentError('file_changed');
      bytes = await file.readFile({ signal: request.signal });
      const after = await file.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        BigInt(bytes.byteLength) !== after.size
      )
        throw new AgentError('file_changed');
      const finished = await target(request, input);
      const identity = finished && (await lstat(finished.actual, { bigint: true }));
      if (
        !finished?.exists ||
        finished.actual !== selected.actual ||
        identity?.dev !== after.dev ||
        identity.ino !== after.ino
      )
        throw new AgentError('file_changed');
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
    request.signal.throwIfAborted();
    return {
      path: selected.path,
      value: {
        path: selected.path,
        content: lines.slice(from, through).join(''),
        selection: {
          fromLine: Number(offset),
          toLine: from >= lines.length ? null : through,
          totalLines: lines.length,
          nextOffset: through < lines.length ? through + 1 : null,
        },
      },
    };
  }
  return {
    readSnapshot,
    tools: options.tools.map(
      (tool): ToolDefinition =>
        tool.id !== 'files.read'
          ? tool
          : {
              ...tool,
              description: `${tool.description} External reads do not grant write permission or load project instructions. External files are outside workspace checkpoints.`,
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
                  const expected = revision(selected, input);
                  if (!context.dispatchAuthorization?.revision)
                    throw new AgentError('file_dispatch_scope_unavailable');
                  for (const leaf of dispatchScopeLeaves(
                    context.dispatchAuthorization.snapshot,
                    'file_dispatch_scope_unavailable',
                  )) {
                    const cap = leaf.data.capability as Record<string, Json> | undefined;
                    if (
                      leaf.namespace !== 'builtin.permissions' ||
                      leaf.data.workspaceTrust !== true ||
                      !['auto', 'full', 'accept_edits'].includes(String(leaf.data.mode)) ||
                      !cap ||
                      cap.kind !== 'tool' ||
                      cap.definitionId !== tool.id ||
                      !['4', '5'].includes(String(cap.definitionVersion)) ||
                      cap.hardAllowed !== true ||
                      cap.revision !== expected
                    )
                      throw new AgentError('file_dispatch_scope_changed');
                  }
                  const snapshot = await readSnapshot(context, input);
                  if (!snapshot) throw new AgentError('file_dispatch_scope_changed');
                  return snapshot.value
                    ? await createFileReadResult(snapshot.value, context, {
                        fileScope: 'external_path',
                        workspaceCheckpoint: false,
                      })
                    : createMissingFileReadResult(snapshot.path);
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
        const selected = await target(request, request.input);
        if (!selected) return null;
        return {
          ...identity,
          revision: revision(selected, request.input),
          effects: ['read', 'external'],
          safeRead: false,
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
