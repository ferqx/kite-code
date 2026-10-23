import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import type { AuthorizationRequest, ToolContext, ToolDefinition } from '../extensions';
import { canonicalJson } from '../json';
import type { CapabilityDescription } from '../permissions';
import { dispatchScopeLeaves } from '../permissions/dispatch-scope';
import { AgentError, type Json } from '../storage/types';
import { createWorkspaceFiles, type FileBaseline, type WorkspaceFiles } from './files';
import { createFileTools } from './files-tools';

export interface EditablePlanFile {
  path: string;
  planId: string;
  version: number;
  digest: string;
  title: string;
  steps: Json;
  file: { path: string; hash: string; size: number };
}
/** Ordinary read/write/edit presentation, with all plan mutations delegated to the Planning owner. */
export function withPlanFileTools(options: {
  profilePath: string;
  tools: readonly ToolDefinition[];
  current(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
  ): Promise<EditablePlanFile | null>;
  write(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    input: Json,
  ): Promise<void>;
}) {
  const root = resolve(options.profilePath);
  function candidate(input: Json) {
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      typeof input.path !== 'string' ||
      !isAbsolute(input.path)
    )
      return false;
    const normalized = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    return normalized(input.path).startsWith(`${normalized(root)}${sep}files${sep}`);
  }
  async function target(
    request: Pick<AuthorizationRequest, 'sessionId' | 'executionId' | 'signal'>,
    input: Json,
    anchored?: WorkspaceFiles,
  ) {
    if (!candidate(input)) return null;
    const current = await options.current(request);
    if (!current || (input as { path: string }).path !== current.path) return null;
    const files =
      anchored ?? createWorkspaceFiles({ root: dirname(current.path), strictReads: true });
    try {
      const identity = await files.inspectIdentity(basename(current.path));
      if (!identity.file) throw new AgentError('plan_file_missing');
      const revision = `plan-file:1:${createHash('sha256')
        .update(
          canonicalJson({
            sessionId: request.sessionId,
            input,
            current,
            identity,
          } as unknown as Json),
        )
        .digest('hex')}`;
      return { current, revision };
    } finally {
      if (!anchored) await files.close();
    }
  }
  function verify(context: ToolContext, tool: ToolDefinition, revision: string) {
    if (!context.dispatchAuthorization?.revision)
      throw new AgentError('file_dispatch_scope_unavailable');
    for (const leaf of dispatchScopeLeaves(
      context.dispatchAuthorization.snapshot,
      'file_dispatch_scope_unavailable',
    )) {
      const capability = leaf.data.capability as Record<string, Json> | undefined;
      if (
        leaf.namespace !== 'builtin.permissions' ||
        !capability ||
        capability.definitionId !== tool.id ||
        capability.definitionVersion !== tool.version ||
        capability.hardAllowed !== true ||
        capability.revision !== revision
      )
        throw new AgentError('file_dispatch_scope_changed');
    }
  }
  return {
    async isPlanFileEdit(request: AuthorizationRequest) {
      if (
        request.kind !== 'tool' ||
        request.definitionVersion !== '2' ||
        !['files.write', 'files.edit'].includes(request.definitionId)
      )
        return false;
      try {
        return !!(await target(request, request.input));
      } catch {
        return false;
      }
    },
    async describeRequest(request: AuthorizationRequest): Promise<CapabilityDescription | null> {
      if (
        request.kind !== 'tool' ||
        !['files.read', 'files.write', 'files.edit'].includes(request.definitionId)
      )
        return null;
      const selected = await target(request, request.input);
      if (!selected) return null;
      const read = request.definitionId === 'files.read';
      return {
        kind: request.kind,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
        revision: selected.revision,
        effects: [read ? 'read' : 'external'],
        safeRead: read,
        hardAllowed: true,
      };
    },
    tools: options.tools.map(
      (tool): ToolDefinition =>
        !['files.read', 'files.write', 'files.edit'].includes(tool.id)
          ? tool
          : {
              ...tool,
              async execute(input, context) {
                let files: WorkspaceFiles | undefined;
                try {
                  const selected = await target(context, input);
                  if (!selected) return tool.execute(input, context);
                  verify(context, tool, selected.revision);
                  files = createWorkspaceFiles({
                    root: dirname(selected.current.path),
                    strictReads: true,
                  });
                  const native = files;
                  if ((await target(context, input, native))?.revision !== selected.revision)
                    throw new AgentError('file_dispatch_scope_changed');
                  const name = basename(selected.current.path);
                  async function mutate(
                    base: FileBaseline | null,
                    transform: (text: string) => string,
                  ) {
                    const prior = await native.read(name, { signal: context.signal });
                    if (
                      !base ||
                      canonicalJson(base as unknown as Json) !==
                        canonicalJson(prior.baseline as unknown as Json)
                    )
                      throw new AgentError('file_baseline_conflict');
                    if ((await target(context, input, native))?.revision !== selected!.revision)
                      throw new AgentError('file_dispatch_scope_changed');
                    const body = transform(prior.content);
                    await options.write(context, {
                      planId: selected!.current.planId,
                      expectedVersion: selected!.current.version,
                      title: selected!.current.title,
                      body,
                      steps: selected!.current.steps,
                      fileBase: prior.baseline as unknown as Json,
                    });
                    const after = await native.read(name, { signal: context.signal });
                    if (after.content !== body)
                      throw new AgentError('file_publish_outcome_unknown');
                    return { ...after, path: selected!.current.path };
                  }
                  const adapter = new Proxy(native, {
                    get(_source, key) {
                      if (key === 'relativePath')
                        return (path: string) => {
                          if (path !== selected.current.path)
                            throw new AgentError('file_path_invalid');
                          return name;
                        };
                      if (key === 'read')
                        return async (
                          _path: string,
                          args: Parameters<WorkspaceFiles['read']>[1],
                        ) => {
                          const value = await native.read(name, {
                            ...args,
                            signal: context.signal,
                          });
                          if (
                            (await target(context, input, native))?.revision !== selected.revision
                          )
                            throw new AgentError('plan_file_changed');
                          return { ...value, path: selected.current.path };
                        };
                      if (key === 'write')
                        return (value: Parameters<WorkspaceFiles['write']>[0]) =>
                          mutate(value.base, () => value.content);
                      if (key === 'edit')
                        return (value: Parameters<WorkspaceFiles['edit']>[0]) =>
                          mutate(value.base, (body) => {
                            if (!value.find) throw new AgentError('file_input_invalid');
                            const pieces = body.split(value.find);
                            if (pieces.length - 1 !== value.occurrences)
                              throw new AgentError('file_edit_match_conflict');
                            return pieces.join(value.replace);
                          });
                      throw new AgentError('plan_file_operation_unavailable');
                    },
                  });
                  return await createFileTools(adapter)
                    .find((definition) => definition.id === tool.id)!
                    .execute(input, context);
                } catch (error) {
                  return {
                    outcome: context.signal.aborted ? 'cancelled' : 'failed',
                    content: error instanceof Error ? error.message : 'plan_file_unavailable',
                  };
                } finally {
                  await files?.close();
                }
              },
            },
    ),
  };
}
