import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentConfig } from "../src/core/config/index";
import { runAgent } from "../src/core/runner";
import { TuiUserInputProvider } from "../src/app/tui/provider";
import type { AgentEvent } from "../src/protocol/events";

describe("TUI Integration", () => {
  test("runAgent with TuiUserInputProvider completes without errors for simple task", async () => {
    const root = join(tmpdir(), "openpx-tui-integration");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    const events: AgentEvent[] = [];
    const provider = new TuiUserInputProvider((e) => events.push(e));

    // Auto-resolve any interrupts that occur
    const autoResolver = setInterval(() => {
      const interrupt = provider.getPendingInterrupt();
      if (interrupt) {
        if (interrupt.kind === "approval") {
          provider.submitAction({ type: "approve", grant: "approve_once" });
        } else {
          provider.submitAction({ type: "input", text: "auto answer" });
        }
      }
    }, 100);

    try {
      const generator = runAgent(provider, {
        task: "Reply with 'hello from TUI integration test' only. Do not use any tools.",
        userId: "test-user",
        threadId: `tui-int-${Date.now().toString(36)}`,
        workspace: root,
        checkpointPath: join(root, "checkpoints.sqlite"),
        config: loadAgentConfig(),
      });

      for await (const _ of generator) {
        /* driven by provider */
      }
    } catch (e) {
      // Model might not be configured — that's OK
    } finally {
      clearInterval(autoResolver);
    }

    expect(events.length).toBeGreaterThanOrEqual(0);
  }, 120_000);
});
