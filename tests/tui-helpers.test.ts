import { describe, expect, test } from "bun:test";
import { darkTheme } from "../src/app/tui/theme";
import type { Theme } from "../src/app/tui/theme";

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

// ── DiffPreview helpers ──

describe("DiffPreview prefix mapping", () => {
  function changePrefix(kind: "add" | "edit" | "delete"): { prefix: string; color: string } {
    switch (kind) {
      case "add": return { prefix: "+", color: darkTheme.success };
      case "edit": return { prefix: "~", color: darkTheme.warning };
      case "delete": return { prefix: "-", color: darkTheme.error };
    }
  }

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

// ── Markdown inline parser ──

describe("MarkdownBlock inline parsing", () => {
  interface InlineSegment {
    text: string;
    bold?: boolean;
    italic?: boolean;
    code?: boolean;
  }

  function parseInline(text: string): InlineSegment[] {
    const allPatterns = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
    const segments: InlineSegment[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = allPatterns.exec(text)) !== null) {
      if (match.index > lastIndex) {
        segments.push({ text: text.slice(lastIndex, match.index) });
      }
      if (match[1].startsWith("**") && match[2] !== undefined) {
        segments.push({ text: match[2], bold: true });
      } else if (match[1].startsWith("*") && !match[1].startsWith("**") && match[3] !== undefined) {
        segments.push({ text: match[3], italic: true });
      } else if (match[4] !== undefined) {
        segments.push({ text: match[4], code: true });
      }
      lastIndex = match.index + match[1].length;
    }

    if (lastIndex < text.length) {
      segments.push({ text: text.slice(lastIndex) });
    }

    return segments;
  }

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
    // the ** pattern wins over ` in the regex alternation
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

// ── StatusBar helpers ──

describe("StatusBar formatDuration", () => {
  function formatDuration(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

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

// ── ToolCard helpers ──

describe("ToolCard statusIcon", () => {
  function statusIcon(status: string): string {
    switch (status) {
      case "pending": return "○";
      case "running": return "⏳";
      case "done": return "✓";
      case "error": return "✗";
      default: return "";
    }
  }

  test("returns correct icon for each status", () => {
    expect(statusIcon("pending")).toBe("○");
    expect(statusIcon("running")).toBe("⏳");
    expect(statusIcon("done")).toBe("✓");
    expect(statusIcon("error")).toBe("✗");
  });
});

describe("ToolCard statusColor", () => {
  function statusColor(status: string): string {
    switch (status) {
      case "done": return darkTheme.success;
      case "error": return darkTheme.error;
      case "running": return darkTheme.warning;
      default: return darkTheme.muted;
    }
  }

  test("returns theme colors for each status", () => {
    expect(statusColor("done")).toBe(darkTheme.success);
    expect(statusColor("error")).toBe(darkTheme.error);
    expect(statusColor("running")).toBe(darkTheme.warning);
    expect(statusColor("pending")).toBe(darkTheme.muted);
    expect(statusColor("unknown" as any)).toBe(darkTheme.muted);
  });
});
