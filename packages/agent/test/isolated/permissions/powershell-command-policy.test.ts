import { expect, test } from 'bun:test';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type AuthorizationRequest, JobStartError } from '../../../src/extensions';
import { ripgrepAsset } from '../../../src/jobs/ripgrep';
import { discoverWindowsPowerShell } from '../../../src/jobs/windows-powershell';
import { createPermissionPolicy } from '../../../src/permissions';
import {
  createPowerShellCommandPolicy,
  powerShellScopeDenial,
} from '../../../src/permissions/powershell-command-policy';
import { createShellConfiguration } from '../../../src/permissions/shell';

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'Windows PowerShell 5.1 classifies exact effects without executing the input',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-powershell-policy-'));
    const workspace = join(root, '中文 空格');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    const junction = join(workspace, 'junction');
    symlinkSync(outside, junction, 'junction');
    const scope = { filesystem: 'workspace_write', network: 'none' };
    try {
      const shell = await discoverWindowsPowerShell();
      const policy = createPowerShellCommandPolicy(shell, workspace, ripgrepAsset());
      const read = await policy.assess(
        "Get-ChildItem -Name; Get-Content -LiteralPath '中文文件.txt' | rg.exe --no-config '你好'",
      );
      expect(read).toMatchObject({
        readOnly: true,
        pinRipgrep: true,
        network: false,
        uncertain: false,
        outsideWrite: false,
        denial: null,
      });

      expect(
        await policy.assess(
          "Microsoft.PowerShell.Management\\Get-Content -LiteralPath 'input.txt'",
        ),
      ).toMatchObject({ readOnly: true, uncertain: false });
      expect(await policy.assess("./Get-Content -LiteralPath 'input.txt'")).toMatchObject({
        readOnly: false,
        uncertain: true,
      });
      for (const program of ['./rg.exe', '.\\rg.exe'])
        expect(await policy.assess(`${program} --files`)).toMatchObject({
          readOnly: false,
          uncertain: true,
        });
      for (const command of [
        'rg.exe --files --glob "*.txt"',
        'rg.exe -n needle -l input.txt',
        'rg.exe -n -g "*.txt" needle . | Select-Object -First 40',
        "Get-Content -LiteralPath 'input.txt' -TotalCount 40",
      ])
        expect(await policy.assess(command), command).toMatchObject({
          readOnly: true,
          uncertain: false,
        });
      for (const command of [
        'rg.exe -e -- --pre helper input.txt',
        'rg.exe -e -- --search-zip input.txt',
        'rg.exe --hostname-bin helper needle input.txt',
        'rg.exe needle input.txt 2> output.txt',
        '#Requires -Modules SomeModule\nGet-Location',
        'Get-Content -LiteralPath "input.txt" | Select-Object -Property @{Expression={Get-Item x}}',
      ])
        expect((await policy.assess(command)).readOnly, command).toBeFalse();
      for (const option of ['-f', '--file']) {
        expect(await policy.assess(`rg.exe ${option} 'patterns.txt' input.txt`)).toMatchObject({
          readOnly: true,
          uncertain: false,
        });
        expect(
          await policy.assess(`rg.exe ${option} '../outside/patterns.txt' input.txt`),
        ).toMatchObject({ readOnly: false, uncertain: true });
      }

      const write = await policy.assess(
        "Set-Content -LiteralPath 'marker.txt' -Value '内容'; '文本' > 'redirected.txt'",
      );
      expect(write.readOnly).toBeFalse();
      expect(powerShellScopeDenial(write, scope)).toBeNull();
      expect(existsSync(join(workspace, 'marker.txt'))).toBeFalse();
      expect(existsSync(join(workspace, 'redirected.txt'))).toBeFalse();

      const external = await policy.assess("Write-Output '内容' > '../outside/result.txt'");
      expect(powerShellScopeDenial(external, scope)).toBe('shell_filesystem_permission_required');
      expect(powerShellScopeDenial(external, { ...scope, filesystem: 'full_access' })).toBeNull();
      expect(
        (await policy.assess("Get-Content -LiteralPath 'junction\\result.txt'")).uncertain,
      ).toBeTrue();

      const internet = await policy.assess(
        "curl -UseBasicParsing 'http://127.0.0.1:8' -OutFile '../outside/body.txt'",
      );
      expect(powerShellScopeDenial(internet, { ...scope, filesystem: 'full_access' })).toBe(
        'shell_network_permission_required',
      );
      expect(powerShellScopeDenial(internet, { ...scope, network: 'internet' })).toBe(
        'shell_filesystem_permission_required',
      );
      expect(
        powerShellScopeDenial(internet, { filesystem: 'full_access', network: 'internet' }),
      ).toBeNull();
      expect(
        (await policy.assess("Write-Output $(Invoke-RestMethod 'http://127.0.0.1:8')")).network,
      ).toBeTrue();
      expect(
        (await policy.assess("Get-ChildItem -LiteralPath '\\\\server\\share'")).network,
      ).toBeTrue();

      for (const script of [
        "& './script.ps1'",
        'Get-ChildItem | Remove-Item',
        "$target = 'marker.txt'; Get-Content $target",
      ])
        expect((await policy.assess(script)).uncertain).toBeTrue();
      expect(await policy.assess("& './with space.ps1' -Count 3")).toMatchObject({
        uncertain: true,
        entryScript: './with space.ps1',
      });
      for (const script of [
        '& $script',
        ". './script.ps1'",
        "& './script.ps1' | Out-String",
        "& './script.ps1'; Get-Location",
        "#Requires -Modules SomeModule\n& './script.ps1'",
      ])
        expect((await policy.assess(script)).entryScript, script).toBeUndefined();
      expect((await policy.assess("Write-Output 'one' && Write-Output 'two'")).denial).toBe(
        'shell_command_syntax_invalid',
      );
      expect((await policy.assess("Start-Process -FilePath 'some.exe'")).denial).toBe(
        'shell_powershell_delegation_unsupported',
      );
      expect((await policy.assess(`rm -Force '${join(shell.systemDirectory, '*')}'`)).denial).toBe(
        'shell_command_hard_denied',
      );
    } finally {
      rmSync(junction);
      rmSync(root, { recursive: true, force: true });
    }
  },
  25000,
);

