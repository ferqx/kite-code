import type { JobContext } from '../extensions';
import { AgentError } from '../storage/types';

/** A trusted host boundary, resolved once from the accepted dispatch proof. */
export interface HostShellExecutionScope {
  readonly filesystem: 'workspace_write' | 'full_access';
  readonly network: 'none' | 'internet';
}
export type HostShellExecutionScopeResolver = (context: JobContext) => HostShellExecutionScope;
export function resolveHostShellExecutionScope(
  executionScope: HostShellExecutionScope | HostShellExecutionScopeResolver | undefined,
  filesystemScope:
    | HostShellExecutionScope['filesystem']
    | ((context: JobContext) => HostShellExecutionScope['filesystem']),
  context: JobContext,
): HostShellExecutionScope {
  // Explicit low-level callers retain their original network contract. Formal
  // host assembly must supply executionScope; it never relies on this fallback.
  const scope = executionScope
    ? typeof executionScope === 'function'
      ? executionScope(context)
      : executionScope
    : {
        filesystem:
          typeof filesystemScope === 'function' ? filesystemScope(context) : filesystemScope,
        network: 'internet' as const,
      };
  if (
    !scope ||
    Object.keys(scope).some((key) => !['filesystem', 'network'].includes(key)) ||
    !['workspace_write', 'full_access'].includes(scope.filesystem) ||
    !['none', 'internet'].includes(scope.network)
  )
    throw new AgentError('host_shell_scope_unavailable');
  return { filesystem: scope.filesystem, network: scope.network };
}
