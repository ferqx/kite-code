/**
 * Subprocess Harness — spawns the TUI in mock mode for E2E testing.
 *
 * Uses Bun.spawn with pipe I/O. stdin keystrokes are written to the pipe;
 * stdout is captured for assertion.
 *
 * Limitation: Without a real PTY, Ink's useInput raw-mode stdin reads may not
 * reliably receive all keystrokes. For session-switch tests where TextInput
 * remounts between sessions, prefer ink-testing-library.
 *
 * Usage:
 *   const tui = subprocessHarness({ responses: ["Reply 1", "Reply 2"] });
 *   await tui.sendMessage("hello");
 *   await tui.waitForText("Reply 1");
 *   tui.dispose();
 */

import { spawn, type Subprocess } from "bun";

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;
const OSC_RE = /\x1b\][^\x07]*\x07/g;
const CR_RE = /\r/g;

function ansiStrip(text: string): string {
  return text.replace(ANSI_RE, "").replace(OSC_RE, "").replace(CR_RE, "");
}

export interface SubprocessHarnessOptions {
  responses: string[];
  cwd?: string;
  stepTimeout?: number;
}

export interface SubprocessTui {
  sendMessage(text: string): Promise<void>;
  sendSlash(command: string): Promise<void>;
  waitForText(text: string, timeout?: number): Promise<void>;
  waitForIdle(timeout?: number): Promise<void>;
  getOutput(): string;
  dispose(): void;
}

export function subprocessHarness(options: SubprocessHarnessOptions): SubprocessTui {
  const stepTimeout = options.stepTimeout ?? 15000;
  const mockResponses = JSON.stringify(options.responses);

  const proc: Subprocess<"pipe", "pipe", "pipe"> = spawn({
    cmd: ["bun", "run", "tests/e2e/mock-entry.tsx"],
    cwd: options.cwd ?? process.cwd(),
    env: {
      ...process.env,
      OPENPX_MOCK_RESPONSES: mockResponses,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";
  let disposed = false;

  if (proc.stdout) {
    (async () => {
      try {
        for await (const chunk of proc.stdout!) {
          if (disposed) break;
          output += new TextDecoder().decode(chunk);
        }
      } catch { /* pipe closed */ }
    })();
  }

  if (proc.stderr) {
    (async () => {
      try { for await (const _ of proc.stderr!) {} } catch {}
    })();
  }

  const stdinWrite = (data: string) => {
    if (disposed) return;
    proc.stdin!.write(data);
  };

  const startup = (async () => {
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (ansiStrip(output).includes("OpenPX")) return;
      await Bun.sleep(300);
    }
  })();

  const tui: SubprocessTui = {
    async sendMessage(text: string) {
      await startup;
      for (const ch of text) {
        stdinWrite(ch);
        await Bun.sleep(3);
      }
      await Bun.sleep(100);
      stdinWrite("\r");
      await Bun.sleep(500);
    },

    async sendSlash(command: string) {
      await startup;
      for (const ch of command) {
        stdinWrite(ch);
        await Bun.sleep(2);
      }
      await Bun.sleep(100);
      stdinWrite("\r");
      await Bun.sleep(500);
    },

    async waitForText(text: string, timeout = stepTimeout) {
      await startup;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        if (ansiStrip(output).includes(text)) return;
        await Bun.sleep(100);
      }
      const clean = ansiStrip(output);
      throw new Error(
        `waitForText "${text}" timed out after ${timeout}ms.\nLast 500:\n${clean.slice(-500)}`,
      );
    },

    async waitForIdle(timeout = stepTimeout) {
      await startup;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const clean = ansiStrip(output);
        if (clean.includes("( - - )") || clean.includes("( = = )")) {
          await Bun.sleep(500);
          return;
        }
        await Bun.sleep(100);
      }
    },

    getOutput() { return ansiStrip(output); },

    dispose() {
      disposed = true;
      proc.kill();
      proc.unref();
    },
  };

  return tui;
}

export { ansiStrip };
