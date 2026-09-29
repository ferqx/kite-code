import { expect, test } from 'bun:test';
import type { SubagentGrantBinding } from '@kite-ai/runtime-spi';
import { BuiltinChildRuntimeDriver } from '../src/subagent/child-runtime-driver';
import { SubagentGrantAuthority } from '../src/subagent/grant-authority';
import { LocalSubagentProvider } from '../src/subagent/local-provider';

const digest = (character: string) => character.repeat(64);

function binding(childInvocationId: string): SubagentGrantBinding {
  return {
    parentInvocationId: 'parent',
    parentToolCallId: 'tool',
    parentAttempt: 1,
    capabilityRevision: digest('a'),
    admissionDigest: digest('b'),
    effectiveEffectsDigest: digest('c'),
    childInvocationId,
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
      bindingIds: [],
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
    cancellationCorrelation: 'tool',
    model: { parentModelInvocationId: 'model', parentToolCallId: 'tool' },
  };
}

test('consumed grant ledger admits more than 4096 children while still rejecting replay', () => {
  let nextGrant = 0;
  const authority = new SubagentGrantAuthority({
    now: () => 1_000,
    idSource: () => `grant-${++nextGrant}`,
  });
  let firstGrant: ReturnType<typeof authority.issueStart> | undefined;
  for (let index = 0; index < 4_097; index += 1) {
    const grant = authority.issueStart(binding(`child-${index}`));
    firstGrant ??= grant;
    expect(authority.verifier().verifyAndConsumeStart(grant).grantId).toBe(grant.grantId);
  }
  if (!firstGrant) throw new Error('First grant was not issued.');
  expect(() => authority.verifier().verifyAndConsumeStart(firstGrant)).toThrow(
    expect.objectContaining({ code: 'consumed_grant' }),
  );
});

test('pending driver registrations exceed 256 without losing exact identities', () => {
  const driver = new BuiltinChildRuntimeDriver({ now: () => 1_000 });
  for (let index = 0; index < 257; index += 1) {
    driver.registerStart(`grant-${index}`, {
      childInvocationId: `child-${index}`,
      parentInvocationId: 'parent',
      parentToolCallId: 'tool',
      parentAttempt: 1,
      run: async () => ({
        childInvocationId: `child-${index}`,
        status: 'completed',
        summary: 'done',
        toolCallCount: 0,
        durationMs: 1,
        privatePayload: {},
      }),
    });
  }
  expect(driver.pendingRegistrationCount()).toBe(257);
});

test('Provider keeps recovery evidence after more than 1024 child completions', async () => {
  let nextGrant = 0;
  let nextHandle = 0;
  const authority = new SubagentGrantAuthority({
    now: () => 1_000,
    idSource: () => `grant-${++nextGrant}`,
  });
  const provider = new LocalSubagentProvider(
    authority.verifier(),
    {
      start: async (grant) => ({
        childInvocationId: grant.childInvocationId,
        status: 'completed',
        summary: 'done',
        toolCallCount: 0,
        durationMs: 1,
        privatePayload: {},
      }),
      resume: async () => {
        throw new Error('Unexpected resume.');
      },
      abandon: () => true,
    },
    { read: () => ({ task: 'Inspect.' }) },
    () => `handle-${++nextHandle}`,
    3_000,
    { now: () => 1_000 },
  );
  let firstHandle: Awaited<ReturnType<typeof provider.start>> | undefined;
  for (let index = 0; index < 1_025; index += 1) {
    const prepared = await provider.start({
      grant: authority.issueStart(binding(`child-${index}`)),
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) throw new Error('Child was not prepared.');
    firstHandle ??= prepared;
    expect((await provider.activate({ handle: prepared.value })).ok).toBe(true);
    expect((await provider.observe({ handle: prepared.value })).ok).toBe(true);
  }
  if (!firstHandle?.ok) throw new Error('First child was not prepared.');
  expect(await provider.reconcile({ handle: firstHandle.value })).toMatchObject({
    ok: true,
    value: { status: 'stopped', cleanupConfirmed: true },
  });
  expect(await provider.observe({ handle: firstHandle.value })).toMatchObject({
    ok: false,
    failure: { code: 'stale_handle' },
  });
});
