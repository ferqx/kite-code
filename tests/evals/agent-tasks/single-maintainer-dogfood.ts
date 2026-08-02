import {
  canonicalJsonBytes,
  sha256Digest,
  sha256DomainSeparated,
} from '../../../scripts/release/canonical-json';

export const SINGLE_MAINTAINER_IDENTITY_V1 = 'github:@ferqx' as const;
export const EXTERNAL_PRODUCT_MINIMUM_PARTICIPANTS_V1 = 3 as const;
export const EXTERNAL_PRODUCT_MINIMUM_TASKS_PER_PARTICIPANT_V1 = 4 as const;

const INTERNAL_RECORD_DIGEST_DOMAIN = 'agent-task-internal-dogfood-record-v1';
const EXTERNAL_PARTICIPANT_DIGEST_DOMAIN = 'agent-task-external-participant-v1';
const EXTERNAL_GATE_DIGEST_DOMAIN = 'agent-task-external-product-gate-v1';
const CURRENT_BOUNDARY_DIGEST_DOMAIN = 'agent-task-single-maintainer-boundary-v1';
const EXTERNAL_PRODUCT_BLOCK_REASONS_V1 = new Set<ExternalProductSampleBlockReasonV1>([
  'authenticated_external_evidence_not_configured',
  'external_consent_not_observed',
  'external_participant_identity_duplicate',
  'external_participant_minimum_not_met',
  'external_product_outcomes_not_observed',
  'external_task_minimum_not_met',
  'independent_security_review_not_observed',
  'single_maintainer_not_external',
]);

export interface AuthorizedDogfoodTaskV1 {
  authorizationDigest: `sha256:${string}`;
  authorizedAt: string;
}

export interface InternalDogfoodAcceptanceRecordV1 {
  version: 1;
  evidenceClass: 'internal_single_maintainer_dogfood';
  producerIdentity: typeof SINGLE_MAINTAINER_IDENTITY_V1;
  taskId: string;
  authorizationDigest: `sha256:${string}`;
  authorizedAt: string;
  observedAt: string;
  outcome: 'accepted' | 'rejected';
  suiteDigest: `sha256:${string}`;
  runDigest: `sha256:${string}`;
  diffDigest: `sha256:${string}`;
  checksDigest: `sha256:${string}`;
  materialClass: 'digest_bound_metadata_only';
  transcriptContentIncluded: false;
  externalCohortEligible: false;
  independentThirdPartySecurityReviewEligible: false;
  digest: `sha256:${string}`;
}

export interface ExternalProductTaskObservationV1 {
  taskId: string;
  observedAt: string;
  outcome: 'accepted' | 'rejected' | 'not_observed';
  runDigest: `sha256:${string}`;
  diffDigest: `sha256:${string}`;
  checksDigest: `sha256:${string}`;
}

export interface ExternalProductParticipantRecordV1 {
  version: 1;
  evidenceClass: 'external_product_participant';
  participantIdentityDigest: `sha256:${string}`;
  consent: {
    consentId: string;
    status: 'opted_in' | 'withdrawn';
    consentedAt: string;
    withdrawalAvailable: true;
    withdrawnAt: string | null;
  };
  tasks: ExternalProductTaskObservationV1[];
  materialClass: 'digest_bound_metadata_only';
  transcriptContentIncluded: false;
  digest: `sha256:${string}`;
}

export type ExternalProductSampleBlockReasonV1 =
  | 'authenticated_external_evidence_not_configured'
  | 'external_consent_not_observed'
  | 'external_participant_identity_duplicate'
  | 'external_participant_minimum_not_met'
  | 'external_product_outcomes_not_observed'
  | 'external_task_minimum_not_met'
  | 'independent_security_review_not_observed'
  | 'single_maintainer_not_external';

