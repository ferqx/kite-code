import { expect, test } from 'bun:test';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import type { ToolResult } from '../../../src/extensions';
import {
  discoverPreferredWindowsPowerShell,
  discoverWindowsPowerShell,
} from '../../../src/jobs/windows-powershell';
import { createWindowsShellJob } from '../../../src/jobs/windows-shell';
import { windowsShellFixture } from '../../fixtures/windows-shell-runtime';

const native = process.platform === 'win32' && process.arch === 'x64' ? test : test.skip;

native(
  'An owned Shell child releases its file at Job exit and the next Job can replace it',
  async () => {
    const root = temporaryDirectory('kite-windows-shell-cleanup-');
    try {
      const [assets, system, preferred] = await Promise.all([
        windowsShellFixture(),
        discoverWindowsPowerShell(),
        discoverPreferredWindowsPowerShell(),
      ]);
      const source = join(root, 'FileLockProbe.cs');
      const executable = join(root, 'file-lock-probe.exe');
      writeFileSync(
        source,
        `
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

internal static class FileLockProbe {
    public static int Main(string[] args) {
        if (args[0] == "hold") {
            using (File.Open("target.txt", FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
                File.WriteAllText("holder.pid.tmp", Process.GetCurrentProcess().Id.ToString());
                File.Move("holder.pid.tmp", "holder.pid");
                Thread.Sleep(20000);
            }
            return 0;
        }
        Console.Error.WriteLine("kite-windows-runner[cleanup]: {}");
        try {
            File.Replace("replacement.txt", "target.txt", null);
            return 0;
        } catch (IOException error) {
            int code = error.HResult & 0xffff;
            Console.Error.WriteLine("Win32=" + code);
            return code;
        }
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

      const powerShells = [system];
      if (preferred.executable.canonical !== system.executable.canonical)
        powerShells.push(preferred);
      const backends = [...powerShells, undefined];
      for (const [index, powerShell] of backends.entries()) {
        const backend = powerShell ? `PowerShell ${powerShell.version}` : 'Git Shell';
        const workspace = join(root, `workspace-${index}`);
        const controlBase = join(root, `control-${index}`);
        const stateRoot = join(root, `sandbox-${index}`);
        for (const path of [workspace, controlBase, stateRoot]) mkdirSync(path);
        copyFileSync(executable, join(workspace, 'file-lock-probe.exe'));
        const target = join(workspace, 'target.txt');
        const replacement = join(workspace, 'replacement.txt');
        writeFileSync(target, 'original');
        writeFileSync(replacement, 'replacement');
        const job = await createWindowsShellJob({
          ...(powerShell
            ? {
                kind: 'powershell' as const,
                powerShell,
                shellExecutable: powerShell.executable.canonical,
              }
            : { shellExecutable: assets.shell, fullShellExecutable: assets.fullShell }),
          cwd: workspace,
          workspaceRoot: workspace,
          controlBase,
          stateRoot,
          supervisorPath: assets.runner,
          env: { PATH: system.systemDirectory },
          executionScope: () => ({ filesystem: 'full_access', network: 'internet' }),
        });
        const execute = async (command: string) => {
          const handle = await job.start(
            { command },
            {
              executionId: crypto.randomUUID(),
              sessionId: `lock-${index}`,
              signal: AbortSignal.timeout(15000),
            },
          );
          let result: ToolResult | undefined;
          let stderr = '';
          try {
            for await (const event of job.observe(handle)) {
              if (event.type === 'terminal') result = event.result;
              if (event.type === 'output' && event.stream === 'stderr') stderr += event.content;
            }
          } finally {
            await job.dispose(handle);
          }
          return { result, stderr };
        };
        const replace = powerShell
          ? "& '.\\file-lock-probe.exe' replace"
          : './file-lock-probe.exe replace';
        const withHolder = powerShell
          ? [
              "$holder = Start-Process -FilePath (Join-Path (Get-Location).Path 'file-lock-probe.exe') -ArgumentList 'hold' -PassThru -WindowStyle Hidden",
              '$deadline = [DateTime]::UtcNow.AddSeconds(5)',
              "while (!(Test-Path -LiteralPath 'holder.pid')) { if ($holder.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'holder not ready' }; Start-Sleep -Milliseconds 20 }",
              replace,
              'exit $LASTEXITCODE',
            ]
          : [
              'set -euo pipefail',
              './file-lock-probe.exe hold &',
              'for attempt in {1..100}; do [[ -f holder.pid ]] && break; sleep .05; done',
              '[[ -f holder.pid ]]',
              replace,
            ];
        const drained = {
          waitReason: 'process_exited',
          activeAfter: 0,
          stdout: { state: 'eof', handleClosed: true },
          stderr: { state: 'eof', handleClosed: true },
          jobHandleClosed: true,
          aclCleanupConfirmed: true,
          hresults: {
            exitCodeQuery: null,
            terminateJob: null,
            stdoutRead: null,
            stderrRead: null,
            jobClose: null,
          },
        };
        const during = await execute(withHolder.join('\n'));
        expect(during.result, `${backend}\n${during.stderr}`).toMatchObject({
          outcome: 'failed',
          details: {
            exitCode: 32,
            cleanupConfirmed: true,
            processTreeStopped: true,
            nativeCleanup: { ...drained, rootExitCode: 32 },
          },
        });
        const details = during.result?.details as { nativeCleanup?: { activeBefore: number } };
        expect(details.nativeCleanup?.activeBefore, backend).toBeGreaterThan(0);
        expect(during.stderr).toContain('Win32=32');
        expect(during.stderr).toContain('kite-windows-runner[cleanup]: {}');
        expect(readFileSync(join(workspace, 'holder.pid'), 'utf8')).toMatch(/^[1-9]\d*$/u);
        expect(readFileSync(target, 'utf8')).toBe('original');
        expect(readFileSync(replacement, 'utf8')).toBe('replacement');

        const next = await execute(replace);
        expect(next.result, `${backend}\n${next.stderr}`).toMatchObject({
          outcome: 'succeeded',
          details: {
            exitCode: 0,
            cleanupConfirmed: true,
            processTreeStopped: true,
            nativeCleanup: { ...drained, rootExitCode: 0 },
          },
        });
        expect(readFileSync(target, 'utf8')).toBe('replacement');
        expect(existsSync(replacement)).toBe(false);
      }
    } finally {
      removeTemporaryDirectory(root);
    }
  },
  60000,
);
