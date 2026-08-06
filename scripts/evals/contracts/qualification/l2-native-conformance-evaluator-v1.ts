import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  type L2NativeConformanceAdapterObservationV1,
  l2NativeConformanceAdapterObservationV1Schema,
} from './l2-native-conformance-adapter-v1';
import {
  buildL2NativeConformanceEvaluatorIdentityV1,
  buildL2NativeConformanceSuiteV1,
  L2_NATIVE_CONFORMANCE_CASE_IDS_V1,
  L2_NATIVE_CONFORMANCE_RUNNER_ID_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
  type L2NativeConformanceEvaluatorIdentityV1,
  l2NativeConformanceEvaluatorIdentityV1Schema,
} from './l2-native-conformance-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const digestSchema = z.string().regex(DIGEST);

/** These facts are closed implementation metadata, never probe or test content. */
export const L2_NATIVE_CONFORMANCE_EVALUATOR_PROVENANCE_V1 = Object.freeze({
  oracle: Object.freeze({
    candidate: 'verified-archive-and-manifest-identity-v1',
    nativeProbe: 'independently-verified-platform-probe-digest-v1',
    disabledCapability: 'all-entrypoints-rejected-and-disclosed-v1',
  }),
  verifier: Object.freeze({
    candidateExecution: 'repository-commit-target-closure-v1',
    protectedWorkflow: 'workflow-job-main-ref-v1',
    supportDeclaration: 'd04-and-approved-registry-digest-v1',
  }),
  runner: Object.freeze({
    runnerId: L2_NATIVE_CONFORMANCE_RUNNER_ID_V1,
    workflowPath: L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
    workflowJob: L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
    retainedOutput: 'metadata-digests-only-v1',
  }),
  scheduler: Object.freeze({
    matrix: 'source-owned-distribution-targets-v1',
    retries: 'new-run-attempt-identity-required-v1',
  }),
  isolation: Object.freeze({
    credentials: 'not-required-v1',
    output: 'no-probe-body-no-archive-path-no-child-output-v1',
  }),
});

export function buildL2NativeConformanceEvaluatorV1(): L2NativeConformanceEvaluatorIdentityV1 {
  return buildL2NativeConformanceEvaluatorIdentityV1({
    ...L2_NATIVE_CONFORMANCE_EVALUATOR_PROVENANCE_V1,
    suite: buildL2NativeConformanceSuiteV1(),
  });
}

export const L2_NATIVE_DIAGNOSTIC_STATES_V1 = [
  'blocked',
  'failed',
  'qualified',
  'unsupported',
  'verified_disabled',
] as const;
export type L2NativeDiagnosticStateV1 = (typeof L2_NATIVE_DIAGNOSTIC_STATES_V1)[number];

export const L2_NATIVE_DIAGNOSTIC_REASON_CODES_V1 = [
  'disabled_entrypoint_rejection_incomplete',
  'disabled_public_disclosure_inconsistent',
  'native_assertion_failed',
  'not_observed',
  'platform_probe_not_conforming',
  'qualified_native_observation',
  'source_not_supported',
  'verified_disabled_complete',
] as const;
export type L2NativeDiagnosticReasonCodeV1 = (typeof L2_NATIVE_DIAGNOSTIC_REASON_CODES_V1)[number];

const resultV1Schema = z
  .object({
    caseId: z.enum(L2_NATIVE_CONFORMANCE_CASE_IDS_V1 as [string, ...string[]]),
    status: z.enum(L2_NATIVE_DIAGNOSTIC_STATES_V1),
    reasonCode: z.enum(L2_NATIVE_DIAGNOSTIC_REASON_CODES_V1),
    observationDigest: digestSchema,
  })
  .strict();
export type L2NativeConformanceResultV1 = z.infer<typeof resultV1Schema>;

