import { describe, test, expect } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { AIMessage } from "@langchain/core/messages";
import { render } from "ink-testing-library";
import React from "react";
import App from "../src/app/tui/App";
import { eventReducer, createInitialState } from "../src/app/tui/App";
import type { Action } from "../src/app/tui/App";
import { TuiUserInputProvider } from "../src/app/tui/provider";
import { runAgent } from "../src/core/runner";
import { loadAgentConfig } from "../src/core/config/index";
import type { AgentEvent } from "../src/protocol/events";

describe("TUI Agent Integration (real loop + mock LLM)", () => {
  test("agent loop produces text events without stalling", async () => {
    const root = join(tmpdir(), "openpx-int-tui-real");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    // Mock model: returns a single AIMessage with text content
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "Hello! This is a test response from the mock model.",
          id: "mock-msg-1",
        }),
      ],
    });

    const events: AgentEvent[] = [];
    const dispatch = (event: AgentEvent) => { events.push(event); };
    const provider = new TuiUserInputProvider(dispatch);

    // Auto-resolve interrupts
    const autoResolve = setInterval(() => {
      const interrupt = provider.getPendingInterrupt();
      if (interrupt) {
        if (interrupt.kind === "approval") {
          provider.submitAction({ type: "approve", grant: "approve_once" });
        } else {
          provider.submitAction({ type: "input", text: "ok" });
        }
      }
    }, 50);

    try {
      const generator = runAgent(provider, {
        task: "Reply with a simple greeting. Do not use any tools.",
        userId: "test-user",
        threadId: `int-tui-${Date.now().toString(36)}`,
        workspace: root,
        checkpointPath: join(root, "checkpoints.sqlite"),
        config: loadAgentConfig(),
        model: model as any,
      });

      for await (const _ of generator) {
        // driven by provider, events pushed via dispatch callback
      }
    } finally {
      clearInterval(autoResolve);
    }

    // Must have produced at least text events
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.length).toBeGreaterThan(0);

    // Feed events through reducer and verify render
    let state = createInitialState();
    for (const event of events) {
      state = eventReducer(state, { type: "EVENT", event } as Action);
    }
    state = eventReducer(state, { type: "SET_IDLE" } as Action);

    const { lastFrame, unmount } = render(
      React.createElement(App, {
        state,
        dispatch: () => {},
        onToggleReason: () => {},
        provider,
      })
    );

    const ansi = lastFrame();
    expect(ansi).toContain("OpenPX");
    expect(ansi).toContain("Hello! This is a test response");

    unmount();
  }, 30_000);

  test("agent loop handles tool approval interrupt flow", async () => {
    const root = join(tmpdir(), "openpx-int-tui-approval");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });

    // Mock model: returns tool_call, then plain text
    const model = new FakeListChatModel({
      responses: [
        new AIMessage({
          content: "",
          id: "mock-msg-tool",
          tool_calls: [
            {
              id: "call_1",
              name: "shell_execute",
              args: { command: "echo hello", intent: "inspect" },
            },
          ],
        }),
        new AIMessage({
          content: "Shell command completed.",
          id: "mock-msg-text",
        }),
      ],
    });

    const events: AgentEvent[] = [];
    const provider = new TuiUserInputProvider((event) => { events.push(event); });

    let approvalResolved = false;
    const autoResolve = setInterval(() => {
      if (approvalResolved) return;
      const interrupt = provider.getPendingInterrupt();
      if (interrupt?.kind === "approval") {
        provider.submitAction({ type: "approve", grant: "approve_once" });
        approvalResolved = true;
      }
    }, 50);

    try {
      const generator = runAgent(provider, {
        task: "Run echo hello.",
        userId: "test-user",
        threadId: `int-tui-approval-${Date.now().toString(36)}`,
        workspace: root,
        checkpointPath: join(root, "cp.sqlite"),
        config: loadAgentConfig(),
        model: model as any,
      });

      for await (const _ of generator) {}
    } finally {
      clearInterval(autoResolve);
    }

    // Verify critical events are produced
    const eventTypes = new Set(events.map((e) => e.type));
    expect(eventTypes.has("tool_call")).toBe(true);
    expect(eventTypes.has("need_approval")).toBe(true);
    expect(eventTypes.has("step_begin")).toBe(true);
    expect(eventTypes.has("step_end")).toBe(true);
    // The full loop completed (no uncaught exceptions)
  }, 30_000);
});
