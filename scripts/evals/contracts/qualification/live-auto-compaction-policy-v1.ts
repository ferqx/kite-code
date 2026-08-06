import { z } from 'zod';
import { canonicalJsonBytes, sha256DomainSeparated } from '../../../release/canonical-json';
import { EVIDENCE_GOVERNANCE_PROFILE_V1 } from './evidence/governance-v1';
import {
  buildDiagnosticCandidateArtifactClosureV1,
  type DiagnosticCandidateArtifactClosureV1,
  type DiagnosticRouteIdentityV1,
} from './evidence/live-observation-schema-v1';
import { isQualificationSafeIdentifierV1 } from './evidence/metadata-safety-v1';
import {
  buildLiveRouteDiagnosticIdentityV1,
  L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1,
  L3_QWEN_LIVE_ROUTE_DECLARATION_V1,
} from './live-route-resolver-v1';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._:/-]{0,191}$/;
const digestSchema = z.string().regex(DIGEST);
const identifierSchema = z.string().regex(IDENTIFIER).refine(isQualificationSafeIdentifierV1, {
  message:
    'L3 auto-compaction identifiers must not contain an endpoint, absolute path, or unsafe metadata',
});
const isoTimestampSchema = z.iso.datetime({ offset: true });
const positiveIntegerSchema = z.number().int().positive();

function exactInventory(values: readonly string[], expected: readonly string[]): boolean {
  return (
    values.length === expected.length && values.every((value, index) => value === expected[index])
  );
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || (values[index - 1] ?? '') < value);
}

function fixedDigest(domain: string, material: unknown): `sha256:${string}` {
  return sha256DomainSeparated(domain, canonicalJsonBytes(material));
}

/**
 * AQ-9B intentionally has a separate policy, fixture, corpus, oracle,
 * evaluator and verifier identity. Its only shared live fact is the reviewed
 * diagnostic Qwen route declaration; it does not reuse AQ-8's policy or
 * observation/verifier registry.
 */
export const L3_LIVE_AUTO_COMPACTION_SUITE_ID_V1 =
  'qualification-l3-live-auto-compaction-v1' as const;
export const L3_LIVE_AUTO_COMPACTION_POLICY_ID_V1 =
  'qualification-l3-live-auto-compaction-policy-v1' as const;
export const L3_LIVE_AUTO_COMPACTION_FIXTURE_ID_V1 =
  'qualification-l3-auto-compaction-sealed-synthetic-fixture-v1' as const;
export const L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1 =
  'qualification-l3-live-auto-compaction-runner-v1' as const;
export const L3_LIVE_AUTO_COMPACTION_ORACLE_ID_V1 =
  'qualification-l3-live-auto-compaction-oracle-v1' as const;
export const L3_LIVE_AUTO_COMPACTION_EVALUATOR_ID_V1 =
  'qualification-l3-live-auto-compaction-evaluator-v1' as const;
export const L3_LIVE_AUTO_COMPACTION_VERIFIER_ID_V1 =
  'qualification-l3-live-auto-compaction-verifier-v1' as const;

export const L3_LIVE_AUTO_COMPACTION_CASE_IDS_V1 = [
  'l3-auto-compaction-cancelled-v1',
  'l3-auto-compaction-success-v1',
] as const;
export type L3LiveAutoCompactionCaseIdV1 = (typeof L3_LIVE_AUTO_COMPACTION_CASE_IDS_V1)[number];

/** Closed zero-network reasons. Live provider/network failures are AQ-9A only. */
export const L3_LIVE_AUTO_COMPACTION_BLOCKED_REASON_CODES_V1 = [
  'budget_exhausted',
  'capability_not_declared',
  'credential_missing',
  'endpoint_not_allowed',
  'explicit_opt_in_required',
  'governance_reservation_unavailable',
  'not_observed',
  'phase_budget_drift',
  'policy_expired',
  'policy_invalid',
  'policy_not_active',
  'projection_not_in_range',
  'route_not_registered',
  'route_policy_mismatch',
  'timeout',
  'tool_output_denied',
] as const;
export type L3LiveAutoCompactionBlockedReasonCodeV1 =
  (typeof L3_LIVE_AUTO_COMPACTION_BLOCKED_REASON_CODES_V1)[number];

const phaseCapsMaterialV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionPhaseCapsV1'),
    version: z.literal(1),
    summaryProviderInputMax: positiveIntegerSchema,
    summaryOutputMax: positiveIntegerSchema,
    followUpProviderInputMax: positiveIntegerSchema,
    followUpOutputMax: positiveIntegerSchema,
    totalMax: positiveIntegerSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.summaryProviderInputMax !== 7_800 ||
      value.summaryOutputMax !== 600 ||
      value.followUpProviderInputMax !== 3_229 ||
      value.followUpOutputMax !== 600 ||
      value.totalMax !== 12_229
    ) {
      context.addIssue({
        code: 'custom',
        message: 'AQ-9B phase caps must retain the exact approved 12,229-token reservation shape',
      });
    }
    if (
      value.summaryProviderInputMax +
        value.summaryOutputMax +
        value.followUpProviderInputMax +
        value.followUpOutputMax !==
      value.totalMax
    ) {
      context.addIssue({
        code: 'custom',
        message: 'AQ-9B phase caps must exactly account for both dispatches',
      });
    }
  });
