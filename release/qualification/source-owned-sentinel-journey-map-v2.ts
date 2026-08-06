import { z } from 'zod';
import {
  reconstructSourceOwnedL1PublicProjectionV1,
  reconstructSourceOwnedL1SkillMcpV1,
  reconstructSourceOwnedL1SubagentRecoveryV1,
  reconstructSourceOwnedL1ToolVerificationV1,
  reconstructSourceOwnedL1TuiRewindForkProjectionV1,
  verifyL1PublicProjectionEvidenceV1,
  verifyL1SkillMcpEvidenceV1,
  verifyL1SubagentRecoveryEvidenceV1,
  verifyL1ToolVerificationEvidenceV1,
  verifyL1TuiRewindForkProjectionEvidenceV1,
} from '../../scripts/evals/contracts/qualification/evidence/evidence-verifier-v1';
import { canonicalJsonBytes } from '../../scripts/release/canonical-json';
import {
  computeSentinelJourneyMapDigestV2,
  SENTINEL_JOURNEY_BLOCKED_REASONS_V2,
  SENTINEL_JOURNEY_IDS_V2,
  type SentinelJourneyApplicabilityEntryV2,
  type SentinelJourneyApplicabilityInputEntryV2,
  type SentinelJourneyApplicabilityInputV2,
  type SentinelJourneyApplicabilityV2,
  type SentinelJourneyBehavioralReceiptLinkV2,
  type SentinelJourneyBlockedReasonV2,
  type SentinelJourneyIdV2,
  type SentinelJourneyMapMaterialV2,
  type SentinelJourneyMapRowV2,
  type SentinelJourneyMapV2,
  type SentinelJourneyProjectionReceiptLinkV2,
  type SentinelJourneyRequiredWhenV2,
  type SentinelJourneySourceBindingV2,
  type SentinelJourneyTrustedRowInputV2,
  type SentinelJourneyTrustedSnapshotV2,
  sentinelJourneyApplicabilityV2Schema,
  sentinelJourneyMapRowV2Schema,
  sentinelJourneyMapV2Schema,
} from './sentinel-journey-map-v2';

const sourceOwnedSentinelJourneyMapInputV1Schema = z
  .object({
    schema: z.literal('SourceOwnedSentinelJourneyMapV2InputV1'),
    version: z.literal(1),
    behavioralEvidence: z.unknown(),
    cliProjectionEvidence: z.unknown(),
    tuiProjectionEvidence: z.unknown(),
  })
  .strict();

const SKILL_MCP_SOURCE_SURFACE_IDS_V2 = [
  'runtime:tool-lifecycle',
  'mcp:supervisor-control',
  'mcp:write-recovery',
  'runtime:interaction-action',
  'skill:open-world-contract',
  'skill:workflow-contract',
] as const;

type SkillMcpSourceSurfaceIdV2 = (typeof SKILL_MCP_SOURCE_SURFACE_IDS_V2)[number];

/**
 * These six opaque values are individually candidate-bound verifier inputs,
 * not a caller-defined source map.  The property names fix which product-owned
 * source surface must validate each record; a swapped record can therefore
 * never qualify the binding selected below.
 */
const l1SkillMcpEvidenceInputsV2Schema = z
  .object({
    'runtime:tool-lifecycle': z.unknown(),
    'mcp:supervisor-control': z.unknown(),
    'mcp:write-recovery': z.unknown(),
    'runtime:interaction-action': z.unknown(),
    'skill:open-world-contract': z.unknown(),
    'skill:workflow-contract': z.unknown(),
  })
  .strict();

const sourceOwnedSentinelJourneyMapInputV2BranchSchema = z
  .object({
    schema: z.literal('SourceOwnedSentinelJourneyMapV2InputV2'),
    version: z.literal(2),
    behavioralEvidence: z.unknown(),
    cliProjectionEvidence: z.unknown(),
    tuiProjectionEvidence: z.unknown(),
    skillMcpEvidence: l1SkillMcpEvidenceInputsV2Schema,
  })
  .strict();

/**
 * AQ-6 fixes one verifier-input slot per product-owned recovery cut point.
 * These keys are not a caller-authored journey map: a record placed under the
 * wrong key is reverified against that exact source surface and fails closed.
 */
const SUBAGENT_RECOVERY_SOURCE_SURFACE_IDS_V3 = [
  'subagent:open-world-contract',
  'subagent:tool-controller',
  'runtime:reducer-terminality',
  'runtime:kernel-recovery',
  'runtime:late-event-terminality',
  'runtime:cancellation-boundary',
  'runtime:session-fork',
] as const;

type SubagentRecoverySourceSurfaceIdV3 = (typeof SUBAGENT_RECOVERY_SOURCE_SURFACE_IDS_V3)[number];

const l1SubagentRecoveryEvidenceInputsV3Schema = z
  .object({
    'subagent:open-world-contract': z.unknown(),
    'subagent:tool-controller': z.unknown(),
    'runtime:reducer-terminality': z.unknown(),
    'runtime:kernel-recovery': z.unknown(),
    'runtime:late-event-terminality': z.unknown(),
    'runtime:cancellation-boundary': z.unknown(),
    'runtime:session-fork': z.unknown(),
  })
  .strict();

/**
 * The public `/rewind` receipt is deliberately a separate projection suite.
 * Its source surface, fixture/runner, receipt, and suite identity cannot be
 * substituted with AQ-6's internal fork receipt.
 */
const sourceOwnedSentinelJourneyMapInputV3BranchSchema = z
  .object({
    schema: z.literal('SourceOwnedSentinelJourneyMapV2InputV3'),
    version: z.literal(3),
    behavioralEvidence: z.unknown(),
    cliProjectionEvidence: z.unknown(),
    tuiProjectionEvidence: z.unknown(),
    skillMcpEvidence: l1SkillMcpEvidenceInputsV2Schema,
    subagentRecoveryEvidence: l1SubagentRecoveryEvidenceInputsV3Schema,
    tuiRewindProjectionEvidence: z.unknown(),
  })
  .strict();

const sourceOwnedSentinelJourneyMapInputSchema = z.union([
  sourceOwnedSentinelJourneyMapInputV1Schema,
  sourceOwnedSentinelJourneyMapInputV2BranchSchema,
  sourceOwnedSentinelJourneyMapInputV3BranchSchema,
]);

export type SourceOwnedSentinelJourneyMapInputV1 = z.infer<
  typeof sourceOwnedSentinelJourneyMapInputV1Schema
>;
export type SourceOwnedSentinelJourneyMapInputV2Branch = z.infer<
  typeof sourceOwnedSentinelJourneyMapInputV2BranchSchema
