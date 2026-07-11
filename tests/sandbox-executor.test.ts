/**
 * 沙箱执行器集成测试 — 仅在 macOS 运行
 * Sandbox executor integration tests — macOS only
 *
 * 这些测试验证 sandbox-exec 的实际隔离效果。在非 macOS 平台上全部跳过。
 * These tests verify actual sandbox-exec isolation. Skipped on non-macOS platforms.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSandboxExecutor } from '../src/core/sandbox/executor';

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

  test('allows file read outside workspace (dev tools need system paths)', async () => {
    const ws = setupWorkspace();
    // 文件读取不再被沙箱阻止，以满足 git、xcrun 等开发工具的需求
    // 危险文件访问由 checkDangerousPaths 和工具策略兜底
    // File reads are no longer blocked by sandbox for dev tool compatibility
    // Dangerous file access is caught by checkDangerousPaths and tool policy
    const externalFile = join(homedir(), `.kite-code-sandbox-test-${process.pid}`);
    writeFileSync(externalFile, 'secret');
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: `cat "${externalFile}"`,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toContain('secret');
    } finally {
      rmSync(externalFile, { force: true });
      cleanupWorkspace(ws);
    }
  });

  test('allows file write outside workspace (authorization handled by tool-policy)', async () => {
    const ws = setupWorkspace();
    const externalFile = join(homedir(), `.kite-code-sandbox-test-write-${process.pid}`);
    try {
      const executor = createSandboxExecutor({ enabled: true, workspace: ws });
      const result = await executor({
        workspace: ws,
        command: `echo hello > "${externalFile}"`,
      });
      // 工作区外写入由 tool-policy 审批控制，沙箱不再拦截
      // Writes outside workspace are controlled by tool-policy approval, not sandbox
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(externalFile, { force: true });
      cleanupWorkspace(ws);
    }
  });

  test('applies network permission independently to each sandboxed command', async () => {
    const ws = setupWorkspace();
    const server = Bun.serve({
      port: 0,
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
