import { z } from 'zod';
import { canonicalJsonBytes, sha256Digest } from '../../../scripts/release/canonical-json';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const handoffInputSchema = z
  .object({
    version: z.literal(1),
    source: z.literal('synthetic_fixture'),
    routeQualification: z.enum(['not_observed', 'not_qualified']),
    manualFlag: z.literal(false),
    autoFlag: z.literal(false),
    contextPressure: z.enum(['approaching', 'exceeded']),
    warningDisplayed: z.boolean(),
    silentCompactionAttempted: z.boolean(),
    originalTranscriptDigestBefore: digest,
    originalTranscriptDigestAfter: digest,
    savedArtifacts: z
      .object({
        diff: z.boolean(),
        plan: z.boolean(),
        checks: z.boolean(),
        pending: z.boolean(),
      })
      .strict(),
    transition: z.enum(['new_session', 'clear']),
    transitionPresentedAsSuccessfulCompaction: z.boolean(),
    taskBudgetClass: z.enum(['supported', 'unsupported_too_long']),
  })
  .strict();

export type NoCompactionHandoffInputV1 = z.infer<typeof handoffInputSchema>;

export interface NoCompactionHandoffReportV1 {
  version: 1;
  kind: 'no_compaction_handoff_contract';
  executionClass: 'synthetic_fixture';
  distribution: 'nonDistributable';
  evidenceEligible: false;
  status: 'blocked';
  contractOutcome: 'passed' | 'failed';
  routeQualification: 'not_observed' | 'not_qualified';
  supportOutcome: 'contract_supported' | 'explicitly_unsupported';
  violations: string[];
  inputDigest: `sha256:${string}`;
  digest: `sha256:${string}`;
}

export function evaluateNoCompactionHandoff(value: unknown): NoCompactionHandoffReportV1 {
  const input = handoffInputSchema.parse(value);
  const violations: string[] = [];
  if (!input.warningDisplayed) violations.push('context_pressure_warning_missing');
  if (input.silentCompactionAttempted) violations.push('silent_compaction_attempted');
  if (input.originalTranscriptDigestBefore !== input.originalTranscriptDigestAfter) {
    violations.push('original_transcript_mutated');
  }
  if (input.transitionPresentedAsSuccessfulCompaction) {
    violations.push('session_transition_mislabeled_as_compaction');
  }
  if (
    input.taskBudgetClass === 'supported' &&
    Object.values(input.savedArtifacts).some((saved) => !saved)
  ) {
    violations.push('handoff_artifact_missing');
  }
  const inputDigest = sha256Digest(canonicalJsonBytes(input));
  const withoutDigest = {
    version: 1 as const,
    kind: 'no_compaction_handoff_contract' as const,
    executionClass: 'synthetic_fixture' as const,
    distribution: 'nonDistributable' as const,
    evidenceEligible: false as const,
    status: 'blocked' as const,
    contractOutcome: violations.length === 0 ? ('passed' as const) : ('failed' as const),
    routeQualification: input.routeQualification,
    supportOutcome:
      input.taskBudgetClass === 'supported'
        ? ('contract_supported' as const)
        : ('explicitly_unsupported' as const),
    violations: violations.sort(),
    inputDigest,
  };
  return { ...withoutDigest, digest: sha256Digest(canonicalJsonBytes(withoutDigest)) };
}

export function syntheticNoCompactionHandoff(): NoCompactionHandoffInputV1 {
  return {
    version: 1,
    source: 'synthetic_fixture',
    routeQualification: 'not_observed',
    manualFlag: false,
    autoFlag: false,
    contextPressure: 'approaching',
    warningDisplayed: true,
    silentCompactionAttempted: false,
    originalTranscriptDigestBefore: `sha256:${'1'.repeat(64)}`,
    originalTranscriptDigestAfter: `sha256:${'1'.repeat(64)}`,
    savedArtifacts: { diff: true, plan: true, checks: true, pending: true },
    transition: 'new_session',
    transitionPresentedAsSuccessfulCompaction: false,
    taskBudgetClass: 'supported',
  };
}
