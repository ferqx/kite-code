import type {
  ContextReclaimModeV1,
  ReclaimEligibilityReasonV1,
  ReclaimRejectionCountsV1,
} from './context-reclaim';

export interface ReclaimShadowSampleV1 {
  policyId: 'context-reclaim:v1';
  policyVersion: 1;
  mode: Extract<ContextReclaimModeV1, 'shadow'>;
  rawInputTokens: number;
  candidateBlockCount: number;
  candidateCallCount: number;
  estimatedSavedChars: number;
  estimatedSavedTokens: number;
  rejectionCounts: ReclaimRejectionCountsV1;
  durationMs: number;
}

export interface ReclaimShadowReporter {
  record(sample: ReclaimShadowSampleV1): void;
}

const REJECTION_REASONS: readonly ReclaimEligibilityReasonV1[] = [
  'invalid_pairing',
  'current_turn',
  'missing_identity',
  'unsupported_or_mixed_tool',
  'unsuccessful_result',
  'not_read_only',
  'workspace_mutation',
  'legacy_provenance',
  'missing_model_content_digest',
  'model_content_digest_mismatch',
  'missing_locator',
  'no_positive_saving',
];
const MAX_SHADOW_SAMPLES = 1_024;

function boundedNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sanitizedRejectionCounts(input: ReclaimRejectionCountsV1): ReclaimRejectionCountsV1 {
  const output: ReclaimRejectionCountsV1 = {};
  for (const reason of REJECTION_REASONS) {
    const count = input[reason];
    if (count != null && count > 0) output[reason] = boundedNonNegative(count);
  }
  return output;
}

/** Bounded, process-local collector. It has no persistence or debug-writer dependency. */
export class ReclaimShadowCollector implements ReclaimShadowReporter {
  readonly #maxSamples: number;
  #samples: ReclaimShadowSampleV1[] = [];

  constructor(maxSamples = 64) {
    const normalized = Number.isFinite(maxSamples) ? Math.floor(maxSamples) : 1;
    this.#maxSamples = Math.min(MAX_SHADOW_SAMPLES, Math.max(1, normalized));
  }

  record(sample: ReclaimShadowSampleV1): void {
    const sanitized: ReclaimShadowSampleV1 = {
      policyId: 'context-reclaim:v1',
      policyVersion: 1,
      mode: 'shadow',
      rawInputTokens: boundedNonNegative(sample.rawInputTokens),
      candidateBlockCount: boundedNonNegative(sample.candidateBlockCount),
      candidateCallCount: boundedNonNegative(sample.candidateCallCount),
      estimatedSavedChars: boundedNonNegative(sample.estimatedSavedChars),
      estimatedSavedTokens: boundedNonNegative(sample.estimatedSavedTokens),
      rejectionCounts: sanitizedRejectionCounts(sample.rejectionCounts),
      durationMs: boundedNonNegative(sample.durationMs),
    };
    this.#samples.push(sanitized);
    if (this.#samples.length > this.#maxSamples) {
      this.#samples = this.#samples.slice(-this.#maxSamples);
    }
  }

  snapshot(): ReclaimShadowSampleV1[] {
    return this.#samples.map((sample) => ({
      ...sample,
      rejectionCounts: { ...sample.rejectionCounts },
    }));
  }

  clear(): void {
    this.#samples = [];
  }
}

export function createReclaimShadowCollector(maxSamples?: number): ReclaimShadowCollector {
  return new ReclaimShadowCollector(maxSamples);
}
