import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.:/-]*$/;
const FEATURE_ID = /^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/;
const nonEmpty = z.string().trim().min(1);
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER);
const SOURCE_SYMBOL = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const REPOSITORY_PATH =
  /^(?:(?:src|release|scripts|\.github)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+|docs\/(?:[^/\\?:][^/\\?:]*\/)*[^/\\?:][^/\\?:]*\.md|README\.md|package\.json)$/u;
const QUALIFICATION_SUITE_PATH =
  /^(?:scripts\/evals\/contracts\/qualification|release\/qualification|tests\/evals\/qualification)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/;

export const QUALIFICATION_LAYERS_V1 = [
  'contract',
  'scripted_runtime',
  'native',
  'live_model',
  'manual_usability',
] as const;
export type QualificationLayerV1 = (typeof QUALIFICATION_LAYERS_V1)[number];

export const QUALIFICATION_ENTRYPOINTS_V1 = ['tui', 'cli', 'installer', 'runtime', 'any'] as const;
export type QualificationEntrypointV1 = (typeof QUALIFICATION_ENTRYPOINTS_V1)[number];

/** A scoped absence must never be represented as whole-feature unsupported. */
export const QUALIFICATION_ENTRYPOINT_NOT_APPLICABLE_RATIONALES_V1 = [
  'entrypoint_not_exposed',
] as const;

/** Closed metadata vocabulary: qualification records never carry free prose. */
export const QUALIFICATION_OWNER_IDS_V1 = [
  'app-cli',
  'app-tui',
  'core-capabilities',
  'core-config',
  'core-execution',
  'core-mcp',
  'core-model',
  'core-policy',
  'core-runtime',
  'core-skills',
  'core-subagent',
  'core-tools',
  'core-verification',
  'release-capability',
  'release-docs',
  'release-platform',
] as const;

export const QUALIFICATION_CONTRACT_CODES_V1 = [
  'approval_workspace_trust',
  'builtin_tool_registry',
  'capability_catalog_protocol',
  'cli_public_declaration',
  'cli_runtime_event_projection',
  'config_schema',
  'distribution_target_registry',
  'effectful_execution_target_registry',
  'embedded_release_profile',
  'mcp_open_world_protocol',
  'provider_open_world_protocol',
  'public_documentation_disclosure',
  'public_release_control_disclosure',
  'release_capability_catalog',
  'runtime_fork_rewind',
  'runtime_effect_terminality',
  'runtime_interaction_action',
  'runtime_snapshot_recovery',
  'runtime_tool_lifecycle',
  'sandbox_execution_boundary',
  'skill_open_world_protocol',
  'standalone_keyring_unavailable',
  'subagent_runtime_protocol',
  'tui_slash_command',
  'tui_runtime_event_projection',
  'verification_completion',
  'feature_flag_registry',
] as const;

export const QUALIFICATION_RISK_RATIONALE_CODES_V1 = [
  'authorization_boundary',
  'cli_entrypoint',
  'configuration_boundary',
  'destructive_or_unknown_tool_effect',
  'distribution_scope',
  'execution_isolation',
  'feature_exposure_boundary',
  'governed_runtime_boundary',
  'open_world_mcp_risk',
  'open_world_skill_risk',
  'provider_egress_boundary',
  'public_documentation_claim',
  'public_release_claim',
  'read_only_deterministic_tool',
  'recovery_authorization_boundary',
  'release_capability_admission',
  'release_profile_ceiling',
  'subagent_authority_boundary',
  'tui_control_surface',
  'verification_bypass_risk',
] as const;

export const QUALIFICATION_NOT_APPLICABLE_CODES_V1 = [
  'default_off_legacy_fallback',
  'legacy_resume_rejected',
  'source_not_supported',
] as const;

export const QUALIFICATION_EVIDENCE_EXCLUSION_CODES_V1 = [
  'manual_usability_not_adr_enabled',
] as const;

const alwaysConditionV1Schema = z
  .object({
    conditionId: identifierSchema,
    kind: z.literal('always'),
    parameters: z.object({}).strict(),
    conditionDigest: digestSchema,
  })
  .strict();