export type LiveAutoCompactionPhaseCapsMaterialV1 = z.infer<typeof phaseCapsMaterialV1Schema>;

export function computeLiveAutoCompactionPhaseCapsDigestV1(
  material: LiveAutoCompactionPhaseCapsMaterialV1,
): `sha256:${string}` {
  return fixedDigest(
    'kite.qualification.live-auto-compaction.phase-caps.v1',
    phaseCapsMaterialV1Schema.parse(material),
  );
}

export const liveAutoCompactionPhaseCapsV1Schema = phaseCapsMaterialV1Schema
  .extend({ phaseCapsDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { phaseCapsDigest, ...material } = value;
    const expected = computeLiveAutoCompactionPhaseCapsDigestV1(material);
    if (phaseCapsDigest !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['phaseCapsDigest'],
        message: 'AQ-9B phase-cap digest mismatch',
      });
    }
  });
export type LiveAutoCompactionPhaseCapsV1 = z.infer<typeof liveAutoCompactionPhaseCapsV1Schema>;

function buildPhaseCaps(): LiveAutoCompactionPhaseCapsV1 {
  const material = phaseCapsMaterialV1Schema.parse({
    schema: 'LiveAutoCompactionPhaseCapsV1',
    version: 1,
    summaryProviderInputMax: 7_800,
    summaryOutputMax: 600,
    followUpProviderInputMax: 3_229,
    followUpOutputMax: 600,
    totalMax: 12_229,
  });
  return liveAutoCompactionPhaseCapsV1Schema.parse({
    ...material,
    phaseCapsDigest: computeLiveAutoCompactionPhaseCapsDigestV1(material),
  });
}

/** Exact source-owned caps; never derive a lower charge from a short output. */
export const L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1 = buildPhaseCaps();

/**
 * The source-owned synthetic projection shape for AQ-9B. These are not
 * product defaults or a context-window declaration: they bind only the safe
 * local corpus used to force one real automatic-compaction boundary. The
 * runner re-measures the current estimator and rejects drift rather than
 * widening a phase cap.
 */
const syntheticProjectionMaterialV1Schema = z
  .object({
    schema: z.literal('L3LiveAutoCompactionSyntheticProjectionV1'),
    version: z.literal(1),
    historyChunkRepeats: z.literal(532),
    safeSummaryTokens: z.literal(597),
    fullProjectionMinimumTokens: z.literal(9_000),
    fullProjectionMaximumTokens: z.literal(10_000),
    compactionThresholdTokens: z.literal(8_192),
    minimumSummaryInputMargin: z.literal(1_000),
    minimumTailInputMargin: z.literal(0),
    minimumReservationMargin: z.literal(1_000),
  })
  .strict();
export type L3LiveAutoCompactionSyntheticProjectionMaterialV1 = z.infer<
  typeof syntheticProjectionMaterialV1Schema
>;

export function computeL3LiveAutoCompactionSyntheticProjectionDigestV1(
  material: L3LiveAutoCompactionSyntheticProjectionMaterialV1,
): `sha256:${string}` {
  return fixedDigest(
    'kite.qualification.live-auto-compaction.synthetic-projection.v1',
    syntheticProjectionMaterialV1Schema.parse(material),
  );
}

export const L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1 = Object.freeze({
  ...syntheticProjectionMaterialV1Schema.parse({
    schema: 'L3LiveAutoCompactionSyntheticProjectionV1',
    version: 1,
    historyChunkRepeats: 532,
    safeSummaryTokens: 597,
    fullProjectionMinimumTokens: 9_000,
    fullProjectionMaximumTokens: 10_000,
    compactionThresholdTokens: 8_192,
    minimumSummaryInputMargin: 1_000,
    minimumTailInputMargin: 0,
    minimumReservationMargin: 1_000,
  }),
  syntheticProjectionDigest: computeL3LiveAutoCompactionSyntheticProjectionDigestV1({
    schema: 'L3LiveAutoCompactionSyntheticProjectionV1',
    version: 1,
    historyChunkRepeats: 532,
    safeSummaryTokens: 597,
    fullProjectionMinimumTokens: 9_000,
    fullProjectionMaximumTokens: 10_000,
    compactionThresholdTokens: 8_192,
    minimumSummaryInputMargin: 1_000,
    minimumTailInputMargin: 0,
    minimumReservationMargin: 1_000,
  }),
});

const liveAutoCompactionSyntheticProjectionV1Schema = syntheticProjectionMaterialV1Schema
  .extend({ syntheticProjectionDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { syntheticProjectionDigest, ...material } = value;
    if (
      syntheticProjectionDigest !== computeL3LiveAutoCompactionSyntheticProjectionDigestV1(material)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['syntheticProjectionDigest'],
        message: 'AQ-9B synthetic projection digest mismatch',
      });
    }
  });

