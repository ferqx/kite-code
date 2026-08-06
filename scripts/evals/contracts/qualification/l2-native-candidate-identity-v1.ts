import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import {
  type ReleaseArtifactIdentityV1,
  type ReleaseEvidenceExecutionIdentityV1,
  releaseArtifactIdentityV1Schema,
  releaseEvidenceExecutionIdentityV1Schema,
} from '../../../release/evidence-identity-primitives';
import {
  PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_ID_V1,
  PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_V1,
} from '../../../release/platform-capability-identity';
import {
  isQualificationSafeIdentifierV1,
  isQualificationSafeMetadataValueV1,
} from './evidence/metadata-safety-v1';
import {
  L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1,
  L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1,
  type L2NativeConformanceTargetV1,
  l2NativeConformanceTargetV1Schema,
} from './l2-native-conformance-schema-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L2 native candidate/execution identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

const observedRunnerV1Schema = z
  .object({
    runnerClass: identifierSchema,
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.enum(['arm64', 'x64']),
  })
  .strict();
export type L2NativeObservedRunnerV1 = z.infer<typeof observedRunnerV1Schema>;

function safeCanonicalArtifactMetadata(artifact: ReleaseArtifactIdentityV1): boolean {
  return (
    isQualificationSafeMetadataValueV1(artifact.canonicalRepository) &&
    isQualificationSafeMetadataValueV1(artifact.repositoryId) &&
    artifact.canonicalRepository === PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_V1 &&
    artifact.repositoryId === PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_ID_V1
  );
}

const candidateMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeCandidateIdentityV1'),
    version: z.literal(1),
    candidateId: identifierSchema,
    target: l2NativeConformanceTargetV1Schema,
    artifact: releaseArtifactIdentityV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!safeCanonicalArtifactMetadata(value.artifact)) {
      context.addIssue({
        code: 'custom',
        path: ['artifact'],
        message: 'L2 native candidate must bind the source-owned canonical repository identity',
      });
    }
    const expectedCandidateId = `l2-native-candidate:${value.target.distributionTargetId}:${value.artifact.payloadSha256}`;
    if (value.candidateId !== expectedCandidateId) {
      context.addIssue({
        code: 'custom',
        path: ['candidateId'],
        message: 'L2 native candidate ID must bind the exact target and archive digest',
      });
    }
  });

export type L2NativeCandidateIdentityMaterialV1 = z.infer<typeof candidateMaterialV1Schema>;

export function computeL2NativeCandidateIdentityDigestV1(
  material: L2NativeCandidateIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-candidate-identity.v1',
    canonicalJsonBytes(candidateMaterialV1Schema.parse(material)),
  );
}

