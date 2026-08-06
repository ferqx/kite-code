import { describe, expect, test } from 'bun:test';
import {
  buildAgentQualificationEvidenceV1,
  buildDiagnosticCandidateArtifactClosureV1,
  buildDiagnosticExecutionV1,
  buildQualificationAttemptV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import {
  buildQualificationVerifierContextV1,
  reconstructSourceOwnedL1PublicProjectionV1,
  reconstructSourceOwnedL1SkillMcpV1,
  reconstructSourceOwnedL1SubagentRecoveryV1,
  reconstructSourceOwnedL1ToolVerificationV1,
  reconstructSourceOwnedL1TuiRewindForkProjectionV1,
  verifyAgentQualificationEvidenceV1,
  verifyL1PublicProjectionEvidenceV1,
  verifyL1SkillMcpEvidenceV1,
  verifyL1SubagentRecoveryEvidenceV1,
  verifyL1ToolVerificationEvidenceV1,
  verifyL1TuiRewindForkProjectionEvidenceV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-verifier-v1';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
  EVIDENCE_GOVERNANCE_PROFILE_V1,
} from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';
import {
  L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
  L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-public-projection-schema-v1';
import { l1SkillMcpReceiptBindingV1 } from '../../../scripts/evals/contracts/qualification/l1-skill-mcp-evidence-v1';
import {
  L1_SKILL_MCP_FIXTURE_ID_V1,
  L1_SKILL_MCP_RUNNER_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-skill-mcp-schema-v1';
import { l1SubagentRecoveryReceiptBindingV1 } from '../../../scripts/evals/contracts/qualification/l1-subagent-recovery-evidence-v1';
import {
  L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
  L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-subagent-recovery-schema-v1';
import { l1ToolVerificationReceiptBindingV1 } from '../../../scripts/evals/contracts/qualification/l1-tool-verification-evidence-v1';
import {
  L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
  L1_TOOL_VERIFICATION_RUNNER_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-tool-verification-schema-v1';
import { l1TuiRewindForkProjectionReceiptBindingV1 } from '../../../scripts/evals/contracts/qualification/l1-tui-rewind-projection-evidence-v1';
import {
  L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
  L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-tui-rewind-projection-schema-v1';

const CREATED_AT = '2026-08-05T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);

function digest(character: string): `sha256:${string}` {
  return ('sha256:' + character.repeat(64)) as `sha256:${string}`;
}

function candidate(payloadDigestCharacter = 'a') {
  return buildDiagnosticCandidateArtifactClosureV1({
    schema: 'DiagnosticCandidateArtifactClosureV1',
    version: 1,
    artifacts: [
      {
        platformIdentity: 'linux-x64',
        artifact: {
          canonicalRepository: 'ferqx/kite-code',
          repositoryId: 'R_kgDOKite',
          commit: COMMIT,
          payloadSha256: digest(payloadDigestCharacter),
          canonicalManifestDigest: digest('b'),
          behaviorDigest: digest('c'),
          profileDigest: digest('d'),
          gatePolicyDigest: digest('e'),
        },
      },
    ],
  });
}

function governanceWitnesses(attempts: number, reservationId: string) {
  const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
  const counters = {
    attempts,
    tokens: attempts * 10,
    runWallClockSeconds: attempts,
    costUsdMicros: attempts,
  };
  const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
    schema: 'EvidenceQuotaLedgerV1',
    profileId: profile.profileId,
    profileDigest: profile.profileDigest,
    routePolicyDigest: digest('1'),
    period: 'day',
    periodStart: '2026-08-05',
    reservationId,
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
    reservationId,
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
  return {
    governance: {
      retentionClass: 'ephemeral_local' as const,
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      quotaLedgerDigests: {
        day: dayQuotaLedger.recordDigest,
        month: monthQuotaLedger.recordDigest,
      },
      storageDeletionWitnessDigest: retention.recordDigest,
    },
    witnesses: { dayQuotaLedger, monthQuotaLedger, retention },
  };
}

function execution(fixtureId: string, runner: string, executionId: string) {
  return buildDiagnosticExecutionV1({
    executionId,
    platformIdentity: 'linux-x64',
    identity: {
      source: 'local_synthetic',
      fixtureId,
      runner,
      commit: COMMIT,
      startedAt: CREATED_AT,
      endedAt: '2026-08-05T00:00:01.000Z',
    },
  });
}

const reconstructedPromise = Promise.all([
  reconstructSourceOwnedL1ToolVerificationV1(),
  Promise.resolve(reconstructSourceOwnedL1PublicProjectionV1()),
  reconstructSourceOwnedL1SkillMcpV1(),
  reconstructSourceOwnedL1SubagentRecoveryV1(),
  reconstructSourceOwnedL1TuiRewindForkProjectionV1(),
]);

async function behavioralFixture() {
  const [reconstructed] = await reconstructedPromise;
  const sourceSurfaceId = 'runtime:tool-lifecycle';
  const bindings = reconstructed.bindings.filter(
    (binding) => binding.sourceSurfaceId === sourceSurfaceId,
  );
  const receipts = reconstructed.receipts.filter(
    (receipt) => receipt.sourceSurfaceId === sourceSurfaceId,
  );
  const diagnosticCandidate = candidate();
  const governance = governanceWitnesses(bindings.length, 'l1-tool-reservation-001');
  const diagnosticExecution = execution(
    'l1-tool-verification-fixture-v1',
    'qualification-l1-tool-verification-runner-v1',
    'l1-tool-execution-linux-001',
  );
  const scope = {
    platformIdentity: 'linux-x64',
    releaseProfileDigest: digest('d'),
    entrypoint: 'runtime' as const,
    testPolicyDigest: digest('1'),
    routePolicyDigest: digest('1'),
  };
  const identity = {
    matrixDigest: reconstructed.matrix.matrixDigest,
    suiteDigest: reconstructed.suite.suiteDigest,
    oracleDigest: reconstructed.suite.oracleDigest,
    corpusDigest: reconstructed.suite.corpusDigest,
    evaluatorDigest: reconstructed.suite.evaluatorDigest,
    verifierDigest: reconstructed.evaluator.verifierDigest,
    runnerDigest: reconstructed.evaluator.runnerDigest,
  };
  const evidence = buildAgentQualificationEvidenceV1({
    schema: 'AgentQualificationEvidenceV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    createdAt: CREATED_AT,
    candidate: diagnosticCandidate,
    governance: governance.governance,
    suite: {
      suiteId: reconstructed.suite.suiteId,
      suiteDigest: reconstructed.suite.suiteDigest,
      role: 'behavioral',
    },
    executions: [diagnosticExecution],
    attempts: bindings.map((binding, index) => {
      const receipt = receipts.find(
        (candidateReceipt) => candidateReceipt.assertionId === binding.binding.assertionId,
      );
      if (!receipt) throw new Error('test_l1_behavioral_receipt_missing');
      return buildQualificationAttemptV1({
        attemptId: 'l1-tool-attempt-' + String(index + 1).padStart(2, '0'),
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        status: 'passed',
        executionId: diagnosticExecution.executionId,
        candidateArtifact: diagnosticCandidate.artifacts[0]!,
        scope,
        identity,
        receipt: l1ToolVerificationReceiptBindingV1(receipt),
      });
    }),
  });
  return {
    reconstructed,
    bindings,
    receipts,
    evidence,
    candidate: diagnosticCandidate,
    governance,
    execution: diagnosticExecution,
    scope,
  };
}

async function projectionFixture() {
  const [, reconstructed] = await reconstructedPromise;
  const sourceSurfaceId = 'cli:runtime-event-projection';
  const bindings = reconstructed.bindings.filter(
    (binding) => binding.sourceSurfaceId === sourceSurfaceId,
  );
  const receipts = reconstructed.receipts.filter(
    (receipt) => receipt.sourceSurfaceId === sourceSurfaceId,
  );
  const diagnosticCandidate = candidate();
  const governance = governanceWitnesses(bindings.length, 'l1-projection-reservation-001');
  const diagnosticExecution = execution(
    'l1-public-projection-fixture-v1',
    'qualification-l1-public-projection-runner-v1',
    'l1-projection-execution-linux-001',
  );
  const scope = {
    platformIdentity: 'linux-x64',
    releaseProfileDigest: digest('d'),
    entrypoint: 'cli' as const,
    testPolicyDigest: digest('1'),
    routePolicyDigest: digest('1'),
  };
  const identity = {
    matrixDigest: reconstructed.matrix.matrixDigest,
    suiteDigest: reconstructed.suite.suiteDigest,
    oracleDigest: reconstructed.suite.oracleDigest,
    corpusDigest: reconstructed.suite.corpusDigest,
    evaluatorDigest: reconstructed.suite.evaluatorDigest,
    verifierDigest: reconstructed.evaluator.verifierDigest,
    runnerDigest: reconstructed.evaluator.runnerDigest,
  };
  const evidence = buildAgentQualificationEvidenceV1({
    schema: 'AgentQualificationEvidenceV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    createdAt: CREATED_AT,
    candidate: diagnosticCandidate,
    governance: governance.governance,
    suite: {
      suiteId: reconstructed.suite.suiteId,
      suiteDigest: reconstructed.suite.suiteDigest,
      role: 'behavioral',
    },
    executions: [diagnosticExecution],
    attempts: bindings.map((binding, index) => {
      const receipt = receipts.find(
        (candidateReceipt) => candidateReceipt.assertionId === binding.binding.assertionId,
      );
      if (!receipt) throw new Error('test_l1_projection_receipt_missing');
      return buildQualificationAttemptV1({
        attemptId: 'l1-projection-attempt-' + String(index + 1).padStart(2, '0'),
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        status: 'passed',
        executionId: diagnosticExecution.executionId,
        candidateArtifact: diagnosticCandidate.artifacts[0]!,
        scope,
        identity,
        receipt: { receiptId: receipt.receiptId, receiptDigest: receipt.receiptDigest },
      });
    }),
  });
  return {
    reconstructed,
    bindings,
    receipts,
    evidence,
    candidate: diagnosticCandidate,
    governance,
    execution: diagnosticExecution,
    scope,
  };
}

async function skillMcpFixture(sourceSurfaceId = 'skill:open-world-contract') {
  const [, , reconstructed] = await reconstructedPromise;
  const bindings = reconstructed.bindings.filter(
    (binding) => binding.sourceSurfaceId === sourceSurfaceId,
  );
  const receipts = reconstructed.receipts.filter(
    (receipt) => receipt.sourceSurfaceId === sourceSurfaceId,
  );
  if (bindings.length === 0 || receipts.length === 0) {
    throw new Error('test_l1_skill_mcp_source_binding_missing:' + sourceSurfaceId);
  }
  const diagnosticCandidate = candidate();
  const governance = governanceWitnesses(bindings.length, 'l1-skill-mcp-reservation-001');
  const diagnosticExecution = execution(
    L1_SKILL_MCP_FIXTURE_ID_V1,
    L1_SKILL_MCP_RUNNER_ID_V1,
    'l1-skill-mcp-execution-linux-001',
  );
  const scope = {
    platformIdentity: 'linux-x64',
    releaseProfileDigest: digest('d'),
    entrypoint: 'runtime' as const,
    testPolicyDigest: digest('1'),
    routePolicyDigest: digest('1'),
  };
  const identity = {
    matrixDigest: reconstructed.matrix.matrixDigest,
    suiteDigest: reconstructed.suite.suiteDigest,
    oracleDigest: reconstructed.suite.oracleDigest,
    corpusDigest: reconstructed.suite.corpusDigest,
    evaluatorDigest: reconstructed.suite.evaluatorDigest,
    verifierDigest: reconstructed.evaluator.verifierDigest,
    runnerDigest: reconstructed.evaluator.runnerDigest,
  };
  const evidence = buildAgentQualificationEvidenceV1({
    schema: 'AgentQualificationEvidenceV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    createdAt: CREATED_AT,
    candidate: diagnosticCandidate,
    governance: governance.governance,
    suite: {
      suiteId: reconstructed.suite.suiteId,
      suiteDigest: reconstructed.suite.suiteDigest,
      role: 'behavioral',
    },
    executions: [diagnosticExecution],
    attempts: bindings.map((binding, index) => {
      const receipt = receipts.find(
        (candidateReceipt) => candidateReceipt.assertionId === binding.binding.assertionId,
      );
      if (!receipt) throw new Error('test_l1_skill_mcp_receipt_missing');
      return buildQualificationAttemptV1({
        attemptId: 'l1-skill-mcp-attempt-' + String(index + 1).padStart(2, '0'),
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        status: 'passed',
        executionId: diagnosticExecution.executionId,
        candidateArtifact: diagnosticCandidate.artifacts[0]!,
        scope,
        identity,
        receipt: l1SkillMcpReceiptBindingV1(receipt),
      });
    }),
  });
  return {
    reconstructed,
    bindings,
    receipts,
    evidence,
    candidate: diagnosticCandidate,
    governance,
    execution: diagnosticExecution,
    scope,
  };
}

async function subagentRecoveryFixture(sourceSurfaceId = 'subagent:open-world-contract') {
  const [, , , reconstructed] = await reconstructedPromise;
  const bindings = reconstructed.bindings.filter(
    (binding) => binding.sourceSurfaceId === sourceSurfaceId,
  );
  const receipts = reconstructed.receipts.filter(
    (receipt) => receipt.sourceSurfaceId === sourceSurfaceId,
  );
  if (bindings.length === 0 || receipts.length === 0) {
    throw new Error('test_l1_subagent_recovery_source_binding_missing:' + sourceSurfaceId);
  }
  const diagnosticCandidate = candidate();
  const governance = governanceWitnesses(bindings.length, 'l1-subagent-recovery-reservation-001');
  const diagnosticExecution = execution(
    L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
    L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
    'l1-subagent-recovery-execution-linux-001',
  );
  const scope = {
    platformIdentity: 'linux-x64',
    releaseProfileDigest: digest('d'),
    entrypoint: 'runtime' as const,
    testPolicyDigest: digest('1'),
    routePolicyDigest: digest('1'),
  };
  const identity = {
    matrixDigest: reconstructed.matrix.matrixDigest,
    suiteDigest: reconstructed.suite.suiteDigest,
    oracleDigest: reconstructed.suite.oracleDigest,
    corpusDigest: reconstructed.suite.corpusDigest,
    evaluatorDigest: reconstructed.suite.evaluatorDigest,
    verifierDigest: reconstructed.evaluator.verifierDigest,
    runnerDigest: reconstructed.evaluator.runnerDigest,
  };
  const evidence = buildAgentQualificationEvidenceV1({
    schema: 'AgentQualificationEvidenceV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    createdAt: CREATED_AT,
    candidate: diagnosticCandidate,
    governance: governance.governance,
    suite: {
      suiteId: reconstructed.suite.suiteId,
      suiteDigest: reconstructed.suite.suiteDigest,
      role: 'behavioral',
    },
    executions: [diagnosticExecution],
    attempts: bindings.map((binding, index) => {
      const receipt = receipts.find(
        (candidateReceipt) => candidateReceipt.assertionId === binding.binding.assertionId,
      );
      if (!receipt) throw new Error('test_l1_subagent_recovery_receipt_missing');
      return buildQualificationAttemptV1({
        attemptId: 'l1-subagent-recovery-attempt-' + String(index + 1).padStart(2, '0'),
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        status: 'passed',
        executionId: diagnosticExecution.executionId,
        candidateArtifact: diagnosticCandidate.artifacts[0]!,
        scope,
        identity,
        receipt: l1SubagentRecoveryReceiptBindingV1(receipt),
      });
    }),
  });
  return {
    reconstructed,
    bindings,
    receipts,
    evidence,
    candidate: diagnosticCandidate,
    governance,
    execution: diagnosticExecution,
    scope,
  };
}

async function tuiRewindForkProjectionFixture(sourceSurfaceId = 'tui:rewind-control') {
  const [, , , , reconstructed] = await reconstructedPromise;
  const bindings = reconstructed.bindings.filter(
    (binding) => binding.sourceSurfaceId === sourceSurfaceId,
  );
  const receipts = reconstructed.receipts.filter(
    (receipt) => receipt.sourceSurfaceId === sourceSurfaceId,
  );
  if (bindings.length === 0 || receipts.length === 0) {
    throw new Error('test_l1_tui_rewind_fork_projection_source_binding_missing:' + sourceSurfaceId);
  }
  const diagnosticCandidate = candidate();
  const governance = governanceWitnesses(
    bindings.length,
    'l1-tui-rewind-fork-projection-reservation-001',
  );
  const diagnosticExecution = execution(
    L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
    L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
    'l1-tui-rewind-fork-projection-execution-linux-001',
  );
  const scope = {
    platformIdentity: 'linux-x64',
    releaseProfileDigest: digest('d'),
    entrypoint: 'tui' as const,
    testPolicyDigest: digest('1'),
    routePolicyDigest: digest('1'),
  };
  const identity = {
    matrixDigest: reconstructed.matrix.matrixDigest,
    suiteDigest: reconstructed.suite.suiteDigest,
    oracleDigest: reconstructed.suite.oracleDigest,
    corpusDigest: reconstructed.suite.corpusDigest,
    evaluatorDigest: reconstructed.suite.evaluatorDigest,
    verifierDigest: reconstructed.evaluator.verifierDigest,
    runnerDigest: reconstructed.evaluator.runnerDigest,
  };
  const evidence = buildAgentQualificationEvidenceV1({
    schema: 'AgentQualificationEvidenceV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    createdAt: CREATED_AT,
    candidate: diagnosticCandidate,
    governance: governance.governance,
    suite: {
      suiteId: reconstructed.suite.suiteId,
      suiteDigest: reconstructed.suite.suiteDigest,
      role: 'behavioral',
    },
    executions: [diagnosticExecution],
    attempts: bindings.map((binding, index) => {
      const receipt = receipts.find(
        (candidateReceipt) => candidateReceipt.assertionId === binding.binding.assertionId,
      );
      if (!receipt) throw new Error('test_l1_tui_rewind_fork_projection_receipt_missing');
      return buildQualificationAttemptV1({
        attemptId: 'l1-tui-rewind-fork-projection-attempt-' + String(index + 1).padStart(2, '0'),
        featureId: binding.featureId,
        assertionId: binding.binding.assertionId,
        layer: 'scripted_runtime',
        status: 'passed',
        executionId: diagnosticExecution.executionId,
        candidateArtifact: diagnosticCandidate.artifacts[0]!,
        scope,
        identity,
        receipt: l1TuiRewindForkProjectionReceiptBindingV1(receipt),
      });
    }),
  });
  return {
    reconstructed,
    bindings,
    receipts,
    evidence,
    candidate: diagnosticCandidate,
    governance,
    execution: diagnosticExecution,
    scope,
  };
}

describe('source-owned L1 diagnostic evidence', () => {
  test('reconstructs candidate-bound behavioral receipts and public projection receipts separately', async () => {
    const behavioral = await behavioralFixture();
    const behavioralReport = await verifyL1ToolVerificationEvidenceV1(
      {
        schema: 'L1ToolVerificationEvidenceVerificationInputV1',
        version: 1,
        evidence: behavioral.evidence,
        trusted: {
          candidate: behavioral.candidate,
          governance: behavioral.governance.governance,
          executions: [behavioral.execution],
          governanceWitnesses: behavioral.governance.witnesses,
        },
        sourceSurfaceId: 'runtime:tool-lifecycle',
        scopes: [{ sourceSurfaceId: 'runtime:tool-lifecycle', scope: behavioral.scope }],
        receipts: behavioral.receipts,
      },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(behavioralReport.authority).toBe('diagnostic');
    expect(behavioralReport.evidenceEligible).toBe(false);
    expect(behavioralReport.results).toHaveLength(3);
    expect(behavioralReport.results.every((result) => result.status === 'qualified')).toBe(true);

    const projection = await projectionFixture();
    const projectionReport = verifyL1PublicProjectionEvidenceV1(
      {
        schema: 'L1PublicProjectionEvidenceVerificationInputV1',
        version: 1,
        evidence: projection.evidence,
        trusted: {
          candidate: projection.candidate,
          governance: projection.governance.governance,
          executions: [projection.execution],
          governanceWitnesses: projection.governance.witnesses,
        },
        sourceSurfaceId: 'cli:runtime-event-projection',
        scopes: [{ sourceSurfaceId: 'cli:runtime-event-projection', scope: projection.scope }],
        receipts: projection.receipts,
      },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(projectionReport.results).toHaveLength(2);
    expect(projectionReport.results.every((result) => result.status === 'qualified')).toBe(true);
  }, 30_000);

  test('reconstructs sealed Skill/MCP receipts only from the six source-owned bindings', async () => {
    const value = await skillMcpFixture();
    const report = await verifyL1SkillMcpEvidenceV1(
      {
        schema: 'L1SkillMcpEvidenceVerificationInputV1',
        version: 1,
        evidence: value.evidence,
        trusted: {
          candidate: value.candidate,
          governance: value.governance.governance,
          executions: [value.execution],
          governanceWitnesses: value.governance.witnesses,
        },
        sourceSurfaceId: 'skill:open-world-contract',
        scopes: [{ sourceSurfaceId: 'skill:open-world-contract', scope: value.scope }],
        receipts: value.receipts,
      },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(report.authority).toBe('diagnostic');
    expect(report.evidenceEligible).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({ status: 'qualified' });
  }, 30_000);

  test('reconstructs candidate-bound Subagent/Runtime recovery receipts from a sealed synthetic run', async () => {
    const value = await subagentRecoveryFixture();
    const report = await verifyL1SubagentRecoveryEvidenceV1(
      {
        schema: 'L1SubagentRecoveryEvidenceVerificationInputV1',
        version: 1,
        evidence: value.evidence,
        trusted: {
          candidate: value.candidate,
          governance: value.governance.governance,
          executions: [value.execution],
          governanceWitnesses: value.governance.witnesses,
        },
        sourceSurfaceId: 'subagent:open-world-contract',
        scopes: [{ sourceSurfaceId: 'subagent:open-world-contract', scope: value.scope }],
        receipts: value.receipts,
      },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(report.authority).toBe('diagnostic');
    expect(report.evidenceEligible).toBe(false);
    expect(report.results).toHaveLength(value.bindings.length);
    expect(report.results.every((result) => result.status === 'qualified')).toBe(true);
  }, 30_000);

  test('reconstructs candidate-bound TUI /rewind fork projection evidence separately', async () => {
    const value = await tuiRewindForkProjectionFixture();
    const report = await verifyL1TuiRewindForkProjectionEvidenceV1(
      {
        schema: 'L1TuiRewindForkProjectionEvidenceVerificationInputV1',
        version: 1,
        evidence: value.evidence,
        trusted: {
          candidate: value.candidate,
          governance: value.governance.governance,
          executions: [value.execution],
          governanceWitnesses: value.governance.witnesses,
        },
        sourceSurfaceId: 'tui:rewind-control',
        scopes: [{ sourceSurfaceId: 'tui:rewind-control', scope: value.scope }],
        receipts: value.receipts,
      },
      new Date('2026-08-06T01:00:00.000Z'),
    );
    expect(report.authority).toBe('diagnostic');
    expect(report.evidenceEligible).toBe(false);
    expect(report.results).toHaveLength(value.bindings.length);
    expect(report.results.every((result) => result.status === 'qualified')).toBe(true);
  }, 30_000);

  test('fails closed on spliced source receipts and caller-supplied evaluator reports', async () => {
    const value = await behavioralFixture();
    const input = {
      schema: 'L1ToolVerificationEvidenceVerificationInputV1' as const,
      version: 1 as const,
      evidence: value.evidence,
      trusted: {
        candidate: value.candidate,
        governance: value.governance.governance,
        executions: [value.execution],
        governanceWitnesses: value.governance.witnesses,
      },
      sourceSurfaceId: 'runtime:tool-lifecycle',
      scopes: [{ sourceSurfaceId: 'runtime:tool-lifecycle', scope: value.scope }],
      receipts: value.receipts,
    };
    const spliced = await verifyL1ToolVerificationEvidenceV1(
      { ...input, receipts: [value.reconstructed.receipts[0]!] },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(spliced.results.every((result) => result.status === 'blocked')).toBe(true);
    const forged = await verifyL1ToolVerificationEvidenceV1(
      { ...input, evaluatorReport: value.reconstructed.evaluatorReport },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(forged.results.every((result) => result.status === 'blocked')).toBe(true);
  }, 30_000);

  test('fails closed when Skill/MCP evidence splices a receipt or a fixture/runner pair', async () => {
    const value = await skillMcpFixture();
    const input = {
      schema: 'L1SkillMcpEvidenceVerificationInputV1' as const,
      version: 1 as const,
      evidence: value.evidence,
      trusted: {
        candidate: value.candidate,
        governance: value.governance.governance,
        executions: [value.execution],
        governanceWitnesses: value.governance.witnesses,
      },
      sourceSurfaceId: 'skill:open-world-contract',
      scopes: [{ sourceSurfaceId: 'skill:open-world-contract', scope: value.scope }],
      receipts: value.receipts,
    };
    const spliced = await verifyL1SkillMcpEvidenceV1(
      { ...input, receipts: [value.reconstructed.receipts[0]!] },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(spliced.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);

    const wrongExecution = execution(
      L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
      L1_TOOL_VERIFICATION_RUNNER_ID_V1,
      value.execution.executionId,
    );
    const {
      recordDigest: _recordDigest,
      reportDigest: _reportDigest,
      ...evidenceMaterial
    } = value.evidence;
    const replayedEvidence = buildAgentQualificationEvidenceV1({
      ...evidenceMaterial,
      executions: [wrongExecution],
    });
    const replayed = await verifyL1SkillMcpEvidenceV1(
      {
        ...input,
        evidence: replayedEvidence,
        trusted: { ...input.trusted, executions: [wrongExecution] },
      },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(replayed.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);
  }, 30_000);

  test('fails closed when Subagent/Runtime recovery evidence splices receipts, fixture/runner, or candidate', async () => {
    const value = await subagentRecoveryFixture();
    const input = {
      schema: 'L1SubagentRecoveryEvidenceVerificationInputV1' as const,
      version: 1 as const,
      evidence: value.evidence,
      trusted: {
        candidate: value.candidate,
        governance: value.governance.governance,
        executions: [value.execution],
        governanceWitnesses: value.governance.witnesses,
      },
      sourceSurfaceId: 'subagent:open-world-contract',
      scopes: [{ sourceSurfaceId: 'subagent:open-world-contract', scope: value.scope }],
      receipts: value.receipts,
    };
    const foreignReceipt = value.reconstructed.receipts.find(
      (receipt) => receipt.sourceSurfaceId !== input.sourceSurfaceId,
    );
    if (!foreignReceipt) throw new Error('test_l1_subagent_recovery_foreign_receipt_missing');
    const spliced = await verifyL1SubagentRecoveryEvidenceV1(
      { ...input, receipts: [foreignReceipt] },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(spliced.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);

    const wrongExecution = execution(
      L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
      L1_TOOL_VERIFICATION_RUNNER_ID_V1,
      value.execution.executionId,
    );
    const {
      recordDigest: _recordDigest,
      reportDigest: _reportDigest,
      ...evidenceMaterial
    } = value.evidence;
    const replayedEvidence = buildAgentQualificationEvidenceV1({
      ...evidenceMaterial,
      executions: [wrongExecution],
    });
    const replayed = await verifyL1SubagentRecoveryEvidenceV1(
      {
        ...input,
        evidence: replayedEvidence,
        trusted: { ...input.trusted, executions: [wrongExecution] },
      },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(replayed.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);

    const candidateSwapped = await verifyL1SubagentRecoveryEvidenceV1(
      { ...input, trusted: { ...input.trusted, candidate: candidate('f') } },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(candidateSwapped.results.every((result) => result.status === 'blocked')).toBe(true);
  }, 30_000);

  test('fails closed when TUI /rewind fork projection receipt, fixture/runner, or candidate is tampered', async () => {
    const value = await tuiRewindForkProjectionFixture();
    const input = {
      schema: 'L1TuiRewindForkProjectionEvidenceVerificationInputV1' as const,
      version: 1 as const,
      evidence: value.evidence,
      trusted: {
        candidate: value.candidate,
        governance: value.governance.governance,
        executions: [value.execution],
        governanceWitnesses: value.governance.witnesses,
      },
      sourceSurfaceId: 'tui:rewind-control',
      scopes: [{ sourceSurfaceId: 'tui:rewind-control', scope: value.scope }],
      receipts: value.receipts,
    };
    const receipt = value.receipts[0];
    if (!receipt) throw new Error('test_l1_tui_rewind_fork_projection_receipt_missing');
    const tamperedReceipt = { ...receipt, receiptDigest: digest('f') };
    const tampered = await verifyL1TuiRewindForkProjectionEvidenceV1(
      { ...input, receipts: [tamperedReceipt] },
      new Date('2026-08-06T01:00:00.000Z'),
    );
    expect(tampered.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);

    const wrongExecution = execution(
      L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
      L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
      value.execution.executionId,
    );
    const {
      recordDigest: _recordDigest,
      reportDigest: _reportDigest,
      ...evidenceMaterial
    } = value.evidence;
    const replayedEvidence = buildAgentQualificationEvidenceV1({
      ...evidenceMaterial,
      executions: [wrongExecution],
    });
    const replayed = await verifyL1TuiRewindForkProjectionEvidenceV1(
      {
        ...input,
        evidence: replayedEvidence,
        trusted: { ...input.trusted, executions: [wrongExecution] },
      },
      new Date('2026-08-06T01:00:00.000Z'),
    );
    expect(replayed.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);

    const candidateSwapped = await verifyL1TuiRewindForkProjectionEvidenceV1(
      { ...input, trusted: { ...input.trusted, candidate: candidate('f') } },
      new Date('2026-08-06T01:00:00.000Z'),
    );
    expect(candidateSwapped.results.every((result) => result.status === 'blocked')).toBe(true);
  }, 30_000);

  test('pins every specialized L1 verifier to its own registered synthetic fixture and runner', async () => {
    const behavioral = await behavioralFixture();
    const behavioralWrongExecution = execution(
      L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
      L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
      behavioral.execution.executionId,
    );
    const {
      recordDigest: _behavioralRecordDigest,
      reportDigest: _behavioralReportDigest,
      ...behavioralMaterial
    } = behavioral.evidence;
    const behavioralWithProjectionExecution = buildAgentQualificationEvidenceV1({
      ...behavioralMaterial,
      executions: [behavioralWrongExecution],
    });
    const behavioralReport = await verifyL1ToolVerificationEvidenceV1(
      {
        schema: 'L1ToolVerificationEvidenceVerificationInputV1',
        version: 1,
        evidence: behavioralWithProjectionExecution,
        trusted: {
          candidate: behavioral.candidate,
          governance: behavioral.governance.governance,
          executions: [behavioralWrongExecution],
          governanceWitnesses: behavioral.governance.witnesses,
        },
        sourceSurfaceId: 'runtime:tool-lifecycle',
        scopes: [{ sourceSurfaceId: 'runtime:tool-lifecycle', scope: behavioral.scope }],
        receipts: behavioral.receipts,
      },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(behavioralReport.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);

    const projection = await projectionFixture();
    const projectionWrongExecution = execution(
      L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
      L1_TOOL_VERIFICATION_RUNNER_ID_V1,
      projection.execution.executionId,
    );
    const {
      recordDigest: _projectionRecordDigest,
      reportDigest: _projectionReportDigest,
      ...projectionMaterial
    } = projection.evidence;
    const projectionWithToolExecution = buildAgentQualificationEvidenceV1({
      ...projectionMaterial,
      executions: [projectionWrongExecution],
    });
    const projectionReport = verifyL1PublicProjectionEvidenceV1(
      {
        schema: 'L1PublicProjectionEvidenceVerificationInputV1',
        version: 1,
        evidence: projectionWithToolExecution,
        trusted: {
          candidate: projection.candidate,
          governance: projection.governance.governance,
          executions: [projectionWrongExecution],
          governanceWitnesses: projection.governance.witnesses,
        },
        sourceSurfaceId: 'cli:runtime-event-projection',
        scopes: [{ sourceSurfaceId: 'cli:runtime-event-projection', scope: projection.scope }],
        receipts: projection.receipts,
      },
      new Date('2026-08-05T01:00:00.000Z'),
    );
    expect(projectionReport.results).toEqual([
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    ]);
  }, 30_000);

  test('keeps generic behavioral contexts unable to promote a diagnostic record', async () => {
    const value = await behavioralFixture();
    const binding = value.bindings[0];
    if (!binding) throw new Error('test_l1_generic_context_binding_missing');
    const receipt = value.receipts.find(
      (candidateReceipt) => candidateReceipt.assertionId === binding.binding.assertionId,
    );
    if (!receipt) throw new Error('test_l1_generic_context_receipt_missing');
    const report = verifyAgentQualificationEvidenceV1(
      value.evidence,
      buildQualificationVerifierContextV1({
        schema: 'QualificationVerifierContextV1',
        version: 1,
        candidate: value.candidate,
        governance: value.governance.governance,
        executions: [value.execution],
        suite: {
          suiteId: value.reconstructed.suite.suiteId,
          suiteDigest: value.reconstructed.suite.suiteDigest,
          role: 'behavioral',
        },
        governanceWitnesses: value.governance.witnesses,
        requirements: [
          {
            requirementId: 'untrusted-l1-behavioral-context',
            featureId: binding.featureId,
            assertionId: binding.binding.assertionId,
            layer: 'scripted_runtime',
            scope: value.scope,
            identity: {
              matrixDigest: value.reconstructed.matrix.matrixDigest,
              suiteDigest: value.reconstructed.suite.suiteDigest,
              oracleDigest: value.reconstructed.suite.oracleDigest,
              corpusDigest: value.reconstructed.suite.corpusDigest,
              evaluatorDigest: value.reconstructed.suite.evaluatorDigest,
              verifierDigest: value.reconstructed.evaluator.verifierDigest,
              runnerDigest: value.reconstructed.evaluator.runnerDigest,
            },
            receipt: l1ToolVerificationReceiptBindingV1(receipt),
            expectedDisposition: 'behavioral_required',
          },
        ],
      }),
    );
    expect(report.authority).toBe('diagnostic');
    expect(report.evidenceEligible).toBe(false);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      status: 'blocked',
      reasonCode: 'behavioral_context_untrusted',
    });
  }, 30_000);
});
