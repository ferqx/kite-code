// ── EVENT action handler — 19 event sub-types ──

import type { AgentEvent, AgentPlanStep, PlanStatus } from "@/protocol/events";
import type { TuiState, OutputBlock, FileChangeRecord } from "../types";
import { appendBlock, updateLastBlock, finalizeLastTurnStreaming, lastTurn } from "./helpers";

function getToolPreview(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_file": return String(args.path ?? "");
    case "write_file":
    case "edit_file": return String(args.path ?? "");
    case "shell_execute": {
      const cmd = String(args.command ?? "");
      return cmd.length > 60 ? cmd.slice(0, 57) + "..." : cmd;
    }
    case "update_plan": return String(args.name ?? "");
    case "ask_user": {
      const q = String(args.question ?? "");
      return q.length > 40 ? q.slice(0, 37) + "..." : q;
    }
    default: return "";
  }
}

function computeToolDetail(name: string, args: Record<string, unknown>): string | undefined {
  switch (name) {
    case "read_file": {
      const path = typeof args.path === "string" ? args.path : "";
      return `Read ${path}`;
    }
    case "write_file": {
      const path = typeof args.path === "string" ? args.path : "";
      const lines = typeof args.content === "string" ? args.content.split("\n").length : undefined;
      return lines != null ? `Wrote ${lines} line(s) to ${path}` : `Wrote ${path}`;
    }
    case "edit_file": {
      const path = typeof args.path === "string" ? args.path : "";
      return `Edited ${path}`;
    }
    case "shell_execute": {
      const cmd = typeof args.command === "string" ? args.command.slice(0, 60) : "";
      return `Ran: ${cmd}`;
    }
    case "update_plan": {
      const name = typeof args.name === "string" ? args.name : "";
      return `Plan: ${name}`;
    }
    case "ask_user": {
      const q = typeof args.question === "string" ? args.question.slice(0, 40) : "";
      return `Asked: ${q}${q.length > 40 ? "..." : ""}`;
    }
    default:
      return undefined;
  }
}

