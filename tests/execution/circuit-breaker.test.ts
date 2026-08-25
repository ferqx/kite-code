import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG_ as DEFAULT_CIRCUIT_BREAKER_CONFIG,
  evaluateAutoReviewCircuitBreaker as evaluateCircuitBreaker,
  type AutoReviewRejectionEntry as RejectionEntry,
} from '@kite-ai/agent-kernel';

const cfg = DEFAULT_CIRCUIT_BREAKER_CONFIG;

function makeEntry(toolName: string, reason: string, timestamp?: number): RejectionEntry {
  return { timestamp: timestamp ?? Date.now(), toolName, reason };
}

describe('DEFAULT_CIRCUIT_BREAKER_CONFIG', () => {
  test('has expected default values', () => {
    expect(cfg.maxRejections).toBe(3);
    expect(cfg.windowMs).toBe(30_000);
    expect(cfg.maxTotalBlocks).toBe(20);
  });
});

describe('evaluateCircuitBreaker — approval path', () => {
  test('approval resets consecutive counter to 0', () => {
    const result = evaluateCircuitBreaker(
      2, // was 2 consecutive rejects
      [makeEntry('shell_execute', 'rejected'), makeEntry('write_file', 'rejected')],
      cfg,
      false, // isRejection = false → approval
    );
    expect(result.tripped).toBe(false);
    expect(result.newConsecutiveRejects).toBe(0);
    expect(result.newStatus.status).toBe('closed');
  });

  test('approval prunes old history entries outside window', () => {
    const old = makeEntry('shell_execute', 'old rejection', Date.now() - 60_000); // 60s ago, window is 30s
    const result = evaluateCircuitBreaker(1, [old], cfg, false, undefined, Date.now());
    expect(result.newRejectionHistory).toHaveLength(0); // old entry pruned
    expect(result.newConsecutiveRejects).toBe(0);
  });
});

describe('evaluateCircuitBreaker — rejection path', () => {
  test('single rejection does not trip', () => {
    const result = evaluateCircuitBreaker(
      0,
      [],
      cfg,
      true,
      makeEntry('write_file', 'unexpected write'),
    );
    expect(result.tripped).toBe(false);
    expect(result.newConsecutiveRejects).toBe(1);
    expect(result.newRejectionHistory).toHaveLength(1);
  });

  test('N consecutive rejections trip the breaker (condition A)', () => {
    // Already at 2 consecutive → this 3rd one trips
    const result = evaluateCircuitBreaker(
      2,
      [makeEntry('shell_execute', 'reject 1'), makeEntry('shell_execute', 'reject 2')],
      cfg,
      true,
      makeEntry('shell_execute', 'reject 3'),
    );
    expect(result.tripped).toBe(true);
    expect(result.reason).toContain('consecutive');
    expect(result.reason).toContain('3');
    expect(result.newStatus.status).toBe('open');
  });

  test('approval interrupts consecutive count → rej-rej-approve-rej = 1 consecutive', () => {
    // Simulate: reject → reject → approve → reject
    // After approve, consecutive was reset. Then another reject → 1 consecutive.
    const afterApprove = evaluateCircuitBreaker(
      2,
      [makeEntry('a', 'r1'), makeEntry('b', 'r2')],
      cfg,
      false, // approve
    );
    expect(afterApprove.newConsecutiveRejects).toBe(0);

    const afterReject = evaluateCircuitBreaker(
      afterApprove.newConsecutiveRejects, // 0
      afterApprove.newRejectionHistory,
      cfg,
      true,
      makeEntry('c', 'r3'),
    );
    expect(afterReject.tripped).toBe(false);
    expect(afterReject.newConsecutiveRejects).toBe(1);
  });

  test('total rejections in window trip the breaker (condition B)', () => {
    // Build 19 existing entries in the window
    const history: RejectionEntry[] = Array.from({ length: 19 }, (_, i) =>
      makeEntry(`tool-${i}`, `reject ${i}`),
    );
    // The 20th rejection trips condition B
    const result = evaluateCircuitBreaker(0, history, cfg, true, makeEntry('tool-20', 'reject 20'));
    expect(result.tripped).toBe(true);
    expect(result.reason).toContain('within');
    expect(result.reason).toContain('20');
  });

  test('sliding window prunes old history entries', () => {
    const now = Date.now();
    const oldEntries: RejectionEntry[] = Array.from({ length: 5 }, (_, i) => ({
      timestamp: now - 60_000, // 60s ago → outside 30s window
      toolName: `old-${i}`,
      reason: `old rejection ${i}`,
    }));
    const result = evaluateCircuitBreaker(
      0,
      oldEntries,
      cfg,
      true,
      makeEntry('new-tool', 'new rejection'),
      now,
    );
    // Old entries should be pruned, only the new one remains
    expect(result.newRejectionHistory).toHaveLength(1);
    expect(result.newRejectionHistory[0]!.toolName).toBe('new-tool');
  });
});
