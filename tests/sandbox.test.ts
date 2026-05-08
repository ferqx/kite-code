import { describe, expect, test } from "bun:test";
import { generateSandboxProfile } from "../src/sandbox/profile";
import { generateBwrapArgs } from "../src/sandbox/bwrap";
import {
  buildUlimitPreamble,
  buildHardenedEnv,
  buildEnvStripSnippet,
  buildEnvExportSnippet,
  checkDangerousPaths,
} from "../src/sandbox/shell-wrapper";
import { detectSandboxBackend, isSandboxAvailable } from "../src/sandbox/platform";
import { createSandboxExecutor } from "../src/sandbox/executor";
import { findApplySeccomp, resolveSeccompPath } from "../src/sandbox/seccomp";
import { shellTool } from "../src/tools/shell";
import { DEFAULT_RESOURCE_LIMITS } from "../src/sandbox/types";
import { parseArgs } from "../src/app/cli";
import { mkdtempSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 验证沙箱 profile 结构 / Validate sandbox profile structure
describe("sandbox profile generation", () => {
  test("profile includes deny-default posture", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain("(deny default)");
  });

  test("profile includes version marker", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain("(version 1)");
  });

  test("profile allows process execution and forking", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain("(allow process-exec)");
    expect(profile).toContain("(allow process-fork)");
  });

  test("profile includes workspace path with full read-write", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain(`(subpath "/tmp/test-workspace")`);
    expect(profile).toContain("file-write*");
  });

  test("profile denies network by default", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain("(deny network*)");
  });

  test("profile imports system.sb as base", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain('(import "system.sb")');
  });

  test("profile allows directory metadata traversal to resolve paths", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain("(allow file-read-metadata (subpath \"/\"))");
  });

  test("profile includes tmp directories for file operations", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain("(subpath \"/tmp\")");
    expect(profile).toContain("(subpath \"/private/tmp\")");
  });

  test("profile escapes backslashes in workspace path", () => {
    const profile = generateSandboxProfile("/tmp/test\\path");
    expect(profile).toContain("/tmp/test\\\\path");
  });

  test("profile includes move-blocking to prevent rename/symlink escape", () => {
    const profile = generateSandboxProfile("/tmp/test-workspace");
    expect(profile).toContain("(deny file-write-unlink file-write-create)");
  });
});