>;
export type SourceOwnedSentinelJourneyMapInputV3 = z.infer<
  typeof sourceOwnedSentinelJourneyMapInputV3BranchSchema
>;
/** V1/V2 remain reconstructible while V3 adds AQ-6's closed source inputs. */
export type SourceOwnedSentinelJourneyMapInputV2 = z.infer<
  typeof sourceOwnedSentinelJourneyMapInputSchema
>;

const TOOL_JOURNEY_BINDINGS_V2 = [
  {
    journeyId: 'sentinel-tool-approval-execution-verification',
    behavioralAdapterId: 'runtime-tool-approval-verification-v1',
    cliProjectionAdapterId: 'cli-tool-approval-projection-v1',
    tuiProjectionAdapterId: 'tui-tool-approval-projection-v1',
  },
  {
    journeyId: 'sentinel-tool-invalid-arguments-correction',
    behavioralAdapterId: 'runtime-invalid-tool-correction-v1',
    cliProjectionAdapterId: 'cli-invalid-arguments-projection-v1',
    tuiProjectionAdapterId: 'tui-invalid-arguments-projection-v1',
  },
] as const;

/**
 * AQ-5 closures deliberately name only the source-owned adapter pair. Feature
 * IDs and assertion IDs are regenerated from the collector; they are never
 * copied into this journey routing table.
 */
const SKILL_MCP_JOURNEY_BINDINGS_V2 = [
  {
    journeyId: 'sentinel-skill-discovery-activation-dependency-output-validation',
    bindings: [
      {
        sourceSurfaceId: 'skill:open-world-contract',
        adapterId: 'skill-discovery-activation-output-v1',
      },
    ],
  },
  {
    journeyId: 'sentinel-skill-mcp-revision-drift',
    bindings: [
      {
        sourceSurfaceId: 'skill:workflow-contract',
        adapterId: 'skill-mcp-dependency-revision-drift-v1',
      },
    ],
  },
  {
    journeyId: 'sentinel-mcp-config-approval-connect-oauth-discovery-call',
    bindings: [
      {
        sourceSurfaceId: 'mcp:supervisor-control',
        adapterId: 'mcp-project-approval-catalog-churn-v1',
      },
      {
        sourceSurfaceId: 'mcp:write-recovery',
        adapterId: 'mcp-unknown-write-reconciliation-v1',
      },
    ],
  },
  {
    journeyId: 'sentinel-mcp-auth-expired-login-new-turn',
    bindings: [
      {
        sourceSurfaceId: 'runtime:tool-lifecycle',
        adapterId: 'mcp-auth-invalid-provider-action-v1',
      },
      {
        sourceSurfaceId: 'runtime:interaction-action',
        adapterId: 'runtime-provider-action-new-turn-v1',
      },
    ],
  },
] as const;

/**
 * AQ-6 joins only closed product-owned recovery pairs.  The repeated
 * `runtime:kernel-recovery` / late-terminal records are intentional: one
 * verifier record may be required by more than one durable journey, but it is
 * never copied into a second broad suite record.
 */
const SUBAGENT_RECOVERY_JOURNEY_BINDINGS_V3 = [
  {
    journeyId: 'sentinel-subagent-approval-restart-continuation',
    bindings: [
      {
        sourceSurfaceId: 'subagent:open-world-contract',
        adapterId: 'subagent-parent-child-reservation-v1',
      },
      {
        sourceSurfaceId: 'subagent:tool-controller',
        adapterId: 'subagent-approval-resume-claim-v1',
      },
      {
        sourceSurfaceId: 'runtime:kernel-recovery',
        adapterId: 'runtime-subagent-restart-unknown-v1',
      },
      {
        sourceSurfaceId: 'runtime:reducer-terminality',
        adapterId: 'runtime-subagent-terminal-consumption-v1',
      },
    ],
  },
  {
    journeyId: 'sentinel-effect-unknown-restart-reconciliation',
    bindings: [
      {
        sourceSurfaceId: 'runtime:kernel-recovery',
        adapterId: 'runtime-subagent-restart-unknown-v1',
      },
      {
        sourceSurfaceId: 'runtime:late-event-terminality',
        adapterId: 'runtime-late-terminal-convergence-v1',
      },
    ],
  },
  {
    journeyId: 'sentinel-parallel-tool-subagent-cancel-convergence',
    bindings: [
      {
        sourceSurfaceId: 'runtime:cancellation-boundary',
        adapterId: 'runtime-parallel-cancel-convergence-v1',
      },
      {
        sourceSurfaceId: 'runtime:late-event-terminality',
        adapterId: 'runtime-late-terminal-convergence-v1',
      },
    ],
  },
  {
    journeyId: 'sentinel-elevated-session-rewind-fork-tightening',
    bindings: [
      {
        sourceSurfaceId: 'runtime:session-fork',
        adapterId: 'runtime-rewind-fork-tightening-v1',
      },
    ],
  },
] as const;

/** The V2 schema's six verifier-input slots must all close a J3--J6 binding. */
function assertSkillMcpJourneyInputCoverageV2(): void {
  const sourceSurfaceIds = SKILL_MCP_JOURNEY_BINDINGS_V2.flatMap((journey) =>
    journey.bindings.map((binding) => binding.sourceSurfaceId),
  ).sort(compareCodePoint);
  const expected = [...SKILL_MCP_SOURCE_SURFACE_IDS_V2].sort(compareCodePoint);
  if (
    sourceSurfaceIds.length !== expected.length ||
    sourceSurfaceIds.some((sourceSurfaceId, index) => sourceSurfaceId !== expected[index])
  ) {
    throw new Error('source_owned_sentinel_v2_skill_mcp_input_coverage_drift');
  }
}

assertSkillMcpJourneyInputCoverageV2();

/** Every V3 recovery record must participate in at least one fixed journey. */
function assertSubagentRecoveryJourneyInputCoverageV3(): void {
  const covered = new Set<string>(
    SUBAGENT_RECOVERY_JOURNEY_BINDINGS_V3.flatMap((journey) =>
      journey.bindings.map((binding) => binding.sourceSurfaceId),
    ),
  );
  const expected = [...SUBAGENT_RECOVERY_SOURCE_SURFACE_IDS_V3].sort(compareCodePoint);
  if (
    covered.size !== expected.length ||
    expected.some((sourceSurfaceId) => !covered.has(sourceSurfaceId))
  ) {
    throw new Error('source_owned_sentinel_v3_subagent_recovery_input_coverage_drift');
  }
}

