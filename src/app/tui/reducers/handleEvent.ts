// ── EVENT action handler — 19 event sub-types ──

import type { AgentEvent } from '@/protocol/events';
import { getToolDetail, getToolPreview } from '../components/render-utils';
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

// ── Structural text block helpers ──
// During streaming, text events are split into per-line blocks for progressive
// rendering. But structural markdown elements (tables, code blocks) need
// multi-line context — MarkdownBlock.groupLines() requires seeing header+sep,
// or opening+closing fences, within a single block. These helpers detect
// structural elements and merge their per-line blocks back together.

// ── Table detection ──

const TABLE_PIPE = /[|│]/;

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
    return {
      ...block,
      active: false,
      latestActivity: undefined,
      totalElapsedMs: Date.now() - block.createdAt,
    };
  });
  return { ...next, currentThoughtSummaryId: undefined };
}

function updateCurrentThoughtActivity(
  state: TuiState,
  latestActivity: Extract<OutputBlock, { kind: 'tool_summary' }>['latestActivity'],
): TuiState {
  const summary = findThoughtSummary(state, state.currentThoughtSummaryId);
  if (summary?.active) {
    return updateToolSummaryById(state, summary.id, (block) => ({
      ...block,
      active: true,
      latestActivity,
    }));
  }

  const id = state.nextBlockId;
  const block: OutputBlock = {
    id,
    kind: 'tool_summary',
    tools: [],
    totalElapsedMs: 0,
    createdAt: Date.now(),
    summaryLine: 'thinking',
    active: true,
    latestActivity,
  };
  return {
    ...appendBlock(state, block),
    currentThoughtSummaryId: id,
  };
}

