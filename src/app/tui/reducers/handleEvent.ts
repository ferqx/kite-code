// ── EVENT action handler — 19 event sub-types ──

import type { AgentEvent } from "@/protocol/events";
import type { TuiState, OutputBlock, InterruptState, FileChangeRecord } from "../types";

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
  switch (event.type) {
    case "text": {
      const lastBlock = state.blocks.at(-1);
      if (lastBlock?.kind === "text" && lastBlock.streaming) {
        const updated = state.blocks.slice(0, -1);
        updated.push({ ...lastBlock, content: event.data.text });
        return { ...state, blocks: updated };
      }
      // Dedup: if the most recent text block has identical content, skip.
      // Prevents duplication when agent emits same text before and after an
      // interrupt (e.g. ask_user tool_call with preamble text, then same text
      // in follow-up response after user answers).
      // Only checks the single most recent text block — not all blocks — so
      // legitimate repetitions across distant turns are not suppressed.
      for (let i = state.blocks.length - 1; i >= 0; i--) {
        if (state.blocks[i].kind === "text") {
          if (state.blocks[i].content === event.data.text) return state;
          break;
        }
      }
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: event.data.text, streaming: state.running };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "reason": {
      if (state.currentRunReasonId != null) {
        const lastBlock = state.blocks.at(-1);
        if (lastBlock?.kind === "reason" && lastBlock.id === state.currentRunReasonId) {
          const blocks = state.blocks.map((b) =>
            b.id === state.currentRunReasonId && b.kind === "reason"
              ? { ...b, content: b.content + "\n\n" + event.data.text }
              : b
          );
          return { ...state, blocks };
        }
      }
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "reason", content: event.data.text, folded: true };
      return { ...state, blocks: [...state.blocks, block], currentRunReasonId: id, nextBlockId: id + 1 };
    }
    case "tool_call": {
      const preview = getToolPreview(event.data.name, event.data.args);
      const id = state.nextBlockId;
      const block: OutputBlock = {
        id, kind: "tool_card",
        callId: event.data.call_id, name: event.data.name, args: event.data.args,
        status: "running", summary: "", preview,
      };
      const times = new Map(state.toolStartTimes);
      times.set(event.data.call_id, Date.now());
      return { ...state, blocks: [...state.blocks, block], toolStartTimes: times, nextBlockId: id + 1 };
    }
    case "tool_done": {
      const startedAt = state.toolStartTimes?.get(event.data.call_id);
      const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
      const nextTimes = new Map(state.toolStartTimes);
      nextTimes.delete(event.data.call_id);
      const blocks = state.blocks.map((b) => {
        if (b.kind === "tool_card" && b.callId === event.data.call_id) {
          return {
            ...b,
            status: event.data.ok ? "done" as const : "error" as const,
            summary: event.data.summary,
            elapsedMs,
            detail: computeToolDetail(b.name, b.args),
          };
        }
        return b;
      });
      return { ...state, blocks, toolStartTimes: nextTimes };
    }
    case "state_change": {
      const d = event.data;
      const next = { ...state.status };
      if (d.phase) next.phase = d.phase;
      if (d.plan !== undefined) next.plan = d.plan;
      if (d.authorization) next.authorization = d.authorization.mode;
      if (d.workspaceAccess) next.workspaceAccess = d.workspaceAccess;
      return { ...state, status: next };
    }
    case "model_retry": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `⟳ Model retry #${event.data.attempt} (${event.data.delayMs}ms): ${event.data.error}` };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
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
      // Dedup: check last block first (fast path), then the most recent
      // text block in case an interrupt block sits between them.
      const lastBlock = state.blocks.at(-1);
      if (lastBlock?.kind === "text" && lastBlock.content === event.data) return state;
      for (let i = state.blocks.length - 1; i >= 0; i--) {
        if (state.blocks[i].kind === "text") {
          if (state.blocks[i].content === event.data) return state;
          break;
        }
      }
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: event.data };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "need_approval": {
      // Finalize streaming text blocks so they move to <Static> immediately.
      // This prevents visual duplication when blocks later transition from
      // the dynamic tree to the terminal scrollback.
      const finalized = state.blocks.map((b) =>
        b.kind === "text" && b.streaming ? { ...b, streaming: false as any } : b
      );
      const blockId = state.nextBlockId;
      const block: OutputBlock = { id: blockId, kind: "approval", approval: event.data };
      const interrupt: InterruptState = { kind: "approval", blockId };
      return { ...state, blocks: [...finalized, block], interrupt, nextBlockId: blockId + 1 };
    }
    case "need_input": {
      // Finalize streaming text blocks so they move to <Static> immediately.
      // This prevents visual duplication when blocks later transition from
      // the dynamic tree to the terminal scrollback.
      const finalized = state.blocks.map((b) =>
        b.kind === "text" && b.streaming ? { ...b, streaming: false as any } : b
      );
      const blockId = state.nextBlockId;
      const block: OutputBlock = { id: blockId, kind: "question", question: event.data };
      const interrupt: InterruptState = { kind: "input", blockId };
      return { ...state, blocks: [...finalized, block], interrupt, nextBlockId: blockId + 1 };
    }
    case "error": {
      const recoverable = event.data.recoverable;
      const prefix = recoverable ? "⟳ Recoverable error" : "Error";
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `${prefix}: ${event.data.message}`, isError: !recoverable };
      return { ...state, blocks: [...state.blocks, block], sessionError: !recoverable, nextBlockId: id + 1 };
    }
    case "file_change": {
      const change: FileChangeRecord = {
        path: event.data.path,
        kind: event.data.kind,
        linesAdded: event.data.linesAdded,
        linesRemoved: event.data.linesRemoved,
        preview: event.data.preview,
      };
      const lastBlock = state.blocks.at(-1);
      if (lastBlock?.kind === "file_change") {
        const updated = state.blocks.slice(0, -1);
        updated.push({ ...lastBlock, changes: [...lastBlock.changes, change] });
        return { ...state, blocks: updated };
      }
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "file_change", changes: [change] };
      return { ...state, blocks: [...state.blocks, block], nextBlockId: id + 1 };
    }
    case "compact_begin": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `⟳ Compacting context: ${event.data.reason}` };
      return { ...state, blocks: [...state.blocks, block], compacting: true, nextBlockId: id + 1 };
    }
    case "compact_end": {
      const id = state.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `✓ Compaction complete: ${event.data.summary}` };
      return { ...state, blocks: [...state.blocks, block], compacting: false, nextBlockId: id + 1 };
    }
    default:
      return state;
  }
}
