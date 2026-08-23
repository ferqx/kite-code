import { canonicalJson, sha256DomainSeparated } from './canonical-json';
import type { ReleaseArtifactIdentity } from './evidence-schema';
import { evaluateReleaseGate, type ReleaseGateDecision } from './gate-evaluator';

export interface ReleaseGateReplayRecord {
  schema: 'ReleaseGateReplayRecord';
  status: 'replay_verified';
  candidateEligible: boolean;
  firstDecisionDigest: string;
  replayDecisionDigest: string;
  canonicalDecisionDigest: `sha256:${string}`;
}

/** Replays a Gate from retained inputs and requires byte-equivalent output. */
export function replayReleaseGate(input: {
  policy: unknown;
  evidence: unknown;
  artifactIdentity: ReleaseArtifactIdentity;
  evaluatedAt: string;
  retainedDecision?: unknown;
}): { decision: ReleaseGateDecision; replay: ReleaseGateReplayRecord } {
  const evaluation = () =>
    evaluateReleaseGate({
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
      schema: 'ReleaseGateReplayRecord',
      status: 'replay_verified',
      candidateEligible: first.overall === 'approved_candidate',
      firstDecisionDigest: first.decisionDigest,
      replayDecisionDigest: replayed.decisionDigest,
      canonicalDecisionDigest,
    },
  };
}
