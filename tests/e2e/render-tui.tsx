/**
 * Real TUI e2e test harness — renders the actual TuiBootstrap component.
 *
 * Unlike the old mock-agent/real-agent helpers which bypass TuiBootstrap,
 * this renders the REAL component with only the LLM replaced by a
 * StreamingMockModel. Every other layer (handleInput → runTask →
 * SessionManager → runAgent → reducer → renderer) is the real production path.
 *
 * Usage:
 *   const tui = await createTui({ modelResponses: [...] });
 *   await tui.sendMessage("hello");
 *   await tui.waitForText("Hello!");
 *   expect(tui.getOutput()).toContain("Hello!");
 *   tui.unmount();
 */
import React from "react";
import { render } from "ink-testing-library";
import { join } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AIMessage } from "@langchain/core/messages";
import { StreamingMockModel, type MockResponse } from "../mock-model";
import { loadAgentConfig } from "../../src/core/config/index";
import type { SupportedChatModel } from "../../src/core/model/factory";

// ── Types ──

export interface CreateTuiOptions {
  /** Mock model responses for the agent */
  modelResponses: MockResponse[];
  /** Terminal width in columns */
  terminalWidth?: number;
  /** Files to create in temp workspace before TUI starts */
  workspaceFiles?: Record<string, string>;
  /** Timeout per step (ms) */
  stepTimeout?: number;
  /** Whether to auto-approve tool calls */
  autoApprove?: boolean;
}

export interface TuiHarness {
  /** Ink stdin (for simulate-input) */
  stdin: { write: (s: string) => void };
  /** Current rendered ANSI output */
  lastFrame: () => string | undefined;
  /** Unmount and cleanup */
  unmount: () => void;
  /** Temp home directory */
  tempHome: string;
  /** Temp workspace directory */
  workspace: string;

  /** Type message and press Enter, wait for running state */
  sendMessage: (text: string) => Promise<void>;
  /** Wait for running state "( ^ ^ )" to appear */
  waitForRunning: (timeout?: number) => Promise<void>;
  /** Wait for idle state "( - - )" to appear after agent finishes */
  waitForIdle: (timeout?: number) => Promise<void>;
  /** Wait for specific text to appear in output */
  waitForText: (text: string, timeout?: number) => Promise<void>;
  /** Wait for text to NOT appear in output */
  waitForTextGone: (text: string, timeout?: number) => Promise<void>;
  /** Get current rendered output */
  getOutput: () => string;
  /** Count sessions in sidebar (by counting ● markers) */
  getSessionCount: () => number;
  /** Check if running state is active */
  isRunning: () => boolean;
  /** Check if idle state */
  isIdle: () => boolean;
}

// ── Cat face indicators (from Header.tsx CAT_LINES) ──

const RUNNING_CAT = "( ^ ^ )";
const ERROR_CAT = "( T T )";
const IDLE_CAT = "( = = )";

// ── Session markers (from Sidebar.tsx) ──

const ACTIVE_SESSION = "●"; // ●
const INACTIVE_SESSION = "○"; // ○

// ── Temp directory helpers ──

function setupTempHome() {
  const tempHome = mkdtempSync(join(tmpdir(), "openpx-e2e-"));
  const openpxDir = join(tempHome, ".openpx");
  mkdirSync(openpxDir, { recursive: true });
  writeFileSync(
    join(openpxDir, "openpx.jsonc"),
    JSON.stringify(
      {
        provider: {
          deepseek: {
            type: "deepseek",
            apiKey: "test-key",
            baseURL: "https://test.api.example.com",
          },
        },
        model: {
          default: { provider: "deepseek", name: "deepseek-v4" },
        },
      },
      null,
      2,
    ),
  );
  return tempHome;
}

function setupTempWorkspace(files?: Record<string, string>): string {
  const ws = mkdtempSync(join(tmpdir(), "openpx-ws-"));
  if (files) {
    for (const [path, content] of Object.entries(files)) {
      const fullPath = join(ws, path);
      mkdirSync(fullPath.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }
  }
  return ws;
}

// ── Global render lock: prevents concurrent Ink renders from conflicting ──

let renderBusy = false;
const renderQueue: (() => void)[] = [];

async function acquireRenderLock(): Promise<void> {
  while (renderBusy) {
    await new Promise<void>((resolve) => renderQueue.push(resolve));
  }
  renderBusy = true;
}

function releaseRenderLock(): void {
  renderBusy = false;
  const next = renderQueue.shift();
  if (next) next();
}

// ── Polling helpers ──

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function poll(
  fn: () => boolean,
  timeout: number,
  label: string,
): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeout) {
      throw new Error(`Timeout (${timeout}ms) waiting for: ${label}`);
    }
    await tick();
  }
}

async function pollTextPresent(
  lastFrame: () => string | undefined,
  text: string,
  timeout: number,
): Promise<void> {
  const start = Date.now();
  while (true) {
    const output = lastFrame() ?? "";
    if (output.includes(text)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `Timeout (${timeout}ms) waiting for text "${text}" in output`,
      );
    }
    await tick();
  }
}