const toolEnvironmentMaterialV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionToolEnvironmentV1'),
    version: z.literal(1),
    toolExecution: z.literal('denied'),
    skillExecution: z.literal('denied'),
    subagentExecution: z.literal('denied'),
    mcpTransport: z.literal('denied'),
    stdioChildren: z.literal('denied'),
    shellChildren: z.literal('denied'),
    childEnvironmentAllowlist: z.array(z.never()).length(0),
  })
  .strict();
export type LiveAutoCompactionToolEnvironmentMaterialV1 = z.infer<
  typeof toolEnvironmentMaterialV1Schema
>;

export function computeLiveAutoCompactionToolEnvironmentDigestV1(
  material: LiveAutoCompactionToolEnvironmentMaterialV1,
): `sha256:${string}` {
  return fixedDigest(
    'kite.qualification.live-auto-compaction.tool-environment.v1',
    toolEnvironmentMaterialV1Schema.parse(material),
  );
}

const autoToolEnvironmentMaterial = toolEnvironmentMaterialV1Schema.parse({
  schema: 'LiveAutoCompactionToolEnvironmentV1',
  version: 1,
  toolExecution: 'denied',
  skillExecution: 'denied',
  subagentExecution: 'denied',
  mcpTransport: 'denied',
  stdioChildren: 'denied',
  shellChildren: 'denied',
  childEnvironmentAllowlist: [],
});
/**
 * This is the only public AQ-9B tool-environment declaration.  Keeping the
 * digest on the exported object prevents a caller from accidentally binding
 * the unresolved material form (which has no security meaning on its own).
 */
export const L3_LIVE_AUTO_COMPACTION_TOOL_ENVIRONMENT_V1 = Object.freeze({
  ...autoToolEnvironmentMaterial,
  toolEnvironmentDigest: computeLiveAutoCompactionToolEnvironmentDigestV1(
    autoToolEnvironmentMaterial,
  ),
});

/** The route declaration has no context-window fact; AQ-9B must keep it unknown. */
export const L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1: DiagnosticRouteIdentityV1 =
  buildLiveRouteDiagnosticIdentityV1(L3_QWEN_LIVE_ROUTE_DECLARATION_V1);

const L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1 = Object.freeze({
  schema: 'LiveAutoCompactionSourceOwnedIdentityV1' as const,
  version: 1 as const,
  matrixId: 'source-owned-agent-feature-qualification-matrix-v1',
  // A checked-in projection of the source-owned Matrix.  The dedicated AQ-9B
  // registry/verifier requires a test to reconstruct this value from the
  // source collector; it is not a manually-maintained feature inventory.
  matrixDigest:
    'sha256:4e78afddb242d5ae6b36003a25cfe6c21831430e3e50a161e7c445661e6b9a0d' as `sha256:${string}`,
  sourceSurfaceId: 'model-context:auto-compaction-failure',
  featureId: 'MODEL_CONTEXT-AUTO_COMPACTION_FAILURE-001',
  assertionId: 'assertion:model-context/auto-compaction-failure',
  matrixSuiteId: 'source-owned-surface-contract-v1',
  matrixSuiteDigest:
    'sha256:e3cf714067abef429d2094120f6c974eff4855130ff7d80a7371893158737212' as `sha256:${string}`,
  suiteId: L3_LIVE_AUTO_COMPACTION_SUITE_ID_V1,
  suiteDigest: '' as `sha256:${string}`,
  verifierId: L3_LIVE_AUTO_COMPACTION_VERIFIER_ID_V1,
  verifierDigest: fixedDigest('kite.qualification.live-auto-compaction.verifier.v1', {
    verifierId: L3_LIVE_AUTO_COMPACTION_VERIFIER_ID_V1,
    authority: 'diagnostic',
    evidenceEligible: false,
    metadataOnly: true,
    rejectReleaseInput: true,
  }),
});

const sourceOwnedIdentityMaterialV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionSourceOwnedIdentityV1'),
    version: z.literal(1),
    matrixId: identifierSchema,
    matrixDigest: digestSchema,
    sourceSurfaceId: identifierSchema,
    featureId: identifierSchema,
    assertionId: identifierSchema,
    matrixSuiteId: identifierSchema,
    matrixSuiteDigest: digestSchema,
    suiteId: z.literal(L3_LIVE_AUTO_COMPACTION_SUITE_ID_V1),
    suiteDigest: digestSchema,
    verifierId: z.literal(L3_LIVE_AUTO_COMPACTION_VERIFIER_ID_V1),
    verifierDigest: digestSchema,
  })
  .strict();
export type LiveAutoCompactionSourceOwnedIdentityMaterialV1 = z.infer<
  typeof sourceOwnedIdentityMaterialV1Schema
>;

