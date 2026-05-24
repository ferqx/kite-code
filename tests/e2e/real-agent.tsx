/**
 * Real agent e2e test runner.
 *
 * Renders the full TUI (App + reducer + InputLine) and runs the actual agent
 * loop with a StreamingMockModel. Captures rendered ANSI output at key moments
 * and verifies content against assertions.
 */
import React from "react";
import { render } from "ink-testing-library";
import { AIMessage } from "@langchain/core/messages";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import App from "../../src/app/tui/App";
import InputLine from "../../src/app/tui/components/InputLine";
import { useTuiState } from "../../src/app/tui/App";
import type { Action as TuiAction } from "../../src/app/tui/App";
import type { TuiState } from "../../src/app/tui/types";
import { TuiUserInputProvider } from "../../src/app/tui/provider";
import { runAgent } from "../../src/core/runner";
import { loadAgentConfig } from "../../src/core/config/index";
import { StreamingMockModel } from "../mock-model";
import type { RealAgentScenario, Snapshot } from "./types";
import { freezeAnsi, freezeState } from "./freeze";
import { verifySnapshotExpectations } from "./helpers";

let dispatchRef: ((a: TuiAction) => void) | null = null;
let stateRef: TuiState | null = null;

function dispatch(action: TuiAction): void {
  if (dispatchRef) dispatchRef(action);
}

function getState(): TuiState | null {
  return stateRef;
}

function TuiRealAgentRoot() {
  const { state, dispatch, onToggleReason } = useTuiState();
  dispatchRef = dispatch;
  stateRef = state;

  // Provider does nothing in its constructor — events will be
  // dispatched manually by the runner when the agent loop emits them.
  const provider = React.useMemo(
    () => new TuiUserInputProvider((_event) => {}),
    []
  );

  const handleInput = React.useCallback(
    (value: string) => {
      if (value.trim()) {
        dispatch({ type: "USER_MESSAGE", text: value });
        dispatch({ type: "SET_RUNNING" });
      }
    },
    [dispatch]
  );

  return React.createElement(App, {
    state,
    dispatch,
    onToggleReason,
    provider,
  },
    React.createElement(InputLine, {
      mode: state.interrupt?.kind === "approval" ? "approval" : state.interrupt?.kind === "input" ? "question" : "prompt",
      onSubmit: handleInput,
      workspace: process.cwd(),
    })
  );
}

