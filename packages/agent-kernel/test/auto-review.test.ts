import { describe, expect, test } from 'bun:test';
import {
  type AutoReviewFactsV1,
  decideAutoReviewV1,
  isValidAutoReviewFactsV1,
} from '../src/auto-review';

function facts(overrides: Partial<AutoReviewFactsV1> = {}): AutoReviewFactsV1 {
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
  test('accepts only an operation-bound approve_once or same_command grant', () => {
    expect(decideAutoReviewV1(facts())).toEqual({
      kind: 'accepted_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      grant: 'approve_once',
    });
    expect(
      decideAutoReviewV1(facts({ grant: 'same_command', reason: 'same command is bounded' })),
    ).toEqual({
      kind: 'accepted_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      grant: 'same_command',
      reason: 'same command is bounded',
    });
  });

  test('escalates an explicit reviewer rejection to user approval', () => {
    const result = decideAutoReviewV1(
      facts({ approved: false, reason: 'the command is broader than the task' }),
    );
    expect(result).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'the command is broader than the task',
    });
  });

  test('escalates technical and invalid reviewer responses', () => {
    expect(
      decideAutoReviewV1(
        facts({ ok: false, approved: false, failureType: 'technical', reason: 'provider failed' }),
      ),
    ).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'provider failed',
      failureType: 'technical',
    });
    expect(decideAutoReviewV1({ reviewId: 'review-1', toolCallId: 'tool-1' })).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'Auto-review facts are malformed; user approval is required.',
      failureType: 'invalid_response',
    });
  });

  test('never turns full_access or an omitted grant into automatic approval', () => {
    expect(decideAutoReviewV1(facts({ grant: 'full_access' }))).toMatchObject({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      failureType: 'invalid_response',
    });
    expect(decideAutoReviewV1(facts({ grant: undefined }))).toMatchObject({
      kind: 'request_user_approval',
      failureType: 'invalid_response',
    });
    expect(
      decideAutoReviewV1(
        facts({ failureType: 'technical', reason: 'contradictory reviewer facts' }),
      ),
    ).toEqual({
      kind: 'request_user_approval',
      reviewId: 'review-1',
      toolCallId: 'tool-1',
      reason: 'contradictory reviewer facts',
      failureType: 'invalid_response',
    });
  });

  test('rejects non-canonical facts and keeps the decision immutable', () => {
    expect(isValidAutoReviewFactsV1(facts())).toBe(true);
    expect(isValidAutoReviewFactsV1({ ...facts(), unexpected: true })).toBe(false);
    expect(isValidAutoReviewFactsV1(Object.create({ ...facts() }))).toBe(false);

    const result = decideAutoReviewV1(facts());
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      (result as { grant: string }).grant = 'full_access';
    }).toThrow();
  });

  test('is deterministic and does not mutate supplied facts', () => {
    const input = facts({ reason: 'stable' });
    const before = JSON.stringify(input);
    const first = decideAutoReviewV1(input);
    const second = decideAutoReviewV1(input);
    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(before);
  });
});