async function pollTextGone(
  lastFrame: () => string | undefined,
  text: string,
  timeout: number,
): Promise<void> {
  const start = Date.now();
  while (true) {
    const output = lastFrame() ?? "";
    if (!output.includes(text)) return;
    if (Date.now() - start > timeout) {
      throw new Error(
        `Timeout (${timeout}ms) waiting for text "${text}" to disappear`,
      );
    }
    await tick();
  }
}

// ── Main factory ──

export async function createTui(opts: CreateTuiOptions): Promise<TuiHarness> {
  // Serialize renders — concurrent Ink instances can conflict on stdout/stdin
  await acquireRenderLock();

  let lockReleased = false;
  const unlock = () => {
    if (!lockReleased) { lockReleased = true; releaseRenderLock(); }
  };

  const tempHome = setupTempHome();
  const workspace = setupTempWorkspace(opts.workspaceFiles);
  const terminalWidth = opts.terminalWidth ?? 120;
  const stepTimeout = opts.stepTimeout ?? 15000;

  const origHome = process.env.HOME;
  const origOpenpxHome = process.env.OPENPX_HOME;
  const origCwd = process.cwd();
  const origColumns = process.stdout.columns;
  process.env.HOME = tempHome;
  process.env.OPENPX_HOME = tempHome;
  process.chdir(workspace);
  process.stdout.columns = terminalWidth;

  const normalizedResponses: MockResponse[] = opts.modelResponses.map((r) => {
    const msg = r.message;
    if (AIMessage.isInstance(msg)) return r;
    const content = (msg as any).content ?? "";
    const toolCalls = (msg as any).tool_calls;
    return {
      ...r,
      message: new AIMessage({
        content,
        id: `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      }),
    };
  });

  const model = new StreamingMockModel({
    responses: normalizedResponses,
  }) as unknown as SupportedChatModel;

  const { TuiBootstrap } = await import("../../src/app/tui/index");
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.includes("[MCP]")) return;
    origError.apply(console, args);
  };
  console.warn = (...args: any[]) => {
    const msg = String(args[0] ?? "");
    if (msg.includes("[sandbox]")) return;
    origWarn.apply(console, args);
  };

  const { stdin, lastFrame, unmount: inkUnmount } = render(
    React.createElement(TuiBootstrap, { model } as any),
  );

  await poll(
    () => {
      const out = lastFrame() ?? "";
      return out.includes("( = = )") || out.includes("( ^ ^ )") || out.includes("❯");
    },
    10000,
    "main App (cat face or prompt)",
  );

  await poll(
    () => {
      const out = lastFrame() ?? "";
      return /[○●]   tui-/.test(out);
    },
    5000,
    "auto-create session in sidebar",
  );

  const getOutput = () => lastFrame() ?? "";

  const unmount = () => {
    inkUnmount();
    console.error = origError;
    console.warn = origWarn;
    process.env.HOME = origHome;
    if (origOpenpxHome !== undefined) {
      process.env.OPENPX_HOME = origOpenpxHome;
    } else {
      delete process.env.OPENPX_HOME;
    }
    process.chdir(origCwd);
    process.stdout.columns = origColumns ?? 80;
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
    try { rmSync(workspace, { recursive: true, force: true }); } catch {}
    unlock();
  };

  let setupOk = false;
  try {
    const harness: TuiHarness = {
      stdin,
      lastFrame,
      unmount,
      tempHome,
      workspace,

      getOutput,

      isRunning: () => getOutput().includes(RUNNING_CAT),
      isIdle: () => {
        const out = getOutput();
        return out.includes(IDLE_CAT) && !out.includes(RUNNING_CAT);
      },

      async sendMessage(text: string) {
        stdin.write(text);
        await tick(100);
        stdin.write("\r");
        await tick(100);
      },

      async waitForRunning(timeout = stepTimeout) {
        await poll(() => getOutput().includes(RUNNING_CAT), timeout, "running state (cat face)");
      },

      async waitForIdle(timeout = stepTimeout) {
        await poll(
          () => {
            const out = getOutput();
            return (out.includes(IDLE_CAT) || !out.includes(RUNNING_CAT)) && !out.includes("Thinking");
          },
          timeout,
          "idle state",
        );
      },

      async waitForText(text: string, timeout = stepTimeout) {
        await pollTextPresent(lastFrame, text, timeout);
      },

      async waitForTextGone(text: string, timeout = stepTimeout) {
        await pollTextGone(lastFrame, text, timeout);
      },

      getSessionCount() {
        const out = getOutput();
        const activeCount = (out.match(/●   /g) || []).length;
        const inactiveCount = (out.match(/○   /g) || []).length;
        return activeCount + inactiveCount;
      },
    };

    setupOk = true;
    return harness;
  } finally {
    if (!setupOk) unlock();
  }
}
