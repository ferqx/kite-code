import { describe, expect, test } from 'bun:test';
import {
  buildSourceOwnedSentinelJourneyMapV2,
  verifySourceOwnedSentinelJourneyMapV2,
} from '../../../release/qualification/source-owned-sentinel-journey-map-v2';
import {
  buildAgentQualificationEvidenceV1,
  buildDiagnosticCandidateArtifactClosureV1,
  buildDiagnosticExecutionV1,
  buildQualificationAttemptV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import {
  reconstructSourceOwnedL1PublicProjectionV1,
  reconstructSourceOwnedL1SkillMcpV1,
  reconstructSourceOwnedL1SubagentRecoveryV1,
  reconstructSourceOwnedL1ToolVerificationV1,
  reconstructSourceOwnedL1TuiRewindForkProjectionV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-verifier-v1';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
  EVIDENCE_GOVERNANCE_PROFILE_V1,
} from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';

const CREATED_AT = '2026-08-05T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}` as `sha256:${string}`;
}

function candidate(commit = COMMIT) {
  return buildDiagnosticCandidateArtifactClosureV1({
    schema: 'DiagnosticCandidateArtifactClosureV1',
    version: 1,
    artifacts: [
      {
        platformIdentity: 'linux-x64',
        artifact: {
          canonicalRepository: 'ferqx/kite-code',
          repositoryId: 'R_kgDOKite',
          commit,
          payloadSha256: digest('a'),
          canonicalManifestDigest: digest('b'),
          behaviorDigest: digest('c'),
          profileDigest: digest('d'),
          gatePolicyDigest: digest('e'),
        },
      },
    ],
  });
}

