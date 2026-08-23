import { describe, expect, test } from 'bun:test';
import {
  buildLimitedSloAdmission,
  buildLimitedSloSampleLedger,
  buildLimitedSloTerminalReceipt,
  type LimitedSloSampleLedger,
  rebuildLimitedSloObservation,
  verifyLimitedSloSampleLedger,
} from '../../scripts/operations/limited-slo-ledger';
import { qualifyLimitedSlo } from '../../scripts/operations/qualify-limited-slo';
import { verifyLimitedSloQualification } from '../../scripts/operations/verify-limited-slo-qualification';
import { canonicalJson, sha256DomainSeparated } from '../../scripts/release/canonical-json';

const digest = (marker: string): `sha256:${string}` =>
  `sha256:${marker.charCodeAt(0).toString(16).padStart(2, '0').repeat(32)}`;
const commit = 'a'.repeat(40);
const artifactIdentity = {
  canonicalRepository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  commit,
  payloadSha256: digest('a'),
  canonicalManifestDigest: digest('m'),
  behaviorDigest: digest('b'),
  profileDigest: digest('p'),
  gatePolicyDigest: digest('g'),
} as const;
const source = {
  repository: 'ferqx/kite-code',
  repositoryId: 'R_kgDOSKbi8g',
  headSha: commit,
  ref: 'refs/heads/main',
  workflowPath: '.github/workflows/limited-slo.yml',
  workflowRef: 'ferqx/kite-code/.github/workflows/limited-slo.yml@refs/heads/main',
  workflowSha: commit,
  runId: '42',
  runAttempt: 1,
  jobName: 'limited-slo',
  jobId: '4201',
  artifactName: 'limited-slo-evidence',
  artifactId: '4202',
  artifactDigest: artifactIdentity.payloadSha256,
  oidcIssuer: 'https://token.actions.githubusercontent.com',
  attestationSubjectDigest: artifactIdentity.payloadSha256,
} as const;
const zeroG0 = {
  unauthorized_side_effects: 0,
  secret_or_content_egress: 0,
  sandbox_or_workspace_escape: 0,
  runtime_state_corruption: 0,
  required_verification_bypass: 0,
} as const;

const policy = {
  schema: 'AgentProductionSlo',
  policyId: 'agent-production-test-v1',
  status: 'approved',
  approvalMilestone: 'MS:LIM-APPROVED',
  noData: 'blocked',
  minimumSamples: 4,
  observationWindowSeconds: 3600,
  errorBudget: 0.5,
  g0: zeroG0,
  thresholds: {
    task_checks_passed: 0.5,
    human_accepted: 0.5,
    recovery_success: 0.5,
    unrelated_diff: 0.5,
    false_completion: 0.5,
    integrated: 0.5,
    reverted: 0.5,
  },
  approval: {
    owner: 'github:@ferqx',
    approvedAt: '2026-07-31T00:00:00.000Z',
    evidenceDigest: digest('p'),
  },
} as const;
const policyDigest = sha256DomainSeparated(
  'kite.operations.limited-slo-policy.v1',
  canonicalJson(policy),
);

function ledger(): LimitedSloSampleLedger {
  let previousAdmission: `sha256:${string}` | null = null;
  let previousTerminal: `sha256:${string}` | null = null;
  const admissions = [];
  const terminalReceipts = [];
  for (let index = 0; index < 4; index += 1) {
    const admission = buildLimitedSloAdmission({
      schema: 'LimitedSloAdmission',
      sequence: index + 1,
      admissionId: `admission_${(index + 1).toString(16).padStart(32, '0')}`,
      previousAdmissionDigest: previousAdmission,
      admittedAt: `2026-08-01T0${index}:00:00.000Z`,
      consentReceiptDigest: digest('c'),
    });
    admissions.push(admission);
    previousAdmission = admission.admissionDigest as `sha256:${string}`;
    const terminal = buildLimitedSloTerminalReceipt({
      schema: 'LimitedSloTerminalReceipt',
      sequence: index + 1,
      terminalReceiptId: `terminal_${(index + 1).toString(16).padStart(32, '0')}`,
      admissionId: admission.admissionId,
      admissionDigest: admission.admissionDigest,
      previousTerminalDigest: previousTerminal,
      finalizedAt: `2026-08-01T0${index}:30:00.000Z`,
      outcomeReceiptDigest: digest(String(index + 1)),
      checksPassed: index !== 3,
      humanAccepted: index < 2,
      recoveryRequired: index < 2,
      recoverySucceeded: index === 0,
      unrelatedDiff: index === 3,
      falseCompletion: index === 3,
      integrated: index < 2,
      reverted: index === 1,
      g0: zeroG0,
      g1Failures: 0,
    });
    terminalReceipts.push(terminal);
    previousTerminal = terminal.terminalDigest as `sha256:${string}`;
  }
  return buildLimitedSloSampleLedger({
    schema: 'LimitedSloSampleLedger',
    policyDigest,
    limitedApprovalDecisionDigest: digest('l'),
    artifactIdentity,
    routeDigest: digest('r'),
    cohortDigest: digest('h'),
    source,
    startedAt: '2026-08-01T00:00:00.000Z',
    endedAt: '2026-08-01T04:00:00.000Z',
    droppedSampleCount: 0,
    consentCompliant: true,
    ownerAvailable: true,
    ownerAvailabilityReceiptDigest: digest('o'),
    killSwitchAvailable: true,
    killSwitchReceiptDigest: digest('k'),
    admissions,
    terminalReceipts,
  });
}