export function computeLiveAutoCompactionSourceOwnedIdentityDigestV1(
  material: LiveAutoCompactionSourceOwnedIdentityMaterialV1,
): `sha256:${string}` {
  return fixedDigest(
    'kite.qualification.live-auto-compaction.source-owned-identity.v1',
    sourceOwnedIdentityMaterialV1Schema.parse(material),
  );
}

export const liveAutoCompactionSourceOwnedIdentityV1Schema = sourceOwnedIdentityMaterialV1Schema
  .extend({ identityDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { identityDigest, ...material } = value;
    if (identityDigest !== computeLiveAutoCompactionSourceOwnedIdentityDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['identityDigest'],
        message: 'source identity drift',
      });
    }
  });
export type LiveAutoCompactionSourceOwnedIdentityV1 = z.infer<
  typeof liveAutoCompactionSourceOwnedIdentityV1Schema
>;

function computeL3LiveAutoCompactionSuiteDigestV1(input: {
  matrixDigest: `sha256:${string}`;
  matrixSuiteDigest: `sha256:${string}`;
  verifierDigest: `sha256:${string}`;
}): `sha256:${string}` {
  return fixedDigest('kite.qualification.live-auto-compaction.suite.v1', {
    suiteId: L3_LIVE_AUTO_COMPACTION_SUITE_ID_V1,
    sourceSurfaceId: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1.sourceSurfaceId,
    featureId: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1.featureId,
    assertionId: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1.assertionId,
    matrixDigest: input.matrixDigest,
    matrixSuiteId: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1.matrixSuiteId,
    matrixSuiteDigest: input.matrixSuiteDigest,
    verifierId: L3_LIVE_AUTO_COMPACTION_VERIFIER_ID_V1,
    verifierDigest: input.verifierDigest,
    caseIds: [...L3_LIVE_AUTO_COMPACTION_CASE_IDS_V1],
  });
}

const sourceOwnedIdentityDeclaration = {
  ...L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1,
  suiteDigest: computeL3LiveAutoCompactionSuiteDigestV1({
    matrixDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1.matrixDigest,
    matrixSuiteDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1.matrixSuiteDigest,
    verifierDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_MATERIAL_V1.verifierDigest,
  }),
};
const sourceOwnedIdentityMaterial = sourceOwnedIdentityMaterialV1Schema.parse(
  sourceOwnedIdentityDeclaration,
);
/** Fully-digested source-owned AQ-9B binding; no unresolved public variant. */
export const L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1 =
  liveAutoCompactionSourceOwnedIdentityV1Schema.parse({
    ...sourceOwnedIdentityMaterial,
    identityDigest: computeLiveAutoCompactionSourceOwnedIdentityDigestV1(
      sourceOwnedIdentityMaterial,
    ),
  });

/**
 * Test-only boundary: a test reconstructs these facts from the source-owned
 * Feature Matrix and supplies them here.  The policy never reads workspace
 * source/config at live-run time, so there is no parallel mutable inventory.
 */
export function assertL3LiveAutoCompactionSourceOwnedMatrixProjectionV1(input: {
  readonly identity: unknown;
  readonly matrixDigest: `sha256:${string}`;
  readonly sourceSurfaceId: string;
  readonly featureId: string;
  readonly assertionId: string;
  readonly matrixSuiteId: string;
  readonly matrixSuiteDigest: `sha256:${string}`;
}): void {
  const identity = liveAutoCompactionSourceOwnedIdentityV1Schema.parse(input.identity);
  if (
    identity.matrixDigest !== input.matrixDigest ||
    identity.sourceSurfaceId !== input.sourceSurfaceId ||
    identity.featureId !== input.featureId ||
    identity.assertionId !== input.assertionId ||
    identity.matrixSuiteId !== input.matrixSuiteId ||
    identity.matrixSuiteDigest !== input.matrixSuiteDigest
  ) {
    throw new Error('live_auto_compaction_source_owned_matrix_drift');
  }
}

const FIXTURE_BYTES = new TextEncoder().encode(
  'schema=qualification-l3-auto-compaction-sealed-synthetic-fixture-v1\nclassification=sealed_synthetic\nmode=diagnostic_only\n',
);
const CORPUS_BYTES = new TextEncoder().encode(
  'schema=qualification-l3-auto-compaction-safe-corpus-v1\nprojection=source_owned\n',
);

export function materializeL3LiveAutoCompactionFixtureBytesV1(): Uint8Array {
  return new Uint8Array(FIXTURE_BYTES);
}

export function materializeL3LiveAutoCompactionCorpusBytesV1(): Uint8Array {
  return new Uint8Array(CORPUS_BYTES);
}

export function computeLiveAutoCompactionFixtureContentDigestV1(
  value: Uint8Array,
): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.live-auto-compaction.fixture-content.v1', value);
}

export function computeLiveAutoCompactionCorpusContentDigestV1(
  value: Uint8Array,
): `sha256:${string}` {
  return sha256DomainSeparated('kite.qualification.live-auto-compaction.corpus-content.v1', value);
}