function recordForSource(input: {
  reconstructed: {
    matrix: { matrixDigest: string };
    suite: {
      suiteId: string;
      suiteDigest: string;
      oracleDigest: string;
      corpusDigest: string;
      evaluatorDigest: string;
    };
    evaluator: { verifierDigest: string; runnerDigest: string };
    bindings: readonly {
      sourceSurfaceId: string;
      featureId: string;
      binding: { assertionId: string };
    }[];
    receipts: readonly {
      sourceSurfaceId: string;
      assertionId: string;
      receiptId: string;
      receiptDigest: string;
    }[];
  };
  schema:
    | 'L1ToolVerificationEvidenceVerificationInputV1'
    | 'L1PublicProjectionEvidenceVerificationInputV1'
    | 'L1SkillMcpEvidenceVerificationInputV1'
    | 'L1SubagentRecoveryEvidenceVerificationInputV1'
    | 'L1TuiRewindForkProjectionEvidenceVerificationInputV1';
  sourceSurfaceId: string;
  entrypoint: 'runtime' | 'cli' | 'tui';
  fixtureId: string;
  runner: string;
  executionId: string;
  diagnosticCandidate: ReturnType<typeof candidate>;
}) {
  const bindings = input.reconstructed.bindings.filter(
    (binding) => binding.sourceSurfaceId === input.sourceSurfaceId,
  );
  const receipts = input.reconstructed.receipts.filter(
    (receipt) => receipt.sourceSurfaceId === input.sourceSurfaceId,
  );
  const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
  const counters = {
    attempts: bindings.length,
    tokens: bindings.length * 10,
    runWallClockSeconds: bindings.length,
    costUsdMicros: bindings.length,
  };
  const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    routePolicyDigest: digest('1'),
    period: 'day',
    periodStart: '2026-08-05',
    reservationId: `${input.executionId}-reservation`,
    status: 'reconciled',
    reserved: counters,
    reconciled: counters,
  });
  const monthQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    routePolicyDigest: digest('1'),
    period: 'month',
    periodStart: '2026-08-01',
    reservationId: `${input.executionId}-reservation`,
    status: 'reconciled',
    reserved: counters,
    reconciled: counters,
  });
  const retention = buildEvidenceRetentionWitnessV1({
    schema: 'EvidenceRetentionWitnessV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    retentionClass: 'ephemeral_local',
    storage: profile.storage,
    deleteTrigger: 'process_exit',
    observedAt: CREATED_AT,
  });
  const candidateCommit = input.diagnosticCandidate.artifacts[0]?.artifact.commit;
  if (!candidateCommit) throw new Error('test_source_owned_sentinel_candidate_missing');
  const governance = {
    retentionClass: 'ephemeral_local' as const,
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    quotaLedgerDigests: { day: dayQuotaLedger.recordDigest, month: monthQuotaLedger.recordDigest },
    storageDeletionWitnessDigest: retention.recordDigest,
  };
  const execution = buildDiagnosticExecutionV1({
    executionId: input.executionId,
    platformIdentity: 'linux-x64',
    identity: {
      source: 'local_synthetic',
      fixtureId: input.fixtureId,
      runner: input.runner,
      commit: candidateCommit,
      startedAt: CREATED_AT,
      endedAt: '2026-08-05T00:00:01.000Z',
    },
  });
  const scope = {
    platformIdentity: 'linux-x64',
    releaseProfileDigest: digest('d'),
    entrypoint: input.entrypoint,
    testPolicyDigest: digest('1'),
    routePolicyDigest: digest('1'),
  };
  const identity = {
    matrixDigest: input.reconstructed.matrix.matrixDigest,
    suiteDigest: input.reconstructed.suite.suiteDigest,
    oracleDigest: input.reconstructed.suite.oracleDigest,
    corpusDigest: input.reconstructed.suite.corpusDigest,
    evaluatorDigest: input.reconstructed.suite.evaluatorDigest,
    verifierDigest: input.reconstructed.evaluator.verifierDigest,
    runnerDigest: input.reconstructed.evaluator.runnerDigest,
  };
  const evidence = buildAgentQualificationEvidenceV1({
    schema: 'AgentQualificationEvidenceV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    createdAt: CREATED_AT,
    candidate: input.diagnosticCandidate,
    governance,
    suite: {
      suiteId: input.reconstructed.suite.suiteId,
      suiteDigest: input.reconstructed.suite.suiteDigest,
      role: 'behavioral',
    },
    executions: [execution],
    attempts: bindings.map((binding, index) => {
      const receipt = receipts.find(
        (candidateReceipt) => candidateReceipt.assertionId === binding.binding.assertionId,
      );
      if (!receipt) throw new Error('test_source_owned_sentinel_receipt_missing');
      return buildQualificationAttemptV1({
        attemptId: `${input.executionId}-attempt-${String(index + 1)}`,
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        status: 'passed',
        executionId: execution.executionId,
        candidateArtifact: input.diagnosticCandidate.artifacts[0]!,
        scope,
        identity,
        receipt: { receiptId: receipt.receiptId, receiptDigest: receipt.receiptDigest },
      });
    }),
  });
  return {
    schema: input.schema,
    version: 1,
    evidence,
    trusted: {
      candidate: input.diagnosticCandidate,
      governance,
      executions: [execution],
      governanceWitnesses: { dayQuotaLedger, monthQuotaLedger, retention },
    },
    sourceSurfaceId: input.sourceSurfaceId,
    scopes: [{ sourceSurfaceId: input.sourceSurfaceId, scope }],
    receipts,
  };
}