function expectation(value: LimitedSloSampleLedger) {
  return {
    policyDigest: value.policyDigest,
    limitedApprovalDecisionDigest: value.limitedApprovalDecisionDigest,
    artifactIdentity: value.artifactIdentity,
    routeDigest: value.routeDigest,
    cohortDigest: value.cohortDigest,
    source: value.source,
    reportDigest: digest('q'),
    verifierDigest: digest('v'),
  } as const;
}

describe('limited SLO retained ledger and independent verifier', () => {
  test('rebuilds every aggregate from a complete digest-chained admission set', () => {
    const value = ledger();
    const rebuilt = rebuildLimitedSloObservation(value);
    expect(rebuilt).toMatchObject({
      sampleCount: 4,
      noData: false,
      droppedSampleCount: 0,
      denominators: { tasks: 4, recoveryRequired: 2, integrated: 2 },
      errorBudgetBurn: 0.25,
      metrics: {
        task_checks_passed: 0.75,
        human_accepted: 0.5,
        recovery_success: 0.5,
        unrelated_diff: 0.25,
        false_completion: 0.25,
        integrated: 0.5,
        reverted: 0.5,
      },
    });
    expect(rebuildLimitedSloObservation(value)).toEqual(rebuilt);
  });

  test('rejects orphan admissions, duplicate terminals, reordering, and tampering', () => {
    const value = ledger();
    const firstTerminal = value.terminalReceipts[0]!;
    const secondTerminal = value.terminalReceipts[1]!;
    expect(() =>
      verifyLimitedSloSampleLedger({
        ...value,
        terminalReceipts: value.terminalReceipts.slice(0, -1),
      }),
    ).toThrow('orphan admission');
    expect(() =>
      verifyLimitedSloSampleLedger({
        ...value,
        terminalReceipts: [
          firstTerminal,
          {
            ...secondTerminal,
            admissionId: firstTerminal.admissionId,
            admissionDigest: firstTerminal.admissionDigest,
          },
          ...value.terminalReceipts.slice(2),
        ],
      }),
    ).toThrow('duplicate terminal receipts');
    expect(() =>
      verifyLimitedSloSampleLedger({
        ...value,
        admissions: [...value.admissions].reverse(),
      }),
    ).toThrow('sequence');
    expect(() =>
      verifyLimitedSloSampleLedger({
        ...value,
        terminalReceipts: [
          { ...value.terminalReceipts[0], checksPassed: false },
          ...value.terminalReceipts.slice(1),
        ],
      }),
    ).toThrow('digest mismatch');
  });

  test('binds expected GitHub and candidate identity but keeps production trust empty', () => {
    const value = ledger();
    const result = verifyLimitedSloQualification({
      ledger: value,
      expected: expectation(value),
    });
    expect(result).toMatchObject({
      status: 'blocked',
      productionEvidenceEligible: false,
      trustRegistryConfigured: false,
      reasonCodes: ['authenticated_observation_verifier_not_configured'],
    });
    const spliced = verifyLimitedSloQualification({
      ledger: value,
      expected: {
        ...expectation(value),
        artifactIdentity: { ...value.artifactIdentity, payloadSha256: digest('x') },
      },
    });
    expect(spliced.reasonCodes).toContain('artifact_identity_mismatch:payloadSha256');

    for (const [field, replacement] of [
      ['jobName', 'spliced-job'],
      ['artifactId', '9999'],
      ['attestationSubjectDigest', digest('x')],
    ] as const) {
      const result = verifyLimitedSloQualification({
        ledger: value,
        expected: {
          ...expectation(value),
          source: { ...value.source, [field]: replacement },
        },
      });
      expect(result.reasonCodes).toContain(`source_identity_mismatch:${field}`);
    }

    for (const sourceSplice of [
      { ...value.source, repository: 'attacker/fork' },
      { ...value.source, repositoryId: 'R_attacker' },
      { ...value.source, oidcIssuer: 'https://issuer.invalid' },
    ]) {
      expect(() =>
        verifyLimitedSloQualification({
          ledger: value,
          expected: { ...expectation(value), source: sourceSplice },
        }),
      ).toThrow();
    }

    const { ledgerDigest: _ledgerDigest, ...material } = value;
    expect(() =>
      buildLimitedSloSampleLedger({
        ...material,
        source: { ...value.source, artifactDigest: digest('x') },
      }),
    ).toThrow('source identity does not match the release artifact identity');
  });

  test('compares the supplied summary to the retained rebuild and never mints a milestone', () => {
    const value = ledger();
    const rebuilt = rebuildLimitedSloObservation(value);
    const observation = {
      schema: 'LimitedCohortObservation',
      artifactIdentity: value.artifactIdentity,
      routeDigest: value.routeDigest,
      cohortDigest: value.cohortDigest,
      source: {
        ...value.source,
        reportDigest: digest('q'),
        verifierDigest: digest('v'),
        sampleLedgerDigest: value.ledgerDigest,
      },
      startedAt: rebuilt.startedAt,
      endedAt: rebuilt.endedAt,
      sampleCount: rebuilt.sampleCount,
      noData: rebuilt.noData,
      consentCompliant: rebuilt.consentCompliant,
      ownerAvailable: rebuilt.ownerAvailable,
      killSwitchAvailable: rebuilt.killSwitchAvailable,
      g0: rebuilt.g0,
      g1Failures: rebuilt.g1Failures,
      errorBudgetBurn: rebuilt.errorBudgetBurn,
      metrics: rebuilt.metrics,
    } as const;
    const result = qualifyLimitedSlo({
      policy,
      observation,
      retainedLedger: value,
      expectedSource: expectation(value),
    });
    expect(result).toMatchObject({
      status: 'blocked',
      milestone: null,
      evidenceEligible: false,
      retainedLedgerDigest: value.ledgerDigest,
      retainedRebuildDigest: rebuilt.rebuildDigest,
      reasonCodes: ['authenticated_observation_verifier_not_configured'],
    });
    const forged = qualifyLimitedSlo({
      policy,
      observation: { ...observation, metrics: { ...observation.metrics, integrated: 1 } },
      retainedLedger: value,
      expectedSource: expectation(value),
    });
    expect(forged.reasonCodes).toContain('retained_sample_rebuild_mismatch');
    expect(forged.milestone).toBeNull();

    const candidateSplice = qualifyLimitedSlo({
      policy,
      observation: {
        ...observation,
        artifactIdentity: { ...observation.artifactIdentity, behaviorDigest: digest('x') },
        source: {
          ...observation.source,
          headSha: 'b'.repeat(40),
          reportDigest: digest('x'),
        },
      },
      retainedLedger: value,
      expectedSource: expectation(value),
    });
    expect(candidateSplice.reasonCodes).toContain(
      'observation_artifact_identity_mismatch:behaviorDigest',
    );
    expect(candidateSplice.reasonCodes).toContain(
      'observation_source_identity_mismatch:reportDigest',
    );
    expect(candidateSplice.reasonCodes).toContain('observation_source_identity_mismatch:headSha');
  });

  test('rejects hidden fields and samples outside the retained observation window', () => {
    const value = ledger();
    expect(() => verifyLimitedSloSampleLedger({ ...value, hiddenGrant: true })).toThrow();
    const { ledgerDigest: _ledgerDigest, ...material } = value;
    expect(() =>
      buildLimitedSloSampleLedger({
        ...material,
        startedAt: '2026-08-01T00:01:00.000Z',
      }),
    ).toThrow('outside the observation window');
  });

  test('rejects non-monotonic admission and terminal time after recomputing valid chains', () => {
    const value = ledger();
    const { ledgerDigest: _ledgerDigest, ...material } = value;
    let previousAdmission: `sha256:${string}` | null = null;
    const admissions = value.admissions.map((admission, index) => {
      const { admissionDigest: _admissionDigest, ...admissionMaterial } = admission;
      const rebuilt = buildLimitedSloAdmission({
        ...admissionMaterial,
        previousAdmissionDigest: previousAdmission,
        admittedAt: index === 3 ? '2026-08-01T01:30:00.000Z' : admission.admittedAt,
      });
      previousAdmission = rebuilt.admissionDigest as `sha256:${string}`;
      return rebuilt;
    });
    let previousTerminal: `sha256:${string}` | null = null;
    const relinkedTerminals = value.terminalReceipts.map((terminal, index) => {
      const { terminalDigest: _terminalDigest, ...terminalMaterial } = terminal;
      const rebuilt = buildLimitedSloTerminalReceipt({
        ...terminalMaterial,
        admissionDigest: admissions[index]!.admissionDigest,
        previousTerminalDigest: previousTerminal,
      });
      previousTerminal = rebuilt.terminalDigest as `sha256:${string}`;
      return rebuilt;
    });
    expect(() =>
      buildLimitedSloSampleLedger({
        ...material,
        admissions,
        terminalReceipts: relinkedTerminals,
      }),
    ).toThrow('admission timestamps are not non-decreasing');

    previousTerminal = null;
    const terminalReceipts = value.terminalReceipts.map((terminal, index) => {
      const { terminalDigest: _terminalDigest, ...terminalMaterial } = terminal;
      const rebuilt = buildLimitedSloTerminalReceipt({
        ...terminalMaterial,
        previousTerminalDigest: previousTerminal,
        finalizedAt: index === 1 ? '2026-08-01T02:45:00.000Z' : terminal.finalizedAt,
      });
      previousTerminal = rebuilt.terminalDigest as `sha256:${string}`;
      return rebuilt;
    });
    expect(() => buildLimitedSloSampleLedger({ ...material, terminalReceipts })).toThrow(
      'terminal receipt timestamps are not non-decreasing',
    );
  });
});
