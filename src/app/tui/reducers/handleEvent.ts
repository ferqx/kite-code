// ── EVENT action handler — 19 event sub-types ──

import type { AgentEvent, AgentPlanStep, PlanStatus } from "@/protocol/events";
import type { TuiState, OutputBlock, FileChangeRecord } from "../types";
import { appendBlock, updateLastBlock, finalizeLastTurnStreaming, lastTurn, findBlockById, replaceBlockById } from "./helpers";
import { formatReadFileRange, getToolPreview, getToolDetail } from "../components/render-utils";

/** 格式化 file_change 事件的原始预览内容，截断到最多 6 行 / Format raw file_change preview, truncating to max 6 lines */
const MAX_PREVIEW_LINES = 6;

function formatFilePreview(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lines = raw.split("\n");
  if (lines.length > MAX_PREVIEW_LINES) {
    return lines.slice(0, MAX_PREVIEW_LINES).join("\n") + "\n...";
  }
  // Remove trailing empty line from exact-slice files (common for files ending with \n)
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    return lines.slice(0, -1).join("\n");
  }
  return raw;
}

/** 格式化 token 数量（1k+ 用 k 缩写）。缓存日志注释解除后需要。
 *  Format token count (abbreviate with k for 1k+). Needed when cache log is uncommented. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
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

export function handleEventAction(state: TuiState, event: AgentEvent): TuiState {
  // Guard: malformed events from corrupted checkpoints must not crash the TUI
  if (!event.data) return state;

  // 非 reason 事件清除 currentRunReasonId，让下一个 reason 创建新块。
  // 避免中间隔了工具调用后两个 reason 块被合并。
  // Auto-clear currentRunReasonId on any non-reason event,
  // so the next reason creates a new block instead of appending.
  if (event.type !== "reason" && state.currentRunReasonId !== undefined) {
    const reasonBlock = findBlockById(state, state.currentRunReasonId);
    if (reasonBlock?.kind === "reason" && reasonBlock.folded) {
      state = replaceBlockById(state, state.currentRunReasonId, { ...reasonBlock, folded: false });
    }
    state = { ...state, currentRunReasonId: undefined };
  }

  switch (event.type) {
    case "text": {
      const last = lastTurn(state);
      const lastBlock = last?.blocks.at(-1);

      if (state.running && event.data.text.includes("\n")) {
        // Multi-line during streaming → always split into per-line blocks.
        // Handles both the first text event (no prior streaming block) and
        // subsequent updates (replacing an existing streaming block).

        // Count already-finalized per-line text blocks (0 for first event or old model).
        let numFinalized = 0;
        if (lastBlock?.kind === "text" && lastBlock.streaming) {
          for (let i = 0; i < last!.blocks.length - 1; i++) {
            if (last!.blocks[i].kind === "text") numFinalized++;
          }
        }
        // Reconstruct previous full text for dedup
        let prevFullText = "";
        let firstText = true;
        for (const b of last?.blocks ?? []) {
          if (b.kind !== "text") continue;
          if (firstText) { prevFullText = b.content; firstText = false; }
          else prevFullText += "\n" + b.content;
        }
        if (prevFullText === event.data.text) return state;

        const newLines = event.data.text.split("\n");

        const turns = state.turns.slice();
        if (turns.length === 0) turns.push({ blocks: [] });
        const blocks = turns[turns.length - 1].blocks.slice();
        let nextId = state.nextBlockId;

        // Remove old streaming block if present
        if (lastBlock?.kind === "text" && lastBlock.streaming) {
          blocks.pop();
        }

        // Add newly completed lines as finalized blocks
        for (let i = numFinalized; i < newLines.length - 1; i++) {
          blocks.push({ id: nextId++, kind: "text", content: newLines[i], streaming: false });
        }

        // Add new streaming block for the last (possibly incomplete) line
        const lastLine = newLines[newLines.length - 1];
        blocks.push({ id: nextId++, kind: "text", content: lastLine, streaming: true });

        turns[turns.length - 1] = { blocks };
        return { ...state, turns, nextBlockId: nextId };
      }

      // Single-line update: keep existing block ID, just replace content.
      if (state.running && lastBlock?.kind === "text" && lastBlock.streaming) {
        if (lastBlock.content === event.data.text) return state;
        return updateLastBlock(state, { ...lastBlock, content: event.data.text });
      }

      // Dedup: check all text blocks in the last turn
      if (lastBlock?.kind === "text" && lastBlock.content === event.data.text) return state;
      if (last) {
        for (let i = last.blocks.length - 1; i >= 0; i--) {
          const blk = last.blocks[i];
          if (blk.kind === "text") {
            if (blk.content === event.data.text) return state;
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
        detail: getToolDetail(matched.name, matched.args, event.data.totalLines),
        expanded: !event.data.ok || matched.name === "shell_execute",
      };
      // 工具输出的 token 计入累计统计 / Tool output tokens counted in cumulative total
      if (event.data.toolTokenCount && event.data.toolTokenCount > 0) {
        return {
          ...replaceBlockById(state, matched.id, next),
          toolStartTimes: nextTimes,
          status: { ...state.status, totalTokens: state.status.totalTokens + event.data.toolTokenCount },
        };
      }
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
      // 手动统计 tokens，不依赖 provider 的 cache_miss 字段：
      // - 首次调用：inputTokens = 全量上下文，作为基准线
      // - 后续调用：只加模型产出 (outputTokens)，上下文增量由 tool_done 的 toolTokenCount 计入
      // Manual token counting, provider-agnostic:
      // - First call: inputTokens = full context baseline
      // - Subsequent calls: only add model output; context growth tracked via toolTokenCount in tool_done
      const isFirstCall = state.status.totalTokens === 0;
      const addedTokens = isFirstCall
        ? d.inputTokens + (d.outputTokens ?? 0)
        : (d.outputTokens ?? 0);
      const updated = {
        ...state,
        status: {
          ...state.status,
          cacheHitTokens: hit,
          cacheMissTokens: miss,
          cacheHitRate: cacheTotal > 0 ? hit / cacheTotal : 0,
          totalTokens: state.status.totalTokens + addedTokens,
        },
      };
      // 缓存命中日志：调试时取消注释即可启用 / Cache hit log: uncomment to enable for debugging
      // if (d.inputTokens > 0) {
      //   const hitTokens = d.cacheHitTokens;
      //   const missTokens = d.cacheMissTokens;
      //   const rate = d.inputTokens > 0 ? (hitTokens / d.inputTokens * 100).toFixed(0) : "0";
      //   const log = `⚡ cache: ${fmt(hitTokens)} hit / ${fmt(missTokens)} miss · ${rate}%`;
      //   const block: OutputBlock = { id: updated.nextBlockId, kind: "text", content: log };
      //   return appendBlock(updated, block);
      // }
      return updated;
    }
    case "final": {
      if (event.data.length === 0) return state;
      const finalized = finalizeLastTurnStreaming(state);
      const last = lastTurn(finalized);
      // Reconstruct full text from all per-line text blocks in this turn,
      // since with line-by-line output each block holds only one line.
      let fullText = "";
      let firstText = true;
      for (const b of (last?.blocks ?? [])) {
        if (b.kind !== "text") continue;
        if (firstText) { fullText = b.content; firstText = false; }
        else fullText += "\n" + b.content;
      }
      if (fullText === event.data) return finalized;
      // final 可能比最后一个 text 事件多几个字符 → 只追加增量，不创建全文 block 避免重复
      if (fullText.length > 0 && event.data.startsWith(fullText)) {
        const delta = event.data.slice(fullText.length);
        if (delta.length === 0) return finalized;
        const id = finalized.nextBlockId;
        const block: OutputBlock = { id, kind: "text", content: delta };
        return appendBlock(finalized, block);
      }
      // 无前置 text block（纯 tool 调用等）→ 创建全文 block
      if (fullText.length === 0) {
        const id = finalized.nextBlockId;
        const block: OutputBlock = { id, kind: "text", content: event.data };
        return appendBlock(finalized, block);
      }
      // final 内容与已渲染文本不一致 → 保留已有 block，不创建重复
      return finalized;
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
        preview: formatFilePreview(event.data.preview),
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
      // 子 agent 缓存命中日志：调试时取消注释即可启用 / Sub-agent cache hit log: uncomment to enable for debugging
      // const hitTokens = event.data.cacheHitTokens;
      // const missTokens = event.data.cacheMissTokens;
      // const inputTokens = event.data.inputTokens;
      // if (inputTokens > 0) {
      //   const rate = (hitTokens / inputTokens * 100).toFixed(0);
      //   const log = `  ⚡ sub cache: ${fmt(hitTokens)} hit / ${fmt(missTokens)} miss · ${rate}%`;
      //   const block = { id: updated.nextBlockId, kind: "text" as const, content: log };
      //   return appendBlock(updated, block);
      // }
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