const featureFlagConditionV1Schema = z
  .object({
    conditionId: identifierSchema,
    kind: z.literal('feature_flag_enabled'),
    parameters: z.object({ flagId: identifierSchema, expected: z.boolean() }).strict(),
    conditionDigest: digestSchema,
  })
  .strict();
const entryRejectionConditionV1Schema = z
  .object({
    conditionId: identifierSchema,
    kind: z.literal('entry_rejection'),
    parameters: z
      .object({
        entrypointId: identifierSchema,
        denialFamily: identifierSchema,
        sourceFactDigest: digestSchema,
      })
      .strict(),
    conditionDigest: digestSchema,
  })
  .strict();
const defaultOffSafeDisableConditionV1Schema = z
  .object({
    conditionId: identifierSchema,
    kind: z.literal('default_off_safe_disable'),
    parameters: z
      .object({
        flagId: identifierSchema,
        entrypointId: identifierSchema,
        sourceFactDigest: digestSchema,
      })
      .strict(),
    conditionDigest: digestSchema,
  })
  .strict();
const manualUsabilityDisabledConditionV1Schema = z
  .object({
    conditionId: identifierSchema,
    kind: z.literal('manual_usability_disabled'),
    parameters: z
      .object({ enabled: z.literal(false), governanceRef: z.literal('ADR-0070') })
      .strict(),
    conditionDigest: digestSchema,
  })
  .strict();

export const qualificationConditionV1Schema = z
  .discriminatedUnion('kind', [
    alwaysConditionV1Schema,
    featureFlagConditionV1Schema,
    entryRejectionConditionV1Schema,
    defaultOffSafeDisableConditionV1Schema,
    manualUsabilityDisabledConditionV1Schema,
  ])
  .superRefine((value, context) => {
    const { conditionDigest, ...material } = value;
    const expected = computeQualificationConditionDigestV1(material);
    if (conditionDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['conditionDigest'],
        message: `qualification condition digest mismatch: expected ${expected}`,
      });
    }
  });

export type QualificationConditionV1 = z.infer<typeof qualificationConditionV1Schema>;
export type QualificationConditionInputV1 = Omit<QualificationConditionV1, 'conditionDigest'>;

export function computeQualificationConditionDigestV1(
  input: QualificationConditionInputV1,
): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.condition.v1', canonicalJsonBytes(input));
}

export function buildQualificationConditionV1(
  input: QualificationConditionInputV1,
): QualificationConditionV1 {
  return qualificationConditionV1Schema.parse({
    ...input,
    conditionDigest: computeQualificationConditionDigestV1(input),
  });
}

export const qualificationSourceRefV1Schema = z
  .object({
    kind: z.enum(['registry', 'config', 'contract', 'public_surface']),
    ref: nonEmpty,
  })
  .strict()
  .superRefine((value, context) => {
    const normalized = value.ref.replaceAll('\\', '/');
    const sourcePath = normalized.split('#', 1)[0] ?? '';
    const fragments = normalized.split('#');
    if (
      normalized.startsWith('tests/') ||
      normalized.includes('/tests/') ||
      normalized.includes('.test.') ||
      normalized.includes('.spec.')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ref'],
        message: 'feature source references must not be test-only',
      });
    }
    if (
      fragments.length > 2 ||
      (fragments.length === 2 && !SOURCE_SYMBOL.test(fragments[1] ?? ''))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ref'],
        message: 'feature source ref fragment must be one safe source symbol',
      });
    }
    if (
      !REPOSITORY_PATH.test(sourcePath) ||
      sourcePath.includes('..') ||
      sourcePath.includes('?') ||
      sourcePath.includes(':') ||
      sourcePath.includes('\u0000') ||
      sourcePath.startsWith('/')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ref'],
        message: 'feature source ref must be a safe repository-relative source path',
      });
    }
  });

export type QualificationSourceRefV1 = z.infer<typeof qualificationSourceRefV1Schema>;

/**
 * A suite may bind its evaluator/oracle/corpus and its deterministic test source.
 * Unlike a product feature sourceRef, a test reference is expected here, but it
 * remains restricted to the qualification implementation and test roots.
 */
