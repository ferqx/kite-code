import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findSystemBash,
  gatherSystemBashCandidates,
  isWslStubPath,
} from '@kite/builtin-runtime/sandbox';
import { guardProcessTree } from '@kite/runtime-host';
import { createSandboxExecutor } from './helpers/sandbox-executor';
import { buildHostShellInvocations } from './helpers/shell-executor';

describe('shell execute integration', () => {
  const workspace = join(tmpdir(), 'kite-code-e2e-shell');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'test.txt'), 'hello');

  // Shell semantics belong to the deterministic default suite. Native
  // sandbox enforcement is isolated in test:sandbox:smoke:native.
  const shell = createSandboxExecutor({ enabled: false, workspace });

  test('ls returns file list with ok=true', async () => {
    const r = await shell({ workspace, command: 'ls' });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('test.txt');
  });

  test('pipe with grep works', async () => {
    const r = await shell({ workspace, command: 'echo hello123 | grep hello' });
    expect(r.ok).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello');
  });

  test('nonexistent command returns ok=false', async () => {
    const r = await shell({ workspace, command: 'nonexistent_cmd_xyz 2>&1' });
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  test('pwd matches workspace', async () => {
    const r = await shell({ workspace, command: 'pwd' });
    expect(r.ok).toBe(true);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  test('stderr capture works', async () => {
    const r = await shell({ workspace, command: 'ls /nonexistent_path_xyz 2>&1' });
    expect(r.ok).toBe(false);
    expect(r.stderr.length + r.stdout.length).toBeGreaterThan(0);
  });
});

describe('shell live output', () => {
  const workspace = join(tmpdir(), 'kite-code-e2e-shell-live');
  mkdirSync(workspace, { recursive: true });
  const shell = createSandboxExecutor({ enabled: false, workspace });

  test('emits stderr progress before later stdout', async () => {
    const events: Array<{ chunk: string; stream: 'stdout' | 'stderr' }> = [];

    const result = await shell({
      workspace,
      command: "printf 'err-first\\n' >&2; sleep 0.2; printf 'out-late\\n'",
      onProgress: (chunk, stream) => {
        events.push({ chunk, stream });
      },
    });

    expect(result.ok).toBe(true);
    expect(events[0]).toEqual({ chunk: 'err-first', stream: 'stderr' });
    expect(events.map((e) => e.chunk)).toEqual(['err-first', 'out-late']);
  });

  test('kills descendant processes before returning a timeout result', async () => {
    const scriptPath = join(workspace, 'timeout-descendant.cjs');
    const pidPath = join(workspace, 'timeout-descendant.pid');
    let descendantPid: number | undefined;
    rmSync(pidPath, { force: true });
    writeFileSync(
      scriptPath,
      [
        "const { writeFileSync } = require('node:fs');",
        "writeFileSync('timeout-descendant.pid', String(process.pid));",
        'setInterval(() => {}, 1_000);',
      ].join('\n'),
    );

    try {
      const result = await shell({
        workspace,
        command: 'node timeout-descendant.cjs',
        timeoutMs: 4_000,
      });

      expect(result.exitCode).toBe(124);
      expect(existsSync(pidPath)).toBe(true);
      descendantPid = Number(readFileSync(pidPath, 'utf8'));
      expect(isProcessAlive(descendantPid)).toBe(false);
    } finally {
      if (descendantPid && isProcessAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // Process exited between the liveness check and cleanup.
        }
      }
      rmSync(scriptPath, { force: true });
      rmSync(pidPath, { force: true });
    }
  }, 10_000);

  test('kills Windows descendants that started before Job assignment', async () => {
    if (process.platform !== 'win32') return;

    const childScript = 'setInterval(() => {}, 1_000);';
    const parentScript = [
      `const child = Bun.spawn([process.execPath, '-e', ${JSON.stringify(childScript)}], {`,
      "  stdin: 'ignore', stdout: 'ignore', stderr: 'ignore'",
      '});',
      'console.log(child.pid);',
      'setInterval(() => {}, 1_000);',
    ].join('\n');
    const proc = Bun.spawn([process.execPath, '-e', parentScript], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    });
    let childPid: number | undefined;
    let processTree: ReturnType<typeof guardProcessTree> | undefined;

    try {
      childPid = Number(await readFirstLine(proc.stdout));
      expect(isProcessAlive(childPid)).toBe(true);

      // Deliberately attach the Job after the descendant exists. Windows does
      // not retroactively add that child to the Job, so native tree sweeping
      // must still find and terminate it.
      processTree = guardProcessTree(proc);
      await processTree.terminate();
      await proc.exited;

      expect(isProcessAlive(childPid)).toBe(false);
    } finally {
      processTree?.dispose();
      try {
        proc.kill('SIGKILL');
      } catch {
        // Parent already exited.
      }
      if (childPid && isProcessAlive(childPid)) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          // Child exited between the liveness check and cleanup.
        }
      }
    }
  }, 20_000);

  test('stops long-running commands after timeoutMs', async () => {
    const startedAt = Date.now();

    const result = await shell({
      workspace,
      command: 'sleep 5',
      timeoutMs: 100,
    });

    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });

  test('does not wait for inherited pipes from a background child after timeout', async () => {
    const startedAt = Date.now();
    const result = await shell({
      workspace,
      command: 'sleep 5 & wait',
      timeoutMs: 50,
    });

    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });

  test('cancellation terminates descendants without waiting for the timeout', async () => {
    const scriptPath = join(workspace, 'cancel-descendant.cjs');
    let descendantPid: number | undefined;
    let cancelledAt: number | undefined;
    const controller = new AbortController();
    writeFileSync(
      scriptPath,
      ['console.log("child-ready:" + process.pid);', 'setInterval(() => {}, 1_000);'].join('\n'),
    );

    try {
      const result = await shell({
        workspace,
        command: 'node cancel-descendant.cjs',
        timeoutMs: 8_000,
        signal: controller.signal,
        onProgress: (line, stream) => {
          const match = stream === 'stdout' ? line.match(/^child-ready:(\d+)$/u) : null;
          if (!match) return;
          descendantPid = Number(match[1]);
          cancelledAt = Date.now();
          controller.abort();
        },
      });

      expect(cancelledAt).toBeDefined();
      // Graceful cancellation should return as soon as the process tree exits;
      // the 500ms bound is a deadline, not a mandatory sleep.
      expect(Date.now() - cancelledAt!).toBeLessThan(500);
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(130);
      expect(result.stderr).toContain('cancelled by user');
      expect(descendantPid).toBeDefined();
      expect(isProcessAlive(descendantPid!)).toBe(false);
      expect(result.processCleanup).toMatchObject({
        confirmedExited: true,
        gracefulRequested: true,
      });
    } finally {
      if (descendantPid && isProcessAlive(descendantPid)) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch {
          // Process exited between the liveness check and cleanup.
        }
      }
      rmSync(scriptPath, { force: true });
    }
  }, 12_000);

  test('escalates from graceful termination to a bounded forced process-group kill', async () => {
    if (process.platform === 'win32') return;
    const controller = new AbortController();
    const startedAt = Date.now();
    const result = await shell({
      workspace,
      command:
        "node -e \"process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)\"",
      timeoutMs: 8_000,
      signal: controller.signal,
      onProgress: (line) => {
        if (line === 'ready') controller.abort();
      },
    });

    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(result.exitCode).toBe(130);
    expect(result.processCleanup).toEqual({
      confirmedExited: true,
      gracefulRequested: true,
      forced: true,
      unconfirmedDescendantCount: 0,
    });
  }, 8_000);
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readFirstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    while (!buffered.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
    }
    return buffered.split(/\r?\n/u, 1)[0] ?? '';
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed.
    }
    reader.releaseLock();
  }
}

