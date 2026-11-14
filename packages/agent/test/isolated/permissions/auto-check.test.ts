import { expect, test } from 'bun:test';
import type {
  AuthorizationRequest,
  PermissionDecision,
  Permissions,
} from '../../../src/extensions';
import {
  createBusinessPermissionPolicy,
  intersectPermissionPolicies,
} from '../../../src/permissions';
import { autoCheckOptions } from '../../../src/permissions/auto-check';

type Scope = NonNullable<PermissionDecision['check']>['timeoutScope'];
const scope: Scope = { filesystem: 'workspace_write', network: 'none' };
const reordered: Scope = { network: 'none', filesystem: 'workspace_write' };
const request: AuthorizationRequest = {
  kind: 'tool',
  sessionId: 's',
  runId: 'r',
  executionId: 'e',
  definitionId: 'shell.execute',
  definitionVersion: '1',
  input: { command: 'printf test' },
  signal: new AbortController().signal,
};
const policy = (timeoutScope: Scope): Permissions => ({
  async authorize() {
    return {
      allowed: false,
      revision: 'auto',
      check: {
        request: { reviewPurpose: 'shell_risk' },
        ...(timeoutScope ? { timeoutScope } : {}),
      },
    };
  },
});

test('equal finite timeout scopes survive policy AND independently of object key order', async () => {
  const result = await intersectPermissionPolicies(policy(scope), policy(reordered)).authorize(
    request,
  );
  expect(result.check?.timeoutScope).toEqual(scope);
  expect(result.check?.requireApproval).toBe(false);
  expect(
    autoCheckOptions([
      { request: null, timeoutScope: 'governed' },
      { request: null, timeoutScope: 'governed' },
    ]).timeoutScope,
  ).toBe('governed');
});

test('missing or different AND scopes cannot inherit another policy timeout capability', async () => {
  for (const other of [
    undefined,
    'governed',
    { filesystem: 'full_access', network: 'none' },
    { filesystem: 'workspace_write', network: 'internet' },
  ] as const) {
    const result = await intersectPermissionPolicies(policy(scope), policy(other)).authorize(
      request,
    );
    expect(result.allowed).toBe(false);
    expect(result.check?.timeoutScope).toBeUndefined();
  }
  expect(autoCheckOptions([])).toEqual({});
});

test('a fail-closed timeout survives mixed policy checks in either order', async () => {
  const stop: Permissions = {
    authorize: async () => ({
      allowed: false,
      revision: 'required-risk-review',
      check: { request: null, stopOnTimeout: true },
    }),
  };
  for (const [left, right] of [
    [stop, policy(scope)],
    [policy(scope), stop],
  ] as const) {
    const result = await intersectPermissionPolicies(left, right).authorize(request);
    expect(result.allowed).toBe(false);
    expect(result.check?.stopOnTimeout).toBe(true);
    expect(result.check?.timeoutScope).toBeUndefined();
  }
});

test('a domain interpreter is preserved only when every actual checker selects the same complete binding', async () => {
  const behavior = {
    capability: { kind: 'tool' as const, definitionId: 'fixture.tool', definitionVersion: '1' },
    contractRef: 'fixture.review',
    configurationDigest: 'a'.repeat(64),
  };
  const checked = (binding: typeof behavior | undefined): Permissions => ({
    authorize: async () => ({
      allowed: false,
      revision: 'checker',
      check: { request: { kind: 'fixture' }, ...(binding ? { behavior: binding } : {}) },
    }),
  });
  const agreed = await intersectPermissionPolicies(
    checked(behavior),
    checked(structuredClone(behavior)),
  ).authorize(request);
  expect(agreed.check!.behavior).toEqual(behavior);
  for (const other of [
    undefined,
    { ...behavior, contractRef: 'independent.review' },
    { ...behavior, configurationDigest: 'b'.repeat(64) },
  ]) {
    const combined = await intersectPermissionPolicies(checked(behavior), checked(other)).authorize(
      request,
    );
    expect(combined.check!.behavior).toBeUndefined();
    expect(combined.check!.request).toEqual({
      policies: [{ kind: 'fixture' }, { kind: 'fixture' }],
    });
  }
  const independent = await intersectPermissionPolicies(checked(behavior), {
    authorize: async () => ({
      allowed: false,
      revision: 'independent-human',
      check: { request: null, requireApproval: true },
    }),
  }).authorize(request);
  expect(independent.check!.behavior).toBeUndefined();
  expect(independent.check!.requireApproval).toBe(true);
});

test('a business gate preserves parent-child timeout scopes and their original approval requirement', async () => {
  const parentChild = intersectPermissionPolicies(policy(scope), policy(reordered));
  const permission = createBusinessPermissionPolicy({
    current: parentChild,
    gate: async () => ({ allowed: true, revision: 'approved-business' }),
  });
  const result = await permission.authorize(request);
  expect(result.allowed).toBe(false);
  expect(result.check).toEqual((await parentChild.authorize(request)).check);
  expect(result.check?.timeoutScope).toEqual(scope);
  expect(result.snapshot?.namespace).toBe('builtin.business.permissions');
});