const evaluatorReportInputV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceEvaluatorReportV1'),
    version: z.literal(1),
    evaluator: l2NativeConformanceEvaluatorIdentityV1Schema,
    observations: z.array(l2NativeConformanceAdapterObservationV1Schema),
  })
  .strict()
  .superRefine((value, context) => {
    const caseIds = value.observations.map((observation) => observation.case.caseId);
    if (
      caseIds.length !== L2_NATIVE_CONFORMANCE_CASE_IDS_V1.length ||
      !caseIds.every((caseId, index) => caseId === L2_NATIVE_CONFORMANCE_CASE_IDS_V1[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['observations'],
        message:
          'L2 observations must contain the exact code-point-sorted platform/capability inventory',
      });
    }
    const suite = buildL2NativeConformanceSuiteV1();
    if (value.evaluator.suiteDigest !== suite.suiteDigest) {
      context.addIssue({
        code: 'custom',
        path: ['evaluator', 'suiteDigest'],
        message: 'L2 evaluator must bind the current source-owned native suite',
      });
    }
  });
export type L2NativeConformanceEvaluatorReportInputV1 = z.infer<
  typeof evaluatorReportInputV1Schema
>;

export const L2_NATIVE_EVALUATOR_REPORT_STATUSES_V1 = ['blocked', 'complete'] as const;
export type L2NativeEvaluatorReportStatusV1 =
  (typeof L2_NATIVE_EVALUATOR_REPORT_STATUSES_V1)[number];

const evaluatorReportMaterialV1Schema = evaluatorReportInputV1Schema
  .extend({
    results: z.array(resultV1Schema),
    blockedCaseIds: z.array(z.enum(L2_NATIVE_CONFORMANCE_CASE_IDS_V1 as [string, ...string[]])),
    status: z.enum(L2_NATIVE_EVALUATOR_REPORT_STATUSES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = deriveL2NativeConformanceReportFieldsV1(value.observations);
    const resultIds = value.results.map((result) => result.caseId);
    if (
      resultIds.length !== L2_NATIVE_CONFORMANCE_CASE_IDS_V1.length ||
      !resultIds.every((caseId, index) => caseId === L2_NATIVE_CONFORMANCE_CASE_IDS_V1[index])
    ) {
      context.addIssue({
        code: 'custom',
        path: ['results'],
        message: 'L2 report results must preserve the exact platform/capability inventory',
      });
    }
    if (
      value.results.length !== expected.results.length ||
      !value.results.every((result, index) => {
        const expectedResult = expected.results[index];
        return (
          expectedResult !== undefined &&
          result.caseId === expectedResult.caseId &&
          result.status === expectedResult.status &&
          result.reasonCode === expectedResult.reasonCode &&
          result.observationDigest === expectedResult.observationDigest
        );
      })
    ) {
      context.addIssue({
        code: 'custom',
        path: ['results'],
        message: 'L2 report results must derive from sealed adapter observations',
      });
    }
    if (JSON.stringify(value.blockedCaseIds) !== JSON.stringify(expected.blockedCaseIds)) {
      context.addIssue({
        code: 'custom',
        path: ['blockedCaseIds'],
        message: 'L2 blocked cases must derive from sealed adapter observations',
      });
    }
    if (value.status !== expected.status) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: `L2 evaluator report status mismatch: expected ${expected.status}`,
      });
    }
  });
export type L2NativeConformanceEvaluatorReportMaterialV1 = z.infer<
  typeof evaluatorReportMaterialV1Schema
>;

export function computeL2NativeConformanceEvaluatorReportDigestV1(
  material: L2NativeConformanceEvaluatorReportMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.evaluator-report.v1',
    canonicalJsonBytes(evaluatorReportMaterialV1Schema.parse(material)),
  );
}