export const qualificationSuiteSourceRefV1Schema = z
  .object({
    kind: z.enum(['evaluator', 'oracle', 'corpus', 'verifier', 'test']),
    ref: nonEmpty,
  })
  .strict()
  .superRefine((value, context) => {
    const normalized = value.ref.replaceAll('\\', '/');
    const sourcePath = normalized.split('#', 1)[0] ?? '';
    const fragments = normalized.split('#');
    if (
      !QUALIFICATION_SUITE_PATH.test(sourcePath) ||
      sourcePath.includes('..') ||
      sourcePath.includes('?') ||
      sourcePath.includes(':') ||
      sourcePath.startsWith('/')
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ref'],
        message:
          'suite source ref must be a safe qualification implementation, corpus, oracle, or test path',
      });
    }
    if (
      fragments.length > 2 ||
      (fragments.length === 2 && !SOURCE_SYMBOL.test(fragments[1] ?? ''))
    ) {
      context.addIssue({
        code: 'custom',
        path: ['ref'],
        message: 'suite source ref fragment must be one safe source symbol',
      });
    }
  });

export type QualificationSuiteSourceRefV1 = z.infer<typeof qualificationSuiteSourceRefV1Schema>;

const qualificationConditionRefV1Schema = z
  .object({ conditionId: identifierSchema, conditionDigest: digestSchema })
  .strict();

export const qualificationEntrypointNotApplicableV1Schema = z
  .object({
    entrypoint: z.enum(['tui', 'cli', 'installer', 'runtime']),
    rationale: z.enum(QUALIFICATION_ENTRYPOINT_NOT_APPLICABLE_RATIONALES_V1),
    /** Digest of the source-owned public-surface absence proof, never prose. */
    sourceFactDigest: digestSchema,
  })
  .strict();
export type QualificationEntrypointNotApplicableV1 = z.infer<
  typeof qualificationEntrypointNotApplicableV1Schema
>;

