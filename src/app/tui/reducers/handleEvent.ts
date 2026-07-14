// ── TUI render-event handler ──

import type { RuntimeEvent } from '@/core/runtime/events';
import type * as Protocol from '@/protocol/events';
import {
  formatToolResultForDisplay,
  getToolDetail,
  getToolPreview,
} from '../components/render-utils';
import { MAX_TOOL_LINES } from '../components/ToolCardBlock';
import type { ConsolidatedToolEntry, FileChangeRecord, OutputBlock, TuiState } from '../types';
import {
  buildToolSummaryLine,
  isExplorationToolByName,
  isExplorationToolEvent,
  maybeConsolidateLastTurnBlocks,
} from './consolidateTools';
import {
  appendBlock,
  finalizeLastTurnStreaming,
  findBlock,
  findBlockById,
  hasBlock,
  lastTurn,
  replaceBlockById,
  updateLastBlock,
} from './helpers';

/** Internal rendering vocabulary shared by RuntimeEvent rendering paths.
 * RuntimeEvent remains the only streamed action accepted by the TUI reducer. */
export type RenderEvent =
  | { type: 'step_begin'; data: { node: string; spanId: string; internal?: boolean } }
  | { type: 'step_end'; data: { node: string; spanId: string } }
  | { type: 'reason' | 'text'; data: { text: string } }
  | { type: 'tool_call'; data: Protocol.ToolCallPayload }
  | { type: 'tool_started'; data: Protocol.ToolStartedPayload }
  | { type: 'tool_done'; data: Protocol.ToolResultPayload }
  | { type: 'need_approval'; data: Protocol.ToolApprovalPayload }
  | { type: 'need_input'; data: Protocol.UserInputPayload; toolCallId?: string }
  | { type: 'need_plan_review'; data: Protocol.NeedPlanReviewPayload }
  | { type: 'state_change'; data: Protocol.StateChangePayload }
  | {
      type: 'file_change';
      data: {
        path: string;
        kind: 'add' | 'edit' | 'delete';
        linesAdded?: number;
        linesRemoved?: number;
        preview?: string;
      };
    }
  | { type: 'cache_metrics'; data: Protocol.CacheMetricsPayload }
  | { type: 'error'; data: { message: string; recoverable: boolean } }
  | { type: 'interrupt' | 'update'; data: unknown }
  | {
      type: 'model_retry';
      data: { attempt: number; maxAttempts: number; error: string; delayMs: number };
    }
  | { type: 'final'; data: string }
  | { type: 'subagent_start'; data: Protocol.SubAgentStartPayload }
  | { type: 'subagent_step'; data: Protocol.SubAgentStepPayload }
  | { type: 'subagent_tool_result'; data: Protocol.SubAgentToolResultPayload }
  | { type: 'subagent_done'; data: Protocol.SubAgentDonePayload }
  | { type: 'subagent_error'; data: Protocol.SubAgentErrorPayload }
  | { type: 'subagent_cache_metrics'; data: Protocol.SubAgentCacheMetricsPayload }
  | { type: 'tool_progress'; data: Protocol.ToolProgressPayload }
  | { type: 'turn_begin'; data: { index: number; spanId: string } }
  | { type: 'turn_end'; data: { index: number } }
  | { type: 'user_message'; data: Protocol.UserMessagePayload };

// ── Structural text block helpers ──
// During streaming, text events are split into per-line blocks for progressive
// rendering. But structural markdown elements (tables, code blocks) need
// multi-line context — MarkdownBlock.groupLines() requires seeing header+sep,
// or opening+closing fences, within a single block. These helpers detect
// structural elements and merge their per-line blocks back together.

// ── Table detection ──

const TABLE_PIPE = /[|│]/;
const TIMEOUT_RE = /^Command timed out after (\d+)ms\./;

function parseTimeoutMs(summary: string): number | undefined {
  const match = summary.match(TIMEOUT_RE);
  return match ? Number(match[1]) : undefined;
}

function isTableSepLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (!TABLE_PIPE.test(trimmed)) return false;
  return /^[\s\-:|─━┼╿]+$/.test(trimmed);
}

function isTableRowLike(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (!TABLE_PIPE.test(trimmed)) return false;
  return /^[|│]/.test(trimmed) || /[|│]$/.test(trimmed) || isTableSepLine(trimmed);
}

// ── Code block detection ──

/** True when the first line of content is a code fence (```). */
function isCodeFenceStart(content: string): boolean {
  return content.trimStart().startsWith('```');
}

/** True when content has an odd number of ``` lines → we're inside an
 *  open code block waiting for a closing fence. */
function isInsideOpenCodeBlock(content: string): boolean {
  let fenceCount = 0;
  const lines = content.split('\n');
  for (const line of lines) {
    if (line.trimStart().startsWith('```')) fenceCount++;
  }
  return fenceCount % 2 === 1;
}

/** True when the streaming block is a structural element that needs
 *  multi-line context for MarkdownBlock — table row, code fence, or
 *  content inside an open code block. */
function needsStructuralContext(content: string): boolean {
  return isTableRowLike(content) || isCodeFenceStart(content) || isInsideOpenCodeBlock(content);
}

// ── Structural merge ──

type TextBlock = OutputBlock & { kind: 'text' };

/** Merge consecutive text blocks that form structural markdown elements
 *  (tables, code blocks) so that MarkdownBlock.groupLines() receives
 *  the multi-line context it needs to render them correctly. */
function mergeStructuralTextBlocks(state: TuiState): TuiState {
  const last = state.turns.at(-1);
  if (!last) return state;

  const merged: OutputBlock[] = [];
  let buffer: TextBlock[] = [];
  let changed = false;

  const flushBuffer = () => {
    if (buffer.length <= 1) {
      for (const b of buffer) merged.push(b);
      buffer = [];
      return;
    }
    const first = buffer[0]!;
    const lastBuf = buffer[buffer.length - 1]!;
    const content = buffer.map((b) => b.content).join('\n');
    merged.push({
      id: first.id,
      kind: 'text' as const,
      content,
      streaming: lastBuf.streaming,
      isError: buffer.some((b) => b.isError === true) || undefined,
    });
    changed = true;
    buffer = [];
  };

  let inCode = false;

  for (const block of last.blocks) {
    if (block.kind !== 'text') {
      flushBuffer();
      inCode = false;
      merged.push(block);
      continue;
    }

    if (isCodeFenceStart(block.content)) {
      if (!inCode) {
        // Opening fence: start code-block buffer (flush any prior table buffer)
        flushBuffer();
        buffer.push(block);
        inCode = true;
      } else {
        // Closing fence: complete the code block
        buffer.push(block);
        flushBuffer();
        inCode = false;
      }
    } else if (inCode || isTableRowLike(block.content)) {
      // Inside code block body, or table row outside code block
      buffer.push(block);
    } else {
      flushBuffer();
      merged.push(block);
    }
  }
  flushBuffer();

  if (!changed) return state;
  const turns = state.turns.slice();
  turns[turns.length - 1] = { blocks: merged };
  return { ...state, turns };
}

