import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/app/cli/index';
import { generateBwrapArgs } from '../src/core/sandbox/bwrap';
import { createSandboxExecutor } from '../src/core/sandbox/executor';
import { detectSandboxBackend, isSandboxAvailable } from '../src/core/sandbox/platform';
import { generateSandboxProfile } from '../src/core/sandbox/profile';
import { findApplySeccomp, resolveSeccompPath } from '../src/core/sandbox/seccomp';
import {
  buildEnvExportSnippet,
  buildEnvStripSnippet,
  buildHardenedEnv,
  buildUlimitPreamble,
  checkDangerousPaths,
  getSandboxRuntimeDir,
} from '../src/core/sandbox/shell-wrapper';
import { DEFAULT_RESOURCE_LIMITS } from '../src/core/sandbox/types';
import { shellTool } from '../src/core/tools/shell';

// 验证沙箱 profile 结构 / Validate sandbox profile structure
describe('sandbox profile generation', () => {
  test('profile includes deny-default posture', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace');
    expect(profile).toContain('(deny default)');
  });

  test('profile includes version marker', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace');
    expect(profile).toContain('(version 1)');
  });

  test('profile allows process execution and forking', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace');
    expect(profile).toContain('(allow process-exec)');
    expect(profile).toContain('(allow process-fork)');
  });

  test('profile restricts file write to workspace and temp directories', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace');
    expect(profile).toContain('(allow file-write* file-ioctl (subpath "/tmp/test-workspace"))');
    expect(profile).toContain('(allow file-write* file-ioctl (subpath "/tmp"))');
    expect(profile).not.toContain('(allow file-write* file-ioctl (subpath "/"))');
  });

  test('profile does not deny network (controlled by tool-policy approval)', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace');
    expect(profile).not.toContain('(deny network*)');
  });

  test('profile can deny network explicitly', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace', { network: 'disabled' });
    expect(profile).toContain('(deny network*)');
  });

  test('profile imports system.sb as base', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace');
    expect(profile).toContain('(import "system.sb")');
  });

  test('profile allows global file read so dev tools (git, xcrun) can access system paths', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace');
    expect(profile).toContain('(allow file-read* (subpath "/"))');
  });

  test('profile restricts file create/unlink to workspace and temp directories', () => {
    const profile = generateSandboxProfile('/tmp/test-workspace');
    expect(profile).toContain(
      '(allow file-write-unlink file-write-create (subpath "/tmp/test-workspace"))',
    );
    expect(profile).not.toContain('(allow file-write-unlink file-write-create (subpath "/"))');
  });
});

