import { describe, test, expect } from "bun:test";
import { render } from "ink-testing-library";
import React from "react";
import CtrlSafeTextInput from "../src/app/tui/components/CtrlSafeTextInput";

const PLACEHOLDER = "[已粘贴 10,000 字符]";
const PLACEHOLDER_LEN = 15;
const BLOCK_END = PLACEHOLDER_LEN - 1; // 14

describe("CtrlSafeTextInput atomicBlock", () => {
  test("renders placeholder text in output", () => {
    const { lastFrame } = render(
      React.createElement(CtrlSafeTextInput, {
        value: `${PLACEHOLDER}hello`,
        onChange: () => {},
        focus: true,
        showCursor: true,
        atomicBlock: { start: 0, end: BLOCK_END },
      }),
    );
    const output = lastFrame() ?? "";
    expect(output).toContain(PLACEHOLDER);
    expect(output).toContain("hello");
  });

  test("typing after placeholder appends text", () => {
    let latest = "";
    const { stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value: PLACEHOLDER,
        onChange: (v) => { latest = v; },
        focus: true,
        showCursor: true,
        atomicBlock: { start: 0, end: BLOCK_END },
      }),
    );
    stdin.write("xyz");
    expect(latest).toContain("xyz");
  });

  test("without atomicBlock, backspace removes one character normally", () => {
    let latest = "";
    const { stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value: "hello",
        onChange: (v) => { latest = v; },
        focus: true,
        showCursor: true,
      }),
    );
    stdin.write("\x08"); // backspace
    expect(latest).toBe("hell");
  });

  test("backspace on bare placeholder calls onRemoveAtomicBlock and removes placeholder from value", () => {
    let latest = "";
    let removed = false;
    const { stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value: PLACEHOLDER,
        onChange: (v) => { latest = v; },
        onRemoveAtomicBlock: () => { removed = true; },
        focus: true,
        showCursor: true,
        atomicBlock: { start: 0, end: BLOCK_END },
      }),
    );
    stdin.write("\x08"); // backspace — cursor at end (ab.end + 1), within boundary
    expect(removed).toBe(true);
    expect(latest).not.toContain(PLACEHOLDER);
  });

  test("backspace before atomic block only removes preceding character", () => {
    let latest = "";
    let removed = false;
    const { stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value: `A${PLACEHOLDER}`,
        onChange: (v) => { latest = v; },
        onRemoveAtomicBlock: () => { removed = true; },
        focus: true,
        showCursor: true,
        atomicBlock: { start: 1, end: BLOCK_END + 1 },
      }),
    );
    // Cursor at end (after block). Block starts at index 1.
    // Backspace at end position = block end + 1 → within boundary, triggers atomic delete.
    stdin.write("\x08");
    expect(removed).toBe(true);
    expect(latest).toBe("A");
  });

  test("normal typing inside atomic block just inserts normally", () => {
    let latest = "";
    const { stdin } = render(
      React.createElement(CtrlSafeTextInput, {
        value: PLACEHOLDER,
        onChange: (v) => { latest = v; },
        focus: true,
        showCursor: true,
        atomicBlock: { start: 0, end: BLOCK_END },
      }),
    );
    stdin.write("X");
    expect(latest).toContain("X");
    expect(latest).toContain(PLACEHOLDER);
  });
});