// 验证 shell wrapper 工具函数 / Validate shell wrapper utility functions
describe("shell wrapper utilities", () => {
  test("ulimit preamble includes working resource limits", () => {
    const preamble = buildUlimitPreamble();
    expect(preamble).toContain(`ulimit -t ${DEFAULT_RESOURCE_LIMITS.cpuTime}`);
    expect(preamble).toContain(`ulimit -f ${DEFAULT_RESOURCE_LIMITS.fileSize}`);
    expect(preamble).toContain(`ulimit -n ${DEFAULT_RESOURCE_LIMITS.fileDescriptors}`);
    // -v and -u 默认关闭（macOS 不兼容）/ disabled by default (macOS incompatible)
    expect(preamble).not.toContain("ulimit -v");
    expect(preamble).not.toContain("ulimit -u");
  });

  test("ulimit preamble merges custom resource limits", () => {
    const preamble = buildUlimitPreamble({ cpuTime: 30, processes: 16 });
    expect(preamble).toContain("ulimit -t 30");
    expect(preamble).toContain("ulimit -u 16");
    expect(preamble).toContain(`ulimit -f ${DEFAULT_RESOURCE_LIMITS.fileSize}`);
  });

  test("hardened env retains safe variables", () => {
    const ws = mkdtempSync(join(tmpdir(), "sandbox-test-"));
    try {
      process.env.TEST_KEEP_VAR = "keep-me";
      const env = buildHardenedEnv(ws);
      // PATH should be passed through from parent
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toContain(".sandbox-home");
    } finally {
      rmSync(ws, { recursive: true, force: true });
      delete process.env.TEST_KEEP_VAR;
    }
  });

  test("hardened env redirects writable paths to workspace", () => {
    const ws = mkdtempSync(join(tmpdir(), "sandbox-test-"));
    try {
      const env = buildHardenedEnv(ws);
      expect(env.HOME).toBe(join(ws, ".sandbox-home"));
      expect(env.TMPDIR).toBe(join(ws, ".sandbox-tmp"));
      expect(env.TMP).toBe(join(ws, ".sandbox-tmp"));
      expect(env.TEMP).toBe(join(ws, ".sandbox-tmp"));
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  test("env strip snippet unsets dangerous variables", () => {
    const snippet = buildEnvStripSnippet();
    expect(snippet).toContain("unset LD_PRELOAD");
    expect(snippet).toContain("unset DYLD_INSERT_LIBRARIES");
    expect(snippet).toContain("unset DYLD_LIBRARY_PATH");
    expect(snippet).toContain("unset NODE_OPTIONS");
  });

  test("env export snippet quotes values", () => {
    const snippet = buildEnvExportSnippet({ FOO: "bar", BAZ: "/path/to/dir" });
    expect(snippet).toContain("export FOO='bar'");
    expect(snippet).toContain("export BAZ='/path/to/dir'");
  });

  test("env export snippet escapes single quotes in values", () => {
    const snippet = buildEnvExportSnippet({ MSG: "it's working" });
    expect(snippet).toContain("export MSG='it'\\''s working'");
  });
});

// 验证危险文件路径检测 / Validate dangerous file path detection
describe("dangerous path detection", () => {
  test("detects shell config files in redirects", () => {
    expect(checkDangerousPaths("echo 'alias ls=evil' >> .bashrc")).toBe(".bashrc");
    expect(checkDangerousPaths("cat payload > ~/.zshrc")).toBe(".zshrc");
    expect(checkDangerousPaths("tee -a .profile < payload")).toBe(".profile");
  });

  test("detects git hooks and config", () => {
    expect(checkDangerousPaths("cp script .git/hooks/pre-commit")).toBe(".git/hooks/");
    expect(checkDangerousPaths("echo '[user]' >> .git/config")).toBe(".git/config");
  });

  test("detects SSH authorized_keys tampering", () => {
    expect(checkDangerousPaths("cat key.pub >> .ssh/authorized_keys")).toBe(".ssh/authorized_keys");
    expect(checkDangerousPaths("echo key >> ~/.ssh/authorized_keys2")).toBe(".ssh/authorized_keys2");
  });

  test("detects IDE/agent config tampering", () => {
    expect(checkDangerousPaths("rm .claude/settings.json")).toBe(".claude/settings.json");
    expect(checkDangerousPaths("echo task >> .vscode/tasks.json")).toBe(".vscode/tasks.json");
  });

  test("detects credential file access", () => {
    expect(checkDangerousPaths("cat .env")).toBe(".env");
    expect(checkDangerousPaths("cp .env .env.local")).toBe(".env");
    expect(checkDangerousPaths("cat ~/.aws/credentials")).toBe(".aws/credentials");
    expect(checkDangerousPaths("cat .npmrc")).toBe(".npmrc");
  });

  test("detects system config tampering", () => {
    expect(checkDangerousPaths("echo 'evil' >> /etc/crontab")).toBe("/etc/crontab");
    expect(checkDangerousPaths("echo 'evil' >> /etc/passwd")).toBe("/etc/passwd");
    expect(checkDangerousPaths("echo 'evil' >> /etc/sudoers")).toBe("/etc/sudoers");
  });

  test("allows safe commands with similar-looking paths", () => {
    expect(checkDangerousPaths("cat package.json")).toBeNull();
    expect(checkDangerousPaths("cat src/config/env.ts")).toBeNull();
    expect(checkDangerousPaths("git status")).toBeNull();
    expect(checkDangerousPaths("bun test")).toBeNull();
    expect(checkDangerousPaths("echo 'hello world'")).toBeNull();
  });

  test("returns null for safe commands", () => {
    expect(checkDangerousPaths("ls -la")).toBeNull();
    expect(checkDangerousPaths("pwd")).toBeNull();
    expect(checkDangerousPaths("cat README.md")).toBeNull();
  });
});

// 验证平台检测 / Validate platform detection
describe("sandbox platform detection", () => {
  test("detectSandboxBackend returns a valid backend type", () => {
    const backend = detectSandboxBackend();
    expect(["seatbelt", "bubblewrap", "none"]).toContain(backend);
  });

  test("detectSandboxBackend returns seatbelt on macOS", () => {
    const backend = detectSandboxBackend();
    if (process.platform === "darwin") {
      expect(backend).toBe("seatbelt");
    }
  });

  test("isSandboxAvailable returns a boolean", () => {
    const available = isSandboxAvailable();
    expect(typeof available).toBe("boolean");
  });

  test("isSandboxAvailable matches detectSandboxBackend !== 'none'", () => {
    expect(isSandboxAvailable()).toBe(detectSandboxBackend() !== "none");
  });
});

// 验证 Bubblewrap 参数生成 / Validate Bubblewrap argument generation
describe("bwrap argument generation", () => {
  test("includes workspace bind mount", () => {
    const args = generateBwrapArgs("/tmp/test-ws");
    expect(args).toContain("--bind");
    expect(args).toContain("/tmp/test-ws");
  });

  test("includes essential isolation flags", () => {
    const args = generateBwrapArgs("/tmp/test-ws");
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
  });

  test("includes minimal /dev and /proc", () => {
    const args = generateBwrapArgs("/tmp/test-ws");
    expect(args).toContain("--dev");
    expect(args).toContain("--proc");
  });

  test("includes tmpfs /tmp", () => {
    const args = generateBwrapArgs("/tmp/test-ws");
    expect(args).toContain("--tmpfs");
    expect(args).toContain("/tmp");
  });

  test("includes system paths as read-only", () => {
    const args = generateBwrapArgs("/tmp/test-ws");
    expect(args).toContain("--ro-bind");
    // 至少包含 /usr 或 /bin（取决于系统）
    const hasSystemPath = args.includes("/usr") || args.includes("/bin");
    expect(hasSystemPath).toBe(true);
  });
});

// 验证 executor 工厂回退行为 / Validate executor factory fallback behavior
describe("sandbox executor factory", () => {
  test("returns shellTool when disabled", () => {
    const executor = createSandboxExecutor({
      enabled: false,
      workspace: "/tmp/test",
    });
    // When disabled, should return the exact shellTool reference
    expect(executor).toBe(shellTool);
  });
});

// 验证 CLI --no-sandbox 标志解析 / Validate CLI --no-sandbox flag parsing
describe("cli sandbox flag", () => {
  test("sandbox is enabled by default", () => {
    const args = parseArgs(["run", "--task", "hello"]);
    expect(args.sandbox).toBe(true);
  });

  test("--no-sandbox disables sandbox", () => {
    const args = parseArgs(["run", "--task", "hello", "--no-sandbox"]);
    expect(args.sandbox).toBe(false);
  });

  test("resume defaults to sandbox enabled", () => {
    const args = parseArgs(["resume", "--approve"]);
    expect(args.sandbox).toBe(true);
  });

  test("resume --no-sandbox disables sandbox", () => {
    const args = parseArgs(["resume", "--approve", "--no-sandbox"]);
    expect(args.sandbox).toBe(false);
  });
});

// 验证 seccomp 二进制查找和路径解析 / Validate seccomp binary lookup and path resolution
describe("seccomp resolution", () => {
  test("findApplySeccomp returns a path on supported architectures", () => {
    const path = findApplySeccomp();
    // x64 / arm64 至少一个存在 / at least one is present
    if (process.arch === "x64" || process.arch === "arm64") {
      expect(path).toBeString();
      expect(path).toContain("vendor/seccomp");
    } else {
      expect(path).toBeNull();
    }
  });

  test("resolveSeccompPath returns null for null input", () => {
    expect(resolveSeccompPath(null, "/tmp/ws")).toBeNull();
  });

  test("resolveSeccompPath returns same path when binary is within workspace", () => {
    const ws = "/tmp/my-workspace";
    const binary = "/tmp/my-workspace/vendor/seccomp/arm64/apply-seccomp";
    expect(resolveSeccompPath(binary, ws)).toBe(binary);
  });

  test("resolveSeccompPath copies binary when outside workspace", () => {
    const ws = mkdtempSync(join(tmpdir(), "seccomp-test-"));
    const srcDir = mkdtempSync(join(tmpdir(), "seccomp-src-"));
    try {
      const srcBinary = join(srcDir, "apply-seccomp");
      Bun.write(srcBinary, "#!/bin/sh\necho fake");
      chmodSync(srcBinary, 0o755);

      const resolved = resolveSeccompPath(srcBinary, ws);
      expect(resolved).toBe(join(ws, ".sandbox-tmp", "apply-seccomp"));
      expect(existsSync(resolved!)).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});
