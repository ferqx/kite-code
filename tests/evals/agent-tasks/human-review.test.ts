import { describe, expect, test } from 'bun:test';
import { digest } from './evaluation-test-fixtures';
import {
  buildSyntheticHumanReviewRehearsal,
  validateSyntheticConsent,
  validateSyntheticHumanResult,
  validateSyntheticReviewForm,
} from './human-review';

describe('synthetic human-review rehearsal contract', () => {
  test('contains only synthetic digest-bound metadata and no human outcome claim', () => {
    const rehearsal = buildSyntheticHumanReviewRehearsal({
      consentId: 'synthetic-consent-v1',
      reviewId: 'synthetic-review-v1',
      diffDigest: digest('diff'),
      checksDigest: digest('checks'),
    });

    expect(rehearsal.status).toBe('synthetic_rehearsal_only');
    expect(rehearsal.evidenceEligible).toBe(false);
    expect(rehearsal.consent.sessionContentShared).toBe(false);
    expect(rehearsal.consent.repositoryContentShared).toBe(false);
    expect(rehearsal.form.materialClass).toBe('synthetic_metadata_only');
    expect(rehearsal.result).toMatchObject({
      humanAccepted: 'not_observed',
      integrated: 'not_observed',
      reverted: 'not_observed',
      trustRating: 'not_observed',
      satisfactionRating: 'not_observed',
    });
    expect(JSON.stringify(rehearsal)).not.toContain('transcript');
  });

  test('rejects fabricated consent, real reviewer material, and human acceptance', () => {
    const rehearsal = buildSyntheticHumanReviewRehearsal({
      consentId: 'synthetic-consent-v1',
      reviewId: 'synthetic-review-v1',
      diffDigest: digest('diff'),
      checksDigest: digest('checks'),
    });
    expect(() =>
      validateSyntheticConsent({ ...rehearsal.consent, sessionContentShared: true } as never),
    ).toThrow('cannot claim real consent');
    expect(() =>
      validateSyntheticReviewForm({
        ...rehearsal.form,
        repositoryContentIncluded: true,
      } as never),
    ).toThrow('only digest-bound metadata');
    expect(() =>
      validateSyntheticHumanResult({
        ...rehearsal.result,
        humanAccepted: true,
      } as never),
    ).toThrow('cannot claim human acceptance');
  });

  test('rejects hidden content or identity fields added to rehearsal records', () => {
    const rehearsal = buildSyntheticHumanReviewRehearsal({
      consentId: 'synthetic-consent-v1',
      reviewId: 'synthetic-review-v1',
      diffDigest: digest('diff'),
      checksDigest: digest('checks'),
    });
    expect(() =>
      validateSyntheticReviewForm({
        ...rehearsal.form,
        reviewerEmail: 'nobody@example.invalid',
      } as never),
    ).toThrow('unknown fields');
  });
});
