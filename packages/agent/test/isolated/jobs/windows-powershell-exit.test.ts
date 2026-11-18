import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  privateDirectory,
  removeTemporaryDirectory,
  temporaryDirectory,
} from '../../../../../tests/fixtures/test-filesystem';
import type { JobContext, ToolResult } from '../../../src/extensions';
import {
  discoverPreferredWindowsPowerShell,
  discoverWindowsPowerShell,
} from '../../../src/jobs/windows-powershell';
import { createWindowsShellJob } from '../../../src/jobs/windows-shell';

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'installed PowerShell editions preserve trailing failure, handled status, return paths and script scope in the owned Job',
  async () => {
    const root = temporaryDirectory('kite-powershell-exit-');
    const workspace = join(root, 'workspace');
    const controlBase = join(root, 'control');
    const stateRoot = join(root, 'state');
    for (const path of [workspace, controlBase, stateRoot]) privateDirectory(path);
    const cases = [
      { command: 'cmd.exe /d /c exit 23', code: 23, stockCode: 1 },
      { command: "Write-Output 'before'; cmd.exe /d /c exit 23", code: 1 },
      { command: "cmd.exe /d /c exit 23; Write-Output 'handled'", code: 0 },
      { command: "Write-Output 'before'; cmd.exe /d /c exit 23; exit $LASTEXITCODE", code: 23 },
      { command: 'cmd.exe /d /c exit 23; return', code: 1 },
      { command: "Write-Output 'before' | cmd.exe /d /c exit 23", code: 1 },
      { command: "cmd.exe /d /c exit 23 | Write-Output 'handled'", code: 1 },
      { command: "param(); Write-Output 'before'; cmd.exe /d /c exit 23", code: 1 },
      { command: "begin { Write-Output 'begin' } end { cmd.exe /d /c exit 23 }", code: 1 },
      { command: 'function Invoke-Handled { cmd.exe /d /c exit 23 }; Invoke-Handled', code: 0 },
      { command: 'cmd.exe /d /c exit 23; if($LASTEXITCODE -eq 23){Write-Output handled}', code: 0 },
      { command: '$false', code: 0 },
      {
        command:
          "$script:items=[Collections.Generic.List[string]]::new(); function Add-Item { $script:items.Add('scope') }; Add-Item; $items.Count",
        code: 0,
        output: '1',
      },
      {
        command:
          "class ExitProbe { static [string] Name() { return 'class scope' } }; [ExitProbe]::Name()",
        code: 0,
        output: 'class scope',
      },
      {
        command: "trap { continue }; throw 'handled'; Write-Output 'after trap'",
        code: 0,
        output: 'after trap',
      },
      {
        command: "using namespace System.Text\n[StringBuilder]::new('namespace').ToString()",
        code: 0,
        output: 'namespace',
      },
      {
        command:
          "#requires -Version 5.1\nparam()\nWrite-Output 'requirements'; cmd.exe /d /c exit 23",
        code: 1,
        output: 'requirements',
      },
    ];
    try {
      const shells = [
        await discoverWindowsPowerShell(),
        await discoverPreferredWindowsPowerShell(),
      ];
      const seen = new Set<string>();
      for (const powerShell of shells) {
        if (seen.has(powerShell.executable.canonical)) continue;
        seen.add(powerShell.executable.canonical);
        const samples = [...cases];
        const cleanBlock = spawnSync(
          powerShell.executable.canonical,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "[bool][Management.Automation.Language.ScriptBlockAst].GetProperty('CleanBlock')",
          ],
          { encoding: 'utf8', windowsHide: true, timeout: 10000 },
        );
        expect(cleanBlock.status, cleanBlock.stderr).toBe(0);
        if (cleanBlock.stdout.trim() === 'True')
          samples.push(
            { command: "end { cmd.exe /d /c exit 23 } clean { Write-Output 'cleanup' }", code: 0 },
            { command: "end { Write-Output 'end' } clean { cmd.exe /d /c exit 23 }", code: 1 },
            {
              command: "end { cmd.exe /d /c exit 23; return } clean { Write-Output 'cleanup' }",
              code: 0,
            },
          );
        for (const sample of samples) {
          const stock = spawnSync(
            powerShell.executable.canonical,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', sample.command],
            { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 10000 },
          );
          expect(stock.status, `${powerShell.version}: ${sample.command}\n${stock.stderr}`).toBe(
            sample.stockCode ?? sample.code,
          );
          const job = await createWindowsShellJob({
            kind: 'powershell',
            powerShell,
            cwd: workspace,
            workspaceRoot: workspace,
            controlBase,
            stateRoot,
            shellExecutable: powerShell.executable.canonical,
            supervisorPath: resolve(
              import.meta.dir,
              '../../../dist/platform/process/windows-shell/kite-windows-runner.exe',
            ),
            env: { PATH: powerShell.systemDirectory, USERPROFILE: workspace },
            executionScope: () => ({ filesystem: 'full_access', network: 'none' }),
          });
          const handle = await job.start({ command: sample.command }, {
            executionId: crypto.randomUUID(),
            sessionId: 'exit-status',
            signal: AbortSignal.timeout(10000),
          } as JobContext);
          let terminal: ToolResult | undefined;
          let output = '';
          let errors = '';
          try {
            for await (const event of job.observe(handle)) {
              if (event.type === 'terminal') terminal = event.result;
              if (event.type === 'output') {
                if (event.stream === 'stdout') output += event.content;
                if (event.stream === 'stderr') errors += event.content;
              }
            }
          } finally {
            await job.dispose(handle);
          }
          expect(terminal, `${powerShell.version}: ${sample.command}\n${errors}`).toMatchObject({
            outcome: sample.code === 0 ? 'succeeded' : 'failed',
            details: { exitCode: sample.code, cleanupConfirmed: true, processTreeStopped: true },
          });
          if (sample.output) expect(output.trim()).toBe(sample.output);
        }
      }
    } finally {
      removeTemporaryDirectory(root);
    }
  },
  90000,
);
