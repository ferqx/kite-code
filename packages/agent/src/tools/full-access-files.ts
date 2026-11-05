import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AuthorizationRequest, ToolContext, ToolDefinition, ToolResult } from '../extensions';
import { canonicalJson } from '../json';
import type { CapabilityDescription, PermissionPolicySnapshot } from '../permissions';
import { dispatchScopeLeaves } from '../permissions/dispatch-scope';
import { AgentError, type Json } from '../storage/types';
import { createWorkspaceFiles, type FileSnapshot, type WorkspaceFiles } from './files';
import {
  createFileReadResult,
  createFileTools,
  createMissingFileReadResult,
  fileFailureAdvice,
} from './files-tools';

type Request = Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>;
const versions: Readonly<Record<string, readonly string[]>> = {
  'files.read': ['4', '5'],
  'files.write': ['3'],
  'files.edit': ['2'],
};
const normalize = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
const within = (path: string, root: string) => {
  const selected = relative(normalize(root), normalize(path));
  return (
    selected === '' ||
    (!isAbsolute(selected) && selected !== '..' && !selected.startsWith(`..${sep}`))
  );
};
const codeOf = (error: unknown) =>
  error instanceof AgentError
    ? error.code
    : error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'file_io_failed';
const unsupportedEditableRead = new Set([
  'file_symlink',
  'file_owner_invalid',
  'file_root_invalid',
]);
async function identity(path: string) {
  try {
    const value = await lstat(path, { bigint: true });
    if (value.isSymbolicLink()) throw new AgentError('file_symlink');
    return { device: String(value.dev), inode: String(value.ino) };
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return null;
    throw error;
  }
}
async function canonicalTarget(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (codeOf(error) !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(await canonicalTarget(dirname(path)), basename(path));
  }
}

/** External text mutations use the existing native engine only under a final Full proof.
 * Workspace checkpoints and special Profile adapters retain their original scopes.
 */