export function handleEventAction(state: TuiState, event: AgentEvent): TuiState {
  // 非 reason 事件清除 currentRunReasonId，让下一个 reason 创建新块。
  // 避免中间隔了工具调用后两个 reason 块被合并。
  // Auto-clear currentRunReasonId on any non-reason event,
  // so the next reason creates a new block instead of appending.
  if (event.type !== "reason" && state.currentRunReasonId !== undefined) {
    state = { ...state, currentRunReasonId: undefined };
  }

  switch (event.type) {
    case "text": {
      const last = lastTurn(state);
      const lastBlock = last?.blocks.at(-1);
      // Stream-append: update the last block if it's a streaming text block
      if (state.running && lastBlock?.kind === "text") {
        return updateLastBlock(state, { ...lastBlock, content: event.data.text });
      }
      // Dedup: check the most recent text block in the last turn
      if (lastBlock?.kind === "text" && lastBlock.content === event.data.text) return state;
      if (last) {
        for (let i = last.blocks.length - 1; i >= 0; i--) {
          const blk = last.blocks[i];
          if (blk.kind === "text") {
            if (blk.content === event.data.text) return state;
            break;
          }
        }
      }
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: event.data.text, streaming: state.running };
      return appendBlock(state, block);
    }
    case "reason": {
      if (state.currentRunReasonId != null) {
        const last = lastTurn(state);
        const lastBlock = last?.blocks.at(-1);
        if (lastBlock?.kind === "reason" && lastBlock.id === state.currentRunReasonId) {
          const next: OutputBlock = {
            ...lastBlock,
            content: lastBlock.content + "\n\n" + event.data.text,
          };
          return updateLastBlock(state, next);
        }
      }
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "reason", content: event.data.text, folded: true };
      return { ...appendBlock(state, block), currentRunReasonId: id };
    }
    case "tool_call": {
      // task tool has its own subagent block — skip the redundant tool_card
      if (event.data.name === "task") return state;
      // update_plan renders as a plan_card block, not a tool_card
      if (event.data.name === "update_plan") {
        const args = event.data.args;
        const steps: AgentPlanStep[] = Array.isArray(args.steps)
          ? (args.steps as AgentPlanStep[])
          : [];
        const id = state.nextBlockId;
        const block: OutputBlock = {
          id, kind: "plan_card",
          name: String(args.name ?? ""),
          description: String(args.description ?? ""),
          planStatus: (args.status as PlanStatus) ?? "pending",
          steps, folded: false, callId: event.data.call_id,
        };
        return appendBlock(state, block);
      }
      const preview = getToolPreview(event.data.name, event.data.args);
      const id = state.nextBlockId;
      const block: OutputBlock = {
        id, kind: "tool_card",
        callId: event.data.call_id, name: event.data.name, args: event.data.args,
        status: "running", summary: "", preview,
      };
      const times = new Map(state.toolStartTimes);
      times.set(event.data.call_id, Date.now());
      return { ...appendBlock(state, block), toolStartTimes: times };
    }
    case "tool_done": {
      if (event.data.name === "task") return state;
      if (event.data.name === "update_plan") return state;
      const startedAt = state.toolStartTimes?.get(event.data.call_id);
      const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
      const nextTimes = new Map(state.toolStartTimes);
      nextTimes.delete(event.data.call_id);
      // Find matching tool_card across all turns
      let matched: (OutputBlock & { kind: "tool_card" }) | undefined;
      for (const turn of state.turns) {
        for (const b of turn.blocks) {
          if (b.kind === "tool_card" && b.callId === event.data.call_id) {
            matched = b; break;
          }
        }
        if (matched) break;
      }
      if (!matched) return { ...state, toolStartTimes: nextTimes };
      const next: OutputBlock = {
        ...matched,
        status: event.data.ok ? "done" as const : "error" as const,
        summary: event.data.summary,
        elapsedMs,
        detail: computeToolDetail(matched.name, matched.args),
        expanded: !event.data.ok,
      };
      // Inline replace: same pattern as replaceBlockById but return just turns
      const turns = state.turns.map(turn => {
        const idx = turn.blocks.findIndex(b => b.id === matched!.id);
        if (idx === -1) return turn;
        const blocks = turn.blocks.slice();
        blocks[idx] = next;
        return { blocks };
      });
      return { ...state, turns, toolStartTimes: nextTimes };
    }
    case "state_change": {
      const d = event.data;
      const next = { ...state.status };
      if (d.phase) next.phase = d.phase;
      if (d.plan !== undefined) next.plan = d.plan;
      if (d.authorization) next.authorization = d.authorization.mode;
      if (d.workspaceAccess) next.workspaceAccess = d.workspaceAccess;
      if (d.modelProvider) next.modelProvider = d.modelProvider;
      if (d.modelName) next.modelName = d.modelName;
      let nextState = state;
      if (d.plan) {
        // Find the latest plan_card
        for (let ti = state.turns.length - 1; ti >= 0; ti--) {
          const turn = state.turns[ti];
          for (let bi = turn.blocks.length - 1; bi >= 0; bi--) {
            const b = turn.blocks[bi];
            if (b.kind === "plan_card") {
              const blocks = turn.blocks.slice();
              blocks[bi] = { ...b, planStatus: d.plan.status, steps: d.plan.steps };
              const turns = state.turns.slice();
              turns[ti] = { blocks };
              nextState = { ...nextState, turns };
              // break label simulation
              ti = -1; break;
            }
          }
        }
      }
      return { ...nextState, status: next };
    }
    case "model_retry": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `⟳ Model retry #${event.data.attempt} (${event.data.delayMs}ms): ${event.data.error}` };
      return appendBlock(state, block);
    }
    case "step_begin": {
      return { ...state, status: { ...state.status, currentNode: event.data.node } };
    }
    case "step_end": {
      return { ...state, status: { ...state.status, currentNode: null } };
    }
    case "cache_metrics": {
      const d = event.data;
      return {
        ...state,
        status: {
          ...state.status,
          cacheHitRate: d.hitRate ?? 0,
          totalTokens: state.status.totalTokens + d.inputTokens + (d.outputTokens ?? 0),
        },
      };
    }
    case "final": {
      if (event.data.length === 0) return state;
      const last = lastTurn(state);
      const lastBlock = last?.blocks.at(-1);
      if (lastBlock?.kind === "text" && lastBlock.content === event.data) return state;
      if (last) {
        for (let i = last.blocks.length - 1; i >= 0; i--) {
          const blk = last.blocks[i];
          if (blk.kind === "text") {
            if (blk.content === event.data) return state;
            break;
          }
        }
      }
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: event.data };
      return appendBlock(state, block);
    }
    case "need_approval": {
      const finalized = finalizeLastTurnStreaming(state);
      const block: OutputBlock = { id: finalized.nextBlockId, kind: "approval", approval: event.data };
      return { ...appendBlock(finalized, block), interrupt: { kind: "approval", blockId: block.id } };
    }
    case "need_input": {
      const finalized = finalizeLastTurnStreaming(state);
      const block: OutputBlock = { id: finalized.nextBlockId, kind: "question", question: event.data };
      return { ...appendBlock(finalized, block), interrupt: { kind: "input", blockId: block.id } };
    }
    case "error": {
      const prefix = event.data.recoverable ? "⟳ Recoverable error" : "Error";
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `${prefix}: ${event.data.message}`, isError: !event.data.recoverable };
      return { ...appendBlock(state, block), sessionError: !event.data.recoverable };
    }
    case "file_change": {
      const change: FileChangeRecord = {
        path: event.data.path,
        kind: event.data.kind,
        linesAdded: event.data.linesAdded,
        linesRemoved: event.data.linesRemoved,
        preview: event.data.preview,
      };
      const last = lastTurn(state);
      const lastBlock = last?.blocks.at(-1);
      if (lastBlock?.kind === "file_change") {
        return updateLastBlock(state, { ...lastBlock, changes: [...lastBlock.changes, change] });
      }
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "file_change", changes: [change] };
      return appendBlock(state, block);
    }
    case "compact_begin": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `⟳ Compacting context: ${event.data.reason}` };
      return { ...appendBlock(state, block), compacting: true };
    }
    case "compact_end": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `✓ Compaction complete: ${event.data.summary}` };
      return { ...appendBlock(state, block), compacting: false };
    }
    case "subagent_start": {
      // Dedup: if a subagent block with this ID already exists, skip.
      for (const turn of state.turns) {
        if (turn.blocks.some(b => b.kind === "subagent" && b.subagentId === event.data.id)) return state;
      }
      const id = state.nextBlockId;
      const block: OutputBlock = {
        id, kind: "subagent",
        subagentId: event.data.id,
        role: event.data.role,
        task: event.data.task,
        status: "running", summary: "",
        toolCallCount: 0, durationMs: 0, steps: [],
      };
      return appendBlock(state, block);
    }
    case "subagent_step": {
      // Find subagent block across all turns
      let matched: (OutputBlock & { kind: "subagent" }) | undefined;
      for (const turn of state.turns) {
        for (const b of turn.blocks) {
          if (b.kind === "subagent" && b.subagentId === event.data.id) { matched = b; break; }
        }
        if (matched) break;
      }
      if (!matched) return state;
      const next: OutputBlock = { ...matched, steps: [...matched.steps, { toolName: event.data.toolName, toolArgs: event.data.toolArgs }] };
      const turns = state.turns.map(t => {
        const idx = t.blocks.findIndex(b => b.id === matched!.id);
        if (idx === -1) return t;
        const blocks = t.blocks.slice();
        blocks[idx] = next;
        return { blocks };
      });
      return { ...state, turns };
    }
    case "subagent_tool_result": {
      let matched: (OutputBlock & { kind: "subagent" }) | undefined;
      for (const turn of state.turns) {
        for (const b of turn.blocks) {
          if (b.kind === "subagent" && b.subagentId === event.data.id) { matched = b; break; }
        }
        if (matched) break;
      }
      if (!matched) return state;
      const steps = matched.steps.map((s, i) =>
        i === matched!.steps.length - 1 && s.toolName === event.data.toolName
          ? { ...s, ok: event.data.ok }
          : s
      );
      if (steps.every((s, i) => s === matched!.steps[i])) return state;
      const next: OutputBlock = { ...matched, steps };
      const turns = state.turns.map(t => {
        const idx = t.blocks.findIndex(b => b.id === matched!.id);
        if (idx === -1) return t;
        const blocks = t.blocks.slice();
        blocks[idx] = next;
        return { blocks };
      });
      return { ...state, turns };
    }
    case "subagent_done": {
      let matched: (OutputBlock & { kind: "subagent" }) | undefined;
      for (const turn of state.turns) {
        for (const b of turn.blocks) {
          if (b.kind === "subagent" && b.subagentId === event.data.id) { matched = b; break; }
        }
        if (matched) break;
      }
      if (!matched) return state;
      const next: OutputBlock = {
        ...matched,
        status: "done" as const,
        summary: event.data.summary,
        toolCallCount: event.data.toolCallCount,
        durationMs: event.data.durationMs,
        expanded: false,
      };
      const turns = state.turns.map(t => {
        const idx = t.blocks.findIndex(b => b.id === matched!.id);
        if (idx === -1) return t;
        const blocks = t.blocks.slice();
        blocks[idx] = next;
        return { blocks };
      });
      return { ...state, turns };
    }
    case "subagent_error": {
      let matched: (OutputBlock & { kind: "subagent" }) | undefined;
      for (const turn of state.turns) {
        for (const b of turn.blocks) {
          if (b.kind === "subagent" && b.subagentId === event.data.id) { matched = b; break; }
        }
        if (matched) break;
      }
      if (!matched) return state;
      const next: OutputBlock = { ...matched, status: "error" as const, error: event.data.error };
      const turns = state.turns.map(t => {
        const idx = t.blocks.findIndex(b => b.id === matched!.id);
        if (idx === -1) return t;
        const blocks = t.blocks.slice();
        blocks[idx] = next;
        return { blocks };
      });
      return { ...state, turns };
    }
    default:
      return state;
  }
}
