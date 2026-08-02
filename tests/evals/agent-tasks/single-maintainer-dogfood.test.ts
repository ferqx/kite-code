import { describe, expect, test } from 'bun:test';
import { sha256Digest } from '../../../scripts/release/canonical-json';
import {
  buildCurrentSingleMaintainerDogfoodBoundaryV1,
  buildExternalProductParticipantV1,
  buildInternalDogfoodAcceptanceV1,
  type ExternalProductParticipantRecordV1,
  evaluateExternalProductSampleV1,
  SINGLE_MAINTAINER_IDENTITY_V1,
  validateInternalDogfoodAcceptanceV1,
  verifyCurrentSingleMaintainerDogfoodBoundaryV1,
} from './single-maintainer-dogfood';

const EVALUATED_AT = '2026-08-02T12:00:00.000Z';
const AUTHORIZED_AT = '2026-08-02T08:00:00.000Z';
const OBSERVED_AT = '2026-08-02T10:00:00.000Z';

function digest(label: string): `sha256:${string}` {
  return sha256Digest(label);
}

function authorization() {
  return {
    'authorized-task': {
      authorizationDigest: digest('authorized-task'),
      authorizedAt: AUTHORIZED_AT,
    },
  };
}

function participant(index: number, options: { tasks?: number; withdrawn?: boolean } = {}) {
  const withdrawn = options.withdrawn ?? false;
  return buildExternalProductParticipantV1({
    version: 1,
    participantIdentityDigest: digest(`external-participant-${index}`),
    consent: {
      consentId: `consent-${index}`,
      status: withdrawn ? 'withdrawn' : 'opted_in',
      consentedAt: '2026-08-02T08:00:00.000Z',
      withdrawalAvailable: true,
      withdrawnAt: withdrawn ? '2026-08-02T11:00:00.000Z' : null,
    },
    tasks: Array.from({ length: options.tasks ?? 4 }, (_, taskIndex) => ({
      taskId: `task-${index}-${taskIndex}`,
      observedAt: '2026-08-02T10:00:00.000Z',
      outcome: 'accepted' as const,
      runDigest: digest(`run-${index}-${taskIndex}`),
      diffDigest: digest(`diff-${index}-${taskIndex}`),
      checksDigest: digest(`checks-${index}-${taskIndex}`),
    })),
    evaluatedAt: EVALUATED_AT,
  });
}