export interface ExternalProductSampleGateV1 {
  version: 1;
  evidenceClass: 'external_product_sample_contract';
  status: 'blocked';
  outcome: 'not_observed';
  evidenceEligible: false;
  participantCount: number;
  qualifyingParticipantCount: number;
  minimumParticipantCount: typeof EXTERNAL_PRODUCT_MINIMUM_PARTICIPANTS_V1;
  minimumTasksPerParticipant: typeof EXTERNAL_PRODUCT_MINIMUM_TASKS_PER_PARTICIPANT_V1;
  reasonCodes: ExternalProductSampleBlockReasonV1[];
  independentThirdPartySecurityReview: 'not_observed';
  releaseBundle: {
    materialClass: 'digest_bound_metadata_only';
    transcriptContentIncluded: false;
    participantRecordDigests: `sha256:${string}`[];
  };
  evaluatedAt: string;
  suiteDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
}

export interface CurrentSingleMaintainerDogfoodBoundaryV1 {
  version: 1;
  decision: { id: 'D-07'; status: 'closed'; owner: typeof SINGLE_MAINTAINER_IDENTITY_V1 };
  internalDogfood: {
    producerIdentity: typeof SINGLE_MAINTAINER_IDENTITY_V1;
    acceptance: 'not_observed';
    externalCohortEligible: false;
    independentThirdPartySecurityReviewEligible: false;
  };
  externalProductSample: ExternalProductSampleGateV1;
  releaseEligible: false;
  digest: `sha256:${string}`;
}

export function buildInternalDogfoodAcceptanceV1(input: {
  version: 1;
  producerIdentity: typeof SINGLE_MAINTAINER_IDENTITY_V1;
  taskId: string;
  authorizationDigest: `sha256:${string}`;
  observedAt: string;
  outcome: 'accepted' | 'rejected';
  suiteDigest: `sha256:${string}`;
  runDigest: `sha256:${string}`;
  diffDigest: `sha256:${string}`;
  checksDigest: `sha256:${string}`;
  authorizedTasks: Readonly<Record<string, AuthorizedDogfoodTaskV1 | undefined>>;
  evaluatedAt: string;
}): InternalDogfoodAcceptanceRecordV1 {
  exactKeys(input, [
    'authorizationDigest',
    'authorizedTasks',
    'checksDigest',
    'diffDigest',
    'evaluatedAt',
    'observedAt',
    'outcome',
    'producerIdentity',
    'runDigest',
    'suiteDigest',
    'taskId',
    'version',
  ]);
  const authorization = input.authorizedTasks[input.taskId];
  if (!authorization) throw new Error('Internal dogfood task is not explicitly authorized.');
  const withoutDigest = {
    version: 1 as const,
    evidenceClass: 'internal_single_maintainer_dogfood' as const,
    producerIdentity: input.producerIdentity,
    taskId: input.taskId,
    authorizationDigest: input.authorizationDigest,
    authorizedAt: authorization.authorizedAt,
    observedAt: input.observedAt,
    outcome: input.outcome,
    suiteDigest: input.suiteDigest,
    runDigest: input.runDigest,
    diffDigest: input.diffDigest,
    checksDigest: input.checksDigest,
    materialClass: 'digest_bound_metadata_only' as const,
    transcriptContentIncluded: false as const,
    externalCohortEligible: false as const,
    independentThirdPartySecurityReviewEligible: false as const,
  };
  const record = {
    ...withoutDigest,
    digest: recordDigest(INTERNAL_RECORD_DIGEST_DOMAIN, withoutDigest),
  };
  validateInternalDogfoodAcceptanceV1(record, {
    authorizedTasks: input.authorizedTasks,
    evaluatedAt: input.evaluatedAt,
  });
  return record;
}

