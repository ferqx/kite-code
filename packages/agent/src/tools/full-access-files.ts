import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  AuthorizationRequest,
  PermissionDecision,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../extensions';
import { canonicalJson } from '../json';
import type { CapabilityDescription, PermissionPolicySnapshot } from '../permissions';
import { dispatchScopeLeaves } from '../permissions/dispatch-scope';
import { AgentError, type Json } from '../storage/types';
import type { PreparedToolExecution } from '../tool-behavior';
import { withExternalFileReads } from './external-file-reads';
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

/** External text mutations use the existing native engine only under a final owned authorization proof.
 * Workspace checkpoints and special Profile adapters retain their original scopes.
 */
export function withFullAccessFiles(options: {
  tools: readonly ToolDefinition[];
  workspaceRoot(request: Request): Promise<string>;
  protectedRoots(): readonly string[];
  workspaceScope?(request: Request): Promise<{ root: string; revision: string }>;
  preparationBinding?(request: AuthorizationRequest, preparing?: true): Promise<string>;
}) {
  const readScope = withExternalFileReads(options);
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
  function authorized(context: ToolContext, tool: ToolDefinition, revision?: string) {
    if (!context.dispatchAuthorization?.revision) return false;
    for (const leaf of dispatchScopeLeaves(
      context.dispatchAuthorization.snapshot,
      'file_dispatch_scope_unavailable',
    )) {
      const capability = leaf.data.capability as Record<string, Json> | undefined;
      if (
        leaf.namespace !== 'builtin.permissions' ||
        !['full', 'auto', 'accept_edits'].includes(String(leaf.data.mode)) ||
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
  type ReadSnapshot = {
    path: string;
    value: (Omit<FileSnapshot, 'baseline'> & { baseline?: FileSnapshot['baseline'] }) | null;
  };
  /** No ToolResult or Artifact exists until the final dispatch consumes this value. */
  async function readSnapshot(request: Request, input: Json): Promise<ReadSnapshot | null> {
    let files: WorkspaceFiles | undefined;
    try {
      const selected = await prepare(request, input);
      if (!selected) return null;
      files = createWorkspaceFiles({ root: selected.anchor, strictReads: true });
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
      const parameters = input as Record<string, Json>;
      let value: FileSnapshot | null = null;
      try {
        value = await files.read(selected.relativePath, {
          offset: parameters.offset === undefined ? 1 : Number(parameters.offset),
          limit: parameters.limit === undefined ? 200 : Number(parameters.limit),
          signal: request.signal,
        });
      } catch (error) {
        if (codeOf(error) !== 'ENOENT') throw error;
        request.signal.throwIfAborted();
      }
      return { path: selected.path, value: value ? { ...value, path: selected.path } : null };
    } catch (error) {
      if (!unsupportedEditableRead.has(codeOf(error))) throw error;
      return readScope.readSnapshot(request, input);
    } finally {
      await files?.close();
    }
  }
  // Metadata only. Bodies are owned by the returned single-use closure, never by
  // request description, review material, public records, or the Artifact store.
  const preparations = new Map<
    string,
    {
      key: string;
      revision: string;
      baseRevision: string;
      scope: string;
      missing: boolean;
      binding: string;
    }
  >();
  const requestKey = (request: AuthorizationRequest) =>
    canonicalJson({
      sessionId: request.sessionId,
      runId: request.runId,
      executionId: request.executionId,
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      input: request.input,
    });
  const readScopeIdentity = async (request: Request) => {
    const scope = options.workspaceScope
      ? await options.workspaceScope(request)
      : { root: await options.workspaceRoot(request), revision: '' };
    return canonicalJson({
      ...scope,
      root: resolve(scope.root),
      protectedRoots: [...options.protectedRoots()],
    });
  };
  async function describeReadRequest(
    request: AuthorizationRequest,
  ): Promise<CapabilityDescription | null> {
    const current = await readScope.describeRequest(request);
    const prepared = preparations.get(request.executionId);
    if (!prepared) return current;
    if (
      !current?.hardAllowed ||
      prepared.key !== requestKey(request) ||
      prepared.binding !== ((await options.preparationBinding?.(request)) ?? requestKey(request)) ||
      (!prepared.missing && prepared.baseRevision !== current.revision) ||
      prepared.scope !== (await readScopeIdentity(request))
    )
      return current
        ? { ...current, hardAllowed: false, denialReason: 'file_preparation_changed' }
        : {
            kind: request.kind,
            definitionId: request.definitionId,
            definitionVersion: request.definitionVersion,
            revision: 'builtin.files:preparation-changed',
            effects: ['read'],
            safeRead: false,
            hardAllowed: false,
            denialReason: 'file_preparation_changed',
          };
    return {
      ...current,
      revision: prepared.revision,
      // A completed missing read exposes no bytes. Native policy still applies its
      // own hard gates; independent parent/child checkers are not rewritten.
      ...(prepared.missing ? { effects: ['read'] as const, safeRead: true } : {}),
    };
  }
  async function prepareRead(
    request: AuthorizationRequest,
    decision: PermissionDecision,
  ): Promise<PreparedToolExecution | null> {
    if (
      request.kind !== 'tool' ||
      request.definitionId !== 'files.read' ||
      request.definitionVersion !== '5' ||
      decision.check?.requireApproval === true ||
      (decision.approval !== undefined && !decision.check)
    )
      return null;
    const leaves = [...dispatchScopeLeaves(decision.snapshot, 'file_dispatch_scope_unavailable')];
    if (
      !leaves.some((leaf) => leaf.namespace === 'builtin.permissions' && leaf.data.mode === 'auto')
    )
      return null;
    const initial = await readScope.describeRequest(request);
    if (!initial) return null;
    if (!initial.hardAllowed)
      throw new AgentError(initial.denialReason ?? 'file_read_scope_unavailable');
    if (preparations.has(request.executionId)) throw new AgentError('file_preparation_conflict');
    const scope = await readScopeIdentity(request);
    const binding = (await options.preparationBinding?.(request, true)) ?? requestKey(request);
    let snapshot = await readSnapshot(request, request.input);
    if (!snapshot) throw new AgentError('file_preparation_changed');
    request.signal.throwIfAborted();
    const after = await readScope.describeRequest(request);
    if (
      !after?.hardAllowed ||
      (snapshot.value !== null && after.revision !== initial.revision) ||
      scope !== (await readScopeIdentity(request))
    )
      throw new AgentError('file_preparation_changed');
    const metadata = {
      key: requestKey(request),
      baseRevision: initial.revision,
      revision: `${initial.revision}:prepared:${randomUUID()}`,
      scope,
      missing: snapshot.value === null,
      binding,
    };
    if (binding !== ((await options.preparationBinding?.(request)) ?? requestKey(request)))
      throw new AgentError('file_preparation_changed');
    request.signal.throwIfAborted();
    preparations.set(request.executionId, metadata);
    let consumed = false;
    const dispose = () => {
      if (preparations.get(request.executionId) === metadata)
        preparations.delete(request.executionId);
      snapshot = null;
      request.signal.removeEventListener('abort', dispose);
    };
    request.signal.addEventListener('abort', dispose, { once: true });
    return {
      dispose,
      async execute(context) {
        request.signal.throwIfAborted();
        context.signal.throwIfAborted();
        if (
          consumed ||
          !snapshot ||
          preparations.get(request.executionId) !== metadata ||
          context.sessionId !== request.sessionId ||
          context.executionId !== request.executionId ||
          context.runId !== request.runId ||
          scope !== (await readScopeIdentity(request))
        )
          throw new AgentError('file_preparation_unavailable');
        const tool = options.tools.find((value) => value.id === 'files.read')!;
        if (!authorized(context, tool, metadata.revision))
          throw new AgentError('file_dispatch_scope_changed');
        const current = await describeReadRequest(request);
        if (!current?.hardAllowed || current.revision !== metadata.revision)
          throw new AgentError('file_preparation_changed');
        request.signal.throwIfAborted();
        context.signal.throwIfAborted();
        consumed = true;
        const frozen = snapshot;
        dispose();
        return frozen.value
          ? createFileReadResult(frozen.value, context, {
              fileScope: 'external_path',
              workspaceCheckpoint: false,
            })
          : createMissingFileReadResult(frozen.path);
      },
    };
  }
  return {
    prepareRead,
    describeReadRequest,
    async describeRequest(
      request: AuthorizationRequest,
      _policy?: Pick<PermissionPolicySnapshot, 'mode'>,
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
              description: `${tool.description} Ordinary external absolute file targets use the current permission mode: Full allows, Auto reviews, Request Approval asks the user. External read results include an edit baseline when the target supports native safe mutation; other readable external targets retain read-only results. Protected resources and inherited restrictions still apply. External files are outside workspace checkpoints.`,
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...(tool.inputSchema.properties as Record<string, Json>),
                  path: {
                    type: 'string',
                    maxLength: 4096,
                    description:
                      'Workspace-relative or absolute path. External absolute write/edit targets require authorization under the current mode; protected resources and native file checks remain.',
                  },
                },
              },
              async execute(input, context) {
                const read = tool.id === 'files.read';
                let files: WorkspaceFiles | undefined;
                let result: ToolResult;
                try {
                  if (!(await outside(context, input))) return await tool.execute(input, context);
                  if (!authorized(context, tool)) {
                    throw new AgentError('file_dispatch_scope_unavailable');
                  }
                  if (read) {
                    const capability = await readScope.describeRequest({
                      ...context,
                      kind: 'tool',
                      definitionId: tool.id,
                      definitionVersion: tool.version,
                      input,
                    });
                    if (!capability?.hardAllowed || !authorized(context, tool, capability.revision))
                      throw new AgentError('file_dispatch_scope_changed');
                  }
                  context.signal.throwIfAborted();
                  const selected = await prepare(context, input);
                  if (!selected) return await tool.execute(input, context);
                  if (!read && !authorized(context, tool, selected.revision))
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