async function validInput(
  options: { behavioralFixtureId?: string; behavioralRunner?: string } = {},
) {
  const [behavioral, projection] = await Promise.all([
    reconstructSourceOwnedL1ToolVerificationV1(),
    Promise.resolve(reconstructSourceOwnedL1PublicProjectionV1()),
  ]);
  const diagnosticCandidate = candidate();
  return {
    schema: 'SourceOwnedSentinelJourneyMapV2InputV1' as const,
    version: 1 as const,
    behavioralEvidence: recordForSource({
      reconstructed: behavioral,
      schema: 'L1ToolVerificationEvidenceVerificationInputV1',
      sourceSurfaceId: 'runtime:tool-lifecycle',
      entrypoint: 'runtime',
      fixtureId: options.behavioralFixtureId ?? 'l1-tool-verification-fixture-v1',
      runner: options.behavioralRunner ?? 'qualification-l1-tool-verification-runner-v1',
      executionId: 'sentinel-behavioral-execution',
      diagnosticCandidate,
    }),
    cliProjectionEvidence: recordForSource({
      reconstructed: projection,
      schema: 'L1PublicProjectionEvidenceVerificationInputV1',
      sourceSurfaceId: 'cli:runtime-event-projection',
      entrypoint: 'cli',
      fixtureId: 'l1-public-projection-fixture-v1',
      runner: 'qualification-l1-public-projection-runner-v1',
      executionId: 'sentinel-cli-projection-execution',
      diagnosticCandidate,
    }),
    tuiProjectionEvidence: recordForSource({
      reconstructed: projection,
      schema: 'L1PublicProjectionEvidenceVerificationInputV1',
      sourceSurfaceId: 'tui:runtime-event-projection',
      entrypoint: 'tui',
      fixtureId: 'l1-public-projection-fixture-v1',
      runner: 'qualification-l1-public-projection-runner-v1',
      executionId: 'sentinel-tui-projection-execution',
      diagnosticCandidate,
    }),
  };
}

/**
 * V2 receives six independent, source-surface-specific inputs. Keeping them
 * as separate records exercises the verifier's candidate/scope/receipt closure
 * per owning symbol instead of treating the sealed corpus as one broad pass.
 */
async function validV2Input(options: { skillMcpCandidate?: ReturnType<typeof candidate> } = {}) {
  const [base, skillMcp] = await Promise.all([validInput(), reconstructSourceOwnedL1SkillMcpV1()]);
  const diagnosticCandidate = options.skillMcpCandidate ?? candidate();
  const skillMcpRecord = (sourceSurfaceId: string, executionId: string) =>
    recordForSource({
      reconstructed: skillMcp,
      schema: 'L1SkillMcpEvidenceVerificationInputV1',
      sourceSurfaceId,
      entrypoint: 'runtime',
      fixtureId: 'l1-skill-mcp-fixture-v1',
      runner: 'qualification-l1-skill-mcp-runner-v1',
      executionId,
      diagnosticCandidate,
    });
  return {
    schema: 'SourceOwnedSentinelJourneyMapV2InputV2' as const,
    version: 2 as const,
    behavioralEvidence: base.behavioralEvidence,
    cliProjectionEvidence: base.cliProjectionEvidence,
    tuiProjectionEvidence: base.tuiProjectionEvidence,
    skillMcpEvidence: {
      'runtime:tool-lifecycle': skillMcpRecord(
        'runtime:tool-lifecycle',
        'sentinel-skill-mcp-auth-execution',
      ),
      'mcp:supervisor-control': skillMcpRecord(
        'mcp:supervisor-control',
        'sentinel-skill-mcp-supervisor-execution',
      ),
      'mcp:write-recovery': skillMcpRecord(
        'mcp:write-recovery',
        'sentinel-skill-mcp-write-recovery-execution',
      ),
      'runtime:interaction-action': skillMcpRecord(
        'runtime:interaction-action',
        'sentinel-skill-mcp-runtime-action-execution',
      ),
      'skill:open-world-contract': skillMcpRecord(
        'skill:open-world-contract',
        'sentinel-skill-mcp-skill-lifecycle-execution',
      ),
      'skill:workflow-contract': skillMcpRecord(
        'skill:workflow-contract',
        'sentinel-skill-mcp-skill-workflow-execution',
      ),
    },
  };
}

/**
 * V3 adds one independently candidate-bound record per durable AQ-6 cut
 * point plus a different source-owned public TUI `/rewind` projection receipt.
 * The projection is never substituted with the internal RuntimeStore fork
 * receipt that supplies J10's behavioral side.
 */