export function computeLiveAutoCompactionFixtureDigestV1(input: {
  fixtureId: string;
  contentDigest: `sha256:${string}`;
}): `sha256:${string}` {
  return fixedDigest('kite.qualification.live-auto-compaction.fixture.v1', {
    fixtureId: identifierSchema.parse(input.fixtureId),
    contentClass: 'sealed_synthetic',
    contentDigest: digestSchema.parse(input.contentDigest),
  });
}

export function computeLiveAutoCompactionCorpusDigestV1(input: {
  corpusId: string;
  fixtureContentDigest: `sha256:${string}`;
  corpusContentDigest: `sha256:${string}`;
}): `sha256:${string}` {
  return fixedDigest('kite.qualification.live-auto-compaction.corpus.v1', {
    corpusId: identifierSchema.parse(input.corpusId),
    fixtureContentDigest: digestSchema.parse(input.fixtureContentDigest),
    corpusContentDigest: digestSchema.parse(input.corpusContentDigest),
  });
}

export function computeLiveAutoCompactionRunnerSourceDigestV1(
  sourceBytes: Uint8Array,
): `sha256:${string}` {
  if (sourceBytes.byteLength === 0) throw new Error('live_auto_compaction_runner_source_empty');
  return sha256DomainSeparated(
    'kite.qualification.live-auto-compaction.runner-source.v1',
    sourceBytes,
  );
}

export function computeLiveAutoCompactionRunnerDigestV1(input: {
  runnerId: string;
  runnerSourceDigest: `sha256:${string}`;
}): `sha256:${string}` {
  return fixedDigest('kite.qualification.live-auto-compaction.runner.v1', {
    runnerId: identifierSchema.parse(input.runnerId),
    runnerSourceDigest: digestSchema.parse(input.runnerSourceDigest),
  });
}

/** Updated only from exact runner bytes; a test rejects unresolved/drifted source. */
export const L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1 =
  'sha256:c78069a011a62ff8a3b731efc8e2411b47dce476edf6c60447103258c3963cdd' as const;
export const L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1 = computeLiveAutoCompactionRunnerDigestV1({
  runnerId: L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1,
  runnerSourceDigest: L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1,
});

const fixtureContentDigest = computeLiveAutoCompactionFixtureContentDigestV1(FIXTURE_BYTES);
const corpusContentDigest = computeLiveAutoCompactionCorpusContentDigestV1(CORPUS_BYTES);
const fixtureDigest = computeLiveAutoCompactionFixtureDigestV1({
  fixtureId: L3_LIVE_AUTO_COMPACTION_FIXTURE_ID_V1,
  contentDigest: fixtureContentDigest,
});
const corpusDigest = computeLiveAutoCompactionCorpusDigestV1({
  corpusId: 'qualification-l3-auto-compaction-safe-corpus-v1',
  fixtureContentDigest,
  corpusContentDigest,
});

export const L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1 = fixedDigest(
  'kite.qualification.live-auto-compaction.scope-profile.v1',
  { profile: 'local-live-auto-compaction-diagnostic-v1' },
);

const oracleDigest = fixedDigest('kite.qualification.live-auto-compaction.oracle.v1', {
  oracleId: L3_LIVE_AUTO_COMPACTION_ORACLE_ID_V1,
  success: 'auto_request_compact_complete_primary',
  cancelled: 'summary_dispatch_abort_same_turn_stop_next_turn_preflight',
});
const evaluatorDigest = fixedDigest('kite.qualification.live-auto-compaction.evaluator.v1', {
  evaluatorId: L3_LIVE_AUTO_COMPACTION_EVALUATOR_ID_V1,
  outcomes: ['cancelled', 'success'],
  metadataOnly: true,
});

const candidateBindingDigest = fixedDigest(
  'kite.qualification.live-auto-compaction.candidate-binding.v1',
  {
    fixtureDigest,
    corpusDigest,
    oracleDigest,
    evaluatorDigest,
    runnerDigest: L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1,
    sourceOwnedIdentityDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.identityDigest,
    governanceProfileDigest: EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.profileDigest,
  },
);

export const L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1: DiagnosticCandidateArtifactClosureV1 =
  buildDiagnosticCandidateArtifactClosureV1({
    schema: 'DiagnosticCandidateArtifactClosureV1',
    version: 1,
    artifacts: [
      {
        platformIdentity: 'local-host',
        artifact: {
          canonicalRepository: 'diagnostic/qualification',
          repositoryId: 'diagnostic_l3_live_auto_compaction_v1',
          commit: '0000000000000000000000000000000000000000',
          payloadSha256: L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1,
          canonicalManifestDigest: fixtureDigest,
          behaviorDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.identityDigest,
          profileDigest: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_SCOPE_PROFILE_DIGEST_V1,
          gatePolicyDigest: candidateBindingDigest,
        },
      },
    ],
  });

