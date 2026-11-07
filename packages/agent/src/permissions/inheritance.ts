import { createHash } from 'node:crypto';
import { consumesExecutionConfirmation } from '../execution-confirmation';
import type { PermissionDecision, Permissions } from '../extensions';
import { approvalOptions, intersectGrantOffers, sameCapability } from '../permission-grants';
import { autoCheckOptions } from './auto-check';
import { sealWorktreeDecision } from './worktree-authorization';

/** Current root policy AND a trusted capability ceiling; neither can widen the other. */
export function intersectPermissionPolicies(
  current: Permissions,
  ceiling?: Permissions,
): Permissions {
  if (!ceiling) return current;
  const sources = new WeakMap<PermissionDecision, readonly PermissionDecision[]>();
  return {
    async consumesExecutionConfirmation(request, decision, owner) {
      const prior = sources.get(decision);
      if (!prior) return false;
      return (
        (await consumesExecutionConfirmation(current, request, prior[0]!, owner)) &&
        (await consumesExecutionConfirmation(ceiling, request, prior[1]!, owner))
      );
    },
    toolDispatchOrder: current.toolDispatchOrder ?? ceiling.toolDispatchOrder,
    async reuseRevision(_request, capability, candidate, decision) {
      const offer = decision.grantOffers?.find(
        (offer) => offer.scopeDigest === candidate.scopeDigest,
      );
      const binding = offer?.policyBindings.find((binding) =>
        sameCapability(binding.capability, capability),
      );
      return binding
        ? {
            reuseRevision: binding.reuseRevision,
            ...(binding.satisfiesCheck ? { satisfiesCheck: true as const } : {}),
            ...(binding.requireApproval === undefined
              ? {}
              : { requireApproval: binding.requireApproval }),
          }
        : null;
    },
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
      const grantOffers = await intersectGrantOffers(request, [
        { permissions: current, decision: base },
        { permissions: ceiling, decision: injected },
      ]);
      const apply = (decision: PermissionDecision): PermissionDecision => ({
        ...decision,
        grantOffers,
        ...(decision.approval
          ? { approval: { ...decision.approval, options: approvalOptions(grantOffers) } }
          : {}),
      });
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
      const finish = (decision: PermissionDecision): PermissionDecision => {
        const result = sealWorktreeDecision(apply(decision), [base, injected]);
        sources.set(result, [base, injected]);
        return result;
      };
      if (!base.allowed && !base.approval && !base.check) return { ...base, ...proof };
      if (!injected.allowed && !injected.approval && !injected.check)
        return { ...injected, ...proof };
      if (injected.allowed) return finish({ ...base, ...proof });
      if (base.allowed) return finish({ ...injected, ...proof });
      const decisions = [base, injected];
      const checks = decisions.filter((decision) => decision.check);
      return finish({
        allowed: false,
        ...proof,
        approval: {
          request: { policies: decisions.map((decision) => decision.approval?.request ?? null) },
        },
        ...(checks.length
          ? {
              check: {
                ...autoCheckOptions(checks.map((decision) => decision.check!)),
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
      });
    },
  };
}