export function validateInternalDogfoodAcceptanceV1(
  value: InternalDogfoodAcceptanceRecordV1,
  context: {
    authorizedTasks: Readonly<Record<string, AuthorizedDogfoodTaskV1 | undefined>>;
    evaluatedAt: string;
  },
): void {
  exactKeys(value, [
    'authorizationDigest',
    'authorizedAt',
    'checksDigest',
    'diffDigest',
    'digest',
    'evidenceClass',
    'externalCohortEligible',
    'independentThirdPartySecurityReviewEligible',
    'materialClass',
    'observedAt',
    'outcome',
    'producerIdentity',
    'runDigest',
    'suiteDigest',
    'taskId',
    'transcriptContentIncluded',
    'version',
  ]);
  const authorization = context.authorizedTasks[value.taskId];
  if (authorization) exactKeys(authorization, ['authorizationDigest', 'authorizedAt']);
  if (
    value.version !== 1 ||
    value.evidenceClass !== 'internal_single_maintainer_dogfood' ||
    value.producerIdentity !== SINGLE_MAINTAINER_IDENTITY_V1 ||
    !identifier(value.taskId) ||
    !authorization ||
    authorization.authorizationDigest !== value.authorizationDigest ||
    authorization.authorizedAt !== value.authorizedAt ||
    !digest(authorization.authorizationDigest) ||
    !timestamp(authorization.authorizedAt) ||
    !digest(value.authorizationDigest) ||
    ![value.suiteDigest, value.runDigest, value.diffDigest, value.checksDigest].every(digest) ||
    (value.outcome !== 'accepted' && value.outcome !== 'rejected') ||
    value.materialClass !== 'digest_bound_metadata_only' ||
    value.transcriptContentIncluded !== false ||
    value.externalCohortEligible !== false ||
    value.independentThirdPartySecurityReviewEligible !== false
  ) {
    throw new Error('Internal dogfood acceptance identity or boundary is invalid.');
  }
  assertTimestampOrder(value.authorizedAt, value.observedAt, context.evaluatedAt);
  verifyRecordDigest(value, INTERNAL_RECORD_DIGEST_DOMAIN);
}

export function buildExternalProductParticipantV1(input: {
  version: 1;
  participantIdentityDigest: `sha256:${string}`;
  consent: ExternalProductParticipantRecordV1['consent'];
  tasks: ExternalProductTaskObservationV1[];
  evaluatedAt: string;
}): ExternalProductParticipantRecordV1 {
  exactKeys(input, ['consent', 'evaluatedAt', 'participantIdentityDigest', 'tasks', 'version']);
  const withoutDigest = {
    version: 1 as const,
    evidenceClass: 'external_product_participant' as const,
    participantIdentityDigest: input.participantIdentityDigest,
    consent: structuredClone(input.consent),
    tasks: structuredClone(input.tasks),
    materialClass: 'digest_bound_metadata_only' as const,
    transcriptContentIncluded: false as const,
  };
  const record = {
    ...withoutDigest,
    digest: recordDigest(EXTERNAL_PARTICIPANT_DIGEST_DOMAIN, withoutDigest),
  };
  validateExternalProductParticipantV1(record, input.evaluatedAt);
  return record;
}

