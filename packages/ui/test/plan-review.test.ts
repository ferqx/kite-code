import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { describePlanReview, PlanReviewPanel, serializePlanReviewAnswer } from '../src';

const request = {
  planId: 'plan-a',
  version: 'v2',
  digest: 'original-digest',
  content: 'Full exact plan\n1. inspect',
};
const interaction: Interaction = {
  id: 'i',
  originStoreId: 'store',
  sessionId: 'child',
  presentationSessionId: 'root',
  ancestry: ['root', 'child'],
  runId: 'r',
  executionId: 'e',
  attempt: 2,
  kind: 'plan_review',
  definitionId: 'fixture.plan',
  definitionVersion: '1',
  inputDigest: 'input',
  policyRevision: 'policy',
  requiredRefs: [],
  request,
  answer: null,
  revision: '5',
  acceptedDecisionRevision: null,
  state: 'pending',
};
test('plan projection preserves exact identity/body and unavailable metadata or legacy mode requests remain read only', () => {
  expect(describePlanReview(request)).toMatchObject({
    kind: 'supported',
    planId: 'plan-a',
    version: 'v2',
    digest: 'original-digest',
    content: request.content,
  });
  const text = JSON.stringify(PlanReviewPanel({ interaction, disabled: false }));
  expect(text).toContain('Full exact plan');
  expect(text).toContain('original-digest');
  expect(text).toContain('Read only');
  expect(describePlanReview({ ...request, allowedModes: ['auto', 'full'] })).toMatchObject({
    kind: 'readonly',
  });
  expect(describePlanReview({ ...request, version: null })).toMatchObject({ kind: 'readonly' });
  expect(describePlanReview({})).toMatchObject({ kind: 'readonly' });
});
test('plan decisions do not select tool permissions and preserve bounded feedback', () => {
  expect(serializePlanReviewAnswer(request, 'approve')).toEqual({
    kind: 'plan_review',
    decision: 'approve',
  });
  for (const decision of ['approve', 'deny', 'revise'] as const)
    expect(serializePlanReviewAnswer(request, decision, 'reviewed')).toEqual({
      kind: 'plan_review',
      decision,
      feedback: 'reviewed',
    });
  expect(() => serializePlanReviewAnswer(request, 'revise', 'x'.repeat(8193))).toThrow(
    'feedback_too_long',
  );
  expect(serializePlanReviewAnswer(request, 'revise', 'x'.repeat(8192)).feedback).toHaveLength(
    8192,
  );
  expect(() =>
    serializePlanReviewAnswer({ ...request, allowedModes: ['auto', 'accept_edits'] }, 'approve'),
  ).toThrow('plan_review_readonly');
});