// 验证 shell wrapper 工具函数 / Validate shell wrapper utility functions
describe('shell wrapper utilities', () => {
  test('ulimit preamble includes working resource limits', () => {
    const preamble = buildUlimitPreamble();
    expect(preamble).toContain(`ulimit -t ${DEFAULT_RESOURCE_LIMITS.cpuTime}`);
    expect(preamble).toContain(`ulimit -f ${DEFAULT_RESOURCE_LIMITS.fileSize}`);
    expect(preamble).toContain(`ulimit -n ${DEFAULT_RESOURCE_LIMITS.fileDescriptors}`);
    // -v and -u 默认关闭（macOS 不兼容）/ disabled by default (macOS incompatible)
    expect(preamble).not.toContain('ulimit -v');
    expect(preamble).not.toContain('ulimit -u');
  });

  test('ulimit preamble merges custom resource limits', () => {
    const preamble = buildUlimitPreamble({ cpuTime: 30, processes: 16 });
    expect(preamble).toContain('ulimit -t 30');
    expect(preamble).toContain('ulimit -u 16');
    expect(preamble).toContain(`ulimit -f ${DEFAULT_RESOURCE_LIMITS.fileSize}`);
  });

  test('hardened env retains safe variables', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    try {
      process.env.TEST_KEEP_VAR = 'keep-me';
      const env = buildHardenedEnv(ws);
      // PATH and HOME should be inherited from parent
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBe(process.env.HOME as string);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      delete process.env.TEST_KEEP_VAR;
    }
  });

  test('hardened env redirects temp and cache paths to sandbox runtime dir', () => {
    const ws = mkdtempSync(join(tmpdir(), 'sandbox-test-'));
    try {
      const env = buildHardenedEnv(ws);
      // HOME is inherited from parent (real user home), not redirected
      if (process.env.HOME !== undefined) {
        expect(env.HOME).toBe(process.env.HOME);
      }
      // Temp and cache paths are redirected to sandbox runtime dir in system temp
      const runtimeDir = getSandboxRuntimeDir();
      expect(env.TMPDIR).toBe(join(runtimeDir, 'tmp'));
      expect(env.TMP).toBe(join(runtimeDir, 'tmp'));
      expect(env.TEMP).toBe(join(runtimeDir, 'tmp'));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test('env strip snippet unsets dangerous variables', () => {
    const snippet = buildEnvStripSnippet();
    expect(snippet).toContain('unset LD_PRELOAD');
    expect(snippet).toContain('unset DYLD_INSERT_LIBRARIES');
    expect(snippet).toContain('unset DYLD_LIBRARY_PATH');
    expect(snippet).toContain('unset NODE_OPTIONS');
  });

  test('env export snippet quotes values', () => {
    const snippet = buildEnvExportSnippet({ FOO: 'bar', BAZ: '/path/to/dir' });
    expect(snippet).toContain("export FOO='bar'");
    expect(snippet).toContain("export BAZ='/path/to/dir'");
  });

  test('env export snippet escapes single quotes in values', () => {
    const snippet = buildEnvExportSnippet({ MSG: "it's working" });
    expect(snippet).toContain("export MSG='it'\\''s working'");
  });
});

// 验证危险文件路径检测 / Validate dangerous file path detection
describe('dangerous path detection', () => {
  test('detects shell config files in redirects', () => {
    expect(checkDangerousPaths("echo 'alias ls=evil' >> .bashrc")).toBe('.bashrc');
    expect(checkDangerousPaths('cat payload > ~/.zshrc')).toBe('.zshrc');
    expect(checkDangerousPaths('tee -a .profile < payload')).toBe('.profile');
  });

  test('detects git hooks and config', () => {
    expect(checkDangerousPaths('cp script .git/hooks/pre-commit')).toBe('.git/hooks/');
    expect(checkDangerousPaths("echo '[user]' >> .git/config")).toBe('.git/config');
  });

  test('detects SSH authorized_keys tampering', () => {
    expect(checkDangerousPaths('cat key.pub >> .ssh/authorized_keys')).toBe('.ssh/authorized_keys');
    expect(checkDangerousPaths('echo key >> ~/.ssh/authorized_keys2')).toBe(
      '.ssh/authorized_keys2',
    );
  });

  test('detects IDE/agent config tampering', () => {
    expect(checkDangerousPaths('rm .claude/settings.json')).toBe('.claude/settings.json');
    expect(checkDangerousPaths('echo task >> .vscode/tasks.json')).toBe('.vscode/tasks.json');
  });

  test('detects credential file access', () => {
    expect(checkDangerousPaths('cat .env')).toBe('.env');
    expect(checkDangerousPaths('cp .env .env.local')).toBe('.env');
    expect(checkDangerousPaths('cat ~/.aws/credentials')).toBe('.aws/credentials');
    expect(checkDangerousPaths('cat .npmrc')).toBe('.npmrc');
  });

  test('detects system config tampering', () => {
    expect(checkDangerousPaths("echo 'evil' >> /etc/crontab")).toBe('/etc/crontab');
    expect(checkDangerousPaths("echo 'evil' >> /etc/passwd")).toBe('/etc/passwd');
    expect(checkDangerousPaths("echo 'evil' >> /etc/sudoers")).toBe('/etc/sudoers');
  });

  test('allows safe commands with similar-looking paths', () => {
    expect(checkDangerousPaths('cat package.json')).toBeNull();
    expect(checkDangerousPaths('cat src/config/env.ts')).toBeNull();
    expect(checkDangerousPaths('git status')).toBeNull();
    expect(checkDangerousPaths('bun test')).toBeNull();
    expect(checkDangerousPaths("echo 'hello world'")).toBeNull();
  });

  test('returns null for safe commands', () => {
    expect(checkDangerousPaths('ls -la')).toBeNull();
    expect(checkDangerousPaths('pwd')).toBeNull();
    expect(checkDangerousPaths('cat README.md')).toBeNull();
  });

  // ── 持久化机制 / Persistence mechanisms ──
  test('detects macOS LaunchAgents tampering', () => {
    // 绝对路径 /Library/LaunchAgents 和 ~/Library/LaunchAgents 都会被捕获
    expect(checkDangerousPaths('cp evil.plist ~/Library/LaunchAgents/evil.plist')).toBe(
      'Library/LaunchAgents/',
    );
    expect(checkDangerousPaths('echo plist > /Library/LaunchAgents/com.attacker.plist')).toBe(
      'Library/LaunchAgents/',
    );
    expect(checkDangerousPaths('rm /Library/LaunchDaemons/system.plist')).toBe(
      'Library/LaunchDaemons/',
    );
  });

  test('detects systemd user unit tampering', () => {
    expect(checkDangerousPaths('echo unit > ~/.config/systemd/user/evil.service')).toBe(
      '.config/systemd/user/',
    );
    expect(checkDangerousPaths('cp evil.service /etc/systemd/system/evil.service')).toBe(
      '/etc/systemd/system/',
    );
  });

  test('detects XDG autostart tampering', () => {
    expect(checkDangerousPaths('echo desktop > ~/.config/autostart/evil.desktop')).toBe(
      '.config/autostart/',
    );
  });

  test('detects Docker config tampering', () => {
    expect(checkDangerousPaths('cat ~/.docker/config.json')).toBe('.docker/config.json');
    expect(checkDangerousPaths("echo '{}' > .docker/daemon.json")).toBe('.docker/daemon.json');
  });

  test('detects SSH daemon config tampering', () => {
    expect(checkDangerousPaths('echo PermitRootLogin yes >> /etc/ssh/sshd_config')).toBe(
      '/etc/ssh/sshd_config',
    );
    expect(checkDangerousPaths('cat /etc/ssh/ssh_config')).toBe('/etc/ssh/ssh_config');
  });
});

// 验证平台检测 / Validate platform detection
describe('sandbox platform detection', () => {
  test('detectSandboxBackend returns a valid backend type', () => {
    const backend = detectSandboxBackend();
    expect(['seatbelt', 'bubblewrap', 'none']).toContain(backend);
  });

  test('detectSandboxBackend matches platform', () => {
    const backend = detectSandboxBackend();
    if (process.platform === 'darwin') {
      expect(backend).toBe('seatbelt');
    } else if (process.platform === 'linux') {
      expect(['bubblewrap', 'none']).toContain(backend);
    } else {
      expect(backend).toBe('none');
    }
  });

  test("isSandboxAvailable matches detectSandboxBackend !== 'none'", () => {
    expect(isSandboxAvailable()).toBe(detectSandboxBackend() !== 'none');
  });
});

// 验证 Bubblewrap 参数生成 / Validate Bubblewrap argument generation
describe('bwrap argument generation', () => {
  test('includes workspace bind mount', () => {
    const args = generateBwrapArgs('/tmp/test-ws');
    expect(args).toContain('--bind');
    expect(args).toContain('/tmp/test-ws');
  });

  test('includes essential isolation flags', () => {
    const args = generateBwrapArgs('/tmp/test-ws');
    expect(args).toContain('--unshare-pid');
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--new-session');
  });

  test('includes minimal /dev and /proc', () => {
    const args = generateBwrapArgs('/tmp/test-ws');
    expect(args).toContain('--dev');
    expect(args).toContain('--proc');
  });

  test('includes tmpfs /tmp', () => {
    const args = generateBwrapArgs('/tmp/test-ws');
    expect(args).toContain('--tmpfs');
    expect(args).toContain('/tmp');
  });

  test('includes system paths as read-only', () => {
    const args = generateBwrapArgs('/tmp/test-ws');
    if (process.platform === 'linux') {
      expect(args).toContain('--ro-bind');
      // 至少包含 /usr 或 /bin（取决于系统）
      const hasSystemPath = args.includes('/usr') || args.includes('/bin');
      expect(hasSystemPath).toBe(true);
    }
  });

  test('can disable network namespace', () => {
    const args = generateBwrapArgs('/tmp/test-ws', { network: 'disabled' });
    expect(args).toContain('--unshare-net');
  });
});

// 验证 executor 工厂回退行为 / Validate executor factory fallback behavior
describe('sandbox executor factory', () => {
  test('returns shellTool when disabled', () => {
    const executor = createSandboxExecutor({
      enabled: false,
      workspace: '/tmp/test',
    });
    // When disabled, should return the exact shellTool reference
    expect(executor).toBe(shellTool);
  });
});

// 验证 CLI --no-sandbox 标志解析 / Validate CLI --no-sandbox flag parsing
describe('cli sandbox flag', () => {
  test('sandbox is enabled by default', () => {
    const args = parseArgs(['run', '--task', 'hello']);
    expect(args.sandbox).toBe(true);
  });

  test('--no-sandbox disables sandbox', () => {
    const args = parseArgs(['run', '--task', 'hello', '--no-sandbox']);
    expect(args.sandbox).toBe(false);
  });

  test('resume defaults to sandbox enabled', () => {
    const args = parseArgs(['resume', '--approve']);
    expect(args.sandbox).toBe(true);
  });

  test('resume --no-sandbox disables sandbox', () => {
    const args = parseArgs(['resume', '--approve', '--no-sandbox']);
    expect(args.sandbox).toBe(false);
  });
});

// 验证 seccomp 二进制查找和路径解析 / Validate seccomp binary lookup and path resolution
describe('seccomp resolution', () => {
  test('findApplySeccomp returns a path on supported architectures', () => {
    const path = findApplySeccomp();
    // x64 / arm64 至少一个存在 / at least one is present
    if (process.arch === 'x64' || process.arch === 'arm64') {
      expect(path).toBeString();
      expect(path?.replace(/\\/g, '/')).toContain('vendor/seccomp');
    } else {
      expect(path).toBeNull();
    }
  });

  test('resolveSeccompPath returns null for null input', () => {
    expect(resolveSeccompPath(null, '/tmp/ws')).toBeNull();
  });

  test('resolveSeccompPath returns same path when binary is within workspace', () => {
    const ws = '/tmp/my-workspace';
    const binary = '/tmp/my-workspace/vendor/seccomp/arm64/apply-seccomp';
    expect(resolveSeccompPath(binary, ws)).toBe(binary);
  });

  test('resolveSeccompPath copies binary when outside workspace', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'seccomp-test-'));
    const srcDir = mkdtempSync(join(tmpdir(), 'seccomp-src-'));
    try {
      const srcBinary = join(srcDir, 'apply-seccomp');
      await Bun.write(srcBinary, '#!/bin/sh\necho fake');
      chmodSync(srcBinary, 0o755);

      const resolved = resolveSeccompPath(srcBinary, ws);
      expect(resolved).toBe(join(getSandboxRuntimeDir(), 'apply-seccomp'));
      expect(existsSync(resolved!)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});