export const L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1 = Object.freeze({
  schema: 'LiveAutoCompactionFixtureDeclarationV1' as const,
  version: 1 as const,
  fixtureId: L3_LIVE_AUTO_COMPACTION_FIXTURE_ID_V1,
  contentDigest: fixtureContentDigest,
  fixtureDigest,
  corpusId: 'qualification-l3-auto-compaction-safe-corpus-v1',
  corpusContentDigest,
  corpusDigest,
  oracleId: L3_LIVE_AUTO_COMPACTION_ORACLE_ID_V1,
  oracleDigest,
  evaluatorId: L3_LIVE_AUTO_COMPACTION_EVALUATOR_ID_V1,
  evaluatorDigest,
  runnerId: L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1,
  runnerSourceDigest: L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1,
  runnerDigest: L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1,
  candidateClosureDigest: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest,
  sourceOwnedIdentity: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1,
  promptEnvironmentDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.promptEnvironmentDigest,
  routeToolCatalogDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.toolCatalogDigest,
  toolEnvironmentDigest: L3_LIVE_AUTO_COMPACTION_TOOL_ENVIRONMENT_V1.toolEnvironmentDigest,
});

const runtimeConfigurationV1Schema = z
  .object({
    contextCompactionV2: z.literal(true),
    contextCompactionAutoV1: z.literal(true),
    autoMode: z.literal('live'),
    compactAfterEstimatedTokens: z.literal(8_192),
    maxSummaryTokens: z.literal(600),
    maxNarrativeTokens: z.literal(800),
    maxSummaryInputTokens: z.literal(8_192),
    contextWindowTokens: z.never().optional(),
  })
  .strict();

const liveAutoCompactionPolicyMaterialV1Schema = z
  .object({
    schema: z.literal('LiveAutoCompactionSuitePolicyV1'),
    version: z.literal(1),
    authority: z.literal('diagnostic'),
    evidenceEligible: z.literal(false),
    issuedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    policyId: z.literal(L3_LIVE_AUTO_COMPACTION_POLICY_ID_V1),
    suiteId: z.literal(L3_LIVE_AUTO_COMPACTION_SUITE_ID_V1),
    sourceOwnedIdentity: liveAutoCompactionSourceOwnedIdentityV1Schema,
    routeId: identifierSchema,
    routeDeclarationDigest: digestSchema,
    routeIdentityDigest: digestSchema,
    providerDataPolicyDigest: digestSchema,
    capabilityDeclarationDigest: digestSchema,
    capabilitySourceBindingDigest: digestSchema,
    governance: z
      .object({
        retentionClass: z.literal('ephemeral_local'),
        profileId: identifierSchema,
        profileDigest: digestSchema,
      })
      .strict(),
    caseIds: z.array(z.enum(L3_LIVE_AUTO_COMPACTION_CASE_IDS_V1)).length(2),
    fixtureId: z.literal(L3_LIVE_AUTO_COMPACTION_FIXTURE_ID_V1),
    fixtureDigest: digestSchema,
    corpusDigest: digestSchema,
    oracleDigest: digestSchema,
    evaluatorDigest: digestSchema,
    verifierDigest: digestSchema,
    runnerSourceDigest: digestSchema,
    runnerDigest: digestSchema,
    candidateClosureDigest: digestSchema,
    promptEnvironmentDigest: digestSchema,
    routeToolCatalogDigest: digestSchema,
    toolEnvironment: z
      .object({
        schema: z.literal('LiveAutoCompactionToolEnvironmentV1'),
        version: z.literal(1),
        toolExecution: z.literal('denied'),
        skillExecution: z.literal('denied'),
        subagentExecution: z.literal('denied'),
        mcpTransport: z.literal('denied'),
        stdioChildren: z.literal('denied'),
        shellChildren: z.literal('denied'),
        childEnvironmentAllowlist: z.array(z.never()).length(0),
        toolEnvironmentDigest: digestSchema,
      })
      .strict(),
    runtimeConfiguration: runtimeConfigurationV1Schema,
    fullProjection: z
      .object({
        minTokens: z.literal(9_000),
        maxTokens: z.literal(10_000),
        thresholdTokens: z.literal(8_192),
      })
      .strict(),
    syntheticProjection: liveAutoCompactionSyntheticProjectionV1Schema,
    phaseCaps: liveAutoCompactionPhaseCapsV1Schema,
    budget: z
      .object({
        maxAttemptsPerInvocation: z.literal(2),
        maxTotalTokens: z.literal(12_229),
        maxRunWallClockSeconds: z.literal(600),
        maxCostUsdMicros: z.literal(250_000),
        maxConcurrentInvocations: z.literal(1),
      })
      .strict(),
    maxRetries: z.literal(0),
    terminalOutcomes: z.array(z.enum(['cancelled', 'success'])).length(2),
    blockedReasonCodes: z.array(z.enum(L3_LIVE_AUTO_COMPACTION_BLOCKED_REASON_CODES_V1)),
    credentialSources: z.array(z.literal('environment')).length(1),
  })
  .strict()
  .superRefine((value, context) => {
    const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
    if (
      Date.parse(value.expiresAt) <= Date.parse(value.issuedAt) ||
      value.governance.profileId !== profile.profileId ||
      value.governance.profileDigest !== profile.profileDigest
    ) {
      context.addIssue({ code: 'custom', message: 'AQ-9B policy governance/expiry mismatch' });
    }
    if (!exactInventory(value.caseIds, L3_LIVE_AUTO_COMPACTION_CASE_IDS_V1)) {
      context.addIssue({
        code: 'custom',
        path: ['caseIds'],
        message: 'AQ-9B case inventory drift',
      });
    }
    if (!exactInventory(value.terminalOutcomes, ['cancelled', 'success'])) {
      context.addIssue({
        code: 'custom',
        path: ['terminalOutcomes'],
        message: 'AQ-9B terminal vocabulary drift',
      });
    }
    if (
      !exactInventory(value.blockedReasonCodes, L3_LIVE_AUTO_COMPACTION_BLOCKED_REASON_CODES_V1)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['blockedReasonCodes'],
        message: 'AQ-9B blocked vocabulary drift',
      });
    }
    if (!exactInventory(value.credentialSources, ['environment'])) {
      context.addIssue({
        code: 'custom',
        path: ['credentialSources'],
        message: 'AQ-9B credential source drift',
      });
    }
    if (
      value.toolEnvironment.toolEnvironmentDigest !==
      L3_LIVE_AUTO_COMPACTION_TOOL_ENVIRONMENT_V1.toolEnvironmentDigest
    ) {
      context.addIssue({
        code: 'custom',
        path: ['toolEnvironment'],
        message: 'AQ-9B tool boundary drift',
      });
    }
    if (
      value.budget.maxAttemptsPerInvocation > profile.quotas.perRun.attempts ||
      value.budget.maxTotalTokens > profile.quotas.perRun.tokens ||
      value.budget.maxRunWallClockSeconds > profile.quotas.perRun.runWallClockSeconds ||
      value.budget.maxCostUsdMicros > profile.quotas.perRun.costUsdMicros ||
      value.budget.maxConcurrentInvocations > profile.quotas.maxConcurrentRuns
    ) {
      context.addIssue({
        code: 'custom',
        path: ['budget'],
        message: 'AQ-9B exceeds accepted governance ceiling',
      });
    }
    if (value.phaseCaps.totalMax !== value.budget.maxTotalTokens) {
      context.addIssue({
        code: 'custom',
        path: ['phaseCaps'],
        message: 'AQ-9B must reserve the full two-phase maximum once',
      });
    }
  });
