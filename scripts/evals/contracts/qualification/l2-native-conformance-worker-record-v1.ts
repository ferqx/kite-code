import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { EVIDENCE_GOVERNANCE_PROFILE_V1 } from './evidence/governance-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import {
  type L2NativeCandidateIdentityV1,
  type L2NativeExecutionV1,
  l2NativeCandidateIdentityV1Schema,
  l2NativeExecutionV1Schema,
} from './l2-native-candidate-identity-v1';
import {
  type L2NativeConformanceAdapterObservationV1,
  l2NativeConformanceAdapterObservationV1Schema,
} from './l2-native-conformance-adapter-v1';
import { buildL2NativeConformanceEvaluatorV1 } from './l2-native-conformance-evaluator-v1';
import {
  buildL2NativeConformanceSourceRegistryV1,
  buildL2NativeConformanceSuiteV1,
  L2_NATIVE_CONFORMANCE_CASE_IDS_V1,
  L2_NATIVE_CONFORMANCE_CASES_V1,
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
  type L2NativeConformanceCaseV1,
  type L2NativeConformanceEvaluatorIdentityV1,
  type L2NativeConformanceSuiteV1,
  type L2NativeConformanceTargetV1,
  l2NativeConformanceEvaluatorIdentityV1Schema,
  l2NativeConformanceSuiteV1Schema,
  l2NativeConformanceTargetV1Schema,
} from './l2-native-conformance-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L2 native worker-record identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

export const L2_NATIVE_CONFORMANCE_WORKER_RECORD_SCHEMA_V1 =
  'L2NativeConformanceWorkerRecordV1' as const;

function exactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

/**
 * A worker is allowed to construct observations only for its own source-owned
 * target. This helper never creates a candidate, probe, receipt, report, or
 * evidence record.
 */
export function l2NativeConformanceCasesForTargetV1(
  target: L2NativeConformanceTargetV1,
): readonly L2NativeConformanceCaseV1[] {
  const parsed = l2NativeConformanceTargetV1Schema.parse(target);
  return Object.freeze(
    L2_NATIVE_CONFORMANCE_CASES_V1.filter(
      (entry) => entry.target.distributionTargetId === parsed.distributionTargetId,
    ),
  );
}

function sameCandidateLineage(
  left: L2NativeCandidateIdentityV1,
  right: L2NativeCandidateIdentityV1,
): boolean {
  return (
    left.artifact.canonicalRepository === right.artifact.canonicalRepository &&
    left.artifact.repositoryId === right.artifact.repositoryId &&
    left.artifact.commit === right.artifact.commit &&
    left.artifact.behaviorDigest === right.artifact.behaviorDigest &&
    left.artifact.profileDigest === right.artifact.profileDigest &&
    left.artifact.gatePolicyDigest === right.artifact.gatePolicyDigest
  );
}

const workerRecordMaterialV1Schema = z
  .object({
    schema: z.literal(L2_NATIVE_CONFORMANCE_WORKER_RECORD_SCHEMA_V1),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    workerRecordId: identifierSchema,
    target: l2NativeConformanceTargetV1Schema,
    sourceRegistryDigest: digestSchema,
    suite: l2NativeConformanceSuiteV1Schema,
    evaluator: l2NativeConformanceEvaluatorIdentityV1Schema,
    candidate: l2NativeCandidateIdentityV1Schema,
    execution: l2NativeExecutionV1Schema,
    observations: z.array(l2NativeConformanceAdapterObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    const sourceRegistry = buildL2NativeConformanceSourceRegistryV1();
    const suite = buildL2NativeConformanceSuiteV1();
    const evaluator = buildL2NativeConformanceEvaluatorV1();
    if (value.sourceRegistryDigest !== sourceRegistry.sourceRegistryDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceRegistryDigest'],
        message: 'L2 worker record must bind the current source-owned target/support registry',
      });
    }
    if (
      value.suite.suiteDigest !== suite.suiteDigest ||
      value.suite.sourceRegistryDigest !== value.sourceRegistryDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['suite'],
        message: 'L2 worker record must bind the current complete native suite',
      });
    }
    if (
      value.evaluator.evaluatorDigest !== evaluator.evaluatorDigest ||
      value.evaluator.suiteDigest !== value.suite.suiteDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evaluator'],
        message: 'L2 worker record must bind the fixed native evaluator identity',
      });
    }
    if (
      value.candidate.target.distributionTargetId !== value.target.distributionTargetId ||
      value.execution.target.distributionTargetId !== value.target.distributionTargetId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['target'],
        message: 'L2 worker record candidate and execution must remain on its one native target',
      });
    }
    const expectedWorkerRecordId = `l2-native-worker-record:${value.target.distributionTargetId}:${value.execution.executionId}`;
    if (value.workerRecordId !== expectedWorkerRecordId) {
      context.addIssue({
        code: 'custom',
        path: ['workerRecordId'],
        message: 'L2 worker record ID must bind its target and protected execution',
      });
    }
    const expectedCases = l2NativeConformanceCasesForTargetV1(value.target);
    const observedCaseIds = value.observations.map((observation) => observation.case.caseId);
    if (
      !exactInventory(
        observedCaseIds,
        expectedCases.map((entry) => entry.caseId),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message:
          'L2 worker record must contain the exact five local target/capability observations',
      });
    }
    if (
      !value.observations.every(
        (observation) =>
          observation.case.target.distributionTargetId === value.target.distributionTargetId &&
          observation.candidate.candidateDigest === value.candidate.candidateDigest &&
          observation.execution.executionDigest === value.execution.executionDigest,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message:
          'L2 worker record observations must bind one local target, candidate, and execution',
      });
    }
  });

