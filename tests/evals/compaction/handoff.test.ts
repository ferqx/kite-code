import { describe, expect, test } from 'bun:test';
import { evaluateNoCompactionHandoff, syntheticNoCompactionHandoff } from './handoff';

describe('no-compaction handoff contract', () => {
  test('keeps manual/auto disabled while preserving a complete supported handoff', () => {
    const report = evaluateNoCompactionHandoff(syntheticNoCompactionHandoff());
    expect(report.contractOutcome).toBe('passed');
    expect(report.routeQualification).toBe('not_observed');
    expect(report.supportOutcome).toBe('contract_supported');
    expect(report.status).toBe('blocked');
    expect(report.evidenceEligible).toBeFalse();
  });

  test('rejects silent compaction, transcript mutation, misleading clear, and lost artifacts', () => {
    const input = syntheticNoCompactionHandoff();
    input.silentCompactionAttempted = true;
    input.originalTranscriptDigestAfter = `sha256:${'2'.repeat(64)}`;
    input.transition = 'clear';
    input.transitionPresentedAsSuccessfulCompaction = true;
    input.savedArtifacts.pending = false;
    const report = evaluateNoCompactionHandoff(input);
    expect(report.contractOutcome).toBe('failed');
    expect(report.violations).toEqual(
      expect.arrayContaining([
        'handoff_artifact_missing',
        'original_transcript_mutated',
        'session_transition_mislabeled_as_compaction',
        'silent_compaction_attempted',
      ]),
    );
  });

  test('marks too-long tasks explicitly unsupported without calling them successful', () => {
    const input = syntheticNoCompactionHandoff();
    input.taskBudgetClass = 'unsupported_too_long';
    input.savedArtifacts = { diff: false, plan: false, checks: false, pending: false };
    const report = evaluateNoCompactionHandoff(input);
    expect(report.contractOutcome).toBe('passed');
    expect(report.supportOutcome).toBe('explicitly_unsupported');
  });

  test('cannot enable compaction in an unqualified handoff fixture', () => {
    expect(() =>
      evaluateNoCompactionHandoff({ ...syntheticNoCompactionHandoff(), manualFlag: true }),
    ).toThrow();
  });
});
