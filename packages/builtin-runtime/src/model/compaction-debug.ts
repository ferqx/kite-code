import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { CompactionReporter, ContextCompactionReason } from './compaction-metrics';
import { secureWindowsOwnerOnlyPath as secureWindowsSessionOwnerOnlyPath } from './secure-storage';

export interface LocalCompactionDebugRecord {
  compactionId: string;
  reason: ContextCompactionReason;
  outcome: 'completed' | 'failed' | 'cancelled' | 'stale';
  tokensBefore?: number;
  tokensAfter?: number;
  durationMs?: number;
  errorKind?: string;
}

/** Apply a non-inheriting ACL granting full control only to the current Windows user. */
export const secureWindowsOwnerOnlyPath = secureWindowsSessionOwnerOnlyPath;

export function createLocalCompactionDebugReporter(input: {
  enabled: boolean;
  directory: string;
  sessionId: string;
}): CompactionReporter {
  const write = (record: LocalCompactionDebugRecord) =>
    writeLocalCompactionDebugRecord({
      ...input,
      record,
      ...(process.platform === 'win32' ? { secureWindowsPath: secureWindowsOwnerOnlyPath } : {}),
    });
  return {
    recordRequested() {},
    recordCompleted(result) {
      write({
        compactionId: result.compactionId,
        reason: result.reason,
        outcome: 'completed',
        tokensBefore: result.tokensBefore,
        tokensAfter: result.tokensAfter,
        durationMs: result.durationMs,
      });
    },
    recordFailed(result) {
      if (!result) return;
      write({
        compactionId: result.compactionId,
        reason: result.reason,
        outcome: result.errorKind === 'summary_aborted' ? 'cancelled' : 'failed',
        durationMs: result.durationMs,
        errorKind: result.errorKind,
      });
    },
  };
}

/** Writes redacted metadata only. Summary, transcript, prompts, and tool output are not accepted. */
export function writeLocalCompactionDebugRecord(input: {
  enabled: boolean;
  directory: string;
  sessionId: string;
  record: LocalCompactionDebugRecord;
  platform?: NodeJS.Platform;
  /** Required on Windows; implementation must apply owner-only ACL with inheritance disabled. */
  secureWindowsPath?: (path: string) => void;
}): string | undefined {
  if (!input.enabled) return undefined;
  const platform = input.platform ?? process.platform;
  if (existsSync(input.directory) && lstatSync(input.directory).isSymbolicLink()) {
    throw new Error('Compaction debug directory must not be a symbolic link or reparse point.');
  }
  mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') chmodSync(input.directory, 0o700);
  if (platform === 'win32' && !input.secureWindowsPath) {
    throw new Error('Windows compaction debug requires an owner-only ACL implementation.');
  }
  input.secureWindowsPath?.(input.directory);

  const sessionKey = createHash('sha256').update(input.sessionId).digest('hex').slice(0, 16);
  const name = `${sessionKey}-${Date.now()}-${randomUUID()}.json`;
  const target = join(input.directory, name);
  const temporary = `${target}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(input.record)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    if (platform !== 'win32') chmodSync(target, 0o600);
    input.secureWindowsPath?.(target);
    return target;
  } catch (error) {
    if (descriptor != null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
