import { basename, dirname } from 'node:path';
import type { AuthorizationRequest, Json, ToolDefinition } from '../../extensions';
import { type GrantCandidate, grantScopeDigest } from '../../permission-grants';
import { validWorktreeDecision } from '../../permissions/worktree-authorization';
import type { TrustedToolBehavior } from '../../tool-behavior';
import { stableWorktreeIdentity } from './approval-scope';
import { Git } from './git';
import { canonicalDirectory, exists, identity, samePath, targetPath, utf8 } from './paths';
import {
  type GitWorktreeConfiguration,
  parseGitWorktreeRequest,
  resolveDefaultWorktreeTarget,
} from './protocol';
export function createWorktreeToolBehavior(options: {
  readonly definition: ToolDefinition;
  readonly configuration: GitWorktreeConfiguration;
  readonly configurationDigest: string;
}): TrustedToolBehavior {
  const { definition, configuration } = options;
  const capability = {
    kind: 'tool' as const,
    definitionId: definition.id,
    definitionVersion: definition.version,
  };
  return {
    definition,
    capability,
    contractRef: 'builtin.worktree.action-scope',
    configurationDigest: options.configurationDigest,
    autoReview: 'none',
    async authorizeChild(_request, decision, _context, bridge) {
      return validWorktreeDecision(decision) && !decision.check?.requireApproval
        ? bridge.worktree()
        : null;
    },
    async grantOffers(request: AuthorizationRequest): Promise<GrantCandidate[]> {
      const input = parseGitWorktreeRequest(request.input, request.executionId);
      if (!input || input.action === 'list' || configuration.unavailable) return [];
      try {
        request.signal.throwIfAborted();
        const git = new Git(
          configuration.git.path,
          configuration.git.sha256,
          configuration.hooksPath,
          request.signal,
        );
        const repository = await git.repository(configuration.sourceCwd);
        request.signal.throwIfAborted();
        const requested =
          input.path ??
          (configuration.defaultRoot &&
            resolveDefaultWorktreeTarget({
              defaultRoot: configuration.defaultRoot,
              sourceCwd: configuration.sourceCwd,
              sessionId: request.sessionId,
              key: input.key,
            }));
        if (!requested) return [];
        const target = targetPath(requested);
        const parent = canonicalDirectory(dirname(target));
        const scope: Record<string, Json> = {
          repository: {
            root: repository.root,
            commonDir: repository.commonDir,
            rootIdentity: stableWorktreeIdentity(repository.rootIdentity),
            commonIdentity: stableWorktreeIdentity(repository.commonIdentity),
          },
          action: input.action,
          parent: { path: parent, identity: stableWorktreeIdentity(identity(parent)) },
          permissions: input.permissions,
        };
        const details = [
          `Session: ${request.sessionId}`,
          `Repository: ${repository.root}`,
          `Tool: ${definition.id}@${definition.version}`,
        ];
        if (input.action === 'create') {
          if (exists(target) || !samePath(dirname(target), parent)) return [];
          const base = await git.run(
            repository.root,
            ['rev-parse', '--verify', '--end-of-options', `${input.baseRef}^{commit}`],
            { allowFailure: true },
          );
          if (base.exitCode !== 0) return [];
          const baseOid = utf8(base.stdout).replace(/\n$/, '');
          if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseOid)) return [];
          scope.baseOid = baseOid;
          scope.branchMode = input.newBranch ? 'newBranch' : 'detached';
          details.push(
            `Create direct children under: ${parent}`,
            `Fixed base commit: ${baseOid}`,
            `Branch mode: ${String(scope.branchMode)}`,
            'Only unoccupied direct child targets; newBranch must be a new branch. No remove, force, recursive directories or additional external scope.',
          );
        } else {
          const listed = (await git.list(repository)).find((entry) => samePath(entry.path, target));
          if (!listed || listed.isMain || listed.isCurrent) return [];
          scope.target = {
            path: canonicalDirectory(target),
            name: basename(target),
            identity: stableWorktreeIdentity(identity(target)),
          };
          details.push(
            `Remove this exact target: ${target}`,
            'No create, force or recursive cleanup. Dirty/untracked/ignored content, occupancy, references and all original removal protections are checked every time.',
          );
        }
        request.signal.throwIfAborted();
        const candidate = {
          ruleId: 'builtin.worktree.action',
          contractId: 'builtin.worktree.action-scope',
          scope,
          bindings: [capability],
          presentation: {
            label:
              input.action === 'create'
                ? '本会话内在此父目录创建直接子工作树'
                : '本会话内删除此精确工作树',
            details,
          },
        };
        return [{ ...candidate, scopeDigest: grantScopeDigest(candidate) }];
      } catch {
        request.signal.throwIfAborted();
        return [];
      }
    },
  };
}
