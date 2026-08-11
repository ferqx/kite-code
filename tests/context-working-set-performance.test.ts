import { describe, expect, test } from 'bun:test';
import { createVerifiedContextCheckpointV3 } from '@/core/model/context-checkpoint-v3';
import { selectCheckpointWorkingSetV1 } from '@/core/model/context-working-set';
import { createInitialRuntimeState } from '@/core/runtime/state';

const BLOCK_COUNT = 2_000;
const FIXTURE_MIN_BYTES = 8 * 1024 * 1024;

function percentile95(values: number[]): number {
  return [...values].sort((left, right) => left - right)[Math.ceil(values.length * 0.95) - 1]!;
}

describe('checkpoint working set qualification', () => {
  test('meets the frozen 2000-block / 8MiB latency and incremental RSS gates', () => {
    const state = createInitialRuntimeState({
      threadId: 'working-set-performance',
      userId: 'u',
      workspace: '/workspace',
    });
    state.revision = 1;
    state.lastAppliedEventId = 'a'.repeat(64);
    state.appliedEventIds = ['a'.repeat(64)];
    state.transcript.messages = Array.from({ length: BLOCK_COUNT }, (_, index) =>
      index % 2 === 0
        ? {
            kind: 'user' as const,
            messageId: `message-${index}`,
            turnId: `turn-${index}`,
            ordinal: 0,
            createdAt: '2026-08-11T00:00:00.000Z',
            content: `user-${index}:${'x'.repeat(4_100)}`,
          }
        : {
            kind: 'assistant' as const,
            messageId: `message-${index}`,
            turnId: `turn-${index}`,
            ordinal: 0,
            createdAt: '2026-08-11T00:00:00.000Z',
            content: `assistant-${index}:${'y'.repeat(4_100)}`,
            toolCalls: [],
          },
    );
    expect(
      Buffer.byteLength(JSON.stringify(state.transcript.messages), 'utf8'),
    ).toBeGreaterThanOrEqual(FIXTURE_MIN_BYTES);
    const checkpoint = createVerifiedContextCheckpointV3({
      state,
      checkpointId: 'performance-v3',
      compactionId: 'performance-v3',
      reason: 'manual',
      coveredThroughMessageId: `message-${BLOCK_COUNT - 5}`,
      summary: '# Working set performance fixture',
      inputTokensBefore: 3_000_000,
      inputTokensAfter: 1_000,
      routeIdentityDigest: 'b'.repeat(64),
      sourceProducingEventCutV1: { revision: 1, eventId: 'a'.repeat(64) },
      createdAt: '2026-08-11T00:00:00.000Z',
    });
    for (let index = 0; index < 3; index += 1) {
      expect(selectCheckpointWorkingSetV1({ state, checkpoint }).status).toBe('available');
    }
    Bun.gc(true);
    let incrementalPeakRss = 0;
    const prepareSamples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      Bun.gc(true);
      const callBaselineRss = process.memoryUsage.rss();
      const startedAt = performance.now();
      const selected = selectCheckpointWorkingSetV1({ state, checkpoint });
      prepareSamples.push(performance.now() - startedAt);
      expect(selected.status).toBe('available');
      incrementalPeakRss = Math.max(
        incrementalPeakRss,
        process.memoryUsage.rss() - callBaselineRss,
      );
    }
    const restoreSamples: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      Bun.gc(true);
      const callBaselineRss = process.memoryUsage.rss();
      const restoredCheckpoint = structuredClone(checkpoint);
      const startedAt = performance.now();
      const selected = selectCheckpointWorkingSetV1({ state, checkpoint: restoredCheckpoint });
      restoreSamples.push(performance.now() - startedAt);
      expect(selected.status).toBe('available');
      incrementalPeakRss = Math.max(
        incrementalPeakRss,
        process.memoryUsage.rss() - callBaselineRss,
      );
    }
    expect(percentile95(prepareSamples)).toBeLessThanOrEqual(75);
    expect(percentile95(restoreSamples)).toBeLessThanOrEqual(100);
    expect(incrementalPeakRss).toBeLessThanOrEqual(96 * 1024 * 1024);
  });
});