async function validV3Input(options: { tuiRewindCandidate?: ReturnType<typeof candidate> } = {}) {
  const [base, subagentRecovery, tuiRewindProjection] = await Promise.all([
    validV2Input(),
    reconstructSourceOwnedL1SubagentRecoveryV1(),
    reconstructSourceOwnedL1TuiRewindForkProjectionV1(),
  ]);
  const diagnosticCandidate = options.tuiRewindCandidate ?? candidate();
  const recoveryRecord = (sourceSurfaceId: string, executionId: string) =>
    recordForSource({
      reconstructed: subagentRecovery,
      schema: 'L1SubagentRecoveryEvidenceVerificationInputV1',
      sourceSurfaceId,
      entrypoint: 'runtime',
      fixtureId: 'l1-subagent-recovery-fixture-v1',
      runner: 'qualification-l1-subagent-recovery-runner-v1',
      executionId,
      diagnosticCandidate,
    });
  return {
    schema: 'SourceOwnedSentinelJourneyMapV2InputV3' as const,
    version: 3 as const,
    behavioralEvidence: base.behavioralEvidence,
    cliProjectionEvidence: base.cliProjectionEvidence,
    tuiProjectionEvidence: base.tuiProjectionEvidence,
    skillMcpEvidence: base.skillMcpEvidence,
    subagentRecoveryEvidence: {
      'subagent:open-world-contract': recoveryRecord(
        'subagent:open-world-contract',
        'sentinel-subagent-parent-child-execution',
      ),
      'subagent:tool-controller': recoveryRecord(
        'subagent:tool-controller',
        'sentinel-subagent-claim-execution',
      ),
      'runtime:reducer-terminality': recoveryRecord(
        'runtime:reducer-terminality',
        'sentinel-subagent-terminal-execution',
      ),
      'runtime:kernel-recovery': recoveryRecord(
        'runtime:kernel-recovery',
        'sentinel-subagent-restart-execution',
      ),
      'runtime:late-event-terminality': recoveryRecord(
        'runtime:late-event-terminality',
        'sentinel-subagent-late-terminal-execution',
      ),
      'runtime:cancellation-boundary': recoveryRecord(
        'runtime:cancellation-boundary',
        'sentinel-subagent-cancel-execution',
      ),
      'runtime:session-fork': recoveryRecord(
        'runtime:session-fork',
        'sentinel-subagent-rewind-behavioral-execution',
      ),
    },
    tuiRewindProjectionEvidence: recordForSource({
      reconstructed: tuiRewindProjection,
      schema: 'L1TuiRewindForkProjectionEvidenceVerificationInputV1',
      sourceSurfaceId: 'tui:rewind-control',
      entrypoint: 'tui',
      fixtureId: 'l1-tui-rewind-fork-projection-fixture-v1',
      runner: 'qualification-l1-tui-rewind-fork-projection-runner-v1',
      executionId: 'sentinel-tui-rewind-projection-execution',
      diagnosticCandidate,
    }),
  };
}

