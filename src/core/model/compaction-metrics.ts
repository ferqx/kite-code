/**
 * Compaction metrics collector.
 *
 * Lightweight telemetry for context compaction operations. Counters accumulate
 * across the session lifetime; caller is responsible for flushing/exporting.
 */

export interface CompactionMetricSample {
  /** compactionId for correlation */
  compactionId: string;
  reason: string;
  durationMs: number;
  tokensBefore: number;
  tokensAfter: number;
  reductionRatio: number;
  /** Elapsed turns since last checkpoint at request time */
  turnsSinceLastCheckpoint?: number;
}

export interface CompactionMetricsSnapshot {
  requested: number;
  completed: number;
  failed: number;
  overflowRecoveries: number;
  resets: number;
  m1FramesFolded: number;
  samples: CompactionMetricSample[];
  /** Rolling average reduction ratio across completed compactions */
  averageReductionRatio: number;
  totalTokensSaved: number;
}

const MAX_SAMPLES = 64;

class CompactionMetrics {
  private _requested = 0;
  private _completed = 0;
  private _failed = 0;
  private _overflowRecoveries = 0;
  private _resets = 0;
  private _m1FramesFolded = 0;
  private _samples: CompactionMetricSample[] = [];

  /** Increment the requested counter. */
  recordRequested(): void {
    this._requested++;
  }

  /** Record a completed compaction with timing and token stats. */
  recordCompleted(input: {
    compactionId: string;
    reason: string;
    durationMs: number;
    tokensBefore: number;
    tokensAfter: number;
    turnsSinceLastCheckpoint?: number;
  }): void {
    this._completed++;
    const reductionRatio =
      input.tokensBefore > 0 ? (input.tokensBefore - input.tokensAfter) / input.tokensBefore : 0;
    this._samples.push({
      compactionId: input.compactionId,
      reason: input.reason,
      durationMs: input.durationMs,
      tokensBefore: input.tokensBefore,
      tokensAfter: input.tokensAfter,
      reductionRatio,
      turnsSinceLastCheckpoint: input.turnsSinceLastCheckpoint,
    });
    if (this._samples.length > MAX_SAMPLES) {
      this._samples = this._samples.slice(-MAX_SAMPLES);
    }
  }

  /** Increment the failed counter. */
  recordFailed(): void {
    this._failed++;
  }

  /** Increment the overflow recovery counter. */
  recordOverflowRecovery(): void {
    this._overflowRecoveries++;
  }

  /** Increment the reset counter. */
  recordReset(): void {
    this._resets++;
  }

  /** Set the M1 folded frames count for the current cycle. */
  recordM1Folded(count: number): void {
    this._m1FramesFolded = count;
  }

  /** Return a read-only snapshot of current metrics. */
  snapshot(): CompactionMetricsSnapshot {
    const totalReduction = this._samples.reduce((sum, sample) => sum + sample.reductionRatio, 0);
    return {
      requested: this._requested,
      completed: this._completed,
      failed: this._failed,
      overflowRecoveries: this._overflowRecoveries,
      resets: this._resets,
      m1FramesFolded: this._m1FramesFolded,
      samples: [...this._samples],
      averageReductionRatio: this._samples.length > 0 ? totalReduction / this._samples.length : 0,
      totalTokensSaved: this._samples.reduce(
        (sum, sample) => sum + (sample.tokensBefore - sample.tokensAfter),
        0,
      ),
    };
  }

  /** Clear all accumulated counters (e.g., on session reset). */
  clear(): void {
    this._requested = 0;
    this._completed = 0;
    this._failed = 0;
    this._overflowRecoveries = 0;
    this._resets = 0;
    this._m1FramesFolded = 0;
    this._samples = [];
  }
}

/** Singleton for the session-level compaction metrics collector. */
export const compactionMetrics = new CompactionMetrics();
