import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';

export interface SyntheticConsentRehearsalV1 {
  version: 1;
  consentId: string;
  mode: 'synthetic_rehearsal';
  participantKind: 'synthetic_fixture';
  consentStatus: 'not_applicable_synthetic';
  sessionContentShared: false;
  repositoryContentShared: false;
  recipient: 'none';
  retention: 'none';
  withdrawal: 'not_applicable_synthetic';
  evidenceEligible: false;
}

export interface SyntheticBlindReviewFormV1 {
  version: 1;
  reviewId: string;
  consentId: string;
  reviewerKind: 'synthetic_fixture';
  materialClass: 'synthetic_metadata_only';
  sessionContentIncluded: false;
  repositoryContentIncluded: false;
  diffDigest: `sha256:${string}`;
  checksDigest: `sha256:${string}`;
}

export interface SyntheticHumanResultV1 {
  version: 1;
  reviewId: string;
  humanAccepted: 'not_observed';
  integrated: 'not_observed';
  reverted: 'not_observed';
  trustRating: 'not_observed';
  satisfactionRating: 'not_observed';
  evidenceEligible: false;
}

export interface HumanReviewRehearsalV1 {
  version: 1;
  consent: SyntheticConsentRehearsalV1;
  form: SyntheticBlindReviewFormV1;
  result: SyntheticHumanResultV1;
  status: 'synthetic_rehearsal_only';
  evidenceEligible: false;
  digest: `sha256:${string}`;
}

export function buildSyntheticHumanReviewRehearsal(input: {
  consentId: string;
  reviewId: string;
  diffDigest: `sha256:${string}`;
  checksDigest: `sha256:${string}`;
}): HumanReviewRehearsalV1 {
  const consent: SyntheticConsentRehearsalV1 = {
    version: 1,
    consentId: input.consentId,
    mode: 'synthetic_rehearsal',
    participantKind: 'synthetic_fixture',
    consentStatus: 'not_applicable_synthetic',
    sessionContentShared: false,
    repositoryContentShared: false,
    recipient: 'none',
    retention: 'none',
    withdrawal: 'not_applicable_synthetic',
    evidenceEligible: false,
  };
  const form: SyntheticBlindReviewFormV1 = {
    version: 1,
    reviewId: input.reviewId,
    consentId: input.consentId,
    reviewerKind: 'synthetic_fixture',
    materialClass: 'synthetic_metadata_only',
    sessionContentIncluded: false,
    repositoryContentIncluded: false,
    diffDigest: input.diffDigest,
    checksDigest: input.checksDigest,
  };
  const result: SyntheticHumanResultV1 = {
    version: 1,
    reviewId: input.reviewId,
    humanAccepted: 'not_observed',
    integrated: 'not_observed',
    reverted: 'not_observed',
    trustRating: 'not_observed',
    satisfactionRating: 'not_observed',
    evidenceEligible: false,
  };
  validateSyntheticConsent(consent);
  validateSyntheticReviewForm(form);
  validateSyntheticHumanResult(result);
  const withoutDigest = {
    version: 1 as const,
    consent,
    form,
    result,
    status: 'synthetic_rehearsal_only' as const,
    evidenceEligible: false as const,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

export function validateSyntheticConsent(value: SyntheticConsentRehearsalV1): void {
  exactKeys(value, [
    'consentId',
    'consentStatus',
    'evidenceEligible',
    'mode',
    'participantKind',
    'recipient',
    'repositoryContentShared',
    'retention',
    'sessionContentShared',
    'version',
    'withdrawal',
  ]);
  if (
    value.version !== 1 ||
    !identifier(value.consentId) ||
    value.mode !== 'synthetic_rehearsal' ||
    value.participantKind !== 'synthetic_fixture' ||
    value.consentStatus !== 'not_applicable_synthetic' ||
    value.sessionContentShared !== false ||
    value.repositoryContentShared !== false ||
    value.recipient !== 'none' ||
    value.retention !== 'none' ||
    value.withdrawal !== 'not_applicable_synthetic' ||
    value.evidenceEligible !== false
  ) {
    throw new Error('Synthetic consent rehearsal cannot claim real consent or content sharing.');
  }
}

export function validateSyntheticReviewForm(value: SyntheticBlindReviewFormV1): void {
  exactKeys(value, [
    'checksDigest',
    'consentId',
    'diffDigest',
    'materialClass',
    'repositoryContentIncluded',
    'reviewId',
    'reviewerKind',
    'sessionContentIncluded',
    'version',
  ]);
  if (
    value.version !== 1 ||
    !identifier(value.reviewId) ||
    !identifier(value.consentId) ||
    value.reviewerKind !== 'synthetic_fixture' ||
    value.materialClass !== 'synthetic_metadata_only' ||
    value.sessionContentIncluded !== false ||
    value.repositoryContentIncluded !== false ||
    !digest(value.diffDigest) ||
    !digest(value.checksDigest)
  ) {
    throw new Error('Synthetic blind-review form may contain only digest-bound metadata.');
  }
}

export function validateSyntheticHumanResult(value: SyntheticHumanResultV1): void {
  exactKeys(value, [
    'evidenceEligible',
    'humanAccepted',
    'integrated',
    'reviewId',
    'reverted',
    'satisfactionRating',
    'trustRating',
    'version',
  ]);
  if (
    value.version !== 1 ||
    !identifier(value.reviewId) ||
    value.humanAccepted !== 'not_observed' ||
    value.integrated !== 'not_observed' ||
    value.reverted !== 'not_observed' ||
    value.trustRating !== 'not_observed' ||
    value.satisfactionRating !== 'not_observed' ||
    value.evidenceEligible !== false
  ) {
    throw new Error('Synthetic rehearsal cannot claim human acceptance or product outcomes.');
  }
}

function identifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,255}$/.test(value);
}

function digest(value: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function exactKeys(value: object, expected: string[]): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error('Human-review rehearsal schema has missing or unknown fields.');
  }
}
