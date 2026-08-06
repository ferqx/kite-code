import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { evidenceGovernanceBindingV1Schema } from './evidence/governance-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import {
  l2NativeCandidateIdentityV1Schema,
  l2NativeExecutionV1Schema,
  l2NativeVerifiedProbeBindingV1Schema,
} from './l2-native-candidate-identity-v1';
import {
  type L2NativeConformanceAdapterObservationV1,
  l2NativeConformanceAdapterObservationV1Schema,
} from './l2-native-conformance-adapter-v1';
import {
  buildL2NativeConformanceEvaluatorV1,
  type L2NativeConformanceEvaluatorReportV1,
  l2NativeConformanceEvaluatorReportV1Schema,
} from './l2-native-conformance-evaluator-v1';
import {
  buildL2NativeConformanceSourceRegistryV1,
  buildL2NativeConformanceSuiteV1,
  L2_NATIVE_CONFORMANCE_SUITE_ID_V1,
  type L2NativeConformanceScopeV1,
  l2NativeConformanceCaseV1Schema,
  l2NativeConformanceEvaluatorIdentityV1Schema,
  l2NativeConformanceScopeV1Schema,
  l2NativeConformanceSuiteV1Schema,
} from './l2-native-conformance-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L2 native receipt identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * Context reconstruction is the L2-only handoff boundary for a later
 * specialized verifier. It deliberately contains no AgentQualificationEvidence
 * record and does not relax the generic GitHub-execution rejection path.
 */
const provenanceContextMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceProvenanceContextV1'),
    version: z.literal(1),
    matrixDigest: digestSchema,
    sourceRegistryDigest: digestSchema,
    suite: l2NativeConformanceSuiteV1Schema,
    evaluator: l2NativeConformanceEvaluatorIdentityV1Schema,
    governance: evidenceGovernanceBindingV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    const sourceRegistry = buildL2NativeConformanceSourceRegistryV1();
    if (value.sourceRegistryDigest !== sourceRegistry.sourceRegistryDigest) {
      context.addIssue({
        code: 'custom',
        path: ['sourceRegistryDigest'],
        message: 'L2 provenance must bind the current source support/target registry digest',
      });
    }
    if (
      value.suite.suiteId !== L2_NATIVE_CONFORMANCE_SUITE_ID_V1 ||
      value.suite.sourceRegistryDigest !== value.sourceRegistryDigest ||
      value.evaluator.suiteDigest !== value.suite.suiteDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['suite'],
        message: 'L2 provenance suite/evaluator identities must remain closed and mutually bound',
      });
    }
    if (value.governance.retentionClass !== 'protected_ci_retained') {
      context.addIssue({
        code: 'custom',
        path: ['governance', 'retentionClass'],
        message: 'L2 protected workflow receipts require protected CI retention metadata',
      });
    }
  });

export type L2NativeConformanceProvenanceContextMaterialV1 = z.infer<
  typeof provenanceContextMaterialV1Schema
>;

export function computeL2NativeConformanceProvenanceContextDigestV1(
  material: L2NativeConformanceProvenanceContextMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.provenance-context.v1',
    canonicalJsonBytes(provenanceContextMaterialV1Schema.parse(material)),
  );
}