assertSubagentRecoveryJourneyInputCoverageV3();

/**
 * The only source-owned diagnostic V2 constructor. It accepts candidate-bound
 * evidence verifier inputs, never a callback or a persisted map. Source
 * ownership, Matrix/suite identities, receipts, projection bindings, and
 * applicability are freshly reconstructed before a row may be observed.
 */
export async function buildSourceOwnedSentinelJourneyMapV2(
  input: unknown,
  now = new Date(),
): Promise<SentinelJourneyMapV2> {
  const parsedInput = sourceOwnedSentinelJourneyMapInputSchema.safeParse(input);
  const behavioral = await reconstructSourceOwnedL1ToolVerificationV1();
  const projection = reconstructSourceOwnedL1PublicProjectionV1();
  if (behavioral.matrix.matrixDigest !== projection.matrix.matrixDigest) {
    throw new Error('source_owned_sentinel_v2_matrix_identity_drift');
  }

  const behavioralReport = parsedInput.success
    ? await verifyL1ToolVerificationEvidenceV1(parsedInput.data.behavioralEvidence, now)
    : await verifyL1ToolVerificationEvidenceV1(undefined, now);
  const cliProjectionReport = parsedInput.success
    ? verifyL1PublicProjectionEvidenceV1(parsedInput.data.cliProjectionEvidence, now)
    : verifyL1PublicProjectionEvidenceV1(undefined, now);
  const tuiProjectionReport = parsedInput.success
    ? verifyL1PublicProjectionEvidenceV1(parsedInput.data.tuiProjectionEvidence, now)
    : verifyL1PublicProjectionEvidenceV1(undefined, now);
  const v2Input =
    parsedInput.success && (parsedInput.data.version === 2 || parsedInput.data.version === 3)
      ? parsedInput.data
      : undefined;
  const v3Input =
    parsedInput.success && parsedInput.data.version === 3 ? parsedInput.data : undefined;
  const skillMcp = v2Input ? await reconstructSourceOwnedL1SkillMcpV1() : undefined;
  const subagentRecovery = v3Input ? await reconstructSourceOwnedL1SubagentRecoveryV1() : undefined;
  const tuiRewindProjection = v3Input
    ? await reconstructSourceOwnedL1TuiRewindForkProjectionV1()
    : undefined;
  if (skillMcp && skillMcp.matrix.matrixDigest !== behavioral.matrix.matrixDigest) {
    throw new Error('source_owned_sentinel_v2_matrix_identity_drift');
  }
  if (subagentRecovery && subagentRecovery.matrix.matrixDigest !== behavioral.matrix.matrixDigest) {
    throw new Error('source_owned_sentinel_v3_matrix_identity_drift');
  }
  if (
    tuiRewindProjection &&
    tuiRewindProjection.matrix.matrixDigest !== behavioral.matrix.matrixDigest
  ) {
    throw new Error('source_owned_sentinel_v3_matrix_identity_drift');
  }
  const skillMcpReports = new Map<
    SkillMcpSourceSurfaceIdV2,
    Awaited<ReturnType<typeof verifyL1SkillMcpEvidenceV1>>
  >();
  if (v2Input) {
    for (const sourceSurfaceId of SKILL_MCP_SOURCE_SURFACE_IDS_V2) {
      skillMcpReports.set(
        sourceSurfaceId,
        await verifyL1SkillMcpEvidenceV1(v2Input.skillMcpEvidence[sourceSurfaceId], now),
      );
    }
  }
  const subagentRecoveryReports = new Map<
    SubagentRecoverySourceSurfaceIdV3,
    Awaited<ReturnType<typeof verifyL1SubagentRecoveryEvidenceV1>>
  >();
  if (v3Input) {
    for (const sourceSurfaceId of SUBAGENT_RECOVERY_SOURCE_SURFACE_IDS_V3) {
      subagentRecoveryReports.set(
        sourceSurfaceId,
        await verifyL1SubagentRecoveryEvidenceV1(
          v3Input.subagentRecoveryEvidence[sourceSurfaceId],
          now,
        ),
      );
    }
  }
  const tuiRewindProjectionReport = v3Input
    ? await verifyL1TuiRewindForkProjectionEvidenceV1(v3Input.tuiRewindProjectionEvidence, now)
    : undefined;
  const candidateClosureAligned = sameCandidateClosureV2([
    behavioralReport,
    cliProjectionReport,
    tuiProjectionReport,
    ...skillMcpReports.values(),
    ...subagentRecoveryReports.values(),
    ...(tuiRewindProjectionReport ? [tuiRewindProjectionReport] : []),
  ]);
  const rows: SentinelJourneyTrustedRowInputV2[] = [
    ...buildToolJourneyRowsV2({
      behavioral,
      projection,
      behavioralReport,
      cliProjectionReport,
      tuiProjectionReport,
      candidateClosureAligned,
    }),
    ...(skillMcp
      ? buildSkillMcpJourneyRowsV2({
          skillMcp,
          reports: skillMcpReports,
          candidateClosureAligned,
        })
      : []),
    ...(subagentRecovery && tuiRewindProjection && tuiRewindProjectionReport
      ? buildSubagentRecoveryJourneyRowsV3({
          subagentRecovery,
          reports: subagentRecoveryReports,
          tuiRewindProjection,
          tuiRewindProjectionReport,
          candidateClosureAligned,
        })
      : []),
  ];

  const snapshot: SentinelJourneyTrustedSnapshotV2 = {
    schema: 'SentinelJourneyMapV2TrustedSnapshot',
    version: 1,
    matrixDigest: behavioral.matrix.matrixDigest,
    rows,
  };
  return materializeSourceOwnedSentinelJourneyMapV2(snapshot);
}

