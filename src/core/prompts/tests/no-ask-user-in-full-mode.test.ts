import { expect, test } from 'bun:test';
import { createFullModePolicy } from '@/core/policies/mode-policy';

/**
 * Contract: full mode does not request ask_user.
 *
 * In full mode the user has authorized fully autonomous execution. The model must
 * not call ask_user — this is enforced by policy, not just by prompt text.
 *
 * The policy-level test is the authoritative check; prompt text is advisory.
 */
test('full mode policy denies ask_user requests', () => {
  const policy = createFullModePolicy(true);

  // Full mode + building phase → should deny ask_user
  expect(
    policy.shouldAskUser({
      interactionMode: 'full',
      phase: 'building',
      planKind: 'building_without_plan',
    }),
  ).toMatchObject({ kind: 'deny' });
});

test('full mode policy denies ask_user across all phases', () => {
  const policy = createFullModePolicy(true);

  for (const phase of ['planning', 'building'] as const) {
    expect(
      policy.shouldAskUser({
        interactionMode: 'full',
        phase,
        planKind: phase === 'planning' ? 'planning_empty' : 'building_without_plan',
      }),
    ).toMatchObject({ kind: 'deny' });
  }
});

test('full mode policy deny is consistent — ask_user always rejected in full mode', () => {
  // Both sandbox and no-sandbox variants of the full-mode policy reject ask_user.
  // This is by design: full mode means autonomous execution, no human-in-the-loop.
  for (const sandboxAvailable of [true, false]) {
    const policy = createFullModePolicy(sandboxAvailable);
    expect(
      policy.shouldAskUser({
        interactionMode: 'full',
        phase: 'building',
        planKind: 'building_without_plan',
      }),
    ).toMatchObject({ kind: 'deny' });
  }
});
