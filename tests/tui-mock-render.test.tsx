import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import Header from "../src/app/tui/Header";
import StatusBar from "../src/app/tui/StatusBar";

function fakeStatus() {
  return {
    phase: "building" as const, plan: null,
    authorization: "default" as const, workspaceAccess: "write" as const,
    cacheHitTokens: 420, cacheMissTokens: 580, cacheHitRate: 0.42, totalTokens: 123456, currentNode: null,
    modelProvider: "deepseek" as const, modelName: "deepseek-v4", thinkingMode: "max",
  };
}

describe("Header", () => {
  test("shows working cat face when running", () => {
    const { lastFrame } = render(
      React.createElement(Header, { running: true })
    );
    expect(lastFrame()).toContain("( ^ ^ )");
  });

  test("shows idle cat face when not running", () => {
    const { lastFrame } = render(
      React.createElement(Header, { running: false })
    );
    expect(lastFrame()).toContain("( = = )");
  });
});

describe("StatusBar", () => {
  test("shows phase label and spinner when running", () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: fakeStatus(), timerKey: 0, running: true, compacting: false })
    );
    const output = lastFrame();
    expect(output).toContain("Building");
    // spinner character appears when running
    expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });

  test("shows only spinner + phase + plan (no metrics)", () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: fakeStatus(), timerKey: 0, running: false, compacting: false })
    );
    const output = lastFrame();
    expect(output).toContain("Building");
    // Metrics are in StatsLine, not StatusBar
    expect(output).not.toContain("42%");
    expect(output).not.toContain("123,456");
  });
});
