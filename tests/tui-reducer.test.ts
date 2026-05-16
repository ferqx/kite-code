import { describe, expect, test } from "bun:test";
import { eventReducer, createInitialState } from "../src/app/tui/App";
import type { Action } from "../src/app/tui/App";
import type { TuiState, OutputBlock } from "../src/app/tui/types";
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

  describe("EVENT.retry / model_retry", () => {
    test("appends text block for retry", () => {
      const s = dispatch(fresh(), { type: "EVENT", event: { type: "retry", data: { attempt: 3, reason: "timeout" } } });
      expect(s.blocks[0].kind).toBe("text");
      expect((s.blocks[0] as any).content).toContain("Retry #3");
    });
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
      s = dispatch(s, { type: "EVENT", event: { type: "cache_metrics", data: { workspaceAccess: "write" as const, cacheHitTokens: 50, cacheMissTokens: 50, cacheWriteTokens: 0, inputTokens: 100, outputTokens: 30, hitRate: 0.5, standard: {} } } });
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
      s = { ...s, blocks: [{ id: 1, kind: "text", content: "old" }], compacting: true, ctrlCPressed: true, interrupt: { kind: "approval", blockId: 1 }, showHelp: true, showModelSelector: true, leaderPending: true, exitRequested: true };
      s = dispatch(s, { type: "NEW_SESSION" });
      expect(s.blocks).toHaveLength(0);
      expect(s.interrupt).toBeNull();
      expect(s.compacting).toBe(false);
      expect(s.ctrlCPressed).toBe(false);
      expect(s.exitRequested).toBe(false);
      expect(s.showHelp).toBe(false);
      expect(s.showModelSelector).toBe(false);
      expect(s.leaderPending).toBe(false);
      expect(s.sessionKey).toBe(1);
    });
    test("OPEN_EDITOR sets editorRequested", () => {
      let s = fresh();
      s = dispatch(s, { type: "OPEN_EDITOR" });
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
});
