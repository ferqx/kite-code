import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseLoggedShellArguments,
  powershellBootstrap,
  runLoggedShell,
} from '../../../scripts/ci/logged-shell';

const roots: string[] = [];
const log = 'dist/unified-evidence/step.log';

function fixture(source: string | Uint8Array): { cwd: string; script: string; args: string[] } {
  const cwd = mkdtempSync(join(tmpdir(), 'kite-ci-shell-test-'));
  roots.push(cwd);
  const script = join(cwd, 'original script');
  writeFileSync(script, source);
  return { cwd, script, args: [`--log=${log}`, script] };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CI logged shell', () => {
  test('accepts exactly the fixed relative evidence log and one literal script path', () => {
    expect(parseLoggedShellArguments([`--log=${log}`, '/tmp/original script'])).toEqual({
      log,
      script: '/tmp/original script',
    });
    for (const args of [
      [],
      [`--log=${log}`],
      [`--log=${log}`, '/tmp/script', 'extra'],
      [`--log=/tmp/step.log`, '/tmp/script'],
      ['--log=dist/unified-evidence/../step.log', '/tmp/script'],
      ['--log=dist/unified-evidence/sub/step.log', '/tmp/script'],
      ['--log=dist/unified-evidence/UPPER.log', '/tmp/script'],
      [`--log=${log}`, '-command'],
      [`--log=${log}`, 'invalid\0path'],
    ]) {
      expect(() => parseLoggedShellArguments(args)).toThrow();
    }
  });

  test('keeps Actions PowerShell error/exit boilerplate separate from original bytes (static contract only)', () => {
    expect(powershellBootstrap()).toBe(
      'param([Parameter(Mandatory = $true)][string]$OriginalScript)\n' +
        "$ErrorActionPreference = 'stop'\n" +
        '& $OriginalScript\n' +
        'if (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }\n',
    );
  });

  // These execute the host's POSIX bash, not a simulated Windows qualification.
  const posix = process.platform === 'win32' ? test.skip : test;
  posix(
    'captures real stdout/stderr bytes and passes them through without changing the script',
    async () => {
      const source = "printf 'stdout\\000原始\\n'; sleep 0.1; printf 'stderr\\n' >&2\n";
      const { cwd, script, args } = fixture(source);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      expect(
        await runLoggedShell(args, {
          cwd,
          stdout: (bytes) => stdout.push(bytes),
          stderr: (bytes) => stderr.push(bytes),
        }),
      ).toBe(0);
      expect(Buffer.concat(stdout)).toEqual(Buffer.from('stdout\0原始\n'));
      expect(Buffer.concat(stderr)).toEqual(Buffer.from('stderr\n'));
      expect(readFileSync(join(cwd, log))).toEqual(Buffer.from('stdout\0原始\nstderr\n'));
      expect(readFileSync(script, 'utf8')).toBe(source);
    },
  );

  posix('returns original failure 23 and retains its output', async () => {
    const { cwd, args } = fixture("printf 'original failure\\n' >&2\nexit 23\n");
    expect(await runLoggedShell(args, { cwd, stderr: () => {} })).toBe(23);
    expect(readFileSync(join(cwd, log), 'utf8')).toBe('original failure\n');
  });

  posix('direct CLI returns the child failure and streams the same console bytes', () => {
    const { cwd, args } = fixture(
      "printf 'stdout\\n'\nsleep 0.1\nprintf 'stderr\\n' >&2\nexit 23\n",
    );
    const wrapper = new URL('../../../scripts/ci/logged-shell.ts', import.meta.url).pathname;
    const result = Bun.spawnSync([process.execPath, 'run', wrapper, ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(23);
    expect(result.stdout).toEqual(Buffer.from('stdout\n'));
    expect(result.stderr).toEqual(Buffer.from('stderr\n'));
    expect(readFileSync(join(cwd, log))).toEqual(Buffer.from('stdout\nstderr\n'));
  });

  posix('preserves errexit and pipefail instead of running later commands', async () => {
    const { cwd, args } = fixture('false | true\nprintf unexpected > ran\n');
    expect(await runLoggedShell(args, { cwd })).toBe(1);
    expect(existsSync(join(cwd, 'ran'))).toBe(false);
  });

  posix('cannot convert a signal or executable startup failure into success', async () => {
    const signalled = fixture('kill -TERM $$\n');
    expect(await runLoggedShell(signalled.args, { cwd: signalled.cwd })).not.toBe(0);
    const missing = fixture('printf unexpected > ran\n');
    expect(
      await runLoggedShell(missing.args, {
        cwd: missing.cwd,
        executable: join(missing.cwd, 'missing-bash'),
      }),
    ).toBe(1);
    expect(existsSync(join(missing.cwd, 'ran'))).toBe(false);
  });

  posix('refuses preexisting logs and symlink directories before launching a command', async () => {
    const existing = fixture('printf unexpected > ran\n');
    mkdirSync(join(existing.cwd, 'dist/unified-evidence'), { recursive: true });
    writeFileSync(join(existing.cwd, log), 'existing evidence');
    await expect(runLoggedShell(existing.args, { cwd: existing.cwd })).rejects.toThrow();
    expect(readFileSync(join(existing.cwd, log), 'utf8')).toBe('existing evidence');
    expect(existsSync(join(existing.cwd, 'ran'))).toBe(false);
    const linked = fixture('printf unexpected > ran\n');
    symlinkSync(existing.cwd, join(linked.cwd, 'dist'));
    await expect(runLoggedShell(linked.args, { cwd: linked.cwd })).rejects.toThrow();
    expect(existsSync(join(linked.cwd, 'ran'))).toBe(false);
  });

  posix('fails invalid UTF-8 before opening evidence or launching the script', async () => {
    const { cwd, args } = fixture(Uint8Array.from([0xff, 0xfe]));
    await expect(runLoggedShell(args, { cwd })).rejects.toThrow();
    expect(existsSync(join(cwd, log))).toBe(false);
  });

  posix('cannot report success when output forwarding fails', async () => {
    const { cwd, args } = fixture("printf 'output\\n'\nsleep 0.1\n");
    expect(
      await runLoggedShell(args, {
        cwd,
        stdout: () => {
          throw new Error('closed sink');
        },
      }),
    ).toBe(1);
    expect(readFileSync(join(cwd, log), 'utf8')).toBe('output\n');
  });

  // These use the real Windows runner's pwsh. Other hosts explicitly skip them.
  const windows = process.platform === 'win32' ? test : test.skip;
  windows(
    'native pwsh preserves BOM/Unicode original bytes and stdout/stderr log forwarding',
    async () => {
      const source = Buffer.from(
        '\ufeff[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n' +
          '[System.IO.File]::WriteAllBytes((Join-Path (Get-Location) "copied-script.bin"), [System.IO.File]::ReadAllBytes($PSCommandPath))\r\n' +
          '[Console]::Out.Write("stdout 原始`n")\r\n' +
          'Start-Sleep -Milliseconds 100\r\n' +
          '[Console]::Error.Write("stderr 原始`n")\r\n',
      );
      const { cwd, script, args } = fixture(source);
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      expect(
        await runLoggedShell(args, {
          cwd,
          stdout: (bytes) => stdout.push(bytes),
          stderr: (bytes) => stderr.push(bytes),
        }),
      ).toBe(0);
      expect(readFileSync(script)).toEqual(source);
      expect(readFileSync(join(cwd, 'copied-script.bin'))).toEqual(source);
      expect(Buffer.concat(stdout)).toEqual(Buffer.from('stdout 原始\n'));
      expect(Buffer.concat(stderr)).toEqual(Buffer.from('stderr 原始\n'));
      expect(readFileSync(join(cwd, log))).toEqual(Buffer.from('stdout 原始\nstderr 原始\n'));
    },
    15_000,
  );

  windows(
    'native pwsh direct CLI propagates the actual external Bun process exit 23',
    () => {
      const bun = process.execPath.replaceAll("'", "''");
      const { cwd, args } = fixture(
        `[Console]::Out.Write("before native child\n")\r\n& '${bun}' -e 'process.exit(23)'\r\n`,
      );
      const wrapper = fileURLToPath(
        new URL('../../../scripts/ci/logged-shell.ts', import.meta.url),
      );
      const result = Bun.spawnSync([process.execPath, 'run', wrapper, ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 10_000,
      });
      expect(result.exitCode).toBe(23);
      expect(result.stdout).toEqual(Buffer.from('before native child\n'));
      expect(result.stderr).toEqual(Buffer.alloc(0));
      expect(readFileSync(join(cwd, log))).toEqual(Buffer.from(result.stdout));
    },
    15_000,
  );

  windows(
    'native pwsh throw remains a failure and prevents subsequent script work',
    async () => {
      const { cwd, args } = fixture(
        'throw "original-pwsh-failure"\r\n[System.IO.File]::WriteAllText("ran", "unexpected")\r\n',
      );
      const stderr: Buffer[] = [];
      expect(await runLoggedShell(args, { cwd, stderr: (bytes) => stderr.push(bytes) })).not.toBe(
        0,
      );
      expect(Buffer.concat(stderr).toString()).toContain('original-pwsh-failure');
      expect(readFileSync(join(cwd, log))).toEqual(Buffer.concat(stderr));
      expect(existsSync(join(cwd, 'ran'))).toBe(false);
    },
    15_000,
  );

  windows(
    'native pwsh output forwarding failure cannot become success',
    async () => {
      const { cwd, args } = fixture(
        '[Console]::Out.Write("forward failed\n")\r\nStart-Sleep -Milliseconds 200\r\n',
      );
      expect(
        await runLoggedShell(args, {
          cwd,
          stdout: () => {
            throw new Error('closed Windows sink');
          },
        }),
      ).toBe(1);
      expect(readFileSync(join(cwd, log), 'utf8')).toBe('forward failed\n');
    },
    15_000,
  );
});
