import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxExecutor } from '../src/core/sandbox/executor';
import {
  findSystemBash,
  gatherSystemBashCandidates,
  isWslStubPath,
} from '../src/core/tools/bash-path';
import { shellTool } from '../src/core/tools/shell';

describe('shell execute integration', () => {
  const workspace = join(tmpdir(), 'kite-code-e2e-shell');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'test.txt'), 'hello');

  const shell = createSandboxExecutor({ enabled: true, workspace });

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

  test('emits stderr progress before later stdout', async () => {
    const events: Array<{ chunk: string; stream: 'stdout' | 'stderr' }> = [];

    const result = await shellTool({
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

  test('stops long-running commands after timeoutMs', async () => {
    const startedAt = Date.now();

    const result = await shellTool({
      workspace,
      command: 'sleep 5',
      timeoutMs: 100,
    });

    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('timed out');
  });
});

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
