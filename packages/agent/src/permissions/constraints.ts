import { createHash } from 'node:crypto';
import { consumesExecutionConfirmation } from '../execution-confirmation';
import type { AuthorizationRequest, Json, PermissionDecision, Permissions } from '../extensions';
import { sameCapability } from '../permission-grants';
import { sealWorktreeDecision } from './worktree-authorization';

const object = (value: Json | undefined): value is Record<string, Json> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: Json): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
      .join(',')}}`;
  return JSON.stringify(value);
};
const permissionConstraintDigest = (value: Json) =>
  createHash('sha256').update(canonical(value)).digest('hex');
/** Compose a business gate with current Tool permission; a gate never grants authority. */
export function createBusinessPermissionPolicy(options: {
  current: Permissions;
  gate(request: AuthorizationRequest): Promise<PermissionDecision>;
}): Permissions {
  const sources = new WeakMap<object, PermissionDecision>();
  return {
    async consumesExecutionConfirmation(request, decision, owner) {
      const current = decision.snapshot && sources.get(decision.snapshot);
      return !!current && consumesExecutionConfirmation(options.current, request, current, owner);
    },
    toolDispatchOrder: options.current.toolDispatchOrder,
    async reuseRevision(_request, capability, candidate, decision) {
      const binding = decision.grantOffers
        ?.find((offer) => offer.scopeDigest === candidate.scopeDigest)
        ?.policyBindings.find((binding) => sameCapability(binding.capability, capability));
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
    async authorize(request) {
      request.signal.throwIfAborted();
      const current = await options.current.authorize(request);
      const gate = await options.gate(request);
      request.signal.throwIfAborted();
      const proof = {
        revision: permissionConstraintDigest({
          current: current as unknown as Json,
          gate: gate as unknown as Json,
        }),
        ...(current.controlReads === undefined ? {} : { controlReads: current.controlReads }),
        snapshot: {
          namespace: 'builtin.business.permissions',
          version: '1',
          data: { current: current.snapshot ?? null, gate: gate.snapshot ?? null },
        },
      };
      sources.set(proof.snapshot, current);
      if (!current.allowed && !current.approval && !current.check)
        return sealWorktreeDecision({ allowed: false, reason: current.reason, ...proof }, [
          current,
        ]);
      if (!gate.allowed)
        return sealWorktreeDecision({ allowed: false, reason: gate.reason, ...proof }, [current]);
      return sealWorktreeDecision({ ...current, ...proof }, [current]);
    },
  };
}
