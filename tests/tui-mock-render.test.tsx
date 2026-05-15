import { describe, test, expect, beforeAll, afterAll } from "bun:test";
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

describe("Header in mock mode", () => {
  let prev: string | undefined;
  beforeAll(() => { prev = process.env.OPENPX_MOCK; process.env.OPENPX_MOCK = "true"; });
  afterAll(() => { if (prev !== undefined) process.env.OPENPX_MOCK = prev; else delete process.env.OPENPX_MOCK; });

  test("shows frozen timer when running", () => {
    const { lastFrame } = render(
      React.createElement(Header, { status: fakeStatus(), running: true, timerKey: 0 })
    );
    expect(lastFrame()).toContain("<TIMER>");
  });
});

describe("StatusBar in mock mode", () => {
  let prev: string | undefined;
  beforeAll(() => { prev = process.env.OPENPX_MOCK; process.env.OPENPX_MOCK = "true"; });
  afterAll(() => { if (prev !== undefined) process.env.OPENPX_MOCK = prev; else delete process.env.OPENPX_MOCK; });

  test("shows frozen cache/tokens/timer", () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, { status: fakeStatus(), thinkingVisible: true, timerKey: 0, running: true })
    );
    const output = lastFrame();
    expect(output).toContain("<CACHE_HIT_RATE>");
    expect(output).toContain("<CACHE_TOKEN_COUNT>");
    expect(output).toContain("<TIMER>");
  });
});
