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
  return new Promise((resolve) => setTimeout(resolve, 50));
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

function waitForToolCardCount(targetCount: number, timeout: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      const s = getState();
      const count = s?.blocks.filter((b) => b.kind === "tool_card").length ?? 0;
      if (count >= targetCount) { resolve(); return; }
      if (Date.now() - start > timeout) { reject(new Error(`Timeout waiting for ${targetCount} tool_cards (have ${count})`)); return; }
      setImmediate(poll);
    };
    poll();
  });
}

function countToolCards(): number {
  return getState()?.blocks.filter((b) => b.kind === "tool_card").length ?? 0;
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

    case "tool-call": {
      const prevCount = countToolCards();
      dispatch({
        type: "EVENT",
        event: {
          type: "tool_call",
          data: { call_id: `mock-${Date.now()}`, name: step.tool as any, args: step.args },
        },
      });
      await waitForToolCardCount(prevCount + 1, timeout);
      break;
    }

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

    case "tool-error": {
      const state = getState();
      if (!state) throw new Error("State not initialized");
      const tcBlock = [...state.blocks].reverse().find(
        (b): b is Extract<OutputBlock, { kind: "tool_card" }> => b.kind === "tool_card"
      );
      if (!tcBlock) throw new Error("No pending tool card for tool-error");
      dispatch({
        type: "EVENT",
        event: {
          type: "tool_done",
          data: { call_id: tcBlock.callId, name: tcBlock.name, ok: false, summary: step.output },
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

    case "error":
      dispatch({
        type: "EVENT",
        event: { type: "error", data: { message: step.message, recoverable: true } },
      });
      await tick();
      break;

    case "retry":
      dispatch({
        type: "EVENT",
        event: { type: "retry", data: { attempt: step.attempt, reason: step.reason } },
      });
      await tick();
      break;

    case "file-change":
      dispatch({
        type: "EVENT",
        event: {
          type: "file_change",
          data: {
            path: step.path,
            kind: step.kind,
            linesAdded: step.linesAdded,
            linesRemoved: step.linesRemoved,
            preview: step.preview,
          },
        },
      });
      await tick();
      break;

    case "state-change":
      dispatch({
        type: "EVENT",
        event: {
          type: "state_change",
          data: {
            phase: step.phase,
            authorization: step.authorization ? { mode: step.authorization } : undefined,
            plan: step.plan,
          },
        },
      });
      await tick();
      break;

    case "cache-metrics":
      dispatch({
        type: "EVENT",
        event: {
          type: "cache_metrics",
          data: {
            workspaceAccess: "write" as const,
            cacheHitTokens: step.hitRate === 0 ? 0 : 100,
            cacheMissTokens: step.hitRate === 100 ? 0 : 100,
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            hitRate: step.hitRate,
            standard: {},
          },
        },
      });
      await tick();
      break;

    case "compact":
      dispatch({
        type: "EVENT",
        event: { type: "compact_begin", data: { reason: step.reason } },
      });
      await tick();
      dispatch({
        type: "EVENT",
        event: { type: "compact_end", data: { summary: step.summary } },
      });
      await tick();
      break;

    case "user-action": {
      const action = step.action;
      let resolution: string | { action: string; grant?: string; pattern?: string };

      if (action.type === "reject") {
        resolution = { action: "denied" };
      } else if (action.type === "approve") {
        resolution = { action: "approve_once", grant: action.grant };
      } else if (action.type === "input") {
        resolution = action.text;
      } else {
        resolution = { action: "unknown" };
      }

      dispatch({
        type: "RESOLVE_INTERRUPT",
        blockId: getState()!.interrupt!.blockId,
        resolution,
      });
      await tick();
      break;
    }

    case "user-input":
      dispatch({ type: "USER_MESSAGE", text: step.text });
      await tick();
      break;

    case "agent-done":
      dispatch({ type: "SET_IDLE" });
      await waitForIdle(timeout);
      await tick();
      await tick();
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
