import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  evaluateGaAssemblyV1,
  GA_ASSEMBLY_DEPENDENCIES_V1,
} from '../../scripts/release/assemble-ga';
import { verifyGaCompatibilityFixtureV1 } from '../../scripts/release/ga-compatibility';
import { validateGaSelectionV1 } from '../../scripts/release/ga-selection';
import { verifyReleaseSchemaRollbackFixtureV1 } from '../../scripts/release/schema-rollback';

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;
const candidate = {
  candidateId: 'ga-candidate-001',
  artifactDigest: digest('1'),
  profileDigest: digest('2'),
  routeDigest: digest('3'),
  cohortDigest: digest('4'),
} as const;
const stableDecision = {
  capability: 'verification',
  stableMilestone: 'MS:5A-STABLE',
  decisionDigest: digest('5'),
  status: 'stable',
  fresh: true,
} as const;
const selection = {
  version: 1,
  selectionId: 'ga-selection-001',
  selectedCapabilities: [
    {
      capability: 'verification',
      stableMilestone: 'MS:5A-STABLE',
      decisionDigest: stableDecision.decisionDigest,
    },
  ],
  forcedOffCapabilities: [
    'auto_compaction',
    'builtin_read_tools',
    'builtin_write_tools',
    'content_session_logging',
    'full_interaction_mode',
    'manual_compaction',
    'mcp_read',
    'mcp_write',
    'plan',
    'remote_telemetry',
    'shell',
    'skills_effectful',
    'skills_readonly',
    'tool_search',
  ],
  approvedBy: ['github:release-owner'],
} as const;
const selectionDigest = validateGaSelectionV1(selection, [stableDecision]).selectionDigest;
const facts = [
  {
    kind: 'verification',
    factId: 'required-check',
    digest: digest('6'),
    status: 'required',
    externalEffect: false,
    replayed: false,
  },
] as const;
const rollbackReport = verifyReleaseSchemaRollbackFixtureV1({
  schema: 'ReleaseSchemaRollbackFixtureV1',
  fixtureClass: 'synthetic_contract_only',
  sourceSchemaVersion: 21,
  candidateSchemaVersion: 22,
  rollbackSchemaVersion: 21,
  sourceArtifactDigest: digest('7'),
  candidateArtifactDigest: candidate.artifactDigest,
  rollbackArtifactDigest: digest('7'),
  before: facts,
  afterUpgrade: facts,
  afterRollback: facts,
  backupCreated: true,
  irreversibleMigrationCount: 0,
});
const compatibilityFacts = [
  {
    ...facts[0],
    kind: 'verification',
  },
] as const;
const compatibilityReport = verifyGaCompatibilityFixtureV1({
  schema: 'GACompatibilityFixtureV1',
  fixtureClass: 'synthetic_contract_only',
  fromArtifactDigest: digest('7'),
  gaArtifactDigest: candidate.artifactDigest,
  rollbackArtifactDigest: digest('7'),
  fromRuntimeSchema: 21,
  gaRuntimeSchema: 22,
  rollbackRuntimeSchema: 21,
  beforeFacts: compatibilityFacts,
  afterUpgradeFacts: compatibilityFacts,
  afterRollbackFacts: compatibilityFacts,
  disabledCapabilities: selection.forcedOffCapabilities,
  newAdmissionsForDisabledCapabilities: 0,
});

const dependencies = GA_ASSEMBLY_DEPENDENCIES_V1.map((dependency, index) => ({
  schema: 'GAAssemblyDependencyDecisionV1' as const,
  dependency,
  status: 'passed' as const,
  ...candidate,
  selectionDigest,
  verifierIdentity: `fixture:${dependency}`,
  verifiedAt: '2026-08-03T00:00:00.000Z',
  decisionDigest: digest(String.fromCharCode(97 + index)),
}));
const rollbackReplay = {
  schema: 'GAAssemblyRollbackReplayV1' as const,
  candidate,
  selectionDigest,
  report: rollbackReport,
};
const compatibilityReplay = {
  schema: 'GAAssemblyCompatibilityReplayV1' as const,
  candidate,
  selectionDigest,
  report: compatibilityReport,
};
const thirdPartyReview = {
  schema: 'GAAssemblyThirdPartyReviewV1' as const,
  status: 'passed' as const,
  independent: true,
  candidate,
  selectionDigest,
  rollbackReportDigest: rollbackReport.reportDigest,
  compatibilityReportDigest: compatibilityReport.reportDigest,
  scope: [
    'candidate',
    'artifact',
    'profile',
    'route',
    'cohort',
    'selection',
    'rollback',
    'compatibility',
  ] as const,
  releaseOwnerIdentity: 'github:release-owner',
  reviewerIdentity: 'github:independent-security-reviewer',
  reviewedAt: '2026-08-03T01:00:00.000Z',
  decisionDigest: digest('f'),
};
const input = {
  schema: 'GAAssemblyInputV1' as const,
  assemblyId: 'ga-assembly-001',
  candidate,
  selection,
  stableCapabilityDecisions: [stableDecision],
  dependencies,
  thirdPartyReview,
  rollbackReplay,
  compatibilityReplay,
};

