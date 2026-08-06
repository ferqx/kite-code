import { describe, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLiveScratchSupervisorHealthV1,
  hasFreshLiveScratchSupervisorHealthV1,
  LIVE_SCRATCH_SUPERVISOR_DIRECTORY_NAME_V1,
  LIVE_SCRATCH_SUPERVISOR_HEALTH_FILE_NAME_V1,
  LIVE_SCRATCH_SUPERVISOR_HEALTH_MAX_BYTES_V1,
  liveScratchSupervisorActivationIsImplementedV1,
  liveScratchSupervisorTrustedParentForCurrentPlatformV1,
} from '../../../scripts/evals/qualification/live-scratch-supervisor-health-v1';
import { installFreshLiveScratchSupervisorHealthV1 } from './fixtures/live-scratch-supervisor-health';

const NOW_MS = Date.parse('2026-08-06T00:00:00.000Z');

function withLedgerRoot(testBody: (ledgerRoot: string) => void): void {
  const ledgerRoot = mkdtempSync(join(tmpdir(), 'kite-live-scratch-supervisor-health-'));
  try {
    testBody(ledgerRoot);
  } finally {
    rmSync(ledgerRoot, { recursive: true, force: true });
  }
}

function healthPath(ledgerRoot: string): string {
  return join(
    ledgerRoot,
    LIVE_SCRATCH_SUPERVISOR_DIRECTORY_NAME_V1,
    LIVE_SCRATCH_SUPERVISOR_HEALTH_FILE_NAME_V1,
  );
}

describe('future live scratch supervisor health shape', () => {
  test('validates only a bounded owner-only future record and never activates L3 itself', () => {
    withLedgerRoot((ledgerRoot) => {
      installFreshLiveScratchSupervisorHealthV1(ledgerRoot, NOW_MS);
      expect(hasFreshLiveScratchSupervisorHealthV1({ ledgerRoot, nowMs: NOW_MS })).toBe(true);
      // This source-literal false is the production authority boundary. A
      // writable local witness is intentionally not an activation credential.
      expect(liveScratchSupervisorActivationIsImplementedV1()).toBe(false);
    });
  });

  test('rejects forged, expired, oversized, mode-incorrect, and symlink records', () => {
    withLedgerRoot((ledgerRoot) => {
      installFreshLiveScratchSupervisorHealthV1(ledgerRoot, NOW_MS);
      const path = healthPath(ledgerRoot);

      const forged = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      forged.recordDigest = `sha256:${'0'.repeat(64)}`;
      writeFileSync(path, JSON.stringify(forged));
      expect(hasFreshLiveScratchSupervisorHealthV1({ ledgerRoot, nowMs: NOW_MS })).toBe(false);

      const trustedScratchParent = liveScratchSupervisorTrustedParentForCurrentPlatformV1();
      if (!trustedScratchParent)
        throw new Error('test_platform_without_live_scratch_supervisor_parent');
      const expired = buildLiveScratchSupervisorHealthV1({
        schema: 'LiveScratchSupervisorHealthV1',
        version: 1,
        supervisorId: 'qualification-live-scratch-supervisor-v1',
        trustedScratchParent,
        state: 'healthy',
        observedAtMs: NOW_MS - 60_000,
        expiresAtMs: NOW_MS - 1,
      });
      writeFileSync(path, JSON.stringify(expired));
      chmodSync(path, 0o600);
      expect(hasFreshLiveScratchSupervisorHealthV1({ ledgerRoot, nowMs: NOW_MS })).toBe(false);

      writeFileSync(path, 'x'.repeat(LIVE_SCRATCH_SUPERVISOR_HEALTH_MAX_BYTES_V1 + 1));
      chmodSync(path, 0o600);
      expect(hasFreshLiveScratchSupervisorHealthV1({ ledgerRoot, nowMs: NOW_MS })).toBe(false);
    });
  });

  test('rejects mode, link, and foreign-owner roots without exposing filesystem details', () => {
    withLedgerRoot((ledgerRoot) => {
      installFreshLiveScratchSupervisorHealthV1(ledgerRoot, NOW_MS);
      const path = healthPath(ledgerRoot);
      chmodSync(path, 0o644);
      expect(hasFreshLiveScratchSupervisorHealthV1({ ledgerRoot, nowMs: NOW_MS })).toBe(false);

      chmodSync(path, 0o600);
      const target = join(ledgerRoot, 'health-target.json');
      writeFileSync(target, readFileSync(path));
      unlinkSync(path);
      symlinkSync(target, path);
      expect(hasFreshLiveScratchSupervisorHealthV1({ ledgerRoot, nowMs: NOW_MS })).toBe(false);
    });

    const foreignOwnedRoot = process.platform === 'darwin' ? '/private/tmp' : '/var/tmp';
    expect(
      hasFreshLiveScratchSupervisorHealthV1({ ledgerRoot: foreignOwnedRoot, nowMs: NOW_MS }),
    ).toBe(false);
  });
});
