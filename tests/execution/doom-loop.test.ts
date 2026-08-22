import { describe, expect, test } from 'bun:test';
import {
  type KernelDoomLoopTrackerEntryV1,
  kernelCheckDoomLoopFingerprintV1,
  kernelToolDoomLoopFingerprintV1,
  kernelUpdateDoomLoopTrackerV1,
} from '@kite/agent-kernel';
import type { PendingToolRequest } from '@kite/builtin-runtime';

type DoomLoopTrackerEntry = KernelDoomLoopTrackerEntryV1;

const buildToolFingerprint = kernelToolDoomLoopFingerprintV1;

function checkDoomLoop(
  tracker: Readonly<Record<string, DoomLoopTrackerEntry>>,
  request: PendingToolRequest,
  threshold: number,
  windowMs: number,
  now = Date.now(),
) {
  return kernelCheckDoomLoopFingerprintV1(
    tracker,
    kernelToolDoomLoopFingerprintV1(request),
    threshold,
    windowMs,
    now,
  );
}

function updateDoomLoopTracker(
  tracker: Readonly<Record<string, DoomLoopTrackerEntry>>,
  fingerprint: string,
  now = Date.now(),
) {
  return kernelUpdateDoomLoopTrackerV1(tracker, fingerprint, now);
}

function makeRequest(name: string, args: Record<string, unknown>): PendingToolRequest {
  return {
    id: 'call-1',
    name,
    args,
    reason: 'test',
    protectedCommand: name,
  } as PendingToolRequest;
}

describe('buildToolFingerprint', () => {
  test('same shell command + same args → same fingerprint', () => {
    const a = makeRequest('shell_execute', { command: 'rm /tmp/cache' });
    const b = makeRequest('shell_execute', { command: 'rm /tmp/cache' });
    expect(buildToolFingerprint(a)).toBe(buildToolFingerprint(b));
  });

  test('different shell commands → different fingerprints', () => {
    const a = makeRequest('shell_execute', { command: 'rm /tmp/a' });
    const b = makeRequest('shell_execute', { command: 'rm /tmp/b' });
    expect(buildToolFingerprint(a)).not.toBe(buildToolFingerprint(b));
  });

  test('shell_execute uses command+cwd, write_file uses path — different fingerprint structures', () => {
    const shell = makeRequest('shell_execute', { command: 'echo hi', cwd: '/tmp' });
    const write = makeRequest('write_file', { path: 'echo hi' });
    // Different tool name → different fingerprint (even if args overlap)
    expect(buildToolFingerprint(shell)).not.toBe(buildToolFingerprint(write));
  });

  test('non-mutation tools include canonical full args without depending on key order', () => {
    const first = makeRequest('remote_lookup', { query: 'alpha', limit: 2 });
    const reordered = makeRequest('remote_lookup', { limit: 2, query: 'alpha' });
    const different = makeRequest('remote_lookup', { query: 'beta', limit: 2 });

    expect(buildToolFingerprint(first)).toBe(buildToolFingerprint(reordered));
    expect(buildToolFingerprint(first)).not.toBe(buildToolFingerprint(different));
  });
});

describe('checkDoomLoop', () => {
  test('an unrecorded call is never blocked', () => {
    const tracker: Record<string, DoomLoopTrackerEntry> = {};
    const req = makeRequest('shell_execute', { command: 'npm install' });
    const result = checkDoomLoop(tracker, req, 3, 60_000);
    expect(result.blocked).toBe(false);
    expect(result.count).toBe(0);
    expect(result.fingerprint).toBeDefined();
  });

  test('windowed repeats ≥ threshold → blocked', () => {
    const req = makeRequest('write_file', { path: 'test.txt', content: 'v1' });
    const fp = buildToolFingerprint(req);
    const tracker: Record<string, DoomLoopTrackerEntry> = {
      [fp]: { count: 3, lastSeenAt: Date.now() },
    };
    const result = checkDoomLoop(tracker, req, 3, 60_000);
    expect(result.blocked).toBe(true);
    expect(result.count).toBe(3);
    expect(result.reason).toContain('Doom loop detected');
  });

  test('repeat outside window → not blocked (counter resets)', () => {
    const req = makeRequest('shell_execute', { command: 'bun test' });
    const fp = buildToolFingerprint(req);
    // Last seen 90s ago — outside the 60s window
    const tracker: Record<string, DoomLoopTrackerEntry> = {
      [fp]: { count: 3, lastSeenAt: Date.now() - 90_000 },
    };
    const result = checkDoomLoop(tracker, req, 3, 60_000);
    expect(result.blocked).toBe(false);
    expect(result.count).toBe(0);
  });
});

describe('updateDoomLoopTracker', () => {
  test('updates count for existing fingerprint', () => {
    const fp = 'abc123';
    const tracker: Record<string, DoomLoopTrackerEntry> = {
      [fp]: { count: 2, lastSeenAt: Date.now() - 1_000 },
    };
    const next = updateDoomLoopTracker(tracker, fp);
    expect(next[fp]!.count).toBe(3);
  });

  test('creates new entry for unknown fingerprint', () => {
    const tracker: Record<string, DoomLoopTrackerEntry> = {};
    const next = updateDoomLoopTracker(tracker, 'new-fp');
    expect(next['new-fp']!.count).toBe(1);
  });

  test('resets the count after the detection window expires', () => {
    const now = Date.parse('2026-08-14T00:02:00.000Z');
    const fp = 'expired-window';
    const tracker: Record<string, DoomLoopTrackerEntry> = {
      [fp]: { count: 4, lastSeenAt: now - 60_001 },
    };

    const next = updateDoomLoopTracker(tracker, fp, now);

    expect(next[fp]).toEqual({ count: 1, lastSeenAt: now });
  });

  test('purges entries older than 120s', () => {
    const oldFp = 'old-entry';
    const recentFp = 'recent-entry';
    const tracker: Record<string, DoomLoopTrackerEntry> = {
      [oldFp]: { count: 5, lastSeenAt: Date.now() - 130_000 }, // beyond 120s
      [recentFp]: { count: 1, lastSeenAt: Date.now() },
    };
    const next = updateDoomLoopTracker(tracker, 'new-fp');
    expect(next[oldFp]).toBeUndefined(); // purged
    expect(next[recentFp]!.count).toBe(1); // preserved
    expect(next['new-fp']!.count).toBe(1); // new entry added
  });
});
