import { describe, expect, test } from 'bun:test';
import { compactionMetrics } from '../../src/core/model/compaction-metrics';

describe('compactionMetrics', () => {
  test('starts with zero counts', () => {
    compactionMetrics.clear();
    const snapshot = compactionMetrics.snapshot();
    expect(snapshot).toEqual({
      requested: 0,
      completed: 0,
      failed: 0,
      overflowRecoveries: 0,
      resets: 0,
      m1FramesFolded: 0,
      samples: [],
      averageReductionRatio: 0,
      totalTokensSaved: 0,
    });
  });

  test('recordRequested increments counter', () => {
    compactionMetrics.clear();
    compactionMetrics.recordRequested();
    compactionMetrics.recordRequested();
    expect(compactionMetrics.snapshot().requested).toBe(2);
  });

  test('recordCompleted adds a sample with correct reduction ratio', () => {
    compactionMetrics.clear();
    compactionMetrics.recordCompleted({
      compactionId: 'c1',
      reason: 'manual',
      durationMs: 1500,
      tokensBefore: 10_000,
      tokensAfter: 3_500,
      turnsSinceLastCheckpoint: 5,
    });
    const snapshot = compactionMetrics.snapshot();
    expect(snapshot.completed).toBe(1);
    expect(snapshot.samples).toHaveLength(1);
    expect(snapshot.samples[0]?.reductionRatio).toBeCloseTo(0.65, 2);
    expect(snapshot.samples[0]?.turnsSinceLastCheckpoint).toBe(5);
    expect(snapshot.averageReductionRatio).toBeCloseTo(0.65, 2);
    expect(snapshot.totalTokensSaved).toBe(6_500);
  });

  test('recordFailed increments the failed counter', () => {
    compactionMetrics.clear();
    compactionMetrics.recordFailed();
    compactionMetrics.recordFailed();
    compactionMetrics.recordFailed();
    expect(compactionMetrics.snapshot().failed).toBe(3);
  });

  test('recordOverflowRecovery and recordReset are independent counters', () => {
    compactionMetrics.clear();
    compactionMetrics.recordOverflowRecovery();
    compactionMetrics.recordOverflowRecovery();
    compactionMetrics.recordReset();
    const snapshot = compactionMetrics.snapshot();
    expect(snapshot.overflowRecoveries).toBe(2);
    expect(snapshot.resets).toBe(1);
  });

  test('recordM1Folded updates the frame count', () => {
    compactionMetrics.clear();
    compactionMetrics.recordM1Folded(42);
    expect(compactionMetrics.snapshot().m1FramesFolded).toBe(42);
    // Last write wins
    compactionMetrics.recordM1Folded(7);
    expect(compactionMetrics.snapshot().m1FramesFolded).toBe(7);
  });

  test('samples are capped at 64 entries', () => {
    compactionMetrics.clear();
    for (let i = 0; i < 80; i++) {
      compactionMetrics.recordCompleted({
        compactionId: `c${i}`,
        reason: 'manual',
        durationMs: 100,
        tokensBefore: 10_000,
        tokensAfter: 5_000 + i,
      });
    }
    const snapshot = compactionMetrics.snapshot();
    expect(snapshot.samples.length).toBeLessThanOrEqual(64);
    expect(snapshot.completed).toBe(80);
  });

  test('averageReductionRatio computes correctly across multiple samples', () => {
    compactionMetrics.clear();
    compactionMetrics.recordCompleted({
      compactionId: 'a',
      reason: 'auto_soft',
      durationMs: 100,
      tokensBefore: 10_000,
      tokensAfter: 5_000, // 0.5
    });
    compactionMetrics.recordCompleted({
      compactionId: 'b',
      reason: 'auto_soft',
      durationMs: 100,
      tokensBefore: 10_000,
      tokensAfter: 2_000, // 0.8
    });
    const snapshot = compactionMetrics.snapshot();
    expect(snapshot.averageReductionRatio).toBeCloseTo(0.65, 2);
  });

  test('totalTokensSaved accumulates across samples', () => {
    compactionMetrics.clear();
    compactionMetrics.recordCompleted({
      compactionId: 'a',
      reason: 'manual',
      durationMs: 100,
      tokensBefore: 8_000,
      tokensAfter: 3_000,
    });
    compactionMetrics.recordCompleted({
      compactionId: 'b',
      reason: 'manual',
      durationMs: 100,
      tokensBefore: 12_000,
      tokensAfter: 5_000,
    });
    expect(compactionMetrics.snapshot().totalTokensSaved).toBe(12_000);
  });

  test('clear resets all counters', () => {
    compactionMetrics.recordRequested();
    compactionMetrics.recordCompleted({
      compactionId: 'x',
      reason: 'manual',
      durationMs: 100,
      tokensBefore: 100,
      tokensAfter: 50,
    });
    compactionMetrics.recordFailed();
    compactionMetrics.clear();
    const snapshot = compactionMetrics.snapshot();
    expect(snapshot.requested).toBe(0);
    expect(snapshot.completed).toBe(0);
    expect(snapshot.failed).toBe(0);
    expect(snapshot.samples).toHaveLength(0);
  });
});
