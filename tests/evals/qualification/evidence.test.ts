import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  agentQualificationEvidenceV1Schema,
  buildAgentQualificationEvidenceV1,
  buildDiagnosticCandidateArtifactClosureV1,
  buildDiagnosticExecutionV1,
  buildLiveCompatibilityObservationV1,
  buildQualificationAttemptV1,
  liveCompatibilityObservationV1Schema,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-schema-v1';
import {
  buildLiveCompatibilityNotObservedReportV1,
  buildLiveCompatibilityObservationVerifierContextV1,
  buildQualificationVerifierContextV1,
  QUALIFICATION_DERIVED_STATES_V1,
  verifyAgentQualificationEvidenceV1,
  verifyLiveCompatibilityObservationV1,
} from '../../../scripts/evals/contracts/qualification/evidence/evidence-verifier-v1';
import {
  buildEvidenceQuotaLedgerV1,
  buildEvidenceRetentionWitnessV1,
  computeEvidenceGovernanceAuthorizationDigestV1,
  EVIDENCE_GOVERNANCE_PROFILE_V1,
  evidenceGovernanceBindingV1Schema,
  evidenceGovernanceProfileV1Schema,
  isEvidenceIssueHandoffAllowedV1,
} from '../../../scripts/evals/contracts/qualification/evidence/governance-v1';
import { verifyReleaseEvidenceBundleV1 } from '../../../scripts/release/evidence-bundle';
import { releaseEvidenceV1Schema } from '../../../scripts/release/evidence-schema';
import {
  buildReleaseGatePolicyV1,
  evaluateReleaseGateV1,
} from '../../../scripts/release/gate-evaluator';

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

const COMMIT = 'a'.repeat(40);
const createdAt = '2026-08-05T00:00:00.000Z';
const candidate = buildDiagnosticCandidateArtifactClosureV1({
  schema: 'DiagnosticCandidateArtifactClosureV1',
  version: 1,
  artifacts: [
    {
      platformIdentity: 'linux-x64',
      artifact: {
        canonicalRepository: 'ferqx/kite-code',
        repositoryId: 'R_kgDOKite',
        commit: COMMIT,
        payloadSha256: digest('a'),
        canonicalManifestDigest: digest('b'),
        behaviorDigest: digest('c'),
        profileDigest: digest('d'),
        gatePolicyDigest: digest('e'),
      },
    },
    {
      platformIdentity: 'macos-arm64',
      artifact: {
        canonicalRepository: 'ferqx/kite-code',
        repositoryId: 'R_kgDOKite',
        commit: COMMIT,
        payloadSha256: digest('f'),
        canonicalManifestDigest: digest('0'),
        behaviorDigest: digest('c'),
        profileDigest: digest('d'),
        gatePolicyDigest: digest('e'),
      },
    },
  ],
});

const ephemeralProfile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local;
const dayQuotaLedger = buildEvidenceQuotaLedgerV1({
  schema: 'EvidenceQuotaLedgerV1',
  profileId: ephemeralProfile.profileId,
  profileDigest: ephemeralProfile.profileDigest,
  routePolicyDigest: digest('1'),
  period: 'day',
  periodStart: '2026-08-05',
  reservationId: 'reservation-001',
  status: 'reconciled',
  reserved: { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 },
  reconciled: { attempts: 1, tokens: 90, runWallClockSeconds: 9, costUsdMicros: 90 },
});
const monthQuotaLedger = buildEvidenceQuotaLedgerV1({
  schema: 'EvidenceQuotaLedgerV1',
  profileId: ephemeralProfile.profileId,
  profileDigest: ephemeralProfile.profileDigest,
  routePolicyDigest: digest('1'),
  period: 'month',
  periodStart: '2026-08-01',
  reservationId: 'reservation-001',
  status: 'reconciled',
  reserved: { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 },
  reconciled: { attempts: 1, tokens: 90, runWallClockSeconds: 9, costUsdMicros: 90 },
});
const retentionWitness = buildEvidenceRetentionWitnessV1({
  schema: 'EvidenceRetentionWitnessV1',
  profileId: ephemeralProfile.profileId,
  profileDigest: ephemeralProfile.profileDigest,
  retentionClass: 'ephemeral_local',
  storage: ephemeralProfile.storage,
  deleteTrigger: 'process_exit',
  observedAt: createdAt,
});
const governance = {
  retentionClass: 'ephemeral_local' as const,
  profileId: ephemeralProfile.profileId,
  profileDigest: ephemeralProfile.profileDigest,
  quotaLedgerDigests: { day: dayQuotaLedger.recordDigest, month: monthQuotaLedger.recordDigest },
  storageDeletionWitnessDigest: retentionWitness.recordDigest,
};
const execution = buildDiagnosticExecutionV1({
  executionId: 'execution-linux-001',
  platformIdentity: 'linux-x64',
  identity: {
    source: 'local_synthetic',
    fixtureId: 'sealed-fixture-v1',
    runner: 'qualification-runner-v1',
    commit: COMMIT,
    startedAt: createdAt,
    endedAt: '2026-08-05T00:00:01.000Z',
  },
});
const scope = {
  platformIdentity: 'linux-x64',
  releaseProfileDigest: digest('d'),
  entrypoint: 'runtime' as const,
  testPolicyDigest: digest('1'),
  routePolicyDigest: digest('1'),
};
const identity = {
  matrixDigest: digest('2'),
  suiteDigest: digest('3'),
  oracleDigest: digest('4'),
  corpusDigest: digest('5'),
  evaluatorDigest: digest('6'),
  verifierDigest: digest('7'),
  runnerDigest: digest('8'),
};
const liveCandidate = buildDiagnosticCandidateArtifactClosureV1({
  schema: 'DiagnosticCandidateArtifactClosureV1',
  version: 1,
  artifacts: [
    {
      platformIdentity: 'linux-x64',
      artifact: {
        canonicalRepository: 'ferqx/kite-code',
        repositoryId: 'R_kgDOKite',
        commit: COMMIT,
        payloadSha256: identity.runnerDigest,
        canonicalManifestDigest: identity.corpusDigest,
        behaviorDigest: identity.matrixDigest,
        profileDigest: scope.releaseProfileDigest,
        gatePolicyDigest: scope.routePolicyDigest,
      },
    },
  ],
});
const suite = {
  suiteId: 'source-owned-surface-contract-v1',
  suiteDigest: identity.suiteDigest,
  role: 'structural_inventory' as const,
};