export const l2NativeConformanceEvaluatorReportV1Schema = evaluatorReportMaterialV1Schema
  .extend({ reportDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { reportDigest, ...material } = value;
    const expected = computeL2NativeConformanceEvaluatorReportDigestV1(material);
    if (reportDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['reportDigest'],
        message: `L2 evaluator report digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceEvaluatorReportV1 = z.infer<
  typeof l2NativeConformanceEvaluatorReportV1Schema
>;

/**
 * `complete` means every platform/capability observation was reconstructed.
 * It is deliberately not an aggregate PASS: individual results can remain
 * `unsupported`, `verified_disabled`, or `failed` without becoming a release
 * conclusion.
 */
export function evaluateL2NativeConformanceCorpusV1(input: {
  evaluator: L2NativeConformanceEvaluatorIdentityV1;
  observations: readonly L2NativeConformanceAdapterObservationV1[];
}): L2NativeConformanceEvaluatorReportV1 {
  const parsed = evaluatorReportInputV1Schema.parse({
    schema: 'L2NativeConformanceEvaluatorReportV1',
    version: 1,
    evaluator: input.evaluator,
    observations: input.observations,
  });
  const derived = deriveL2NativeConformanceReportFieldsV1(parsed.observations);
  const material = evaluatorReportMaterialV1Schema.parse({ ...parsed, ...derived });
  return l2NativeConformanceEvaluatorReportV1Schema.parse({
    ...material,
    reportDigest: computeL2NativeConformanceEvaluatorReportDigestV1(material),
  });
}

export function parseL2NativeConformanceEvaluatorReportV1(
  value: unknown,
): L2NativeConformanceEvaluatorReportV1 {
  return l2NativeConformanceEvaluatorReportV1Schema.parse(value);
}

function deriveL2NativeConformanceReportFieldsV1(
  observations: readonly L2NativeConformanceAdapterObservationV1[],
): Pick<L2NativeConformanceEvaluatorReportMaterialV1, 'results' | 'blockedCaseIds' | 'status'> {
  const results = observations.map((observation) => deriveL2NativeConformanceResultV1(observation));
  const blockedCaseIds = results
    .filter((result) => result.status === 'blocked')
    .map((result) => result.caseId);
  return {
    results,
    blockedCaseIds,
    status: blockedCaseIds.length === 0 ? 'complete' : 'blocked',
  };
}

function deriveL2NativeConformanceResultV1(
  observation: L2NativeConformanceAdapterObservationV1,
): L2NativeConformanceResultV1 {
  const common = {
    caseId: observation.case.caseId,
    observationDigest: observation.observationDigest,
  } as const;
  if (observation.case.expectedDisposition === 'unsupported') {
    if (observation.observedOutcome === 'not_observed') {
      return { ...common, status: 'blocked', reasonCode: 'not_observed' };
    }
    if (observation.observedOutcome === 'failed') {
      return { ...common, status: 'failed', reasonCode: 'native_assertion_failed' };
    }
    return { ...common, status: 'unsupported', reasonCode: 'source_not_supported' };
  }
  if (observation.case.expectedDisposition === 'verified_disabled') {
    if (observation.observedOutcome === 'not_observed') {
      return { ...common, status: 'blocked', reasonCode: 'not_observed' };
    }
    if (observation.observedOutcome === 'passed') {
      return {
        ...common,
        status: 'verified_disabled',
        reasonCode: 'verified_disabled_complete',
      };
    }
    return {
      ...common,
      status: 'failed',
      reasonCode:
        observation.disabledProof === 'public_disclosure_inconsistent'
          ? 'disabled_public_disclosure_inconsistent'
          : observation.disabledProof === 'entrypoint_rejection_incomplete'
            ? 'disabled_entrypoint_rejection_incomplete'
            : 'native_assertion_failed',
    };
  }
  if (observation.observedOutcome === 'not_observed') {
    return { ...common, status: 'blocked', reasonCode: 'not_observed' };
  }
  if (observation.observedOutcome === 'failed') {
    return { ...common, status: 'failed', reasonCode: 'native_assertion_failed' };
  }
  if (observation.probe.outcome !== 'supported') {
    return { ...common, status: 'blocked', reasonCode: 'platform_probe_not_conforming' };
  }
  return { ...common, status: 'qualified', reasonCode: 'qualified_native_observation' };
}