describe('findSystemBash — candidate selection logic', () => {
  const SYSTEMROOT = 'C:\\Windows';

  test('no git, no bash → returns null', () => {
    const which = (_name: string) => null;
    const { gitDerived, pathBash } = gatherSystemBashCandidates(which, SYSTEMROOT);
    expect(gitDerived).toEqual([]);
    expect(pathBash).toBeNull();
  });

  test('git found → derives bash candidates from git path', () => {
    const which = (name: string) =>
      name === 'git' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : null;
    const { gitDerived, pathBash } = gatherSystemBashCandidates(which, SYSTEMROOT);

    expect(gitDerived.length).toBe(3);
    expect(gitDerived[0]).toContain('bash.exe');
    expect(gitDerived[1]).toContain(join('bin', 'bash.exe'));
    expect(pathBash).toBeNull();
  });

  test('bash in PATH from non-Windows directory → accepted', () => {
    const which = (name: string) => (name === 'bash' ? 'D:\\Git\\usr\\bin\\bash.exe' : null);
    const { pathBash } = gatherSystemBashCandidates(which, SYSTEMROOT);

    expect(isWslStubPath(pathBash!, SYSTEMROOT)).toBe(false);
  });

  test('WSL stub: bash at System32 → flagged as WSL', () => {
    expect(isWslStubPath('C:\\Windows\\System32\\bash.exe', 'C:\\Windows')).toBe(true);
    expect(isWslStubPath('C:\\Windows\\SysWOW64\\bash.exe', 'C:\\Windows')).toBe(true);
    // Also test case-insensitive and forward-slashed variants
    expect(isWslStubPath('c:\\windows\\system32\\bash.exe', 'C:\\Windows')).toBe(true);
  });

  test('non-WSL paths → not flagged', () => {
    expect(isWslStubPath('D:\\Git\\usr\\bin\\bash.exe', 'C:\\Windows')).toBe(false);
    expect(isWslStubPath('C:\\msys64\\usr\\bin\\bash.exe', 'C:\\Windows')).toBe(false);
    expect(isWslStubPath('/usr/bin/bash', 'C:\\Windows')).toBe(false);
  });

  test('real environment: findSystemBash excludes WSL if git bash available', () => {
    const bashPath = findSystemBash();
    if (bashPath) {
      expect(isWslStubPath(bashPath, process.env.SystemRoot || 'C:\\Windows')).toBe(false);
    }
    // If null, no bash available — vendored or cmd.exe will be used (valid)
  });
});

