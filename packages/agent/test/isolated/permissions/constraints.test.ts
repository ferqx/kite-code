import { expect, test } from 'bun:test';
import type { PlanningState } from '../../../src/business/planning';
import type { AuthorizationRequest } from '../../../src/extensions';
import {
  type CapabilityDescription,
  createPermissionPolicy,
  createPlanningPermissionPolicy,
  type PermissionPolicySnapshot,
} from '../../../src/permissions';

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
function externalDescription(policy?: Readonly<PermissionPolicySnapshot>): CapabilityDescription {
  return {
    kind: request.kind,
    definitionId: request.definitionId,
    definitionVersion: request.definitionVersion,
    revision: 'files-external',
    effects: ['external'],
    safeRead: false,
    hardAllowed: policy?.mode === 'full',
    ...(policy?.mode === 'full' ? {} : { denialReason: 'file_external_write_requires_full' }),
  };
}
function current(mode: PermissionPolicySnapshot['mode'] = 'full') {
  return createPermissionPolicy({
    readPolicy: () => ({
      mode,
      workspaceTrust: true,
      revision: `current-${mode}`,
      allowed: [
        {
          kind: request.kind,
          definitionId: request.definitionId,
          definitionVersion: request.definitionVersion,
        },
      ],
    }),
    describeCapability: (_request, policy) => externalDescription(policy),
  });
}

test('planning preapproval classification has no Full policy to infer external authority', async () => {
  const seen: (PermissionPolicySnapshot['mode'] | undefined)[] = [];
  const permission = createPlanningPermissionPolicy({
    required: true,
    run: () => ({ runId: 'r', sessionId: 's' }),
    current: current(),
    readState: async () => ({ status: 'pending' }),
    describe: (_request, policy) => {
      seen.push(policy?.mode);
      return externalDescription(policy);
    },
  });
  expect(await permission.authorize(request)).toMatchObject({
    allowed: false,
    reason: 'plan_approval_required',
  });
  expect(seen).toEqual([undefined]);
});

test('approved planning ceilings receive their own mode and keep Full current policy narrowed', async () => {
  for (const mode of ['auto', 'accept_edits'] as const) {
    const seen: (PermissionPolicySnapshot['mode'] | undefined)[] = [];
    let stateReads = 0;
    const state: PlanningState = {
      status: 'approved',
      mode,
      planId: 'p',
      version: 1,
      digest: 'approved',
    };
    const permission = createPlanningPermissionPolicy({
      required: true,
      run: () => ({ runId: 'r', sessionId: 's' }),
      current: current(),
      readState: async () => {
        stateReads++;
        return state;
      },
      describe: (_request, policy) => {
        seen.push(policy?.mode);
        return externalDescription(policy);
      },
    });
    expect(await permission.authorize(request)).toMatchObject({
      allowed: false,
      reason: 'file_external_write_requires_full',
      snapshot: { data: { current: { data: { mode: 'full' } }, ceiling: { data: { mode } } } },
    });
    expect(seen).toEqual([undefined, mode]);
    expect(stateReads).toBe(1);
  }
});

test('disabled planning retains current permission without capability reclassification', async () => {
  const permission = createPlanningPermissionPolicy({
    required: false,
    run: () => undefined,
    current: current(),
    readState: async () => {
      throw Error('must not read');
    },
    describe: () => {
      throw Error('must not reclassify');
    },
  });
  expect(await permission.authorize(request)).toMatchObject({
    allowed: true,
    snapshot: { data: { mode: 'full' } },
  });
});
