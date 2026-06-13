import React from "react";
import { render } from "ink-testing-library";
import { describe, test, expect } from "bun:test";
import CtrlSafeTextInput from "../src/app/tui/components/CtrlSafeTextInput";

async function wait(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("CtrlSafeTextInput End key on wrapped line", () => {
  test("End on line1 moves to line2 start", async () => {
    const value = "一二三四五六七八九十"; // line1=8 chars, line2=2 chars
    const { lastFrame, stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value,
        onChange: () => {},
        focus: true,
        showCursor: true,
        maxWidth: 18,
      }),
    );

    // Move to line1 start
    stdin.write("\x1b[1~");
    await wait(50);

    // End to line1 end -> should render on line2 start
    stdin.write("\x1b[4~");
    await wait(50);

    const lines = (lastFrame() ?? "").split("\n");
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("九");
  });
});
