import type { JobContext } from '../extensions';
import { AgentError, type Json } from '../storage/types';

type Snapshot = NonNullable<NonNullable<JobContext['dispatchAuthorization']>['snapshot']>;

/** Visit the original accepted AND tree; individual leaves still belong to each adapter. */
export function* dispatchScopeLeaves(
  snapshot: Snapshot | undefined,
  unavailable: string,
): Generator<{ namespace: string; data: Record<string, Json> }> {
  const pending = [snapshot];
  let count = 0;
  while (pending.length) {
    const current = pending.pop();
    if (
      current?.version !== '1' ||
      ++count > 8192 ||
      !current.data ||
      typeof current.data !== 'object' ||
      Array.isArray(current.data)
    )
      throw new AgentError(unavailable);
    const data = current.data;
    if (current.namespace === 'builtin.planning.permissions') {
      if (
        Object.keys(data).sort().join(',') !== 'ceiling,current,originalRun,planning' ||
        !data.planning ||
        typeof data.planning !== 'object' ||
        Array.isArray(data.planning) ||
        !['disabled', 'pending', 'approved'].includes(String(data.planning.status)) ||
        !data.originalRun ||
        typeof data.originalRun !== 'object' ||
        Array.isArray(data.originalRun) ||
        typeof data.originalRun.sessionId !== 'string' ||
        typeof data.originalRun.runId !== 'string'
      )
        throw new AgentError(unavailable);
      for (const [key, value] of [
        ['current', data.current],
        ['ceiling', data.ceiling],
      ] as const) {
        if (value === null && key === 'ceiling') continue;
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof value.namespace !== 'string' ||
          typeof value.version !== 'string' ||
          !Object.hasOwn(value, 'data')
        )
          throw new AgentError(unavailable);
        pending.push(value as Snapshot);
      }
      continue;
    }
    if (current.namespace !== 'agent.permission-intersection') {
      // Yield as encountered so leaf rejection keeps its original error precedence.
      yield { namespace: current.namespace, data };
      continue;
    }
    if (!Array.isArray(data.policies) || !data.policies.length || data.policies.length > 2)
      throw new AgentError(unavailable);
    for (const [index, policy] of data.policies.entries()) {
      if (
        !policy ||
        typeof policy !== 'object' ||
        Array.isArray(policy) ||
        policy.scope !== (index === 0 ? 'parent' : 'child') ||
        typeof policy.revision !== 'string' ||
        !policy.revision ||
        typeof policy.allowed !== 'boolean' ||
        !policy.snapshot ||
        typeof policy.snapshot !== 'object' ||
        Array.isArray(policy.snapshot) ||
        typeof policy.snapshot.namespace !== 'string' ||
        typeof policy.snapshot.version !== 'string' ||
        !Object.hasOwn(policy.snapshot, 'data')
      )
        throw new AgentError(unavailable);
      // allowed=false may be an approval challenge accepted by final owned dispatch.
      // These snapshots explain the decision; no leaf grants authority by itself.
      pending.push(policy.snapshot as Snapshot);
    }
  }
}
