import { createHash } from 'node:crypto';
import type { PermissionDecision, Permissions } from '../extensions';

/** Current root policy AND a trusted capability ceiling; neither can widen the other. */
export function intersectPermissionPolicies(
  current: Permissions,
  ceiling?: Permissions,
): Permissions {
  if (!ceiling) return current;
  return {
    toolDispatchOrder: current.toolDispatchOrder ?? ceiling.toolDispatchOrder,
    async authorize(request): Promise<PermissionDecision> {
      const base = await current.authorize(request);
      const injected = await ceiling.authorize(request);
      const revision = createHash('sha256')
        .update(JSON.stringify([base, injected]))
        .digest('hex');
      const controlReads = [...(base.controlReads ?? [])];
      for (const read of injected.controlReads ?? []) {
        const previous = controlReads.find(
          (item) => item.kind === read.kind && item.scope === read.scope,
        );
        if (previous && previous.revision !== read.revision)
          return { allowed: false, revision, reason: 'permission_control_changed' };
        if (!previous) controlReads.push(read);
      }
      if (controlReads.length > 3)
        return { allowed: false, revision, reason: 'invalid_permission_control_reads' };
      const proof = {
        revision,
        controlReads,
        snapshot:
          injected.snapshot === undefined
            ? base.snapshot
            : {
                namespace: 'agent.permission-intersection',
                version: '1',
                data: {
                  policies: [base, injected].map((decision, index) => ({
                    scope: index === 0 ? 'parent' : 'child',
                    revision: decision.revision,
                    allowed: decision.allowed,
                    snapshot: decision.snapshot ?? null,
                  })),
                },
              },
      };
      if (!base.allowed && !base.approval && !base.check) return { ...base, ...proof };
      if (!injected.allowed && !injected.approval && !injected.check)
        return { ...injected, ...proof };
      if (injected.allowed) return { ...base, ...proof };
      if (base.allowed) return { ...injected, ...proof };
      const decisions = [base, injected];
      const checks = decisions.filter((decision) => decision.check);
      return {
        allowed: false,
        ...proof,
        approval: {
          request: { policies: decisions.map((decision) => decision.approval?.request ?? null) },
        },
        ...(checks.length
          ? {
              check: {
                request: {
                  policies: decisions.map((decision) => decision.check?.request ?? null),
                },
                requireApproval: decisions.some(
                  (decision) =>
                    decision.check?.requireApproval || (!!decision.approval && !decision.check),
                ),
              },
            }
          : {}),
      };
    },
  };
}
