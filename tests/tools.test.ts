import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchTool, assertInsideWorkspace, shellTool } from "../src/tools";

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
  });

  test("creates files inside the workspace", async () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-patch");
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = await applyPatchTool({
      workspace,
      path: "hello.txt",
      content: "hello from patch\n",
      shellExecutor: async (input) => {
        writeFileSync(join(workspace, "hello.txt"), "hello from patch\n", "utf8");
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(existsSync(join(workspace, "hello.txt"))).toBe(true);
    expect(readFileSync(join(workspace, "hello.txt"), "utf8")).toBe(
      "hello from patch\n",
    );
  });

  test("apply_patch delegates edits through shell execution", async () => {
    const commands: string[] = [];
    const result = await applyPatchTool({
      workspace: join(tmpdir(), "openpx-langgraph-tools-shell-delegate"),
      path: "delegated.txt",
      content: "delegated through shell\n",
      shellExecutor: async (input) => {
        commands.push(input.command);
        return {
          ok: true,
          command: input.command,
          exitCode: 0,
          stdout: "",
          stderr: "",
        };
      },
    });

    expect(result.ok).toBe(true);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain(process.platform === "win32" ? "Set-Content" : "bun -e");
  });

  test("returns structured shell command results", async () => {
    const workspace = join(tmpdir(), "openpx-langgraph-tools-shell");
    mkdirSync(workspace, { recursive: true });

    const result = await shellTool({ workspace, command: "pwd" });

    expect(result.command).toBe("pwd");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
  });
});
