import React from "react";
import { render } from "ink-testing-library";
import App from "../../src/app/tui/App";
import { useTuiState } from "../../src/app/tui/App";
import type { Action as TuiAction } from "../../src/app/tui/App";
import type { TuiState, OutputBlock } from "../../src/app/tui/types";
import { TuiUserInputProvider } from "../../src/app/tui/provider";
import type { Scenario, Step, Snapshot, E2EResult } from "./types";
import { freezeAnsi, freezeState } from "./freeze";

let dispatchRef: ((a: TuiAction) => void) | null = null;
let stateRef: TuiState | null = null;
let snapshotIdx = 0;

function TuiMockRoot() {
  const { state, dispatch, onToggleReason } = useTuiState();
  dispatchRef = dispatch;
  stateRef = state;

  const provider = React.useMemo(
    () => new TuiUserInputProvider((_event) => {}),
    []
  );

  return React.createElement(App, {
    state,
    dispatch,
    onToggleReason,
    provider,
  });
}

function dispatch(action: TuiAction): void {
  if (dispatchRef) dispatchRef(action);
}

function getState(): TuiState | null {
  return stateRef;
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function takeSnapshot(
  reason: Snapshot["reason"],
  freezeKeys: string[],
  lastFrame: () => string
): Snapshot {
  const state = getState();
  if (!state) throw new Error("TUI state not initialized");
  snapshotIdx++;
  const rawAnsi = lastFrame();
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
      if (s && !s.running && !s.interrupt) { resolve(); return; }
      if (Date.now() - start > timeout) { reject(new Error("Timeout waiting for idle")); return; }
      setImmediate(poll);
    };
    poll();
  });
}

async function runStep(
  step: Step,
  timeout: number,
  freezeKeys: string[],
  lastFrame: () => string,
  snapshots: Snapshot[]
): Promise<void> {
  switch (step.type) {
    case "agent-text":
      dispatch({ type: "EVENT", event: { type: "text", data: { text: step.text } } });
      await tick();
      break;

    case "agent-reason":
      dispatch({ type: "EVENT", event: { type: "reason", data: { text: step.text } } });
      await tick();
      break;

    case "tool-call":
      dispatch({
        type: "EVENT",
        event: {
          type: "tool_call",
          data: { call_id: `mock-${Date.now()}`, name: step.tool as any, args: step.args },
        },
      });
      await tick();
      break;

    case "tool-result": {
      const state = getState();
      if (!state) throw new Error("State not initialized");
      const tcBlock = [...state.blocks].reverse().find(
        (b): b is Extract<OutputBlock, { kind: "tool_card" }> => b.kind === "tool_card"
      );
      if (!tcBlock) throw new Error("No pending tool card for tool-result");
      dispatch({
        type: "EVENT",
        event: {
          type: "tool_done",
          data: { call_id: tcBlock.callId, name: tcBlock.name, ok: true, summary: step.output },
        },
      });
      await tick();
      break;
    }

    case "need-approval":
      dispatch({
        type: "EVENT",
        event: {
          type: "need_approval",
          data: {
            tool: step.approval.tool as any,
            scope: "once" as const,
            cwd: process.cwd(),
            threadId: "mock-thread",
            command: step.approval.command,
            risk: step.approval.risk,
            summary: step.approval.summary,
            reason: "Test reason",
            approvalHash: "mock-hash",
            expectedEffects: [],
            grantOptions: ["approve_once", "same_command", "full_access"],
            recommendedGrant: "approve_once",
          },
        },
      });
      await tick();
      break;

    case "need-input":
      dispatch({
        type: "EVENT",
        event: {
          type: "need_input",
          data: {
            question: step.question.question,
            options: step.question.options,
            allow_free_text: step.question.allow_free_text ?? false,
          },
        },
      });
      await tick();
      break;

    case "expect-mode": {
      await waitForInterrupt(timeout);
      const state = getState()!;
      if (step.mode === "approval" && state.interrupt?.kind !== "approval") {
        throw new Error(`Expected approval mode, got ${state.interrupt?.kind}`);
      }
      if (step.mode === "question" && state.interrupt?.kind !== "input") {
        throw new Error(`Expected question mode, got ${state.interrupt?.kind}`);
      }
      snapshots.push(
        takeSnapshot(
          step.mode === "approval" ? "approval-wait" : "question-wait",
          freezeKeys,
          lastFrame
        )
      );
      break;
    }

    case "assert-snapshot":
      snapshots.push(takeSnapshot("explicit", freezeKeys, lastFrame));
      break;

    case "user-action":
      dispatch({
        type: "RESOLVE_INTERRUPT",
        blockId: getState()!.interrupt!.blockId,
        resolution: step.action,
      });
      await tick();
      break;

    case "user-input":
      dispatch({ type: "USER_MESSAGE", text: step.text });
      await tick();
      break;

    case "agent-done":
      dispatch({ type: "SET_EXITED" });
      dispatch({ type: "SET_IDLE" });
      await waitForIdle(timeout);
      snapshots.push(takeSnapshot("terminal", freezeKeys, lastFrame));
      break;

    default:
      throw new Error(`Unknown step type: ${(step as any).type}`);
  }
}

export async function runTuiE2E(scenario: Scenario): Promise<E2EResult> {
  const prevMock = process.env.OPENPX_MOCK;
  const prevColumns = process.stdout.columns;
  process.env.OPENPX_MOCK = "true";
  process.stdout.columns = scenario.terminalWidth;

  dispatchRef = null;
  stateRef = null;
  snapshotIdx = 0;

  const { lastFrame, unmount } = render(React.createElement(TuiMockRoot));

  const snapshots: Snapshot[] = [];
  const stepTimeout = scenario.stepTimeout ?? 5000;
  const freezeKeys = scenario.freeze ?? [];
  let pass = true;
  let error: string | undefined;

  try {
    for (const step of scenario.steps) {
      await runStep(step, stepTimeout, freezeKeys, lastFrame, snapshots);
    }
  } catch (e: any) {
    pass = false;
    error = e.message;
  } finally {
    unmount();
    if (prevMock !== undefined) {
      process.env.OPENPX_MOCK = prevMock;
    } else {
      delete process.env.OPENPX_MOCK;
    }
    process.stdout.columns = prevColumns ?? 80;
  }

  return { snapshots, pass, error };
}
