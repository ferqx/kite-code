import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  createAgentTaskContractConformanceInputV1,
  produceUnsignedAgentTaskEvidenceV1,
} from '../../../scripts/evals/agent-task-evidence-producer';
import { verifyFormalAgentTaskEvidenceV1 } from '../../../scripts/evals/verify-agent-task-evidence';
import type { AgentTaskEvidenceSourceV1 } from './authenticated-evidence';

const HEAD_SHA = 'a'.repeat(40);

describe('formal Agent task evidence producer and independent verifier', () => {
  test.each([
    ['pinned_route_or_baseline_change', 8, 96],
    ['release_candidate', 20, 240],
  ] as const)('retains and rebuilds the complete %s contract', (stage, attemptsPerCase, total) => {
    const retained = createAgentTaskContractConformanceInputV1({
      repository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      headSha: HEAD_SHA,
      stage,
      startedAt: '2026-08-02T00:00:00.000Z',
    });
    const source = sourceFor(retained.startedAt, retained.endedAt);
    const evidence = produceUnsignedAgentTaskEvidenceV1({
      retainedInput: retained,
      source: withoutWindow(source),
      signedAt: after(retained.endedAt),
    });
    const report = verifyFormalAgentTaskEvidenceV1({ evidence, expectedSource: source });

    expect(evidence.executionClass).toBe('contract_conformance');
    expect(evidence.signature).toEqual({
      kind: 'unconfigured',
      algorithm: 'none',
      reason: 'production_sigstore_unconfigured',
    });
    expect(evidence.caseLedgers).toHaveLength(12);
    expect(evidence.caseLedgers.every((ledger) => ledger.attempts.length === attemptsPerCase)).toBe(
      true,
    );
    expect(evidence.adversarial.receipts).toHaveLength(21);
    expect(report).toMatchObject({
      status: 'blocked',
      evidenceEligible: false,
      sourceIdentityVerified: true,
      retainedArtifactIdentity: {
        artifactId: '9000000001',
        artifactName: 'agent-task-retained-input-30750000001',
      },
      verification: {
        status: 'blocked',
        evidenceEligible: false,
        attemptsPerCase,
        verifiedCaseCount: 12,
        verifiedAttemptCount: total,
        signatureVerified: false,
        formalAdversarialPassed: true,
        d07PolicyPassed: true,
      },
    });
    expect(report.verification.reasonCodes).toEqual([
      'contract_conformance_not_production',
      'production_route_unconfigured',
      'production_sigstore_verifier_unconfigured',
      'unsigned_formal_bundle_not_production',
    ]);
  });

  test('does not trust artifact-reported GitHub or retained artifact identity', () => {
    const retained = createAgentTaskContractConformanceInputV1({
      repository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      headSha: HEAD_SHA,
      stage: 'pinned_route_or_baseline_change',
      startedAt: '2026-08-02T00:00:00.000Z',
    });
    const source = sourceFor(retained.startedAt, retained.endedAt);
    const evidence = produceUnsignedAgentTaskEvidenceV1({
      retainedInput: retained,
      source: withoutWindow(source),
      signedAt: after(retained.endedAt),
    });

    expect(() =>
      verifyFormalAgentTaskEvidenceV1({
        evidence,
        expectedSource: { ...source, artifactId: '9000000002' },
      }),
    ).toThrow('does not match independent expectations');
    expect(() =>
      verifyFormalAgentTaskEvidenceV1({
        evidence,
        expectedSource: { ...source, workflowSha: 'b'.repeat(40) },
      }),
    ).toThrow('does not match independent expectations');
  });

  test('rejects retained data that tries to turn a failed run into a passing contract', () => {
    const retained = createAgentTaskContractConformanceInputV1({
      repository: 'ferqx/kite-code',
      repositoryId: 'R_kgDOSKbi8g',
      headSha: HEAD_SHA,
      stage: 'pinned_route_or_baseline_change',
      startedAt: '2026-08-02T00:00:00.000Z',
    });
    const attempt = retained.caseLedgers[0]?.attempts[0];
    if (!attempt) throw new Error('contract fixture is incomplete');
    attempt.checksPassed = false;
    const source = sourceFor(retained.startedAt, retained.endedAt);
    expect(() =>
      produceUnsignedAgentTaskEvidenceV1({
        retainedInput: retained,
        source: withoutWindow(source),
        signedAt: after(retained.endedAt),
      }),
    ).toThrow('passed retained attempt requires checks');
  });

  test('keeps the workflow manual, read-only, unsigned, and independently identity-bound', () => {
    const workflow = readFileSync('.github/workflows/agent-task-evidence.yml', 'utf8');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/\n\s+(push|pull_request|schedule):/);
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toContain('id-token: write');
    expect(workflow).not.toContain('packages: write');
    expect(workflow).not.toContain('releases: write');
    expect(workflow).toContain('--expected-repository-id=');
    expect(workflow).toContain('--expected-workflow-sha=');
    expect(workflow).toContain('--expected-artifact-id=');
    expect(workflow).toContain('--require-blocked=true');
  });
});

function sourceFor(startedAt: string, endedAt: string): AgentTaskEvidenceSourceV1 {
  return {
    schema: 'AgentTaskEvidenceSourceV1',
    repository: 'ferqx/kite-code',
    repositoryId: 'R_kgDOSKbi8g',
    headSha: HEAD_SHA,
    ref: 'refs/heads/main',
    workflowPath: '.github/workflows/agent-task-evidence.yml',
    workflowRef: 'ferqx/kite-code/.github/workflows/agent-task-evidence.yml@refs/heads/main',
    workflowSha: HEAD_SHA,
    runId: '30750000001',
    runAttempt: 1,
    job: 'agent-task-evidence-contract',
    artifactId: '9000000001',
    artifactName: 'agent-task-retained-input-30750000001',
    startedAt,
    endedAt,
  };
}

function withoutWindow(
  source: AgentTaskEvidenceSourceV1,
): Omit<AgentTaskEvidenceSourceV1, 'startedAt' | 'endedAt'> {
  const { startedAt: _startedAt, endedAt: _endedAt, ...identity } = source;
  return identity;
}

function after(timestamp: string): string {
  return new Date(Date.parse(timestamp) + 1).toISOString();
}
