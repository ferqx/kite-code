import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildLiveScratchSupervisorHealthV1,
  LIVE_SCRATCH_SUPERVISOR_DIRECTORY_NAME_V1,
  LIVE_SCRATCH_SUPERVISOR_HEALTH_FILE_NAME_V1,
  liveScratchSupervisorTrustedParentForCurrentPlatformV1,
} from '../../../../scripts/evals/qualification/live-scratch-supervisor-health-v1';
import { canonicalJson } from '../../../../scripts/release/canonical-json';

export function installFreshLiveScratchSupervisorHealthV1(ledgerRoot: string, nowMs: number): void {
  const trustedScratchParent = liveScratchSupervisorTrustedParentForCurrentPlatformV1();
  if (!trustedScratchParent)
    throw new Error('test_platform_without_live_scratch_supervisor_parent');
  const directory = join(ledgerRoot, LIVE_SCRATCH_SUPERVISOR_DIRECTORY_NAME_V1);
  mkdirSync(directory, { mode: 0o700 });
  chmodSync(directory, 0o700);
  const health = buildLiveScratchSupervisorHealthV1({
    schema: 'LiveScratchSupervisorHealthV1',
    version: 1,
    supervisorId: 'qualification-live-scratch-supervisor-v1',
    trustedScratchParent,
    state: 'healthy',
    observedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 30_000,
  });
  const file = join(directory, LIVE_SCRATCH_SUPERVISOR_HEALTH_FILE_NAME_V1);
  writeFileSync(file, canonicalJson(health), { mode: 0o600, flag: 'wx' });
  chmodSync(file, 0o600);
}
