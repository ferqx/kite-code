import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  secureWindowsOwnerOnlyPath,
  writeLocalCompactionDebugRecord,
} from '@kite/builtin-runtime/model';

describe('local compaction debug', () => {
  test('is opt-in, atomic, redacted, owner-only, and session-isolated', () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-debug-'));
    const windowsAcl = process.platform === 'win32' ? secureWindowsOwnerOnlyPath : undefined;
    try {
      expect(
        writeLocalCompactionDebugRecord({
          enabled: false,
          directory: join(root, 'disabled'),
          sessionId: 'session-a',
          record: { compactionId: 'c', reason: 'manual', outcome: 'completed' },
        }),
      ).toBeUndefined();
      const first = writeLocalCompactionDebugRecord({
        enabled: true,
        directory: join(root, 'enabled'),
        sessionId: 'session-a',
        secureWindowsPath: windowsAcl,
        record: {
          compactionId: 'c',
          reason: 'manual',
          outcome: 'completed',
          tokensBefore: 10_000,
          tokensAfter: 4_000,
        },
      })!;
      const second = writeLocalCompactionDebugRecord({
        enabled: true,
        directory: join(root, 'enabled'),
        sessionId: 'session-b',
        secureWindowsPath: windowsAcl,
        record: { compactionId: 'd', reason: 'auto', outcome: 'failed' },
      })!;
      expect(first).not.toBe(second);
      expect(readFileSync(first, 'utf8')).not.toContain('summary');
      if (process.platform !== 'win32') {
        expect(lstatSync(join(root, 'enabled')).mode & 0o777).toBe(0o700);
        expect(lstatSync(first).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires Windows ACL support and rejects symlink directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-debug-symlink-'));
    try {
      const real = join(root, 'real');
      const link = join(root, 'link');
      writeLocalCompactionDebugRecord({
        enabled: true,
        directory: real,
        sessionId: 'session',
        secureWindowsPath: process.platform === 'win32' ? secureWindowsOwnerOnlyPath : undefined,
        record: { compactionId: 'c', reason: 'manual', outcome: 'completed' },
      });
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(() =>
        writeLocalCompactionDebugRecord({
          enabled: true,
          directory: link,
          sessionId: 'session',
          record: { compactionId: 'c', reason: 'manual', outcome: 'completed' },
        }),
      ).toThrow(/symbolic link|reparse point/);
      expect(() =>
        writeLocalCompactionDebugRecord({
          enabled: true,
          directory: join(root, 'windows'),
          sessionId: 'session',
          platform: 'win32',
          record: { compactionId: 'c', reason: 'manual', outcome: 'completed' },
        }),
      ).toThrow(/owner-only ACL/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('applies the Windows ACL callback to both directory and atomically renamed file', () => {
    const root = mkdtempSync(join(tmpdir(), 'compaction-debug-windows-'));
    const secured: string[] = [];
    try {
      const directory = join(root, 'secure');
      const target = writeLocalCompactionDebugRecord({
        enabled: true,
        directory,
        sessionId: 'session',
        platform: 'win32',
        secureWindowsPath: (path) => secured.push(path),
        record: { compactionId: 'c', reason: 'manual', outcome: 'completed' },
      });
      expect(target).toBeDefined();
      if (!target) throw new Error('Expected a debug record path.');
      expect(secured).toEqual([directory, target]);
      expect(target).not.toEndWith('.tmp');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'win32')(
    'applies a real owner-only non-inheriting ACL on Windows with bounded native invocations',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'compaction-debug-real-acl-'));
      try {
        expect(() => secureWindowsOwnerOnlyPath(root)).not.toThrow();
        const script = `
$acl = Get-Acl -LiteralPath $env:KITE_ACL_TEST_PATH
if (-not $acl.AreAccessRulesProtected) { exit 2 }
$allow = @($acl.Access | Where-Object { $_.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow })
if ($allow.Count -ne 1) { exit 3 }
if (($allow[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq 0) { exit 4 }
`;
        const result = spawnSync(
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ],
          {
            env: {
              ...process.env,
              KITE_ACL_TEST_PATH: root,
              PSModulePath: join(
                process.env.SystemRoot ?? 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'Modules',
              ),
            },
          },
        );
        expect(result.status).toBe(0);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
