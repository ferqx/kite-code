import { canonicalJson, sha256DomainSeparated } from './canonical-json';
import type { ReleaseArtifactIdentityV1 } from './evidence-schema';
import { evaluateReleaseGateV1, type ReleaseGateDecisionV1 } from './gate-evaluator';

export interface ReleaseGateReplayRecordV1 {
  schema: 'ReleaseGateReplayRecordV1';
  status: 'replay_verified';
  candidateEligible: boolean;
  firstDecisionDigest: string;
  replayDecisionDigest: string;
  canonicalDecisionDigest: `sha256:${string}`;
}

/** Replays a Gate from retained inputs and requires byte-equivalent output. */
export function replayReleaseGateV1(input: {
  policy: unknown;
  evidence: unknown;
  artifactIdentity: ReleaseArtifactIdentityV1;
  evaluatedAt: string;
  retainedDecision?: unknown;
}): { decision: ReleaseGateDecisionV1; replay: ReleaseGateReplayRecordV1 } {
  const evaluation = () =>
    evaluateReleaseGateV1({
      policy: input.policy,
      evidence: input.evidence,
      artifactIdentity: input.artifactIdentity,
      evaluatedAt: input.evaluatedAt,
    });
  const first = evaluation();
  const replayed = evaluation();
  if (canonicalJson(first) !== canonicalJson(replayed)) {
    throw new Error('Release Gate replay is not deterministic.');
  }
  if (
    input.retainedDecision !== undefined &&
    canonicalJson(first) !== canonicalJson(input.retainedDecision)
  ) {
    throw new Error('Retained Release Gate decision does not match replayed inputs.');
  }
  const canonicalDecisionDigest = sha256DomainSeparated(
    'kite.release.gate-replay.v1',
    canonicalJson(first),
  );
  return {
    decision: first,
    replay: {
      schema: 'ReleaseGateReplayRecordV1',
      status: 'replay_verified',
      candidateEligible: first.overall === 'approved_candidate',
      firstDecisionDigest: first.decisionDigest,
      replayDecisionDigest: replayed.decisionDigest,
      canonicalDecisionDigest,
    },
  };
}
