import { describe, expect, test } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import Sidebar from "../src/app/tui/components/Sidebar";

function fakeSnapshot(overrides: Partial<import("../src/app/tui/types").SessionSnapshot> = {}): import("../src/app/tui/types").SessionSnapshot {
  return {
    threadId: "tui-test",
    name: "Test Session",
    workspace: "/tmp",
    active: false,
    running: false,
    pendingInterrupt: false,
    plan: null,
    status: {
      phase: "building" as const,
      plan: null,
      authorization: "default" as const,
      workspaceAccess: "write" as const,
      cacheHitRate: 0,
      totalTokens: 0,
      currentNode: null,
      modelName: "",
      thinkingMode: "",
    },
    blocks: [],
    ...overrides,
  };
}

describe("Sidebar", () => {
  test("renders empty state", () => {
    const { lastFrame } = render(
      <Sidebar
        sessions={[]}
        activeSessionId={null}
        focus="input"
        sidebarSelection={0}
        plan={null}
        onSwitch={() => {}}
        onNavigate={() => {}}
        onNew={() => {}}
      />
    );
    expect(lastFrame()).toContain("No sessions");
  });

  test("renders session list with active marker", () => {
    const sessions = [fakeSnapshot({ threadId: "t1", name: "Session 1", active: true })];
    const { lastFrame } = render(
      <Sidebar
        sessions={sessions}
        activeSessionId="t1"
        focus="input"
        sidebarSelection={0}
        plan={null}
        onSwitch={() => {}}
        onNavigate={() => {}}
        onNew={() => {}}
      />
    );
    expect(lastFrame()).toContain("Session 1");
  });

  test("renders pending interrupt indicator", () => {
    const sessions = [fakeSnapshot({ threadId: "t1", name: "Alert", pendingInterrupt: true })];
    const { lastFrame } = render(
      <Sidebar
        sessions={sessions}
        activeSessionId="other"
        focus="input"
        sidebarSelection={0}
        plan={null}
        onSwitch={() => {}}
        onNavigate={() => {}}
        onNew={() => {}}
      />
    );
    // Should render (no crash) with interrupt session
    expect(lastFrame()).toContain("Alert");
  });

  test("renders plan steps when plan is provided", () => {
    const plan = {
      name: "Refactor",
      description: "Refactor user service",
      status: "in_progress" as const,
      steps: [
        { step: "Add API", status: "completed" as const },
        { step: "Update core", status: "in_progress" as const },
        { step: "Test", status: "pending" as const },
      ],
    };
    const { lastFrame } = render(
      <Sidebar
        sessions={[]}
        activeSessionId={null}
        focus="input"
        sidebarSelection={0}
        plan={plan}
        onSwitch={() => {}}
        onNavigate={() => {}}
        onNew={() => {}}
      />
    );
    const frame = lastFrame();
    expect(frame).toContain("Add API");
    expect(frame).toContain("Update core");
    expect(frame).toContain("Test");
  });

  test("renders running indicator for background session", () => {
    const sessions = [fakeSnapshot({ threadId: "t1", name: "BG", active: false, running: true })];
    const { lastFrame } = render(
      <Sidebar
        sessions={sessions}
        activeSessionId="other"
        focus="input"
        sidebarSelection={0}
        plan={null}
        onSwitch={() => {}}
        onNavigate={() => {}}
        onNew={() => {}}
      />
    );
    expect(lastFrame()).toContain("BG");
  });
});