/** 格式化 file_change 事件的原始预览内容，截断到最多 6 行 / Format raw file_change preview, truncating to max 6 lines */
const MAX_PREVIEW_LINES = 6;

function formatFilePreview(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const lines = raw.split('\n');
  if (lines.length > MAX_PREVIEW_LINES) {
    return `${lines.slice(0, MAX_PREVIEW_LINES).join('\n')}\n...`;
  }
  // Remove trailing empty line from exact-slice files (common for files ending with \n)
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1).join('\n');
  }
  return raw;
}

function findToolSummaryLocation(
  state: TuiState,
  callId: string,
  preferredBlockId?: number,
): {
  turnIndex: number;
  blockIndex: number;
  block: Extract<OutputBlock, { kind: 'tool_summary' }>;
} | null {
  if (preferredBlockId != null) {
    for (let turnIndex = 0; turnIndex < state.turns.length; turnIndex++) {
      const blockIndex = state.turns[turnIndex]!.blocks.findIndex(
        (b) => b.kind === 'tool_summary' && b.id === preferredBlockId,
      );
      if (blockIndex >= 0) {
        return {
          turnIndex,
          blockIndex,
          block: state.turns[turnIndex]!.blocks[blockIndex]! as Extract<
            OutputBlock,
            { kind: 'tool_summary' }
          >,
        };
      }
    }
  }

  for (let turnIndex = state.turns.length - 1; turnIndex >= 0; turnIndex--) {
    const blocks = state.turns[turnIndex]!.blocks;
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex--) {
      const block = blocks[blockIndex]!;
      if (block.kind === 'tool_summary' && block.tools.some((t) => t.callId === callId)) {
        return { turnIndex, blockIndex, block };
      }
    }
  }

  return null;
}

function updateToolSummaryById(
  state: TuiState,
  blockId: number,
  update: (
    block: Extract<OutputBlock, { kind: 'tool_summary' }>,
  ) => Extract<OutputBlock, { kind: 'tool_summary' }> | null,
): TuiState {
  let changed = false;
  const turns = state.turns.map((turn) => ({
    blocks: turn.blocks.flatMap((block) => {
      if (block.kind !== 'tool_summary' || block.id !== blockId) return [block];
      const next = update(block);
      changed = true;
      return next ? [next] : [];
    }),
  }));
  return changed ? { ...state, turns } : state;
}

function findThoughtSummary(
  state: TuiState,
  blockId: number | undefined,
): Extract<OutputBlock, { kind: 'tool_summary' }> | null {
  if (blockId == null) return null;
  const block = findBlockById(state, blockId);
  return block?.kind === 'tool_summary' ? block : null;
}

function closeCurrentThought(state: TuiState): TuiState {
  const summary = findThoughtSummary(state, state.currentThoughtSummaryId);
  if (!summary) return { ...state, currentThoughtSummaryId: undefined };

  const next = updateToolSummaryById(state, summary.id, (block) => {
    if (block.tools.length === 0) return null;
    const hasError = block.tools.some(
      (t) => t.status === 'error' || t.status === 'timeout' || t.status === 'exhausted',
    );
    const anyCancelled = block.tools.some((t) => t.status === 'cancelled');
    const allSettled = block.tools.every((t) => t.status !== 'queued' && t.status !== 'running');
    // Only assign result when all tools have actually settled.
    // If tools are still running, leave result undefined — later tool_done
    // events will recalculate it (lines ~633-648).
    const result = allSettled
      ? hasError
        ? ('error' as const)
        : anyCancelled
          ? ('cancelled' as const)
          : ('done' as const)
      : undefined;
    return {
      ...block,
      active: false,
      latestActivity: undefined,
      totalElapsedMs: Date.now() - block.createdAt,
      ...(result ? { result } : {}),
    };
  });
  return { ...next, currentThoughtSummaryId: undefined };
}

function updateCurrentThoughtActivity(
  state: TuiState,
  latestActivity: Extract<OutputBlock, { kind: 'tool_summary' }>['latestActivity'],
): TuiState {
  const isThinking = latestActivity?.kind === 'thinking';
  const summary = findThoughtSummary(state, state.currentThoughtSummaryId);
  if (summary?.active) {
    return updateToolSummaryById(state, summary.id, (block) => {
      const seq = (block.nextTimelineSeq ?? block.timeline?.length ?? 0) + 1;
      const timelineEntry = isThinking
        ? { seq, kind: 'thinking' as const, text: latestActivity!.text }
        : { seq, kind: 'tool' as const, callId: latestActivity!.callId };
      return {
        ...block,
        active: true,
        latestActivity,
        hasThinking: isThinking ? true : block.hasThinking,
        totalElapsedMs: Date.now() - block.createdAt,
        timeline: [...(block.timeline ?? []), timelineEntry],
        nextTimelineSeq: seq,
      };
    });
  }

  const id = state.nextBlockId;
  const initialTimeline = latestActivity
    ? [
        {
          seq: 1,
          kind: latestActivity.kind as 'thinking' | 'tool',
          ...(latestActivity.kind === 'thinking'
            ? { text: latestActivity.text }
            : { callId: latestActivity.callId }),
        },
      ]
    : [];
  const block: OutputBlock = {
    id,
    kind: 'tool_summary',
    tools: [],
    totalElapsedMs: 0,
    createdAt: Date.now(),
    summaryLine: 'thinking',
    active: true,
    hasThought: true,
    latestActivity,
    hasThinking: isThinking || undefined,
    timeline: initialTimeline as Extract<OutputBlock, { kind: 'tool_summary' }>['timeline'],
    nextTimelineSeq: 1,
  };
  return {
    ...appendBlock(state, block),
    currentThoughtSummaryId: id,
  };
}

