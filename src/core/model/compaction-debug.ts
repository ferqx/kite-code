import { spawnSync } from 'node:child_process';
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
import type { ContextCompactionReason } from '@/core/runtime/context-compaction';
import type { CompactionReporter } from './compaction-metrics';

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
export function secureWindowsOwnerOnlyPath(path: string): void {
  const account =
    process.env.USERDOMAIN && process.env.USERNAME
      ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
      : process.env.USERNAME;
  if (!account) throw new Error('Cannot resolve the current Windows account for debug ACL.');
  const script = `
$item = Get-Item -LiteralPath $env:KITE_COMPACTION_DEBUG_ACL_PATH -Force
$acl = Get-Acl -LiteralPath $item.FullName
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
$inheritance = if ($item.PSIsContainer) {
  [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.SetOwner($identity)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $item.FullName -AclObject $acl
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, KITE_COMPACTION_DEBUG_ACL_PATH: path },
    },
  );
  if (result.status !== 0) {
    throw new Error('Failed to apply the owner-only, non-inheriting Windows debug ACL.');
  }
}

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
