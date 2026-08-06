import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_V1,
  PRODUCTION_DISTRIBUTION_TARGETS_V1,
  type ProductionDistributionTargetV1,
  SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1,
} from '../../../../src/core/config/release-surface-registry';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { resolveOssReleaseTarget } from '../../../release/oss-candidate';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L2 native-conformance identifier must not contain an endpoint, absolute path, or unsafe metadata',
});

/**
 * AQ-7 is a diagnostic native-environment observation only. These identifiers
 * deliberately name no production-control path or admission evaluator.
 */
export const L2_NATIVE_CONFORMANCE_SUITE_ID_V1 = 'qualification-l2-native-conformance-v1';
export const L2_NATIVE_CONFORMANCE_EVALUATOR_ID_V1 =
  'qualification-l2-native-conformance-evaluator-v1';
export const L2_NATIVE_CONFORMANCE_RUNNER_ID_V1 = 'qualification-l2-native-conformance-runner-v1';
export const L2_NATIVE_CONFORMANCE_WORKFLOW_PATH_V1 =
  '.github/workflows/native-conformance-qualification.yml';
export const L2_NATIVE_CONFORMANCE_WORKFLOW_JOB_V1 = 'native-conformance';

export const L2_NATIVE_CONFORMANCE_CAPABILITY_IDS_V1 = [
  'candidate_archive_integrity',
  'candidate_cli_smoke',
  'candidate_tui_smoke',
  'native_platform_capability',
  'standalone_keyring_unavailable',
] as const;
export type L2NativeConformanceCapabilityIdV1 =
  (typeof L2_NATIVE_CONFORMANCE_CAPABILITY_IDS_V1)[number];
const capabilityIdSchema = z.enum(L2_NATIVE_CONFORMANCE_CAPABILITY_IDS_V1);

export const L2_NATIVE_CONFORMANCE_ENTRYPOINTS_V1 = ['cli', 'installer', 'runtime', 'tui'] as const;
export type L2NativeConformanceEntrypointV1 = (typeof L2_NATIVE_CONFORMANCE_ENTRYPOINTS_V1)[number];
const entrypointSchema = z.enum(L2_NATIVE_CONFORMANCE_ENTRYPOINTS_V1);

export const L2_NATIVE_EXPECTED_DISPOSITIONS_V1 = [
  'positive_native_evidence',
  'verified_disabled',
  'unsupported',
] as const;
export type L2NativeExpectedDispositionV1 = (typeof L2_NATIVE_EXPECTED_DISPOSITIONS_V1)[number];
const expectedDispositionSchema = z.enum(L2_NATIVE_EXPECTED_DISPOSITIONS_V1);

export interface L2NativeConformanceTargetV1 {
  distributionTargetId: string;
  candidateTargetId: string;
  platform: 'darwin' | 'linux' | 'win32';
  arch: 'arm64' | 'x64';
  nativeRunner: string;
  runnerClass: string;
}

function nodePlatformForDistributionTargetV1(
  platform: ProductionDistributionTargetV1['platform'],
): 'darwin' | 'linux' | 'win32' {
  switch (platform) {
    case 'macos':
      return 'darwin';
    case 'linux':
      return 'linux';
    case 'windows':
      return 'win32';
  }
}

/**
 * This is a projection from the two product-owned registries, not a parallel
 * target list. `resolveOssReleaseTarget` supplies the candidate archive target
 * from the candidate builder's public source of truth.
 */
function deriveL2NativeConformanceTargetsV1(): readonly L2NativeConformanceTargetV1[] {
  return Object.freeze(
    PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_V1.map((distributionTargetId) => {
      const distribution = PRODUCTION_DISTRIBUTION_TARGETS_V1[distributionTargetId];
      const platform = nodePlatformForDistributionTargetV1(distribution.platform);
      const candidate = resolveOssReleaseTarget(platform, distribution.arch);
      if (candidate.os !== platform || candidate.arch !== distribution.arch) {
        throw new Error('l2_native_target_projection_mismatch');
      }
      return Object.freeze({
        distributionTargetId: distribution.identity,
        candidateTargetId: candidate.id,
        platform,
        arch: candidate.arch,
        nativeRunner: distribution.nativeRunner,
        // The class is algebraically bound to the same source-owned target
        // identity. It is not an independently maintained runner registry.
        runnerClass: `${distribution.identity}-github-hosted`,
      });
    }),
  );
}