export function evaluateExternalProductSampleV1(input: {
  version: 1;
  participants: ExternalProductParticipantRecordV1[];
  evaluatedAt: string;
  suiteDigest: `sha256:${string}`;
}): ExternalProductSampleGateV1 {
  exactKeys(input, ['evaluatedAt', 'participants', 'suiteDigest', 'version']);
  if (input.version !== 1 || !timestamp(input.evaluatedAt) || !digest(input.suiteDigest)) {
    throw new Error('External product sample identity is invalid.');
  }
  input.participants.forEach((participant) => {
    validateExternalProductParticipantV1(participant, input.evaluatedAt);
  });

  const reasons = new Set<ExternalProductSampleBlockReasonV1>([
    'authenticated_external_evidence_not_configured',
    'independent_security_review_not_observed',
  ]);
  const identities = input.participants.map(
    ({ participantIdentityDigest }) => participantIdentityDigest,
  );
  if (new Set(identities).size !== identities.length) {
    reasons.add('external_participant_identity_duplicate');
  }
  if (input.participants.length === 0) {
    reasons.add('external_consent_not_observed');
    reasons.add('single_maintainer_not_external');
  }

  const optedIn = input.participants.filter(
    ({ consent }) => consent.status === 'opted_in' && consent.withdrawnAt === null,
  );
  const qualifying = optedIn.filter(
    ({ tasks }) =>
      new Set(tasks.map(({ taskId }) => taskId)).size >=
        EXTERNAL_PRODUCT_MINIMUM_TASKS_PER_PARTICIPANT_V1 &&
      tasks.filter(({ outcome }) => outcome !== 'not_observed').length >=
        EXTERNAL_PRODUCT_MINIMUM_TASKS_PER_PARTICIPANT_V1,
  );
  if (optedIn.length < EXTERNAL_PRODUCT_MINIMUM_PARTICIPANTS_V1) {
    reasons.add('external_participant_minimum_not_met');
  }
  if (qualifying.length < EXTERNAL_PRODUCT_MINIMUM_PARTICIPANTS_V1) {
    reasons.add('external_task_minimum_not_met');
    reasons.add('external_product_outcomes_not_observed');
  }

  const productReasons = [...reasons].filter(
    (reason) =>
      reason !== 'independent_security_review_not_observed' &&
      reason !== 'single_maintainer_not_external',
  );
  // Local records can exercise the population contract, but they cannot
  // authenticate consent, participant identity, or provider run receipts.
  // Only a future independent adapter may turn a qualifying assessment into
  // external evidence; this constructor therefore always remains blocked.
  void productReasons;
  const withoutDigest = {
    version: 1 as const,
    evidenceClass: 'external_product_sample_contract' as const,
    status: 'blocked' as const,
    outcome: 'not_observed' as const,
    evidenceEligible: false as const,
    participantCount: input.participants.length,
    qualifyingParticipantCount: qualifying.length,
    minimumParticipantCount: EXTERNAL_PRODUCT_MINIMUM_PARTICIPANTS_V1,
    minimumTasksPerParticipant: EXTERNAL_PRODUCT_MINIMUM_TASKS_PER_PARTICIPANT_V1,
    reasonCodes: [...reasons].sort(compareCodeUnits),
    independentThirdPartySecurityReview: 'not_observed' as const,
    releaseBundle: {
      materialClass: 'digest_bound_metadata_only' as const,
      transcriptContentIncluded: false as const,
      participantRecordDigests: input.participants
        .map(({ digest: participantDigest }) => participantDigest)
        .sort(compareCodeUnits),
    },
    evaluatedAt: input.evaluatedAt,
    suiteDigest: input.suiteDigest,
  };
  const record = {
    ...withoutDigest,
    digest: recordDigest(EXTERNAL_GATE_DIGEST_DOMAIN, withoutDigest),
  };
  validateExternalProductSampleGateV1(record);
  return record;
}

export function buildCurrentSingleMaintainerDogfoodBoundaryV1(input: {
  evaluatedAt: string;
  suiteDigest: `sha256:${string}`;
}): CurrentSingleMaintainerDogfoodBoundaryV1 {
  exactKeys(input, ['evaluatedAt', 'suiteDigest']);
  const externalProductSample = evaluateExternalProductSampleV1({
    version: 1,
    participants: [],
    evaluatedAt: input.evaluatedAt,
    suiteDigest: input.suiteDigest,
  });
  const withoutDigest = {
    version: 1 as const,
    decision: {
      id: 'D-07' as const,
      status: 'closed' as const,
      owner: SINGLE_MAINTAINER_IDENTITY_V1,
    },
    internalDogfood: {
      producerIdentity: SINGLE_MAINTAINER_IDENTITY_V1,
      acceptance: 'not_observed' as const,
      externalCohortEligible: false as const,
      independentThirdPartySecurityReviewEligible: false as const,
    },
    externalProductSample,
    releaseEligible: false as const,
  };
  const boundary = {
    ...withoutDigest,
    digest: recordDigest(CURRENT_BOUNDARY_DIGEST_DOMAIN, withoutDigest),
  };
  verifyCurrentSingleMaintainerDogfoodBoundaryV1(boundary);
  return boundary;
}

