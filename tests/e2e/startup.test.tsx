/**
 * TUI Startup & Input flow e2e — renders the actual TuiBootstrap component.
 *
 * Unlike mock-agent/real-agent tests which render simplified roots
 * (TuiMockRoot / TuiRealAgentRoot), these tests exercise the REAL
 * TuiBootstrap component to catch:
 *
 * - TDZ / ReferenceError during render phase (near-empty output)
 * - Auto-create session failure (no sidebar session marker)
 * - handleInput → runTask dispatch (user message block appears in output)
 *
 * Test gap documented in docs/space/execution/active/tui-e2e-standards.md
 */
import { describe, test, expect, mock, beforeAll, afterAll } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// ── Mock heavy dependencies ──

mock.module("@/core/skills/loader", () => ({
  scanSkills: () => [],
  getSkillContent: () => Promise.resolve(""),
}));

function setupTempHome() {
  const tempHome = mkdtempSync(join(tmpdir(), "openpx-startup-"));
  const openpxDir = join(tempHome, ".openpx");
  mkdirSync(openpxDir, { recursive: true });
  writeFileSync(join(openpxDir, "openpx.jsonc"), JSON.stringify({
    provider: {
      deepseek: { type: "deepseek", apiKey: "test-key", baseURL: "https://test.api.example.com" },
    },
    model: {
      default: { provider: "deepseek", name: "deepseek-v4" },
    },
  }, null, 2));
  return tempHome;
}

async function tick(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe("TUI Startup & Input", () => {

  // ── Test 1: Render without crash ──

  test("TuiBootstrap renders meaningful output (no render crash)", async () => {
    const tempHome = setupTempHome();
    const origHome = process.env.HOME;
    process.env.HOME = tempHome;

    let result: ReturnType<typeof render> | null = null;

    try {
      const { TuiBootstrap } = await import("../../src/app/tui/index");
      result = render(React.createElement(TuiBootstrap));

      // A render crash (TDZ/ReferenceError) produces near-empty output (~1 char)
      // because React unmounts the tree on uncaught errors. Normal startup
      // produces hundreds of characters of ANSI-formatted TUI content.
      const output = result.lastFrame();
      expect(output.length, "Output > 10 chars (empty = render crash)")
        .toBeGreaterThan(10);
      expect(output.toLowerCase()).toContain("openpx");
    } finally {
      result?.unmount();
      process.env.HOME = origHome;
      try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  // ── Test 2: Auto-create session ──

  test("auto-create session shows in sidebar", async () => {
    const tempHome = setupTempHome();
    const origHome = process.env.HOME;
    process.env.HOME = tempHome;

    let result: ReturnType<typeof render> | null = null;

    try {
      const { TuiBootstrap } = await import("../../src/app/tui/index");
      result = render(React.createElement(TuiBootstrap));

      // Wait for the 80ms initialization timer + session creation effect
      await tick(200);

      const output = result.lastFrame();
      // Sidebar shows ● for active session
      expect(output).toContain("●");
      expect(output).not.toContain("No sessions");
    } finally {
      result?.unmount();
      process.env.HOME = origHome;
      try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
    }
  }, 15000);

  // ── Test 3: User input → handleInput → runTask → UI update ──

  test("Enter key triggers handleInput → runTask → user message block", async () => {
    const tempHome = setupTempHome();
    const origHome = process.env.HOME;
    process.env.HOME = tempHome;

    let result: ReturnType<typeof render> | null = null;

    try {
      const { TuiBootstrap } = await import("../../src/app/tui/index");
      const { stdin, lastFrame, unmount } = render(React.createElement(TuiBootstrap));
      result = { stdin, lastFrame, unmount } as any;

      // Wait for initialization
      await tick(300);

      // Verify sidebar shows a session (initialized state)
      const beforeOutput = result.lastFrame();
      expect(beforeOutput).toContain("●");

      // Simulate typing "hello" and pressing Enter
      (result as any).stdin.write("hello");
      await tick(100);
      (result as any).stdin.write("\r");
      await tick(500);

      const afterOutput = result.lastFrame();

      // After input, either:
      // a) handleInput was called → user message "hello" appears in output area
      // b) If agent started running, the header cat changes to "( ^ ^ )"
      const hasUserBlock = afterOutput.includes("hello");
      const hasRunningCat = afterOutput.includes("( ^ ^ )");
      const hasErrorCat = afterOutput.includes("( T T )");

      // At minimum, output should change from before-input state.
      // With a mock API key, the agent may fail → error cat, or
      // the user message block should appear.
      expect(afterOutput, "Output must change after user input")
        .not.toBe(beforeOutput);

      // User message block "hello" should appear as a rendered block
      // (not just in the input area). The InputLine clears after submit,
      // so "hello" in output after Enter means it's a message block.
      expect(hasUserBlock || hasRunningCat || hasErrorCat,
        "Must have user message block or agent status change"
      ).toBe(true);
    } finally {
      result?.unmount();
      process.env.HOME = origHome;
      try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
    }
  }, 20000);

});
