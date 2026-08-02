import { describe, expect, test } from 'bun:test';
import { evaluateStructureConformance, syntheticSettledObservation } from './structure';

describe('compaction structure conformance adapter', () => {
  test('passes the synthetic contract without claiming formal G0 evidence', () => {
    const report = evaluateStructureConformance(syntheticSettledObservation());
    expect(report.contractOutcome).toBe('passed');
    expect(report.status).toBe('blocked');
    expect(report.formalG0Outcome).toBe('not_observed');
    expect(report.evidenceEligible).toBeFalse();
    expect(report.distribution).toBe('nonDistributable');
  });

  test('classifies transcript, pairing, replay, lease, drift, and summary failures', () => {
    const observation = syntheticSettledObservation();
    observation.transcriptDigestAfter = `sha256:${'3'.repeat(64)}`;
    observation.toolResultIds = ['orphan'];
    observation.replayedCheckpointRevision = 2;
    observation.lease = 'stale';
    observation.environment = 'drifted';
    observation.summary = 'truncated';
    observation.originalStateUsableAfterFailure = false;
    const report = evaluateStructureConformance(observation);
    expect(report.contractOutcome).toBe('failed');
    expect(report.violations).toEqual(
      expect.arrayContaining([
        'checkpoint_replay_invalid',
        'environment_drift',
        'lease_stale',
        'original_state_unusable',
        'summary_truncated',
        'tool_pair_invalid',
        'transcript_mutated',
      ]),
    );
  });

  test('rejects unknown observation fields', () => {
    expect(() =>
      evaluateStructureConformance({ ...syntheticSettledObservation(), g0Passed: true }),
    ).toThrow();
  });

  test.each([
    'direct',
    'incremental',
    'reset',
  ] as const)('accepts the %s synthetic flow contract', (mode) => {
    const observation = syntheticSettledObservation();
    observation.mode = mode;
    expect(evaluateStructureConformance(observation).contractOutcome).toBe('passed');
  });

  test.each([
    'empty',
    'truncated',
    'tool_call',
    'oversized',
    'insufficient_reduction',
  ] as const)('fails closed for a %s summary', (summary) => {
    const observation = syntheticSettledObservation();
    observation.summary = summary;
    expect(evaluateStructureConformance(observation).violations).toContain(`summary_${summary}`);
  });

  test('requires every authoritative state source after replay', () => {
    const observation = syntheticSettledObservation();
    observation.reinjectedAuthorities = ['system_prompt', 'tool_schema', 'runtime_state'];
    expect(evaluateStructureConformance(observation).violations).toContain(
      'authoritative_state_not_reinjected',
    );
  });
});
