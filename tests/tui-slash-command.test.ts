import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "../src/app/tui/hooks/useSlashCommand";
import type { SlashAction } from "../src/app/tui/hooks/useSlashCommand";

describe("parseSlashCommand", () => {
  test("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("  /help")).toBeNull(); // leading space
  });

  // ── /thinking ──
  test("parses /thinking", () => {
    expect(parseSlashCommand("/thinking")).toEqual({ type: "thinking" });
  });

  test("parses shorthand /t", () => {
    expect(parseSlashCommand("/t")).toEqual({ type: "thinking" });
  });

  // ── /model ──
  test("parses /model without args", () => {
    expect(parseSlashCommand("/model")).toEqual({ type: "model", name: undefined });
  });

  test("parses /model with name", () => {
    expect(parseSlashCommand("/model deepseek-v4")).toEqual({ type: "model", name: "deepseek-v4" });
  });

  test("parses /model with multi-word name", () => {
    expect(parseSlashCommand("/model claude sonnet 4")).toEqual({ type: "model", name: "claude sonnet 4" });
  });

  test("parses /model list", () => {
    expect(parseSlashCommand("/model list")).toEqual({ type: "model_list" });
  });

  test("/model list takes priority over name", () => {
    expect(parseSlashCommand("/model list")).not.toEqual({ type: "model", name: "list" });
    expect(parseSlashCommand("/model list")).toEqual({ type: "model_list" });
  });

  // ── /sessions ──
  test("parses /sessions without id", () => {
    expect(parseSlashCommand("/sessions")).toEqual({ type: "sessions", id: undefined });
  });

  test("parses /sessions with id", () => {
    expect(parseSlashCommand("/sessions run-abc123")).toEqual({ type: "sessions", id: "run-abc123" });
  });

  // ── /plan / /code ──
  test("parses /plan", () => {
    expect(parseSlashCommand("/plan")).toEqual({ type: "plan" });
  });

  test("parses /code", () => {
    expect(parseSlashCommand("/code")).toEqual({ type: "code" });
  });

  // ── /auth ──
  test("parses /auth without mode", () => {
    expect(parseSlashCommand("/auth")).toEqual({ type: "auth", mode: undefined });
  });

  test("parses /auth with mode", () => {
    expect(parseSlashCommand("/auth full_access")).toEqual({ type: "auth", mode: "full_access" });
  });

  // ── /clear ──
  test("parses /clear", () => {
    expect(parseSlashCommand("/clear")).toEqual({ type: "clear" });
  });

  test("parses shorthand /c", () => {
    expect(parseSlashCommand("/c")).toEqual({ type: "clear" });
  });

  // ── /compact ──
  test("parses /compact", () => {
    expect(parseSlashCommand("/compact")).toEqual({ type: "compact" });
  });

  // ── /undo / /redo ──
  test("parses /undo", () => {
    expect(parseSlashCommand("/undo")).toEqual({ type: "undo" });
  });

  test("parses /redo", () => {
    expect(parseSlashCommand("/redo")).toEqual({ type: "redo" });
  });

  // ── /export ──
  test("parses /export", () => {
    expect(parseSlashCommand("/export")).toEqual({ type: "export" });
  });

  // ── /editor ──
  test("parses /editor", () => {
    expect(parseSlashCommand("/editor")).toEqual({ type: "editor" });
  });

  // ── /setting ──
  test("parses /setting", () => {
    expect(parseSlashCommand("/setting")).toEqual({ type: "setting" });
  });

  test("parses alias /config", () => {
    expect(parseSlashCommand("/config")).toEqual({ type: "setting" });
  });

  // ── /help ──
  test("parses /help", () => {
    expect(parseSlashCommand("/help")).toEqual({ type: "help" });
  });

  test("parses shorthand /h", () => {
    expect(parseSlashCommand("/h")).toEqual({ type: "help" });
  });

  // ── /exit ──
  test("parses /exit", () => {
    expect(parseSlashCommand("/exit")).toEqual({ type: "exit" });
  });

  test("parses alias /quit", () => {
    expect(parseSlashCommand("/quit")).toEqual({ type: "exit" });
  });

  test("parses alias /q", () => {
    expect(parseSlashCommand("/q")).toEqual({ type: "exit" });
  });

  // ── unknown commands ──
  test("returns unknown for unrecognized commands", () => {
    expect(parseSlashCommand("/foobar")).toEqual({ type: "unknown", raw: "/foobar" });
  });

  test("unknown preserves the full raw input", () => {
    expect(parseSlashCommand("/nonexistent arg1 arg2")).toEqual({ type: "unknown", raw: "/nonexistent arg1 arg2" });
  });

  // ── edge cases ──
  test("handles extra whitespace between / and command", () => {
    // parser trims after /, so /   thinking is treated as /thinking
    expect(parseSlashCommand("/   thinking")).toEqual({ type: "thinking" });
  });

  test("handles trailing whitespace", () => {
    expect(parseSlashCommand("/thinking   ")).toEqual({ type: "thinking" });
  });

  test("handles no input after slash (just '/')", () => {
    expect(parseSlashCommand("/")).toEqual({ type: "unknown", raw: "/" });
  });

  test("handles empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });
});