function buildToolJourneyRowsV2(input: {
  behavioral: Awaited<ReturnType<typeof reconstructSourceOwnedL1ToolVerificationV1>>;
  projection: ReturnType<typeof reconstructSourceOwnedL1PublicProjectionV1>;
  behavioralReport: Awaited<ReturnType<typeof verifyL1ToolVerificationEvidenceV1>>;
  cliProjectionReport: ReturnType<typeof verifyL1PublicProjectionEvidenceV1>;
  tuiProjectionReport: ReturnType<typeof verifyL1PublicProjectionEvidenceV1>;
  candidateClosureAligned: boolean;
}): SentinelJourneyTrustedRowInputV2[] {
  return TOOL_JOURNEY_BINDINGS_V2.map((binding) => {
    const behavioralBinding = input.behavioral.bindings.find(
      (candidate) => candidate.binding.adapterId === binding.behavioralAdapterId,
    );
    const behavioralReceipt = input.behavioral.receipts.find(
      (candidate) => candidate.adapterId === binding.behavioralAdapterId,
    );
    const cliBinding = input.projection.bindings.find(
      (candidate) => candidate.binding.adapterId === binding.cliProjectionAdapterId,
    );
    const cliReceipt = input.projection.receipts.find(
      (candidate) => candidate.adapterId === binding.cliProjectionAdapterId,
    );
    const tuiBinding = input.projection.bindings.find(
      (candidate) => candidate.binding.adapterId === binding.tuiProjectionAdapterId,
    );
    const tuiReceipt = input.projection.receipts.find(
      (candidate) => candidate.adapterId === binding.tuiProjectionAdapterId,
    );
    if (
      !behavioralBinding ||
      !behavioralReceipt ||
      !cliBinding ||
      !cliReceipt ||
      !tuiBinding ||
      !tuiReceipt
    ) {
      throw new Error('source_owned_sentinel_v2_closed_binding_missing');
    }
    const behavioralSourceBinding = toSourceBindingV2(behavioralBinding);
    const cliSourceBinding = toSourceBindingV2(cliBinding);
    const tuiSourceBinding = toSourceBindingV2(tuiBinding);
    const behavioralObserved =
      input.candidateClosureAligned &&
      reportQualified(
        input.behavioralReport,
        behavioralBinding.featureId,
        behavioralBinding.binding.assertionId,
      );
    const cliObserved =
      input.candidateClosureAligned &&
      reportQualified(
        input.cliProjectionReport,
        cliBinding.featureId,
        cliBinding.binding.assertionId,
      );
    const tuiObserved =
      input.candidateClosureAligned &&
      reportQualified(
        input.tuiProjectionReport,
        tuiBinding.featureId,
        tuiBinding.binding.assertionId,
      );
    const behavioralLink = toBehavioralReceiptLinkV2(
      behavioralSourceBinding,
      behavioralReceipt,
      input.behavioral.suite.suiteId,
      behavioralObserved,
    );
    return {
      journeyId: binding.journeyId,
      sourceBindings: [behavioralSourceBinding],
      behavioralReceipts: [behavioralLink],
      entrypointProjectionReceipts: {
        cli: [
          toProjectionReceiptLinkV2(
            'cli',
            behavioralLink,
            cliSourceBinding,
            cliReceipt,
            cliObserved,
          ),
        ],
        tui: [
          toProjectionReceiptLinkV2(
            'tui',
            behavioralLink,
            tuiSourceBinding,
            tuiReceipt,
            tuiObserved,
          ),
        ],
      },
      applicability: {
        journey: requiredWhenFor(
          input.behavioral.matrix,
          behavioralBinding.featureId,
          behavioralBinding.binding.assertionId,
          input.behavioral.suite.suiteId,
        ),
        cli: requiredWhenFor(
          input.projection.matrix,
          cliBinding.featureId,
          cliBinding.binding.assertionId,
          input.projection.suite.suiteId,
        ),
        tui: requiredWhenFor(
          input.projection.matrix,
          tuiBinding.featureId,
          tuiBinding.binding.assertionId,
          input.projection.suite.suiteId,
        ),
      },
    };
  });
}

/**
 * AQ-5 does not invent a public receipt from a runtime receipt. The current
 * public projection catalog has no adapter for any *full* J3--J6 journey.
 * In particular `tui-provider-action-projection-v1` renders only an
 * action-required prompt; it cannot attest login completion and a fresh turn.
 * Thus the full journeys carry explicit source-owned `entrypoint_not_exposed`
 * N/A entries instead of a partial or fabricated projection link.
 */
function fullJourneyEntrypointNotExposedV2(): SentinelJourneyApplicabilityInputEntryV2 {
  return { notApplicableRationale: 'entrypoint_not_exposed' };
}

function buildSkillMcpJourneyRowsV2(input: {
  skillMcp: Awaited<ReturnType<typeof reconstructSourceOwnedL1SkillMcpV1>>;
  reports: ReadonlyMap<
    SkillMcpSourceSurfaceIdV2,
    Awaited<ReturnType<typeof verifyL1SkillMcpEvidenceV1>>
  >;
  candidateClosureAligned: boolean;
}): SentinelJourneyTrustedRowInputV2[] {
  return SKILL_MCP_JOURNEY_BINDINGS_V2.map((journey) => {
    const closedLinks = journey.bindings.map((route) => {
      const binding = input.skillMcp.bindings.find(
        (candidate) =>
          candidate.sourceSurfaceId === route.sourceSurfaceId &&
          candidate.binding.adapterId === route.adapterId,
      );
      const receipt = input.skillMcp.receipts.find(
        (candidate) =>
          candidate.sourceSurfaceId === route.sourceSurfaceId &&
          candidate.adapterId === route.adapterId,
      );
      const report = input.reports.get(route.sourceSurfaceId);
      if (!binding || !receipt || !report) {
        throw new Error('source_owned_sentinel_v2_skill_mcp_closed_binding_missing');
      }
      const sourceBinding = toSourceBindingV2(binding);
      return {
        sourceBinding,
        binding,
        receipt,
        observed:
          input.candidateClosureAligned &&
          reportQualified(report, binding.featureId, binding.binding.assertionId),
      };
    });
    return {
      journeyId: journey.journeyId,
      sourceBindings: closedLinks.map((link) => link.sourceBinding),
      behavioralReceipts: closedLinks.map((link) =>
        toBehavioralReceiptLinkV2(
          link.sourceBinding,
          link.receipt,
          input.skillMcp.suite.suiteId,
          link.observed,
        ),
      ),
      entrypointProjectionReceipts: { cli: [], tui: [] },
      applicability: {
        journey: sharedRequiredWhenFor(
          input.skillMcp.matrix,
          closedLinks.map((link) => link.binding),
          input.skillMcp.suite.suiteId,
        ),
        cli: fullJourneyEntrypointNotExposedV2(),
        tui: fullJourneyEntrypointNotExposedV2(),
      },
    };
  });
}

/**
 * AQ-6 joins source-owned recovery receipts into J7--J10. The only public
 * projection is J10's separately reconstructed TUI `/rewind` receipt; J7--J9
 * retain source-derived N/A entries because their owning runtime symbols do
 * not expose a full CLI/TUI journey.
 */