export const l2NativeCandidateIdentityV1Schema = candidateMaterialV1Schema
  .extend({ candidateDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { candidateDigest, ...material } = value;
    const expected = computeL2NativeCandidateIdentityDigestV1(material);
    if (candidateDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['candidateDigest'],
        message: `L2 native candidate digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeCandidateIdentityV1 = z.infer<typeof l2NativeCandidateIdentityV1Schema>;

/**
 * The candidate identity retains only canonical artifact identity primitives
 * and a derived target ID. Archive locations, manifest bodies, binaries, and
 * workspace content have no field in this contract.
 */
export function buildL2NativeCandidateIdentityV1(input: {
  target: L2NativeConformanceTargetV1;
  artifact: ReleaseArtifactIdentityV1;
}): L2NativeCandidateIdentityV1 {
  const material = candidateMaterialV1Schema.parse({
    schema: 'L2NativeCandidateIdentityV1',
    version: 1,
    candidateId: `l2-native-candidate:${input.target.distributionTargetId}:${input.artifact.payloadSha256}`,
    target: input.target,
    artifact: input.artifact,
  });
  return l2NativeCandidateIdentityV1Schema.parse({
    ...material,
    candidateDigest: computeL2NativeCandidateIdentityDigestV1(material),
  });
}

function githubExecutionMetadataIsSafe(identity: ReleaseEvidenceExecutionIdentityV1): boolean {
  if (identity.source !== 'github_actions') return false;
  return [
    identity.canonicalRepository,
    identity.repositoryId,
    identity.workflowPath,
    identity.workflowRef,
    identity.ref,
    identity.job,
  ].every(isQualificationSafeMetadataValueV1);
}

const executionMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeExecutionV1'),
    version: z.literal(1),
    executionId: identifierSchema,
    target: l2NativeConformanceTargetV1Schema,
    observedRunner: observedRunnerV1Schema,
    identity: releaseEvidenceExecutionIdentityV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.identity.source !== 'github_actions') {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'source'],
        message:
          'L2 native execution requires the exact protected diagnostic GitHub execution source',
      });
      return;
    }
    const identity = value.identity;
    if (
      value.observedRunner.runnerClass !== value.target.runnerClass ||
      value.observedRunner.platform !== value.target.platform ||
      value.observedRunner.arch !== value.target.arch
    ) {
      context.addIssue({
        code: 'custom',
        path: ['observedRunner'],
        message:
          'L2 native observed runner class, platform, and arch must exactly match the source target',
      });
    }
    if (!githubExecutionMetadataIsSafe(identity)) {
      context.addIssue({
        code: 'custom',
        path: ['identity'],
        message: 'L2 native execution contains unsafe metadata',
      });
    }
    if (
      identity.canonicalRepository !== PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_V1 ||
      identity.repositoryId !== PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_ID_V1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['identity'],
        message: 'L2 native execution must bind the source-owned canonical repository identity',
      });
    }
    if (
      identity.workflowPath !== L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1 ||
      identity.job !== L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1 ||
      identity.ref !== 'refs/heads/main' ||
      identity.workflowRef !==
        `${identity.canonicalRepository}/${L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1}@refs/heads/main`
    ) {
      context.addIssue({
        code: 'custom',
        path: ['identity'],
        message:
          'L2 native execution must bind the exact protected diagnostic workflow, job, and ref',
      });
    }
    if (identity.workflowSha !== identity.commit) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'workflowSha'],
        message: 'L2 native workflow SHA must equal the candidate execution commit',
      });
    }
    if (Date.parse(identity.endedAt) < Date.parse(identity.startedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['identity', 'endedAt'],
        message: 'L2 native execution end time must not precede its start time',
      });
    }
    const expectedExecutionId = `l2-native-execution:${value.target.distributionTargetId}:${identity.runId}:${identity.runAttempt}`;
    if (value.executionId !== expectedExecutionId) {
      context.addIssue({
        code: 'custom',
        path: ['executionId'],
        message: 'L2 native execution ID must bind target, run ID, and run attempt',
      });
    }
  });

export type L2NativeExecutionMaterialV1 = z.infer<typeof executionMaterialV1Schema>;

export function computeL2NativeExecutionDigestV1(
  material: L2NativeExecutionMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-execution.v1',
    canonicalJsonBytes(executionMaterialV1Schema.parse(material)),
  );
}

export const l2NativeExecutionV1Schema = executionMaterialV1Schema
  .extend({ executionDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { executionDigest, ...material } = value;
    const expected = computeL2NativeExecutionDigestV1(material);
    if (executionDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['executionDigest'],
        message: `L2 native execution digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeExecutionV1 = z.infer<typeof l2NativeExecutionV1Schema>;

/**
 * This wrapper is intentionally separate from DiagnosticExecutionV1. Generic
 * AQ-2 verification continues to reject GitHub execution identities unless
 * the later L2-only provenance validator explicitly reconstructs this shape.
 */
export function buildL2NativeExecutionV1(input: {
  target: L2NativeConformanceTargetV1;
  observedRunner: L2NativeObservedRunnerV1;
  identity: ReleaseEvidenceExecutionIdentityV1;
}): L2NativeExecutionV1 {
  const identity = releaseEvidenceExecutionIdentityV1Schema.parse(input.identity);
  if (identity.source !== 'github_actions') {
    throw new Error('l2_native_execution_source_must_be_github_actions');
  }
  const material = executionMaterialV1Schema.parse({
    schema: 'L2NativeExecutionV1',
    version: 1,
    executionId: `l2-native-execution:${input.target.distributionTargetId}:${identity.runId}:${identity.runAttempt}`,
    target: input.target,
    observedRunner: input.observedRunner,
    identity,
  });
  return l2NativeExecutionV1Schema.parse({
    ...material,
    executionDigest: computeL2NativeExecutionDigestV1(material),
  });
}

export const L2_NATIVE_PLATFORM_PROBE_OUTCOMES_V1 = [
  'supported',
  'read_only_only',
  'excluded',
] as const;
export type L2NativePlatformProbeOutcomeV1 = (typeof L2_NATIVE_PLATFORM_PROBE_OUTCOMES_V1)[number];

/**
 * L2's own opaque independently-verified projection. It has no input
 * position for a legacy probe record, parser, or verifier result; a future
 * protected orchestrator may create this local metadata-only projection only
 * after completing its independently governed source checks.
 */
const l2NativeIndependentPlatformProjectionMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeIndependentPlatformProjectionV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    source: z
      .object({
        repository: z.string(),
        repositoryId: z.string(),
        headSha: z.string(),
        ref: z.string(),
        workflow: z.string(),
        workflowRef: z.string(),
        workflowSha: z.string(),
        runId: z.string(),
        runAttempt: z.string(),
        runnerClass: z.string(),
      })
      .strict(),
    probeDigest: digestSchema,
    outcome: z.enum(L2_NATIVE_PLATFORM_PROBE_OUTCOMES_V1),
    productionSupported: z.literal(false),
  })
  .strict();

export type L2NativeIndependentPlatformProjectionMaterialV1 = z.infer<
  typeof l2NativeIndependentPlatformProjectionMaterialV1Schema
>;

export function computeL2NativeIndependentPlatformProjectionDigestV1(
  material: L2NativeIndependentPlatformProjectionMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.independent-platform-projection.v1',
    canonicalJsonBytes(l2NativeIndependentPlatformProjectionMaterialV1Schema.parse(material)),
  );
}

