import { describe, expect, test } from "bun:test";
import { generateSandboxProfile } from "../src/sandbox/profile";
import {
  buildUlimitPreamble,
  buildHardenedEnv,
  buildEnvStripSnippet,
  buildEnvExportSnippet,
} from "../src/sandbox/shell-wrapper";
import { isSandboxAvailable } from "../src/sandbox/platform";
import { createSandboxExecutor } from "../src/sandbox/executor";
import { shellTool } from "../src/tools/shell";
import { DEFAULT_RESOURCE_LIMITS } from "../src/sandbox/types";
import { parseArgs } from "../src/app/cli";
import { mkdtempSync, rmSync } from "node:fs";
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

// 验证平台检测 / Validate platform detection
describe("sandbox platform detection", () => {
  test("isSandboxAvailable returns a boolean", () => {
    const available = isSandboxAvailable();
    expect(typeof available).toBe("boolean");
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
