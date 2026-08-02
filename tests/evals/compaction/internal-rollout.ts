import { z } from 'zod';
import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';

const inputSchema = z
  .object({
    version: z.literal(1),
    executionClass: z.literal('synthetic_contract_only'),
    requestedStage: z.enum([
      'off',
      'internal_manual',
      'internal_auto_shadow',
      'internal_auto_live',
    ]),
    dependencies: z
      .object({
        phase3OperationsReady: z.literal(false),
        routeQualification: z.enum(['not_observed', 'not_qualified']),
        liveMatrix: z.literal('not_observed'),
        g3: z.literal('not_observed'),
        g4: z.literal('not_observed'),
      })
      .strict(),
    killSwitch: z.literal('disable_only'),
  })
  .strict();

export type InternalCompactionRolloutInputV1 = z.infer<typeof inputSchema>;

export interface InternalCompactionRolloutReportV1 {
  version: 1;
  kind: 'internal_compaction_rollout_contract';
  executionClass: 'synthetic_contract_only';
  distribution: 'nonDistributable';
  evidenceEligible: false;
  status: 'blocked';
  requestedStage: InternalCompactionRolloutInputV1['requestedStage'];
  effectiveStage: 'off';
  manualEnabled: false;
  autoShadowEnabled: false;
  autoLiveEnabled: false;
  terminalFailureBehavior: 'compaction_off';
  externalCohort: 0;
  milestone: null;
  reasonCodes: string[];
  digest: `sha256:${string}`;
}

/**
 * Contract-only adapter for Task 4.9. Its input type intentionally cannot express
 * observed production dependencies, so it cannot mint a rollout qualification.
 */
export function evaluateInternalCompactionRollout(
  value: unknown,
): InternalCompactionRolloutReportV1 {
  const input = inputSchema.parse(value);
  const withoutDigest = {
    version: 1 as const,
    kind: 'internal_compaction_rollout_contract' as const,
    executionClass: 'synthetic_contract_only' as const,
    distribution: 'nonDistributable' as const,
    evidenceEligible: false as const,
    status: 'blocked' as const,
    requestedStage: input.requestedStage,
    effectiveStage: 'off' as const,
    manualEnabled: false as const,
    autoShadowEnabled: false as const,
    autoLiveEnabled: false as const,
    terminalFailureBehavior: 'compaction_off' as const,
    externalCohort: 0 as const,
    milestone: null,
    reasonCodes: [
      'phase3_operations_ready_missing',
      `route_qualification_${input.dependencies.routeQualification}`,
      'live_matrix_not_observed',
      'g3_not_observed',
      'g4_not_observed',
      'internal_freshness_not_observed',
    ].sort(),
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

export function syntheticInternalRolloutInput(
  requestedStage: InternalCompactionRolloutInputV1['requestedStage'] = 'internal_auto_live',
): InternalCompactionRolloutInputV1 {
  return {
    version: 1,
    executionClass: 'synthetic_contract_only',
    requestedStage,
    dependencies: {
      phase3OperationsReady: false,
      routeQualification: 'not_observed',
      liveMatrix: 'not_observed',
      g3: 'not_observed',
      g4: 'not_observed',
    },
    killSwitch: 'disable_only',
  };
}
