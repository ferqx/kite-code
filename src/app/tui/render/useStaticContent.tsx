// ── Static content computation hook ──
// Only truly immutable blocks go to <Static>. Blocks with mutable state
// (tool_card running→done, subagent running→done, streaming text, etc.)
// stay in the dynamic tree until they become immutable.
//
// Screen transitions (resize, session switch) use DEC synchronized output
// (\x1B[?2026h/l) to buffer the full re-render and display it atomically.
// The enable + clear sequence runs synchronously during the React render
// phase (before Ink commits output), so ALL TUI rendering — Static,
// dynamic tree, header, footer — is captured in the buffer.
//
// ═══════════════════════════════════════════════════════════════════════
// REFERENCE STABILITY (2026-06-17 fix)
// ═══════════════════════════════════════════════════════════════════════
// The reducer returns a new `turns` array on every dispatch. All downstream
// useMemo calls that depend on turns/settledTurns/activeTurn recompute on
// EVERY render, producing new array references for staticItems, mergedStaticBlocks,
// and activeDynamicBlocks — even when nothing changed but a subagent timer tick.
//
// This cascade defeats React.memo (BlockRenderer sees new prevBlock every render),
// forces Ink to diff identical output strings, and in edge cases causes Ink's
// log-update cursor tracking to write dynamic content at stale Y positions,
// producing duplicate lines.
//
// Fix: compute a "fingerprint" of block identity+state and only update refs
// when the fingerprint changes. All downstream values are derived from these
// stable refs, so references are constant between genuine state transitions.

import { type ReactNode, useEffect, useMemo, useRef } from 'react';
import { isExplorationTool } from '../reducers/consolidateTools';
import type { OutputBlock, Turn } from '../types';

export { changePrefix } from '../components/BlockRenderer';
export { toolColor } from '../components/render-utils';

/** Sentinel: ensures <Static> always has ≥1 item so Header renders even with no completed blocks */
const HEADER_SENTINEL = { __header: true } as const;

/**
 * 判定运行中（activeTurn）的 block 是否已绝对不可变，可以提前进入 Ink <Static>。
 *
 * Ink <Static> 是 append-only 的（items.slice(index) 只渲染新增项，已渲染项内容
 * 变化不会被更新）。因此只有保证 reducer 后续事件绝不再修改的 block 才能离开
 * 动态树。判定故意保守——宁可多留在动态树，也不允许 Static 中出现陈旧行。
 *
 * - user：永不修改。
 * - text：只有流式 / 待终态调和 / 仍持有活动结构组件 source 的块不稳定。
 *   Runtime delta 路径只把完整 Markdown 组件追加为新的 text block；已经提交的
 *   相邻 text 是 append-only 前缀，必须立即冻结，否则长回答会整体滞留在 Ink
 *   dynamic tree，并让每帧布局与终端输出成本随全文长度增长。
 * - tool_card：只有终态（done/error/cancelled/timeout/exhausted）稳定；探索工具
 *   仍可能被 maybeConsolidateLastTurnBlocks 合并为 tool_summary，必须留在动态树。
 * - 其余 kind（tool_summary / subagent / approval / question / reason）在 run 期间
 *   仍可能被后续事件修改（consolidate 重建、cache_metrics 迟到、resolved 回写、
 *   folded toggle 等），保守地留在动态树。
 */