describe('GA pure assembly and replay contract', () => {
  test('binds the complete local contract but remains non-distributable without authority', () => {
    expect(evaluateGaAssemblyV1(input)).toMatchObject({
      status: 'blocked',
      gaEligible: false,
      distributable: false,
      bundleWritten: false,
      published: false,
      milestone: null,
      candidate,
      selectionDigest,
      dependencyDecisionDigests: dependencies.map((entry) => entry.decisionDigest).sort(),
      thirdPartyReviewDecisionDigest: thirdPartyReview.decisionDigest,
      rollbackReportDigest: rollbackReport.reportDigest,
      compatibilityReportDigest: compatibilityReport.reportDigest,
      reasonCodes: [
        'authenticated_ga_assembly_authority_not_configured',
        'compatibility_production_evidence_missing',
        'rollback_production_evidence_missing',
      ],
    });
  });

  test('keeps missing dependencies, review, and replay evidence explicitly blocked', () => {
    const result = evaluateGaAssemblyV1({
      ...input,
      dependencies: [],
      thirdPartyReview: null,
      rollbackReplay: null,
      compatibilityReplay: null,
    });
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        'dependency_missing:candidate_decision',
        'dependency_missing:artifact_decision',
        'dependency_missing:profile_decision',
        'dependency_missing:route_decision',
        'dependency_missing:cohort_decision',
        'third_party_security_review_missing',
        'rollback_replay_missing',
        'compatibility_replay_missing',
      ]),
    );
    expect(result).toMatchObject({ distributable: false, milestone: null });
  });

  test('detects identity, selection, independent-review, and replay cross-splicing', () => {
    const result = evaluateGaAssemblyV1({
      ...input,
      dependencies: dependencies.map((entry) =>
        entry.dependency === 'route_decision'
          ? { ...entry, routeDigest: digest('9'), selectionDigest: digest('8') }
          : entry,
      ),
      rollbackReplay: {
        ...rollbackReplay,
        candidate: { ...candidate, artifactDigest: digest('9') },
        selectionDigest: digest('8'),
      },
      compatibilityReplay: {
        ...compatibilityReplay,
        candidate: { ...candidate, cohortDigest: digest('9') },
      },
      thirdPartyReview: {
        ...thirdPartyReview,
        independent: false,
        reviewerIdentity: thirdPartyReview.releaseOwnerIdentity,
        selectionDigest: digest('8'),
        rollbackReportDigest: digest('9'),
        compatibilityReportDigest: digest('9'),
      },
    });
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining([
        'dependency_candidate_identity_mismatch:route_decision',
        'dependency_selection_mismatch:route_decision',
        'rollback_replay_candidate_identity_mismatch',
        'rollback_replay_selection_mismatch',
        'compatibility_replay_candidate_identity_mismatch',
        'third_party_security_review_not_independent',
        'third_party_security_review_selection_mismatch',
        'third_party_security_review_rollback_mismatch',
        'third_party_security_review_compatibility_mismatch',
      ]),
    );
  });

  test('rejects duplicate decisions, hidden fields, and unvalidated stable selection', () => {
    expect(() =>
      evaluateGaAssemblyV1({
        ...input,
        dependencies: [dependencies[0], dependencies[0]],
      }),
    ).toThrow('duplicated');
    expect(() => evaluateGaAssemblyV1({ ...input, hiddenPublish: true })).toThrow();
    expect(() => evaluateGaAssemblyV1({ ...input, stableCapabilityDecisions: [] })).toThrow(
      'fresh stable decision',
    );
  });

  test('has no filesystem, process, network, or publish implementation path', () => {
    const source = readFileSync('scripts/release/assemble-ga.ts', 'utf8');
    expect(source).not.toContain("from 'node:fs'");
    expect(source).not.toContain("from 'node:child_process'");
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('writeFile');
  });
});
