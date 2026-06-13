import React from "react";
import { render } from "ink-testing-library";
import { describe, test, expect } from "bun:test";
import CtrlSafeTextInput from "../src/app/tui/components/CtrlSafeTextInput";

function displayWidth(s: string): number {
  let w = 0;
  for (const c of s) {
    w += c.charCodeAt(0) > 127 ? 2 : 1;
  }
  return w;
}

describe("CtrlSafeTextInput mixed script wrapping", () => {
  test("fills remaining line width before breaking at script boundaries", () => {
    const value =
      "2222222222222222222222222222222222222222222222222222222222222222阿萨德撒打撒大叔大婶 2";
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    const lines = (lastFrame() ?? "").split("\n");
    // With cursor reserve the effective width is 17. No wrapped line (except
    // possibly the last) should leave more empty space than a single CJK char.
    for (const line of lines.slice(0, -1)) {
      expect(displayWidth(line)).toBeGreaterThanOrEqual(17 - 2);
      expect(displayWidth(line)).toBeLessThanOrEqual(17);
    }
  });

  test("fits part of CJK run when there is room on the current line", () => {
    const value = "hello世界你好";
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 8,
      }),
    );

    const lines = (lastFrame() ?? "").split("\n");
    // effective width is 7. "hello" (5) + "世" (2) = 7 fills the line.
    expect(lines[0]).toBe("hello世");
    expect(lines[1]).toContain("界你");
  });

  test("does not leave usable line width empty at script boundaries", () => {
    // 4 ASCII chars leave 3 effective cols. One CJK (2 cols) should fit.
    const value = "1234中文中文中";
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 8,
      }),
    );

    const lines = (lastFrame() ?? "").split("\n");
    expect(lines[0]).toMatch(/^1234[\u4e00-\u9fff]$/);
    expect(lines[1]).toBeDefined();
  });
});