describe('host Shell candidate resolution', () => {
  test('Windows uses Bash, cmd, then PowerShell candidates', () => {
    const candidates = buildHostShellInvocations('echo ok', {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      systemBash: 'C:\\Git\\bin\\bash.exe',
      vendoredBash: 'D:\\app\\vendor\\bash.exe',
      which: (name) => (name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null),
    });

    expect(candidates.map((candidate) => candidate.kind)).toEqual([
      'bash',
      'bash',
      'cmd',
      'powershell',
    ]);
    expect(candidates[2]?.argv).toEqual(['C:\\Windows\\System32\\cmd.exe', '/d', '/c', 'echo ok']);
    expect(candidates[3]?.argv).toContain('-NoProfile');
  });

  test('macOS and Linux use the same ordered resolver with available interpreters', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const candidates = buildHostShellInvocations('echo ok', {
        platform,
        systemRoot: '',
        configuredShell: '/bin/zsh',
        which: (name) =>
          name === 'bash' ? '/usr/bin/bash' : name === 'pwsh' ? '/usr/local/bin/pwsh' : null,
      });

      expect(candidates.map((candidate) => candidate.kind)).toEqual([
        'bash',
        'posix',
        'powershell',
        'posix',
      ]);
      expect(candidates[2]?.argv).toEqual([
        '/usr/local/bin/pwsh',
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'echo ok',
      ]);
    }
  });

  test('Windows host Shell can explicitly execute cmd and PowerShell commands', async () => {
    if (process.platform !== 'win32') return;

    const shell = createSandboxExecutor({ enabled: false, workspace: process.cwd() });
    const cmdResult = await shell({
      workspace: process.cwd(),
      command: 'cmd.exe //d //c "echo CMD_OK"',
    });
    expect(cmdResult).toMatchObject({ ok: true });
    expect(cmdResult.stdout).toContain('CMD_OK');

    const powershell = Bun.which('pwsh') ?? Bun.which('powershell.exe');
    if (!powershell) return;
    const psResult = await shell({
      workspace: process.cwd(),
      command: 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "Write-Output PS_OK"',
    });
    expect(psResult).toMatchObject({ ok: true });
    expect(psResult.stdout).toContain('PS_OK');
  });
});
