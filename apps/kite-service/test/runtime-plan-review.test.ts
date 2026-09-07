import { expect, test } from 'bun:test';
import {
  isRuntimeClientInteraction,
  type RuntimePlanReviewInteraction,
  sameRuntimeClientInteractionIdentity,
} from '@kite-ai/runtime-contract';
import { projectPlanReview } from '../src/runtime-client/plan-review';

test('plan review includes the body and steps, redacts secrets and explicitly bounds long plans', () => {
  const plan = {
    name: 'Change',
    description: 'Acceptance: run the tests. apiKey=private-value',
    status: 'pending' as const,
    steps: [{ step: 'Implement', status: 'pending' as const, note: 'Preserve existing files' }],
  };
  const review = projectPlanReview(plan);
  expect(review.text).toContain('Acceptance: run the tests.');
  expect(review.text).toContain('1. Implement\nPreserve existing files');
  expect(review.text).not.toContain('private-value');
  expect(review.truncated).toBe(false);
  const long = projectPlanReview({ ...plan, description: 'a'.repeat(70_000) });
  expect(long.truncated).toBe(true);
  expect(long.text.length).toBe(65_536);
});

test('review content participates in stable settlement identity and rejects malformed projection', () => {
  const interaction: RuntimePlanReviewInteraction = {
    kind: 'plan_review',
    interactionId: 'review-1',
    sessionRevision: 1,
    plan: { planId: 'plan-1', version: 1, structuralDigest: 'digest-1' },
    review: { text: 'Read this plan', truncated: false },
  };
  expect(isRuntimeClientInteraction(interaction)).toBe(true);
  expect(
    isRuntimeClientInteraction({
      ...interaction,
      review: { text: 'a'.repeat(65_537), truncated: true },
    }),
  ).toBe(false);
  expect(
    isRuntimeClientInteraction({
      ...interaction,
      review: { text: 'text', truncated: false, secret: 'hidden' },
    }),
  ).toBe(false);
  expect(
    sameRuntimeClientInteractionIdentity(interaction, { ...interaction, sessionRevision: 2 }),
  ).toBe(true);
  expect(
    sameRuntimeClientInteractionIdentity(interaction, {
      ...interaction,
      review: { text: 'Another plan', truncated: false },
    }),
  ).toBe(false);
});