function buildSubagentRecoveryJourneyRowsV3(input: {
  subagentRecovery: Awaited<ReturnType<typeof reconstructSourceOwnedL1SubagentRecoveryV1>>;
  reports: ReadonlyMap<
    SubagentRecoverySourceSurfaceIdV3,
    Awaited<ReturnType<typeof verifyL1SubagentRecoveryEvidenceV1>>
  >;
  tuiRewindProjection: Awaited<
    ReturnType<typeof reconstructSourceOwnedL1TuiRewindForkProjectionV1>
  >;
  tuiRewindProjectionReport: Awaited<ReturnType<typeof verifyL1TuiRewindForkProjectionEvidenceV1>>;
  candidateClosureAligned: boolean;
}): SentinelJourneyTrustedRowInputV2[] {
  return SUBAGENT_RECOVERY_JOURNEY_BINDINGS_V3.map((journey) => {
    const closedLinks = journey.bindings.map((route) => {
      const binding = input.subagentRecovery.bindings.find(
        (candidate) =>
          candidate.sourceSurfaceId === route.sourceSurfaceId &&
          candidate.binding.adapterId === route.adapterId,
      );
      const receipt = input.subagentRecovery.receipts.find(
        (candidate) =>
          candidate.sourceSurfaceId === route.sourceSurfaceId &&
          candidate.adapterId === route.adapterId,
      );
      const report = input.reports.get(route.sourceSurfaceId);
      if (!binding || !receipt || !report) {
        throw new Error('source_owned_sentinel_v3_subagent_recovery_closed_binding_missing');
      }
      const sourceBinding = toSourceBindingV2(binding);
      return {
        sourceBinding,
        binding,
        receipt,
        observed:
          input.candidateClosureAligned &&
          reportQualified(report, binding.featureId, binding.binding.assertionId),
      };
    });
    const behavioralReceipts = closedLinks.map((link) =>
      toBehavioralReceiptLinkV2(
        link.sourceBinding,
        link.receipt,
        input.subagentRecovery.suite.suiteId,
        link.observed,
      ),
    );
    const isRewindJourney =
      journey.journeyId === 'sentinel-elevated-session-rewind-fork-tightening';
    if (!isRewindJourney) {
      return {
        journeyId: journey.journeyId,
        sourceBindings: closedLinks.map((link) => link.sourceBinding),
        behavioralReceipts,
        entrypointProjectionReceipts: { cli: [], tui: [] },
        applicability: {
          journey: sharedRequiredWhenFor(
            input.subagentRecovery.matrix,
            closedLinks.map((link) => link.binding),
            input.subagentRecovery.suite.suiteId,
          ),
          cli: sourceOwnedEntrypointNotExposedV3(
            input.subagentRecovery.matrix,
            closedLinks.map((link) => link.binding),
            'cli',
          ),
          tui: sourceOwnedEntrypointNotExposedV3(
            input.subagentRecovery.matrix,
            closedLinks.map((link) => link.binding),
            'tui',
          ),
        },
      };
    }

    const projectionBinding = input.tuiRewindProjection.bindings.find(
      (candidate) =>
        candidate.sourceSurfaceId === 'tui:rewind-control' &&
        candidate.binding.adapterId === 'tui-rewind-fork-projection-v1',
    );
    const projectionReceipt = input.tuiRewindProjection.receipts.find(
      (candidate) =>
        candidate.sourceSurfaceId === 'tui:rewind-control' &&
        candidate.adapterId === 'tui-rewind-fork-projection-v1',
    );
    if (!projectionBinding || !projectionReceipt) {
      throw new Error('source_owned_sentinel_v3_tui_rewind_projection_binding_missing');
    }
    const projectionSourceBinding = toSourceBindingV2(projectionBinding);
    const projectionObserved =
      input.candidateClosureAligned &&
      reportQualified(
        input.tuiRewindProjectionReport,
        projectionBinding.featureId,
        projectionBinding.binding.assertionId,
      );
    return {
      journeyId: journey.journeyId,
      sourceBindings: closedLinks.map((link) => link.sourceBinding),
      behavioralReceipts,
      entrypointProjectionReceipts: {
        cli: [],
        tui: behavioralReceipts.map((behavioralReceipt) =>
          toProjectionReceiptLinkV2(
            'tui',
            behavioralReceipt,
            projectionSourceBinding,
            projectionReceipt,
            projectionObserved,
          ),
        ),
      },
      applicability: {
        journey: sharedRequiredWhenFor(
          input.subagentRecovery.matrix,
          closedLinks.map((link) => link.binding),
          input.subagentRecovery.suite.suiteId,
        ),
        cli: sourceOwnedEntrypointNotExposedV3(
          input.subagentRecovery.matrix,
          closedLinks.map((link) => link.binding),
          'cli',
        ),
        tui: requiredWhenFor(
          input.tuiRewindProjection.matrix,
          projectionBinding.featureId,
          projectionBinding.binding.assertionId,
          input.tuiRewindProjection.suite.suiteId,
        ),
      },
    };
  });
}

/**
 * An `entrypoint_not_exposed` result is generated only after current
 * source-owned Feature applicability proves every required behavioral owner
 * lacks that entrypoint. A public TUI source can therefore never be hidden by
 * a caller-provided N/A string.
 */
function sourceOwnedEntrypointNotExposedV3(
  matrix: {
    features: ReadonlyArray<{
      id: string;
      sourceSurfaceId: string;
      applicability: { entrypoints: readonly string[] };
    }>;
  },
  bindings: readonly { sourceSurfaceId: string; featureId: string }[],
  entrypoint: 'cli' | 'tui',
): SentinelJourneyApplicabilityInputEntryV2 {
  if (bindings.length === 0) {
    throw new Error('source_owned_sentinel_v3_entrypoint_binding_missing');
  }
  for (const binding of bindings) {
    const feature = matrix.features.find(
      (candidate) =>
        candidate.id === binding.featureId && candidate.sourceSurfaceId === binding.sourceSurfaceId,
    );
    if (!feature) {
      throw new Error('source_owned_sentinel_v3_entrypoint_feature_missing');
    }
    if (feature.applicability.entrypoints.includes(entrypoint)) {
      throw new Error('source_owned_sentinel_v3_entrypoint_is_public:' + entrypoint);
    }
  }
  return fullJourneyEntrypointNotExposedV2();
}

/**
 * A persisted V2 map is valid only if it exactly equals a fresh source-owned
 * reconstruction from the same candidate-bound verifier inputs.
 */
export async function verifySourceOwnedSentinelJourneyMapV2(
  persisted: unknown,
  input: unknown,
  now = new Date(),
): Promise<SentinelJourneyMapV2> {
  const expected = await buildSourceOwnedSentinelJourneyMapV2(input, now);
  const parsed = sentinelJourneyMapV2Schema.safeParse(persisted);
  if (
    !parsed.success ||
    !sameBytes(canonicalJsonBytes(parsed.data), canonicalJsonBytes(expected))
  ) {
    throw new Error('source_owned_sentinel_v2_reconstruction_drift');
  }
  return expected;
}