export const L2_NATIVE_CONFORMANCE_TARGETS_V1 = deriveL2NativeConformanceTargetsV1();

const TARGET_BY_DISTRIBUTION_ID_V1 = new Map(
  L2_NATIVE_CONFORMANCE_TARGETS_V1.map((target) => [target.distributionTargetId, target]),
);

function sameTarget(
  left: L2NativeConformanceTargetV1,
  right: L2NativeConformanceTargetV1,
): boolean {
  return (
    left.distributionTargetId === right.distributionTargetId &&
    left.candidateTargetId === right.candidateTargetId &&
    left.platform === right.platform &&
    left.arch === right.arch &&
    left.nativeRunner === right.nativeRunner &&
    left.runnerClass === right.runnerClass
  );
}

/** A target is valid only when it is the exact source-derived projection. */
export const l2NativeConformanceTargetV1Schema = z
  .object({
    distributionTargetId: identifierSchema,
    candidateTargetId: identifierSchema,
    platform: z.enum(['darwin', 'linux', 'win32']),
    arch: z.enum(['arm64', 'x64']),
    nativeRunner: identifierSchema,
    runnerClass: identifierSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected = TARGET_BY_DISTRIBUTION_ID_V1.get(value.distributionTargetId);
    if (!expected || !sameTarget(value, expected)) {
      context.addIssue({
        code: 'custom',
        message:
          'L2 native target must be the exact source-owned distribution/candidate projection',
      });
    }
  });

export type L2NativeConformanceTargetRecordV1 = z.infer<typeof l2NativeConformanceTargetV1Schema>;

function exactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

function sourceDeclaredEffectfulTargetIdsV1(): readonly string[] {
  return Object.freeze([...SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1].sort());
}

const d04SupportMatrixSourceV1Schema = z
  .object({
    version: z.literal(1),
    decisionId: z.literal('D-04'),
    status: z.literal('accepted_empty_support_set'),
    selectedNetworkMode: z.literal('off'),
    productionSupportedPlatforms: z.array(identifierSchema).length(0),
  })
  .passthrough();

/**
 * AQ-7 reads only the currently approved, empty D-04 registry as source data.
 * This intentionally avoids importing the runtime admission loader (and its
 * execution-boundary dependency graph). A non-empty support set must arrive
 * through a separately reviewed contract revision, never through an L2
 * diagnostic fallback.
 */
const l2NativeApprovedExecutionRegistryV1Schema = z
  .object({
    version: z.literal(1),
    decisionId: z.literal('D-04'),
    revision: z.literal('d04-empty-2026-07-31'),
    status: z.literal('accepted_empty_support_set'),
    selectedNetworkMode: z.literal('off'),
    evidenceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    digest: z.literal('sha256:6c33ab090cd138d0eb26cdcbdc97ef92bc794adb3b1690fd7e8d2d24a4510656'),
    qualifications: z.array(z.never()).length(0),
  })
  .strict();
export type L2NativeApprovedExecutionRegistryV1 = z.infer<
  typeof l2NativeApprovedExecutionRegistryV1Schema
>;

export function parseL2NativeApprovedExecutionRegistryV1(
  value: unknown,
): L2NativeApprovedExecutionRegistryV1 {
  return l2NativeApprovedExecutionRegistryV1Schema.parse(value);
}

function readL2NativeApprovedExecutionRegistryV1(): L2NativeApprovedExecutionRegistryV1 {
  const registryUrl = new URL(
    '../../../../release/platform-capabilities/approved-execution-qualifications-v1.json',
    import.meta.url,
  );
  return parseL2NativeApprovedExecutionRegistryV1(
    JSON.parse(readFileSync(fileURLToPath(registryUrl), 'utf8')),
  );
}

const supportDeclarationMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceSupportDeclarationV1'),
    version: z.literal(1),
    supportMatrixDigest: digestSchema,
    approvedQualificationRegistryDigest: digestSchema,
    declaredEffectfulTargetIds: z.array(identifierSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const declared = value.declaredEffectfulTargetIds;
    if (
      !exactInventory(declared, [...declared].sort()) ||
      new Set(declared).size !== declared.length ||
      declared.some((targetId) => !TARGET_BY_DISTRIBUTION_ID_V1.has(targetId))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['declaredEffectfulTargetIds'],
        message: 'declared effectful target identities must be sorted, unique, and source-known',
      });
    }
  });
export type L2NativeConformanceSupportDeclarationMaterialV1 = z.infer<
  typeof supportDeclarationMaterialV1Schema
>;

export function computeL2NativeConformanceSupportDeclarationDigestV1(
  material: L2NativeConformanceSupportDeclarationMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.support-declaration.v1',
    canonicalJsonBytes(supportDeclarationMaterialV1Schema.parse(material)),
  );
}

export const l2NativeConformanceSupportDeclarationV1Schema = supportDeclarationMaterialV1Schema
  .extend({ supportDeclarationDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { supportDeclarationDigest, ...material } = value;
    const expected = computeL2NativeConformanceSupportDeclarationDigestV1(material);
    if (supportDeclarationDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['supportDeclarationDigest'],
        message: `L2 support declaration digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceSupportDeclarationV1 = z.infer<
  typeof l2NativeConformanceSupportDeclarationV1Schema
>;

/**
 * The public D-04 matrix is read only to bind its canonical digest. Its URL,
 * target rationale, historic artifact names, and any environment details never
 * enter a receipt. The approved qualification registry is parsed here as a
 * strict, exact-empty, pinned data artifact before its digest is exposed.
 */
export function buildL2NativeConformanceSupportDeclarationV1(): L2NativeConformanceSupportDeclarationV1 {
  const matrixUrl = new URL(
    '../../../../release/platform-capabilities/support-matrix-v1.json',
    import.meta.url,
  );
  const matrix = d04SupportMatrixSourceV1Schema.parse(
    JSON.parse(readFileSync(fileURLToPath(matrixUrl), 'utf8')),
  );
  const approved = readL2NativeApprovedExecutionRegistryV1();
  const declaredEffectfulTargetIds = sourceDeclaredEffectfulTargetIdsV1();
  if (declaredEffectfulTargetIds.length > 0 || approved.qualifications.length > 0) {
    throw new Error('l2_native_support_declaration_requires_new_approved_contract');
  }
  const material = supportDeclarationMaterialV1Schema.parse({
    schema: 'L2NativeConformanceSupportDeclarationV1',
    version: 1,
    supportMatrixDigest: sha256DomainSeparated(
      'kite.qualification.l2.native-conformance.d04-support-matrix.v1',
      canonicalJsonBytes(matrix),
    ),
    approvedQualificationRegistryDigest: approved.digest,
    declaredEffectfulTargetIds,
  });
  return l2NativeConformanceSupportDeclarationV1Schema.parse({
    ...material,
    supportDeclarationDigest: computeL2NativeConformanceSupportDeclarationDigestV1(material),
  });
}

export function isL2NativeTargetEffectfullyDeclaredV1(
  target: L2NativeConformanceTargetV1,
): boolean {
  const parsed = l2NativeConformanceTargetV1Schema.parse(target);
  return sourceDeclaredEffectfulTargetIdsV1().includes(parsed.distributionTargetId);
}

export function l2NativeEntrypointForCapabilityV1(
  capabilityId: L2NativeConformanceCapabilityIdV1,
): L2NativeConformanceEntrypointV1 {
  switch (capabilityId) {
    case 'candidate_archive_integrity':
      return 'installer';
    case 'candidate_cli_smoke':
      return 'cli';
    case 'candidate_tui_smoke':
      return 'tui';
    case 'native_platform_capability':
    case 'standalone_keyring_unavailable':
      return 'runtime';
  }
}

/**
 * Positive native observations are demanded only for targets that product
 * source declares effectfully supported. The standalone keyring is an
 * intentionally unavailable capability, so it may only establish a complete
 * diagnostic disabled state rather than a positive capability claim.
 */
export function expectedL2NativeDispositionV1(
  target: L2NativeConformanceTargetV1,
  capabilityId: L2NativeConformanceCapabilityIdV1,
): L2NativeExpectedDispositionV1 {
  l2NativeConformanceTargetV1Schema.parse(target);
  if (capabilityId === 'standalone_keyring_unavailable') return 'verified_disabled';
  return isL2NativeTargetEffectfullyDeclaredV1(target) ? 'positive_native_evidence' : 'unsupported';
}

function caseIdFor(
  target: L2NativeConformanceTargetV1,
  capabilityId: L2NativeConformanceCapabilityIdV1,
) {
  return `l2-native:${target.distributionTargetId}:${capabilityId}:v1`;
}

export interface L2NativeConformanceCaseV1 {
  caseId: string;
  target: L2NativeConformanceTargetV1;
  capabilityId: L2NativeConformanceCapabilityIdV1;
  entrypoint: L2NativeConformanceEntrypointV1;
  expectedDisposition: L2NativeExpectedDispositionV1;
}

export const L2_NATIVE_CONFORMANCE_CASES_V1: readonly L2NativeConformanceCaseV1[] = Object.freeze(
  L2_NATIVE_CONFORMANCE_TARGETS_V1.flatMap((target) =>
    L2_NATIVE_CONFORMANCE_CAPABILITY_IDS_V1.map((capabilityId) => ({
      caseId: caseIdFor(target, capabilityId),
      target,
      capabilityId,
      entrypoint: l2NativeEntrypointForCapabilityV1(capabilityId),
      expectedDisposition: expectedL2NativeDispositionV1(target, capabilityId),
    })),
  ).sort((left, right) => left.caseId.localeCompare(right.caseId)),
);

export const L2_NATIVE_CONFORMANCE_CASE_IDS_V1 = Object.freeze(
  L2_NATIVE_CONFORMANCE_CASES_V1.map((entry) => entry.caseId),
);

const CASE_BY_ID_V1 = new Map(L2_NATIVE_CONFORMANCE_CASES_V1.map((entry) => [entry.caseId, entry]));

export const l2NativeConformanceCaseV1Schema = z
  .object({
    caseId: identifierSchema,
    target: l2NativeConformanceTargetV1Schema,
    capabilityId: capabilityIdSchema,
    entrypoint: entrypointSchema,
    expectedDisposition: expectedDispositionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected = CASE_BY_ID_V1.get(value.caseId);
    if (
      !expected ||
      !sameTarget(value.target, expected.target) ||
      value.capabilityId !== expected.capabilityId ||
      value.entrypoint !== expected.entrypoint ||
      value.expectedDisposition !== expected.expectedDisposition
    ) {
      context.addIssue({
        code: 'custom',
        message: 'L2 native case must be the exact source-derived platform/capability inventory',
      });
    }
  });
export type L2NativeConformanceCaseRecordV1 = z.infer<typeof l2NativeConformanceCaseV1Schema>;

/**
 * The receipt scope repeats only the platform, profile digest, and source
 * entrypoint needed to prevent a candidate/profile or entrypoint splice. It
 * carries no profile body, config value, or workspace material.
 */
export const l2NativeConformanceScopeV1Schema = z
  .object({
    platformIdentity: identifierSchema,
    releaseProfileDigest: digestSchema,
    entrypoint: entrypointSchema,
  })
  .strict();
export type L2NativeConformanceScopeV1 = z.infer<typeof l2NativeConformanceScopeV1Schema>;

export const l2NativeConformanceCorpusV1Schema = z
  .array(l2NativeConformanceCaseV1Schema)
  .superRefine((value, context) => {
    if (
      !exactInventory(
        value.map((entry) => entry.caseId),
        L2_NATIVE_CONFORMANCE_CASE_IDS_V1,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'L2 native corpus must contain the exact code-point-sorted platform/capability inventory',
      });
    }
  });
export type L2NativeConformanceCorpusV1 = z.infer<typeof l2NativeConformanceCorpusV1Schema>;

export function computeL2NativeConformanceCorpusDigestV1(
  corpus: L2NativeConformanceCorpusV1 = L2_NATIVE_CONFORMANCE_CASES_V1 as L2NativeConformanceCorpusV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.corpus.v1',
    canonicalJsonBytes(l2NativeConformanceCorpusV1Schema.parse(corpus)),
  );
}

const sourceRegistryMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceSourceRegistryV1'),
    version: z.literal(1),
    targets: z.array(l2NativeConformanceTargetV1Schema),
    declaredEffectfulTargetIds: z.array(identifierSchema),
    supportDeclarationDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      !exactInventory(
        value.targets.map((target) => target.distributionTargetId),
        PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_V1,
      ) ||
      !value.targets.every((target, index) =>
        sameTarget(target, L2_NATIVE_CONFORMANCE_TARGETS_V1[index]!),
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['targets'],
        message: 'L2 source registry target projection drifted from the product-owned registry',
      });
    }
    const declared = value.declaredEffectfulTargetIds;
    if (
      !exactInventory(declared, [...declared].sort()) ||
      new Set(declared).size !== declared.length ||
      declared.some((targetId) => !TARGET_BY_DISTRIBUTION_ID_V1.has(targetId))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['declaredEffectfulTargetIds'],
        message: 'declared effectful target identities must be sorted, unique, and source-known',
      });
    }
    if (
      value.supportDeclarationDigest !==
      buildL2NativeConformanceSupportDeclarationV1().supportDeclarationDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['supportDeclarationDigest'],
        message: 'L2 source registry must bind the current D-04 support declaration',
      });
    }
  });

export type L2NativeConformanceSourceRegistryMaterialV1 = z.infer<
  typeof sourceRegistryMaterialV1Schema
>;

export function computeL2NativeConformanceSourceRegistryDigestV1(
  material: L2NativeConformanceSourceRegistryMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.source-registry.v1',
    canonicalJsonBytes(sourceRegistryMaterialV1Schema.parse(material)),
  );
}

export const l2NativeConformanceSourceRegistryV1Schema = sourceRegistryMaterialV1Schema
  .extend({ sourceRegistryDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { sourceRegistryDigest, ...material } = value;
    const expected = computeL2NativeConformanceSourceRegistryDigestV1(material);
    if (sourceRegistryDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['sourceRegistryDigest'],
        message: `L2 source registry digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceSourceRegistryV1 = z.infer<
  typeof l2NativeConformanceSourceRegistryV1Schema
>;

export function buildL2NativeConformanceSourceRegistryV1(): L2NativeConformanceSourceRegistryV1 {
  const material = sourceRegistryMaterialV1Schema.parse({
    schema: 'L2NativeConformanceSourceRegistryV1',
    version: 1,
    targets: L2_NATIVE_CONFORMANCE_TARGETS_V1,
    declaredEffectfulTargetIds: sourceDeclaredEffectfulTargetIdsV1(),
    supportDeclarationDigest:
      buildL2NativeConformanceSupportDeclarationV1().supportDeclarationDigest,
  });
  return l2NativeConformanceSourceRegistryV1Schema.parse({
    ...material,
    sourceRegistryDigest: computeL2NativeConformanceSourceRegistryDigestV1(material),
  });
}

const suiteMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceSuiteV1'),
    version: z.literal(1),
    suiteId: z.literal(L2_NATIVE_CONFORMANCE_SUITE_ID_V1),
    sourceRegistryDigest: digestSchema,
    corpusDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceRegistryDigest !== buildL2NativeConformanceSourceRegistryV1().sourceRegistryDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['sourceRegistryDigest'],
        message: 'L2 suite must bind the current source-owned target registry',
      });
    }
    if (value.corpusDigest !== computeL2NativeConformanceCorpusDigestV1()) {
      context.addIssue({
        code: 'custom',
        path: ['corpusDigest'],
        message: 'L2 suite must bind the exact platform/capability corpus',
      });
    }
  });