function tick(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tempWorkspace() {
  const root = join(tmpdir(), `openpx-e2e-${Date.now().toString(36)}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function takeSnapshot(
  reason: Snapshot["reason"],
  freezeKeys: string[],
  lastFrame: () => string | undefined,
  snapshotIdx: number
): Snapshot {
  const state = getState();
  if (!state) throw new Error("TUI state not initialized");
  const rawAnsi = lastFrame() ?? "";
  const rawState = JSON.parse(JSON.stringify(state));
  return {
    index: snapshotIdx,
    reason,
    ansi: freezeKeys.length > 0 ? freezeAnsi(rawAnsi, freezeKeys) : rawAnsi,
    state: freezeKeys.length > 0 ? freezeState(rawState, freezeKeys) : rawState,
  };
}

function waitForInterrupt(timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      if (getState()?.interrupt) { resolve(); return; }
      if (Date.now() - start > timeout) { reject(new Error("Timeout waiting for interrupt")); return; }
      setImmediate(poll);
    };
    poll();
  });
}

function waitForIdle(timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const s = getState();
      if (s && !s.running && !s.exited) { resolve(); return; }
      if (Date.now() - start > timeout) { reject(new Error("Timeout waiting for idle")); return; }
      setImmediate(poll);
    };
    poll();
  });
}

export async function runRealAgentE2E(
  scenarioName: string,
  scenario: RealAgentScenario,
): Promise<void> {
  const workspace = tempWorkspace();

  // Create workspace files so that tool calls (read_file, etc.) succeed
  if (scenario.workspaceFiles) {
    for (const [path, content] of Object.entries(scenario.workspaceFiles)) {
      const fullPath = join(workspace, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    }
  }

  // Allow scenario-specific workspace setup (skills, etc.)
  if (scenario.onWorkspaceReady) {
    await scenario.onWorkspaceReady(workspace);
  }

  const terminalWidth = scenario.terminalWidth ?? 120;
  const timeout = scenario.stepTimeout ?? 15000;
  const freezeKeys = scenario.freeze ?? [];
  const autoApprove = scenario.autoApprove ?? false;
  const prevColumns = process.stdout.columns;
  const prevMock = process.env.OPENPX_MOCK;
  process.stdout.columns = terminalWidth;
  process.env.OPENPX_MOCK = "true";

  dispatchRef = null;
  stateRef = null;

  const { lastFrame, unmount } = render(React.createElement(TuiRealAgentRoot));

  // Build mock responses
  const responses = scenario.modelResponses.map((r) => {
    if (r.error) return { message: new AIMessage({ content: "", id: "err" }), error: r.error, delay: r.delay };
    const tc = r.message?.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
    }));
    return {
      message: new AIMessage({
        content: r.message?.content ?? "",
        id: `m-${Date.now().toString(36)}`,
        tool_calls: tc as any,
      }),
      delay: r.delay,
    };
  });

  const model = new StreamingMockModel({ responses }) as any;

  // Wire agent events to TUI reducer
  const provider = new TuiUserInputProvider((event) => {
    dispatch({ type: "EVENT", event });
  });

  // Set running state
  dispatch({ type: "USER_MESSAGE", text: scenario.task });
  dispatch({ type: "SET_RUNNING" });

  await tick();

  // Auto-approve polling
  let autoApproveDone = false;
  const approvalTimer = autoApprove ? setInterval(() => {
    if (autoApproveDone) return;
    const i = provider.getPendingInterrupt();
    if (i?.kind === "approval") {
      provider.submitAction({ type: "approve", grant: "approve_once" });
    }
  }, 50) : undefined;

  const snapshots: Snapshot[] = [];
  let snapshotIdx = 0;
  let agentError: string | undefined;

  const gen = runAgent(provider, {
    task: scenario.task,
    userId: "e2e-user",
    threadId: `e2e-${Date.now().toString(36)}`,
    workspace,
    checkpointPath: join(workspace, "cp.sqlite"),
    config: loadAgentConfig(),
    model,
    mcpManager: scenario.mcpManager,
    skills: scenario.skills,
    skillOptions: scenario.skillOptions,
  });

  // Stream the agent — capture approval/question snapshots as they occur
  try {
    for await (const _ of gen) {
      const s = getState();
      if (s?.interrupt && !autoApprove) {
        snapshotIdx++;
        snapshots.push(takeSnapshot(
          s.interrupt.kind === "approval" ? "approval-wait" : "question-wait",
          freezeKeys, lastFrame, snapshotIdx
        ));
      }
    }
  } catch (e: any) {
    // Agent errors (model failures, etc.) are expected in error scenarios.
    // Don't fail — let the snapshot expectations verify behavior.
    agentError = e?.message ?? String(e);
  }

  autoApproveDone = true;
  if (approvalTimer) clearInterval(approvalTimer);

  // Dispatch exit sequence matching real app behavior
  dispatch({ type: "SET_EXITED" });
  await tick();
  dispatch({ type: "SET_IDLE" });

  await waitForIdle(timeout);
  await tick();
  await tick();

  // Take terminal snapshot (even on error — verifies loop completed)
  snapshotIdx++;
  snapshots.push(takeSnapshot("terminal", freezeKeys, lastFrame, snapshotIdx));
  unmount();
  process.stdout.columns = prevColumns;
  if (prevMock !== undefined) {
    process.env.OPENPX_MOCK = prevMock;
  } else {
    delete process.env.OPENPX_MOCK;
  }

  // Agent errors (e.g. model failures) are expected in error scenarios.
  // Let snapshot expectations handle verification — don't throw here.

  // Run verifications
  for (let i = 0; i < scenario.expectations.length; i++) {
    const snap = snapshots[i];
    if (!snap) {
      throw new Error(`[${scenarioName}] Missing snapshot ${i + 1} (expected ${scenario.expectations.length})`);
    }
    verifySnapshotExpectations(snap, scenario.expectations[i], scenarioName, i);
  }
}
