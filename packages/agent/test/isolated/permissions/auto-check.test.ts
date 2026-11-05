import { expect, test } from 'bun:test';
import type {
  AuthorizationRequest,
  PermissionDecision,
  Permissions,
} from '../../../src/extensions';
import {
  createPlanningPermissionPolicy,
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

test('nested parent-child AND and approved Planning preserve equal scopes without dropping either approval requirement', async () => {
  const parentChild = intersectPermissionPolicies(policy(scope), policy(reordered));
  let planScope: Scope = reordered;
  const permission = createPlanningPermissionPolicy({
    required: true,
    run: () => ({ runId: 'r', sessionId: 's' }),
    current: parentChild,
    readState: async () => ({
      status: 'approved',
      mode: 'auto',
      planId: 'plan',
      version: 1,
      digest: 'digest',
    }),
    describe: (actual) => ({
      kind: actual.kind,
      definitionId: actual.definitionId,
      definitionVersion: actual.definitionVersion,
      revision: 'shell',
      effects: ['process'],
      hardAllowed: true,
      safeRead: false,
      autoReview: 'shell_risk',
      autoTimeoutScope: planScope,
    }),
  });
  const result = await permission.authorize(request);
  expect(result.allowed).toBe(false);
  expect(result.check?.timeoutScope).toEqual(scope);
  expect(result.snapshot?.namespace).toBe('builtin.planning.permissions');
  for (const narrowed of [
    undefined,
    { filesystem: 'workspace_write', network: 'internet' },
  ] as const) {
    planScope = narrowed;
    expect((await permission.authorize(request)).check?.timeoutScope).toBeUndefined();
  }
  const human = intersectPermissionPolicies(parentChild, {
    async authorize() {
      return {
        allowed: false,
        revision: 'human',
        approval: { request: 'Independent human approval' },
      };
    },
  });
  expect((await human.authorize(request)).check).toMatchObject({
    timeoutScope: scope,
    requireApproval: true,
  });
});
