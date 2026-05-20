import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import Header from "../src/app/tui/Header";
import StatusBar from "../src/app/tui/StatusBar";

function fakeStatus() {
  return {
    phase: "building" as const, plan: null,
    authorization: "default" as const, workspaceAccess: "write" as const,
    cacheHitRate: 42, totalTokens: 123456, currentNode: null,
    modelName: "deepseek-v4", thinkingMode: "max",
  };
}

describe("Header", () => {
  test("shows working cat face when running", () => {
    const { lastFrame } = render(
      React.createElement(Header, { status: fakeStatus(), running: true })
    );
    expect(lastFrame()).toContain("( ^ ^ )");
  });

  test("shows idle cat face when not running", () => {
    const { lastFrame } = render(
      React.createElement(Header, { status: fakeStatus(), running: false })
    );
    expect(lastFrame()).toContain("( = = )");
  });
});

describe("StatusBar", () => {
  test("shows real cache hit rate and token count", () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: fakeStatus(), thinkingVisible: true, timerKey: 0, running: true })
    );
    const output = lastFrame();
    expect(output).toContain("42%");
    expect(output).toContain("123,456");
    expect(output).toContain("00:00");
  });
});