export const l2NativeIndependentPlatformProjectionV1Schema =
  l2NativeIndependentPlatformProjectionMaterialV1Schema
    .extend({ projectionDigest: digestSchema })
    .strict()
    .superRefine((value, context) => {
      const { projectionDigest, ...material } = value;
      const expected = computeL2NativeIndependentPlatformProjectionDigestV1(material);
      if (projectionDigest !== expected) {
        context.addIssue({
          code: 'custom',
          path: ['projectionDigest'],
          message: `L2 independent platform projection digest mismatch: expected ${expected}`,
        });
      }
    });
export type L2NativeIndependentPlatformProjectionV1 = z.infer<
  typeof l2NativeIndependentPlatformProjectionV1Schema
>;

/** A local constructor for a future protected orchestrator; current CI never calls it. */
export function buildL2NativeIndependentPlatformProjectionV1(
  material: L2NativeIndependentPlatformProjectionMaterialV1,
): L2NativeIndependentPlatformProjectionV1 {
  const parsed = l2NativeIndependentPlatformProjectionMaterialV1Schema.parse(material);
  return l2NativeIndependentPlatformProjectionV1Schema.parse({
    ...parsed,
    projectionDigest: computeL2NativeIndependentPlatformProjectionDigestV1(parsed),
  });
}

export const L2_NATIVE_INDEPENDENT_PLATFORM_PROJECTION_PROVENANCE_V1 = Object.freeze({
  contract: 'l2-native-independent-platform-projection-v1',
  sourceClosure: 'exact-github-execution-metadata-v1',
  retainedOutput: 'opaque-probe-digest-and-outcome-v1',
  productionSupport: 'false-only-v1',
});
export const L2_NATIVE_INDEPENDENT_PLATFORM_PROJECTION_VERIFIER_DIGEST_V1 = sha256DomainSeparated(
  'kite.qualification.l2.independent-platform-projection-verifier.v1',
  canonicalJsonBytes(L2_NATIVE_INDEPENDENT_PLATFORM_PROJECTION_PROVENANCE_V1),
);

const verifiedProbeMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeVerifiedProbeBindingV1'),
    version: z.literal(1),
    target: l2NativeConformanceTargetV1Schema,
    executionDigest: digestSchema,
    probeDigest: digestSchema,
    platformVerifierDigest: digestSchema,
    outcome: z.enum(L2_NATIVE_PLATFORM_PROBE_OUTCOMES_V1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.platformVerifierDigest !== L2_NATIVE_INDEPENDENT_PLATFORM_PROJECTION_VERIFIER_DIGEST_V1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['platformVerifierDigest'],
        message: 'L2 verified probe must bind the fixed independent projection contract',
      });
    }
  });