function attempt(overrides: Record<string, unknown> = {}) {
  return buildQualificationAttemptV1({
    attemptId: 'attempt-001',
    featureId: 'RUNTIME-CORE-001',
    assertionId: 'source-surface:runtime-core',
    layer: 'contract',
    status: 'passed',
    executionId: execution.executionId,
    candidateArtifact: candidate.artifacts[0]!,
    scope,
    identity,
    ...overrides,
  } as Parameters<typeof buildQualificationAttemptV1>[0]);
}

function evidence(overrides: Record<string, unknown> = {}) {
  return buildAgentQualificationEvidenceV1({
    schema: 'AgentQualificationEvidenceV1',
    version: 1,
    authority: 'diagnostic',
    evidenceEligible: false,
    createdAt,
    candidate,
    governance,
    suite,
    executions: [execution],
    attempts: [attempt()],
    ...overrides,
  } as Parameters<typeof buildAgentQualificationEvidenceV1>[0]);
}

function context(overrides: Record<string, unknown> = {}) {
  return buildQualificationVerifierContextV1({
    schema: 'QualificationVerifierContextV1',
    version: 1,
    candidate,
    governance,
    executions: [execution],
    suite,
    governanceWitnesses: {
      dayQuotaLedger,
      monthQuotaLedger,
      retention: retentionWitness,
    },
    requirements: [
      {
        requirementId: 'requirement-001',
        featureId: 'RUNTIME-CORE-001',
        assertionId: 'source-surface:runtime-core',
        layer: 'contract',
        scope,
        identity,
        expectedDisposition: 'behavioral_required',
      },
    ],
    ...overrides,
  } as Parameters<typeof buildQualificationVerifierContextV1>[0]);
}

function liveContext(
  observation: ReturnType<typeof buildLiveCompatibilityObservationV1>,
  overrides: Record<string, unknown> = {},
) {
  return buildLiveCompatibilityObservationVerifierContextV1({
    schema: 'LiveCompatibilityObservationVerifierContextV1',
    version: 1,
    candidate: observation.candidate,
    governance: observation.governance,
    execution: observation.execution,
    scope: observation.scope,
    identity: observation.identity,
    governanceWitnesses: {
      dayQuotaLedger,
      monthQuotaLedger,
      retention: retentionWitness,
    },
    ...overrides,
  } as Parameters<typeof buildLiveCompatibilityObservationVerifierContextV1>[0]);
}