export function handleEventAction(state: TuiState, event: RenderEvent): TuiState {
  // Guard: malformed events from corrupted checkpoints must not crash the TUI
  if (!event.data) return state;

  // 非 reason 事件清除 currentRunReasonId，让下一个 reason 创建新块。
  // 避免中间隔了工具调用后两个 reason 块被合并。
  // 但 cache_metrics / state_change / step_begin / step_end / interrupt / update
  // 等纯内部事件不应打断 reason 连续性——这些事件不代表模型推理周期中断。
  // Auto-clear currentRunReasonId on content-bearing events,
  // so the next reason creates a new block instead of appending.
  // Internal bookkeeping events (cache_metrics, state_change, step_*) must NOT
  // break reason continuity — they are not part of the model's reasoning cycle.
  const REASON_CONTINUITY_EVENTS = new Set([
    'cache_metrics',
    'state_change',
    'step_begin',
    'step_end',
    'interrupt',
    'update',
    'tool_progress',
    'subagent_cache_metrics',
  ]);
  if (
    event.type !== 'reason' &&
    state.currentRunReasonId !== undefined &&
    !REASON_CONTINUITY_EVENTS.has(event.type)
  ) {
    const reasonBlock = findBlockById(state, state.currentRunReasonId);
    if (reasonBlock?.kind === 'reason' && reasonBlock.folded) {
      state = replaceBlockById(state, state.currentRunReasonId, { ...reasonBlock, folded: false });
    }
    state = { ...state, currentRunReasonId: undefined };
  }

  switch (event.type) {
    case 'text': {
      // 先关闭当前 Thought，再判断是否为 whitespace。即使文本自身不渲染（纯空白），
      // 模型已经开始输出就代表思考周期结束，Thought 必须关闭以防后续工具无限累积。
      // Close the current Thought BEFORE the whitespace check. Even if the text
      // itself isn't rendered (all whitespace), the model has begun output —
      // the thinking cycle is over and the Thought must close to prevent
      // unbounded tool accumulation in subsequent exploration phases.
      state = closeCurrentThought(state);
      if (!/\S/u.test(event.data.text)) return state;
      const last = lastTurn(state);
      const lastBlock = last?.blocks.at(-1);

      if (state.running && event.data.text.includes('\n')) {
        // Multi-line during streaming → split into per-line blocks for progressive
        // rendering. Structural elements (tables, code blocks) are an exception:
        // consecutive structural lines are kept together so MarkdownBlock.groupLines()
        // can detect the multi-line patterns it needs to render them correctly.

        // Count already-finalized per-line text blocks (0 for first event or old model).
        let numFinalized = 0;
        if (lastBlock?.kind === 'text' && lastBlock.streaming) {
          for (let i = 0; i < last!.blocks.length - 1; i++) {
            if (last!.blocks[i]!.kind === 'text') numFinalized++;
          }
        }
        // Reconstruct previous full text for dedup
        let prevFullText = '';
        let firstText = true;
        for (const b of last?.blocks ?? []) {
          if (b.kind !== 'text') continue;
          if (firstText) {
            prevFullText = b.content;
            firstText = false;
          } else prevFullText += `\n${b.content}`;
        }
        if (prevFullText === event.data.text) return state;

        // ── Structural-element extension: when the current streaming block
        //     contains a table row, code fence, or code body, and the new
        //     text is an extension, update in place. This preserves the
        //     multi-line structure MarkdownBlock needs for table/code-block
        //     detection and avoids unnecessary block ID churn.
        if (
          lastBlock?.kind === 'text' &&
          lastBlock.streaming &&
          needsStructuralContext(lastBlock.content) &&
          event.data.text.startsWith(lastBlock.content) &&
          event.data.text.length > lastBlock.content.length
        ) {
          // Strip trailing newline so block content doesn't end with \n
          const cleanText = event.data.text.endsWith('\n')
            ? event.data.text.slice(0, -1)
            : event.data.text;
          if (cleanText !== lastBlock.content) {
            const updated = updateLastBlock(state, { ...lastBlock, content: cleanText });
            return mergeStructuralTextBlocks(updated);
          }
          // cleanText === lastBlock.content: nothing changed after stripping, fall through
        }

        const newLines = event.data.text.split('\n');
        // Drop trailing empty from split (trailing \n artifact).
        // Otherwise the trailing "" becomes a streaming text block
        // that renders as a blank line between event dispatches.
        if (event.data.text.endsWith('\n') && newLines.length > 0) {
          newLines.pop();
        }

        const turns = state.turns.slice();
        if (turns.length === 0) turns.push({ blocks: [] });
        const blocks = turns[turns.length - 1]!.blocks.slice();
        let nextId = state.nextBlockId;

        // Remove old streaming block if present
        if (lastBlock?.kind === 'text' && lastBlock.streaming) {
          blocks.pop();
        }

        // Add newly completed lines as finalized blocks
        for (let i = numFinalized; i < newLines.length - 1; i++) {
          blocks.push({ id: nextId++, kind: 'text', content: newLines[i]!, streaming: false });
        }

        // Add new streaming block for the last (possibly incomplete) line
        const lastLine = newLines[newLines.length - 1]!;
        blocks.push({ id: nextId++, kind: 'text', content: lastLine, streaming: true });

        turns[turns.length - 1] = { blocks };
        const splitResult = { ...state, turns, nextBlockId: nextId };
        return mergeStructuralTextBlocks(splitResult);
      }

      // Single-line update: keep existing block ID, just replace content.
      if (state.running && lastBlock?.kind === 'text' && lastBlock.streaming) {
        if (lastBlock.content === event.data.text) return state;
        const updated = updateLastBlock(state, { ...lastBlock, content: event.data.text });
        return mergeStructuralTextBlocks(updated);
      }

      // Dedup: check all text blocks in the last turn
      if (lastBlock?.kind === 'text' && lastBlock.content === event.data.text) return state;
      if (last) {
        for (let i = last.blocks.length - 1; i >= 0; i--) {
          const blk = last.blocks[i]!;
          if (blk.kind === 'text') {
            if (blk.content === event.data.text) return state;
          }
        }
      }
      // 纯空白文本（含 Unicode 空白）不创建 block — MarkdownBlock 不渲染，
      // 但 block 本身会通过 gapFrom 的 marginTop 产生多余空白行。
      // Blank/whitespace-only text (incl. Unicode whitespace) creates no
      // visual output but its marginTop adds unwanted blank lines.
      const id = state.nextBlockId;
      const block: OutputBlock = {
        id,
        kind: 'text',
        content: event.data.text,
        streaming: state.running,
      };
      const appended = appendBlock(state, block);
      return mergeStructuralTextBlocks(appended);
    }
    case 'reason': {
      if (state.currentRunReasonId != null) {
        const reasonBlock = findBlockById(state, state.currentRunReasonId);
        if (reasonBlock?.kind === 'reason') {
          const next: OutputBlock = {
            ...reasonBlock,
            content: `${reasonBlock.content}\n\n${event.data.text}`,
          };
          return updateCurrentThoughtActivity(replaceBlockById(state, reasonBlock.id, next), {
            kind: 'thinking',
            text: event.data.text,
          });
        }
      }
      // Finalize streaming text so it doesn't enter <Static> with cursor
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: 'reason', content: event.data.text, folded: true };
      const withReason = { ...appendBlock(finalized, block), currentRunReasonId: id };
      return updateCurrentThoughtActivity(withReason, { kind: 'thinking', text: event.data.text });
    }
    case 'tool_call': {
      const isExploration = isExplorationToolEvent(event.data);
      const toolStatus = event.data.status ?? 'running';
      // task tool has its own subagent block
      if (!isExploration) state = closeCurrentThought(state);
      if (event.data.name === 'task') return state;
      // 已审批方案后的 update_plan 调用是进度追踪，不在消息列表中展示
      if (event.data.name === 'update_plan' && state.status.plan !== null) return state;
      // Dedup: skip if this callId already exists in any block
      if (hasBlock(state, (b) => b.kind === 'tool_card' && b.callId === event.data.call_id))
        return state;
      // Finalize streaming text so it doesn't enter <Static> with cursor
      const finalized = finalizeLastTurnStreaming(state);
      const now = Date.now();
      const times =
        toolStatus === 'running'
          ? { ...finalized.toolStartTimes, [event.data.call_id]: now }
          : finalized.toolStartTimes;

      // ── Pre-consolidation: exploration tools go directly to tool_summary, never as tool_card ──
      if (isExploration) {
        const entry: ConsolidatedToolEntry = {
          callId: event.data.call_id,
          name: event.data.name,
          args: event.data.args,
          ok: false,
          summary: '',
          status: toolStatus,
          totalLines:
            typeof event.data.args?.totalLines === 'number'
              ? event.data.args.totalLines
              : undefined,
        };
        const currentThought = findThoughtSummary(finalized, finalized.currentThoughtSummaryId);

        if (currentThought?.active) {
          // Dedup: skip if this callId already exists in tools (dual pipeline: side-channel + stream)
          if (currentThought.tools.some((t) => t.callId === event.data.call_id)) {
            return finalized;
          }
          const now = Date.now();
          const tools = [...currentThought.tools, entry];
          const latestActivity =
            currentThought.latestActivity?.kind === 'thinking'
              ? currentThought.latestActivity
              : ({ kind: 'tool', callId: event.data.call_id } as const);
          const seq = (currentThought.nextTimelineSeq ?? currentThought.timeline?.length ?? 0) + 1;
          const updated: Extract<OutputBlock, { kind: 'tool_summary' }> = {
            ...currentThought,
            tools,
            totalElapsedMs: now - currentThought.createdAt,
            summaryLine: buildToolSummaryLine(tools),
            active: true,
            latestActivity,
            timeline: [
              ...(currentThought.timeline ?? []),
              { seq, kind: 'tool' as const, callId: event.data.call_id },
            ],
            nextTimelineSeq: seq,
          };
          return {
            ...replaceBlockById(finalized, currentThought.id, updated),
            toolStartTimes: times,
            explorationSummaryIds: {
              ...finalized.explorationSummaryIds,
              [event.data.call_id]: currentThought.id,
            },
            currentThoughtSummaryId: currentThought.id,
          };
        }

        // 创建新 tool_summary（无前置 reason → 无思考）
        const id = finalized.nextBlockId;
        const block: OutputBlock = {
          id,
          kind: 'tool_summary',
          tools: [entry],
          totalElapsedMs: 0,
          createdAt: now,
          summaryLine: buildToolSummaryLine([entry]),
          active: true,
          hasThought: false,
          latestActivity: { kind: 'tool', callId: event.data.call_id },
          timeline: [{ seq: 1, kind: 'tool' as const, callId: event.data.call_id }],
          nextTimelineSeq: 1,
        };
        return {
          ...appendBlock(finalized, block),
          toolStartTimes: times,
          explorationSummaryIds: { ...finalized.explorationSummaryIds, [event.data.call_id]: id },
          currentThoughtSummaryId: id,
        };
      }

      // Non-exploration tool → standard tool_card
      const preview = getToolPreview(event.data.name, event.data.args);
      const id = finalized.nextBlockId;
      const block: OutputBlock = {
        id,
        kind: 'tool_card',
        callId: event.data.call_id,
        name: event.data.name,
        args: event.data.args,
        status: toolStatus,
        summary: '',
        preview,
        ...(toolStatus === 'running' ? { startedAt: now } : {}),
      };
      return { ...appendBlock(finalized, block), toolStartTimes: times };
    }
    case 'tool_started': {
      const now = Date.now();
      const matched = findBlock(
        state,
        (b) => b.kind === 'tool_card' && b.callId === event.data.call_id,
      );
      if (matched?.kind === 'tool_card') {
        if (matched.status === 'running') return state;
        if (matched.status !== 'queued') return state;
        return {
          ...replaceBlockById(state, matched.id, {
            ...matched,
            status: 'running' as const,
            startedAt: now,
          }),
          toolStartTimes: { ...state.toolStartTimes, [event.data.call_id]: now },
        };
      }

      const location = findToolSummaryLocation(state, event.data.call_id);
      if (!location) return state;
      const { turnIndex, blockIndex, block: summary } = location;
      let changed = false;
      const tools = summary.tools.map((t) => {
        if (t.callId !== event.data.call_id || t.status !== 'queued') return t;
        changed = true;
        return { ...t, status: 'running' as const };
      });
      if (!changed) return state;
      const updatedSummary: OutputBlock = {
        ...summary,
        tools,
        active: summary.active,
        totalElapsedMs: summary.active ? now - summary.createdAt : summary.totalElapsedMs,
        summaryLine: buildToolSummaryLine(tools),
      };
      const turnsCopy = state.turns.map((t, ti) => {
        if (ti !== turnIndex) return t;
        return { blocks: t.blocks.map((b, bi) => (bi === blockIndex ? updatedSummary : b)) };
      });
      return {
        ...state,
        turns: turnsCopy,
        toolStartTimes: { ...state.toolStartTimes, [event.data.call_id]: now },
      };
    }
    case 'tool_done': {
      if (event.data.name === 'task') return state;
      const startedAt = state.toolStartTimes?.[event.data.call_id];
      const elapsedMs = startedAt ? Date.now() - startedAt : undefined;
      const { [event.data.call_id]: _, ...nextTimes } = state.toolStartTimes ?? {};

      // ── Exploration tool: update entry in tool_summary (only if it was pre-consolidated) ──
      // shell_execute without intent=inspect creates tool_card → won't be found here → falls through
      if (isExplorationToolByName(event.data.name)) {
        const blockId = state.explorationSummaryIds[event.data.call_id];
        const location = findToolSummaryLocation(state, event.data.call_id, blockId);
        if (location) {
          const { turnIndex, blockIndex, block: summary } = location;
          const tools = summary.tools.map((t) =>
            t.callId === event.data.call_id
              ? {
                  ...t,
                  ok: event.data.ok,
                  summary: event.data.summary,
                  elapsedMs,
                  totalLines: event.data.totalLines ?? t.totalLines,
                  status:
                    event.data.status === 'exhausted'
                      ? ('exhausted' as const)
                      : event.data.ok
                        ? ('done' as const)
                        : ('error' as const),
                  reviewFailure: event.data.reviewFailure ?? t.reviewFailure,
                }
              : t,
          );
          const totalElapsedMs = Date.now() - summary.createdAt;
          // 所有工具均 settled 时重新计算 result，修复 closeCurrentThought 提前
          // 关闭导致的 result='cancelled' 残留——后续 tool_done 到达后不再卡在 cancelled。
          // Recompute result when all tools are settled, fixing stale 'cancelled'
          // left by closeCurrentThought before late-arriving tool_done events.
          const allSettled = tools.every(
            (t) =>
              t.status !== 'queued' &&
              t.status !== 'running' &&
              (t.status === 'done' ||
                t.status === 'error' ||
                t.status === 'cancelled' ||
                t.status === 'timeout' ||
                t.status === 'exhausted'),
          );
          const hasError = tools.some(
            (t) => t.status === 'error' || t.status === 'timeout' || t.status === 'exhausted',
          );
          const updatedSummary: OutputBlock = {
            ...summary,
            tools,
            totalElapsedMs,
            summaryLine: buildToolSummaryLine(tools),
            ...(allSettled ? { result: hasError ? ('error' as const) : ('done' as const) } : {}),
          };
          const turnsCopy = state.turns.map((t, ti) => {
            if (ti !== turnIndex) return t;
            return { blocks: t.blocks.map((b, bi) => (bi === blockIndex ? updatedSummary : b)) };
          });
          let next = { ...state, turns: turnsCopy, toolStartTimes: nextTimes };
          if (event.data.toolTokenCount && event.data.toolTokenCount > 0) {
            next = {
              ...next,
              status: {
                ...state.status,
                totalTokens: state.status.totalTokens + event.data.toolTokenCount,
              },
            };
          }
          return next;
        }
        // Not found via map or in blocks — fall through to standard tool_card update
      }

      // ── Standard tool_card update (non-exploration tools + exploration tools not pre-consolidated) ──
      const matched = findBlock(
        state,
        (b) => b.kind === 'tool_card' && b.callId === event.data.call_id,
      );
      if (matched?.kind !== 'tool_card') {
        // Preflight block: tool was stopped before execution (fingerprint already exhausted).
        // No tool_card was created by a prior tool_call event — create one now so the
        // user sees the system intervention.  The status footer ("blocked") is sufficient;
        // no separate notification text block needed.
        if (event.data.status === 'exhausted') {
          const id = state.nextBlockId;
          const card: OutputBlock = {
            id,
            kind: 'tool_card',
            callId: event.data.call_id,
            name: event.data.name,
            args: {},
            status: 'exhausted' as const,
            summary: event.data.summary,
            expanded: true,
          };
          return {
            ...appendBlock(state, card),
            toolStartTimes: nextTimes,
          };
        }
        return { ...state, toolStartTimes: nextTimes };
      }
      // update_plan declined
      if (matched.name === 'update_plan' && !event.data.ok) {
        const declined: OutputBlock = { ...matched, status: 'done' as const, expanded: true };
        return { ...replaceBlockById(state, matched.id, declined), toolStartTimes: nextTimes };
      }

      // ask_user summary extraction
      let summaryText = event.data.summary;
      if (matched.name === 'ask_user') {
        try {
          const p = JSON.parse(summaryText);
          if (p && typeof p === 'object') {
            if (p.ok === false) {
              summaryText =
                (p.detail as string) ||
                (p.stderr as string) ||
                'ask_user failed: invalid arguments';
            } else {
              const answer = p.answer as string | undefined;
              const answers = p.answers as Record<string, string> | undefined;
              if (answers && Object.keys(answers).length > 0) {
                summaryText = Object.entries(answers)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join('\n');
              } else if (typeof answer === 'string') {
                summaryText = answer || '(no answer)';
              }
            }
          }
        } catch {
          /* not JSON, use raw summary */
        }
      }

      const cancelled = !event.data.ok && summaryText === 'Cancelled';
      const exhaustedStatus = event.data.status === 'exhausted';
      const timedOut =
        !event.data.ok &&
        matched.name === 'shell_execute' &&
        (event.data.exitCode === 124 || TIMEOUT_RE.test(summaryText));
      const timeoutMs =
        timedOut && typeof matched.args.timeout_ms === 'number'
          ? matched.args.timeout_ms
          : timedOut
            ? parseTimeoutMs(summaryText)
            : undefined;
      const displaySummary =
        timedOut && TIMEOUT_RE.test(summaryText) && matched.liveOutput
          ? matched.liveOutput
          : summaryText;
      // A reviewed write_plan already contains the full plan document from
      // plan.review_requested. Its final tool.finished event carries only a
      // machine-readable approval/revision payload; do not replace the plan
      // document with that JSON in either live rendering or replay.
      const preserveReviewedPlan =
        matched.name === 'write_plan' &&
        event.data.ok &&
        (state.status.plan !== null || state.status.pendingPlan !== null) &&
        matched.summary.trim().length > 0;
      const next: OutputBlock = {
        ...matched,
        status: exhaustedStatus
          ? ('exhausted' as const)
          : event.data.ok
            ? ('done' as const)
            : cancelled
              ? ('cancelled' as const)
              : timedOut
                ? ('timeout' as const)
                : ('error' as const),
        reviewFailure:
          event.data.reviewFailure ??
          ('reviewFailure' in matched ? matched.reviewFailure : undefined),
        userInput: event.data.userInput ?? matched.userInput,
        summary: preserveReviewedPlan ? matched.summary : displaySummary,
        elapsedMs: elapsedMs ?? matched.elapsedMs,
        detail: getToolDetail(matched.name, matched.args, event.data.totalLines),
        ...(timeoutMs != null ? { timeoutMs } : {}),
        expanded:
          exhaustedStatus ||
          !event.data.ok ||
          matched.name === 'shell_execute' ||
          matched.name === 'edit_file' ||
          matched.name === 'write_file' ||
          matched.name === 'write_plan' ||
          matched.name === 'update_plan' ||
          matched.name === 'ask_user',
      };

      const updated = replaceBlockById(state, matched.id, next);
      let result: TuiState = { ...updated, toolStartTimes: nextTimes };
      if (event.data.toolTokenCount && event.data.toolTokenCount > 0) {
        result = {
          ...result,
          status: {
            ...state.status,
            totalTokens: state.status.totalTokens + event.data.toolTokenCount,
          },
        };
      }

      // ── Flush pending tool_summary: when non-exploration tool completes, ensure preceding
      //     exploration tools get flushed (they may be trapped behind a non-exploration tool_card) ──
      const turn2 = lastTurn(result);
      if (turn2) {
        const consolidated = maybeConsolidateLastTurnBlocks(turn2.blocks, result.nextBlockId);
        const tCopy = result.turns.slice();
        tCopy[tCopy.length - 1] = { blocks: consolidated.blocks };
        result = { ...result, turns: tCopy, nextBlockId: consolidated.nextBlockId };
      }

      // Exhaustion is rendered by the tool_card itself (amber dot + status footer
      // "blocked (too many repeated failures)"), no separate notification needed.
      return result;
    }
    case 'state_change': {
      const d = event.data;
      const next = { ...state.status };
      let nextInteractionMode = state.interactionMode;
      if (d.phase) next.phase = d.phase;
      if (d.plan !== undefined) next.plan = d.plan;
      if (d.authorization) next.authorization = d.authorization.mode;
      if (d.interactionMode)
        nextInteractionMode = d.interactionMode as 'accept_edits' | 'auto' | 'full';
      if (d.workspaceAccess) next.workspaceAccess = d.workspaceAccess;
      if (d.modelProvider) next.modelProvider = d.modelProvider;
      if (d.modelName) next.modelName = d.modelName;
      return { ...state, status: next, interactionMode: nextInteractionMode };
    }
    case 'model_retry': {
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state));
      const id = finalized.nextBlockId;
      const maxAttempts = event.data.maxAttempts;
      const delayLabel =
        event.data.delayMs >= 1000
          ? `${(event.data.delayMs / 1000).toFixed(1)}s`
          : `${event.data.delayMs}ms`;
      const block: OutputBlock = {
        id,
        kind: 'text',
        content:
          maxAttempts > 0
            ? `⟳ Model retry #${event.data.attempt}/${maxAttempts} (${delayLabel}): ${event.data.error}`
            : `⟳ Model retry #${event.data.attempt} (${delayLabel}): ${event.data.error}`,
      };
      return {
        ...appendBlock(finalized, block),
        status: {
          ...finalized.status,
          retryState: {
            attempt: event.data.attempt,
            maxAttempts: maxAttempts,
            error: event.data.error,
            delayMs: event.data.delayMs,
          },
        },
      };
    }
    case 'step_begin': {
      return { ...state, status: { ...state.status, currentNode: event.data.node } };
    }
    case 'step_end': {
      return { ...state, status: { ...state.status, currentNode: null } };
    }
    case 'cache_metrics': {
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
    case 'final': {
      if (event.data.length === 0) return state;
      if (!/\S/u.test(event.data)) return state;
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state));
      const last = lastTurn(finalized);
      // Reconstruct full text from all per-line text blocks in this turn,
      // since with line-by-line output each block holds only one line.
      let fullText = '';
      let firstText = true;
      for (const b of last?.blocks ?? []) {
        if (b.kind !== 'text') continue;
        if (firstText) {
          fullText = b.content;
          firstText = false;
        } else fullText += `\n${b.content}`;
      }
      if (fullText === event.data) return finalized;
      // final 可能比最后一个 text 事件多几个字符 → 只追加增量，不创建全文 block 避免重复
      if (fullText.length > 0 && event.data.startsWith(fullText)) {
        const delta = event.data.slice(fullText.length);
        if (delta.length === 0 || !/\S/u.test(delta)) return finalized;
        const id = finalized.nextBlockId;
        const block: OutputBlock = { id, kind: 'text', content: delta };
        const appended = appendBlock(finalized, block);
        return mergeStructuralTextBlocks(appended);
      }
      // 无前置 text block（纯 tool 调用等）→ 创建全文 block
      if (fullText.length === 0) {
        const id = finalized.nextBlockId;
        const block: OutputBlock = { id, kind: 'text', content: event.data };
        const appended = appendBlock(finalized, block);
        return mergeStructuralTextBlocks(appended);
      }
      // final 内容与已渲染文本不一致 → 保留已有 block，不创建重复
      return finalized;
    }
    case 'need_approval': {
      // Dedup: side-channel + stream interrupt can both emit need_approval for the same request.
      if (state.interrupt?.kind === 'approval') return state;
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state));
      const block: OutputBlock = {
        id: finalized.nextBlockId,
        kind: 'approval',
        approval: event.data,
      };
      let next: TuiState = {
        ...appendBlock(finalized, block),
        interrupt: { kind: 'approval' as const, blockId: block.id },
      };
      if (event.data.reviewFailure) {
        const pendingTool = findBlock(
          next,
          (b) =>
            b.kind === 'tool_card' &&
            (b.status === 'queued' || b.status === 'running') &&
            (b.callId === event.data.callId || (!event.data.callId && b.name === event.data.tool)),
        );
        if (pendingTool?.kind === 'tool_card') {
          next = replaceBlockById(next, pendingTool.id, {
            ...pendingTool,
            reviewFailure: event.data.reviewFailure,
          });
        }
      }
      // 如果是子 agent 的工具需要审批，标记该子 agent 为等待审批状态
      if (event.data.subagentId) {
        next = {
          ...next,
          turns: next.turns.map((turn) => {
            let changed = false;
            const blocks = turn.blocks.map((blk) => {
              if (
                blk.kind === 'subagent' &&
                blk.subagentId === event.data.subagentId &&
                blk.status === 'running'
              ) {
                changed = true;
                const stepIndex = blk.steps.length - 1;
                const steps = blk.steps.map((s, i) =>
                  i === stepIndex ? { ...s, status: 'awaiting_approval' as const } : s,
                );
                return {
                  ...blk,
                  awaitingApproval: true,
                  approvingStepIndex: stepIndex,
                  steps,
                };
              }
              return blk;
            });
            return changed ? { ...turn, blocks } : turn;
          }),
        };
      }
      return next;
    }
    case 'need_input': {
      // Dedup: side-channel + stream interrupt can both emit need_input for the same request.
      // Skip if a question block is already active (interrupt pending).
      if (state.interrupt?.kind === 'input') return state;
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state));
      const block: OutputBlock = {
        id: finalized.nextBlockId,
        kind: 'question',
        question: event.data,
        toolCallId: event.toolCallId,
      };
      return { ...appendBlock(finalized, block), interrupt: { kind: 'input', blockId: block.id } };
    }
    case 'need_plan_review': {
      // Dedup: side-channel + stream interrupt can both emit need_plan_review for the same request.
      if (state.interrupt?.kind === 'plan_review') return state;
      // 方案内容在 OutputArea 以 Markdown tool_card 渲染，同时 Footer PlanReviewBlock
      // 展示确认操作条。填充 summary + expanded 以便 MarkdownBlock 展开渲染。
      // Plan content rendered in OutputArea as Markdown tool_card; Footer PlanReviewBlock
      // shows the confirmation bar. Populate summary + expanded for MarkdownBlock rendering.
      const planCard = findBlock(
        state,
        (b) =>
          b.kind === 'tool_card' &&
          (b.name === 'write_plan' || b.name === 'update_plan') &&
          (b.status === 'queued' || b.status === 'running'),
      );
      const plan = event.data.plan;
      const stepsText = (plan.steps ?? []).map((s, i) => `${i + 1}. ${s.step}`).join('\n');
      const planSummary = plan.description
        ? `${plan.description}\n\nSteps:\n${stepsText}`
        : `Steps:\n${stepsText}`;
      let next = closeCurrentThought(state);
      if (planCard?.kind === 'tool_card') {
        next = replaceBlockById(next, planCard.id, {
          ...planCard,
          status: 'done' as const,
          summary: planSummary,
          detail: getToolDetail(planCard.name, planCard.args),
          expanded: true,
        });
      }
      return {
        ...next,
        interrupt: {
          kind: 'plan_review',
          plan: event.data.plan,
          ...(event.data.artifact ? { artifact: event.data.artifact } : {}),
        },
        status: { ...next.status, pendingPlan: event.data.plan },
      };
    }
    case 'error': {
      // 错误打断当前思考周期——恢复/重试后模型从头开始推理，不应延续旧 Thought。
      // An error breaks the current thinking cycle — recovery/retry starts fresh,
      // so the old Thought must close to avoid incorrect elapsed time accumulation.
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state));
      const prefix = event.data.recoverable ? '⟳ Recoverable error' : 'Error';
      const id = finalized.nextBlockId;
      const block: OutputBlock = {
        id,
        kind: 'text',
        content: `${prefix}: ${event.data.message}`,
        isError: !event.data.recoverable,
      };
      return { ...appendBlock(finalized, block), sessionError: !event.data.recoverable };
    }
    case 'file_change': {
      const change: FileChangeRecord = {
        path: event.data.path,
        kind: event.data.kind,
        linesAdded: event.data.linesAdded,
        linesRemoved: event.data.linesRemoved,
        preview: formatFilePreview(event.data.preview),
      };
      const last = lastTurn(state);
      const lastBlock = last?.blocks.at(-1);
      if (lastBlock?.kind === 'file_change') {
        return updateLastBlock(state, { ...lastBlock, changes: [...lastBlock.changes, change] });
      }
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = { id, kind: 'file_change', changes: [change] };
      return appendBlock(finalized, block);
    }
    case 'subagent_start': {
      if (hasBlock(state, (b) => b.kind === 'subagent' && b.subagentId === event.data.id))
        return state;
      const finalized = finalizeLastTurnStreaming(state);
      const id = finalized.nextBlockId;
      const block: OutputBlock = {
        id,
        kind: 'subagent',
        subagentId: event.data.id,
        role: event.data.role,
        task: event.data.task,
        status: 'running',
        summary: '',
        toolCallCount: 0,
        durationMs: 0,
        steps: [],
        startedAt: Date.now(),
      };
      return appendBlock(finalized, block);
    }
    case 'subagent_step': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      const next: OutputBlock = {
        ...matched,
        steps: [
          ...matched.steps,
          {
            toolName: event.data.toolName,
            toolArgs: event.data.toolArgs,
            status: 'pending' as const,
          },
        ],
        awaitingApproval: false, // 新步骤到来时清除等待状态
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_tool_result': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      // Reverse-scan unresolved steps by status (not ok boolean).
      // pending / awaiting_approval → unresolved; success / rejected / error → resolved.
      let lastMatchIdx = -1;
      for (let i = matched.steps.length - 1; i >= 0; i--) {
        if (
          matched.steps[i]!.toolName === event.data.toolName &&
          (matched.steps[i]!.status === 'pending' ||
            matched.steps[i]!.status === 'awaiting_approval')
        ) {
          lastMatchIdx = i;
          break;
        }
      }
      // Fallback: old data without status field → match by ok===undefined (unresolved)
      if (lastMatchIdx === -1) {
        for (let i = matched.steps.length - 1; i >= 0; i--) {
          if (
            matched.steps[i]!.toolName === event.data.toolName &&
            matched.steps[i]!.ok === undefined
          ) {
            lastMatchIdx = i;
            break;
          }
        }
      }
      // Absolute fallback: all steps have ok set already, re-resolve the last one
      if (lastMatchIdx === -1) {
        for (let i = matched.steps.length - 1; i >= 0; i--) {
          if (matched.steps[i]!.toolName === event.data.toolName) {
            lastMatchIdx = i;
            break;
          }
        }
      }
      if (lastMatchIdx === -1) return state;
      // Compute step status from result + approval context.
      // A rejected approval produces status:'rejected', not status:'error'.
      const isApprovalRejected =
        matched.approvingStepIndex === lastMatchIdx && event.data.ok === false;
      const stepStatus: 'rejected' | 'success' | 'error' = isApprovalRejected
        ? 'rejected'
        : event.data.ok
          ? 'success'
          : 'error';
      const steps = matched.steps.map((s, i) => {
        if (i !== lastMatchIdx) return s;
        return { ...s, status: stepStatus, ok: event.data.ok, totalLines: event.data.totalLines };
      });
      if (steps.every((s, i) => s === matched.steps[i]!)) return state;
      const next: OutputBlock = {
        ...matched,
        steps,
        awaitingApproval: false,
        approvingStepIndex: undefined,
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_done': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      const next: OutputBlock = {
        ...matched,
        status: 'done' as const,
        summary: event.data.summary,
        toolCallCount: event.data.toolCallCount,
        durationMs: event.data.durationMs,
        expanded: false,
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_error': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      const summary = event.data.summary ?? event.data.error;
      const cancelled = summary === 'Cancelled';
      const next: OutputBlock = {
        ...matched,
        status: cancelled ? ('cancelled' as const) : ('error' as const),
        summary,
        error: summary || undefined,
        toolCallCount: event.data.toolCallCount ?? matched.toolCallCount,
        durationMs: event.data.durationMs ?? matched.durationMs,
        expanded: false,
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_cache_metrics': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.subagentId,
      );
      if (matched?.kind !== 'subagent') return state;
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
    case 'tool_progress': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'tool_card' && b.callId === event.data.call_id,
      );
      if (matched?.kind !== 'tool_card' || matched.status !== 'running') return state;

      const prev = matched.liveOutput ?? '';
      const line = event.data.chunk;
      const next = prev ? `${prev}\n${line}` : line;

      // Tail-follow：固定窗口，保留最近 N 行（与 ToolCardBlock.MAX_TOOL_LINES 一致）
      const lines = next.split('\n');
      const capped = lines.length > MAX_TOOL_LINES ? lines.slice(-MAX_TOOL_LINES).join('\n') : next;

      // 累计总行数：基于上一次的 total + 新行数（非完整行不计数）
      const prevTotal = matched.liveTotalLines ?? 0;
      const prevLineCount = prev ? prev.split('\n').length : 0;
      const newCompleteLines = lines.length - prevLineCount;

      return replaceBlockById(state, matched.id, {
        ...matched,
        liveOutput: capped,
        liveTotalLines: prevTotal + Math.max(0, newCompleteLines),
      });
    }
    // Raw passthrough events — intentionally no-op for UI consumers
    case 'interrupt':
    case 'update':
      return state;
    case 'turn_begin':
      // Informational — turn boundary marker, no UI state change needed
      return state;
    case 'turn_end':
      // Informational — turn boundary marker, no UI state change needed
      return state;
    case 'user_message':
      // Informational — user message already rendered via other mechanisms
      return state;
    default:
      return state;
  }
}

