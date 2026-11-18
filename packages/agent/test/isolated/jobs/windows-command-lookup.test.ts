import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
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
  'Windows Shell reports actual lookup misses regardless of the final script exit code',
  async () => {
    const root = temporaryDirectory('kite-command-lookup-');
    const prefix = `kite-lookup-${crypto.randomUUID()}`;
    const pathName = `${prefix}-path`;
    const portableName = `${prefix}-portable`;
    const appName = `${prefix}-app`;
    const missingName = `${prefix}-missing`;
    const appKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${appName}.exe`;
    let registration: string | undefined;
    try {
      const [assets, system, preferred] = await Promise.all([
        windowsShellFixture(),
        discoverWindowsPowerShell(),
        discoverPreferredWindowsPowerShell(),
      ]);
      const pathDirectory = join(root, 'on-path');
      const toolDirectory = join(root, '便携 工具');
      const appDirectory = join(root, 'registered');
      for (const path of [pathDirectory, toolDirectory, appDirectory]) mkdirSync(path);
      const source = join(root, 'Probe.cs');
      const executable = join(root, 'probe.exe');
      writeFileSync(
        source,
        'class Probe { static void Main() { System.Console.WriteLine("local-tool-ok"); } }',
      );
      const compiler = join(
        dirname(system.systemDirectory),
        'Microsoft.NET',
        'Framework64',
        'v4.0.30319',
        'csc.exe',
      );
      const compiled = Bun.spawnSync([compiler, '/nologo', `/out:${executable}`, source], {
        windowsHide: true,
      });
      expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
      const portable = join(toolDirectory, `${portableName}.exe`);
      const registered = join(appDirectory, `${appName}.exe`);
      for (const path of [join(pathDirectory, `${pathName}.exe`), portable, registered])
        copyFileSync(executable, path);

      const reg = join(system.systemDirectory, 'reg.exe');
      const absent = Bun.spawnSync([reg, 'query', appKey, '/reg:64'], { windowsHide: true });
      expect(absent.exitCode).toBe(1);
      const added = Bun.spawnSync(
        [reg, 'add', appKey, '/ve', '/t', 'REG_SZ', '/d', registered.slice(0, -4), '/f', '/reg:64'],
        { windowsHide: true },
      );
      expect(added.exitCode, added.stderr.toString()).toBe(0);
      registration = reg;

      const backends = [
        ...(preferred.executable.canonical === system.executable.canonical
          ? [system]
          : [system, preferred]),
        undefined,
      ];
      for (const [index, powerShell] of backends.entries()) {
        const label = powerShell ? `PowerShell ${powerShell.version}` : 'Git Shell';
        const cwd = join(root, `work-${index}`);
        const controlBase = join(root, `control-${index}`);
        const stateRoot = join(root, `state-${index}`);
        for (const path of [cwd, controlBase, stateRoot]) mkdirSync(path);
        const job = await createWindowsShellJob({
          ...(powerShell
            ? {
                kind: 'powershell' as const,
                powerShell,
                shellExecutable: powerShell.executable.canonical,
              }
            : { shellExecutable: assets.shell, fullShellExecutable: assets.fullShell }),
          cwd,
          workspaceRoot: cwd,
          controlBase,
          stateRoot,
          supervisorPath: assets.runner,
          env: {
            PATH: `${pathDirectory};${system.systemDirectory}`,
            KITE_SHELL_TOOL_DIRS: `"${toolDirectory}"`,
          },
          executionScope: () => ({ filesystem: 'full_access', network: 'internet' }),
        });
        async function run(command: string) {
          const handle = await job.start(
            { command },
            {
              executionId: crypto.randomUUID(),
              sessionId: `lookup-${index}`,
              signal: AbortSignal.timeout(10000),
            },
          );
          let result: ToolResult | undefined;
          let stdout = '',
            stderr = '';
          try {
            for await (const event of job.observe(handle)) {
              if (event.type === 'terminal') result = event.result;
              if (event.type === 'output' && event.stream === 'stdout') stdout += event.content;
              if (event.type === 'output' && event.stream === 'stderr') stderr += event.content;
            }
          } finally {
            await job.dispose(handle);
          }
          expect(result, `${label}\n${stderr}`).toMatchObject({
            details: { cleanupConfirmed: true },
          });
          return {
            details: result!.details as Record<string, unknown>,
            outcome: result!.outcome,
            stdout,
            stderr,
          };
        }
        const lookup = (name: string) => (powerShell ? `Get-Command '${name}'` : name);
        const before = await run(pathName);
        expect(before.details.exitCode, label).toBe(0);
        expect(before.stdout, label).toContain('local-tool-ok');
        expect(before.details.commandLookup).toBeUndefined();

        expect((await run(lookup(portableName))).details, label).toMatchObject({
          exitCode: 127,
          commandLookup: {
            name: portableName,
            candidates: [{ path: portable, source: 'configured_directory' }],
          },
        });
        const candidate = {
          name: portableName,
          candidates: [{ path: portable, source: 'configured_directory' }],
        };
        const handled = powerShell
          ? `$tool = Get-Command '${portableName}' -ErrorAction SilentlyContinue; if (!$tool) { Write-Output 'missing'; exit 2 }`
          : `type -a '${portableName}' || true`;
        const handledResult = await run(handled);
        expect(handledResult, label).toMatchObject({
          outcome: powerShell ? 'failed' : 'succeeded',
          details: { exitCode: powerShell ? 2 : 0, commandLookup: candidate },
        });
        if (powerShell) {
          expect(handledResult.stdout.trim()).toBe('missing');
          expect(
            (await run(`Get-Command '${portableName}' -ErrorAction Ignore; Write-Output 'ignored'`))
              .details,
            label,
          ).not.toHaveProperty('commandLookup');
        } else {
          expect(handledResult.stderr).toContain(`type: ${portableName}: not found`);
          const invocation = await run(`${portableName} || true`);
          expect(invocation.details, label).toMatchObject({
            exitCode: 0,
            commandLookup: candidate,
          });
          for (const [command, exitCode] of [
            [`command -v '${portableName}'`, 1],
            [`command -v -- "${portableName}" || true`, 0],
          ] as const) {
            const silent = await run(command);
            expect(silent, label).toMatchObject({
              stdout: '',
              stderr: '',
              details: { exitCode, commandLookup: candidate },
            });
          }
          const hit = await run(`command -v "${pathName}" || true`);
          expect(hit.stdout, label).toContain(pathName);
          expect(hit.details.commandLookup, label).toBeUndefined();
          const hidden = await run(`command -v "${pathName}" >/dev/null || true`);
          expect(hidden.stdout, label).toBe('');
          expect(hidden.details.commandLookup, label).toBeUndefined();
        }
        const absolute = powerShell
          ? `& '${portable.replaceAll("'", "''")}'`
          : `'${portable.replaceAll('\\', '/')}'`;
        const verified = await run(absolute);
        expect(verified.details.exitCode, label).toBe(0);
        expect(verified.stdout, label).toContain('local-tool-ok');

        expect((await run(lookup(appName))).details, label).toMatchObject({
          exitCode: 127,
          commandLookup: {
            name: appName,
            candidates: [{ path: registered, source: 'user_app_paths' }],
          },
        });
        expect((await run(lookup(missingName))).details, label).toMatchObject({
          exitCode: 127,
          commandLookup: { name: missingName, candidates: [] },
        });
        for (const code of [2, 127]) {
          const explicit = await run(`exit ${code}`);
          expect(explicit.details.exitCode, label).toBe(code);
          expect(explicit.details.commandLookup).toBeUndefined();
        }
      }
    } finally {
      try {
        if (registration) {
          const removed = Bun.spawnSync([registration, 'delete', appKey, '/f', '/reg:64'], {
            windowsHide: true,
          });
          expect(removed.exitCode, removed.stderr.toString()).toBe(0);
        }
      } finally {
        removeTemporaryDirectory(root);
      }
    }
  },
  90000,
);