export function isBlockSettledInRun(
  block: OutputBlock,
  _blocks: OutputBlock[],
  _index: number,
): boolean {
  switch (block.kind) {
    case 'user':
      return true;
    case 'text': {
      if (
        block.streaming ||
        block.responsePending ||
        block.streamingSource != null ||
        block.streamingComponent != null
      ) {
        return false;
      }
      return true;
    }
    case 'tool_card': {
      if (
        block.status !== 'done' &&
        block.status !== 'error' &&
        block.status !== 'cancelled' &&
        block.status !== 'timeout' &&
        block.status !== 'exhausted'
      ) {
        return false;
      }
      return !isExplorationTool(block);
    }
    case 'tool_summary':
      return (
        !block.active &&
        !block.responsePending &&
        block.tools.every(
          (tool) =>
            tool.status === 'done' ||
            tool.status === 'error' ||
            tool.status === 'cancelled' ||
            tool.status === 'timeout' ||
            tool.status === 'exhausted',
        )
      );
    case 'reason':
    case 'file_change':
      return true;
    case 'subagent':
      return block.status === 'done' || block.status === 'error' || block.status === 'cancelled';
    case 'approval':
    case 'question':
      return block.resolved !== undefined;
    default:
      return false;
  }
}

/**
 * Stable fingerprint of a block's identity and mutable state.
 * Only changes when the block's visual output actually changes.
 * This is the single source of truth for cache invalidation.
 */
export function blockFingerprint(b: OutputBlock): string {
  let extra = '';
  switch (b.kind) {
    case 'text':
      extra =
        (b.streaming ? `:s:${b.content.length}` : b.responsePending ? ':pending' : ':f') +
        (b.thoughtElapsedMs != null ? `:th${b.thoughtElapsedMs}` : '') +
        (b.thoughtContent ? `:tc${b.thoughtContent.length}:${b.thoughtContent.slice(-16)}` : '');
      break;
    case 'tool_card':
      // liveOutput 头尾各 8 字符 + totalLines 做指纹：窗口滑动 → 头部变；新增行 → 尾部变 / 计数变
      extra =
        `:${b.status}` +
        (b.liveOutput
          ? `:lo${b.liveOutput.length}:${b.liveOutput.slice(0, 8)}:${b.liveOutput.slice(-8)}:t${b.liveTotalLines ?? 0}`
          : '');
      break;
    case 'tool_summary':
      // Every tool status change must trigger a split recomputation
      extra =
        `:${b.active ? 'a' : b.responsePending ? 'pending' : 's'}:${b.tools.length}:${b.tools.map((t) => t.status[0]).join('')}:${b.totalElapsedMs}:${b.result ?? '_'}` +
        (b.latestActivity
          ? b.latestActivity.kind === 'thinking'
            ? `:th:${b.latestActivity.text.length}:${b.latestActivity.text.slice(-16)}`
            : `:tc:${b.latestActivity.callId}`
          : '') +
        // ADR-0030 旁白字幕变化同样触发重算 / caption changes invalidate too
        (b.captions?.length ? `:cap${b.captions.length}:${b.captions.join('|').length}` : '') +
        (b.pendingCaption != null ? `:pc${b.pendingCaption.length}` : '');
      break;
    case 'subagent':
      extra =
        `:${b.status}:${b.steps.length}:${b.steps.map((s) => s.status?.[0] ?? '_').join('')}` +
        (b.awaitingApproval ? ':wait' : '');
      break;
    case 'approval':
    case 'question':
      extra = b.resolved !== undefined ? ':resolved' : ':pending';
      break;
  }
  return `${b.id}:${b.kind}${extra}`;
}