test.skipIf(process.platform !== 'win32' || process.arch !== 'x64')(
  'PowerShell Job rejects changed reviewed script bytes and path assessments before launch',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'kite-powershell-dispatch-'));
    const workspace = join(root, 'workspace');
    const control = join(root, 'control');
    const stateRoot = join(root, 'sandbox');
    const outside = join(root, 'other');
    const path = join(workspace, 'docs');
    try {
      for (const directory of [workspace, control, stateRoot, outside, path])
        mkdirSync(directory, { mode: 0o700 });
      const powerShell = await discoverWindowsPowerShell();
      const configuration = await createShellConfiguration({
        workspaceRoot: workspace,
        toolIds: ['shell.execute'],
        options: {
          platform: 'win32',
          configurationId: 'powershell-dispatch-fixture',
          supervisorPath: resolve(
            import.meta.dir,
            '../../../dist/platform/process/windows-shell/kite-windows-runner.exe',
          ),
          bunExecutable: process.execPath,
          shellExecutable: powerShell.executable.canonical,
          env: { PATH: powerShell.systemDirectory, USERPROFILE: root },
          windows: { kind: 'powershell', powerShell, stateRoot },
          host: {
            controlBase: control,
            protectedRoots: [],
            readonlyAssets: [],
            runtimeReadOnlyRoots: [],
          },
        },
      });
      const job = configuration.extensions
        .flatMap((extension) => extension.jobs ?? [])
        .find((definition) => definition.id === 'shell.command')!;
      const input = { command: "Get-Content -LiteralPath 'docs/input.txt'" };
      const request: AuthorizationRequest = {
        kind: 'job',
        definitionId: job.id,
        definitionVersion: job.version,
        sessionId: 'session',
        runId: null,
        executionId: 'powershell-dispatch',
        input,
        signal: AbortSignal.timeout(15000),
      };
      const descriptor = (await configuration.describeRequest(request))!;
      expect(descriptor).toMatchObject({ safeRead: true, hardAllowed: true });
      expect(descriptor.commandDigest).toHaveLength(64);
      expect(await configuration.commandDigest(request)).toBe(descriptor.commandDigest!);
      const policy = createPermissionPolicy({
        readPolicy: () => ({
          mode: 'accept_edits',
          workspaceTrust: true,
          revision: 'fixture',
          allowed: [{ kind: 'job', definitionId: job.id, definitionVersion: job.version }],
        }),
        describeCapability: () => ({
          ...configuration.describe(job.id),
          ...descriptor,
          kind: 'job',
          definitionId: job.id,
          definitionVersion: job.version,
          revision: 'fixture',
          hardAllowed: descriptor.hardAllowed === true,
        }),
      });
      const accepted = await policy.authorize(request);
      expect(accepted.allowed).toBeTrue();

      const script = join(path, 'entry.ps1');
      const scriptInput = { command: "& './entry.ps1'", workdir: 'docs' };
      const scriptRequest = { ...request, executionId: 'powershell-script', input: scriptInput };
      const scriptText = "Write-Output 'reviewed'\n";
      writeFileSync(script, scriptText);
      const toolReview = await configuration.prepareRiskReview({
        ...scriptRequest,
        kind: 'tool',
        definitionId: 'shell.execute',
        executionId: 'powershell-script-tool',
      });
      const jobReview = await configuration.prepareRiskReview(scriptRequest);
      expect(toolReview?.fingerprint).toBe(jobReview?.fingerprint);
      expect(jobReview?.material.directScripts).toMatchObject([
        { path: './entry.ps1', resolvedPath: script, text: scriptText, complete: true },
      ]);
      writeFileSync(join(outside, 'entry.ps1'), "Write-Output 'outside the workspace'\n");
      const outsideReview = await configuration.prepareRiskReview({
        ...scriptRequest,
        kind: 'tool',
        definitionId: 'shell.execute',
        executionId: 'powershell-outside-script',
        input: { ...scriptInput, workdir: outside },
      });
      expect(outsideReview?.material.directScripts).toEqual([
        {
          path: './entry.ps1',
          availability: 'unavailable',
          reason: 'entry_bytes_unavailable',
          complete: false,
        },
      ]);
      writeFileSync(script, "Write-Output 'changed'\n");
      await expect(
        job.start(scriptInput, {
          sessionId: request.sessionId,
          executionId: scriptRequest.executionId,
          signal: request.signal,
          dispatchAuthorization: { revision: 'fixture', materialReviewed: true },
        }),
      ).rejects.toThrow('shell_review_entry_changed');
      rmSync(script);

      rmdirSync(path);
      symlinkSync(outside, path, 'junction');
      const changed = await configuration.describeRequest(request);
      expect(changed).toMatchObject({ requiresApproval: true, hardAllowed: true });
      const auto = await configuration.describeRequest(request, {
        mode: 'auto',
        revision: 'fixture',
        workspaceTrust: true,
        allowed: [],
      });
      expect(auto?.hardAllowed).toBeTrue();
      expect(auto?.safeRead).toBeUndefined();
      expect(auto?.requiresApproval).toBeUndefined();
      expect(changed?.commandDigest).not.toBe(descriptor.commandDigest);
      const result = await job
        .start(input, {
          sessionId: request.sessionId,
          executionId: request.executionId,
          signal: request.signal,
          dispatchAuthorization: accepted,
        })
        .catch((error: unknown) => error);
      expect(result).toBeInstanceOf(JobStartError);
      expect(result).toMatchObject({ message: 'shell_workdir_changed', handle: undefined });
      expect(readdirSync(control)).toEqual([]);
    } finally {
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(path);
      rmSync(root, { recursive: true, force: true });
    }
  },
  25000,
);
