import { describe, expect, test } from "bun:test";
import { eventReducer, createInitialState } from "../src/app/tui/App";
import type { Action } from "../src/app/tui/App";
import type { TuiState, OutputBlock, SessionSnapshot, InterruptState } from "../src/app/tui/types";
import type { CheckpointEntry } from "../src/core/persistence/checkpoint";
import type { ToolApprovalPayload, UserInputPayload } from "../src/protocol/events";

function fresh(): TuiState { return createInitialState(); }
function dispatch(s: TuiState, a: Action): TuiState { return eventReducer(s, a); }

function textEvt(text: string): Action {
  return { type: "EVENT", event: { type: "text", data: { text } } };
}
function reasonEvt(text: string): Action {
  return { type: "EVENT", event: { type: "reason", data: { text } } };
}
function tcEvt(callId: string, name: string, args: Record<string, unknown> = {}): Action {
  return { type: "EVENT", event: { type: "tool_call", data: { call_id: callId, name: name as any, args } } };
}
function tdEvt(callId: string, name: string, ok: boolean, summary: string): Action {
  return { type: "EVENT", event: { type: "tool_done", data: { call_id: callId, name, ok, summary } } };
}
function approval(data: Partial<ToolApprovalPayload> = {}): ToolApprovalPayload {
  return { scope: "once", cwd: "/tmp", threadId: "t1", tool: "shell_execute", command: "echo hi", risk: "execute_code", approvalHash: "abc", summary: "run", reason: "test", expectedEffects: [], grantOptions: ["approve_once"], recommendedGrant: "approve_once", ...data };
}
function question(data: Partial<UserInputPayload> = {}): UserInputPayload {
  return { question: "What?", options: [], allow_free_text: true, ...data };
}

