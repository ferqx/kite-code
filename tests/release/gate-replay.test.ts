import { describe, expect, test } from 'bun:test';
import { buildSyntheticFoundationGateRecord } from '../../scripts/release/foundation-gate';
import { replayReleaseGate } from '../../scripts/release/gate-replay';

describe('Release Gate replay', () => {
  test('rebuilds the retained foundation decision byte-for-byte', () => {
    const fixture = buildSyntheticFoundationGateRecord();
    const result = replayReleaseGate({
      policy: fixture.policy,
      evidence: fixture.evidence,
      artifactIdentity: fixture.evidence.artifactIdentity,
      evaluatedAt: fixture.decision.evaluatedAt,
      retainedDecision: fixture.decision,
    });
    expect(result.replay).toMatchObject({
      status: 'replay_verified',
      candidateEligible: false,
      firstDecisionDigest: fixture.decision.decisionDigest,
      replayDecisionDigest: fixture.decision.decisionDigest,
    });
  });

  test('rejects a retained decision that does not match the retained inputs', () => {
    const fixture = buildSyntheticFoundationGateRecord();
    expect(() =>
      replayReleaseGate({
        policy: fixture.policy,
        evidence: fixture.evidence,
        artifactIdentity: fixture.evidence.artifactIdentity,
        evaluatedAt: fixture.decision.evaluatedAt,
        retainedDecision: { ...fixture.decision, overall: 'blocked' },
      }),
    ).toThrow('does not match');
  });
});
