import { createHash } from 'node:crypto';
import type { ContextCompactionAutoMode } from './context-compaction-decision';

/** Stable 0..9999 session bucket. Changing the salt intentionally reassigns cohorts. */
export function contextCompactionCohortBucket(cohortSalt: string, sessionId: string): number {
  const digest = createHash('sha256').update(`${cohortSalt}\0${sessionId}`).digest();
  return digest.readUInt32BE(0) % 10_000;
}

export function resolveContextCompactionRollout(input: {
  masterEnabled: boolean;
  configuredMode?: ContextCompactionAutoMode;
  cohortSalt?: string;
  sessionId: string;
  livePercentage?: number;
}): ContextCompactionAutoMode {
  if (!input.masterEnabled) return 'off';
  const mode = input.configuredMode ?? 'off';
  if (mode !== 'live') return mode;
  const percentage = Math.max(0, Math.min(100, input.livePercentage ?? 100));
  if (percentage === 100) return 'live';
  if (percentage === 0) return 'shadow';
  const bucket = contextCompactionCohortBucket(input.cohortSalt ?? 'default', input.sessionId);
  return bucket < percentage * 100 ? 'live' : 'shadow';
}
