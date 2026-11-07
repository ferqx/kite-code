import {
  approvalOptions,
  type CapabilityBinding,
  type GrantOffer,
  grantDigest,
  grantScopeDigest,
} from '../../packages/agent/src/permission-grants';
import type { Json } from '../../packages/agent/src/storage/types';

/** Trusted test policy's finite range; production rules must derive their own real resource facts. */
export function fixtureGrant(
  definitionId: string,
  scope: Json,
  kind: 'tool' | 'job' = 'tool',
  bindings?: readonly CapabilityBinding[],
): GrantOffer {
  const candidate = {
    ruleId: 'fixture.scope',
    contractId: 'fixture.scope.contract',
    scope,
    bindings: bindings ?? [{ kind, definitionId, definitionVersion: '1' }],
    presentation: { label: '本会话准确范围', details: ['仅测试策略明确列出的工具与资源'] },
  };
  return {
    ...candidate,
    scopeDigest: grantScopeDigest(candidate),
    policyBindings: candidate.bindings.map((capability) => ({
      capability,
      reuseRevision: grantDigest({
        policy: 'fixture.policy',
        scope,
        capability: capability as unknown as Json,
      }),
    })),
  };
}
export function fixtureOptions(
  definitionId: string,
  scope: Json,
  kind: 'tool' | 'job' = 'tool',
): Json {
  return approvalOptions([fixtureGrant(definitionId, scope, kind)]) as unknown as Json;
}
export function fixtureScopeOption(request: Json): string {
  const options = (request as { options: { kind: string; optionId: string }[] }).options;
  const option = options.find((option) => option.kind === 'scope');
  if (!option) throw new Error('fixture_scope_option_missing');
  return option.optionId;
}
