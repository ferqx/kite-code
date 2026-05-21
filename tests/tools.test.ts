import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertInsideWorkspace, shellTool } from "../src/core/tools/shell";
import { writeFile, editFile, readFile } from "../src/core/tools/file";

/** Convert MSYS2 Unix-style path to Windows-style path */
function msys2ToWindowsPath(p: string): string {
  return p
    .replace(/^\/cygdrive\/([a-z])\b/i, "$1:\\")
    .replace(/^\/mnt\/([a-z])\b/i, "$1:\\")
    .replace(/^\/([a-z])\//i, "$1:\\")
    .replace(/\//g, "\\");
}

describe("tool safety", () => {
  test("allows paths inside the workspace", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-safe");
    expect(assertInsideWorkspace(workspace, "inside.txt")).toBe(
      join(workspace, "inside.txt"),
    );
  });

  test("allows workspace files whose names start with dots", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-safe");
    expect(assertInsideWorkspace(workspace, "..notes.txt")).toBe(
      join(workspace, "..notes.txt"),
    );
  });

  test("rejects paths outside the workspace", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-safe");
    expect(() => assertInsideWorkspace(workspace, "..\\outside.txt")).toThrow(
      /outside workspace/,
    );
    expect(() => assertInsideWorkspace(workspace, "../outside.txt")).toThrow(
      /outside workspace/,
    );
  });

  test("write_file creates files inside the workspace", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-write");
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = writeFile({
      workspace,
      path: "hello.txt",
      content: "hello from write_file\n",
    });

    expect(result.ok).toBe(true);
    expect(result.lines).toBe(1);
    expect(existsSync(join(workspace, "hello.txt"))).toBe(true);
    expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toBe(
      "hello from write_file\n",
    );
  });

  test("write_file accepts absolute paths inside the workspace", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-write-absolute");
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });
    const absolutePath = join(workspace, "nested", "hello.txt");

    const result = writeFile({
      workspace,
      path: absolutePath,
      content: "hello from absolute path\n",
    });

    expect(result.ok).toBe(true);
    expect(existsSync(absolutePath)).toBe(true);
    // Verify the absolute path was not misinterpreted as relative and double-nested
    expect(existsSync(join(workspace, workspace.slice(1), "nested", "hello.txt"))).toBe(false);
  });

  test("edit_file finds and replaces text", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-edit");
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: "config.ts", content: "  debug: true,\n  env: prod,\n" });

    const result = editFile({
      workspace,
      path: "config.ts",
      oldString: "  debug: true,",
      newString: "  debug: false,",
    });

    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(1);
    expect(readFileSync(join(workspace, "config.ts"), "utf8")).toContain("debug: false");
  });

  test("edit_file fails when old_string not found", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-edit-nf");
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: "f.txt", content: "hello\n" });

    const result = editFile({
      workspace,
      path: "f.txt",
      oldString: "nonexistent",
      newString: "replaced",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("read_file reads file with line numbers", () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-read");
    mkdirSync(workspace, { recursive: true });

    writeFile({ workspace, path: "test.txt", content: "line1\nline2\nline3\n" });

    const result = readFile({ workspace, path: "test.txt", offset: 2, limit: 1 });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("2|line2");
    expect(result.totalLines).toBe(3);
  });

  test("returns structured shell command results", async () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-shell");
    mkdirSync(workspace, { recursive: true });

    const result = await shellTool({ workspace, command: "pwd" });

    expect(result.command).toBe("pwd");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // MSYS2 bash on Windows outputs Unix-style paths; normalize to compare with workspace
    // On macOS, /var is a symlink to /private/var, so pwd may differ from tmpdir()
    const { resolve } = await import("node:path");
    const { realpathSync } = await import("node:fs");
    const pwdOutput = result.stdout.trim();
    const normalizedPwd = process.platform === "win32" ? msys2ToWindowsPath(pwdOutput) : pwdOutput;
    expect(realpathSync(normalizedPwd).toLowerCase()).toBe(realpathSync(workspace).toLowerCase());
  });

  test("shell_execute produces no stderr noise on standard commands", async () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-shell-clean");
    mkdirSync(workspace, { recursive: true });

    const result = await shellTool({ workspace, command: "ls" });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    // MSYS2 bash must not emit /tmp or other spurious warnings to stderr
    expect(result.stderr).toBe("");
  });
});
