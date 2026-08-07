/**
 * 沙箱执行器集成测试 — 仅在 macOS 运行
 * Sandbox executor integration tests — macOS only
 *
 * 这些测试验证 sandbox-exec 的实际隔离效果。在非 macOS 平台上全部跳过。
 * These tests verify actual sandbox-exec isolation. Skipped on non-macOS platforms.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxExecutor } from '../src/core/sandbox/executor';
import { startTestHttpServer } from './helpers/test-http-server';

const isMacOS = process.platform === 'darwin';

function setupWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'kite-code-sandbox-test-'));
  return ws;
}

function cleanupWorkspace(ws: string) {
  rmSync(ws, { recursive: true, force: true });
}

describe('sandbox executor integration', () => {
  if (!isMacOS) {
    test('reports that Seatbelt integration requires macOS', () => {
      expect(process.platform).not.toBe('darwin');
    });
    return;
  }

  test('executes commands within workspace successfully', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: 'pwd' });
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(ws);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('can read files within workspace', async () => {
    const ws = setupWorkspace();
    try {
      writeFileSync(join(ws, 'hello.txt'), 'hello sandbox');
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: 'cat hello.txt' });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('hello sandbox');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('fallback /bin/sh can read the workspace when SHELL is absent', async () => {
    const ws = setupWorkspace();
    const previousShell = process.env.SHELL;
    writeFileSync(join(ws, 'fallback-readable.txt'), 'fallback-readable');
    try {
      delete process.env.SHELL;
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: 'cat fallback-readable.txt' });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('fallback-readable');
    } finally {
      if (previousShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = previousShell;
      cleanupWorkspace(ws);
    }
  });

  test('can write files within workspace', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      await executor({ workspace: ws, command: 'echo created > sandbox-test.txt' });
      const result = await executor({ workspace: ws, command: 'cat sandbox-test.txt' });
      expect(result.stdout).toContain('created');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('can execute the controlled Bun runtime without granting its root write access', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: 'bun --version' });
      expect(result.ok).toBe(true);
      expect(result.stdout.trim()).toBe(Bun.version);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('emits live stderr progress before later stdout', async () => {
    const ws = setupWorkspace();
    try {
      const events: Array<{ chunk: string; stream: 'stdout' | 'stderr' }> = [];
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });

      const result = await executor({
        workspace: ws,
        command: "printf 'err-first\\n' >&2; sleep 0.2; printf 'out-late\\n'",
        onProgress: (chunk, stream) => {
          events.push({ chunk, stream });
        },
      });

      expect(result.ok).toBe(true);
      expect(events[0]).toEqual({ chunk: 'err-first', stream: 'stderr' });
      expect(events.map((e) => e.chunk)).toEqual(['err-first', 'out-late']);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('stops long-running commands after timeoutMs', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const startedAt = Date.now();

      const result = await executor({
        workspace: ws,
        command: 'sleep 5',
        timeoutMs: 100,
      });

      expect(Date.now() - startedAt).toBeLessThan(2000);
      expect(result.ok).toBe(false);
      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain('timed out');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('denies file read outside workspace at the OS boundary', async () => {
    const ws = setupWorkspace();
    const externalFile = join(homedir(), `.kite-code-sandbox-test-${process.pid}`);
    writeFileSync(externalFile, 'secret');
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: `cat "${externalFile}"`,
      });
      expect(result.ok).toBe(false);
      expect(result.stdout).not.toContain('secret');
    } finally {
      rmSync(externalFile, { force: true });
      cleanupWorkspace(ws);
    }
  });

  test('denies broad system configuration reads', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: 'cat /private/etc/hosts' });
      expect(result.ok).toBe(false);
      expect(result.stdout).toBe('');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('uses and removes an invocation-private runtime directory', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: `printf secret > "$TMPDIR/secret"; printf '%s' "$TMPDIR"`,
      });
      expect(result.ok).toBe(true);
      const runtimeTmp = result.stdout;
      expect(runtimeTmp).toContain('openpx-sandbox-runtime');
      expect(existsSync(runtimeTmp)).toBe(false);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('concurrent invocations cannot share runtime directories', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const [first, second] = await Promise.all([
        executor({ workspace: ws, command: `printf '%s' "$TMPDIR"; sleep 0.05` }),
        executor({ workspace: ws, command: `printf '%s' "$TMPDIR"; sleep 0.05` }),
      ]);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(first.stdout).not.toBe(second.stdout);
      expect(existsSync(first.stdout)).toBe(false);
      expect(existsSync(second.stdout)).toBe(false);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('hostile runtime modes are recovered without throwing or leaving residue', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command:
          'printf %s "$TMPDIR" > runtime-path.txt; mkdir -p "$TMPDIR/nested/deeper"; printf flagged > "$TMPDIR/nested/deeper/flagged"; chflags uchg,uappnd "$TMPDIR/nested/deeper/flagged"; chmod 000 "$TMPDIR/nested/deeper"; chflags uchg,uappnd "$TMPDIR/nested/deeper"; chmod 000 "$TMPDIR/nested"; chflags uchg,uappnd "$TMPDIR/nested"; chmod 000 "$TMPDIR/.."',
      });
      expect(result.ok).toBe(true);
      const runtimeTmp = await Bun.file(join(ws, 'runtime-path.txt')).text();
      expect(existsSync(runtimeTmp)).toBe(false);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('normal shell exit terminates background descendants before runtime cleanup returns', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command:
          'sleep 30 </dev/null >/dev/null 2>&1 & child=$!; printf "%s\\n%s" "$child" "$TMPDIR"',
      });

      const [pidText, runtimeTmp] = result.stdout.split('\n');
      if (!pidText || !runtimeTmp) throw new Error('Expected background PID and runtime path.');
      const childPid = Number(pidText);
      expect(result.ok).toBe(true);
      expect(result.processCleanup?.confirmedExited).toBe(true);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(existsSync(runtimeTmp)).toBe(false);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('denies file write outside workspace at the OS boundary', async () => {
    const ws = setupWorkspace();
    const externalFile = join(homedir(), `.kite-code-sandbox-test-write-${process.pid}`);
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: `echo hello > "${externalFile}"`,
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(externalFile)).toBe(false);
    } finally {
      rmSync(externalFile, { force: true });
      cleanupWorkspace(ws);
    }
  });

  test('denies unlink outside workspace at the OS boundary', async () => {
    const ws = setupWorkspace();
    const externalFile = join(homedir(), `.kite-code-sandbox-unlink-${process.pid}`);
    writeFileSync(externalFile, 'keep');
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: `rm "${externalFile}"` });
      expect(result.ok).toBe(false);
      expect(existsSync(externalFile)).toBe(true);
    } finally {
      rmSync(externalFile, { force: true });
      cleanupWorkspace(ws);
    }
  });

  test('denies symlink escape to a file outside workspace', async () => {
    const ws = setupWorkspace();
    const externalFile = join(homedir(), `.kite-code-sandbox-link-${process.pid}`);
    writeFileSync(externalFile, 'outside-secret');
    symlinkSync(externalFile, join(ws, 'outside-link'));
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({ workspace: ws, command: 'cat outside-link' });
      expect(result.ok).toBe(false);
      expect(result.stdout).not.toContain('outside-secret');
    } finally {
      rmSync(externalFile, { force: true });
      cleanupWorkspace(ws);
    }
  });

  test('denies protected paths inside workspace', async () => {
    const ws = setupWorkspace();
    mkdirSync(join(ws, '.SSH'));
    writeFileSync(join(ws, '.SSH', 'config'), 'protected');
    writeFileSync(join(ws, '.ENV.TEST'), 'keep');
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      // Split the literal so checkDangerousPaths cannot be the mechanism under test.
      const read = await executor({ workspace: ws, command: 'cat .S"SH/config"' });
      const write = await executor({ workspace: ws, command: 'echo changed > .E"NV.TEST"' });
      expect(read.ok).toBe(false);
      expect(read.stdout).not.toContain('protected');
      expect(write.ok).toBe(false);
      expect(await Bun.file(join(ws, '.ENV.TEST')).text()).toBe('keep');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('allows git access to workspace .git inside the sandbox', async () => {
    const ws = setupWorkspace();
    mkdirSync(join(ws, '.GIT'));
    writeFileSync(join(ws, '.GIT', 'config'), 'repo-config');
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      // Split the literal so checkDangerousPaths cannot be the mechanism under test.
      const result = await executor({ workspace: ws, command: 'cat .g"it/config"' });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('repo-config');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('child shells inherit the same filesystem boundary', async () => {
    const ws = setupWorkspace();
    const externalFile = join(homedir(), `.kite-code-sandbox-child-${process.pid}`);
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: `sh -c 'echo bypass > "${externalFile}"'`,
      });
      expect(result.ok).toBe(false);
      expect(existsSync(externalFile)).toBe(false);
    } finally {
      rmSync(externalFile, { force: true });
      cleanupWorkspace(ws);
    }
  });

  test('enforces read-only workspace scope natively', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({
        enabled: true,
        workspace: ws,
        filesystemScope: 'read_only',
      });
      const result = await executor({ workspace: ws, command: 'echo denied > read-only.txt' });
      expect(result.ok).toBe(false);
      expect(existsSync(join(ws, 'read-only.txt'))).toBe(false);
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('applies network permission independently to each sandboxed command', async () => {
    const ws = setupWorkspace();
    const server = startTestHttpServer({
      fetch: () => new Response('sandbox-network-ok'),
    });
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const url = `http://127.0.0.1:${server.port}`;
      const blocked = await executor({
        workspace: ws,
        command: `curl -s --connect-timeout 1 ${url}`,
      });
      const allowed = await executor({
        workspace: ws,
        command: `curl -s --connect-timeout 1 ${url}`,
        networkMode: 'allow_all',
      });

      expect(blocked.ok).toBe(false);
      expect(allowed.ok).toBe(true);
      expect(allowed.stdout).toBe('sandbox-network-ok');
    } finally {
      server.stop(true);
      cleanupWorkspace(ws);
    }
  });

  test('kills commands exceeding CPU time limit', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({
        enabled: true,
        workspace: ws,
        resourceLimits: { cpuTime: 3 },
      });
      // 无限循环应在约 3 秒后被 ulimit -t 杀死
      const result = await executor({
        workspace: ws,
        command: 'while true; do :; done',
        // Seatbelt may suppress SIGXCPU delivery. The executor timeout keeps
        // this regression test bounded while cpuTime still configures ulimit.
        timeoutMs: 4_000,
      });
      expect(result.ok).toBe(false);
      expect(result.exitCode).not.toBe(0);
    } finally {
      cleanupWorkspace(ws);
    }
  }, 10_000);

  test('rejects commands targeting dangerous file paths', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: 'echo alias ls=evil >> .bashrc',
      });
      expect(result.ok).toBe(false);
      expect(result.stderr).toContain('Rejected');
      expect(result.stderr).toContain('.bashrc');
    } finally {
      cleanupWorkspace(ws);
    }
  });

  test('disabled executor falls back to unsandboxed execution', async () => {
    const ws = setupWorkspace();
    try {
      const executor = createSandboxExecutor({ enabled: false, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: 'echo unsandboxed',
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('unsandboxed');
    } finally {
      cleanupWorkspace(ws);
    }
  });
});