export type L2NativeVerifiedProbeBindingMaterialV1 = z.infer<typeof verifiedProbeMaterialV1Schema>;

export function computeL2NativeVerifiedProbeBindingDigestV1(
  material: L2NativeVerifiedProbeBindingMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-verified-probe-binding.v1',
    canonicalJsonBytes(verifiedProbeMaterialV1Schema.parse(material)),
  );
}

/**
 * This is a metadata-only projection of an independently verified platform
 * probe. The original probe body, exact OS/build values, limitations, and
 * output logs must remain outside this diagnostic receipt.
 */
export const l2NativeVerifiedProbeBindingV1Schema = verifiedProbeMaterialV1Schema
  .extend({ probeBindingDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { probeBindingDigest, ...material } = value;
    const expected = computeL2NativeVerifiedProbeBindingDigestV1(material);
    if (probeBindingDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['probeBindingDigest'],
        message: `L2 verified probe binding digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeVerifiedProbeBindingV1 = z.infer<typeof l2NativeVerifiedProbeBindingV1Schema>;

function buildL2NativeVerifiedProbeBindingV1(input: {
  target: L2NativeConformanceTargetV1;
  execution: L2NativeExecutionV1;
  probeDigest: `sha256:${string}`;
  outcome: L2NativePlatformProbeOutcomeV1;
}): L2NativeVerifiedProbeBindingV1 {
  const execution = l2NativeExecutionV1Schema.parse(input.execution);
  const target = l2NativeConformanceTargetV1Schema.parse(input.target);
  if (execution.target.distributionTargetId !== target.distributionTargetId) {
    throw new Error('l2_native_probe_execution_target_mismatch');
  }
  const material = verifiedProbeMaterialV1Schema.parse({
    schema: 'L2NativeVerifiedProbeBindingV1',
    version: 1,
    target,
    executionDigest: execution.executionDigest,
    probeDigest: input.probeDigest,
    platformVerifierDigest: L2_NATIVE_INDEPENDENT_PLATFORM_PROJECTION_VERIFIER_DIGEST_V1,
    outcome: input.outcome,
  });
  return l2NativeVerifiedProbeBindingV1Schema.parse({
    ...material,
    probeBindingDigest: computeL2NativeVerifiedProbeBindingDigestV1(material),
  });
}

/**
 * Future protected-workflow adapter for L2's opaque independently-verified
 * projection. It closes every formal GitHub source field to the already
 * sealed L2 execution before deriving the opaque binding. The current CI
 * runner intentionally does not call this path: without a non-forgeable
 * atomic governance control plane it emits only its blocked transport.
 *
 * The returned value contains only digests and the derived outcome; neither
 * the raw probe nor the verifier report is retained.
 */
export function deriveL2NativeVerifiedProbeBindingFromIndependentProjectionV1(input: {
  execution: L2NativeExecutionV1;
  independentProjection: unknown;
}): L2NativeVerifiedProbeBindingV1 {
  const execution = l2NativeExecutionV1Schema.parse(input.execution);
  const projection = l2NativeIndependentPlatformProjectionV1Schema.parse(
    input.independentProjection,
  );
  if (execution.identity.source !== 'github_actions') {
    throw new Error('l2_native_verified_platform_execution_source_mismatch');
  }
  const source = projection.source;
  const identity = execution.identity;
  if (
    source.repository !== identity.canonicalRepository ||
    source.repositoryId !== identity.repositoryId ||
    source.headSha !== identity.commit ||
    source.ref !== identity.ref ||
    source.workflow !== identity.workflowPath ||
    source.workflowRef !== identity.workflowRef ||
    source.workflowSha !== identity.workflowSha ||
    source.runId !== identity.runId ||
    source.runAttempt !== String(identity.runAttempt) ||
    source.runnerClass !== execution.observedRunner.runnerClass ||
    source.runnerClass !== execution.target.runnerClass
  ) {
    throw new Error('l2_native_verified_platform_source_execution_mismatch');
  }
  if (projection.productionSupported !== false) {
    throw new Error('l2_native_verified_platform_production_support_forbidden');
  }
  return buildL2NativeVerifiedProbeBindingV1({
    target: execution.target,
    execution,
    probeDigest: projection.probeDigest as `sha256:${string}`,
    outcome: projection.outcome,
  });
}
