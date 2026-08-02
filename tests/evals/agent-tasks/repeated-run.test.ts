import { describe, expect, test } from 'bun:test';
import { sha256Digest } from '../../../scripts/release/canonical-json';
import {
  type AgentTaskAttemptV1,
  buildRepeatedRunReport,
  RepeatedRunLedgerV1,
  runSyntheticRepeatedEvaluation,
  type SyntheticRepeatedRunConfigV1,
  verifySyntheticRepeatedRunReport,
} from './repeated-runner';

describe('repeated Agent task runner and report', () => {
  test('retains every attempt and reports distribution without claiming evidence eligibility', async () => {
    const config = syntheticConfig(4);
    const report = await runSyntheticRepeatedEvaluation(config, async (context) =>
      attemptBody(context.attemptIndex, context.attemptIndex % 2 === 0),
    );

    expect(report.attempts).toHaveLength(4);
    expect(report.attempts.map((attempt) => attempt.attemptIndex)).toEqual([0, 1, 2, 3]);
    expect(new Set(report.attempts.map((attempt) => attempt.attemptId)).size).toBe(4);
    expect(report.counts).toEqual({
      scheduled: 4,
      attempted: 4,
      producedChange: 4,
      checksPassed: 2,
      humanAccepted: { true: 2, false: 2, notObserved: 0 },
      integrated: { true: 1, false: 2, notObserved: 1 },
      reverted: { true: 0, false: 1, notObserved: 3 },
    });
    expect(report.checkSuccessRate).toBe(0.5);
    expect(report.checkSuccessWilson95.lower).toBeGreaterThan(0);
    expect(report.checkSuccessWilson95.upper).toBeLessThan(1);
    expect(report.latencyMs).toEqual({
      total: 100,
      observed: 4,
      notObserved: 0,
      p50: 20,
      p95: 40,
    });
    expect(report.failureTaxonomy).toEqual([{ kind: 'check_failed', count: 2 }]);
    expect(report.providerRandomnessControlled).toBe(false);
    expect(report.evidenceEligible).toBe(false);
    expect(report.gateStatus).toBe('blocked_unconfigured');
  });

  test('refuses partial or best-only reports', () => {
    const config = syntheticConfig(4);
    const successes = [completeAttempt(0, true), completeAttempt(1, true)];
    expect(() => buildRepeatedRunReport(config, successes)).toThrow('every scheduled attempt');
  });

  test('append-only ledger clones records and rejects replacement or stage inconsistency', () => {
    const ledger = new RepeatedRunLedgerV1('case.v1', 2);
    const first = completeAttempt(0, true, 'case.v1');
    ledger.append(first);
    first.failureKinds.push('later_mutation');
    expect(ledger.snapshot()[0]?.failureKinds).toEqual([]);
    expect(() => ledger.append(completeAttempt(0, true, 'case.v1'))).toThrow('attempt 1');

    const invalid = completeAttempt(1, false, 'case.v1');
    invalid.attempted = false;
    invalid.checksPassed = true;
    invalid.producedChange = false;
    expect(() => ledger.append(invalid)).toThrow('unattempted run');
  });

  test('retains a structured unknown-metrics attempt when an executor throws', async () => {
    const report = await runSyntheticRepeatedEvaluation(syntheticConfig(3), async (context) => {
      if (context.attemptIndex === 1) throw new Error('sensitive provider detail');
      return attemptBody(context.attemptIndex, true);
    });

    expect(report.attempts).toHaveLength(3);
    expect(report.attempts[1]?.failureKinds).toEqual(['runner_error']);
    expect(report.attempts[1]?.metrics.latencyMs).toBeNull();
    expect(report.latencyMs.observed).toBe(2);
    expect(report.latencyMs.notObserved).toBe(1);
    expect(JSON.stringify(report)).not.toContain('sensitive provider detail');
  });

  test('is deterministic for the same retained attempts and evaluator seed', () => {
    const config = syntheticConfig(2);
    const attempts = [completeAttempt(0, true), completeAttempt(1, false)];
    const first = buildRepeatedRunReport(config, attempts);
    const second = buildRepeatedRunReport(structuredClone(config), structuredClone(attempts));
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => verifySyntheticRepeatedRunReport(first, config)).not.toThrow();

    const tampered = structuredClone(first);
    tampered.counts.checksPassed += 1;
    expect(() => verifySyntheticRepeatedRunReport(tampered, config)).toThrow('does not rebuild');
  });
});

function syntheticConfig(repetitionCount: number): SyntheticRepeatedRunConfigV1 {
  return {
    version: 1,
    executionClass: 'synthetic_fixture',
    caseId: 'synthetic.math-bug-fix.v1',
    suiteDigest: digest('suite'),
    routeIdentity: 'synthetic-offline-route',
    configDigest: digest('config'),
    artifactDigest: digest('artifact'),
    contractDigest: digest('contract'),
    schemaDigest: digest('schema'),
    repetitionCount,
    evaluatorSeed: 1729,
    decision: { id: 'D-07', status: 'unconfigured', approvedAt: null },
  };
}

function completeAttempt(
  attemptIndex: number,
  success: boolean,
  caseId = 'synthetic.math-bug-fix.v1',
): AgentTaskAttemptV1 {
  return {
    version: 1,
    attemptIndex,
    attemptId: `attempt-${attemptIndex}`,
    caseId,
    ...attemptBody(attemptIndex, success),
  };
}

function attemptBody(attemptIndex: number, success: boolean) {
  const second = String(attemptIndex).padStart(2, '0');
  return {
    startedAt: `2026-08-02T00:00:${second}.000Z`,
    finishedAt: `2026-08-02T00:00:${second}.010Z`,
    attempted: true,
    producedChange: true,
    checksPassed: success,
    humanAccepted: success,
    integrated: success && attemptIndex === 0 ? true : success ? 'not_observed' : false,
    reverted: success && attemptIndex === 0 ? false : 'not_observed',
    failureKinds: success ? [] : ['check_failed'],
    oracleDigest: digest(`oracle-${attemptIndex}`),
    metrics: {
      latencyMs: (attemptIndex + 1) * 10,
      modelCalls: 1,
      toolCalls: attemptIndex + 1,
      inputTokens: 100 + attemptIndex,
      outputTokens: 20 + attemptIndex,
      approvalCount: 0,
      userCorrections: success ? 0 : 1,
    },
  } as const;
}

function digest(value: string): `sha256:${string}` {
  return sha256Digest(value);
}