/** Shared RuntimeEvent rendering path for live updates and session replay. */
export function handleRuntimeEventAction(state: TuiState, event: RuntimeEvent): TuiState {
  switch (event.type) {
    case 'subagent.started':
      return handleEventAction(state, { type: 'subagent_start', data: event.subagent });
    case 'subagent.step':
      return handleEventAction(state, { type: 'subagent_step', data: event.subagent });
    case 'subagent.tool_result':
      return handleEventAction(state, { type: 'subagent_tool_result', data: event.subagent });
    case 'subagent.completed':
      return handleEventAction(state, { type: 'subagent_done', data: event.subagent });
    case 'subagent.failed':
      return handleEventAction(state, { type: 'subagent_error', data: event.subagent });
    case 'subagent.cache_metrics':
      return handleEventAction(state, { type: 'subagent_cache_metrics', data: event.subagent });
    case 'user.message_appended':
      return appendBlock(state, {
        id: state.nextBlockId,
        kind: 'user',
        content: event.content.replace(/^User:\s*/, ''),
      });
    case 'model.responded': {
      let next = state;
      if (event.reasoningText)
        next = handleEventAction(next, { type: 'reason', data: { text: event.reasoningText } });
      if (event.text) next = handleEventAction(next, { type: 'text', data: { text: event.text } });
      return next;
    }
    case 'model.retry':
      return handleEventAction(state, {
        type: 'model_retry',
        data: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          error: event.error,
          delayMs: event.delayMs,
        },
      });
    case 'model.cache_metrics':
      return handleEventAction(state, {
        type: 'cache_metrics',
        data: {
          workspaceAccess: 'write' as const,
          inputTokens: event.inputTokens,
          cacheHitTokens: event.cacheHitTokens,
          cacheMissTokens: event.cacheMissTokens,
          hitRate: event.hitRate,
          standard: {
            callIndex: 1,
            isWarmup: false,
            includedInStandard: false,
            targetHitRate: 0.8,
            minimumMeasuredInputTokens: 0,
            summary: {
              inputTokens: event.inputTokens,
              cacheHitTokens: event.cacheHitTokens,
              cacheMissTokens: event.cacheMissTokens,
              hitRate: event.hitRate,
              totalCalls: 1,
              warmupCalls: 0,
              measuredCalls: 0,
              targetHitRate: 0.8,
              minimumMeasuredInputTokens: 0,
              hasEnoughMeasuredTokens: false,
              meetsTarget: null,
            },
          },
        },
      });
    case 'run.error':
      return handleEventAction(state, {
        type: 'error',
        data: { message: event.message, recoverable: event.recoverable },
      });
    case 'tool.queued':
      return handleEventAction(state, {
        type: 'tool_call',
        data: {
          call_id: event.toolCallId,
          name: event.name,
          args: event.args as Record<string, unknown>,
          status: 'queued',
        },
      });
    case 'tool.started':
      return handleEventAction(state, {
        type: 'tool_started',
        data: { call_id: event.toolCallId },
      });
    case 'tool.progress':
      return handleEventAction(state, {
        type: 'tool_progress',
        data: { call_id: event.toolCallId, name: '', chunk: event.chunk, stream: event.stream },
      });
    case 'tool.finished':
      return handleEventAction(state, {
        type: 'tool_done',
        data: {
          call_id: event.toolCallId,
          name: event.name,
          ok: event.result.ok,
          summary: formatToolResultForDisplay(event.name, event.result.stdout, event.result.stderr),
          exitCode: event.result.exitCode,
          status: event.result.status,
          userInput: event.result.userInput,
        },
      });
    case 'tool.failed':
      return handleEventAction(state, {
        type: 'tool_done',
        data: {
          call_id: event.toolCallId,
          name: '',
          ok: false,
          summary: event.failure?.message ?? event.error ?? 'Tool failed.',
        },
      });
    case 'tool.rejected':
      return handleEventAction(state, {
        type: 'tool_done',
        data: { call_id: event.toolCallId, name: '', ok: false, summary: event.reason },
      });
    case 'tool.file_change':
      return handleEventAction(state, {
        type: 'file_change',
        data: {
          path: event.path,
          kind: event.kind,
          linesAdded: event.linesAdded,
          linesRemoved: event.linesRemoved,
          preview: event.preview,
        },
      });
    case 'user_input.requested':
      return handleEventAction(state, {
        type: 'need_input',
        data: event.request,
        toolCallId: event.toolCallId,
      });
    case 'approval.requested':
      return handleEventAction(state, { type: 'need_approval', data: event.approval });
    case 'planning.entered':
      return { ...state, status: { ...state.status, phase: 'planning' } };
    case 'plan.review_requested':
      return handleEventAction(state, {
        type: 'need_plan_review',
        data: { plan: event.plan, ...(event.artifact ? { artifact: event.artifact } : {}) },
      });
    case 'plan.approved':
      return {
        ...state,
        status: {
          ...state.status,
          phase: 'building',
          // Replay has no separate RESOLVE_PLAN_REVIEW UI action. Promote the
          // pending plan here so replay and live rendering share the same
          // update_plan visibility rule.
          plan: state.status.pendingPlan ?? state.status.plan,
          pendingPlan: null,
        },
      };
    case 'plan.progress_updated':
    case 'plan.completed':
      return {
        ...state,
        status: { ...state.status, plan: event.plan },
      };
    case 'plan.revision_requested':
      return {
        ...state,
        interrupt: null,
        status: {
          ...state.status,
          pendingPlan: state.status.plan, // keep current plan for revision display
        },
      };
    case 'plan.review_cancelled':
      return {
        ...state,
        interrupt: null,
        status: { ...state.status, pendingPlan: null },
      };
    case 'plan.rejected':
      return {
        ...state,
        status: { ...state.status, pendingPlan: null },
      };
    case 'task.completed':
      return { ...state, status: { ...state.status, phase: 'building' } };
    case 'task.cancelled':
      return { ...state, status: { ...state.status, phase: 'building', pendingPlan: null } };
    default:
      return state;
  }
}