describe('AgentQualificationEvidenceV1', () => {
  test('allows per-platform payload and manifest digests while binding common lineage', () => {
    expect(candidate.artifacts[0]?.artifact.payloadSha256).not.toBe(
      candidate.artifacts[1]?.artifact.payloadSha256,
    );
    expect(candidate.artifacts[0]?.artifact.canonicalManifestDigest).not.toBe(
      candidate.artifacts[1]?.artifact.canonicalManifestDigest,
    );
    expect(candidate.closureDigest).toMatch(/^sha256:/);
  });

  test('rejects closure duplicate, ordering, and common-lineage splices', () => {
    expect(() =>
      buildDiagnosticCandidateArtifactClosureV1({
        schema: 'DiagnosticCandidateArtifactClosureV1',
        version: 1,
        artifacts: [candidate.artifacts[1]!, candidate.artifacts[0]!],
      }),
    ).toThrow();
    expect(() =>
      buildDiagnosticCandidateArtifactClosureV1({
        schema: 'DiagnosticCandidateArtifactClosureV1',
        version: 1,
        artifacts: [
          {
            ...candidate.artifacts[0]!,
            artifact: {
              ...candidate.artifacts[0]!.artifact,
              canonicalRepository: 'credential-sentinel',
              repositoryId: 'prompt-content',
            },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      buildDiagnosticCandidateArtifactClosureV1({
        schema: 'DiagnosticCandidateArtifactClosureV1',
        version: 1,
        artifacts: [
          candidate.artifacts[0]!,
          { ...candidate.artifacts[1]!, platformIdentity: 'linux-x64' },
        ],
      }),
    ).toThrow();
    expect(() =>
      buildDiagnosticCandidateArtifactClosureV1({
        schema: 'DiagnosticCandidateArtifactClosureV1',
        version: 1,
        artifacts: [
          candidate.artifacts[0]!,
          {
            ...candidate.artifacts[1]!,
            artifact: { ...candidate.artifacts[1]!.artifact, behaviorDigest: digest('9') },
          },
        ],
      }),
    ).toThrow();
  });

  test('binds every attempt to its exact closure platform, execution, and profile', () => {
    const swapped = attempt({
      candidateArtifact: candidate.artifacts[1],
      scope: { ...scope, platformIdentity: 'macos-arm64' },
    });
    expect(() => evidence({ attempts: [swapped] })).toThrow();
    expect(() =>
      evidence({
        executions: [],
        attempts: [attempt()],
      }),
    ).toThrow();
    expect(() => evidence({ attempts: [] })).toThrow();
    expect(() =>
      evidence({
        executions: [execution, execution],
        attempts: [attempt()],
      }),
    ).toThrow();
    expect(() =>
      evidence({
        executions: [{ ...execution, executionId: 'execution-linux-002' }],
        attempts: [attempt()],
      }),
    ).toThrow();
  });

  test('binds aggregate executions to the trusted context and blocks extra attempts', () => {
    const { executionDigest: _executionDigest, ...executionMaterial } = execution;
    const replacementExecution = buildDiagnosticExecutionV1({
      ...executionMaterial,
      executionId: 'execution-linux-002',
    });
    const replacementEvidence = evidence({
      executions: [replacementExecution],
      attempts: [attempt({ executionId: replacementExecution.executionId })],
    });
    expect(verifyAgentQualificationEvidenceV1(replacementEvidence, context()).results[0]).toEqual(
      expect.objectContaining({ status: 'blocked', reasonCode: 'identity_drift' }),
    );

    const extraAttempt = attempt({
      attemptId: 'attempt-002',
      assertionId: 'source-surface:unregistered',
    });
    const { recordDigest: _dayRecordDigest, ...twoAttemptDayMaterial } = dayQuotaLedger;
    const { recordDigest: _monthRecordDigest, ...twoAttemptMonthMaterial } = monthQuotaLedger;
    const twoAttempts = {
      attempts: 2,
      tokens: 180,
      runWallClockSeconds: 18,
      costUsdMicros: 180,
    };
    const twoAttemptDayLedger = buildEvidenceQuotaLedgerV1({
      ...twoAttemptDayMaterial,
      reserved: { attempts: 2, tokens: 200, runWallClockSeconds: 20, costUsdMicros: 200 },
      reconciled: twoAttempts,
    });
    const twoAttemptMonthLedger = buildEvidenceQuotaLedgerV1({
      ...twoAttemptMonthMaterial,
      reserved: { attempts: 2, tokens: 200, runWallClockSeconds: 20, costUsdMicros: 200 },
      reconciled: twoAttempts,
    });
    const twoAttemptGovernance = {
      ...governance,
      quotaLedgerDigests: {
        day: twoAttemptDayLedger.recordDigest,
        month: twoAttemptMonthLedger.recordDigest,
      },
    };
    expect(
      verifyAgentQualificationEvidenceV1(
        evidence({ governance: twoAttemptGovernance, attempts: [attempt(), extraAttempt] }),
        context({
          governance: twoAttemptGovernance,
          governanceWitnesses: {
            dayQuotaLedger: twoAttemptDayLedger,
            monthQuotaLedger: twoAttemptMonthLedger,
            retention: retentionWitness,
          },
        }),
      ).results[0],
    ).toEqual(expect.objectContaining({ status: 'blocked', reasonCode: 'identity_drift' }));
  });

  test('rejects unsafe execution metadata and reverse timestamps', () => {
    expect(() =>
      buildDiagnosticExecutionV1({
        ...execution,
        executionId: 'unsafe-execution',
        identity: {
          source: 'local_synthetic',
          fixtureId: '/workspace/secret',
          runner: 'qualification-runner-v1',
          commit: COMMIT,
          startedAt: createdAt,
          endedAt: '2026-08-05T00:00:01.000Z',
        },
      }),
    ).toThrow();
    expect(() =>
      buildQualificationAttemptV1({
        ...attempt(),
        attemptId: 'C:/Users/unsafe-attempt',
      }),
    ).toThrow('diagnostic identifier');
    expect(() =>
      buildQualificationAttemptV1({
        ...attempt(),
        assertionId: 'https://provider.invalid/full-assertion',
      }),
    ).toThrow('diagnostic assertion identifier');
    expect(() =>
      buildDiagnosticExecutionV1({
        ...execution,
        executionId: 'content-sentinel-execution',
        identity: {
          source: 'local_synthetic',
          fixtureId: 'credential-sentinel',
          runner: 'prompt-content',
          commit: COMMIT,
          startedAt: createdAt,
          endedAt: '2026-08-05T00:00:01.000Z',
        },
      }),
    ).toThrow();
    expect(() =>
      buildDiagnosticExecutionV1({
        ...execution,
        executionId: 'reverse-execution',
        identity: {
          ...execution.identity,
          startedAt: '2026-08-05T00:00:02.000Z',
          endedAt: '2026-08-05T00:00:01.000Z',
        },
      }),
    ).toThrow();
  });

  test('parses a specialized GitHub diagnostic execution but keeps the generic verifier fail-closed', () => {
    const githubExecution = buildDiagnosticExecutionV1({
      executionId: 'l2-native-execution-linux-001',
      platformIdentity: 'linux-x64',
      identity: {
        source: 'github_actions',
        canonicalRepository: 'ferqx/kite-code',
        repositoryId: 'R_kgDOKite',
        workflowPath: '.github/workflows/native-conformance-qualification.yml',
        workflowRef:
          'ferqx/kite-code/.github/workflows/native-conformance-qualification.yml@refs/heads/main',
        workflowSha: 'b'.repeat(40),
        oidcIssuer: 'https://token.actions.githubusercontent.com',
        ref: 'refs/heads/main',
        runId: '123',
        runAttempt: 1,
        job: 'native-linux',
        commit: COMMIT,
        startedAt: createdAt,
        endedAt: '2026-08-05T00:00:01.000Z',
      },
    });
    const githubEvidence = evidence({
      executions: [githubExecution],
      attempts: [attempt({ executionId: githubExecution.executionId })],
    });
    expect(
      verifyAgentQualificationEvidenceV1(githubEvidence, context({ executions: [githubExecution] }))
        .results[0],
    ).toEqual(
      expect.objectContaining({ status: 'blocked', reasonCode: 'execution_identity_untrusted' }),
    );
  });

  test('keeps the current structural suite blocked even for a fully valid green record', () => {
    const report = verifyAgentQualificationEvidenceV1(
      evidence(),
      context(),
      new Date('2026-08-05T01:00:00Z'),
    );
    expect(report.authority).toBe('diagnostic');
    expect(report.evidenceEligible).toBeFalse();
    expect(report.results).toEqual([
      expect.objectContaining({
        status: 'blocked',
        reasonCode: 'behavioral_evidence_not_registered',
      }),
    ]);
  });

  test('does not derive any positive state without a source-owned behavioral suite registration', () => {
    expect(() => context({ suite: { ...suite, role: 'behavioral' } })).toThrow();
    expect(() => context({ requirements: [] })).toThrow();
    expect(() => context({ executions: [execution, execution] })).toThrow();
    expect(QUALIFICATION_DERIVED_STATES_V1).toEqual([
      'qualified',
      'verified_disabled',
      'unsupported',
      'blocked',
      'failed',
    ]);
  });

  test('derives failed and registered unsupported semantics without treating them as a pass', () => {
    const failed = evidence({
      attempts: [attempt({ status: 'failed', reasonCode: 'assertion_failed' })],
    });
    expect(verifyAgentQualificationEvidenceV1(failed, context()).results[0]).toEqual(
      expect.objectContaining({ status: 'failed', reasonCode: 'assertion_failed' }),
    );
    const unsupportedContext = context({
      requirements: [
        {
          requirementId: 'requirement-001',
          featureId: 'RUNTIME-CORE-001',
          assertionId: 'source-surface:runtime-core',
          layer: 'contract',
          scope,
          identity,
          expectedDisposition: 'unsupported',
        },
      ],
    });
    const unsupported = evidence({
      attempts: [
        attempt({
          status: 'not_applicable',
          reasonCode: 'not_applicable_source_not_supported',
        }),
      ],
    });
    expect(verifyAgentQualificationEvidenceV1(unsupported, unsupportedContext).results[0]).toEqual(
      expect.objectContaining({
        status: 'unsupported',
        reasonCode: 'not_applicable_source_not_supported',
      }),
    );
  });

  test('fails closed on matrix, suite, oracle, corpus, evaluator, verifier, runner, policy, and route drift', () => {
    const fields = [
      'matrixDigest',
      'suiteDigest',
      'oracleDigest',
      'corpusDigest',
      'evaluatorDigest',
      'verifierDigest',
      'runnerDigest',
    ] as const;
    for (const field of fields) {
      const drifted = evidence({
        attempts: [attempt({ identity: { ...identity, [field]: digest('9') } })],
      });
      expect(verifyAgentQualificationEvidenceV1(drifted, context()).results[0]).toEqual(
        expect.objectContaining({ status: 'blocked', reasonCode: 'identity_drift' }),
      );
    }
    const route = {
      routeAlias: 'qwen',
      model: 'qwen3.6-flash',
      protocolFamily: 'openai_compatible' as const,
      routeIdentityDigest: digest('a'),
      providerDataPolicyDigest: digest('b'),
      promptEnvironmentDigest: digest('c'),
      toolCatalogDigest: digest('d'),
      capabilityDeclarationDigest: digest('e'),
    };
    const routeScope = { ...scope, route };
    const routeContext = context({
      requirements: [
        {
          requirementId: 'requirement-001',
          featureId: 'RUNTIME-CORE-001',
          assertionId: 'source-surface:runtime-core',
          layer: 'contract',
          scope: routeScope,
          identity,
          expectedDisposition: 'behavioral_required',
        },
      ],
    });
    for (const field of [
      'model',
      'routeIdentityDigest',
      'providerDataPolicyDigest',
      'promptEnvironmentDigest',
      'toolCatalogDigest',
    ] as const) {
      const driftedScope = {
        ...routeScope,
        route: { ...route, [field]: field === 'model' ? 'other-model' : digest('9') },
      };
      const drifted = evidence({ attempts: [attempt({ scope: driftedScope })] });
      expect(verifyAgentQualificationEvidenceV1(drifted, routeContext).results[0]).toEqual(
        expect.objectContaining({ status: 'blocked', reasonCode: 'identity_drift' }),
      );
    }
  });

  test('rejects malformed governance, retention availability, and private profile selection', () => {
    expect(EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.retention).toEqual({
      // Normal cleanup remains process-exit immediate; this is the accepted
      // crash-recovery upper bound, not retained diagnostic evidence.
      maxAgeSeconds: 86_400,
      deleteTrigger: 'process_exit',
    });
    expect(isEvidenceIssueHandoffAllowedV1({ actorIdentity: 'github:@ferqx' })).toBeFalse();
    expect(
      evidenceGovernanceBindingV1Schema.safeParse({ ...governance, profileDigest: digest('9') })
        .success,
    ).toBeFalse();
    expect(
      evidenceGovernanceProfileV1Schema.safeParse({
        ...EVIDENCE_GOVERNANCE_PROFILE_V1,
        profiles: {
          ...EVIDENCE_GOVERNANCE_PROFILE_V1.profiles,
          ephemeral_local: {
            ...EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local,
            allowedDataCategories: [
              ...EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.ephemeral_local.allowedDataCategories,
            ].reverse(),
          },
        },
      }).success,
    ).toBeFalse();
    const { quotaLedgerDigests: _quotaLedgerDigests, ...unavailableGovernance } = governance;
    expect(() => evidence({ governance: unavailableGovernance })).toThrow();
    expect(() =>
      buildEvidenceQuotaLedgerV1({
        schema: 'EvidenceQuotaLedgerV1',
        profileId: ephemeralProfile.profileId,
        profileDigest: ephemeralProfile.profileDigest,
        routePolicyDigest: digest('1'),
        period: 'day',
        periodStart: '2026-08-05',
        reservationId: 'https://provider.invalid/full-endpoint',
        status: 'reserved',
        reserved: { attempts: 1, tokens: 1, runWallClockSeconds: 1, costUsdMicros: 1 },
      }),
    ).toThrow('governance metadata identifier');
    expect(() =>
      buildEvidenceQuotaLedgerV1({
        schema: 'EvidenceQuotaLedgerV1',
        profileId: ephemeralProfile.profileId,
        profileDigest: ephemeralProfile.profileDigest,
        routePolicyDigest: digest('1'),
        period: 'day',
        periodStart: '2026-08-05',
        reservationId: 'C:/Users/qualification',
        status: 'reserved',
        reserved: { attempts: 1, tokens: 1, runWallClockSeconds: 1, costUsdMicros: 1 },
      }),
    ).toThrow('governance metadata identifier');
    expect(() =>
      computeEvidenceGovernanceAuthorizationDigestV1({
        schema: 'EvidenceGovernanceAuthorizationV1',
        profileId: ephemeralProfile.profileId,
        profileDigest: ephemeralProfile.profileDigest,
        routePolicyDigest: digest('1'),
        actorIdentity: '/workspace/maintainer',
        purpose: 'metadata_only_issue_handoff',
        sanitizedSummaryDigest: digest('2'),
        issuedAt: createdAt,
        expiresAt: '2026-08-05T00:01:00.000Z',
      }),
    ).toThrow('governance metadata identifier');
    expect(() =>
      computeEvidenceGovernanceAuthorizationDigestV1({
        schema: 'EvidenceGovernanceAuthorizationV1',
        profileId: ephemeralProfile.profileId,
        profileDigest: ephemeralProfile.profileDigest,
        routePolicyDigest: digest('1'),
        actorIdentity: 'https:/provider.invalid/normalized-uri',
        purpose: 'metadata_only_issue_handoff',
        sanitizedSummaryDigest: digest('2'),
        issuedAt: createdAt,
        expiresAt: '2026-08-05T00:01:00.000Z',
      }),
    ).toThrow('governance metadata identifier');
  });

  test('requires one current UTC reservation across the day and month ledger buckets', () => {
    const { recordDigest: _monthRecordDigest, ...monthMaterial } = monthQuotaLedger;
    const mismatchedReservation = buildEvidenceQuotaLedgerV1({
      ...monthMaterial,
      reservationId: 'reservation-002',
    });
    const reservationGovernance = {
      ...governance,
      quotaLedgerDigests: {
        ...governance.quotaLedgerDigests,
        month: mismatchedReservation.recordDigest,
      },
    };
    expect(
      verifyAgentQualificationEvidenceV1(
        evidence({ governance: reservationGovernance }),
        context({
          governance: reservationGovernance,
          governanceWitnesses: {
            dayQuotaLedger,
            monthQuotaLedger: mismatchedReservation,
            retention: retentionWitness,
          },
        }),
      ).results[0],
    ).toEqual(expect.objectContaining({ status: 'blocked', reasonCode: 'retention_unavailable' }));

    const { recordDigest: _dayRecordDigest, ...dayMaterial } = dayQuotaLedger;
    const staleDay = buildEvidenceQuotaLedgerV1({
      ...dayMaterial,
      periodStart: '2026-08-04',
    });
    const staleGovernance = {
      ...governance,
      quotaLedgerDigests: {
        ...governance.quotaLedgerDigests,
        day: staleDay.recordDigest,
      },
    };
    expect(
      verifyAgentQualificationEvidenceV1(
        evidence({ governance: staleGovernance }),
        context({
          governance: staleGovernance,
          governanceWitnesses: {
            dayQuotaLedger: staleDay,
            monthQuotaLedger,
            retention: retentionWitness,
          },
        }),
      ).results[0],
    ).toEqual(expect.objectContaining({ status: 'blocked', reasonCode: 'retention_unavailable' }));
  });

  test('binds protected retention expiry and retained artifact without permitting replacement', () => {
    const profile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.protected_ci_retained;
    const expiresAt = '2026-08-10T00:00:00.000Z';
    const protectedDayLedger = buildEvidenceQuotaLedgerV1({
      schema: 'EvidenceQuotaLedgerV1',
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      routePolicyDigest: digest('1'),
      period: 'day',
      periodStart: '2026-08-05',
      reservationId: 'protected-reservation-001',
      status: 'reconciled',
      reserved: { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 },
      reconciled: { attempts: 1, tokens: 90, runWallClockSeconds: 9, costUsdMicros: 90 },
    });
    const protectedMonthLedger = buildEvidenceQuotaLedgerV1({
      schema: 'EvidenceQuotaLedgerV1',
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      routePolicyDigest: digest('1'),
      period: 'month',
      periodStart: '2026-08-01',
      reservationId: 'protected-reservation-001',
      status: 'reconciled',
      reserved: { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 },
      reconciled: { attempts: 1, tokens: 90, runWallClockSeconds: 9, costUsdMicros: 90 },
    });
    const protectedWitness = buildEvidenceRetentionWitnessV1({
      schema: 'EvidenceRetentionWitnessV1',
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      retentionClass: 'protected_ci_retained',
      storage: profile.storage,
      deleteTrigger: 'artifact_expiry',
      observedAt: createdAt,
      expiresAt,
      retainedArtifactDigest: digest('b'),
    });
    const protectedGovernance = {
      retentionClass: 'protected_ci_retained' as const,
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      expiresAt,
      retainedArtifactDigest: digest('b'),
      quotaLedgerDigests: {
        day: protectedDayLedger.recordDigest,
        month: protectedMonthLedger.recordDigest,
      },
      storageDeletionWitnessDigest: protectedWitness.recordDigest,
    };
    const protectedContext = context({
      governance: protectedGovernance,
      governanceWitnesses: {
        dayQuotaLedger: protectedDayLedger,
        monthQuotaLedger: protectedMonthLedger,
        retention: protectedWitness,
      },
    });
    const replacement = evidence({
      governance: { ...protectedGovernance, retainedArtifactDigest: digest('9') },
    });
    expect(verifyAgentQualificationEvidenceV1(replacement, protectedContext).results[0]).toEqual(
      expect.objectContaining({ status: 'blocked', reasonCode: 'identity_drift' }),
    );

    const expiredAt = '2026-08-05T00:00:30.000Z';
    const expiredWitness = buildEvidenceRetentionWitnessV1({
      schema: 'EvidenceRetentionWitnessV1',
      profileId: profile.profileId,
      profileDigest: profile.profileDigest,
      retentionClass: 'protected_ci_retained',
      storage: profile.storage,
      deleteTrigger: 'artifact_expiry',
      observedAt: createdAt,
      expiresAt: expiredAt,
      retainedArtifactDigest: digest('b'),
    });
    const expiredGovernance = {
      ...protectedGovernance,
      expiresAt: expiredAt,
      storageDeletionWitnessDigest: expiredWitness.recordDigest,
    };
    const expiredContext = context({
      governance: expiredGovernance,
      governanceWitnesses: {
        dayQuotaLedger: protectedDayLedger,
        monthQuotaLedger: protectedMonthLedger,
        retention: expiredWitness,
      },
    });
    const expired = evidence({ governance: expiredGovernance });
    expect(
      verifyAgentQualificationEvidenceV1(expired, expiredContext, new Date('2026-08-05T01:00:00Z'))
        .results[0],
    ).toEqual(expect.objectContaining({ status: 'blocked', reasonCode: 'retention_unavailable' }));

    const privateProfile = EVIDENCE_GOVERNANCE_PROFILE_V1.profiles.private_reserve;
    const privateExpiry = '2026-08-20T00:00:00.000Z';
    const privateDayLedger = buildEvidenceQuotaLedgerV1({
      schema: 'EvidenceQuotaLedgerV1',
      profileId: privateProfile.profileId,
      profileDigest: privateProfile.profileDigest,
      routePolicyDigest: digest('1'),
      period: 'day',
      periodStart: '2026-08-05',
      reservationId: 'private-reservation-001',
      status: 'reconciled',
      reserved: { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 },
      reconciled: { attempts: 1, tokens: 90, runWallClockSeconds: 9, costUsdMicros: 90 },
    });
    const privateMonthLedger = buildEvidenceQuotaLedgerV1({
      schema: 'EvidenceQuotaLedgerV1',
      profileId: privateProfile.profileId,
      profileDigest: privateProfile.profileDigest,
      routePolicyDigest: digest('1'),
      period: 'month',
      periodStart: '2026-08-01',
      reservationId: 'private-reservation-001',
      status: 'reconciled',
      reserved: { attempts: 1, tokens: 100, runWallClockSeconds: 10, costUsdMicros: 100 },
      reconciled: { attempts: 1, tokens: 90, runWallClockSeconds: 9, costUsdMicros: 90 },
    });
    const privateWitness = buildEvidenceRetentionWitnessV1({
      schema: 'EvidenceRetentionWitnessV1',
      profileId: privateProfile.profileId,
      profileDigest: privateProfile.profileDigest,
      retentionClass: 'private_reserve',
      storage: privateProfile.storage,
      deleteTrigger: 'cryptographic_purge',
      observedAt: createdAt,
      expiresAt: privateExpiry,
    });
    const privateGovernance = {
      retentionClass: 'private_reserve' as const,
      profileId: privateProfile.profileId,
      profileDigest: privateProfile.profileDigest,
      expiresAt: privateExpiry,
      quotaLedgerDigests: {
        day: privateDayLedger.recordDigest,
        month: privateMonthLedger.recordDigest,
      },
      storageDeletionWitnessDigest: privateWitness.recordDigest,
    };
    expect(evidenceGovernanceBindingV1Schema.safeParse(privateGovernance).success).toBeTrue();
    expect(
      verifyAgentQualificationEvidenceV1(
        evidence({ governance: privateGovernance }),
        context({
          governance: privateGovernance,
          governanceWitnesses: {
            dayQuotaLedger: privateDayLedger,
            monthQuotaLedger: privateMonthLedger,
            retention: privateWitness,
          },
        }),
      ).results[0],
    ).toEqual(expect.objectContaining({ status: 'blocked', reasonCode: 'retention_unavailable' }));
  });

  test('detects record/report digest tampering even when other fields stay intact', () => {
    const value = evidence();
    expect(
      agentQualificationEvidenceV1Schema.safeParse({ ...value, recordDigest: digest('9') }).success,
    ).toBeFalse();
    expect(
      agentQualificationEvidenceV1Schema.safeParse({ ...value, reportDigest: digest('9') }).success,
    ).toBeFalse();
  });

  test('binds a diagnostic candidate closure without creating aggregate or release evidence', () => {
    const observation = buildLiveCompatibilityObservationV1({
      schema: 'LiveCompatibilityObservationV1',
      version: 1,
      authority: 'diagnostic',
      evidenceEligible: false,
      observedAt: createdAt,
      candidate: liveCandidate,
      governance,
      execution,
      scope: {
        ...scope,
        route: {
          routeAlias: 'qwen',
          model: 'qwen3.6-flash',
          protocolFamily: 'openai_compatible',
          routeIdentityDigest: digest('a'),
          providerDataPolicyDigest: digest('b'),
          promptEnvironmentDigest: digest('c'),
          toolCatalogDigest: digest('d'),
          capabilityDeclarationDigest: digest('e'),
        },
      },
      identity,
      outcome: 'success',
    });
    expect(liveCompatibilityObservationV1Schema.parse(observation).candidate.closureDigest).toBe(
      liveCandidate.closureDigest,
    );
    const verifiedObservationReport = verifyLiveCompatibilityObservationV1(
      observation,
      liveContext(observation),
      new Date('2026-08-05T01:00:00Z'),
    );
    expect(verifiedObservationReport).toEqual(
      expect.objectContaining({
        status: 'observed',
        reasonCode: 'observed_success',
        authority: 'diagnostic',
        evidenceEligible: false,
        candidateClosureDigest: liveCandidate.closureDigest,
      }),
    );
    const {
      recordDigest: _recordDigest,
      reportDigest: _reportDigest,
      ...observationMaterial
    } = observation;
    const driftedObservation = buildLiveCompatibilityObservationV1({
      ...observationMaterial,
      scope: { ...observation.scope, routePolicyDigest: digest('9') },
    });
    expect(
      verifyLiveCompatibilityObservationV1(
        driftedObservation,
        liveContext(observation),
        new Date('2026-08-05T01:00:00Z'),
      ),
    ).toEqual(expect.objectContaining({ status: 'blocked', reasonCode: 'identity_drift' }));
    const alternateLiveCandidate = buildDiagnosticCandidateArtifactClosureV1({
      schema: 'DiagnosticCandidateArtifactClosureV1',
      version: 1,
      artifacts: [
        {
          ...liveCandidate.artifacts[0]!,
          artifact: {
            ...liveCandidate.artifacts[0]!.artifact,
            canonicalManifestDigest: digest('f'),
          },
        },
      ],
    });
    const candidateDriftedObservation = buildLiveCompatibilityObservationV1({
      ...observationMaterial,
      candidate: alternateLiveCandidate,
    });
    expect(candidateDriftedObservation.recordDigest).not.toBe(observation.recordDigest);
    expect(candidateDriftedObservation.reportDigest).not.toBe(observation.reportDigest);
    const alternateCandidateReport = verifyLiveCompatibilityObservationV1(
      candidateDriftedObservation,
      liveContext(candidateDriftedObservation),
      new Date('2026-08-05T01:00:00Z'),
    );
    expect(alternateCandidateReport).toEqual(
      expect.objectContaining({
        status: 'observed',
        candidateClosureDigest: alternateLiveCandidate.closureDigest,
      }),
    );
    expect(alternateCandidateReport.reportDigest).not.toBe(verifiedObservationReport.reportDigest);
    expect(
      verifyLiveCompatibilityObservationV1(
        candidateDriftedObservation,
        liveContext(observation),
        new Date('2026-08-05T01:00:00Z'),
      ),
    ).toEqual(expect.objectContaining({ status: 'blocked', reasonCode: 'identity_drift' }));
    expect(
      liveCompatibilityObservationV1Schema.safeParse({
        ...observation,
        candidate: undefined,
      }).success,
    ).toBeFalse();
    expect(verifyAgentQualificationEvidenceV1(observation, context()).results[0]).toEqual(
      expect.objectContaining({ status: 'blocked', reasonCode: 'input_invalid' }),
    );
    expect(buildLiveCompatibilityNotObservedReportV1(liveContext(observation))).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reasonCode: 'not_observed',
        verifierContextDigest: liveContext(observation).contextDigest,
      }),
    );
    expect(releaseEvidenceV1Schema.safeParse(evidence()).success).toBeFalse();
    expect(releaseEvidenceV1Schema.safeParse(observation).success).toBeFalse();
    expect(() => verifyReleaseEvidenceBundleV1(evidence())).toThrow();
    const policy = buildReleaseGatePolicyV1({
      schema: 'ReleaseGatePolicyV1',
      policyId: 'diagnostic-rejection-test-v1',
      mode: 'synthetic_foundation',
      canonicalRepository: candidate.artifacts[0]!.artifact.canonicalRepository,
      repositoryId: candidate.artifacts[0]!.artifact.repositoryId,
      releaseWorkflowPath: '.github/workflows/release-candidate.yml',
      releaseWorkflowSha: COMMIT,
      oidcIssuer: 'https://token.actions.githubusercontent.com',
      allowedRefPrefixes: ['refs/tags/v'],
      capabilities: [],
      requirements: [],
    });
    expect(() =>
      evaluateReleaseGateV1({
        policy,
        evidence: evidence(),
        artifactIdentity: {
          ...candidate.artifacts[0]!.artifact,
          gatePolicyDigest: policy.policyDigest,
        },
        evaluatedAt: createdAt,
      }),
    ).toThrow();

    const { quotaLedgerDigests: _quotaLedgerDigests, ...missingLedgerGovernance } = governance;
    expect(() =>
      buildLiveCompatibilityObservationV1({
        schema: 'LiveCompatibilityObservationV1',
        version: 1,
        authority: 'diagnostic',
        evidenceEligible: false,
        observedAt: createdAt,
        candidate: liveCandidate,
        governance: missingLedgerGovernance,
        execution,
        scope: {
          ...scope,
          route: {
            routeAlias: 'qwen',
            model: 'qwen3.6-flash',
            protocolFamily: 'openai_compatible',
            routeIdentityDigest: digest('a'),
            providerDataPolicyDigest: digest('b'),
            promptEnvironmentDigest: digest('c'),
            toolCatalogDigest: digest('d'),
            capabilityDeclarationDigest: digest('e'),
          },
        },
        identity,
        outcome: 'success',
      }),
    ).toThrow();
  });

  test('keeps the diagnostic implementation outside release evidence and gate import paths', () => {
    const sources = [
      'scripts/evals/contracts/qualification/evidence/evidence-schema-v1.ts',
      'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts',
      'scripts/evals/contracts/qualification/evidence/governance-v1.ts',
      'scripts/evals/contracts/qualification/l0-contract-schema-v1.ts',
      'scripts/evals/contracts/qualification/l0-contract-evaluator-v1.ts',
      'scripts/evals/contracts/qualification/l0-contract-adapter-v1.ts',
      'release/qualification/evidence/source-owned-verifier-v1.ts',
      'release/qualification/sentinel-journey-map-v1.ts',
    ].map((path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'));
    for (const source of sources) {
      expect(source).not.toContain('ReleaseEvidenceV1');
      expect(source).not.toContain('releaseEvidenceV1Schema');
      expect(source).not.toContain('RELEASE_GATES');
      expect(source).not.toMatch(/(?:gate-evaluator|gate-replay|evidence-bundle|foundation-gate)/);
    }
  });
});
