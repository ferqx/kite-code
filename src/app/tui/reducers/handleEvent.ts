// ── EVENT action handler — 19 event sub-types ──

import type { AgentEvent, AgentPlanStep, PlanStatus } from "@/protocol/events";
import type { TuiState, OutputBlock, FileChangeRecord } from "../types";
import { appendBlock, updateLastBlock, finalizeLastTurnStreaming, lastTurn, findBlockById, replaceBlockById } from "./helpers";
import { formatReadFileRange } from "../components/render-utils";

/** 格式化 token 数量（1k+ 用 k 缩写）/ Format token count (abbreviate with k for 1k+) */
function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Shared helper: O(1) blockIndex lookup with O(n) full-scan fallback for session-load edge cases.
 *  Eliminates the duplicate pattern that was repeated 5 times across tool_done / subagent handlers. */
function findBlockByIndexAndKind<T extends OutputBlock["kind"]>(
  state: TuiState,
  indexKey: string,
  expectedKind: T,
  scanMatch: (b: Extract<OutputBlock, { kind: T }>) => boolean,
): (OutputBlock & { kind: T }) | undefined {
  const indexedId = state.blockIndex[indexKey];
  if (indexedId != null) {
    const b = findBlockById(state, indexedId);
    if (b && b.kind === expectedKind && scanMatch(b as Extract<OutputBlock, { kind: T }>)) {
      return b as OutputBlock & { kind: T };
    }
  }
  // Full-scan fallback
  for (const turn of state.turns) {
    for (const b of turn.blocks) {
      if (b.kind === expectedKind && scanMatch(b as Extract<OutputBlock, { kind: T }>)) {
        return b as OutputBlock & { kind: T };
      }
    }
  }
  return undefined;
}

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

