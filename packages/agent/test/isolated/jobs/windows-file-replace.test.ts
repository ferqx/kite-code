import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import type { ToolResult } from '../../../src/extensions';
import {
  discoverWindowsPowerShell,
  discoverWindowsPowerShell7,
} from '../../../src/jobs/windows-powershell';
import { createWindowsShellJob } from '../../../src/jobs/windows-shell';
import { windowsShellFixture } from '../../fixtures/windows-shell-runtime';

const native = process.platform === 'win32' ? test : test.skip;

native(
  'Workspace file replacement preserves ACLs without granting directory or external WRITE_DAC',
  async () => {
    const root = temporaryDirectory('kite-windows-file-replace-');
    try {
      const workspace = join(root, 'workspace');
      const controlBase = join(root, 'control');
      const stateRoot = join(root, 'sandbox');
      for (const path of [workspace, controlBase, stateRoot, join(workspace, 'nested')])
        mkdirSync(path);
      const outside = join(root, 'outside.txt');
      writeFileSync(outside, 'outside');
      // These files predate the first Workspace preparation.
      writeFileSync(join(workspace, 'nested', 'original.txt'), 'original');
      writeFileSync(join(workspace, 'nested', 'replacement.txt'), 'replacement');
      const [assets, system, seven] = await Promise.all([
        windowsShellFixture(),
        discoverWindowsPowerShell(),
        discoverWindowsPowerShell7().catch((error: unknown) => {
          if (error instanceof Error && error.message === 'windows_powershell7_unavailable')
            return undefined;
          throw error;
        }),
      ]);
      const source = join(workspace, 'FileReplaceProbe.cs');
      const executable = join(workspace, 'FileReplaceProbe.exe');
      writeFileSync(
        source,
        `
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal static class FileReplaceProbe {
    private static string stage = "directory-access";
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern SafeFileHandle CreateFileW(
        string path, uint access, uint share, IntPtr security,
        uint disposition, uint flags, IntPtr template);

    private static int Access(string path) {
        using (var handle = CreateFileW(path, 0x40000, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
            return handle.IsInvalid ? Marshal.GetLastWin32Error() : 0;
        }
    }

    private static void Require(bool condition, string reason) {
        if (!condition) throw new InvalidOperationException(reason);
    }

    private static void RequireDeniedReplacement(string source, string target) {
        try {
            File.Replace(source, target, null);
            throw new InvalidOperationException("Replacement escaped the filesystem scope");
        } catch (Exception error) {
            Require(error is IOException || error is UnauthorizedAccessException,
                "Unexpected replacement failure");
            Require(File.Exists(source), "Denied replacement consumed its source");
            Console.WriteLine("scope-denial=" + (error.HResult & 0xffff));
        }
    }

    public static int Main(string[] args) {
        try {
            return Run(args);
        } catch (Exception error) {
            Console.WriteLine("failed-stage=" + stage);
            Console.WriteLine("failed-code=" + (error.HResult & 0xffff));
            if (error is InvalidOperationException) Console.WriteLine(error.Message);
            return 1;
        }
    }

    private static int Run(string[] args) {
        string target = Path.GetFullPath("nested/original.txt");
        string replacement = Path.GetFullPath("nested/replacement.txt");
        Require(Access(Path.GetFullPath(".")) == 5, "Workspace directory WRITE_DAC");
        Require(Access(Path.GetFullPath("nested")) == 5, "Nested directory WRITE_DAC");
        Require(Access(args[0]) == 5, "External file WRITE_DAC");
        if (args.Length == 2) {
            stage = "read-only-replacement";
            Require(Access(target) == 5, "Read-only Job acquired WRITE_DAC");
            RequireDeniedReplacement(replacement, target);
            Console.WriteLine("read-only-denied");
            return 0;
        }
        stage = "external-source-access";
        Require(Access(replacement) == 0, "Replacement file WRITE_DAC");
        string externalAttempt = Path.GetFullPath("nested/external-attempt.txt");
        stage = "external-source-create";
        File.WriteAllText(externalAttempt, "external-attempt");
        stage = "external-replacement";
        RequireDeniedReplacement(externalAttempt, args[0]);
        stage = "external-target-read";
        Require(File.ReadAllText(args[0]) == "outside", "External target changed");
        Console.WriteLine("external-replacement-denied");
        stage = "destination-acl";
        var before = File.GetAccessControl(target).GetSecurityDescriptorBinaryForm();
        stage = "held-replacement";
        using (var held = File.Open(target, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
            try {
                File.Replace(replacement, target, null);
                throw new InvalidOperationException("Replaced a file held without delete sharing");
            } catch (IOException error) {
                Require((error.HResult & 0xffff) == 32, "Unexpected held-file error");
            }
        }
        Require(File.ReadAllText(target) == "original", "Held target was modified");
        Require(File.ReadAllText(replacement) == "replacement", "Held source was modified");
        stage = "released-replacement";
        File.Replace(replacement, target, null);
        Require(File.ReadAllText(target) == "replacement", "Replacement did not commit");
        var after = File.GetAccessControl(target).GetSecurityDescriptorBinaryForm();
        Require(Convert.ToBase64String(before) == Convert.ToBase64String(after), "Destination ACL changed");
        Require(!File.Exists(replacement), "Replacement source remains");
        // Newly created files inherit the same grant after the initial preparation.
        stage = "new-source-replacement";
        File.WriteAllText(target, "original");
        File.WriteAllText(replacement, "replacement");
        Require(Access(replacement) == 0, "New replacement file WRITE_DAC");
        File.Replace(replacement, target, null);
        Require(File.ReadAllText(target) == "replacement", "Second replacement did not commit");
        Console.WriteLine("replaced-with-acl");
        return 0;
    }
}`,
      );
      const compiler = join(
        dirname(system.systemDirectory),
        'Microsoft.NET',
        'Framework64',
        'v4.0.30319',
        'csc.exe',
      );
      const compiled = Bun.spawnSync(
        [compiler, '/nologo', '/optimize+', `/out:${executable}`, source],
        { windowsHide: true },
      );
      expect(compiled.exitCode, compiled.stdout.toString() + compiled.stderr.toString()).toBe(0);
      for (const backend of ['powershell-5.1', 'powershell-7', 'git-bash'] as const) {
        const powerShell = backend === 'powershell-7' ? seven : system;
        if (!powerShell) continue;
        const quote = (path: string) =>
          backend === 'git-bash'
            ? `'${path.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`
            : `'${path.replaceAll("'", "''")}'`;
        for (const filesystem of ['workspace_write', 'read_only'] as const) {
          writeFileSync(join(workspace, 'nested', 'original.txt'), 'original');
          writeFileSync(join(workspace, 'nested', 'replacement.txt'), 'replacement');
          const job = await createWindowsShellJob({
            ...(backend === 'git-bash'
              ? { shellExecutable: assets.shell, fullShellExecutable: assets.fullShell }
              : {
                  kind: 'powershell' as const,
                  shellExecutable: powerShell.executable.canonical,
                  powerShell,
                }),
            cwd: workspace,
            workspaceRoot: workspace,
            controlBase,
            stateRoot,
            supervisorPath: assets.runner,
            env: { PATH: system.systemDirectory, USERPROFILE: root },
            executionScope: () => ({ filesystem, network: 'none' }),
          });
          const invocation = `${backend === 'git-bash' ? '' : '& '}${quote(executable)} ${quote(outside)}`;
          const handle = await job.start(
            { command: invocation + (filesystem === 'read_only' ? ' read-only' : '') },
            {
              executionId: crypto.randomUUID(),
              sessionId: backend,
              signal: AbortSignal.timeout(10000),
            },
          );
          let result: ToolResult | undefined;
          let output = '';
          try {
            for await (const event of job.observe(handle)) {
              if (event.type === 'output') output += event.content;
              if (event.type === 'terminal') result = event.result;
            }
          } finally {
            await job.dispose(handle);
          }
          expect(readFileSync(outside, 'utf8')).toBe('outside');
          expect(result, `${backend} ${filesystem}\n${output}`).toMatchObject({
            outcome: 'succeeded',
            details: { exitCode: 0, cleanupConfirmed: true, processTreeStopped: true },
          });
          expect(output).toContain(
            filesystem === 'read_only' ? 'read-only-denied' : 'replaced-with-acl',
          );
          expect(readFileSync(join(workspace, 'nested', 'original.txt'), 'utf8')).toBe(
            filesystem === 'read_only' ? 'original' : 'replacement',
          );
        }
      }
    } finally {
      removeTemporaryDirectory(root);
    }
  },
  60000,
);