export type LiveAutoCompactionSuitePolicyMaterialV1 = z.infer<
  typeof liveAutoCompactionPolicyMaterialV1Schema
>;

export function computeLiveAutoCompactionSuitePolicyDigestV1(
  material: LiveAutoCompactionSuitePolicyMaterialV1,
): `sha256:${string}` {
  return fixedDigest(
    'kite.qualification.live-auto-compaction.policy.v1',
    liveAutoCompactionPolicyMaterialV1Schema.parse(material),
  );
}

export const liveAutoCompactionSuitePolicyV1Schema = liveAutoCompactionPolicyMaterialV1Schema
  .extend({ policyDigest: digestSchema })
  .strict()
  .superRefine((value, context) => {
    const { policyDigest, ...material } = value;
    if (policyDigest !== computeLiveAutoCompactionSuitePolicyDigestV1(material)) {
      context.addIssue({
        code: 'custom',
        path: ['policyDigest'],
        message: 'AQ-9B policy digest mismatch',
      });
    }
  });
export type LiveAutoCompactionSuitePolicyV1 = z.infer<typeof liveAutoCompactionSuitePolicyV1Schema>;

function buildPolicy(): LiveAutoCompactionSuitePolicyV1 {
  const material = liveAutoCompactionPolicyMaterialV1Schema.parse({
    schema: 'LiveAutoCompactionSuitePolicyV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    issuedAt: '2026-08-05T00:00:00.000Z',
    expiresAt: '2026-12-31T00:00:00.000Z',
    policyId: L3_LIVE_AUTO_COMPACTION_POLICY_ID_V1,
    suiteId: L3_LIVE_AUTO_COMPACTION_SUITE_ID_V1,
    sourceOwnedIdentity: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1,
    routeId: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.routeId,
    routeDeclarationDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.declarationDigest,
    routeIdentityDigest: L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1.routeIdentityDigest,
    providerDataPolicyDigest: L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.policyDigest,
    capabilityDeclarationDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.capabilityDeclarationDigest,
    capabilitySourceBindingDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.capabilitySourceBindingDigest,
    governance: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.governance,
    caseIds: [...L3_LIVE_AUTO_COMPACTION_CASE_IDS_V1],
    fixtureId: L3_LIVE_AUTO_COMPACTION_FIXTURE_ID_V1,
    fixtureDigest,
    corpusDigest,
    oracleDigest,
    evaluatorDigest,
    verifierDigest: L3_LIVE_AUTO_COMPACTION_SOURCE_OWNED_IDENTITY_V1.verifierDigest,
    runnerSourceDigest: L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1,
    runnerDigest: L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1,
    candidateClosureDigest: L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest,
    promptEnvironmentDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.promptEnvironmentDigest,
    routeToolCatalogDigest: L3_QWEN_LIVE_ROUTE_DECLARATION_V1.toolCatalogDigest,
    toolEnvironment: L3_LIVE_AUTO_COMPACTION_TOOL_ENVIRONMENT_V1,
    runtimeConfiguration: {
      contextCompactionV2: true,
      contextCompactionAutoV1: true,
      autoMode: 'live',
      compactAfterEstimatedTokens: 8_192,
      maxSummaryTokens: 600,
      maxNarrativeTokens: 800,
      maxSummaryInputTokens: 8_192,
    },
    fullProjection: { minTokens: 9_000, maxTokens: 10_000, thresholdTokens: 8_192 },
    syntheticProjection: L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1,
    phaseCaps: L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1,
    budget: {
      maxAttemptsPerInvocation: 2,
      maxTotalTokens: 12_229,
      maxRunWallClockSeconds: 600,
      maxCostUsdMicros: 250_000,
      maxConcurrentInvocations: 1,
    },
    maxRetries: 0,
    terminalOutcomes: ['cancelled', 'success'],
    blockedReasonCodes: [...L3_LIVE_AUTO_COMPACTION_BLOCKED_REASON_CODES_V1],
    credentialSources: ['environment'],
  });
  return liveAutoCompactionSuitePolicyV1Schema.parse({
    ...material,
    policyDigest: computeLiveAutoCompactionSuitePolicyDigestV1(material),
  });
}

