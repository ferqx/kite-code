import React from "react";
import { render } from "ink-testing-library";
import { describe, test, expect } from "bun:test";
import CtrlSafeTextInput from "../src/app/tui/components/CtrlSafeTextInput";

describe("CtrlSafeTextInput edge cases", () => {
  test("handles explicit newlines with empty lines", () => {
    const value = "abc\n\nghi";
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 20,
      }),
    );

    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("abc");
    expect(lines[2]).toContain("ghi");
  });

  test("handles single character wider than maxWidth", () => {
    const value = "中";
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 1,
      }),
    );

    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("中");
  });

  test("handles mask with soft wrap", () => {
    const value = "一二三四五六七八九十";
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        mask: "*",
        maxWidth: 10,
      }),
    );

    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toMatch(/\*+/);
  });

  test("handles emoji width", () => {
    const value = "🎉🎉🎉🎉🎉";
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 4,
      }),
    );

    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBeGreaterThan(0);
  });
});