export function verifyCurrentSingleMaintainerDogfoodBoundaryV1(
  value: CurrentSingleMaintainerDogfoodBoundaryV1,
): void {
  exactKeys(value, [
    'decision',
    'digest',
    'externalProductSample',
    'internalDogfood',
    'releaseEligible',
    'version',
  ]);
  exactKeys(value.decision, ['id', 'owner', 'status']);
  exactKeys(value.internalDogfood, [
    'acceptance',
    'externalCohortEligible',
    'independentThirdPartySecurityReviewEligible',
    'producerIdentity',
  ]);
  if (
    value.version !== 1 ||
    value.decision.id !== 'D-07' ||
    value.decision.status !== 'closed' ||
    value.decision.owner !== SINGLE_MAINTAINER_IDENTITY_V1 ||
    value.internalDogfood.producerIdentity !== SINGLE_MAINTAINER_IDENTITY_V1 ||
    value.internalDogfood.acceptance !== 'not_observed' ||
    value.internalDogfood.externalCohortEligible !== false ||
    value.internalDogfood.independentThirdPartySecurityReviewEligible !== false ||
    value.externalProductSample.status !== 'blocked' ||
    value.externalProductSample.outcome !== 'not_observed' ||
    value.externalProductSample.participantCount !== 0 ||
    value.externalProductSample.independentThirdPartySecurityReview !== 'not_observed' ||
    value.releaseEligible !== false
  ) {
    throw new Error('Current single-maintainer boundary cannot claim observed external evidence.');
  }
  validateExternalProductSampleGateV1(value.externalProductSample);
  verifyRecordDigest(value, CURRENT_BOUNDARY_DIGEST_DOMAIN);
}

function validateExternalProductSampleGateV1(value: ExternalProductSampleGateV1): void {
  exactKeys(value, [
    'digest',
    'evaluatedAt',
    'evidenceClass',
    'evidenceEligible',
    'independentThirdPartySecurityReview',
    'minimumParticipantCount',
    'minimumTasksPerParticipant',
    'outcome',
    'participantCount',
    'qualifyingParticipantCount',
    'reasonCodes',
    'releaseBundle',
    'status',
    'suiteDigest',
    'version',
  ]);
  exactKeys(value.releaseBundle, [
    'materialClass',
    'participantRecordDigests',
    'transcriptContentIncluded',
  ]);
  const normalizedReasons = [...new Set(value.reasonCodes)].sort(compareCodeUnits);
  const normalizedRecordDigests = [...value.releaseBundle.participantRecordDigests].sort(
    compareCodeUnits,
  );
  if (
    value.version !== 1 ||
    value.evidenceClass !== 'external_product_sample_contract' ||
    !Number.isInteger(value.participantCount) ||
    value.participantCount < 0 ||
    !Number.isInteger(value.qualifyingParticipantCount) ||
    value.qualifyingParticipantCount < 0 ||
    value.qualifyingParticipantCount > value.participantCount ||
    value.minimumParticipantCount !== EXTERNAL_PRODUCT_MINIMUM_PARTICIPANTS_V1 ||
    value.minimumTasksPerParticipant !== EXTERNAL_PRODUCT_MINIMUM_TASKS_PER_PARTICIPANT_V1 ||
    value.independentThirdPartySecurityReview !== 'not_observed' ||
    value.releaseBundle.materialClass !== 'digest_bound_metadata_only' ||
    value.releaseBundle.transcriptContentIncluded !== false ||
    !value.releaseBundle.participantRecordDigests.every(digest) ||
    value.releaseBundle.participantRecordDigests.some(
      (recordDigest, index) => recordDigest !== normalizedRecordDigests[index],
    ) ||
    normalizedReasons.length !== value.reasonCodes.length ||
    normalizedReasons.some((reason, index) => reason !== value.reasonCodes[index]) ||
    !value.reasonCodes.every((reason) => EXTERNAL_PRODUCT_BLOCK_REASONS_V1.has(reason)) ||
    !timestamp(value.evaluatedAt) ||
    !digest(value.suiteDigest) ||
    value.status !== 'blocked' ||
    value.outcome !== 'not_observed' ||
    value.evidenceEligible !== false ||
    !value.reasonCodes.includes('authenticated_external_evidence_not_configured')
  ) {
    throw new Error('External product sample Gate boundary is invalid.');
  }
  verifyRecordDigest(value, EXTERNAL_GATE_DIGEST_DOMAIN);
}

