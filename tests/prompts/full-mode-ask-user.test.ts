import { expect, test } from 'bun:test';
import { createFullModePolicy } from '@/core/policies/mode-policy';

test('full mode allows ask_user across planning and building phases', () => {
  for (const sandboxAvailable of [true, false]) {
    const policy = createFullModePolicy(sandboxAvailable);
    for (const phase of ['planning', 'building'] as const) {
      expect(
        policy.shouldAskUser({
          interactionMode: 'full',
          phase,
          planKind: phase === 'planning' ? 'planning_empty' : 'building_without_plan',
        }),
      ).toMatchObject({ kind: 'allow' });
    }
  }
});
