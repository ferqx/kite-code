import type { AuthorizationRequest, Json, ToolDefinition } from '../extensions';
import {
  type CapabilityBinding,
  type GrantCandidate,
  grantDigest,
  grantScopeDigest,
} from '../permission-grants';
import type { TrustedToolBehavior } from '../tool-behavior';
import type { WorkspaceFiles } from './files';

/** Ordinary workspace locations only. Private adapters retain their own narrower contracts. */
export function createFileToolBehaviors(options: {
  readonly tools: readonly ToolDefinition[];
  readonly readFiles: (
    request: AuthorizationRequest,
  ) => Promise<{ workspaceId: string; root: string; files: WorkspaceFiles }>;
}): TrustedToolBehavior[] {
  const definitions = options.tools.filter(
    (tool) =>
      (tool.id === 'files.write' && tool.version === '3') ||
      (tool.id === 'files.edit' && tool.version === '2'),
  );
  if (definitions.length !== 2) return [];
  const bindings: CapabilityBinding[] = definitions.map((tool) => ({
    kind: 'tool',
    definitionId: tool.id,
    definitionVersion: tool.version,
  }));
  return definitions.map((definition) => ({
    definition,
    capability: {
      kind: 'tool',
      definitionId: definition.id,
      definitionVersion: definition.version,
    },
    contractRef: 'builtin.files.exact-location',
    configurationDigest: grantDigest({
      bindings: bindings as unknown as Json,
      scope: 'workspace-parent-slot-edit-write',
    }),
    autoReview: 'none',
    async grantOffers(request): Promise<GrantCandidate[]> {
      if (
        !request.input ||
        typeof request.input !== 'object' ||
        Array.isArray(request.input) ||
        typeof request.input.path !== 'string'
      )
        return [];
      let bound: Awaited<ReturnType<typeof options.readFiles>> | undefined;
      try {
        bound = await options.readFiles(request);
        request.signal.throwIfAborted();
        const path = bound.files.relativePath(request.input.path);
        const rootIdentity = await bound.files.inspectRootIdentity?.();
        if (!rootIdentity) return [];
        const actual = await bound.files.inspectIdentity(path);
        request.signal.throwIfAborted();
        const candidate = {
          ruleId: 'builtin.files.location',
          contractId: 'builtin.files.exact-location',
          scope: {
            workspaceId: bound.workspaceId,
            root: bound.root,
            rootIdentity,
            parent: actual.parent,
            path,
            actions: ['edit', 'write'],
          } as unknown as Json,
          bindings,
          presentation: {
            label: '本会话内对此文件编辑和写入',
            details: [
              `Session: ${request.sessionId}`,
              `File: ${bound.root}/${path}`,
              'Actions: edit, write; this exact location only, no recursive directory access.',
              `Tools: ${bindings.map((binding) => `${binding.definitionId}@${binding.definitionVersion}`).join(', ')}`,
              'Current baseline, content conflicts, protected paths and current permissions are checked for every call.',
            ],
          },
        };
        return [{ ...candidate, scopeDigest: grantScopeDigest(candidate) }];
      } catch {
        request.signal.throwIfAborted();
        return [];
      } finally {
        await bound?.files.close();
      }
    },
  }));
}
