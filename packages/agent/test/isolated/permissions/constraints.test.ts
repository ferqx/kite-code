import { expect, test } from '#kite-test';
import type { AuthorizationRequest, PermissionDecision } from '../../../src/extensions';
import { grantScopeDigest } from '../../../src/permission-grants';
import { createBusinessPermissionPolicy, createPermissionPolicy } from '../../../src/permissions';

const request: AuthorizationRequest = {
  kind: 'tool',
  sessionId: 's',
  runId: 'r',
  executionId: 'write',
  definitionId: 'files.write',
  definitionVersion: '3',
  input: { path: '/owned/outside.txt' },
  signal: new AbortController().signal,
};
const gate = (allowed: boolean, revision = 'business-1'): PermissionDecision => ({
  allowed,
  revision,
  ...(!allowed ? { reason: 'business_approval_required' } : {}),
  snapshot: { namespace: 'fixture.business', version: '1', data: { approved: allowed, revision } },
});

test('an extension business gate blocks current Full without manufacturing permission approval', async () => {
  const permission = createBusinessPermissionPolicy({
    current: { authorize: async () => ({ allowed: true, revision: 'current-full' }) },
    gate: async () => gate(false),
  });
  const decision = await permission.authorize(request);
  expect(decision).toMatchObject({ allowed: false, reason: 'business_approval_required' });
  expect(decision.approval).toBeUndefined();
  expect(decision.check).toBeUndefined();
  expect(decision.grantOffers).toBeUndefined();
});

test('business approval preserves current Full rather than introducing an Auto or Manual ceiling', async () => {
  const current: PermissionDecision = {
    allowed: true,
    revision: 'current-full',
    snapshot: { namespace: 'builtin.permissions', version: '1', data: { mode: 'full' } },
    controlReads: [{ kind: 'permission.mode', scope: 'session:s', revision: '3' }],
  };
  const permission = createBusinessPermissionPolicy({
    current: { authorize: async () => current },
    gate: async () => gate(true),
  });
  const decision = await permission.authorize(request);
  expect(decision.allowed).toBe(true);
  expect(decision.approval).toBeUndefined();
  expect(decision.check).toBeUndefined();
  expect(decision.controlReads).toEqual(current.controlReads);
  expect(decision.snapshot).toMatchObject({
    namespace: 'builtin.business.permissions',
    data: {
      current: current.snapshot,
      gate: { namespace: 'fixture.business', data: { approved: true } },
    },
  });
});

test('business approval cannot replace current check, manual approval or a hard denial', async () => {
  for (const current of [
    {
      allowed: false,
      revision: 'auto',
      check: { request: { exact: 'call' }, requireApproval: true },
    },
    { allowed: false, revision: 'manual', approval: { request: { exact: 'call' }, options: [] } },
    { allowed: false, revision: 'denied', reason: 'workspace_untrusted' },
  ] satisfies PermissionDecision[]) {
    const permission = createBusinessPermissionPolicy({
      current: { authorize: async () => current },
      gate: async () => gate(true),
    });
    const decision = await permission.authorize(request);
    expect(decision.allowed).toBe(false);
    expect(decision.check).toEqual('check' in current ? current.check : undefined);
    expect(decision.approval).toEqual('approval' in current ? current.approval : undefined);
    if ('reason' in current) expect(decision.reason).toBe(current.reason);
  }
});

test('changing business proof changes final binding without changing the independent Tool scope grant', async () => {
  const candidate = {
    ruleId: 'fixture.location',
    contractId: 'fixture.exact-location',
    scope: { path: 'file' },
    bindings: [
      {
        kind: 'tool' as const,
        definitionId: request.definitionId,
        definitionVersion: request.definitionVersion,
      },
    ],
    presentation: { label: 'Exact location', details: ['Current Session only'] },
  };
  const offer = { ...candidate, scopeDigest: grantScopeDigest(candidate) };
  const base = createPermissionPolicy({
    readPolicy: () => ({
      mode: 'full',
      workspaceTrust: true,
      revision: 'base',
      allowed: candidate.bindings,
    }),
    describeCapability: () => ({
      kind: request.kind,
      definitionId: request.definitionId,
      definitionVersion: request.definitionVersion,
      revision: 'fixture-location',
      effects: ['process'],
      safeRead: false,
      hardAllowed: true,
      grantOffers: [offer],
    }),
  });
  let version = 'plan-1';
  const permission = createBusinessPermissionPolicy({
    current: base,
    gate: async () => gate(true, version),
  });
  const original = await base.authorize(request),
    first = await permission.authorize(request);
  expect(first.allowed).toBe(true);
  expect(first.grantOffers).toEqual(original.grantOffers);
  version = 'plan-2';
  const changed = await permission.authorize(request);
  expect(changed.revision).not.toBe(first.revision);
  expect(changed.grantOffers).toEqual(first.grantOffers);
  expect(await permission.reuseRevision!(request, candidate.bindings[0]!, offer, changed)).toEqual({
    reuseRevision: changed.grantOffers![0]!.policyBindings[0]!.reuseRevision,
    requireApproval: false,
  });
});
