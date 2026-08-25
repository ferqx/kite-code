import { describe, expect, test } from 'bun:test';
import { type AutoReviewFacts, decideAutoReview, isValidAutoReviewFacts } from '../src/auto-review';

function facts(overrides: Partial<AutoReviewFacts> = {}): AutoReviewFacts {
  return {
    reviewId: 'review-1',
    toolCallId: 'tool-1',
    ok: true,
    approved: true,
    grant: 'approve_once',
    ...overrides,
  };
}

describe('State auto-review completion authority', () => {
  test('accepts only the operation-bound approve_once grant', () => {
    expect(decideAutoReview(facts())).toEqual({
      kind: 'accepted_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      grant: 'approve_once',
    });
  });

  test('distinguishes a reviewer rejection from an explicit user-approval escalation', () => {
    const result = decideAutoReview(
      facts({ approved: false, reason: 'the command is broader than the task' }),
    );
    expect(result).toEqual({
      kind: 'rejected',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'the command is broader than the task',
    });
    expect(
      decideAutoReview(
        facts({
          approved: false,
          requiresUserApproval: true,
          reason: 'user intent is required',
        }),
      ),
    ).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'user intent is required',
    });
  });

  test('escalates technical and invalid reviewer responses', () => {
    expect(
      decideAutoReview(
        facts({ ok: false, approved: false, failureType: 'technical', reason: 'provider failed' }),
      ),
    ).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'provider failed',
      failureType: 'technical',
    });
    expect(decideAutoReview({ reviewId: 'review-1', toolCallId: 'tool-1' })).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'Auto-review facts are malformed; user approval is required.',
      failureType: 'invalid_response',
    });
  });

  test('fails closed for same_command, full_access, and legacy reviewer output shapes', () => {
    expect(decideAutoReview(facts({ grant: 'same_command' } as never))).toMatchObject({
      kind: 'request_user_approval',
      toolCallId: 'tool-1',
      failureType: 'invalid_response',
    });
    expect(decideAutoReview(facts({ grant: 'full_access' } as never))).toMatchObject({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      failureType: 'invalid_response',
    });
    expect(decideAutoReview({ kind: 'approve', approved: true, grant: 'approve_once' })).toEqual({
      kind: 'request_user_approval',
      failureType: 'invalid_response',
      reason: 'Auto-review facts are malformed; user approval is required.',
    });
    expect(decideAutoReview(facts({ grant: undefined }))).toMatchObject({
      kind: 'request_user_approval',
      failureType: 'invalid_response',
    });
    expect(
      decideAutoReview(facts({ failureType: 'technical', reason: 'contradictory reviewer facts' })),
    ).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'contradictory reviewer facts',
      failureType: 'invalid_response',
    });
    expect(
      decideAutoReview(
        facts({
          approved: false,
          failureType: 'technical',
          reason: 'contradictory rejection facts',
        }),
      ),
    ).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'contradictory rejection facts',
      failureType: 'invalid_response',
    });
  });

  test('rejects non-canonical facts and keeps the decision immutable', () => {
    expect(isValidAutoReviewFacts(facts())).toBe(true);
    expect(isValidAutoReviewFacts({ ...facts(), unexpected: true })).toBe(false);
    expect(isValidAutoReviewFacts(Object.create({ ...facts() }))).toBe(false);

    const result = decideAutoReview(facts());
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { grant: string }).grant = 'full_access';
    }).toThrow();
  });

  test('is deterministic and does not mutate supplied facts', () => {
    const input = facts({ reason: 'stable' });
    const before = JSON.stringify(input);
    const first = decideAutoReview(input);
    const second = decideAutoReview(input);
    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(before);
  });
});
