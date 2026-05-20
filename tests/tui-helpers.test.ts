import { describe, expect, test } from "bun:test";
import { darkTheme } from "../src/app/tui/theme";
import type { Theme } from "../src/app/tui/theme";
import { parseInline, type InlineSegment } from "../src/app/tui/components/MarkdownBlock";
import { changePrefix, toolColor } from "../src/app/tui/OutputArea";
import { formatDuration } from "../src/app/tui/Header";

describe("darkTheme", () => {
  test("has all required color keys", () => {
    const keys: (keyof Omit<Theme, "risk">)[] = ["primary", "success", "error", "warning", "muted", "dim", "bg"];
    for (const k of keys) {
      expect(darkTheme[k]).toBeString();
      expect(darkTheme[k]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  test("risk colors cover all risk levels with hex values", () => {
    const expectedRisks = ["read", "plan", "write_file", "execute_code", "destructive", "network", "vcs_mutation", "unknown"];
    for (const r of expectedRisks) {
      expect(darkTheme.risk[r]).toBeString();
      expect(darkTheme.risk[r]).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });
});

// ── OutputArea changePrefix ──

describe("changePrefix", () => {
  test("add returns + with success color", () => {
    expect(changePrefix("add")).toEqual({ prefix: "+", color: darkTheme.success });
  });

  test("edit returns ~ with warning color", () => {
    expect(changePrefix("edit")).toEqual({ prefix: "~", color: darkTheme.warning });
  });

  test("delete returns - with error color", () => {
    expect(changePrefix("delete")).toEqual({ prefix: "-", color: darkTheme.error });
  });
});

// ── MarkdownBlock parseInline ──

describe("parseInline", () => {
  test("plain text returns single segment", () => {
    const result = parseInline("hello world");
    expect(result).toEqual([{ text: "hello world" }]);
  });

  test("parses bold text with **", () => {
    const result = parseInline("this is **bold** text");
    expect(result).toEqual([
      { text: "this is " },
      { text: "bold", bold: true },
      { text: " text" },
    ]);
  });

  test("parses italic text with *", () => {
    const result = parseInline("this is *italic* text");
    expect(result).toEqual([
      { text: "this is " },
      { text: "italic", italic: true },
      { text: " text" },
    ]);
  });

  test("parses inline code with backticks", () => {
    const result = parseInline("use `const x = 1` here");
    expect(result).toEqual([
      { text: "use " },
      { text: "const x = 1", code: true },
      { text: " here" },
    ]);
  });

  test("parses mixed bold, italic, and code", () => {
    const result = parseInline("**bold** *italic* `code`");
    expect(result).toEqual([
      { text: "bold", bold: true },
      { text: " " },
      { text: "italic", italic: true },
      { text: " " },
      { text: "code", code: true },
    ]);
  });

  test("parses adjacent inline elements", () => {
    const result = parseInline("**a***b*");
    expect(result).toEqual([
      { text: "a", bold: true },
      { text: "b", italic: true },
    ]);
  });

  test("handles text with no formatting", () => {
    const result = parseInline("no formatting at all");
    expect(result).toEqual([{ text: "no formatting at all" }]);
  });

  test("handles empty string", () => {
    const result = parseInline("");
    expect(result).toEqual([]);
  });

  test("bold spans content containing backticks (backtick is not special inside **...** match)", () => {
    const result = parseInline("**bold `code` here**");
    expect(result).toEqual([
      { text: "bold `code` here", bold: true },
    ]);
  });

  test("unclosed bold treated as literal", () => {
    const result = parseInline("this **is not closed");
    expect(result).toEqual([{ text: "this **is not closed" }]);
  });

  test("unclosed italic treated as literal", () => {
    const result = parseInline("this *is not closed");
    expect(result).toEqual([{ text: "this *is not closed" }]);
  });
});

// ── formatDuration ──

describe("formatDuration", () => {
  test("0 seconds -> 00:00", () => {
    expect(formatDuration(0)).toBe("00:00");
  });

  test("59 seconds -> 00:59", () => {
    expect(formatDuration(59)).toBe("00:59");
  });

  test("60 seconds -> 01:00", () => {
    expect(formatDuration(60)).toBe("01:00");
  });

  test("3661 seconds -> 61:01", () => {
    expect(formatDuration(3661)).toBe("61:01");
  });
});

// ── OutputArea toolColor ──

describe("toolColor", () => {
  test("returns theme colors for each status", () => {
    expect(toolColor("done")).toBe(darkTheme.success);
    expect(toolColor("error")).toBe(darkTheme.error);
    expect(toolColor("running")).toBe(darkTheme.warning);
    expect(toolColor("pending")).toBe(darkTheme.muted);
    expect(toolColor("unknown")).toBe(darkTheme.muted);
  });
});