/**
 * This materializer is intentionally private to the source-owned constructor.
 * Its snapshot is freshly assembled only after the three specialized evidence
 * verifiers have reconstructed the Matrix and source bindings.  The generic
 * V2 module exposes schemas and digests, never a raw-snapshot materializer.
 */
function materializeSourceOwnedSentinelJourneyMapV2(
  snapshot: SentinelJourneyTrustedSnapshotV2,
): SentinelJourneyMapV2 {
  const rowsByJourneyId = new Map<SentinelJourneyIdV2, SentinelJourneyTrustedRowInputV2>();
  for (const row of snapshot.rows) {
    if (rowsByJourneyId.has(row.journeyId)) {
      throw new Error('source_owned_sentinel_v2_trusted_reconstruction_invalid');
    }
    rowsByJourneyId.set(row.journeyId, row);
  }

  const rows = SENTINEL_JOURNEY_IDS_V2.map((journeyId) => {
    const input = rowsByJourneyId.get(journeyId);
    const sourceBindings = canonicalSourceBindings(input?.sourceBindings ?? []);
    const behavioralReceipts = canonicalBehavioralReceipts(input?.behavioralReceipts ?? []);
    const entrypointProjectionReceipts = {
      cli: canonicalProjectionReceipts(input?.entrypointProjectionReceipts?.cli ?? []),
      tui: canonicalProjectionReceipts(input?.entrypointProjectionReceipts?.tui ?? []),
    };
    const applicability = materializeApplicabilityV2(input?.applicability);
    const draft = {
      journeyId,
      sourceBindings,
      featureIds: canonicalIds(
        [
          ...sourceBindings,
          ...entrypointProjectionReceipts.cli.map(
            (projection) => projection.projectionSourceBinding,
          ),
          ...entrypointProjectionReceipts.tui.map(
            (projection) => projection.projectionSourceBinding,
          ),
        ].map((binding) => binding.featureId),
      ),
      assertionIds: canonicalIds(
        [
          ...sourceBindings,
          ...entrypointProjectionReceipts.cli.map(
            (projection) => projection.projectionSourceBinding,
          ),
          ...entrypointProjectionReceipts.tui.map(
            (projection) => projection.projectionSourceBinding,
          ),
        ].map((binding) => binding.assertionId),
      ),
      behavioralReceipts,
      behavioralReceiptIds: canonicalIds(behavioralReceipts.map((receipt) => receipt.receiptId)),
      entrypointProjectionReceipts,
      applicability,
      state: 'blocked' as const,
      blockedReasons: [] as SentinelJourneyBlockedReasonV2[],
    };
    const blockedReasons = blockedReasonsForRowV2(draft);
    return sentinelJourneyMapRowV2Schema.parse({
      ...draft,
      state: rowStateV2(applicability, blockedReasons),
      blockedReasons,
    });
  });

  const material: SentinelJourneyMapMaterialV2 = {
    schema: 'SentinelJourneyMapV2',
    version: 2,
    authority: 'diagnostic',
    evidenceEligible: false,
    matrixDigest: snapshot.matrixDigest,
    rows,
    coverage: {
      fixedRowCount: SENTINEL_JOURNEY_IDS_V2.length,
      observedJourneyIds: rows
        .filter((row) => row.state === 'observed')
        .map((row) => row.journeyId),
    },
  };
  return sentinelJourneyMapV2Schema.parse({
    ...material,
    mapDigest: computeSentinelJourneyMapDigestV2(material),
  });
}

function blockedReasonsForRowV2(row: SentinelJourneyMapRowV2): SentinelJourneyBlockedReasonV2[] {
  const reasons = new Set<SentinelJourneyBlockedReasonV2>();
  const applicability = [row.applicability.journey, row.applicability.cli, row.applicability.tui];
  if (applicability.some((entry) => entry.state === 'blocked')) {
    reasons.add(
      applicability.some((entry) => entry.requiredWhen && entry.notApplicableRationale)
        ? 'applicability_conflict'
        : 'applicability_missing',
    );
  }
  if (
    row.applicability.journey.state === 'not_applicable' &&
    (row.applicability.cli.state === 'required' || row.applicability.tui.state === 'required')
  ) {
    reasons.add('applicability_conflict');
  }

  if (row.sourceBindings.length === 0) {
    reasons.add('source_binding_missing');
    return canonicalBlockedReasonsV2(reasons);
  }
  if (
    hasDuplicateKeys(row.sourceBindings.map(sourceBindingKeyV2)) ||
    hasDuplicateKeys(row.behavioralReceipts.map((receipt) => receipt.receiptId))
  ) {
    reasons.add('link_identity_mismatch');
  }

  if (row.applicability.journey.state === 'required') {
    validateBehavioralReceiptsV2(row, reasons);
  } else if (
    row.behavioralReceipts.some(
      (receipt) => !row.sourceBindings.some((binding) => sameSourceBindingV2(binding, receipt)),
    )
  ) {
    reasons.add('link_identity_mismatch');
  }
  if (row.applicability.cli.state === 'required') {
    validateProjectionReceiptsV2('cli', row, reasons);
  }
  if (row.applicability.tui.state === 'required') {
    validateProjectionReceiptsV2('tui', row, reasons);
  }
  return canonicalBlockedReasonsV2(reasons);
}

function validateBehavioralReceiptsV2(
  row: SentinelJourneyMapRowV2,
  reasons: Set<SentinelJourneyBlockedReasonV2>,
): void {
  if (row.behavioralReceipts.length === 0) {
    reasons.add('behavioral_receipt_missing');
    return;
  }
  for (const binding of row.sourceBindings) {
    const matches = row.behavioralReceipts.filter((receipt) =>
      sameSourceBindingV2(binding, receipt),
    );
    if (matches.length === 0) {
      reasons.add('behavioral_receipt_missing');
      continue;
    }
    if (matches.some((receipt) => receipt.observation !== 'observed')) {
      reasons.add('behavioral_receipt_unobserved');
    }
  }
  if (
    row.behavioralReceipts.some(
      (receipt) => !row.sourceBindings.some((binding) => sameSourceBindingV2(binding, receipt)),
    )
  ) {
    reasons.add('link_identity_mismatch');
  }
}

