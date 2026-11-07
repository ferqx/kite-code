import { createHash } from 'node:crypto';
import type { AuthorizationRequest, PermissionDecision, Permissions } from './extensions';
import { canonicalJson } from './json';
import { AgentError, type Json } from './storage/types';

export interface CapabilityBinding {
  readonly kind: 'model' | 'tool' | 'job';
  readonly definitionId: string;
  readonly definitionVersion: string;
}
export interface GrantCandidate {
  readonly ruleId: string;
  readonly contractId: string;
  readonly scope: Json;
  readonly scopeDigest: string;
  readonly bindings: readonly CapabilityBinding[];
  readonly presentation: { readonly label: string; readonly details: readonly string[] };
}
export interface GrantPolicyBinding {
  readonly capability: CapabilityBinding;
  readonly reuseRevision: string;
  /** Explicit trusted permission to satisfy this policy's default check. */
  readonly satisfiesCheck?: true;
  readonly requireApproval?: boolean;
}
export interface GrantOffer extends GrantCandidate {
  readonly policyBindings: readonly GrantPolicyBinding[];
}
export type ApprovalOption =
  | {
      readonly optionId: string;
      readonly kind: 'once';
      readonly presentation: GrantCandidate['presentation'];
    }
  | (GrantOffer & { readonly optionId: string; readonly kind: 'scope' });
export interface GrantUse {
  readonly grantId: string;
  readonly revision: string;
  readonly acceptedRevision: string;
  readonly offer: GrantOffer;
  readonly binding: CapabilityBinding;
  readonly reuseRevision: string;
}
export const grantDigest = (value: Json): string =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export const sameCapability = (a: CapabilityBinding, b: CapabilityBinding): boolean =>
  a.kind === b.kind &&
  a.definitionId === b.definitionId &&
  a.definitionVersion === b.definitionVersion;
export const capabilityKey = (binding: CapabilityBinding): string =>
  canonicalJson(binding as unknown as Json);
