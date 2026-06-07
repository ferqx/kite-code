import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "../src/app/tui/hooks/useSlashCommand";
import type { SlashAction } from "../src/app/tui/hooks/useSlashCommand";

describe("parseSlashCommand", () => {
  test("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
    expect(parseSlashCommand("  /help")).toBeNull(); // leading space
  });

  // ── /effort ──
  test("parses /effort", () => {
    expect(parseSlashCommand("/effort")).toEqual({ type: "effort", level: "max" });
  });

  test("parses /effort with level", () => {
    expect(parseSlashCommand("/effort low")).toEqual({ type: "effort", level: "low" });
  });

  test("parses /effort with medium level", () => {
    expect(parseSlashCommand("/effort medium")).toEqual({ type: "effort", level: "medium" });
  });

  test("parses /effort with high level", () => {
    expect(parseSlashCommand("/effort high")).toEqual({ type: "effort", level: "high" });
  });

  test("parses /effort with max level", () => {
    expect(parseSlashCommand("/effort max")).toEqual({ type: "effort", level: "max" });
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

  // ── /plan ──
  test("parses /plan", () => {
    expect(parseSlashCommand("/plan")).toEqual({ type: "plan" });
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
    // parser trims after /, so /   effort is treated as /effort
    expect(parseSlashCommand("/   effort")).toEqual({ type: "effort", level: "max" });
  });

  test("handles trailing whitespace", () => {
    expect(parseSlashCommand("/effort max   ")).toEqual({ type: "effort", level: "max" });
  });

  test("handles no input after slash (just '/')", () => {
    expect(parseSlashCommand("/")).toEqual({ type: "unknown", raw: "/" });
  });

  test("handles empty string", () => {
    expect(parseSlashCommand("")).toBeNull();
  });
});