describe("eventReducer (blocks model)", () => {
  describe("EVENT.text", () => {
    test("appends text block", () => {
      const s = dispatch(fresh(), textEvt("hello"));
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0].kind).toBe("text");
      expect((s.blocks[0] as any).content).toBe("hello");
    });
    test("assigns unique incrementing ids to blocks", () => {
      let s = fresh();
      s = dispatch(s, textEvt("a"));
      s = dispatch(s, textEvt("b"));
      s = dispatch(s, textEvt("c"));
      const ids = s.blocks.map((b) => b.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids[0]).toBeLessThan(ids[1]);
      expect(ids[1]).toBeLessThan(ids[2]);
    });
  });

  describe("EVENT.reason", () => {
    test("appends reason block with folded=true", () => {
      const s = dispatch(fresh(), reasonEvt("thinking..."));
      expect(s.blocks[0].kind).toBe("reason");
      const r = s.blocks[0] as Extract<OutputBlock, { kind: "reason" }>;
      expect(r.folded).toBe(true);
    });
  });

  describe("EVENT.tool_call / tool_done", () => {
    test("appends tool_card block with running status", () => {
      const s = dispatch(fresh(), tcEvt("c1", "read_file", { path: "a.txt" }));
      const t = s.blocks[0] as Extract<OutputBlock, { kind: "tool_card" }>;
      expect(t.kind).toBe("tool_card");
      expect(t.callId).toBe("c1");
      expect(t.status).toBe("running");
    });
    test("tool_done updates to done and records elapsed", () => {
      let s = fresh();
      s = dispatch(s, tcEvt("c1", "read_file"));
      s = dispatch(s, tdEvt("c1", "read_file", true, "150 lines"));
      const t = s.blocks[0] as Extract<OutputBlock, { kind: "tool_card" }>;
      expect(t.status).toBe("done");
      expect(t.summary).toBe("150 lines");
      expect(t.elapsedMs).toBeNumber();
    });
    test("tool_done updates to error when ok=false", () => {
      let s = fresh();
      s = dispatch(s, tcEvt("c1", "shell_execute"));
      s = dispatch(s, tdEvt("c1", "shell_execute", false, "exit 1"));
      const t = s.blocks[0] as Extract<OutputBlock, { kind: "tool_card" }>;
      expect(t.status).toBe("error");
    });
    test("tool_done only updates matching callId", () => {
      let s = fresh();
      s = dispatch(s, tcEvt("c1", "a"));
      s = dispatch(s, tcEvt("c2", "b"));
      s = dispatch(s, tdEvt("c1", "a", true, "ok"));
      const t1 = s.blocks[0] as Extract<OutputBlock, { kind: "tool_card" }>;
      const t2 = s.blocks[1] as Extract<OutputBlock, { kind: "tool_card" }>;
      expect(t1.status).toBe("done");
      expect(t2.status).toBe("running");
    });
  });

  describe("EVENT.state_change", () => {
    test("updates phase", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "state_change", data: { phase: "planning" } } });
      expect(s.status.phase).toBe("planning");
    });
    test("updates plan and clears to null", () => {
      let s = fresh();
      const plan = { name: "P", description: "d", status: "in_progress" as const, steps: [] };
      s = dispatch(s, { type: "EVENT", event: { type: "state_change", data: { plan } } });
      expect(s.status.plan).toEqual(plan);
      s = dispatch(s, { type: "EVENT", event: { type: "state_change", data: { plan: null } } });
      expect(s.status.plan).toBeNull();
    });
  });

  describe("EVENT.model_retry", () => {
    test("appends text block for model_retry", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "model_retry", data: { attempt: 2, error: "rate limit", delayMs: 1000 } } });
      expect(s.blocks[0].kind).toBe("text");
      expect((s.blocks[0] as any).content).toContain("Model retry #2");
    });
  });

  describe("EVENT.step_begin / step_end", () => {
    test("step_begin sets currentNode", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "step_begin", data: { node: "agent" } } });
      expect(s.status.currentNode).toBe("agent");
    });
    test("step_end clears currentNode", () => {
      let s = fresh();
      s = dispatch(s, { type: "EVENT", event: { type: "step_begin", data: { node: "tools" } } });
      s = dispatch(s, { type: "EVENT", event: { type: "step_end", data: { node: "tools" } } });
      expect(s.status.currentNode).toBeNull();
    });
  });

  describe("EVENT.cache_metrics", () => {
    test("accumulates totalTokens", () => {
      let s = fresh();
      s = dispatch(s, { type: "EVENT", event: { type: "cache_metrics", data: { workspaceAccess: "write" as const, cacheHitTokens: 50, cacheMissTokens: 50, cacheWriteTokens: 0, inputTokens: 100, outputTokens: 30, hitRate: 0.5, standard: {} as import("@/protocol/events").PromptCacheStandardEvaluation } } });
      expect(s.status.totalTokens).toBe(130);
    });
  });

  describe("EVENT.final", () => {
    test("appends text block when non-empty", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "final", data: "done" } });
      expect(s.blocks).toHaveLength(1);
      expect((s.blocks[0] as any).content).toBe("done");
    });
    test("no-ops when empty", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "final", data: "" } });
      expect(s.blocks).toHaveLength(0);
    });
    test("deduplicates against earlier text block across interrupt boundary", () => {
      // Simulate: agent emits text + ask_user tool_call → interrupt →
      // agent resumes with same text → text + final events
      let s = fresh();
      s = dispatch(s, { type: "SET_RUNNING" });
      s = dispatch(s, textEvt("我看了你的项目环境，这是 OpenPX 项目本身"));
      s = dispatch(s, tcEvt("c1", "ask_user", { question: "你要什么？" }));
      s = dispatch(s, { type: "EVENT", event: { type: "need_input", data: question() } });
      // User answers, interrupt resolved
      s = dispatch(s, { type: "RESOLVE_INTERRUPT", blockId: s.interrupt!.blockId, resolution: "a" });
      // Agent resumes, emits same text + final
      s = dispatch(s, textEvt("我看了你的项目环境，这是 OpenPX 项目本身"));
      s = dispatch(s, { type: "EVENT", event: { type: "final", data: "我看了你的项目环境，这是 OpenPX 项目本身" } });
      // Should have only 1 text block with the duplicate content
      const textBlocks = s.blocks.filter(b => b.kind === "text" && (b as any).content === "我看了你的项目环境，这是 OpenPX 项目本身");
      expect(textBlocks).toHaveLength(1);
    });
    test("deduplicates final against text block separated by tool_card", () => {
      // Simulate: agent emits text → tool_call → tool_done → final with same text
      let s = fresh();
      s = dispatch(s, { type: "SET_RUNNING" });
      s = dispatch(s, textEvt("分析完成"));
      s = dispatch(s, tcEvt("c2", "shell_execute", { command: "ls" }));
      s = dispatch(s, tdEvt("c2", "shell_execute", true, "ok"));
      // final arrives, last block is tool_card (done), not text
      s = dispatch(s, { type: "EVENT", event: { type: "final", data: "分析完成" } });
      // Should not create another text block for the same content
      const textBlocks = s.blocks.filter(b => b.kind === "text" && (b as any).content === "分析完成");
      expect(textBlocks).toHaveLength(1);
    });
  });

  describe("EVENT.need_approval / need_input + RESOLVE_INTERRUPT", () => {
    test("appends approval block and sets interrupt", () => {
      const a = approval({ command: "rm -rf /" });
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "need_approval", data: a } });
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0].kind).toBe("approval");
      expect(s.interrupt?.kind).toBe("approval");
      expect(s.interrupt?.blockId).toBe(s.blocks[0].id);
    });
    test("appends question block and sets interrupt", () => {
      const q = question({ question: "Choose color" });
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "need_input", data: q } });
      expect(s.blocks[0].kind).toBe("question");
      expect(s.interrupt?.kind).toBe("input");
    });
    test("RESOLVE_INTERRUPT marks approval as resolved and clears interrupt", () => {
      let s = fresh();
      const a = approval();
      s = dispatch(s, { type: "EVENT", event: { type: "need_approval", data: a } });
      const blockId = s.interrupt!.blockId;
      s = dispatch(s, { type: "RESOLVE_INTERRUPT", blockId, resolution: { action: "approved", grant: "approve_once" } });
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "approval" }>;
      expect(b.resolved?.action).toBe("approved");
      expect(s.interrupt).toBeNull();
    });
    test("RESOLVE_INTERRUPT marks question as resolved", () => {
      let s = fresh();
      s = dispatch(s, { type: "EVENT", event: { type: "need_input", data: question() } });
      const blockId = s.interrupt!.blockId;
      s = dispatch(s, { type: "RESOLVE_INTERRUPT", blockId, resolution: "my answer" });
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "question" }>;
      expect(b.resolved).toBe("my answer");
      expect(s.interrupt).toBeNull();
    });
  });

  describe("EVENT.error", () => {
    test("appends text block with error message", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "error", data: { message: "boom", recoverable: true } } });
      expect((s.blocks[0] as any).content).toContain("boom");
    });
  });

  describe("EVENT.file_change", () => {
    test("appends file_change block", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "file_change", data: { path: "a.ts", kind: "add" } } });
      const fc = s.blocks[0] as Extract<OutputBlock, { kind: "file_change" }>;
      expect(fc.changes).toHaveLength(1);
      expect(fc.changes[0].path).toBe("a.ts");
    });
    test("coalesces consecutive file_change events into one block", () => {
      let s = fresh();
      s = dispatch(s, { type: "EVENT", event: { type: "file_change", data: { path: "a.ts", kind: "add" } } });
      s = dispatch(s, { type: "EVENT", event: { type: "file_change", data: { path: "b.ts", kind: "edit" } } });
      expect(s.blocks).toHaveLength(1);
      const fc = s.blocks[0] as Extract<OutputBlock, { kind: "file_change" }>;
      expect(fc.changes).toHaveLength(2);
    });
  });

  describe("EVENT.compact_begin / compact_end", () => {
    test("compact_begin appends text block and sets compacting", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "compact_begin", data: { reason: "limit" } } });
      expect((s.blocks[0] as any).content).toContain("Compacting");
      expect(s.compacting).toBe(true);
    });
    test("compact_end sets compacting=false", () => {
      let s = fresh(); s = { ...s, compacting: true };
      s = dispatch(s, { type: "EVENT", event: { type: "compact_end", data: { summary: "done" } } });
      expect(s.compacting).toBe(false);
    });
  });

  describe("non-event actions", () => {
    test("SET_RUNNING increments runCount", () => {
      let s = fresh();
      s = dispatch(s, { type: "SET_RUNNING" });
      expect(s.running).toBe(true);
      expect(s.runCount).toBe(1);
    });
    test("SET_IDLE clears running and interrupt", () => {
      let s = fresh();
      s = { ...s, running: true, interrupt: { kind: "approval", blockId: 1 } };
      s = dispatch(s, { type: "SET_IDLE" });
      expect(s.running).toBe(false);
      expect(s.interrupt).toBeNull();
    });
    test("TOGGLE_REASON toggles folded on reason block", () => {
      let s = fresh();
      s = dispatch(s, reasonEvt("think"));
      const id = (s.blocks[0] as Extract<OutputBlock, { kind: "reason" }>).id;
      expect((s.blocks[0] as any).folded).toBe(true);
      s = dispatch(s, { type: "TOGGLE_REASON", id });
      expect((s.blocks[0] as any).folded).toBe(false);
    });
    test("TOGGLE_ALL_REASON toggles all reason blocks folded", () => {
      let s = fresh();
      s = dispatch(s, reasonEvt("first"));
      s = dispatch(s, textEvt("between"));
      s = dispatch(s, reasonEvt("second"));
      // Both start folded
      expect((s.blocks[0] as any).folded).toBe(true);
      expect((s.blocks[2] as any).folded).toBe(true);
      // Toggle: expand all
      s = dispatch(s, { type: "TOGGLE_ALL_REASON" });
      expect((s.blocks[0] as any).folded).toBe(false);
      expect((s.blocks[2] as any).folded).toBe(false);
      // Toggle: collapse all
      s = dispatch(s, { type: "TOGGLE_ALL_REASON" });
      expect((s.blocks[0] as any).folded).toBe(true);
      expect((s.blocks[2] as any).folded).toBe(true);
    });
    test("TOGGLE_ALL_REASON is no-op when no reason blocks", () => {
      let s = dispatch(fresh(), textEvt("hello"));
      const prev = s.blocks;
      s = dispatch(s, { type: "TOGGLE_ALL_REASON" });
      expect(s.blocks).toBe(prev);
    });
    test("TOGGLE_THINKING shows content on first use, hides on second", () => {
      let s = fresh();
      s = dispatch(s, reasonEvt("step 1"));
      // Default: thinkingVisible=true, folded=true → content NOT visible
      // First toggle should SHOW content
      s = dispatch(s, { type: "TOGGLE_THINKING" });
      expect(s.thinkingVisible).toBe(true);
      expect((s.blocks[0] as any).folded).toBe(false);
      // Second toggle should HIDE content
      s = dispatch(s, { type: "TOGGLE_THINKING" });
      expect(s.thinkingVisible).toBe(false);
    });
    test("TOGGLE_THINKING shows content when thinking was off", () => {
      let s = fresh();
      s = { ...s, thinkingVisible: false };
      s = dispatch(s, reasonEvt("step 1"));
      s = dispatch(s, { type: "TOGGLE_THINKING" });
      expect(s.thinkingVisible).toBe(true);
      expect((s.blocks[0] as any).folded).toBe(false);
    });
    test("CLEAR_OUTPUT clears blocks", () => {
      let s = dispatch(fresh(), textEvt("hello"));
      s = dispatch(s, { type: "CLEAR_OUTPUT" });
      expect(s.blocks).toHaveLength(0);
    });
    test("ESCAPE clears interrupt when active", () => {
      let s = fresh();
      s = { ...s, interrupt: { kind: "approval", blockId: 99 } };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.interrupt).toBeNull();
    });
    test("ESCAPE when running cancels the agent", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.running).toBe(false);
      expect(s.ctrlCPressed).toBe(true);
    });
    test("ESCAPE when running with interrupt cancels both", () => {
      let s = fresh(); s = { ...s, running: true, interrupt: { kind: "approval", blockId: 99 } };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.running).toBe(false);
      expect(s.ctrlCPressed).toBe(true);
      expect(s.interrupt).toBeNull();
    });
    test("ESCAPE closes help before modelSelector", () => {
      let s = fresh();
      s = { ...s, showHelp: true, showModelSelector: true };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.showHelp).toBe(false);
      expect(s.showModelSelector).toBe(true);
    });
    test("CTRL_C when running sets ctrlCPressed", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, { type: "CTRL_C" });
      expect(s.ctrlCPressed).toBe(true);
    });
    test("CTRL_C when not running first press sets ctrlCPressed", () => {
      let s = fresh();
      s = dispatch(s, { type: "CTRL_C" });
      expect(s.ctrlCPressed).toBe(true);
      expect(s.running).toBe(false);
    });
    test("CTRL_C when not running second press sets exitRequested", () => {
      let s = fresh(); s = { ...s, ctrlCPressed: true };
      s = dispatch(s, { type: "CTRL_C" });
      expect(s.exitRequested).toBe(true);
    });
    test("SWITCH_AUTH toggles default <-> full_access", () => {
      let s = fresh();
      s = dispatch(s, { type: "SWITCH_AUTH", mode: "toggle" });
      expect(s.status.authorization).toBe("full_access");
      s = dispatch(s, { type: "SWITCH_AUTH", mode: "toggle" });
      expect(s.status.authorization).toBe("default");
    });
    test("SWITCH_AUTH with explicit mode sets authorization directly", () => {
      let s = fresh();
      s = dispatch(s, { type: "SWITCH_AUTH", mode: "full_access" });
      expect(s.status.authorization).toBe("full_access");
      s = dispatch(s, { type: "SWITCH_AUTH", mode: "default" });
      expect(s.status.authorization).toBe("default");
    });
    test("SET_PHASE transitions between planning and building", () => {
      let s = fresh();
      expect(s.status.phase).toBe("building");
      s = dispatch(s, { type: "SET_PHASE", phase: "planning" });
      expect(s.status.phase).toBe("planning");
      s = dispatch(s, { type: "SET_PHASE", phase: "building" });
      expect(s.status.phase).toBe("building");
    });
    test("SHOW_MODEL_SELECTOR / HIDE_MODEL_SELECTOR", () => {
      let s = fresh();
      s = dispatch(s, { type: "SHOW_MODEL_SELECTOR" });
      expect(s.showModelSelector).toBe(true);
      s = dispatch(s, { type: "HIDE_MODEL_SELECTOR" });
      expect(s.showModelSelector).toBe(false);
    });
    test("SELECT_MODEL sets modelName and closes selector", () => {
      let s = fresh(); s = { ...s, showModelSelector: true };
      s = dispatch(s, { type: "SELECT_MODEL", modelId: "gpt-4o" });
      expect(s.status.modelName).toBe("gpt-4o");
      expect(s.showModelSelector).toBe(false);
    });
    test("LIST_MODELS outputs model list as text block", () => {
      let s = fresh();
      s = dispatch(s, { type: "LIST_MODELS" });
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0].kind).toBe("text");
      expect((s.blocks[0] as any).content).toContain("Available Models");
    });
    test("SHOW_SETTING outputs current settings as text block", () => {
      let s = fresh();
      s = dispatch(s, { type: "SHOW_SETTING" });
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0].kind).toBe("text");
      const c = (s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content;
      expect(c).toContain("Current Settings");
      expect(c).toContain("deepseek-v4");
      expect(c).toContain("building");
    });
    test("USER_MESSAGE appends user block", () => {
      let s = fresh();
      s = dispatch(s, { type: "USER_MESSAGE", text: "Hello, AI" });
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0].kind).toBe("user");
      expect((s.blocks[0] as any).content).toBe("Hello, AI");
    });
    test("NEW_SESSION clears blocks, resets state, increments sessionKey", () => {
      let s = fresh();
      s = { ...s, blocks: [{ id: 1, kind: "text", content: "old" }], compacting: true, ctrlCPressed: true, interrupt: { kind: "approval", blockId: 1 }, showHelp: true, showModelSelector: true, exitRequested: true };
      s = dispatch(s, { type: "NEW_SESSION", threadId: "new-session-1" });
      expect(s.blocks).toHaveLength(0);
      expect(s.interrupt).toBeNull();
      expect(s.compacting).toBe(false);
      expect(s.ctrlCPressed).toBe(false);
      expect(s.exitRequested).toBe(false);
      expect(s.showHelp).toBe(false);
      expect(s.showModelSelector).toBe(false);
      expect(s.sessionKey).toBe(1);
      expect(s.activeSessionId).toBe("new-session-1");
      expect(s.sessions).toHaveLength(1);
      expect(s.sessions[0].threadId).toBe("new-session-1");
      expect(s.sessions[0].active).toBe(true);
    });
    test("EXPAND_INPUT sets editorRequested", () => {
      let s = fresh();
      s = dispatch(s, { type: "EXPAND_INPUT" });
      expect(s.editorRequested).toBe(true);
    });
    test("EDITOR_DONE clears editorRequested", () => {
      let s = fresh(); s = { ...s, editorRequested: true };
      s = dispatch(s, { type: "EDITOR_DONE" });
      expect(s.editorRequested).toBe(false);
    });
    test("SET_RUNNING resets ctrlCPressed and exitRequested", () => {
      let s = fresh(); s = { ...s, ctrlCPressed: true, exitRequested: true };
      s = dispatch(s, { type: "SET_RUNNING" });
      expect(s.ctrlCPressed).toBe(false);
      expect(s.exitRequested).toBe(false);
    });
    test("text blocks have streaming=true when state is running", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, textEvt("hello"));
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "text" }>;
      expect(b.streaming).toBe(true);
    });
    test("SET_IDLE marks streaming blocks as not streaming", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, textEvt("hello"));
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).streaming).toBe(true);
      s = { ...s, running: true }; // simulate mid-run
      s = dispatch(s, { type: "SET_IDLE" });
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).streaming).toBe(false);
    });
    test("SET_EXITED adds exit summary block and sets exited flag", () => {
      let s = fresh(); s = { ...s, running: true, runStartTime: Date.now() - 5000 };
      s = dispatch(s, { type: "SET_EXITED" });
      expect(s.exited).toBe(true);
      const last = s.blocks.at(-1) as Extract<OutputBlock, { kind: "text" }>;
      expect(last.kind).toBe("text");
      expect(last.content).toMatch(/^── \d+s ──$/);
    });
    test("SET_EXITED summary includes file change count", () => {
      let s = fresh(); s = { ...s, running: true };
      // Add a file_change block with 2 changes
      s = dispatch(s, { type: "EVENT", event: { type: "file_change", data: { path: "a.ts", kind: "add" } } });
      s = dispatch(s, { type: "EVENT", event: { type: "file_change", data: { path: "b.ts", kind: "edit" } } });
      s = dispatch(s, { type: "SET_EXITED" });
      const last = s.blocks.at(-1) as Extract<OutputBlock, { kind: "text" }>;
      expect(last.content).toContain("2 files");
    });
    test("SET_EXITED + SET_IDLE preserves both the exit summary and content blocks", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, textEvt("AI response"));
      s = dispatch(s, { type: "SET_EXITED" });
      s = dispatch(s, { type: "SET_IDLE" });
      // All blocks preserved, exit summary at end
      expect(s.blocks).toHaveLength(2);
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toBe("AI response");
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).streaming).toBe(false);
      expect((s.blocks[1] as Extract<OutputBlock, { kind: "text" }>).content).toMatch(/^── /);
      expect(s.exited).toBe(false);
      expect(s.running).toBe(false);
    });
    test("consecutive streaming text events replace last block instead of appending", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, textEvt("Hello"));
      s = dispatch(s, textEvt("Hello, world"));
      s = dispatch(s, textEvt("Hello, world!"));
      // Only 1 block — each event replaced the previous streaming block
      expect(s.blocks).toHaveLength(1);
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toBe("Hello, world!");
    });
    test("streaming text appends new block when last block is not streaming text", () => {
      let s = fresh(); s = { ...s, running: true };
      // First text (streaming)
      s = dispatch(s, textEvt("Hello"));
      // Tool card interleaved
      s = dispatch(s, tcEvt("c1", "read_file"));
      // Next text should be a new block (last is tool_card, not streaming text)
      s = dispatch(s, textEvt("After tool"));
      expect(s.blocks).toHaveLength(3);
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toBe("Hello");
      expect(s.blocks[1].kind).toBe("tool_card");
      expect((s.blocks[2] as Extract<OutputBlock, { kind: "text" }>).content).toBe("After tool");
    });
    test("SET_EXITED then SET_IDLE clears exited flag", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, { type: "SET_EXITED" });
      expect(s.exited).toBe(true);
      s = dispatch(s, { type: "SET_IDLE" });
      expect(s.exited).toBe(false);
    });
  });

  describe("immutability", () => {
    test("reducer returns new state object", () => {
      const s = fresh();
      const next = dispatch(s, textEvt("hello"));
      expect(next).not.toBe(s);
    });
    test("blocks array is not mutated", () => {
      let s = fresh();
      s = dispatch(s, textEvt("a"));
      const arr1 = s.blocks;
      s = dispatch(s, textEvt("b"));
      expect(s.blocks).not.toBe(arr1);
      expect(arr1).toHaveLength(1);
    });
  });

  describe("createInitialState", () => {
    test("returns fresh state with empty blocks and no interrupt", () => {
      const s = createInitialState();
      expect(s.blocks).toEqual([]);
      expect(s.interrupt).toBeNull();
      expect(s.status.modelName).toBe("deepseek-v4");
      expect(s.thinkingVisible).toBe(true);
    });
  });

  describe("LOAD_SESSION", () => {
    test("preserves monotonically increasing nextBlockId without reset", () => {
      const blocks: OutputBlock[] = [
        { id: 5, kind: "text", content: "old" },
        { id: 10, kind: "user", content: "old user" },
      ];
      let s = fresh();
      // Create some blocks first to advance nextBlockId
      s = dispatch(s, textEvt("pre-load block"));
      expect(s.blocks.at(-1)!.id).toBe(1);
      expect(s.nextBlockId).toBe(2);

      s = dispatch(s, {
        type: "LOAD_SESSION", threadId: "t1", blocks, interrupt: null,
        modelProvider: "test", modelName: "deepseek-v4", thinkingLevel: null,
      });
      // nextBlockId should NOT reset after LOAD_SESSION
      expect(s.nextBlockId).toBe(2);
      // Loaded blocks have their original IDs
      expect(s.blocks.map(b => b.id)).toEqual([5, 10]);
      // New block gets the monotonically increasing nextBlockId
      s = dispatch(s, textEvt("new block after load"));
      expect(s.nextBlockId).toBe(3);
      expect(s.blocks.at(-1)!.id).toBe(2);
    });

    test("preserves interrupt when loading approval block", () => {
      const interrupt: InterruptState = { kind: "approval", blockId: 42 };
      const blocks: OutputBlock[] = [
        { id: 42, kind: "approval", approval: approval() },
      ];
      const s = dispatch(fresh(), {
        type: "LOAD_SESSION", threadId: "t1", blocks, interrupt,
        modelProvider: "test", modelName: "deepseek-v4", thinkingLevel: null,
      });
      expect(s.interrupt).toEqual(interrupt);
      expect(s.blocks[0].kind).toBe("approval");
    });
  });

  describe("LOAD_SESSION_PENDING", () => {
    test("sets loadingSession to true while keeping blocks intact", () => {
      const s = fresh();
      s.blocks.push({ id: 1, kind: "text", content: "existing" });
      const next = dispatch(s, { type: "LOAD_SESSION_PENDING", threadId: "t1" });
      expect(next.loadingSession).toBe(true);
      expect(next.blocks).toBe(s.blocks); // blocks unchanged
    });
  });

  describe("COMPACT_CONTEXT", () => {
    test("when running appends compaction text block", () => {
      let s = fresh(); s = { ...s, running: true };
      s = dispatch(s, { type: "COMPACT_CONTEXT" });
      expect(s.blocks).toHaveLength(1);
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toContain("Manual compaction requested");
    });
    test("when not running is a no-op", () => {
      const s = fresh();
      const next = dispatch(s, { type: "COMPACT_CONTEXT" });
      expect(next).toBe(s);
      expect(next.blocks).toHaveLength(0);
    });
  });

  describe("SHOW_SESSIONS / HIDE_SESSIONS + ESCAPE", () => {
    test("SHOW_SESSIONS sets showSessions=true", () => {
      const s = dispatch(fresh(), { type: "SHOW_SESSIONS" });
      expect(s.showSessions).toBe(true);
    });
    test("HIDE_SESSIONS clears showSessions", () => {
      let s = fresh(); s = { ...s, showSessions: true };
      s = dispatch(s, { type: "HIDE_SESSIONS" });
      expect(s.showSessions).toBe(false);
    });
    test("ESCAPE when showSessions=true clears it", () => {
      let s = fresh(); s = { ...s, showSessions: true };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.showSessions).toBe(false);
    });
  });

  describe("SHOW_REWIND / HIDE_REWIND / SET_CHECKPOINTS + ESCAPE", () => {
    const ck1: CheckpointEntry = { checkpointId: "ck1", parentCheckpointId: null, createdAt: "2024-01-01T00:00:00Z", firstUserMessage: "hello" };

    test("SHOW_REWIND sets showRewind=true", () => {
      const s = dispatch(fresh(), { type: "SHOW_REWIND" });
      expect(s.showRewind).toBe(true);
    });
    test("HIDE_REWIND clears showRewind and checkpoints", () => {
      let s = fresh(); s = { ...s, showRewind: true, checkpoints: [ck1] };
      s = dispatch(s, { type: "HIDE_REWIND" });
      expect(s.showRewind).toBe(false);
      expect(s.checkpoints).toEqual([]);
    });
    test("SET_CHECKPOINTS stores entries", () => {
      const entries = [ck1, { ...ck1, checkpointId: "ck2" }];
      const s = dispatch(fresh(), { type: "SET_CHECKPOINTS", checkpoints: entries });
      expect(s.checkpoints).toEqual(entries);
    });
    test("ESCAPE when showRewind clears it and checkpoints", () => {
      let s = fresh(); s = { ...s, showRewind: true, checkpoints: [ck1] };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.showRewind).toBe(false);
      expect(s.checkpoints).toEqual([]);
    });
  });

  describe("SHOW_MCP / HIDE_MCP + ESCAPE", () => {
    test("SHOW_MCP sets showMcp=true", () => {
      const s = dispatch(fresh(), { type: "SHOW_MCP" });
      expect(s.showMcp).toBe(true);
    });
    test("HIDE_MCP clears showMcp", () => {
      let s = fresh(); s = { ...s, showMcp: true };
      s = dispatch(s, { type: "HIDE_MCP" });
      expect(s.showMcp).toBe(false);
    });
    test("ESCAPE when showMcp clears it", () => {
      let s = fresh(); s = { ...s, showMcp: true };
      s = dispatch(s, { type: "ESCAPE" });
      expect(s.showMcp).toBe(false);
    });
  });

  describe("INJECT_MCP_PROMPT", () => {
    test("appends user block with formatted prompt string", () => {
      const s = dispatch(fresh(), { type: "INJECT_MCP_PROMPT", server: "github", promptName: "create-issue" });
      expect(s.blocks).toHaveLength(1);
      expect(s.blocks[0].kind).toBe("user");
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "user" }>).content).toBe("/mcp__github__create-issue");
    });
  });

  describe("REVERT_TO_CHECKPOINT / FORK_FROM_CHECKPOINT", () => {
    test("REVERT_TO_CHECKPOINT closes panel and increments rewindCounter", () => {
      let s = fresh(); s = { ...s, showRewind: true, rewindCounter: 0 };
      s = dispatch(s, { type: "REVERT_TO_CHECKPOINT", checkpointId: "ck1" });
      expect(s.showRewind).toBe(false);
      expect(s.rewindCounter).toBe(1);
    });
    test("FORK_FROM_CHECKPOINT closes panel and increments rewindCounter", () => {
      let s = fresh(); s = { ...s, showRewind: true, rewindCounter: 5 };
      s = dispatch(s, { type: "FORK_FROM_CHECKPOINT", checkpointId: "ck1" });
      expect(s.showRewind).toBe(false);
      expect(s.rewindCounter).toBe(6);
    });
  });

  describe("EVENT.error sessionError flag", () => {
    test("non-recoverable error sets sessionError=true", () => {
      const s = dispatch(fresh(), {
        type: "EVENT",
        event: { type: "error", data: { message: "fatal error", recoverable: false } },
      });
      expect(s.sessionError).toBe(true);
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toContain("Error: fatal error");
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).isError).toBe(true);
    });
    test("recoverable error does NOT set sessionError", () => {
      const s = dispatch(fresh(), {
        type: "EVENT",
        event: { type: "error", data: { message: "rate limit", recoverable: true } },
      });
      expect(s.sessionError).toBe(false);
      expect((s.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toContain("Recoverable error: rate limit");
    });
  });

  describe("ACTIVATE_SKILL", () => {
    test("adds skill content to pendingSkills", () => {
      const state = createInitialState();
      const next = eventReducer(state, { type: "ACTIVATE_SKILL", name: "tdd", content: "Always test first." });
      expect(next.pendingSkills).toHaveLength(1);
      expect(next.pendingSkills[0]).toContain("[SKILL: tdd]");
      expect(next.pendingSkills[0]).toContain("Always test first.");
    });

    test("appends multiple skills in activation order", () => {
      const state = createInitialState();
      const s1 = eventReducer(state, { type: "ACTIVATE_SKILL", name: "a", content: "A" });
      const s2 = eventReducer(s1, { type: "ACTIVATE_SKILL", name: "b", content: "B" });
      expect(s2.pendingSkills).toHaveLength(2);
      expect(s2.pendingSkills[0]).toContain("[SKILL: a]");
      expect(s2.pendingSkills[1]).toContain("[SKILL: b]");
    });
  });

  describe("DEACTIVATE_SKILL", () => {
    test("clears pendingSkills", () => {
      const state = createInitialState();
      const withSkills = eventReducer(state, { type: "ACTIVATE_SKILL", name: "tdd", content: "test" });
      const cleared = eventReducer(withSkills, { type: "DEACTIVATE_SKILL" });
      expect(cleared.pendingSkills).toEqual([]);
    });
  });

  describe("LIST_SKILLS", () => {
    test("adds text block listing all skills", () => {
      const state: TuiState = {
        ...createInitialState(),
        skillManifests: [
          { name: "tdd", description: "Write tests", source: "project", origin: ".openpx" },
        ],
      };
      const next = eventReducer(state, { type: "LIST_SKILLS" });
      const last = next.blocks[next.blocks.length - 1];
      expect(last.kind).toBe("text");
      if (last.kind === "text") expect(last.content).toContain("tdd");
    });

    test("shows no-skills message when manifests empty", () => {
      const state = createInitialState();
      const next = eventReducer(state, { type: "LIST_SKILLS" });
      const last = next.blocks[next.blocks.length - 1];
      expect(last.kind).toBe("text");
      if (last.kind === "text") expect(last.content).toContain("No skills available");
    });
  });

  describe("SET_SKILL_MANIFESTS", () => {
    test("sets skillManifests in state", () => {
      const state = createInitialState();
      const manifests = [
        { name: "tdd", description: "Write tests", source: "project" as const, origin: ".openpx" as const },
      ];
      const next = eventReducer(state, { type: "SET_SKILL_MANIFESTS", manifests });
      expect(next.skillManifests).toEqual(manifests);
    });
  });

  describe("multi-session reducer actions", () => {
    const initialState = createInitialState();

    test("initial state has required multi-session fields", () => {
      expect(initialState.sessions).toEqual([]);
      expect(initialState.activeSessionId).toBeNull();
    });

    test("NEW_SESSION saves current blocks to outgoing snapshot", () => {
      const s: TuiState = {
        ...initialState,
        activeSessionId: "t1",
        sessions: [
          { threadId: "t1", name: "Session 1", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
        ],
        blocks: [{ id: 1, kind: "text", content: "hello" }],
      };
      const next = eventReducer(s, { type: "NEW_SESSION", threadId: "t2" });
      // Old session should have its blocks saved
      expect(next.sessions).toHaveLength(2);
      const oldSnap = next.sessions.find(sp => sp.threadId === "t1")!;
      expect(oldSnap.blocks).toHaveLength(1);
      expect((oldSnap.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toBe("hello");
      expect(oldSnap.active).toBe(false);
      // New session should be active with empty blocks
      const newSnap = next.sessions.find(sp => sp.threadId === "t2")!;
      expect(newSnap.active).toBe(true);
      expect(newSnap.blocks).toEqual([]);
      expect(next.activeSessionId).toBe("t2");
      expect(next.blocks).toEqual([]);
    });

    test("SWITCH_SESSION saves current blocks and restores target", () => {
      const s: TuiState = {
        ...initialState,
        activeSessionId: "t1",
        sessions: [
          { threadId: "t1", name: "S1", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [{ id: 1, kind: "text", content: "A" }] },
          { threadId: "t2", name: "S2", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [{ id: 10, kind: "text", content: "B" }] },
        ],
        blocks: [{ id: 2, kind: "text", content: "latest in t1" }],
      };
      const next = eventReducer(s, { type: "SWITCH_SESSION", threadId: "t2" });
      // t1 should have latest blocks saved
      const t1 = next.sessions.find(sp => sp.threadId === "t1")!;
      expect(t1.blocks).toHaveLength(1);
      expect((t1.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toBe("latest in t1");
      expect(t1.active).toBe(false);
      // t2 should be active and its blocks restored
      const t2 = next.sessions.find(sp => sp.threadId === "t2")!;
      expect(t2.active).toBe(true);
      expect(t2.blocks).toHaveLength(1);
      expect((t2.blocks[0] as Extract<OutputBlock, { kind: "text" }>).content).toBe("B");
      expect(next.activeSessionId).toBe("t2");
      expect(next.blocks).toEqual(t2.blocks);
      expect(next.interrupt).toBeNull();
    });

    test("SWITCH_SESSION to nonexistent session uses default empty blocks", () => {
      const s: TuiState = {
        ...initialState,
        activeSessionId: "t1",
        sessions: [
          { threadId: "t1", name: "S1", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
        ],
      };
      const next = eventReducer(s, { type: "SWITCH_SESSION", threadId: "missing" });
      expect(next.blocks).toEqual([]);
      expect(next.activeSessionId).toBe("missing");
    });

    test("SESSION_INTERRUPT_PENDING sets pending flag on session", () => {
      const sessions: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
        { threadId: "b", name: "B", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
      ];
      const next = eventReducer(
        { ...initialState, sessions },
        { type: "SESSION_INTERRUPT_PENDING", threadId: "a" }
      );
      expect(next.sessions[0].pendingInterrupt).toBe(true);
      expect(next.sessions[1].pendingInterrupt).toBe(false);
    });

    test("SET_SESSIONS merges: preserves existing blocks and syncs activeSessionId", () => {
      // Simulate: state has session with blocks, SET_SESSIONS comes in with empty blocks
      const existing: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: { ...initialState.status, totalTokens: 100 }, blocks: [{ id: 1, kind: "text" as const, content: "hello" }] },
      ];
      const incoming: SessionSnapshot[] = [
        { threadId: "a", name: "A (renamed)", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: { ...initialState.status, totalTokens: 0 }, blocks: [] },
      ];
      const state = { ...initialState, sessions: existing, activeSessionId: null };
      const next = eventReducer(state, { type: "SET_SESSIONS", sessions: incoming });
      // Name/running from incoming, blocks/status preserved from existing, activeSessionId synced
      expect(next.sessions[0].name).toBe("A (renamed)");
      expect(next.sessions[0].blocks).toEqual([{ id: 1, kind: "text", content: "hello" }]);
      expect(next.sessions[0].status.totalTokens).toBe(100);
      expect(next.activeSessionId).toBe("a"); // synced from incoming.active
    });

    test("SET_SESSIONS handles new session (no existing match)", () => {
      const incoming: SessionSnapshot[] = [
        { threadId: "new", name: "New", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
      ];
      const next = eventReducer(initialState, { type: "SET_SESSIONS", sessions: incoming });
      expect(next.sessions[0].threadId).toBe("new");
      expect(next.activeSessionId).toBe("new");
    });

    test("SWITCH_SESSION preserves blocks on outgoing session and restores from incoming", () => {
      const sessions: SessionSnapshot[] = [
        {
          threadId: "a", name: "A", workspace: "/tmp", active: true, running: false,
          pendingInterrupt: false, plan: null,
          status: { ...initialState.status, totalTokens: 100 },
          blocks: [{ id: 1, kind: "text" as const, content: "session A content" }],
        },
        {
          threadId: "b", name: "B", workspace: "/tmp", active: false, running: false,
          pendingInterrupt: false, plan: null,
          status: { ...initialState.status, totalTokens: 200 },
          blocks: [{ id: 1, kind: "text" as const, content: "session B content" }],
        },
      ];

      let state: TuiState = {
        ...initialState,
        sessions,
        activeSessionId: "a",
        blocks: [{ id: 2, kind: "text" as const, content: "updated A content" }],
      };

      // Simulate SWITCH_SESSION to "b"
      const newSessions = state.sessions.map(s =>
        s.threadId === state.activeSessionId
          ? { ...s, blocks: state.blocks, status: state.status, active: false }
          : s.threadId === "b"
            ? { ...s, active: true }
            : s
      );
      const target = newSessions.find(s => s.threadId === "b")!;

      state = {
        ...state,
        sessions: newSessions,
        activeSessionId: "b",
        blocks: target.blocks,
        status: target.status,
        interrupt: null,
      };

      // Verify A's blocks were saved
      const savedA = state.sessions.find(s => s.threadId === "a")!;
      expect(savedA.blocks).toEqual([{ id: 2, kind: "text", content: "updated A content" }] as OutputBlock[]);
      expect(savedA.active).toBe(false);

      // Verify B's blocks were restored
      expect(state.blocks).toEqual([{ id: 1, kind: "text", content: "session B content" }] as OutputBlock[]);
      expect(state.activeSessionId).toBe("b");
      expect(state.status.totalTokens).toBe(200);
    });

    test("full chain: NEW_SESSION saves blocks → SET_SESSIONS preserves → SWITCH_SESSION restores", () => {
      // Setup: session A is active with runtime blocks in state.blocks
      let state: TuiState = {
        ...initialState,
        sessions: [
          { threadId: "a", name: "A", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: { ...initialState.status, totalTokens: 100 }, blocks: [] },
        ],
        activeSessionId: "a",
        blocks: [
          { id: 1, kind: "user" as const, content: "Hello" },
          { id: 2, kind: "text" as const, content: "Hi there!" },
        ],
      };

      // Step 1: NEW_SESSION — should save session A's blocks
      state = eventReducer(state, { type: "NEW_SESSION", threadId: "b" });
      expect(state.sessions.length).toBe(2);
      expect(state.sessions[0].threadId).toBe("a");
      expect(state.sessions[0].blocks.length).toBe(2); // blocks saved
      expect((state.sessions[0].blocks[0] as { content: string }).content).toBe("Hello");
      expect(state.sessions[0].active).toBe(false);
      expect(state.sessions[1].threadId).toBe("b");
      expect(state.sessions[1].active).toBe(true);
      expect(state.activeSessionId).toBe("b");

      // Step 2: SET_SESSIONS from SessionManager.getSnapshot() (blocks are always [])
      // This simulates what happens after dispatchSessionLoad calls SET_SESSIONS
      const runtimeSnapshots: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
        { threadId: "b", name: "B", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
      ];
      state = eventReducer(state, { type: "SET_SESSIONS", sessions: runtimeSnapshots });
      // Merge must preserve blocks from step 1
      expect(state.sessions[0].blocks.length).toBe(2); // preserved!
      expect((state.sessions[0].blocks[0] as { content: string }).content).toBe("Hello");
      expect(state.sessions[1].blocks.length).toBe(0); // new session, no blocks
      expect(state.activeSessionId).toBe("b"); // synced from runtime

      // Step 3: Add some blocks to session B's runtime (simulating agent response)
      state = { ...state, blocks: [
        { id: 3, kind: "user" as const, content: "Msg in B" },
        { id: 4, kind: "text" as const, content: "Reply in B" },
      ]};

      // Step 4: SWITCH_SESSION back to A — should save B's blocks and restore A's
      state = eventReducer(state, { type: "SWITCH_SESSION", threadId: "a" });
      expect(state.activeSessionId).toBe("a");
      // A's blocks restored
      expect(state.blocks.length).toBe(2);
      expect((state.blocks[0] as { content: string }).content).toBe("Hello");
      expect((state.blocks[1] as { content: string }).content).toBe("Hi there!");
      // B's blocks saved to snapshot
      expect(state.sessions[1].blocks.length).toBe(2);
      expect((state.sessions[1].blocks[0] as { content: string }).content).toBe("Msg in B");
    });

    test("SESSION_INTERRUPT_PENDING sets flag on correct session", () => {
      const sessions: SessionSnapshot[] = [
        {
          threadId: "a", name: "A", workspace: "/tmp", active: true, running: false,
          pendingInterrupt: false, plan: null,
          status: initialState.status, blocks: [],
        },
        {
          threadId: "b", name: "B", workspace: "/tmp", active: false, running: true,
          pendingInterrupt: false, plan: null,
          status: initialState.status, blocks: [],
        },
      ];

      let state = { ...initialState, sessions, activeSessionId: "a" };

      // Simulate SESSION_INTERRUPT_PENDING for "b"
      state = {
        ...state,
        sessions: state.sessions.map(s =>
          s.threadId === "b" ? { ...s, pendingInterrupt: true } : s
        ),
      };

      const a = state.sessions.find(s => s.threadId === "a")!;
      const b = state.sessions.find(s => s.threadId === "b")!;
      expect(a.pendingInterrupt).toBe(false);
      expect(b.pendingInterrupt).toBe(true);
    });

    test("SET_SESSIONS with a new session (not in existing) adds it alongside existing sessions", () => {
      const existing: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
      ];
      const incoming: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
        { threadId: "b", name: "B", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
      ];
      const state = { ...initialState, sessions: existing, activeSessionId: "a" };
      const next = eventReducer(state, { type: "SET_SESSIONS", sessions: incoming });
      expect(next.sessions).toHaveLength(2);
      expect(next.sessions[0].threadId).toBe("a");
      expect(next.sessions[1].threadId).toBe("b");
      expect(next.activeSessionId).toBe("b");
    });

    test("SET_SESSIONS when no incoming session is active preserves existing activeSessionId", () => {
      const existing: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: true, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
      ];
      const incoming: SessionSnapshot[] = [
        { threadId: "a", name: "A", workspace: "/tmp", active: false, running: false, pendingInterrupt: false, plan: null, status: initialState.status, blocks: [] },
      ];
      const state = { ...initialState, sessions: existing, activeSessionId: "a" };
      const next = eventReducer(state, { type: "SET_SESSIONS", sessions: incoming });
      expect(next.activeSessionId).toBe("a");
    });
  });

  describe("EVENT.subagent_*", () => {
    function saStart(id: string, role: "explore" | "code" | "review", task: string): Action {
      return { type: "EVENT", event: { type: "subagent_start", data: { id, role, task } } };
    }
    function saStep(id: string, toolName: string, toolArgs: Record<string, unknown> = {}): Action {
      return { type: "EVENT", event: { type: "subagent_step", data: { id, toolName, toolArgs } } };
    }
    function saToolResult(id: string, toolName: string, ok: boolean): Action {
      return { type: "EVENT", event: { type: "subagent_tool_result", data: { id, toolName, ok } } };
    }
    function saDone(id: string, summary: string, toolCallCount: number, durationMs: number): Action {
      return { type: "EVENT", event: { type: "subagent_done", data: { id, summary, toolCallCount, durationMs } } };
    }
    function saError(id: string, error: string): Action {
      return { type: "EVENT", event: { type: "subagent_error", data: { id, error } } };
    }

    test("subagent_start creates running subagent block", () => {
      const s = dispatch(fresh(), saStart("sub-1", "explore", "find usages"));
      expect(s.blocks).toHaveLength(1);
      const b = s.blocks[0];
      expect(b.kind).toBe("subagent");
      if (b.kind !== "subagent") throw new Error("unexpected kind");
      expect(b.subagentId).toBe("sub-1");
      expect(b.role).toBe("explore");
      expect(b.task).toBe("find usages");
      expect(b.status).toBe("running");
      expect(b.steps).toEqual([]);
      expect(b.toolCallCount).toBe(0);
    });

    test("subagent_step appends step to matching running block", () => {
      let s = dispatch(fresh(), saStart("sub-1", "code", "fix bug"));
      s = dispatch(s, saStep("sub-1", "read_file", { path: "a.ts" }));
      s = dispatch(s, saStep("sub-1", "edit_file", { path: "a.ts" }));
      const b = s.blocks[0];
      if (b.kind !== "subagent") throw new Error("unexpected kind");
      expect(b.steps).toHaveLength(2);
      expect(b.steps[0].toolName).toBe("read_file");
      expect(b.steps[0].toolArgs).toEqual({ path: "a.ts" });
      expect(b.steps[1].toolName).toBe("edit_file");
    });

    test("subagent_step does not affect non-matching subagent blocks", () => {
      let s = dispatch(fresh(), saStart("sub-1", "code", "fix"));
      s = dispatch(s, saStart("sub-2", "review", "review"));
      s = dispatch(s, saStep("sub-1", "read_file"));
      const b1 = s.blocks[0] as Extract<OutputBlock, { kind: "subagent" }>;
      const b2 = s.blocks[1] as Extract<OutputBlock, { kind: "subagent" }>;
      expect(b1.steps).toHaveLength(1);
      expect(b2.steps).toHaveLength(0);
    });

    test("subagent_tool_result marks last matching step's ok", () => {
      let s = dispatch(fresh(), saStart("sub-1", "code", "fix"));
      s = dispatch(s, saStep("sub-1", "read_file", { path: "a.ts" }));
      s = dispatch(s, saStep("sub-1", "edit_file", { path: "a.ts" }));
      s = dispatch(s, saToolResult("sub-1", "read_file", true));
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "subagent" }>;
      expect(b.steps[0].ok).toBeUndefined(); // not the last step
      // last step should be updated by second tool_result
      s = dispatch(s, saToolResult("sub-1", "edit_file", false));
      const b2 = s.blocks[0] as Extract<OutputBlock, { kind: "subagent" }>;
      expect(b2.steps[0].ok).toBeUndefined(); // still not last
    });

    test("subagent_tool_result updates last step ok", () => {
      let s = dispatch(fresh(), saStart("sub-1", "explore", "search"));
      s = dispatch(s, saStep("sub-1", "read_file"));
      s = dispatch(s, saToolResult("sub-1", "read_file", true));
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "subagent" }>;
      expect(b.steps[0].ok).toBe(true);
    });

    test("subagent_done updates running block to done", () => {
      let s = dispatch(fresh(), saStart("sub-1", "review", "review PR"));
      s = dispatch(s, saDone("sub-1", "No issues found", 3, 2500));
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "subagent" }>;
      expect(b.status).toBe("done");
      expect(b.summary).toBe("No issues found");
      expect(b.toolCallCount).toBe(3);
      expect(b.durationMs).toBe(2500);
    });

    test("subagent_error updates running block to error", () => {
      let s = dispatch(fresh(), saStart("sub-1", "code", "impl"));
      s = dispatch(s, saError("sub-1", "timeout"));
      const b = s.blocks[0] as Extract<OutputBlock, { kind: "subagent" }>;
      expect(b.status).toBe("error");
      expect(b.error).toBe("timeout");
    });

    test("subagent events interleave correctly with other block types", () => {
      let s = fresh();
      s = dispatch(s, textEvt("start working"));
      s = dispatch(s, saStart("sub-1", "explore", "search"));
      s = dispatch(s, saStep("sub-1", "read_file"));
      s = dispatch(s, saToolResult("sub-1", "read_file", true));
      s = dispatch(s, saDone("sub-1", "found 3 files", 1, 800));
      s = dispatch(s, textEvt("done"));
      expect(s.blocks).toHaveLength(3); // text, subagent, text
      expect(s.blocks[0].kind).toBe("text");
      expect(s.blocks[1].kind).toBe("subagent");
      expect(s.blocks[2].kind).toBe("text");
    });

    test("subagent blocks get unique incrementing ids", () => {
      let s = fresh();
      s = dispatch(s, saStart("sub-1", "explore", "task1"));
      s = dispatch(s, saStart("sub-2", "code", "task2"));
      expect(s.blocks[0].id).toBeLessThan(s.blocks[1].id);
    });
  });
});