export function grantScopeDigest(
  candidate: Pick<GrantCandidate, 'ruleId' | 'contractId' | 'scope' | 'bindings'>,
): string {
  return grantDigest({
    ruleId: candidate.ruleId,
    contractId: candidate.contractId,
    scope: candidate.scope,
    bindings: [...candidate.bindings].sort((a, b) =>
      capabilityKey(a).localeCompare(capabilityKey(b)),
    ) as unknown as Json,
  });
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 8192;
const capability = (value: unknown): value is CapabilityBinding =>
  object(value) &&
  Object.keys(value).sort().join(',') === 'definitionId,definitionVersion,kind' &&
  ['model', 'tool', 'job'].includes(String(value.kind)) &&
  text(value.definitionId) &&
  text(value.definitionVersion);
export function parseGrantCandidate(value: unknown): GrantCandidate {
  if (
    !object(value) ||
    !text(value.ruleId) ||
    !text(value.contractId) ||
    !Object.hasOwn(value, 'scope') ||
    !Array.isArray(value.bindings) ||
    !value.bindings.length ||
    value.bindings.length > 32 ||
    !value.bindings.every(capability) ||
    new Set(value.bindings.map(capabilityKey)).size !== value.bindings.length ||
    !object(value.presentation) ||
    !text(value.presentation.label) ||
    !Array.isArray(value.presentation.details) ||
    !value.presentation.details.every(text)
  )
    throw new AgentError('invalid_grant_offer');
  const candidate = value as unknown as GrantCandidate;
  if (candidate.scopeDigest !== grantScopeDigest(candidate))
    throw new AgentError('invalid_grant_offer');
  return structuredClone({
    ruleId: candidate.ruleId,
    contractId: candidate.contractId,
    scope: candidate.scope,
    scopeDigest: candidate.scopeDigest,
    bindings: candidate.bindings,
    presentation: candidate.presentation,
  });
}
export function parseGrantOffer(value: unknown): GrantOffer {
  const candidate = parseGrantCandidate(value);
  if (
    !object(value) ||
    !Array.isArray(value.policyBindings) ||
    value.policyBindings.length !== candidate.bindings.length ||
    !value.policyBindings.every(
      (binding) =>
        object(binding) &&
        capability(binding.capability) &&
        typeof binding.reuseRevision === 'string' &&
        /^[a-f0-9]{64}$/.test(binding.reuseRevision) &&
        (binding.satisfiesCheck === undefined || binding.satisfiesCheck === true) &&
        (binding.requireApproval === undefined || typeof binding.requireApproval === 'boolean') &&
        Object.keys(binding).every((key) =>
          ['capability', 'reuseRevision', 'satisfiesCheck', 'requireApproval'].includes(key),
        ),
    ) ||
    candidate.bindings.some(
      (binding) =>
        (value.policyBindings as { capability: CapabilityBinding }[]).filter(
          (entry: { capability: CapabilityBinding }) => sameCapability(entry.capability, binding),
        ).length !== 1,
    )
  )
    throw new AgentError('invalid_grant_offer');
  return { ...candidate, policyBindings: structuredClone(value.policyBindings) } as GrantOffer;
}
export function approvalOptions(offers: readonly GrantOffer[] = []): ApprovalOption[] {
  return [
    { optionId: 'once', kind: 'once', presentation: { label: '仅此次', details: [] } },
    ...offers.map((offer) => ({
      ...parseGrantOffer(offer),
      kind: 'scope' as const,
      optionId: `scope-${offer.scopeDigest}`,
    })),
  ];
}
export function selectedApprovalOption(request: unknown, optionId: unknown): ApprovalOption {
  if (!object(request) || !Array.isArray(request.options) || !text(optionId))
    throw new AgentError('interaction_answer_invalid');
  const selected = request.options.filter(
    (option) => object(option) && option.optionId === optionId,
  );
  if (selected.length !== 1) throw new AgentError('interaction_answer_invalid');
  const option = selected[0];
  if (!object(option) || (option.kind !== 'once' && option.kind !== 'scope'))
    throw new AgentError('interaction_answer_invalid');
  if (option.kind === 'scope') parseGrantOffer(option);
  return structuredClone(option) as unknown as ApprovalOption;
}
/** Every participant supplies a binding, including a participant that already allows this call. */
export async function intersectGrantOffers(
  request: AuthorizationRequest,
  participants: readonly { permissions: Permissions; decision: PermissionDecision }[],
): Promise<GrantOffer[]> {
  const candidates = participants.flatMap(({ decision }) => decision.grantOffers ?? []);
  const result: GrantOffer[] = [];
  for (const candidate of candidates) {
    if (result.some((offer) => offer.scopeDigest === candidate.scopeDigest)) continue;
    const policyBindings: GrantPolicyBinding[] = [];
    let supported = true;
    for (const binding of candidate.bindings) {
      const revisions: GrantPolicyBinding[] = [];
      for (const participant of participants) {
        const decision = participant.decision;
        if (
          (!decision.allowed && !decision.approval && !decision.check) ||
          !participant.permissions.reuseRevision
        ) {
          supported = false;
          break;
        }
        if (
          decision.approval &&
          !(decision.grantOffers ?? []).some(
            (offer) =>
              offer.scopeDigest === candidate.scopeDigest &&
              canonicalJson([...offer.bindings].map(capabilityKey).sort()) ===
                canonicalJson([...candidate.bindings].map(capabilityKey).sort()),
          )
        ) {
          supported = false;
          break;
        }
        const revision = await participant.permissions.reuseRevision(
          request,
          binding,
          candidate,
          decision,
        );
        if (!revision) {
          supported = false;
          break;
        }
        revisions.push({
          capability: binding,
          ...revision,
          requireApproval: revision.requireApproval ?? decision.check?.requireApproval === true,
        });
      }
      if (!supported) break;
      policyBindings.push({
        capability: binding,
        reuseRevision: grantDigest(revisions as unknown as Json),
        requireApproval: revisions.some((revision) => revision.requireApproval === true),
        ...(participants.every(
          ({ decision }, index) => !decision.check || revisions[index]?.satisfiesCheck,
        )
          ? { satisfiesCheck: true as const }
          : {}),
      });
    }
    if (supported) result.push({ ...candidate, policyBindings });
  }
  return result;
}