describe('single-maintainer dogfood and external evidence boundary', () => {
  test('keeps the current repository state blocked/not_observed with zero fabricated outcomes', () => {
    const boundary = buildCurrentSingleMaintainerDogfoodBoundaryV1({
      evaluatedAt: EVALUATED_AT,
      suiteDigest: digest('suite'),
    });
    verifyCurrentSingleMaintainerDogfoodBoundaryV1(boundary);
    expect(boundary).toMatchObject({
      decision: { id: 'D-07', status: 'closed', owner: 'github:@ferqx' },
      internalDogfood: {
        acceptance: 'not_observed',
        externalCohortEligible: false,
        independentThirdPartySecurityReviewEligible: false,
      },
      externalProductSample: {
        status: 'blocked',
        outcome: 'not_observed',
        evidenceEligible: false,
        participantCount: 0,
        qualifyingParticipantCount: 0,
        independentThirdPartySecurityReview: 'not_observed',
        releaseBundle: { transcriptContentIncluded: false, participantRecordDigests: [] },
      },
      releaseEligible: false,
    });
    expect(boundary.externalProductSample.reasonCodes).toEqual([
      'authenticated_external_evidence_not_configured',
      'external_consent_not_observed',
      'external_participant_minimum_not_met',
      'external_product_outcomes_not_observed',
      'external_task_minimum_not_met',
      'independent_security_review_not_observed',
      'single_maintainer_not_external',
    ]);
  });

  test('allows github:@ferqx to record real internal acceptance only for authorized tasks', () => {
    const authorizedTasks = authorization();
    const record = buildInternalDogfoodAcceptanceV1({
      version: 1,
      producerIdentity: SINGLE_MAINTAINER_IDENTITY_V1,
      taskId: 'authorized-task',
      authorizationDigest: authorizedTasks['authorized-task'].authorizationDigest,
      observedAt: OBSERVED_AT,
      outcome: 'accepted',
      suiteDigest: digest('suite'),
      runDigest: digest('run'),
      diffDigest: digest('diff'),
      checksDigest: digest('checks'),
      authorizedTasks,
      evaluatedAt: EVALUATED_AT,
    });
    validateInternalDogfoodAcceptanceV1(record, { authorizedTasks, evaluatedAt: EVALUATED_AT });
    expect(record).toMatchObject({
      evidenceClass: 'internal_single_maintainer_dogfood',
      producerIdentity: 'github:@ferqx',
      outcome: 'accepted',
      materialClass: 'digest_bound_metadata_only',
      transcriptContentIncluded: false,
      externalCohortEligible: false,
      independentThirdPartySecurityReviewEligible: false,
    });
    expect(record.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('rejects unauthorized, forged, stale, content-bearing, or unknown internal metadata', () => {
    const authorizedTasks = authorization();
    const base = {
      version: 1 as const,
      producerIdentity: SINGLE_MAINTAINER_IDENTITY_V1,
      taskId: 'authorized-task',
      authorizationDigest: authorizedTasks['authorized-task'].authorizationDigest,
      observedAt: OBSERVED_AT,
      outcome: 'accepted' as const,
      suiteDigest: digest('suite'),
      runDigest: digest('run'),
      diffDigest: digest('diff'),
      checksDigest: digest('checks'),
      authorizedTasks,
      evaluatedAt: EVALUATED_AT,
    };
    expect(() =>
      buildInternalDogfoodAcceptanceV1({ ...base, taskId: 'unauthorized-task' }),
    ).toThrow('not explicitly authorized');
    expect(() =>
      buildInternalDogfoodAcceptanceV1({
        ...base,
        producerIdentity: 'github:@someone-else' as typeof SINGLE_MAINTAINER_IDENTITY_V1,
      }),
    ).toThrow('identity or boundary is invalid');
    expect(() =>
      buildInternalDogfoodAcceptanceV1({ ...base, observedAt: '2026-08-03T00:00:00.000Z' }),
    ).toThrow('not monotonic');

    const record = buildInternalDogfoodAcceptanceV1(base);
    expect(() =>
      validateInternalDogfoodAcceptanceV1({ ...record, transcriptContentIncluded: true } as never, {
        authorizedTasks,
        evaluatedAt: EVALUATED_AT,
      }),
    ).toThrow('identity or boundary is invalid');
    expect(() =>
      validateInternalDogfoodAcceptanceV1({ ...record, transcript: 'secret content' } as never, {
        authorizedTasks,
        evaluatedAt: EVALUATED_AT,
      }),
    ).toThrow('missing or unknown fields');
    expect(() =>
      validateInternalDogfoodAcceptanceV1(
        { ...record, runDigest: digest('forged') },
        { authorizedTasks, evaluatedAt: EVALUATED_AT },
      ),
    ).toThrow('digest does not match');
  });

  test('keeps a locally constructed qualifying population contract-only and non-evidence', () => {
    const participants = [participant(1), participant(2), participant(3)];
    const result = evaluateExternalProductSampleV1({
      version: 1,
      participants,
      evaluatedAt: EVALUATED_AT,
      suiteDigest: digest('suite'),
    });
    expect(result).toMatchObject({
      status: 'blocked',
      outcome: 'not_observed',
      evidenceEligible: false,
      participantCount: 3,
      qualifyingParticipantCount: 3,
      minimumParticipantCount: 3,
      minimumTasksPerParticipant: 4,
      independentThirdPartySecurityReview: 'not_observed',
      releaseBundle: {
        materialClass: 'digest_bound_metadata_only',
        transcriptContentIncluded: false,
      },
    });
    expect(result.reasonCodes).toEqual([
      'authenticated_external_evidence_not_configured',
      'independent_security_review_not_observed',
    ]);
    expect(result.releaseBundle.participantRecordDigests).toHaveLength(3);
  });

  test('fails closed for duplicate identities, withdrawal, or fewer than four tasks', () => {
    const first = participant(1);
    const duplicatedRecord = evaluateExternalProductSampleV1({
      version: 1,
      participants: [first, first, participant(3)],
      evaluatedAt: EVALUATED_AT,
      suiteDigest: digest('suite'),
    });
    expect(duplicatedRecord.status).toBe('blocked');
    expect(duplicatedRecord.reasonCodes).toContain('external_participant_identity_duplicate');

    const duplicate = {
      ...participant(2),
      participantIdentityDigest: first.participantIdentityDigest,
    } as ExternalProductParticipantRecordV1;
    // A caller cannot mutate identity without rebuilding the canonical digest.
    expect(() =>
      evaluateExternalProductSampleV1({
        version: 1,
        participants: [first, duplicate, participant(3)],
        evaluatedAt: EVALUATED_AT,
        suiteDigest: digest('suite'),
      }),
    ).toThrow('digest does not match');

    const second = participant(2);
    const canonicalDuplicate = buildExternalProductParticipantV1({
      version: 1,
      participantIdentityDigest: first.participantIdentityDigest,
      consent: second.consent,
      tasks: second.tasks,
      evaluatedAt: EVALUATED_AT,
    });
    const duplicateResult = evaluateExternalProductSampleV1({
      version: 1,
      participants: [first, canonicalDuplicate, participant(3)],
      evaluatedAt: EVALUATED_AT,
      suiteDigest: digest('suite'),
    });
    expect(duplicateResult.status).toBe('blocked');
    expect(duplicateResult.reasonCodes).toContain('external_participant_identity_duplicate');

    const insufficient = evaluateExternalProductSampleV1({
      version: 1,
      participants: [participant(1), participant(2, { tasks: 3 }), participant(3)],
      evaluatedAt: EVALUATED_AT,
      suiteDigest: digest('suite'),
    });
    expect(insufficient.status).toBe('blocked');
    expect(insufficient.reasonCodes).toContain('external_task_minimum_not_met');

    const withdrawn = evaluateExternalProductSampleV1({
      version: 1,
      participants: [participant(1), participant(2, { withdrawn: true }), participant(3)],
      evaluatedAt: EVALUATED_AT,
      suiteDigest: digest('suite'),
    });
    expect(withdrawn.status).toBe('blocked');
    expect(withdrawn.reasonCodes).toContain('external_participant_minimum_not_met');
  });

  test('rejects the maintainer masquerading as an external participant and any transcript field', () => {
    expect(() =>
      buildExternalProductParticipantV1({
        version: 1,
        participantIdentityDigest: digest(SINGLE_MAINTAINER_IDENTITY_V1),
        consent: {
          consentId: 'consent-maintainer',
          status: 'opted_in',
          consentedAt: AUTHORIZED_AT,
          withdrawalAvailable: true,
          withdrawnAt: null,
        },
        tasks: [],
        evaluatedAt: EVALUATED_AT,
      }),
    ).toThrow('identity or metadata boundary is invalid');

    const valid = participant(1);
    expect(() =>
      evaluateExternalProductSampleV1({
        version: 1,
        participants: [{ ...valid, transcript: 'private session' } as never],
        evaluatedAt: EVALUATED_AT,
        suiteDigest: digest('suite'),
      }),
    ).toThrow('missing or unknown fields');
  });
});
