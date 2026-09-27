import { expect, test } from 'bun:test';
import {
  LocalSubagentProvider,
  SubagentGrantAuthority,
  SubagentGrantError,
} from '@kite-ai/builtin-runtime/subagent';
import type { SubagentGrantBinding } from '@kite-ai/runtime-spi';

const digest = (character: string) => character.repeat(64);

function binding(): SubagentGrantBinding {
  return {
    parentInvocationId: 'parent-invocation',
    parentToolCallId: 'parent-tool',
    parentAttempt: 1,
    capabilityRevision: digest('a'),
    admissionDigest: digest('b'),
    effectiveEffectsDigest: digest('c'),
    childInvocationId: 'child-invocation',
    role: 'review',
    taskArtifact: {
      artifactId: `pa_${digest('d')}`,
      kind: 'subagent_task',
      integrityIdentifier: `sha256:${digest('e')}`,
      byteLength: 100,
    },
    taskDigest: `sha256:${digest('f')}`,
    capabilityCeiling: {
      allowedTools: ['read_file'],
      bindingIds: ['binding-1'],
      bindingRevision: digest('1'),
      ceilingDigest: digest('2'),
    },
    authorization: {
      authorizationDigest: digest('3'),
      interactionMode: 'accept_edits',
      phase: 'building',
      workspaceAccess: 'write',
    },
    executionBoundary: {
      canonicalWorkspace: '/workspace',
      executionBoundaryDigest: `sha256:${digest('4')}`,
    },
    resource: { parentReservationId: null, budgetDigest: digest('5') },
    cancellationCorrelation: 'parent-tool',
    model: { parentModelInvocationId: 'parent-model', parentToolCallId: 'parent-tool' },
  };
}

function errorCode(action: () => unknown): SubagentGrantError['code'] | undefined {
  try {
    action();
  } catch (error) {
    if (error instanceof SubagentGrantError) return error.code;
    throw error;
  }
  return undefined;
}

test('repeatable inspect preserves the single Provider start authorization', async () => {
  const now = 1_000;
  const authority = new SubagentGrantAuthority({ now: () => now, idSource: () => 'grant-1' });
  const grant = authority.issueStart(binding());
  expect(authority.inspectStart(grant)).toEqual(grant);
  expect(authority.inspectStart(grant)).toEqual(grant);
  expect(Object.isFrozen(authority.inspectStart(grant))).toBe(true);

  let childStarts = 0;
  let nextId = 0;
  const provider = new LocalSubagentProvider(
    authority.verifier(),
    {
      start: async () => {
        childStarts += 1;
        return {
          childInvocationId: grant.childInvocationId,
          status: 'completed',
          summary: 'done',
          toolCallCount: 0,
          durationMs: 1,
          privatePayload: {},
        };
      },
      resume: async () => {
        throw new Error('Unexpected resume.');
      },
      abandon: () => true,
    },
    { read: () => ({ task: 'Inspect once.' }) },
    () => `local-${++nextId}`,
    3_000,
    { now: () => now },
  );
  const prepared = await provider.start({ grant });
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error('Start grant was not accepted.');
  expect(errorCode(() => authority.inspectStart(grant))).toBe('consumed_grant');
  expect(authority.inspectActivatedStart(grant)).toEqual(grant);
  const second = await provider.start({ grant });
  expect(second).toMatchObject({ ok: false, failure: { code: 'consumed_grant' } });
  expect(childStarts).toBe(0);
  expect(await provider.activate({ handle: prepared.value })).toMatchObject({ ok: true });
  expect(childStarts).toBe(1);
});

test('inspect rejects expired and tampered grants without creating a consumed tombstone', () => {
  let now = 1_000;
  const authority = new SubagentGrantAuthority({ now: () => now, idSource: () => 'grant-2' });
  const grant = authority.issueStart(binding());
  expect(errorCode(() => authority.inspectStart({ ...grant, role: 'code' }))).toBe('invalid_grant');
  expect(
    errorCode(() =>
      authority.inspectStart({
        ...grant,
        capabilityCeiling: { ...grant.capabilityCeiling, allowedTools: ['write_file'] },
      }),
    ),
  ).toBe('invalid_grant');
  expect(errorCode(() => authority.inspectStart({ ...grant, seal: `sha256:${digest('0')}` }))).toBe(
    'invalid_grant',
  );
  expect(authority.inspectStart(grant)).toEqual(grant);
  now = grant.expiresAtMs;
  expect(errorCode(() => authority.inspectStart(grant))).toBe('expired_grant');
  expect(authority.inspectActivatedStart(grant)).toEqual(grant);
  expect(errorCode(() => authority.inspectActivatedStart({ ...grant, role: 'code' }))).toBe(
    'invalid_grant',
  );
  expect(errorCode(() => authority.verifier().verifyAndConsumeStart(grant))).toBe('expired_grant');
});