function computeToolDetail(name: string, args: Record<string, unknown>, totalLines?: number): string | undefined {
  switch (name) {
    case "read_file": {
      const path = typeof args.path === "string" ? args.path : "";
      const range = formatReadFileRange(args, totalLines);
      return `Read ${path}${range}`;
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
  // Guard: malformed events from corrupted checkpoints must not crash the TUI
  if (!event.data) return state;

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
      // Stream-append: update the last block only if it's a streaming text block.
      // Non-streaming text blocks (model_retry, final) should not be overwritten.
      // Skip update if content hasn't changed to avoid unnecessary re-renders.
      if (state.running && lastBlock?.kind === "text" && lastBlock.streaming) {
        if (lastBlock.content === event.data.text) return state;
        return updateLastBlock(state, { ...lastBlock, content: event.data.text });
      }
      // Dedup: check all text blocks in the last turn (not just the most recent one)
      if (lastBlock?.kind === "text" && lastBlock.content === event.data.text) return state;
      if (last) {
        for (let i = last.blocks.length - 1; i >= 0; i--) {
          const blk = last.blocks[i];
          if (blk.kind === "text") {
            if (blk.content === event.data.text) return state;
            // Continue scanning — don't break, as there may be earlier text blocks with same content
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
      // Finalize streaming text so it doesn't enter <Static> with cursor
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: "reason", content: event.data.text, folded: true };
      return { ...appendBlock(finalized, block), currentRunReasonId: id };
    }
    case "tool_call": {
      // task tool has its own subagent block — skip the redundant tool_card
      if (event.data.name === "task") return state;
      // Dedup: if this call_id already has a tool_card block, skip.
      // Prevents duplicate rendering when the same tool_call event is replayed.
      if (state.blockIndex[event.data.call_id] != null) {
        const existing = findBlockById(state, state.blockIndex[event.data.call_id]);
        if (existing?.kind === "tool_card" && existing.callId === event.data.call_id) return state;
      }
      // Finalize streaming text so it doesn't enter <Static> with cursor
      const finalized = finalizeLastTurnStreaming(state);
      // update_plan renders as a plan_card block, not a tool_card
      if (event.data.name === "update_plan") {
        const args = event.data.args;
        const steps: AgentPlanStep[] = Array.isArray(args.steps)
          ? (args.steps as AgentPlanStep[])
          : [];
        const id = finalized.nextBlockId;
        const block: OutputBlock = {
          id, kind: "plan_card",
          name: String(args.name ?? ""),
          description: String(args.description ?? ""),
          planStatus: (args.status as PlanStatus) ?? "pending",
          steps, folded: false, callId: event.data.call_id,
        };
        return appendBlock(finalized, block);
      }
      const preview = getToolPreview(event.data.name, event.data.args);
      const id = finalized.nextBlockId;
      const block: OutputBlock = {
        id, kind: "tool_card",
        callId: event.data.call_id, name: event.data.name, args: event.data.args,
        status: "running", summary: "", preview,
      };
      const times = { ...finalized.toolStartTimes, [event.data.call_id]: Date.now() };
      const blockIndex = { ...finalized.blockIndex, [event.data.call_id]: id };
      return { ...appendBlock(finalized, block), toolStartTimes: times, blockIndex };
    }
    case "tool_done": {
      if (event.data.name === "task") return state;
      if (event.data.name === "update_plan") return state;
      const startedAt = state.toolStartTimes?.[event.data.call_id];
      const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
      const { [event.data.call_id]: _, ...nextTimes } = state.toolStartTimes ?? {};
      const matched = findBlockByIndexAndKind(state, event.data.call_id, "tool_card", b => b.callId === event.data.call_id);
      if (!matched) return { ...state, toolStartTimes: nextTimes };
      const next: OutputBlock = {
        ...matched,
        status: event.data.ok ? "done" as const : "error" as const,
        summary: event.data.summary,
        elapsedMs,
        detail: computeToolDetail(matched.name, matched.args, event.data.totalLines),
        expanded: !event.data.ok,
      };
      return { ...replaceBlockById(state, matched.id, next), toolStartTimes: nextTimes };
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
        // Update ALL plan_card blocks (not just the most recent one)
        for (let ti = state.turns.length - 1; ti >= 0; ti--) {
          const turn = state.turns[ti];
          let turnChanged = false;
          const blocks = turn.blocks.slice();
          for (let bi = turn.blocks.length - 1; bi >= 0; bi--) {
            const b = turn.blocks[bi];
            if (b.kind === "plan_card") {
              blocks[bi] = { ...b, planStatus: d.plan.status ?? b.planStatus, steps: d.plan.steps ?? b.steps };
              turnChanged = true;
            }
          }
          if (turnChanged) {
            const turns = nextState.turns.slice();
            turns[ti] = { blocks };
            nextState = { ...nextState, turns };
          }
        }
      }
      return { ...nextState, status: next };
    }
    case "model_retry": {
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `⟳ Model retry #${event.data.attempt} (${event.data.delayMs}ms): ${event.data.error}` };
      return appendBlock(finalized, block);
    }
    case "step_begin": {
      return { ...state, status: { ...state.status, currentNode: event.data.node } };
    }
    case "step_end": {
      return { ...state, status: { ...state.status, currentNode: null } };
    }
    case "cache_metrics": {
      const d = event.data;
      const hit = state.status.cacheHitTokens + d.cacheHitTokens;
      const miss = state.status.cacheMissTokens + d.cacheMissTokens;
      const cacheTotal = hit + miss;
      const updated = {
        ...state,
        status: {
          ...state.status,
          cacheHitTokens: hit,
          cacheMissTokens: miss,
          cacheHitRate: cacheTotal > 0 ? hit / cacheTotal : 0,
          // 累加每轮净增量：未命中缓存的输入 + 模型产出。
          // cacheHitTokens 是前缀缓存复用，已在之前轮次中计入过，不重复累加。
          // Accumulate net-new tokens per call: cache-miss input + model output.
          // cacheHitTokens are prefix reuse and already counted in prior calls.
          totalTokens: state.status.totalTokens + d.cacheMissTokens + (d.outputTokens ?? 0),
        },
      };
      // 每次模型调用后追加一条缓存命中日志到输出区
      // Append a cache hit log line after each model call
      if (d.inputTokens > 0) {
        const hitTokens = d.cacheHitTokens;
        const missTokens = d.cacheMissTokens;
        const rate = d.inputTokens > 0 ? (hitTokens / d.inputTokens * 100).toFixed(0) : "0";
        const log = `⚡ cache: ${fmt(hitTokens)} hit / ${fmt(missTokens)} miss · ${rate}%`;
        const block: OutputBlock = { id: updated.nextBlockId, kind: "text", content: log };
        return appendBlock(updated, block);
      }
      return updated;
    }
    case "final": {
      if (event.data.length === 0) return state;
      const finalized = finalizeLastTurnStreaming(state);
      const last = lastTurn(finalized);
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
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: event.data };
      return appendBlock(finalized, block);
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
      const finalized = finalizeLastTurnStreaming(state);
      const prefix = event.data.recoverable ? "⟳ Recoverable error" : "Error";
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: "text", content: `${prefix}: ${event.data.message}`, isError: !event.data.recoverable };
      return { ...appendBlock(finalized, block), sessionError: !event.data.recoverable };
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
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: "file_change", changes: [change] };
      return appendBlock(finalized, block);
    }
    case "subagent_start": {
      // Dedup: if a subagent block with this ID already exists, skip.
      if (state.blockIndex[event.data.id] != null) return state;
      for (const turn of state.turns) {
        if (turn.blocks.some(b => b.kind === "subagent" && b.subagentId === event.data.id)) return state;
      }
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = {
        id, kind: "subagent",
        subagentId: event.data.id,
        role: event.data.role,
        task: event.data.task,
        status: "running", summary: "",
        toolCallCount: 0, durationMs: 0, steps: [],
      };
      const blockIndex = { ...finalized.blockIndex, [event.data.id]: id };
      return { ...appendBlock(finalized, block), blockIndex };
    }
    case "subagent_step": {
      const matched = findBlockByIndexAndKind(state, event.data.id, "subagent", b => b.subagentId === event.data.id);
      if (!matched) return state;
      const next: OutputBlock = { ...matched, steps: [...matched.steps, { toolName: event.data.toolName, toolArgs: event.data.toolArgs }] };
      return replaceBlockById(state, matched.id, next);
    }
    case "subagent_tool_result": {
      const matched = findBlockByIndexAndKind(state, event.data.id, "subagent", b => b.subagentId === event.data.id);
      if (!matched) return state;
      // Reverse-scan to find the last UNRESOLVED step with matching toolName.
      // Prefer unresolved steps to handle out-of-order results correctly:
      // e.g., two read_file steps — first result resolves the last unresolved one,
      // second result resolves the remaining one.
      let lastMatchIdx = -1;
      for (let i = matched.steps.length - 1; i >= 0; i--) {
        if (matched.steps[i].toolName === event.data.toolName && matched.steps[i].ok === undefined) {
          lastMatchIdx = i;
          break;
        }
      }
      // Fallback: if all matching steps already have ok, re-resolve the last one
      if (lastMatchIdx === -1) {
        for (let i = matched.steps.length - 1; i >= 0; i--) {
          if (matched.steps[i].toolName === event.data.toolName) {
            lastMatchIdx = i;
            break;
          }
        }
      }
      if (lastMatchIdx === -1) return state;
      const steps = matched.steps.map((s, i) =>
        i === lastMatchIdx ? { ...s, ok: event.data.ok, totalLines: event.data.totalLines } : s
      );
      if (steps.every((s, i) => s === matched.steps[i])) return state;
      const next: OutputBlock = { ...matched, steps };
      return replaceBlockById(state, matched.id, next);
    }
    case "subagent_done": {
      const matched = findBlockByIndexAndKind(state, event.data.id, "subagent", b => b.subagentId === event.data.id);
      if (!matched) return state;
      const next: OutputBlock = {
        ...matched,
        status: "done" as const,
        summary: event.data.summary,
        toolCallCount: event.data.toolCallCount,
        durationMs: event.data.durationMs,
        expanded: false,
      };
      return replaceBlockById(state, matched.id, next);
    }
    case "subagent_error": {
      const matched = findBlockByIndexAndKind(state, event.data.id, "subagent", b => b.subagentId === event.data.id);
      if (!matched) return state;
      const next: OutputBlock = { ...matched, status: "error" as const, error: event.data.error };
      return replaceBlockById(state, matched.id, next);
    }
    case "subagent_cache_metrics": {
      // 累积子 agent 的缓存指标到对应 subagent block 上，供 TUI 展示
      const matched = findBlockByIndexAndKind(state, event.data.subagentId, "subagent", b => b.subagentId === event.data.subagentId);
      if (!matched) return state;
      const prevHit = matched.cacheHitTokens ?? 0;
      const prevMiss = matched.cacheMissTokens ?? 0;
      const next: typeof matched = {
        ...matched,
        cacheHitTokens: prevHit + event.data.cacheHitTokens,
        cacheMissTokens: prevMiss + event.data.cacheMissTokens,
      };
      const updated = replaceBlockById(state, matched.id, next);
      // 追加子 agent 缓存命中日志到输出区
      const hitTokens = event.data.cacheHitTokens;
      const missTokens = event.data.cacheMissTokens;
      const inputTokens = event.data.inputTokens;
      if (inputTokens > 0) {
        const rate = (hitTokens / inputTokens * 100).toFixed(0);
        const log = `  ⚡ sub cache: ${fmt(hitTokens)} hit / ${fmt(missTokens)} miss · ${rate}%`;
        const block: OutputBlock = { id: updated.nextBlockId, kind: "text", content: log };
        return appendBlock(updated, block);
      }
      return updated;
    }
    // Raw passthrough events — intentionally no-op for UI consumers
    case "interrupt":
    case "update":
      return state;
    default:
      return state;
  }
}