function validateExternalProductParticipantV1(
  value: ExternalProductParticipantRecordV1,
  evaluatedAt: string,
): void {
  exactKeys(value, [
    'consent',
    'digest',
    'evidenceClass',
    'materialClass',
    'participantIdentityDigest',
    'tasks',
    'transcriptContentIncluded',
    'version',
  ]);
  exactKeys(value.consent, [
    'consentId',
    'consentedAt',
    'status',
    'withdrawalAvailable',
    'withdrawnAt',
  ]);
  if (
    value.version !== 1 ||
    value.evidenceClass !== 'external_product_participant' ||
    !digest(value.participantIdentityDigest) ||
    value.participantIdentityDigest === sha256Digest(SINGLE_MAINTAINER_IDENTITY_V1) ||
    !identifier(value.consent.consentId) ||
    (value.consent.status !== 'opted_in' && value.consent.status !== 'withdrawn') ||
    value.consent.withdrawalAvailable !== true ||
    value.materialClass !== 'digest_bound_metadata_only' ||
    value.transcriptContentIncluded !== false
  ) {
    throw new Error('External participant identity or metadata boundary is invalid.');
  }
  if (
    (value.consent.status === 'opted_in' && value.consent.withdrawnAt !== null) ||
    (value.consent.status === 'withdrawn' && value.consent.withdrawnAt === null)
  ) {
    throw new Error('External participant consent/withdrawal state is invalid.');
  }
  assertTimestampOrder(
    value.consent.consentedAt,
    value.consent.withdrawnAt ?? value.consent.consentedAt,
    evaluatedAt,
  );
  const taskIds = new Set<string>();
  for (const task of value.tasks) {
    exactKeys(task, ['checksDigest', 'diffDigest', 'observedAt', 'outcome', 'runDigest', 'taskId']);
    if (
      !identifier(task.taskId) ||
      taskIds.has(task.taskId) ||
      ![task.runDigest, task.diffDigest, task.checksDigest].every(digest) ||
      !['accepted', 'rejected', 'not_observed'].includes(task.outcome) ||
      !timestamp(task.observedAt) ||
      task.observedAt < value.consent.consentedAt ||
      task.observedAt > evaluatedAt
    ) {
      throw new Error('External participant task observation is invalid.');
    }
    taskIds.add(task.taskId);
  }
  verifyRecordDigest(value, EXTERNAL_PARTICIPANT_DIGEST_DOMAIN);
}

function assertTimestampOrder(...values: string[]): void {
  if (values.some((value) => !timestamp(value))) throw new Error('Evidence timestamp is invalid.');
  if (values.some((value, index) => index > 0 && value < values[index - 1]!)) {
    throw new Error('Evidence timestamps are not monotonic.');
  }
}

function timestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function identifier(value: string): boolean {
  return /^[a-z0-9][a-z0-9._:-]{0,255}$/.test(value);
}

function digest(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

function recordDigest(domain: string, value: object): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

function verifyRecordDigest(value: { digest: string }, domain: string): void {
  const withoutDigest = { ...value } as Record<string, unknown>;
  const actual = withoutDigest.digest;
  delete withoutDigest.digest;
  if (
    typeof actual !== 'string' ||
    !digest(actual) ||
    actual !== recordDigest(domain, withoutDigest)
  ) {
    throw new Error('Evidence digest does not match canonical content.');
  }
}

function exactKeys(value: object, expected: readonly string[]): void {
  const actual = Object.keys(value).sort(compareCodeUnits);
  const sorted = [...expected].sort(compareCodeUnits);
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error('Single-maintainer dogfood schema has missing or unknown fields.');
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