export const L3_LIVE_AUTO_COMPACTION_POLICY_V1 = buildPolicy();

export function assertL3LiveAutoCompactionFixtureContentV1(content: Uint8Array): void {
  if (
    computeLiveAutoCompactionFixtureContentDigestV1(content) !==
    L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.contentDigest
  ) {
    throw new Error('live_auto_compaction_fixture_content_mismatch');
  }
}

export function assertL3LiveAutoCompactionCorpusContentV1(content: Uint8Array): void {
  if (
    computeLiveAutoCompactionCorpusContentDigestV1(content) !==
    L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.corpusContentDigest
  ) {
    throw new Error('live_auto_compaction_corpus_content_mismatch');
  }
}

export function assertL3LiveAutoCompactionRunnerSourceDriftV1(input: {
  runnerId: string;
  sourceBytes: Uint8Array;
}): void {
  const sourceDigest = computeLiveAutoCompactionRunnerSourceDigestV1(input.sourceBytes);
  const runnerDigest = computeLiveAutoCompactionRunnerDigestV1({
    runnerId: input.runnerId,
    runnerSourceDigest: sourceDigest,
  });
  if (
    input.runnerId !== L3_LIVE_AUTO_COMPACTION_RUNNER_ID_V1 ||
    sourceDigest !== L3_LIVE_AUTO_COMPACTION_RUNNER_SOURCE_DIGEST_V1 ||
    runnerDigest !== L3_LIVE_AUTO_COMPACTION_RUNNER_DIGEST_V1
  ) {
    throw new Error('live_auto_compaction_runner_source_drift');
  }
}

/** Strict source-owned closure used by runner and specialized verifier. */
export function l3LiveAutoCompactionPolicyIsClosedV1(): boolean {
  const policy = L3_LIVE_AUTO_COMPACTION_POLICY_V1;
  return (
    liveAutoCompactionSuitePolicyV1Schema.safeParse(policy).success &&
    sortedUnique(policy.caseIds) &&
    policy.routeId === L3_QWEN_LIVE_ROUTE_DECLARATION_V1.routeId &&
    policy.routeIdentityDigest === L3_LIVE_AUTO_COMPACTION_ROUTE_IDENTITY_V1.routeIdentityDigest &&
    policy.providerDataPolicyDigest === L3_QWEN_DIAGNOSTIC_PROVIDER_DATA_POLICY_V1.policyDigest &&
    policy.fixtureDigest === L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.fixtureDigest &&
    policy.corpusDigest === L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.corpusDigest &&
    policy.runnerDigest === L3_LIVE_AUTO_COMPACTION_FIXTURE_DECLARATION_V1.runnerDigest &&
    policy.candidateClosureDigest ===
      L3_LIVE_AUTO_COMPACTION_DIAGNOSTIC_CANDIDATE_CLOSURE_V1.closureDigest &&
    policy.phaseCaps.phaseCapsDigest === L3_LIVE_AUTO_COMPACTION_PHASE_CAPS_V1.phaseCapsDigest &&
    policy.syntheticProjection.syntheticProjectionDigest ===
      L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1.syntheticProjectionDigest &&
    policy.syntheticProjection.historyChunkRepeats ===
      L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1.historyChunkRepeats &&
    policy.syntheticProjection.safeSummaryTokens ===
      L3_LIVE_AUTO_COMPACTION_SYNTHETIC_PROJECTION_V1.safeSummaryTokens
  );
}
