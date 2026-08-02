import { z } from 'zod';
import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const observationSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('synthetic_fixture'),
    mode: z.enum(['direct', 'incremental', 'reset']),
    rounds: z.number().int().min(1).max(5),
    settledTurn: z.boolean(),
    transcriptDigestBefore: digest,
    transcriptDigestAfter: digest,
    checkpointDigest: digest.nullable(),
    replayedCheckpointDigest: digest.nullable(),
    checkpointRevision: z.number().int().nonnegative(),
    replayedCheckpointRevision: z.number().int().nonnegative(),
    lease: z.enum(['current', 'stale', 'missing']),
    environment: z.enum(['stable', 'drifted']),
    toolCallIds: z.array(z.string().min(1)).max(64),
    toolResultIds: z.array(z.string().min(1)).max(64),
    summary: z.enum([
      'accepted',
      'empty',
      'truncated',
      'tool_call',
      'oversized',
      'insufficient_reduction',
    ]),
    originalStateUsableAfterFailure: z.boolean(),
    reinjectedAuthorities: z
      .array(z.enum(['system_prompt', 'tool_schema', 'plan', 'verification', 'runtime_state']))
      .max(5),
  })
  .strict();

export type CompactionStructureObservationV1 = z.infer<typeof observationSchema>;

export interface CompactionStructureReportV1 {
  version: 1;
  kind: 'compaction_structure_contract';
  executionClass: 'synthetic_fixture';
  distribution: 'nonDistributable';
  evidenceEligible: false;
  status: 'blocked';
  contractOutcome: 'passed' | 'failed';
  formalG0Outcome: 'not_observed';
  violations: string[];
  observationDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
}

export function evaluateStructureConformance(value: unknown): CompactionStructureReportV1 {
  const observation = observationSchema.parse(value);
  const violations: string[] = [];
  if (!observation.settledTurn) violations.push('turn_not_settled');
  if (observation.transcriptDigestBefore !== observation.transcriptDigestAfter) {
    violations.push('transcript_mutated');
  }
  const calls = new Set(observation.toolCallIds);
  const results = new Set(observation.toolResultIds);
  if (
    calls.size !== observation.toolCallIds.length ||
    results.size !== observation.toolResultIds.length ||
    calls.size !== results.size ||
    [...calls].some((identity) => !results.has(identity))
  ) {
    violations.push('tool_pair_invalid');
  }
  if (
    observation.checkpointDigest === null ||
    observation.replayedCheckpointDigest !== observation.checkpointDigest ||
    observation.replayedCheckpointRevision !== observation.checkpointRevision
  ) {
    violations.push('checkpoint_replay_invalid');
  }
  if (observation.lease !== 'current') violations.push(`lease_${observation.lease}`);
  if (observation.environment !== 'stable') violations.push('environment_drift');
  if (observation.summary !== 'accepted') violations.push(`summary_${observation.summary}`);
  if (violations.length > 0 && !observation.originalStateUsableAfterFailure) {
    violations.push('original_state_unusable');
  }
  const requiredAuthorities = [
    'system_prompt',
    'tool_schema',
    'plan',
    'verification',
    'runtime_state',
  ] as const;
  if (
    new Set(observation.reinjectedAuthorities).size !== observation.reinjectedAuthorities.length ||
    requiredAuthorities.some((authority) => !observation.reinjectedAuthorities.includes(authority))
  ) {
    violations.push('authoritative_state_not_reinjected');
  }
  const observationDigest = sha256Digest(canonicalJsonBytes(observation));
  const withoutDigest = {
    version: 1 as const,
    kind: 'compaction_structure_contract' as const,
    executionClass: 'synthetic_fixture' as const,
    distribution: 'nonDistributable' as const,
    evidenceEligible: false as const,
    status: 'blocked' as const,
    contractOutcome: violations.length === 0 ? ('passed' as const) : ('failed' as const),
    formalG0Outcome: 'not_observed' as const,
    violations: [...new Set(violations)].sort(),
    observationDigest,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

export function syntheticSettledObservation(): CompactionStructureObservationV1 {
  return {
    version: 1,
    source: 'synthetic_fixture',
    mode: 'incremental',
    rounds: 2,
    settledTurn: true,
    transcriptDigestBefore: `sha256:${'1'.repeat(64)}`,
    transcriptDigestAfter: `sha256:${'1'.repeat(64)}`,
    checkpointDigest: `sha256:${'2'.repeat(64)}`,
    replayedCheckpointDigest: `sha256:${'2'.repeat(64)}`,
    checkpointRevision: 3,
    replayedCheckpointRevision: 3,
    lease: 'current',
    environment: 'stable',
    toolCallIds: ['call-1'],
    toolResultIds: ['call-1'],
    summary: 'accepted',
    originalStateUsableAfterFailure: true,
    reinjectedAuthorities: [
      'system_prompt',
      'tool_schema',
      'plan',
      'verification',
      'runtime_state',
    ],
  };
}