export type L2NativeConformanceWorkerRecordMaterialV1 = z.infer<
  typeof workerRecordMaterialV1Schema
>;

export function computeL2NativeConformanceWorkerRecordDigestV1(
  material: L2NativeConformanceWorkerRecordMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.worker-record.v1',
    canonicalJsonBytes(workerRecordMaterialV1Schema.parse(material)),
  );
}

/**
 * This is an opaque, metadata-only worker transport record—not a receipt,
 * AgentQualificationEvidenceV1 record, report, or production artifact. It is
 * deliberately limited to five observations for a single native target.
 */
export const l2NativeConformanceWorkerRecordV1Schema = workerRecordMaterialV1Schema
  .extend({ workerRecordDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { workerRecordDigest, ...material } = value;
    const expected = computeL2NativeConformanceWorkerRecordDigestV1(material);
    if (workerRecordDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['workerRecordDigest'],
        message: `L2 native worker record digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceWorkerRecordV1 = z.infer<
  typeof l2NativeConformanceWorkerRecordV1Schema
>;

export function buildL2NativeConformanceWorkerRecordV1(input: {
  target: L2NativeConformanceTargetV1;
  candidate: L2NativeCandidateIdentityV1;
  execution: L2NativeExecutionV1;
  observations: readonly L2NativeConformanceAdapterObservationV1[];
  sourceRegistryDigest?: `sha256:${string}`;
  suite?: L2NativeConformanceSuiteV1;
  evaluator?: L2NativeConformanceEvaluatorIdentityV1;
}): L2NativeConformanceWorkerRecordV1 {
  const target = l2NativeConformanceTargetV1Schema.parse(input.target);
  const execution = l2NativeExecutionV1Schema.parse(input.execution);
  const material = workerRecordMaterialV1Schema.parse({
    schema: L2_NATIVE_CONFORMANCE_WORKER_RECORD_SCHEMA_V1,
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    workerRecordId: `l2-native-worker-record:${target.distributionTargetId}:${execution.executionId}`,
    target,
    sourceRegistryDigest:
      input.sourceRegistryDigest ?? buildL2NativeConformanceSourceRegistryV1().sourceRegistryDigest,
    suite: input.suite ?? buildL2NativeConformanceSuiteV1(),
    evaluator: input.evaluator ?? buildL2NativeConformanceEvaluatorV1(),
    candidate: input.candidate,
    execution,
    observations: input.observations,
  });
  return l2NativeConformanceWorkerRecordV1Schema.parse({
    ...material,
    workerRecordDigest: computeL2NativeConformanceWorkerRecordDigestV1(material),
  });
}

export function parseL2NativeConformanceWorkerRecordV1(
  value: unknown,
): L2NativeConformanceWorkerRecordV1 {
  return l2NativeConformanceWorkerRecordV1Schema.parse(value);
}

/**
 * A governance control-plane failure is transportable only as a minimal
 * diagnostic block. `requestedGovernanceProfile` is a profile reference, not
 * an EvidenceGovernanceBinding, quota reservation, retention assertion, or
 * qualification evidence claim.
 */
export const L2_NATIVE_CONFORMANCE_BLOCKED_WORKER_REASON_V1 =
  'protected_ci_governance_control_plane_unavailable' as const;

const requestedGovernanceProfileV1Schema = z
  .object({
    retentionClass: z.literal('protected_ci_retained'),
    profileId: identifierSchema,
    profileDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.protected_ci_retained;
    if (value.profileId !== profile.profileId || value.profileDigest !== profile.profileDigest) {
      context.addIssue({
        code: 'custom',
        message:
          'L2 blocked worker transport must reference the exact requested protected-CI profile',
      });
    }
  });
export type L2NativeRequestedGovernanceProfileV1 = z.infer<
  typeof requestedGovernanceProfileV1Schema
>;

const blockedWorkerTransportMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceBlockedWorkerTransportV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    blockedTransportId: identifierSchema,
    target: l2NativeConformanceTargetV1Schema,
    sourceRegistryDigest: digestSchema,
    suite: l2NativeConformanceSuiteV1Schema,
    evaluator: l2NativeConformanceEvaluatorIdentityV1Schema,
    requestedGovernanceProfile: requestedGovernanceProfileV1Schema,
    governancePreflight: z.literal('unavailable'),
    reasonCode: z.literal(L2_NATIVE_CONFORMANCE_BLOCKED_WORKER_REASON_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const sourceRegistry = buildL2NativeConformanceSourceRegistryV1();
    const suite = buildL2NativeConformanceSuiteV1();
    const evaluator = buildL2NativeConformanceEvaluatorV1();
    if (value.sourceRegistryDigest !== sourceRegistry.sourceRegistryDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceRegistryDigest'],
        message:
          'L2 blocked worker transport must bind the current source-owned target/support registry',
      });
    }
    if (
      value.suite.suiteDigest !== suite.suiteDigest ||
      value.suite.sourceRegistryDigest !== value.sourceRegistryDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['suite'],
        message: 'L2 blocked worker transport must bind the current complete native suite',
      });
    }
    if (
      value.evaluator.evaluatorDigest !== evaluator.evaluatorDigest ||
      value.evaluator.suiteDigest !== value.suite.suiteDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evaluator'],
        message: 'L2 blocked worker transport must bind the fixed native evaluator identity',
      });
    }
    const expectedBlockedTransportId = `l2-native-blocked-worker:${value.target.distributionTargetId}:${value.sourceRegistryDigest}`;
    if (value.blockedTransportId !== expectedBlockedTransportId) {
      context.addIssue({
        code: 'custom',
        path: ['blockedTransportId'],
        message: 'L2 blocked worker transport ID must bind its target and source registry',
      });
    }
  });

export type L2NativeConformanceBlockedWorkerTransportMaterialV1 = z.infer<
  typeof blockedWorkerTransportMaterialV1Schema
>;

export function computeL2NativeConformanceBlockedWorkerTransportDigestV1(
  material: L2NativeConformanceBlockedWorkerTransportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.blocked-worker-transport.v1',
    canonicalJsonBytes(blockedWorkerTransportMaterialV1Schema.parse(material)),
  );
}

export const l2NativeConformanceBlockedWorkerTransportV1Schema =
  blockedWorkerTransportMaterialV1Schema
    .extend({ blockedTransportDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { blockedTransportDigest, ...material } = value;
      const expected = computeL2NativeConformanceBlockedWorkerTransportDigestV1(material);
      if (blockedTransportDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['blockedTransportDigest'],
          message: `L2 blocked worker transport digest mismatch: expected ${expected}`,
        });
      }
    });
export type L2NativeConformanceBlockedWorkerTransportV1 = z.infer<
  typeof l2NativeConformanceBlockedWorkerTransportV1Schema
>;

function requestedProtectedCiGovernanceProfileV1(): L2NativeRequestedGovernanceProfileV1 {
  const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.protected_ci_retained;
  return requestedGovernanceProfileV1Schema.parse({
    retentionClass: 'protected_ci_retained',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
  });
}

export function buildL2NativeConformanceBlockedWorkerTransportV1(input: {
  target: L2NativeConformanceTargetV1;
  requestedGovernanceProfile?: L2NativeRequestedGovernanceProfileV1;
  sourceRegistryDigest?: string;
  suite?: L2NativeConformanceSuiteV1;
  evaluator?: L2NativeConformanceEvaluatorIdentityV1;
}): L2NativeConformanceBlockedWorkerTransportV1 {
  const target = l2NativeConformanceTargetV1Schema.parse(input.target);
  const sourceRegistryDigest =
    input.sourceRegistryDigest ?? buildL2NativeConformanceSourceRegistryV1().sourceRegistryDigest;
  const material = blockedWorkerTransportMaterialV1Schema.parse({
    schema: 'L2NativeConformanceBlockedWorkerTransportV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    blockedTransportId: `l2-native-blocked-worker:${target.distributionTargetId}:${sourceRegistryDigest}`,
    target,
    sourceRegistryDigest,
    suite: input.suite ?? buildL2NativeConformanceSuiteV1(),
    evaluator: input.evaluator ?? buildL2NativeConformanceEvaluatorV1(),
    requestedGovernanceProfile:
      input.requestedGovernanceProfile ?? requestedProtectedCiGovernanceProfileV1(),
    governancePreflight: 'unavailable',
    reasonCode: L2_NATIVE_CONFORMANCE_BLOCKED_WORKER_REASON_V1,
  });
  return l2NativeConformanceBlockedWorkerTransportV1Schema.parse({
    ...material,
    blockedTransportDigest: computeL2NativeConformanceBlockedWorkerTransportDigestV1(material),
  });
}

export function parseL2NativeConformanceBlockedWorkerTransportV1(
  value: unknown,
): L2NativeConformanceBlockedWorkerTransportV1 {
  return l2NativeConformanceBlockedWorkerTransportV1Schema.parse(value);
}

export interface L2NativeConformanceWorkerAggregateInputV1 {
  sourceRegistryDigest: string;
  suite: L2NativeConformanceSuiteV1;
  evaluator: L2NativeConformanceEvaluatorIdentityV1;
  workerRecordDigests: readonly string[];
  observations: readonly L2NativeConformanceAdapterObservationV1[];
}

/**
 * Only the later protected aggregate job may call this after downloading all
 * three sealed worker records. This function merely assembles the exact
 * fifteen observations for the existing L2 evaluator; it never creates a
 * report, receipt, generic evidence, or production-control conclusion.
 */
export function assembleL2NativeConformanceWorkerRecordsV1(input: {
  workerRecords: readonly L2NativeConformanceWorkerRecordV1[];
}): L2NativeConformanceWorkerAggregateInputV1 {
  const parsedRecords = input.workerRecords.map((record) =>
    l2NativeConformanceWorkerRecordV1Schema.parse(record),
  );
  if (parsedRecords.length !== L2_NATIVE_CONFORMANCE_TARGETS_V1.length) {
    throw new Error('l2_native_worker_aggregate_requires_exact_three_target_records');
  }
  const recordsByTarget = new Map(
    parsedRecords.map((record) => [record.target.distributionTargetId, record]),
  );
  if (recordsByTarget.size !== L2_NATIVE_CONFORMANCE_TARGETS_V1.length) {
    throw new Error('l2_native_worker_aggregate_rejects_duplicate_target_records');
  }
  const orderedRecords = L2_NATIVE_CONFORMANCE_TARGETS_V1.map((target) => {
    const record = recordsByTarget.get(target.distributionTargetId);
    if (!record) throw new Error('l2_native_worker_aggregate_missing_source_target_record');
    return record;
  });
  const first = orderedRecords[0]!;
  if (
    !orderedRecords.every(
      (record) =>
        record.sourceRegistryDigest === first.sourceRegistryDigest &&
        record.suite.suiteDigest === first.suite.suiteDigest &&
        record.evaluator.evaluatorDigest === first.evaluator.evaluatorDigest &&
        sameCandidateLineage(record.candidate, first.candidate),
    )
  ) {
    throw new Error('l2_native_worker_aggregate_candidate_or_provenance_closure_mismatch');
  }
  const payloadDigests = new Set(
    orderedRecords.map((record) => record.candidate.artifact.payloadSha256),
  );
  if (payloadDigests.size !== orderedRecords.length) {
    throw new Error('l2_native_worker_aggregate_rejects_cross_target_candidate_payload_reuse');
  }
  const observationByCase = new Map(
    orderedRecords.flatMap((record) =>
      record.observations.map((observation) => [observation.case.caseId, observation] as const),
    ),
  );
  const observations = L2_NATIVE_CONFORMANCE_CASE_IDS_V1.map((caseId) => {
    const observation = observationByCase.get(caseId);
    if (!observation) throw new Error('l2_native_worker_aggregate_missing_case_observation');
    return observation;
  });
  if (observationByCase.size !== L2_NATIVE_CONFORMANCE_CASE_IDS_V1.length) {
    throw new Error('l2_native_worker_aggregate_rejects_duplicate_or_unknown_case_observations');
  }
  return Object.freeze({
    sourceRegistryDigest: first.sourceRegistryDigest,
    suite: first.suite,
    evaluator: first.evaluator,
    workerRecordDigests: Object.freeze(orderedRecords.map((record) => record.workerRecordDigest)),
    observations: Object.freeze(observations),
  });
}