export const l2NativeConformanceProvenanceContextV1Schema = provenanceContextMaterialV1Schema
  .extend({ contextDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { contextDigest, ...material } = value;
    const expected = computeL2NativeConformanceProvenanceContextDigestV1(material);
    if (contextDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['contextDigest'],
        message: `L2 provenance context digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceProvenanceContextV1 = z.infer<
  typeof l2NativeConformanceProvenanceContextV1Schema
>;

export function reconstructL2NativeConformanceProvenanceV1(input: {
  matrixDigest: `sha256:${string}`;
  governance: z.infer<typeof evidenceGovernanceBindingV1Schema>;
}): L2NativeConformanceProvenanceContextV1 {
  const suite = buildL2NativeConformanceSuiteV1();
  const material = provenanceContextMaterialV1Schema.parse({
    schema: 'L2NativeConformanceProvenanceContextV1',
    version: 1,
    matrixDigest: input.matrixDigest,
    sourceRegistryDigest: buildL2NativeConformanceSourceRegistryV1().sourceRegistryDigest,
    suite,
    evaluator: buildL2NativeConformanceEvaluatorV1(),
    governance: input.governance,
  });
  return l2NativeConformanceProvenanceContextV1Schema.parse({
    ...material,
    contextDigest: computeL2NativeConformanceProvenanceContextDigestV1(material),
  });
}

const receiptMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceReceiptV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    receiptId: identifierSchema,
    sourceSurfaceId: identifierSchema,
    featureId: z.string().regex(FEATURE_ID),
    assertionId: identifierSchema,
    sourceBindingDigest: digestSchema,
    scope: l2NativeConformanceScopeV1Schema,
    case: l2NativeConformanceCaseV1Schema,
    candidate: l2NativeCandidateIdentityV1Schema,
    execution: l2NativeExecutionV1Schema,
    probe: l2NativeVerifiedProbeBindingV1Schema,
    provenanceContextDigest: digestSchema,
    matrixDigest: digestSchema,
    suiteId: z.literal(L2_NATIVE_CONFORMANCE_SUITE_ID_V1),
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    corpusDigest: digestSchema,
    evaluatorDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    platformVerifierDigest: digestSchema,
    evaluatorReportDigest: digestSchema,
    governance: evidenceGovernanceBindingV1Schema,
    outcome: z.enum(['blocked', 'failed', 'qualified', 'unsupported', 'verified_disabled']),
    reasonCode: identifierSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scope.platformIdentity !== value.case.target.distributionTargetId ||
      value.scope.entrypoint !== value.case.entrypoint ||
      value.scope.releaseProfileDigest !== value.candidate.artifact.profileDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['scope'],
        message:
          'L2 receipt scope must bind its exact platform, entrypoint, and candidate profile digest',
      });
    }
    if (
      value.candidate.target.distributionTargetId !== value.case.target.distributionTargetId ||
      value.execution.target.distributionTargetId !== value.case.target.distributionTargetId ||
      value.probe.target.distributionTargetId !== value.case.target.distributionTargetId ||
      value.probe.executionDigest !== value.execution.executionDigest
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'L2 receipt candidate, execution, probe, and case must bind the same platform target',
      });
    }
    if (value.platformVerifierDigest !== value.probe.platformVerifierDigest) {
      context.addIssue({
        code: 'custom',
        path: ['platformVerifierDigest'],
        message: 'L2 receipt must bind the independent platform verifier used by its probe',
      });
    }
    if (
      value.execution.identity.source !== 'github_actions' ||
      value.execution.identity.commit !== value.candidate.artifact.commit ||
      value.execution.identity.canonicalRepository !==
        value.candidate.artifact.canonicalRepository ||
      value.execution.identity.repositoryId !== value.candidate.artifact.repositoryId
    ) {
      context.addIssue({
        code: 'custom',
        path: ['execution'],
        message: 'L2 receipt execution must bind the exact candidate repository and commit',
      });
    }
    if (value.assertionId !== value.case.caseId) {
      context.addIssue({
        code: 'custom',
        path: ['assertionId'],
        message:
          'L2 receipt assertion ID must be the exact source-derived platform/capability case ID',
      });
    }
    const expectedReceiptId = `l2-native-receipt:${value.sourceSurfaceId}:${value.case.caseId}:${value.assertionId}`;
    if (value.receiptId !== expectedReceiptId) {
      context.addIssue({
        code: 'custom',
        path: ['receiptId'],
        message: 'L2 receipt ID must derive from source surface, case, and assertion',
      });
    }
    if (value.governance.retentionClass !== 'protected_ci_retained') {
      context.addIssue({
        code: 'custom',
        path: ['governance', 'retentionClass'],
        message: 'L2 receipt requires protected CI retention metadata',
      });
    }
  });

export type L2NativeConformanceReceiptMaterialV1 = z.infer<typeof receiptMaterialV1Schema>;

export function computeL2NativeConformanceReceiptDigestV1(
  material: L2NativeConformanceReceiptMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.receipt.v1',
    canonicalJsonBytes(receiptMaterialV1Schema.parse(material)),
  );
}

/**
 * This opaque receipt is designed only to be embedded as a receipt binding in
 * a separately constructed AgentQualificationEvidenceV1 record. It is not an
 * aggregate evidence type and cannot stand in for one.
 */
export const l2NativeConformanceReceiptV1Schema = receiptMaterialV1Schema
  .extend({ receiptDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { receiptDigest, ...material } = value;
    const parsed = receiptMaterialV1Schema.safeParse(material);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        context.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
      return;
    }
    const expected = computeL2NativeConformanceReceiptDigestV1(parsed.data);
    if (receiptDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['receiptDigest'],
        message: `L2 receipt digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceReceiptV1 = z.infer<typeof l2NativeConformanceReceiptV1Schema>;

export function buildL2NativeConformanceReceiptV1(input: {
  sourceSurfaceId: string;
  featureId: string;
  assertionId: string;
  sourceBindingDigest: `sha256:${string}`;
  scope: L2NativeConformanceScopeV1;
  provenance: L2NativeConformanceProvenanceContextV1;
  observation: L2NativeConformanceAdapterObservationV1;
  evaluatorReport: L2NativeConformanceEvaluatorReportV1;
}): L2NativeConformanceReceiptV1 {
  const provenance = l2NativeConformanceProvenanceContextV1Schema.parse(input.provenance);
  const observation = l2NativeConformanceAdapterObservationV1Schema.parse(input.observation);
  const evaluatorReport = l2NativeConformanceEvaluatorReportV1Schema.parse(input.evaluatorReport);
  const result = evaluatorReport.results.find((entry) => entry.caseId === observation.case.caseId);
  if (!result || result.observationDigest !== observation.observationDigest) {
    throw new Error('l2_native_receipt_evaluator_observation_mismatch');
  }
  if (
    evaluatorReport.evaluator.evaluatorDigest !== provenance.evaluator.evaluatorDigest ||
    evaluatorReport.evaluator.suiteDigest !== provenance.suite.suiteDigest
  ) {
    throw new Error('l2_native_receipt_provenance_evaluator_mismatch');
  }
  if (input.assertionId !== observation.case.caseId) {
    throw new Error('l2_native_receipt_assertion_case_mismatch');
  }
  const material = receiptMaterialV1Schema.parse({
    schema: 'L2NativeConformanceReceiptV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    receiptId: `l2-native-receipt:${input.sourceSurfaceId}:${observation.case.caseId}:${input.assertionId}`,
    sourceSurfaceId: input.sourceSurfaceId,
    featureId: input.featureId,
    assertionId: input.assertionId,
    sourceBindingDigest: input.sourceBindingDigest,
    scope: input.scope,
    case: observation.case,
    candidate: observation.candidate,
    execution: observation.execution,
    probe: observation.probe,
    provenanceContextDigest: provenance.contextDigest,
    matrixDigest: provenance.matrixDigest,
    suiteId: provenance.suite.suiteId,
    suiteDigest: provenance.suite.suiteDigest,
    oracleDigest: provenance.evaluator.oracleDigest,
    corpusDigest: provenance.suite.corpusDigest,
    evaluatorDigest: provenance.evaluator.evaluatorDigest,
    verifierDigest: provenance.evaluator.verifierDigest,
    runnerDigest: provenance.evaluator.runnerDigest,
    platformVerifierDigest: observation.probe.platformVerifierDigest,
    evaluatorReportDigest: evaluatorReport.reportDigest,
    governance: provenance.governance,
    outcome: result.status,
    reasonCode: result.reasonCode,
  });
  return l2NativeConformanceReceiptV1Schema.parse({
    ...material,
    receiptDigest: computeL2NativeConformanceReceiptDigestV1(material),
  });
}

export const l2NativeConformanceReceiptBindingV1Schema = z
  .object({ receiptId: identifierSchema, receiptDigest: digestSchema })
  .strict();
export type L2NativeConformanceReceiptBindingV1 = z.infer<
  typeof l2NativeConformanceReceiptBindingV1Schema
>;

export function l2NativeConformanceReceiptBindingV1(
  receipt: L2NativeConformanceReceiptV1,
): L2NativeConformanceReceiptBindingV1 {
  const parsed = l2NativeConformanceReceiptV1Schema.parse(receipt);
  return l2NativeConformanceReceiptBindingV1Schema.parse({
    receiptId: parsed.receiptId,
    receiptDigest: parsed.receiptDigest,
  });
}