function validateProjectionReceiptsV2(
  entrypoint: 'cli' | 'tui',
  row: SentinelJourneyMapRowV2,
  reasons: Set<SentinelJourneyBlockedReasonV2>,
): void {
  const projections = row.entrypointProjectionReceipts[entrypoint];
  if (projections.length === 0) {
    reasons.add(projectionMissingReasonV2(entrypoint));
    return;
  }
  if (hasDuplicateKeys(projections.map(projectionReceiptKeyV2))) {
    reasons.add('link_identity_mismatch');
  }
  for (const receipt of row.behavioralReceipts) {
    const matches = projections.filter((projection) =>
      sameBehavioralReceiptV2(receipt, projection),
    );
    if (matches.length !== 1) {
      reasons.add(projectionMissingReasonV2(entrypoint));
      if (matches.length > 1) reasons.add('link_identity_mismatch');
      continue;
    }
    const projection = matches[0];
    if (!projection) continue;
    if (projection.entrypoint !== entrypoint) {
      reasons.add('link_identity_mismatch');
    }
    if (projection.observation !== 'observed') {
      reasons.add(projectionUnobservedReasonV2(entrypoint));
    }
    if (!isIndependentProjectionV2(receipt, projection)) {
      reasons.add('projection_not_independent');
    }
  }
  if (
    projections.some(
      (projection) =>
        !row.behavioralReceipts.some((receipt) => sameBehavioralReceiptV2(receipt, projection)),
    )
  ) {
    reasons.add('link_identity_mismatch');
  }
}

function materializeApplicabilityV2(
  input: SentinelJourneyApplicabilityInputV2 | undefined,
): SentinelJourneyApplicabilityV2 {
  return sentinelJourneyApplicabilityV2Schema.parse({
    journey: materializeApplicabilityEntryV2(input?.journey),
    cli: materializeApplicabilityEntryV2(input?.cli),
    tui: materializeApplicabilityEntryV2(input?.tui),
  });
}

function materializeApplicabilityEntryV2(
  input: SentinelJourneyApplicabilityInputEntryV2 | undefined,
): SentinelJourneyApplicabilityEntryV2 {
  const requiredWhen = input?.requiredWhen ?? null;
  const notApplicableRationale = input?.notApplicableRationale ?? null;
  const state = applicabilityStateV2(requiredWhen, notApplicableRationale);
  return {
    requiredWhen,
    notApplicableRationale,
    state,
  };
}

function applicabilityStateV2(
  requiredWhen: SentinelJourneyRequiredWhenV2 | null,
  notApplicableRationale: SentinelJourneyApplicabilityEntryV2['notApplicableRationale'],
): SentinelJourneyApplicabilityEntryV2['state'] {
  if (requiredWhen && !notApplicableRationale) return 'required';
  if (!requiredWhen && notApplicableRationale) return 'not_applicable';
  return 'blocked';
}

function rowStateV2(
  applicability: SentinelJourneyApplicabilityV2,
  blockedReasons: readonly SentinelJourneyBlockedReasonV2[],
): SentinelJourneyMapRowV2['state'] {
  if (blockedReasons.length > 0) return 'blocked';
  return applicability.journey.state === 'not_applicable' ? 'not_applicable' : 'observed';
}

function sameSourceBindingV2(
  source: SentinelJourneySourceBindingV2,
  linked: SentinelJourneyBehavioralReceiptLinkV2 | SentinelJourneyProjectionReceiptLinkV2,
): boolean {
  return (
    source.sourceSurfaceId === linked.sourceSurfaceId &&
    source.featureId === linked.featureId &&
    source.assertionId === linked.assertionId &&
    source.sourceBindingDigest === linked.sourceBindingDigest
  );
}

function sameBehavioralReceiptV2(
  receipt: SentinelJourneyBehavioralReceiptLinkV2,
  projection: SentinelJourneyProjectionReceiptLinkV2,
): boolean {
  return (
    sameSourceBindingV2(receipt, projection) &&
    receipt.receiptId === projection.behavioralReceiptId &&
    receipt.receiptDigest === projection.behavioralReceiptDigest &&
    receipt.suiteId === projection.behavioralSuiteId &&
    receipt.suiteDigest === projection.behavioralSuiteDigest
  );
}

function isIndependentProjectionV2(
  receipt: SentinelJourneyBehavioralReceiptLinkV2,
  projection: SentinelJourneyProjectionReceiptLinkV2,
): boolean {
  return (
    projection.projectionAssertionId === projection.projectionSourceBinding.assertionId &&
    !sameSourceBindingPairV2(receipt, projection.projectionSourceBinding) &&
    projection.projectionReceiptId !== receipt.receiptId &&
    projection.suiteId !== receipt.suiteId &&
    projection.suiteDigest !== receipt.suiteDigest
  );
}

function sameSourceBindingPairV2(
  left: SentinelJourneySourceBindingV2,
  right: SentinelJourneySourceBindingV2,
): boolean {
  return (
    left.sourceSurfaceId === right.sourceSurfaceId &&
    left.featureId === right.featureId &&
    left.assertionId === right.assertionId &&
    left.sourceBindingDigest === right.sourceBindingDigest
  );
}

function sourceBindingKeyV2(binding: SentinelJourneySourceBindingV2): string {
  return `${binding.sourceSurfaceId}\u0000${binding.featureId}\u0000${binding.assertionId}\u0000${binding.sourceBindingDigest}`;
}

function behavioralReceiptKeyV2(receipt: SentinelJourneyBehavioralReceiptLinkV2): string {
  return `${sourceBindingKeyV2(receipt)}\u0000${receipt.receiptId}\u0000${receipt.receiptDigest}\u0000${receipt.suiteId}\u0000${receipt.suiteDigest}`;
}

function projectionReceiptKeyV2(receipt: SentinelJourneyProjectionReceiptLinkV2): string {
  return `${receipt.entrypoint}\u0000${sourceBindingKeyV2(receipt)}\u0000${sourceBindingKeyV2(receipt.projectionSourceBinding)}\u0000${receipt.behavioralReceiptId}\u0000${receipt.behavioralReceiptDigest}\u0000${receipt.behavioralSuiteId}\u0000${receipt.behavioralSuiteDigest}\u0000${receipt.projectionAssertionId}\u0000${receipt.projectionReceiptId}\u0000${receipt.projectionReceiptDigest}\u0000${receipt.suiteId}\u0000${receipt.suiteDigest}`;
}

function canonicalSourceBindings(
  bindings: readonly SentinelJourneySourceBindingV2[],
): SentinelJourneySourceBindingV2[] {
  return [...bindings].sort((left, right) =>
    compareCodePoint(sourceBindingKeyV2(left), sourceBindingKeyV2(right)),
  );
}