export type L2NativeConformanceSuiteMaterialV1 = z.infer<typeof suiteMaterialV1Schema>;

export function computeL2NativeConformanceSuiteDigestV1(
  material: L2NativeConformanceSuiteMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.suite.v1',
    canonicalJsonBytes(suiteMaterialV1Schema.parse(material)),
  );
}

export const l2NativeConformanceSuiteV1Schema = suiteMaterialV1Schema
  .extend({ suiteDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { suiteDigest, ...material } = value;
    const expected = computeL2NativeConformanceSuiteDigestV1(material);
    if (suiteDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['suiteDigest'],
        message: `L2 suite digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceSuiteV1 = z.infer<typeof l2NativeConformanceSuiteV1Schema>;

export function buildL2NativeConformanceSuiteV1(): L2NativeConformanceSuiteV1 {
  const material = suiteMaterialV1Schema.parse({
    schema: 'L2NativeConformanceSuiteV1',
    version: 1,
    suiteId: L2_NATIVE_CONFORMANCE_SUITE_ID_V1,
    sourceRegistryDigest: buildL2NativeConformanceSourceRegistryV1().sourceRegistryDigest,
    corpusDigest: computeL2NativeConformanceCorpusDigestV1(),
  });
  return l2NativeConformanceSuiteV1Schema.parse({
    ...material,
    suiteDigest: computeL2NativeConformanceSuiteDigestV1(material),
  });
}

const evaluatorIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('L2NativeConformanceEvaluatorIdentityV1'),
    version: z.literal(1),
    evaluatorId: z.literal(L2_NATIVE_CONFORMANCE_EVALUATOR_ID_V1),
    suiteDigest: digestSchema,
    oracleDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerDigest: digestSchema,
    schedulerDigest: digestSchema,
    isolationDigest: digestSchema,
  })
  .strict();
export type L2NativeConformanceEvaluatorIdentityMaterialV1 = z.infer<
  typeof evaluatorIdentityMaterialV1Schema
>;

export function computeL2NativeConformanceEvaluatorIdentityDigestV1(
  material: L2NativeConformanceEvaluatorIdentityMaterialV1,
): `sha256:${string}` {
  return sha256DomainSeparated(
    'kite.qualification.l2.native-conformance.evaluator-identity.v1',
    canonicalJsonBytes(evaluatorIdentityMaterialV1Schema.parse(material)),
  );
}

export const l2NativeConformanceEvaluatorIdentityV1Schema = evaluatorIdentityMaterialV1Schema
  .extend({ evaluatorDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { evaluatorDigest, ...material } = value;
    const expected = computeL2NativeConformanceEvaluatorIdentityDigestV1(material);
    if (evaluatorDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['evaluatorDigest'],
        message: `L2 evaluator digest mismatch: expected ${expected}`,
      });
    }
  });
export type L2NativeConformanceEvaluatorIdentityV1 = z.infer<
  typeof l2NativeConformanceEvaluatorIdentityV1Schema
>;

function dependencyDigest(domain: string, value: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(value));
}

/**
 * Only dependency digests leave this constructor. Callers must use fixed
 * implementation facts; the receipt never retains test bodies, probe bodies,
 * archive paths, command output, or OS-version strings.
 */
export function buildL2NativeConformanceEvaluatorIdentityV1(input: {
  oracle: unknown;
  verifier: unknown;
  runner: unknown;
  scheduler: unknown;
  isolation: unknown;
  suite?: L2NativeConformanceSuiteV1;
}): L2NativeConformanceEvaluatorIdentityV1 {
  const suite = input.suite ?? buildL2NativeConformanceSuiteV1();
  const material = evaluatorIdentityMaterialV1Schema.parse({
    schema: 'L2NativeConformanceEvaluatorIdentityV1',
    version: 1,
    evaluatorId: L2_NATIVE_CONFORMANCE_EVALUATOR_ID_V1,
    suiteDigest: suite.suiteDigest,
    oracleDigest: dependencyDigest(
      'kite.qualification.l2.native-conformance.oracle.v1',
      input.oracle,
    ),
    verifierDigest: dependencyDigest(
      'kite.qualification.l2.native-conformance.verifier.v1',
      input.verifier,
    ),
    runnerDigest: dependencyDigest(
      'kite.qualification.l2.native-conformance.runner.v1',
      input.runner,
    ),
    schedulerDigest: dependencyDigest(
      'kite.qualification.l2.native-conformance.scheduler.v1',
      input.scheduler,
    ),
    isolationDigest: dependencyDigest(
      'kite.qualification.l2.native-conformance.isolation.v1',
      input.isolation,
    ),
  });
  return l2NativeConformanceEvaluatorIdentityV1Schema.parse({
    ...material,
    evaluatorDigest: computeL2NativeConformanceEvaluatorIdentityDigestV1(material),
  });
}
