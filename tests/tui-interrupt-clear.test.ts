import { describe, expect, test } from 'bun:test';
import { shouldCancelClearedInterrupt } from '../src/app/tui/interrupt-clear';
import type { InterruptState } from '../src/app/tui/types';

describe('TUI interrupt clear handling', () => {
  const approvalInterrupt: InterruptState = { kind: 'approval', blockId: 1 };
  const inputInterrupt: InterruptState = { kind: 'input', blockId: 1 };
  const planReviewInterrupt: InterruptState = {
    kind: 'plan_review',
    plan: {
      name: 'Plan',
      description: 'Review',
      status: 'pending',
      steps: [{ step: 'Check', status: 'pending' }],
    },
  };

  test.each([
    ['approval', approvalInterrupt],
    ['input', inputInterrupt],
    ['plan_review', planReviewInterrupt],
  ] as const)('does not submit cancel when %s was cleared by a submitted action', (_, interrupt) => {
    expect(shouldCancelClearedInterrupt(interrupt, null, true)).toBe(false);
  });

  test('submits cancel when an interrupt disappears without an explicit resolution', () => {
    expect(shouldCancelClearedInterrupt(inputInterrupt, null, false)).toBe(true);
  });

  test('does not submit cancel while replacing one interrupt with another', () => {
    expect(shouldCancelClearedInterrupt(inputInterrupt, planReviewInterrupt, false)).toBe(false);
  });
});