const qualificationApplicabilityV1Schema = z
  .object({
    releaseProfiles: z.array(identifierSchema).min(1),
    platforms: z.array(z.enum(['macos', 'linux', 'windows', 'any'])).min(1),
    entrypoints: z.array(z.enum(QUALIFICATION_ENTRYPOINTS_V1)).min(1),
    entrypointNotApplicable: z.array(qualificationEntrypointNotApplicableV1Schema).optional(),
    routeClasses: z.array(identifierSchema).optional(),
    featureFlags: z.array(identifierSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    for (const [key, entries] of Object.entries({
      releaseProfiles: value.releaseProfiles,
      platforms: value.platforms,
      entrypoints: value.entrypoints,
      routeClasses: value.routeClasses,
      featureFlags: value.featureFlags,
    })) {
      if (entries !== undefined && !isCodePointSortedUnique(entries)) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} must be unique and code-point sorted`,
        });
      }
    }
    const notApplicable = value.entrypointNotApplicable ?? [];
    if (!isCodePointSortedUnique(notApplicable.map((entry) => entry.entrypoint))) {
      context.addIssue({
        code: 'custom',
        path: ['entrypointNotApplicable'],
        message:
          'entrypointNotApplicable records must be unique and code-point sorted by entrypoint',
      });
    }
    for (const record of notApplicable) {
      if (value.entrypoints.includes(record.entrypoint)) {
        context.addIssue({
          code: 'custom',
          path: ['entrypointNotApplicable'],
          message: 'entrypointNotApplicable may only name an entrypoint absent from applicability',
        });
      }
    }
  });

const qualificationRequiredEvidenceV1Schema = z
  .object({
    layer: z.enum(QUALIFICATION_LAYERS_V1),
    suiteIds: z.array(identifierSchema).min(1),
    assertionIds: z.array(identifierSchema).min(1),
    requiredWhen: qualificationConditionRefV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!isCodePointSortedUnique(value.suiteIds) || !isCodePointSortedUnique(value.assertionIds)) {
      context.addIssue({
        code: 'custom',
        message: 'required evidence suite/assertion IDs must be unique and code-point sorted',
      });
    }
  });

const qualificationEvidenceExclusionV1Schema = z
  .object({
    layer: z.enum(QUALIFICATION_LAYERS_V1),
    condition: qualificationConditionRefV1Schema,
    rationale: z.enum(QUALIFICATION_EVIDENCE_EXCLUSION_CODES_V1),
  })
  .strict();

export const agentFeatureQualificationSpecV1Schema = z
  .object({
    schema: z.literal('AgentFeatureQualificationSpecV1'),
    version: z.literal(1),
    id: z.string().regex(FEATURE_ID),
    sourceSurfaceId: identifierSchema,
    domain: z.enum([
      'tool',
      'skill',
      'mcp',
      'subagent',
      'runtime',
      'authorization',
      'sandbox',
      'verification',
      'model_context',
      'tui',
      'cli',
      'release',
      'config',
    ]),
    observableContract: z.enum(QUALIFICATION_CONTRACT_CODES_V1),
    risk: z.enum(['p0', 'p1', 'p2']),
    riskRationale: z.enum(QUALIFICATION_RISK_RATIONALE_CODES_V1),
    sourceRefs: z.array(qualificationSourceRefV1Schema).min(1),
    owner: z.enum(QUALIFICATION_OWNER_IDS_V1),
    applicability: qualificationApplicabilityV1Schema,
    supportState: z.enum(['supported', 'unsupported']),
    declaredExposure: z.enum(['default_on', 'experimental_default_off', 'disabled', 'unsupported']),
    requiredEvidence: z.array(qualificationRequiredEvidenceV1Schema),
    evidenceExclusions: z.array(qualificationEvidenceExclusionV1Schema).default([]),
    notApplicableRationale: z.enum(QUALIFICATION_NOT_APPLICABLE_CODES_V1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.declaredExposure === 'default_on' && value.requiredEvidence.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['requiredEvidence'],
        message: 'default-on feature requires at least one evidence requirement',
      });
    }
    if (value.requiredEvidence.some((requirement) => requirement.layer === 'manual_usability')) {
      context.addIssue({
        code: 'custom',
        path: ['requiredEvidence'],
        message:
          'manual usability evidence is disabled until a future ADR defines an enable condition',
      });
    }
    if (value.supportState === 'unsupported') {
      if (value.declaredExposure !== 'unsupported' || !value.notApplicableRationale) {
        context.addIssue({
          code: 'custom',
          path: ['notApplicableRationale'],
          message:
            'unsupported feature requires unsupported exposure and a disclosed not-applicable rationale',
        });
      }
    } else if (value.declaredExposure === 'unsupported' || value.notApplicableRationale) {
      context.addIssue({
        code: 'custom',
        path: ['notApplicableRationale'],
        message: 'not-applicable rationale is reserved for an unsupported feature',
      });
    }
    if (value.applicability.entrypointNotApplicable?.length && value.supportState !== 'supported') {
      context.addIssue({
        code: 'custom',
        path: ['applicability', 'entrypointNotApplicable'],
        message: 'scoped entrypoint absence is only valid for an otherwise supported feature',
      });
    }
    const sourceKeys = value.sourceRefs.map((source) => `${source.kind}:${source.ref}`);
    if (!isCodePointSortedUnique(sourceKeys)) {
      context.addIssue({
        code: 'custom',
        path: ['sourceRefs'],
        message: 'source refs must be unique and code-point sorted',
      });
    }
    if (!isCodePointSortedUnique(value.evidenceExclusions.map((entry) => entry.layer))) {
      context.addIssue({
        code: 'custom',
        path: ['evidenceExclusions'],
        message: 'evidence exclusions must have unique, sorted layers',
      });
    }
  });

export type AgentFeatureQualificationSpecV1 = z.infer<typeof agentFeatureQualificationSpecV1Schema>;

export const qualificationSourceSurfaceV1Schema = z
  .object({
    sourceSurfaceId: identifierSchema,
    /** Digest of the source-owner fact snapshot; source content is never emitted. */
    sourceFactDigest: digestSchema,
    sourceDigest: digestSchema,
    feature: agentFeatureQualificationSpecV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceSurfaceId !== value.feature.sourceSurfaceId) {
      context.addIssue({
        code: 'custom',
        path: ['feature', 'sourceSurfaceId'],
        message: 'feature must bind its exact source surface',
      });
    }
    const { sourceDigest, ...material } = value;
    const expected = computeQualificationSourceSurfaceDigestV1(material);
    if (sourceDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['sourceDigest'],
        message: `source surface digest mismatch: expected ${expected}`,
      });
    }
  });

export type QualificationSourceSurfaceV1 = z.infer<typeof qualificationSourceSurfaceV1Schema>;

export function computeQualificationSourceSurfaceDigestV1(input: {
  sourceSurfaceId: string;
  sourceFactDigest: string;
  feature: AgentFeatureQualificationSpecV1;
}): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.source-surface.v1', canonicalJsonBytes(input));
}

export function buildQualificationSourceSurfaceV1(input: {
  sourceSurfaceId: string;
  sourceFact: unknown;
  feature: AgentFeatureQualificationSpecV1;
}): QualificationSourceSurfaceV1 {
  const sourceFactDigest = computeQualificationSourceFactDigestV1(input.sourceFact);
  const material = {
    sourceSurfaceId: input.sourceSurfaceId,
    sourceFactDigest,
    feature: input.feature,
  };
  return qualificationSourceSurfaceV1Schema.parse({
    ...material,
    sourceDigest: computeQualificationSourceSurfaceDigestV1(material),
  });
}

export function computeQualificationSourceFactDigestV1(value: unknown): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.source-fact.v1', canonicalJsonBytes(value));
}

/**
 * The AQ-1 structural evaluator owns this deterministic assertion namespace.
 * Product behavior adapters add their own assertion IDs in later AQ tasks;
 * these IDs prove only that a source-owned surface is present and bound.
 */
export function qualificationStructuralAssertionIdV1(sourceSurfaceId: string): string {
  return `assertion:${sourceSurfaceId.replaceAll(':', '/')}`;
}

/**
 * These suffixes are emitted only by the structural evaluator from a verified
 * source-surface/condition pairing. They are never inferred from a feature's
 * requested evidence, so a collector cannot prove an arbitrary assertion by
 * merely asking its suite to contain it.
 */
export type QualificationStructuralConditionAssertionKindV1 =
  | 'entry_rejection'
  | 'default_off_safe_disable';

export function qualificationStructuralConditionAssertionIdV1(
  sourceSurfaceId: string,
  kind: QualificationStructuralConditionAssertionKindV1,
): string {
  const suffix = kind === 'entry_rejection' ? 'entry-rejection' : 'default-off-safe-disable';
  return `${qualificationStructuralAssertionIdV1(sourceSurfaceId)}:${suffix}`;
}

export interface QualificationStructuralAssertionV1 {
  assertionId: string;
  sourceSurfaceId: string;
  sourceDigest: `sha256:${string}`;
}

export function evaluateQualificationStructuralAssertionsV1(
  sourceSurfaces: readonly QualificationSourceSurfaceV1[],
  conditions: readonly QualificationConditionV1[] = [],
): QualificationStructuralAssertionV1[] {
  const assertions = sourceSurfaces
    .map((surface) => qualificationSourceSurfaceV1Schema.parse(surface))
    .flatMap((surface) => {
      const assertionKinds = qualificationStructuralConditionAssertionKindsV1(
        surface.feature,
        conditions,
      );
      return [
        {
          assertionId: qualificationStructuralAssertionIdV1(surface.sourceSurfaceId),
          sourceSurfaceId: surface.sourceSurfaceId,
          sourceDigest: surface.sourceDigest as `sha256:${string}`,
        },
        ...assertionKinds.map((kind) => ({
          assertionId: qualificationStructuralConditionAssertionIdV1(surface.sourceSurfaceId, kind),
          sourceSurfaceId: surface.sourceSurfaceId,
          sourceDigest: surface.sourceDigest as `sha256:${string}`,
        })),
      ];
    })
    .sort((left, right) => compareCodePoint(left.assertionId, right.assertionId));
  assertCodePointSortedUnique(
    assertions.map((assertion) => assertion.assertionId),
    'structural assertion IDs',
  );
  return assertions;
}

function qualificationStructuralConditionAssertionKindsV1(
  feature: AgentFeatureQualificationSpecV1,
  conditions: readonly QualificationConditionV1[],
): QualificationStructuralConditionAssertionKindV1[] {
  const entrypoints = new Set(feature.applicability.entrypoints);
  if (
    feature.declaredExposure === 'disabled' &&
    conditions.some(
      (condition) =>
        condition.kind === 'entry_rejection' &&
        isQualificationEntrypointV1(condition.parameters.entrypointId) &&
        entrypoints.has(condition.parameters.entrypointId),
    )
  ) {
    return ['entry_rejection'];
  }
  const featureFlags = new Set(feature.applicability.featureFlags ?? []);
  if (
    feature.declaredExposure === 'experimental_default_off' &&
    conditions.some(
      (condition) =>
        condition.kind === 'default_off_safe_disable' &&
        featureFlags.has(condition.parameters.flagId) &&
        isQualificationEntrypointV1(condition.parameters.entrypointId) &&
        entrypoints.has(condition.parameters.entrypointId),
    )
  ) {
    return ['default_off_safe_disable'];
  }
  return [];
}

function isQualificationEntrypointV1(value: string): value is QualificationEntrypointV1 {
  return (QUALIFICATION_ENTRYPOINTS_V1 as readonly string[]).includes(value);
}

export const qualificationSuiteV1Schema = z
  .object({
    suiteId: identifierSchema,
    sourceRefs: z.array(qualificationSuiteSourceRefV1Schema).min(1),
    assertionIds: z.array(identifierSchema).min(1),
    suiteSourceDigest: digestSchema,
    evaluatorDigest: digestSchema,
    oracleDigest: digestSchema,
    corpusDigest: digestSchema,
    suiteDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const sourceKeys = value.sourceRefs.map((source) => `${source.kind}:${source.ref}`);
    if (!isCodePointSortedUnique(sourceKeys) || !isCodePointSortedUnique(value.assertionIds)) {
      context.addIssue({
        code: 'custom',
        message: 'suite source refs and assertion IDs must be unique and code-point sorted',
      });
    }
    const expected = computeQualificationSuiteDigestV1({
      suiteId: value.suiteId,
      sourceRefs: value.sourceRefs,
      assertionIds: value.assertionIds,
      suiteSourceDigest: value.suiteSourceDigest,
      evaluatorDigest: value.evaluatorDigest,
      oracleDigest: value.oracleDigest,
      corpusDigest: value.corpusDigest,
    });
    if (value.suiteDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['suiteDigest'],
        message: `qualification suite digest mismatch: expected ${expected}`,
      });
    }
  });

export type QualificationSuiteV1 = z.infer<typeof qualificationSuiteV1Schema>;

export function computeQualificationSuiteDigestV1(
  input: Omit<QualificationSuiteV1, 'suiteDigest'>,
): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.suite.v1', canonicalJsonBytes(input));
}

export function buildQualificationSuiteV1(input: {
  suiteId: string;
  sourceRefs: readonly QualificationSuiteSourceRefV1[];
  assertionIds: readonly string[];
  sourceFact: unknown;
  evaluatorFact: unknown;
  oracleFact: unknown;
  corpusFact: unknown;
}): QualificationSuiteV1 {
  const material = {
    suiteId: input.suiteId,
    sourceRefs: [...input.sourceRefs],
    assertionIds: [...input.assertionIds],
    suiteSourceDigest: computeQualificationSuiteSourceDigestV1(input.sourceFact),
    evaluatorDigest: computeQualificationEvaluatorDigestV1(input.evaluatorFact),
    oracleDigest: computeQualificationOracleDigestV1(input.oracleFact),
    corpusDigest: computeQualificationCorpusDigestV1(input.corpusFact),
  };
  return qualificationSuiteV1Schema.parse({
    ...material,
    suiteDigest: computeQualificationSuiteDigestV1(material),
  });
}

export function computeQualificationSuiteSourceDigestV1(value: unknown): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.suite-source.v1', canonicalJsonBytes(value));
}

export function computeQualificationEvaluatorDigestV1(value: unknown): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.evaluator.v1', canonicalJsonBytes(value));
}

export function computeQualificationOracleDigestV1(value: unknown): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.oracle.v1', canonicalJsonBytes(value));
}

export function computeQualificationCorpusDigestV1(value: unknown): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.corpus.v1', canonicalJsonBytes(value));
}

export const agentFeatureQualificationMatrixV1Schema = z
  .object({
    schema: z.literal('AgentFeatureQualificationMatrixV1'),
    version: z.literal(1),
    sourceSurfaceDigest: digestSchema,
    conditionCatalogDigest: digestSchema,
    suiteCatalogDigest: digestSchema,
    features: z.array(agentFeatureQualificationSpecV1Schema).min(1),
    matrixDigest: digestSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (!isCodePointSortedUnique(value.features.map((feature) => feature.id))) {
      context.addIssue({
        code: 'custom',
        path: ['features'],
        message: 'features must be unique and sorted',
      });
    }
    const { matrixDigest, ...material } = value;
    const expected = computeAgentFeatureQualificationMatrixDigestV1(material);
    if (matrixDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['matrixDigest'],
        message: `matrix digest mismatch: expected ${expected}`,
      });
    }
  });

export type AgentFeatureQualificationMatrixV1 = z.infer<
  typeof agentFeatureQualificationMatrixV1Schema
>;

export interface GenerateAgentFeatureQualificationMatrixInputV1 {
  sourceSurfaces: readonly QualificationSourceSurfaceV1[];
  conditions: readonly QualificationConditionV1[];
  suites: readonly QualificationSuiteV1[];
}

export function generateAgentFeatureQualificationMatrixV1(
  input: GenerateAgentFeatureQualificationMatrixInputV1,
): AgentFeatureQualificationMatrixV1 {
  const sourceSurfaces = input.sourceSurfaces.map((surface) =>
    qualificationSourceSurfaceV1Schema.parse(surface),
  );
  const conditions = input.conditions.map((condition) =>
    qualificationConditionV1Schema.parse(condition),
  );
  const suites = input.suites.map((suite) => qualificationSuiteV1Schema.parse(suite));
  assertCodePointSortedUnique(
    sourceSurfaces.map((surface) => surface.sourceSurfaceId),
    'source surfaces',
  );
  assertCodePointSortedUnique(
    conditions.map((condition) => condition.conditionId),
    'conditions',
  );
  assertCodePointSortedUnique(
    suites.map((suite) => suite.suiteId),
    'suites',
  );

  const conditionById = new Map(conditions.map((condition) => [condition.conditionId, condition]));
  const suiteById = new Map(suites.map((suite) => [suite.suiteId, suite]));
  const features = [...sourceSurfaces]
    .map((surface) => surface.feature)
    .sort((left, right) => compareCodePoint(left.id, right.id));
  assertCodePointSortedUnique(
    features.map((feature) => feature.id),
    'feature IDs',
  );
  assertUnique(
    features.map((feature) => feature.sourceSurfaceId),
    'feature source surfaces',
  );

  for (const feature of features) {
    for (const requirement of feature.requiredEvidence) {
      const condition = conditionById.get(requirement.requiredWhen.conditionId);
      if (!condition || condition.conditionDigest !== requirement.requiredWhen.conditionDigest) {
        throw new Error(
          `unknown_or_drifted_condition:${feature.id}:${requirement.requiredWhen.conditionId}`,
        );
      }
      for (const suiteId of requirement.suiteIds) {
        const suite = suiteById.get(suiteId);
        if (!suite) throw new Error(`unknown_suite:${feature.id}:${suiteId}`);
        for (const assertionId of requirement.assertionIds) {
          if (!suite.assertionIds.includes(assertionId)) {
            throw new Error(`unknown_assertion:${feature.id}:${suiteId}:${assertionId}`);
          }
        }
      }
    }
    for (const exclusion of feature.evidenceExclusions) {
      const condition = conditionById.get(exclusion.condition.conditionId);
      if (!condition || condition.conditionDigest !== exclusion.condition.conditionDigest) {
        throw new Error(`unknown_or_drifted_exclusion_condition:${feature.id}:${exclusion.layer}`);
      }
      if (feature.requiredEvidence.some((requirement) => requirement.layer === exclusion.layer)) {
        throw new Error(`required_and_excluded_layer:${feature.id}:${exclusion.layer}`);
      }
    }
    if (feature.declaredExposure === 'default_on') {
      const manualExclusion = feature.evidenceExclusions.find(
        (exclusion) => exclusion.layer === 'manual_usability',
      );
      const manualCondition = manualExclusion
        ? conditionById.get(manualExclusion.condition.conditionId)
        : undefined;
      if (
        !manualExclusion ||
        !manualCondition ||
        manualCondition.conditionDigest !== manualExclusion.condition.conditionDigest ||
        manualCondition.kind !== 'manual_usability_disabled' ||
        manualCondition.parameters.enabled !== false ||
        manualCondition.parameters.governanceRef !== 'ADR-0070' ||
        manualExclusion.rationale !== 'manual_usability_not_adr_enabled'
      ) {
        throw new Error(`manual_usability_exclusion_missing:${feature.id}`);
      }
    }
    if (
      feature.declaredExposure === 'disabled' &&
      !feature.requiredEvidence.some((requirement) => {
        const condition = conditionById.get(requirement.requiredWhen.conditionId);
        return (
          condition?.kind === 'entry_rejection' &&
          isQualificationEntrypointV1(condition.parameters.entrypointId) &&
          feature.applicability.entrypoints.includes(condition.parameters.entrypointId) &&
          condition.conditionDigest === requirement.requiredWhen.conditionDigest
        );
      })
    ) {
      throw new Error(`entry_rejection_requirement_missing:${feature.id}`);
    }
    if (
      feature.declaredExposure === 'experimental_default_off' &&
      !feature.requiredEvidence.some((requirement) => {
        const condition = conditionById.get(requirement.requiredWhen.conditionId);
        return (
          condition?.kind === 'feature_flag_enabled' &&
          condition.parameters.expected === true &&
          feature.applicability.featureFlags?.includes(condition.parameters.flagId) &&
          condition.conditionDigest === requirement.requiredWhen.conditionDigest
        );
      })
    ) {
      throw new Error(`feature_flag_enablement_requirement_missing:${feature.id}`);
    }
    if (
      feature.declaredExposure === 'experimental_default_off' &&
      !feature.requiredEvidence.some((requirement) => {
        const condition = conditionById.get(requirement.requiredWhen.conditionId);
        return (
          condition?.kind === 'default_off_safe_disable' &&
          feature.applicability.featureFlags?.includes(condition.parameters.flagId) &&
          isQualificationEntrypointV1(condition.parameters.entrypointId) &&
          feature.applicability.entrypoints.includes(condition.parameters.entrypointId) &&
          condition.conditionDigest === requirement.requiredWhen.conditionDigest
        );
      })
    ) {
      throw new Error(`default_off_safe_disable_requirement_missing:${feature.id}`);
    }
  }

  const sourceSurfaceDigest = sha256DomainSeparated(
    'kite.qualification.source-surface-catalog.v1',
    canonicalJsonBytes(sourceSurfaces),
  );
  const conditionCatalogDigest = sha256DomainSeparated(
    'kite.qualification.condition-catalog.v1',
    canonicalJsonBytes(conditions),
  );
  const suiteCatalogDigest = sha256DomainSeparated(
    'kite.qualification.suite-catalog.v1',
    canonicalJsonBytes(suites),
  );
  const material = {
    schema: 'AgentFeatureQualificationMatrixV1' as const,
    version: 1 as const,
    sourceSurfaceDigest,
    conditionCatalogDigest,
    suiteCatalogDigest,
    features,
  };
  return agentFeatureQualificationMatrixV1Schema.parse({
    ...material,
    matrixDigest: computeAgentFeatureQualificationMatrixDigestV1(material),
  });
}

export function computeAgentFeatureQualificationMatrixDigestV1(
  input: Omit<AgentFeatureQualificationMatrixV1, 'matrixDigest'>,
): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.feature-matrix.v1', canonicalJsonBytes(input));
}

export function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCodePointSortedUnique(values: readonly string[], label: string): void {
  if (!isCodePointSortedUnique(values)) throw new Error(`${label}_must_be_unique_and_sorted`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label}_must_be_unique`);
}

function isCodePointSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}