export function withFullAccessFiles(options: {
  tools: readonly ToolDefinition[];
  workspaceRoot(request: Request): Promise<string>;
  protectedRoots(): readonly string[];
}) {
  async function outside(request: Request, input: Json) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.path !== 'string' ||
      !isAbsolute(input.path)
    )
      return null;
    const path = resolve(input.path);
    const workspace = resolve(await options.workspaceRoot(request));
    return within(path, workspace) ? null : { path, originalPath: input.path };
  }
  async function prepare(request: Request, input: Json) {
    const selected = await outside(request, input);
    if (!selected) return null;
    const logical =
      process.platform === 'win32'
        ? selected.originalPath.replaceAll('\\', '/')
        : selected.originalPath;
    if (
      Buffer.from(selected.originalPath).toString('utf8') !== selected.originalPath ||
      selected.originalPath.length > 4096 ||
      selected.originalPath.includes('\0') ||
      logical.split('/').some((part) => part === '.' || part === '..') ||
      (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(selected.originalPath))
    )
      throw new AgentError('file_path_invalid');
    const actual = await canonicalTarget(selected.path);
    for (const root of options.protectedRoots()) {
      const logicalRoot = resolve(root),
        actualRoot = await canonicalTarget(logicalRoot);
      if (within(selected.path, logicalRoot) || within(actual, actualRoot))
        throw new AgentError('file_path_protected');
    }
    let probe = selected.path;
    for (;;) {
      try {
        const parent = await lstat(dirname(probe));
        if (!parent.isDirectory() && !parent.isSymbolicLink()) throw new AgentError('ENOTDIR');
        break;
      } catch (error) {
        if (codeOf(error) !== 'ENOENT' || dirname(probe) === probe) throw error;
        probe = dirname(probe);
      }
    }
    const anchor = dirname(probe);
    // Opening the original logical anchor preserves native no-follow/root checks.
    const native = createWorkspaceFiles({ root: anchor, strictReads: true });
    try {
      const relativePath = native.relativePath(selected.path);
      const binding = {
        path: selected.path,
        actual,
        anchor,
        probe,
        parent: await identity(anchor),
        file: await identity(probe),
      };
      request.signal.throwIfAborted();
      return {
        ...selected,
        anchor,
        relativePath,
        binding,
        revision: `full-file:1:${createHash('sha256')
          .update(canonicalJson({ input, ...binding } as Json))
          .digest('hex')}`,
      };
    } finally {
      await native.close();
    }
  }
  function full(context: ToolContext, tool: ToolDefinition, revision?: string) {
    if (!context.dispatchAuthorization?.revision) return false;
    for (const leaf of dispatchScopeLeaves(
      context.dispatchAuthorization.snapshot,
      'file_dispatch_scope_unavailable',
    )) {
      const capability = leaf.data.capability as Record<string, Json> | undefined;
      if (
        leaf.namespace !== 'builtin.permissions' ||
        leaf.data.mode !== 'full' ||
        leaf.data.workspaceTrust !== true ||
        !capability ||
        capability.kind !== 'tool' ||
        capability.definitionId !== tool.id ||
        (tool.id === 'files.read'
          ? !versions['files.read']!.includes(String(capability.definitionVersion))
          : capability.definitionVersion !== tool.version) ||
        capability.hardAllowed !== true ||
        (revision !== undefined && capability.revision !== revision)
      )
        return false;
    }
    return true;
  }
  function failure(error: unknown, context: ToolContext, published = false): ToolResult {
    const code = published ? 'file_publish_outcome_unknown' : codeOf(error);
    const advice = fileFailureAdvice(code);
    return {
      outcome: published ? 'outcome_unknown' : context.signal.aborted ? 'cancelled' : 'failed',
      content: published
        ? `${code}: The file changed, but its result could not be confirmed. Do not repeat the write. ${error instanceof Error ? error.message : ''}`
        : code === 'file_full_access_required'
          ? `${code}: This file is outside the workspace. Direct external file mutation requires effective Full access from every inherited policy; this invocation did not modify the file.`
          : `${code}${error instanceof Error && error.message !== code ? `: ${error.message}` : ''}${advice ? `: ${advice}` : ''}`,
      details: {
        code,
        ...(advice ? { next_action: advice } : {}),
        fileScope: 'external_path',
        workspaceCheckpoint: false,
      },
    };
  }
  return {
    async describeRequest(
      request: AuthorizationRequest,
      policy?: Pick<PermissionPolicySnapshot, 'mode'>,
    ): Promise<CapabilityDescription | null> {
      if (
        request.kind !== 'tool' ||
        !['files.write', 'files.edit'].includes(request.definitionId) ||
        !versions[request.definitionId]?.includes(request.definitionVersion)
      )
        return null;
      if (!(await outside(request, request.input))) return null;
      const base = {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        safeRead: false,
        effects: ['external'] as const,
      };
      if (policy?.mode !== 'full')
        return {
          ...base,
          revision: 'builtin.files:external-full-required',
          hardAllowed: false,
          denialReason: 'file_full_access_required',
        };
      try {
        const selected = await prepare(request, request.input);
        return selected ? { ...base, revision: selected.revision, hardAllowed: true } : null;
      } catch (error) {
        request.signal.throwIfAborted();
        return {
          ...base,
          revision: 'builtin.files:external-full-unavailable',
          hardAllowed: false,
          denialReason: codeOf(error),
        };
      }
    },
    tools: options.tools.map(
      (tool): ToolDefinition =>
        !versions[tool.id]?.includes(tool.version)
          ? tool
          : {
              ...tool,
              description: `${tool.description} Full access also supports ordinary external absolute file targets directly. External read results include an edit baseline when the target supports native safe mutation; other readable external targets retain read-only results. Protected resources and inherited restrictions still apply. External files are outside workspace checkpoints.`,
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema.properties as Record<string, Json>),
                  path: {
                    type: 'string',
                    maxLength: 4096,
                    description:
                      'Workspace-relative or absolute path. Effective Full access allows external absolute write/edit targets; protected resources and native file checks remain.',
                  },
                },
              },
              async execute(input, context) {
                const read = tool.id === 'files.read';
                let files: WorkspaceFiles | undefined;
                let result: ToolResult;
                try {
                  if (!(await outside(context, input))) return await tool.execute(input, context);
                  if (!full(context, tool)) {
                    if (read) return await tool.execute(input, context);
                    throw new AgentError('file_full_access_required');
                  }
                  context.signal.throwIfAborted();
                  const selected = await prepare(context, input);
                  if (!selected) return await tool.execute(input, context);
                  if (!read && !full(context, tool, selected.revision))
                    throw new AgentError('file_dispatch_scope_changed');
                  files = createWorkspaceFiles({ root: selected.anchor, strictReads: true });
                  const native = files;
                  if (
                    canonicalJson({
                      path: selected.path,
                      actual: await canonicalTarget(selected.path),
                      anchor: selected.anchor,
                      probe: selected.binding.probe,
                      parent: await identity(selected.anchor),
                      file: await identity(selected.binding.probe),
                    } as Json) !== canonicalJson(selected.binding as Json)
                  )
                    throw new AgentError('file_dispatch_scope_changed');
                  const absolute = (snapshot: FileSnapshot): FileSnapshot => ({
                    ...snapshot,
                    path: selected.path,
                    ...(snapshot.change
                      ? { change: { ...snapshot.change, path: selected.path } }
                      : {}),
                  });
                  if (read) {
                    const parameters = input as Record<string, Json>;
                    let snapshot: FileSnapshot | undefined;
                    try {
                      snapshot = await native.read(selected.relativePath, {
                        offset: parameters.offset === undefined ? 1 : Number(parameters.offset),
                        limit: parameters.limit === undefined ? 200 : Number(parameters.limit),
                        signal: context.signal,
                      });
                    } catch (error) {
                      if (codeOf(error) !== 'ENOENT') throw error;
                      context.signal.throwIfAborted();
                    }
                    result = snapshot
                      ? await createFileReadResult(absolute(snapshot), context, {
                          fileScope: 'external_path',
                          workspaceCheckpoint: false,
                        })
                      : createMissingFileReadResult(selected.path);
                  } else {
                    const adapter = new Proxy(native, {
                      get(_source, property) {
                        if (property === 'relativePath')
                          return (path: string) => {
                            if (path !== selected.originalPath)
                              throw new AgentError('file_path_invalid');
                            return selected.relativePath;
                          };
                        if (property === 'write')
                          return async (value: Parameters<WorkspaceFiles['write']>[0]) =>
                            absolute(await native.write({ ...value, path: selected.relativePath }));
                        if (property === 'edit')
                          return async (value: Parameters<WorkspaceFiles['edit']>[0]) =>
                            absolute(await native.edit({ ...value, path: selected.relativePath }));
                        throw new AgentError('file_operation_unavailable');
                      },
                    });
                    result = await createFileTools(adapter)
                      .find((candidate) => candidate.id === tool.id)!
                      .execute(input, context);
                    result = {
                      ...result,
                      details: {
                        ...((result.details as Record<string, Json>) ?? {}),
                        fileScope: 'external_path',
                        workspaceCheckpoint: false,
                      },
                    };
                  }
                } catch (error) {
                  if (read && unsupportedEditableRead.has(codeOf(error))) {
                    await files?.close();
                    return await tool.execute(input, context);
                  }
                  result = failure(error, context);
                }
                try {
                  await files?.close();
                } catch (error) {
                  if (result.outcome === 'outcome_unknown')
                    return {
                      ...result,
                      content: `${result.content}\nNative file close also failed: ${error instanceof Error ? error.message : codeOf(error)}`,
                    };
                  return failure(error, context, !read && result.outcome === 'succeeded');
                }
                return result;
              },
            },
    ),
  };
}