/** Element-by-element reference identity comparison. */
function blocksIdentical(a: OutputBlock[], b: OutputBlock[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export interface StaticContentResult {
  /** Static items array for the <Static> component */
  staticItems: (typeof HEADER_SENTINEL | OutputBlock)[];
  /** Static key for Ink's <Static> cache invalidation */
  staticKey: string;
  /** Header element rendered as the first Static item */
  header: ReactNode;
  /** Static blocks from turns older than the live tail. */
  mergedStaticBlocks: OutputBlock[];
  /** Blocks kept in the dynamic tree (may still mutate) */
  activeDynamicBlocks: OutputBlock[];
}

export interface UseStaticContentOptions {
  turns: Turn[];
  running: boolean;
  sessionKey?: number;
  header: ReactNode;
  /** > 0 时表示 resize 重挂载，开启同步输出缓冲消除闪烁 / When > 0, resize remount detected, enables sync output to eliminate flicker */
  resizeGeneration?: number;
}

export function useStaticContent({
  turns,
  running,
  sessionKey,
  header,
  resizeGeneration,
}: UseStaticContentOptions): StaticContentResult {
  // ── Session / resize lifecycle ──
  const prevSessionKeyRef = useRef<number | undefined>(undefined);
  const syncOutputRef = useRef(false);
  // 会话重挂载后历史（含最后 turn）整体进 Static；新 run 开始时恢复活跃尾。
  // After a session remount the whole history (including the last turn) is
  // immutable; a new run (SET_RUNNING) restores the live-tail split.
  const prevRunningRef = useRef(running);
  const allSettledRef = useRef(false);

  const needsClear = sessionKey !== prevSessionKeyRef.current;
  const isResize = (resizeGeneration ?? 0) > 0;
  const isInitialMount = prevSessionKeyRef.current === undefined;

  if (needsClear) {
    prevSessionKeyRef.current = sessionKey;

    // Session switch / remount with an idle session: promote the ENTIRE
    // conversation (including the last turn) to <Static>. The screen was
    // cleared below, so this cannot duplicate Windows scrollback frames the
    // way a live model.responded promotion would. Keeping the last turn
    // dynamic here would leave the whole history in the dynamic tree and
    // re-render it on every keystroke. A session that is still running keeps
    // its live tail dynamic so streamed content stays updateable.
    allSettledRef.current = !running;

    if (isResize || !isInitialMount) {
      // Resize / session switch: scroll to bottom, enable sync, clear.
      // \x1B[9999H forces viewport to bottom before sync freezes it.
      // eslint-disable-next-line no-restricted-properties
      process.stdout.write('\x1B[9999H\x1B[?2026h\x1B[H\x1B[2J\x1B[3J');
      syncOutputRef.current = true;
    } else {
      // Initial mount: clear only, no sync (content appears naturally).
      // eslint-disable-next-line no-restricted-properties
      process.stdout.write('\x1B[2J\x1B[3J\x1B[H');
    }
  }

  // A new run (SET_RUNNING fires before USER_MESSAGE in the same tick) ends
  // the remount all-settled window: the freshly appended user turn becomes the
  // live tail and older turns remain immutable.
  if (running && !prevRunningRef.current) {
    allSettledRef.current = false;
  }
  prevRunningRef.current = running;

  // ── Stable-history / live-tail split ──
  // Keep the latest turn dynamic while a run is live or while it remains the
  // latest turn after an idle run. Promoting it to Ink <Static> in the same
  // terminal frame as model.responded/SET_EXITED leaves earlier dynamic frames
  // in Windows scrollback and visibly duplicates the terminal answer. The turn
  // becomes immutable history when a newer user turn is appended or the
  // session is remounted (handled above via allSettledRef).
  const allSettled = allSettledRef.current;
  const settledTurns = allSettled ? turns : turns.slice(0, -1);
  const activeTurn = allSettled ? undefined : turns.at(-1);

  // Disable synchronized output after the first render commits.
  useEffect(() => {
    if (syncOutputRef.current) {
      syncOutputRef.current = false;
      // eslint-disable-next-line no-restricted-properties
      process.stdout.write('\x1B[?2026l');
    }
    return () => {
      if (syncOutputRef.current) {
        syncOutputRef.current = false;
        // eslint-disable-next-line no-restricted-properties
        process.stdout.write('\x1B[?2026l');
      }
    };
  });

  // ═══════════════════════════════════════════════════════════════════
  // STABLE CACHE LAYER
  //
  // All derived values (staticBlocks, activeSettledBlocks, activeDynamicBlocks,
  // mergedStaticBlocks, staticItems) MUST have stable references between
  // renders when the underlying content hasn't changed.
  //
  // We use refs + fingerprints instead of useMemo because useMemo's dependency
  // comparison is reference-based (Object.is), and the reducer always produces
  // new turns/settledTurns/activeTurn references on every dispatch.
  // ═══════════════════════════════════════════════════════════════════

  // ── Settled turn blocks: cache by fingerprint ──
  // When running flips from true to false, the active turn moves into
  // settled turns. If a block inside it later changes state (e.g. running
  // sub-agent receives subagent_error, tool_card receives tool_done), the
  // count stays the same but the content differs. Fingerprint catches this.
  const prevSettledFpRef = useRef('');
  const staticBlocksRef = useRef<OutputBlock[]>([]);

  const settledFp = settledTurns.map((t) => t.blocks.map(blockFingerprint).join(',')).join('|');

  if (settledFp !== prevSettledFpRef.current) {
    prevSettledFpRef.current = settledFp;
    staticBlocksRef.current = settledTurns.flatMap((t) => t.blocks);
  }

  // ── Active turn dynamic cache: cache by fingerprint ──
  // The fingerprint captures block identity, kind, status, and step count —
  // everything that affects the active turn visual output.
  const prevFingerprintRef = useRef('');
  const activeSettledRef = useRef<OutputBlock[]>([]);
  const activeDynamicRef = useRef<OutputBlock[]>([]);

  let fingerprint = '';
  if (activeTurn) {
    fingerprint = activeTurn.blocks.map(blockFingerprint).join(',');
  }

  if (fingerprint !== prevFingerprintRef.current) {
    prevFingerprintRef.current = fingerprint;

    let nextSettled: OutputBlock[];
    let nextDynamic: OutputBlock[];

    if (activeTurn && activeTurn.blocks.length > 0) {
      // 运行中就把已完成（绝对不可变）的连续前缀提升进 <Static>，只把活跃
      // 后缀留在动态树。Ink <Static> 是 append-only 的（items.slice(index) 只
      // 渲染新增项），所以只有 isBlockSettledInRun 判定的、后续事件绝不再
      // 修改的 block 才能离开动态树；一旦遇到第一个仍可变的块，其后的块
      // 全部留在动态树（保证 Static→动态的渲染顺序）。
      const blocks = activeTurn.blocks;
      let split = 0;
      while (split < blocks.length && isBlockSettledInRun(blocks[split]!, blocks, split)) {
        split++;
      }
      nextSettled = blocks.slice(0, split);
      nextDynamic = blocks.slice(split);
    } else {
      nextSettled = [];
      nextDynamic = [];
    }

    // Only update refs when arrays actually differ by element identity.
    // This prevents downstream useMemo churn when a block in the dynamic
    // group changes state (e.g. C running→done) but the settled group is
    // unchanged — mergedStaticBlocks stays reference-stable, <Static> skips
    // the diff entirely, and OutputArea only re-renders for genuinely new data.
    if (!blocksIdentical(activeSettledRef.current, nextSettled)) {
      activeSettledRef.current = nextSettled;
    }
    if (!blocksIdentical(activeDynamicRef.current, nextDynamic)) {
      activeDynamicRef.current = nextDynamic;
    }
  }

  // ── Derived values with stable references ──
  // These useMemos depend on the ref values. Since we only update the refs
  // when content actually changes, the useMemo dependencies are stable
  // between renders, preventing unnecessary recomputation.
  const staticBlocks = staticBlocksRef.current;
  const activeSettledBlocks = activeSettledRef.current;
  const activeDynamicBlocks = activeDynamicRef.current;

  const mergedStaticBlocks = useMemo(
    () => [...staticBlocks, ...activeSettledBlocks],
    [staticBlocks, activeSettledBlocks],
  );

  const staticItems = useMemo(() => [HEADER_SENTINEL, ...mergedStaticBlocks], [mergedStaticBlocks]);

  const staticKey = useMemo(() => `s-${sessionKey ?? 0}`, [sessionKey]);

  return { staticItems, staticKey, header, mergedStaticBlocks, activeDynamicBlocks };
}