describe('source-owned SentinelJourneyMapV2', () => {
  test('preserves V1 input semantics: only J1/J2 are observed and AQ-5 journeys remain blocked', async () => {
    const input = await validInput();
    const map = await buildSourceOwnedSentinelJourneyMapV2(
      input,
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(map.authority).toBe('diagnostic');
    expect(map.evidenceEligible).toBe(false);
    expect(map.coverage.observedJourneyIds).toEqual([
      'sentinel-tool-approval-execution-verification',
      'sentinel-tool-invalid-arguments-correction',
    ]);
    for (const row of map.rows.slice(0, 2)) {
      expect(row.state).toBe('observed');
      expect(row.entrypointProjectionReceipts.cli[0]?.projectionSourceBinding.sourceSurfaceId).toBe(
        'cli:runtime-event-projection',
      );
      expect(row.entrypointProjectionReceipts.tui[0]?.projectionSourceBinding.sourceSurfaceId).toBe(
        'tui:runtime-event-projection',
      );
    }
    expect(map.rows.slice(2, 6).every((row) => row.state === 'blocked')).toBe(true);
    await expect(
      verifySourceOwnedSentinelJourneyMapV2(map, input, new Date('2026-08-05T01:00:00.000Z')),
    ).resolves.toEqual(map);
  }, 60_000);

  test('V2 binds J3--J6 to all six specialized Skill/MCP receipts without fabricating a public projection', async () => {
    const input = await validV2Input();
    const map = await buildSourceOwnedSentinelJourneyMapV2(
      input,
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(map.coverage.observedJourneyIds).toEqual([
      'sentinel-tool-approval-execution-verification',
      'sentinel-tool-invalid-arguments-correction',
      'sentinel-skill-discovery-activation-dependency-output-validation',
      'sentinel-skill-mcp-revision-drift',
      'sentinel-mcp-config-approval-connect-oauth-discovery-call',
      'sentinel-mcp-auth-expired-login-new-turn',
    ]);
    const journey = (journeyId: string) => map.rows.find((row) => row.journeyId === journeyId)!;
    expect(
      journey(
        'sentinel-skill-discovery-activation-dependency-output-validation',
      ).sourceBindings.map((binding) => [binding.sourceSurfaceId, binding.assertionId]),
    ).toEqual([['skill:open-world-contract', 'l1.skill.discovery-activation-output.v1']]);
    expect(
      journey('sentinel-skill-mcp-revision-drift').sourceBindings.map((binding) => [
        binding.sourceSurfaceId,
        binding.assertionId,
      ]),
    ).toEqual([['skill:workflow-contract', 'l1.skill.mcp-dependency-revision-drift.v1']]);
    expect(
      journey('sentinel-mcp-config-approval-connect-oauth-discovery-call').sourceBindings.map(
        (binding) => [binding.sourceSurfaceId, binding.assertionId],
      ),
    ).toEqual([
      ['mcp:supervisor-control', 'l1.mcp.project-approval-catalog-churn.v1'],
      ['mcp:write-recovery', 'l1.mcp.unknown-write-reconciliation.v1'],
    ]);
    const authJourney = journey('sentinel-mcp-auth-expired-login-new-turn');
    expect(
      authJourney.sourceBindings.map((binding) => [binding.sourceSurfaceId, binding.assertionId]),
    ).toEqual([
      ['runtime:interaction-action', 'l1.runtime.provider-action-new-turn.v1'],
      ['runtime:tool-lifecycle', 'l1.mcp.auth-invalid-provider-action.v1'],
    ]);
    for (const row of map.rows.slice(2, 6)) {
      expect(row.state).toBe('observed');
      expect(row.applicability.cli).toMatchObject({
        state: 'not_applicable',
        notApplicableRationale: 'entrypoint_not_exposed',
      });
      expect(row.applicability.tui).toMatchObject({
        state: 'not_applicable',
        notApplicableRationale: 'entrypoint_not_exposed',
      });
      expect(row.entrypointProjectionReceipts).toEqual({ cli: [], tui: [] });
    }
    // A provider.action_required TUI receipt exists independently, but it
    // cannot stand in for login completion plus a fresh user turn.
    expect(authJourney.assertionIds).not.toContain('l1.projection.tui.provider-action.v1');

    const candidateDriftInput = await validV2Input({
      skillMcpCandidate: candidate('b'.repeat(40)),
    });
    const candidateDrift = await buildSourceOwnedSentinelJourneyMapV2(
      candidateDriftInput,
      new Date('2026-08-05T01:00:00.000Z'),
    );
    // A fully valid per-surface Skill/MCP record still cannot be joined to a
    // Tool/projection candidate closure from a different commit.
    expect(candidateDrift.rows.slice(0, 6).every((row) => row.state === 'blocked')).toBe(true);
    expect(candidateDrift.coverage.observedJourneyIds).toEqual([]);
  }, 180_000);

  test('V3 binds AQ-6 cut points and an independent real TUI /rewind projection without widening J1--J6', async () => {
    const input = await validV3Input();
    const map = await buildSourceOwnedSentinelJourneyMapV2(
      input,
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(map.coverage.observedJourneyIds).toEqual([
      'sentinel-tool-approval-execution-verification',
      'sentinel-tool-invalid-arguments-correction',
      'sentinel-skill-discovery-activation-dependency-output-validation',
      'sentinel-skill-mcp-revision-drift',
      'sentinel-mcp-config-approval-connect-oauth-discovery-call',
      'sentinel-mcp-auth-expired-login-new-turn',
      'sentinel-subagent-approval-restart-continuation',
      'sentinel-effect-unknown-restart-reconciliation',
      'sentinel-parallel-tool-subagent-cancel-convergence',
      'sentinel-elevated-session-rewind-fork-tightening',
    ]);
    const journey = (journeyId: string) => map.rows.find((row) => row.journeyId === journeyId)!;
    for (const journeyId of [
      'sentinel-subagent-approval-restart-continuation',
      'sentinel-effect-unknown-restart-reconciliation',
      'sentinel-parallel-tool-subagent-cancel-convergence',
    ]) {
      const row = journey(journeyId);
      expect(row.state).toBe('observed');
      expect(row.entrypointProjectionReceipts).toEqual({ cli: [], tui: [] });
      expect(row.applicability.cli).toMatchObject({
        state: 'not_applicable',
        notApplicableRationale: 'entrypoint_not_exposed',
      });
      expect(row.applicability.tui).toMatchObject({
        state: 'not_applicable',
        notApplicableRationale: 'entrypoint_not_exposed',
      });
    }
    const rewind = journey('sentinel-elevated-session-rewind-fork-tightening');
    expect(rewind.state).toBe('observed');
    expect(rewind.applicability.cli).toMatchObject({
      state: 'not_applicable',
      notApplicableRationale: 'entrypoint_not_exposed',
    });
    expect(rewind.applicability.tui.state).toBe('required');
    expect(rewind.entrypointProjectionReceipts.tui).toEqual([
      expect.objectContaining({
        entrypoint: 'tui',
        projectionSourceBinding: expect.objectContaining({
          sourceSurfaceId: 'tui:rewind-control',
          assertionId: 'l1.projection.tui.rewind-fork-tightening.v1',
        }),
        suiteId: 'qualification-l1-tui-rewind-fork-projection-v1',
        observation: 'observed',
      }),
    ]);
    expect(rewind.entrypointProjectionReceipts.tui[0]?.behavioralSuiteId).toBe(
      'qualification-l1-subagent-recovery-v1',
    );
    expect(rewind.entrypointProjectionReceipts.tui[0]?.suiteId).not.toBe(
      rewind.entrypointProjectionReceipts.tui[0]?.behavioralSuiteId,
    );

    const candidateDrift = await buildSourceOwnedSentinelJourneyMapV2(
      await validV3Input({ tuiRewindCandidate: candidate('f'.repeat(40)) }),
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(candidateDrift.rows.every((row) => row.state === 'blocked')).toBe(true);
    expect(candidateDrift.coverage.observedJourneyIds).toEqual([]);
  }, 240_000);

  test('rejects an observed persisted map when its verifier inputs are fabricated or candidate bindings drift', async () => {
    const input = await validInput();
    const observed = await buildSourceOwnedSentinelJourneyMapV2(
      input,
      new Date('2026-08-05T01:00:00.000Z'),
    );
    await expect(
      verifySourceOwnedSentinelJourneyMapV2(
        observed,
        {
          ...input,
          behavioralEvidence: { fabricated: true },
        },
        new Date('2026-08-05T01:00:00.000Z'),
      ),
    ).rejects.toThrow('source_owned_sentinel_v2_reconstruction_drift');

    const drifted = {
      ...input,
      cliProjectionEvidence: {
        ...input.cliProjectionEvidence,
        trusted: {
          ...input.cliProjectionEvidence.trusted,
          candidate: candidate('b'.repeat(40)),
        },
      },
    };
    const blocked = await buildSourceOwnedSentinelJourneyMapV2(
      drifted,
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(blocked.rows.slice(0, 2).every((row) => row.state === 'blocked')).toBe(true);

    const swappedBehavioralExecution = await validInput({
      behavioralFixtureId: 'l1-public-projection-fixture-v1',
      behavioralRunner: 'qualification-l1-public-projection-runner-v1',
    });
    const fixtureRunnerBlocked = await buildSourceOwnedSentinelJourneyMapV2(
      swappedBehavioralExecution,
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(fixtureRunnerBlocked.rows.slice(0, 2).every((row) => row.state === 'blocked')).toBe(
      true,
    );
    expect(fixtureRunnerBlocked.coverage.observedJourneyIds).toEqual([]);
  }, 60_000);
});