export function handleEventAction(state: TuiState, event: AgentEvent): TuiState {
  // Guard: malformed events from corrupted checkpoints must not crash the TUI
  if (!event.data) return state;

  // 非 reason 事件清除 currentRunReasonId，让下一个 reason 创建新块。
  // 避免中间隔了工具调用后两个 reason 块被合并。
  // Auto-clear currentRunReasonId on any non-reason event,
  // so the next reason creates a new block instead of appending.
  if (event.type !== 'reason' && state.currentRunReasonId !== undefined) {
    const reasonBlock = findBlockById(state, state.currentRunReasonId);
    if (reasonBlock?.kind === 'reason' && reasonBlock.folded) {
      state = replaceBlockById(state, state.currentRunReasonId, { ...reasonBlock, folded: false });
    }
    state = { ...state, currentRunReasonId: undefined };
  }

  switch (event.type) {
    case 'text': {
      if (!/\S/u.test(event.data.text)) return state;
      state = closeCurrentThought(state);
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
      const times = { ...finalized.toolStartTimes, [event.data.call_id]: now };

      // ── Pre-consolidation: exploration tools go directly to tool_summary, never as tool_card ──
      if (isExploration) {
        const entry: ConsolidatedToolEntry = {
          callId: event.data.call_id,
          name: event.data.name,
          args: event.data.args,
          ok: false,
          summary: '',
          status: 'running',
          totalLines:
            typeof event.data.args?.totalLines === 'number'
              ? event.data.args.totalLines
              : undefined,
        };
        const currentThought = findThoughtSummary(finalized, finalized.currentThoughtSummaryId);

        if (currentThought?.active) {
          const tools = [...currentThought.tools, entry];
          const latestActivity =
            currentThought.latestActivity?.kind === 'thinking'
              ? currentThought.latestActivity
              : ({ kind: 'tool', callId: event.data.call_id } as const);
          const updated: Extract<OutputBlock, { kind: 'tool_summary' }> = {
            ...currentThought,
            tools,
            summaryLine: buildToolSummaryLine(tools),
            active: true,
            latestActivity,
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

        // 创建新 tool_summary
        const id = finalized.nextBlockId;
        const block: OutputBlock = {
          id,
          kind: 'tool_summary',
          tools: [entry],
          totalElapsedMs: 0,
          createdAt: now,
          summaryLine: buildToolSummaryLine([entry]),
          active: true,
          latestActivity: { kind: 'tool', callId: event.data.call_id },
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
        status: 'running',
        summary: '',
        preview,
        startedAt: now,
      };
      return { ...appendBlock(finalized, block), toolStartTimes: times };
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
                  status: event.data.ok ? ('done' as const) : ('error' as const),
                }
              : t,
          );
          const totalElapsedMs = Date.now() - summary.createdAt;
          const updatedSummary: OutputBlock = {
            ...summary,
            tools,
            totalElapsedMs,
            summaryLine: buildToolSummaryLine(tools),
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
      if (matched?.kind !== 'tool_card') return { ...state, toolStartTimes: nextTimes };

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
      const next: OutputBlock = {
        ...matched,
        status: event.data.ok
          ? ('done' as const)
          : cancelled
            ? ('cancelled' as const)
            : ('error' as const),
        summary: summaryText,
        elapsedMs: elapsedMs ?? matched.elapsedMs,
        detail: getToolDetail(matched.name, matched.args, event.data.totalLines),
        expanded:
          !event.data.ok ||
          matched.name === 'shell_execute' ||
          matched.name === 'edit_file' ||
          matched.name === 'write_file' ||
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

      return result;
    }
    case 'state_change': {
      const d = event.data;
      const next = { ...state.status };
      if (d.phase) next.phase = d.phase;
      if (d.plan !== undefined) next.plan = d.plan;
      if (d.authorization) next.authorization = d.authorization.mode;
      if (d.workspaceAccess) next.workspaceAccess = d.workspaceAccess;
      if (d.modelProvider) next.modelProvider = d.modelProvider;
      if (d.modelName) next.modelName = d.modelName;
      return { ...state, status: next };
    }
    case 'model_retry': {
      const finalized = finalizeLastTurnStreaming(state);
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
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state));
      const block: OutputBlock = {
        id: finalized.nextBlockId,
        kind: 'approval',
        approval: event.data,
      };
      return {
        ...appendBlock(finalized, block),
        interrupt: { kind: 'approval', blockId: block.id },
      };
    }
    case 'need_input': {
      const finalized = finalizeLastTurnStreaming(closeCurrentThought(state));
      const block: OutputBlock = {
        id: finalized.nextBlockId,
        kind: 'question',
        question: event.data,
      };
      return { ...appendBlock(finalized, block), interrupt: { kind: 'input', blockId: block.id } };
    }
    case 'need_plan_review': {
      // 方案内容在 OutputArea 以 Markdown tool_card 渲染，同时 Footer PlanReviewBlock
      // 展示确认操作条。填充 summary + expanded 以便 MarkdownBlock 展开渲染。
      // Plan content rendered in OutputArea as Markdown tool_card; Footer PlanReviewBlock
      // shows the confirmation bar. Populate summary + expanded for MarkdownBlock rendering.
      const planCard = findBlock(
        state,
        (b) => b.kind === 'tool_card' && b.name === 'update_plan' && b.status === 'running',
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
        interrupt: { kind: 'plan_review', plan: event.data.plan },
        status: { ...next.status, pendingPlan: event.data.plan },
      };
    }
    case 'error': {
      const finalized = finalizeLastTurnStreaming(state);
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
        steps: [...matched.steps, { toolName: event.data.toolName, toolArgs: event.data.toolArgs }],
      };
      return replaceBlockById(state, matched.id, next);
    }
    case 'subagent_tool_result': {
      const matched = findBlock(
        state,
        (b) => b.kind === 'subagent' && b.subagentId === event.data.id,
      );
      if (matched?.kind !== 'subagent') return state;
      // Reverse-scan to find the last UNRESOLVED step with matching toolName.
      // Prefer unresolved steps to handle out-of-order results correctly:
      // e.g., two read_file steps — first result resolves the last unresolved one,
      // second result resolves the remaining one.
      let lastMatchIdx = -1;
      for (let i = matched.steps.length - 1; i >= 0; i--) {
        if (
          matched.steps[i]!.toolName === event.data.toolName &&
          matched.steps[i]!.ok === undefined
        ) {
          lastMatchIdx = i;
          break;
        }
      }
      // Fallback: if all matching steps already have ok, re-resolve the last one
      if (lastMatchIdx === -1) {
        for (let i = matched.steps.length - 1; i >= 0; i--) {
          if (matched.steps[i]!.toolName === event.data.toolName) {
            lastMatchIdx = i;
            break;
          }
        }
      }
      if (lastMatchIdx === -1) return state;
      const steps = matched.steps.map((s, i) =>
        i === lastMatchIdx ? { ...s, ok: event.data.ok, totalLines: event.data.totalLines } : s,
      );
      if (steps.every((s, i) => s === matched.steps[i]!)) return state;
      const next: OutputBlock = { ...matched, steps };
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
    default:
      return state;
  }
}
