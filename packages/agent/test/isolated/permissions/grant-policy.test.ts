import { expect, test } from '#kite-test';
import type { AuthorizationRequest, Permissions } from '../../../src/extensions';
import { type GrantCandidate, grantDigest, grantScopeDigest } from '../../../src/permission-grants';
import { createPermissionPolicy } from '../../../src/permissions';
import { intersectPermissionPolicies } from '../../../src/permissions/inheritance';

const confirmationOwner = {
  capability: { kind: 'tool' as const, definitionId: 'fixture.edit', definitionVersion: '1' },
  contractRef: 'fixture.confirmation',
  configurationDigest: '0'.repeat(64),
};

const bindings = ['fixture.edit', 'fixture.write'].map((definitionId) => ({
  kind: 'tool' as const,
  definitionId,
  definitionVersion: '1',
}));
const candidate: GrantCandidate = (() => {
  const value = {
    ruleId: 'fixture.location',
    contractId: 'fixture.exact-location',
    scope: { slot: 'file', anchor: 'directory' },
    bindings,
    presentation: { label: '本会话精确文件位置', details: ['edit 和 write；不递归'] },
  };
  return { ...value, scopeDigest: grantScopeDigest(value) };
})();
const request = (definitionId = 'fixture.edit', input = 'body'): AuthorizationRequest => ({
  kind: 'tool',
  definitionId,
  definitionVersion: '1',
  sessionId: 's',
  runId: 'r',
  executionId: input,
  input: { body: input },
  signal: new AbortController().signal,
});
function policy(mode: 'auto' | 'accept_edits' | 'full' = 'auto', control = '0') {
  return createPermissionPolicy({
    readPolicy: () => ({
      mode,
      workspaceTrust: true,
      revision: 'fixture.policy',
      allowed: bindings,
      controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: control }],
    }),
    describeCapability: (value) => ({
      kind: value.kind,
      definitionId: value.definitionId,
      definitionVersion: value.definitionVersion,
      revision: grantDigest(value.input),
      effects: ['process'],
      hardAllowed: true,
      safeRead: false,
      autoReview: 'check',
      grantSatisfiesDefaultCheck: true,
      grantOffers: [candidate],
    }),
  });
}

test('stable scope binding retains full per-call revisions and accepts a different bound definition', async () => {
  const permissions = policy();
  const edit = await permissions.authorize(request());
  const write = await permissions.authorize(
    request('fixture.write', 'different-body-and-baseline'),
  );
  expect(edit.revision).not.toBe(write.revision);
  const originalWrite = edit.grantOffers![0]!.policyBindings.find(
    (binding) => binding.capability.definitionId === 'fixture.write',
  )!;
  const actualWrite = write.grantOffers![0]!.policyBindings.find(
    (binding) => binding.capability.definitionId === 'fixture.write',
  )!;
  expect(originalWrite).toEqual(actualWrite);
  expect(actualWrite.satisfiesCheck).toBe(true);
  const changed = await policy('auto', '1').authorize(request('fixture.write', 'new'));
  expect(changed.grantOffers![0]!.policyBindings[1]!.reuseRevision).not.toBe(
    actualWrite.reuseRevision,
  );
});

test('AND includes an allowed participant and a participant without reusable support suppresses the option', async () => {
  const current = policy('accept_edits');
  const unsupported: Permissions = {
    authorize: async () => ({ allowed: true, revision: 'single-call-only' }),
  };
  const limited = await intersectPermissionPolicies(current, unsupported).authorize(request());
  expect(limited.grantOffers).toEqual([]);
  expect(limited.approval!.options!.map((option) => option.kind)).toEqual(['once']);
  const full = await intersectPermissionPolicies(current, policy('full')).authorize(request());
  expect(full.grantOffers).toHaveLength(1);
  expect(full.grantOffers![0]!.policyBindings[0]!.reuseRevision).not.toBe(
    (await current.authorize(request())).grantOffers![0]!.policyBindings[0]!.reuseRevision,
  );
  const ceiling = policy('accept_edits');
  const reordered: Permissions = {
    ...ceiling,
    async authorize(value) {
      const decision = await ceiling.authorize(value);
      return {
        ...decision,
        grantOffers: decision.grantOffers?.map((offer) => ({
          ...offer,
          bindings: [...offer.bindings].reverse(),
        })),
      };
    },
  };
  expect(
    (await intersectPermissionPolicies(current, reordered).authorize(request())).grantOffers,
  ).toHaveLength(1);
});

test('AND retains an independent checker and independently required human approval in the reusable binding', async () => {
  const independent: Permissions = {
    authorize: async () => ({
      allowed: false,
      revision: 'independent',
      check: { request: { kind: 'independent' }, requireApproval: true },
    }),
    reuseRevision: async () => ({
      reuseRevision: grantDigest({ policy: 'independent' }),
      requireApproval: true,
    }),
  };
  const combined = await intersectPermissionPolicies(policy(), independent).authorize(request());
  expect(combined.check!.requireApproval).toBe(true);
  expect(combined.grantOffers).toHaveLength(1);
  expect(combined.grantOffers![0]!.policyBindings[0]!.satisfiesCheck).toBeUndefined();
  expect(combined.grantOffers![0]!.policyBindings[0]!.requireApproval).toBe(true);
});

test('another authorization sharing a snapshot cannot replace an independent confirmation challenge', async () => {
  const snapshot = { namespace: 'fixture.current', version: '1', data: {} };
  const current: Permissions = {
    authorize: async () => ({ allowed: true, revision: 'current', snapshot }),
  };
  const ceiling: Permissions = {
    authorize: async (value) =>
      value.executionId === 'independent'
        ? { allowed: false, revision: 'independent', check: { request: { separate: true } } }
        : { allowed: true, revision: 'unrelated' },
  };
  const combined = intersectPermissionPolicies(current, ceiling);
  const original = request('fixture.edit', 'independent');
  const decision = await combined.authorize(original);
  expect(await combined.consumesExecutionConfirmation!(original, decision, confirmationOwner)).toBe(
    false,
  );
  await combined.authorize(request('fixture.edit', 'unrelated'));
  expect(decision.check).toBeDefined();
  expect(await combined.consumesExecutionConfirmation!(original, decision, confirmationOwner)).toBe(
    false,
  );
});

test('explicit confirmation support composes without optional policy snapshots', async () => {
  const current: Permissions = {
    authorize: async () => ({
      allowed: false,
      revision: 'current',
      approval: { request: { exact: true } },
    }),
    consumesExecutionConfirmation: async () => true,
  };
  const combined = intersectPermissionPolicies(current, {
    authorize: async () => ({ allowed: true, revision: 'ceiling' }),
  });
  const original = request();
  const decision = await combined.authorize(original);
  expect(decision.snapshot).toBeUndefined();
  expect(await combined.consumesExecutionConfirmation!(original, decision, confirmationOwner)).toBe(
    true,
  );
});
