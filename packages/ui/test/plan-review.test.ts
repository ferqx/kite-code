import { expect, test } from 'bun:test';
import type { Interaction } from '@kite-ai/client';
import { describePlanReview, PlanReviewPanel, serializePlanReviewAnswer } from '../src';

const request = {
  planId: 'plan-a',
  version: 'v2',
  digest: 'original-digest',
  content: 'Full exact plan\n1. inspect',
  allowedModes: ['auto', 'accept_edits'],
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
test('plan projection preserves exact identity/body and unavailable metadata or unsupported modes remain read only', () => {
  expect(describePlanReview(request)).toMatchObject({
    kind: 'supported',
    planId: 'plan-a',
    version: 'v2',
    digest: 'original-digest',
    content: request.content,
    allowedModes: ['auto', 'accept_edits'],
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
test('approve requires an explicitly offered supported mode, feedback is bounded and deny/revise grant no mode', () => {
  expect(() => serializePlanReviewAnswer(request, 'approve')).toThrow(
    'explicit_plan_mode_required',
  );
  expect(() => serializePlanReviewAnswer(request, 'approve', '', 'full')).toThrow(
    'explicit_plan_mode_required',
  );
  for (const mode of ['auto', 'accept_edits'])
    expect(serializePlanReviewAnswer(request, 'approve', 'reviewed', mode)).toEqual({
      kind: 'plan_review',
      decision: 'approve',
      feedback: 'reviewed',
      mode,
    });
  expect(serializePlanReviewAnswer(request, 'deny', 'reason', 'auto')).toEqual({
    kind: 'plan_review',
    decision: 'deny',
    feedback: 'reason',
  });
  expect(serializePlanReviewAnswer(request, 'revise', 'change step')).toEqual({
    kind: 'plan_review',
    decision: 'revise',
    feedback: 'change step',
  });
  expect(() => serializePlanReviewAnswer(request, 'revise', 'x'.repeat(8193))).toThrow(
    'feedback_too_long',
  );
  expect(serializePlanReviewAnswer(request, 'revise', 'x'.repeat(8192)).feedback).toHaveLength(
    8192,
  );
  expect(() =>
    serializePlanReviewAnswer(
      { ...request, allowedModes: ['accept_edits'] },
      'approve',
      '',
      'auto',
    ),
  ).toThrow('explicit_plan_mode_required');
});