function canonicalBehavioralReceipts(
  receipts: readonly SentinelJourneyBehavioralReceiptLinkV2[],
): SentinelJourneyBehavioralReceiptLinkV2[] {
  return [...receipts].sort((left, right) =>
    compareCodePoint(behavioralReceiptKeyV2(left), behavioralReceiptKeyV2(right)),
  );
}

function canonicalProjectionReceipts(
  receipts: readonly SentinelJourneyProjectionReceiptLinkV2[],
): SentinelJourneyProjectionReceiptLinkV2[] {
  return [...receipts].sort((left, right) =>
    compareCodePoint(projectionReceiptKeyV2(left), projectionReceiptKeyV2(right)),
  );
}

function canonicalIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodePoint);
}

function canonicalBlockedReasonsV2(
  reasons: ReadonlySet<SentinelJourneyBlockedReasonV2>,
): SentinelJourneyBlockedReasonV2[] {
  return SENTINEL_JOURNEY_BLOCKED_REASONS_V2.filter((reason) => reasons.has(reason));
}

function projectionMissingReasonV2(entrypoint: 'cli' | 'tui'): SentinelJourneyBlockedReasonV2 {
  return entrypoint === 'cli' ? 'cli_projection_missing' : 'tui_projection_missing';
}

function projectionUnobservedReasonV2(entrypoint: 'cli' | 'tui'): SentinelJourneyBlockedReasonV2 {
  return entrypoint === 'cli' ? 'cli_projection_unobserved' : 'tui_projection_unobserved';
}

function hasDuplicateKeys(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toSourceBindingV2(binding: {
  sourceSurfaceId: string;
  featureId: string;
  binding: { assertionId: string; bindingDigest: string };
}): SentinelJourneySourceBindingV2 {
  return {
    sourceSurfaceId: binding.sourceSurfaceId,
    featureId: binding.featureId,
    assertionId: binding.binding.assertionId,
    sourceBindingDigest: binding.binding.bindingDigest,
  };
}

function toBehavioralReceiptLinkV2(
  source: SentinelJourneySourceBindingV2,
  receipt: {
    receiptId: string;
    receiptDigest: string;
    suiteDigest: string;
  },
  suiteId: string,
  observed: boolean,
): SentinelJourneyBehavioralReceiptLinkV2 {
  return {
    ...source,
    receiptId: receipt.receiptId,
    receiptDigest: receipt.receiptDigest,
    suiteId,
    suiteDigest: receipt.suiteDigest,
    observation: observed ? 'observed' : 'unobserved',
  };
}

function toProjectionReceiptLinkV2(
  entrypoint: 'cli' | 'tui',
  behavioral: SentinelJourneyBehavioralReceiptLinkV2,
  projectionSourceBinding: SentinelJourneySourceBindingV2,
  receipt: {
    receiptId: string;
    receiptDigest: string;
    suiteId: string;
    suiteDigest: string;
  },
  observed: boolean,
): SentinelJourneyProjectionReceiptLinkV2 {
  return {
    sourceSurfaceId: behavioral.sourceSurfaceId,
    featureId: behavioral.featureId,
    assertionId: behavioral.assertionId,
    sourceBindingDigest: behavioral.sourceBindingDigest,
    entrypoint,
    behavioralReceiptId: behavioral.receiptId,
    behavioralReceiptDigest: behavioral.receiptDigest,
    behavioralSuiteId: behavioral.suiteId,
    behavioralSuiteDigest: behavioral.suiteDigest,
    projectionSourceBinding,
    projectionAssertionId: projectionSourceBinding.assertionId,
    projectionReceiptId: receipt.receiptId,
    projectionReceiptDigest: receipt.receiptDigest,
    suiteId: receipt.suiteId,
    suiteDigest: receipt.suiteDigest,
    observation: observed ? 'observed' : 'unobserved',
  };
}

function requiredWhenFor(
  matrix: {
    features: ReadonlyArray<{
      id: string;
      requiredEvidence: ReadonlyArray<{
        layer: string;
        suiteIds: string[];
        assertionIds: string[];
        requiredWhen: { conditionId: string; conditionDigest: string };
      }>;
    }>;
  },
  featureId: string,
  assertionId: string,
  suiteId: string,
) {
  const feature = matrix.features.find((candidate) => candidate.id === featureId);
  const requirement = feature?.requiredEvidence.find(
    (candidate) =>
      candidate.layer === 'scripted_runtime' &&
      candidate.suiteIds.length === 1 &&
      candidate.suiteIds[0] === suiteId &&
      candidate.assertionIds.length === 1 &&
      candidate.assertionIds[0] === assertionId,
  );
  if (!requirement) throw new Error('source_owned_sentinel_v2_matrix_requirement_missing');
  return { requiredWhen: requirement.requiredWhen };
}

/**
 * A multi-binding journey can be observed only when all of its exact
 * source-owned requirements share one condition. Sentinel V2 has one journey
 * applicability slot, so silently choosing one binding's condition would
 * weaken the closure rather than represent it faithfully.
 */
function sharedRequiredWhenFor(
  matrix: Parameters<typeof requiredWhenFor>[0],
  bindings: readonly { featureId: string; binding: { assertionId: string } }[],
  suiteId: string,
): { requiredWhen: { conditionId: string; conditionDigest: string } } {
  if (bindings.length === 0) {
    throw new Error('source_owned_sentinel_v2_shared_requirement_missing');
  }
  const requirements = bindings.map((binding) =>
    requiredWhenFor(matrix, binding.featureId, binding.binding.assertionId, suiteId),
  );
  const first = requirements[0]!;
  if (
    !requirements.every(
      (requirement) =>
        requirement.requiredWhen.conditionId === first.requiredWhen.conditionId &&
        requirement.requiredWhen.conditionDigest === first.requiredWhen.conditionDigest,
    )
  ) {
    throw new Error('source_owned_sentinel_v2_shared_requirement_drift');
  }
  return first;
}

function reportQualified(
  report: {
    results: ReadonlyArray<{
      featureId: string;
      assertionId: string;
      status: string;
    }>;
  },
  featureId: string,
  assertionId: string,
): boolean {
  return report.results.some(
    (result) =>
      result.featureId === featureId &&
      result.assertionId === assertionId &&
      result.status === 'qualified',
  );
}

function sameCandidateClosureV2(
  reports: ReadonlyArray<{ candidateClosureDigest?: string }>,
): boolean {
  const first = reports[0]?.candidateClosureDigest;
  return Boolean(first) && reports.every((report) => report.candidateClosureDigest === first);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
