// ── Static content computation hook ──
// Only truly immutable blocks go to <Static>. Blocks with mutable state
// (tool_card running→done, subagent running→done, streaming text, etc.)
// stay in the dynamic tree until they become immutable.
//
// Screen transitions (resize, session switch) use DEC synchronized output
// (\x1B[?2026h/l) to buffer the full re-render and display it atomically.
// Transition ownership lives in the commit/layout-effect coordinator below;
// rendering this hook never writes to stdout.
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

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  advanceOutputBlockTimeline,
  outputBlockVisualDigest,
  projectApprovalViewport,
  type TimelineItem,
  type TimelineState,
} from '../presentation/timeline';
import type { OutputBlock, Turn } from '../types';

export { changePrefix } from '../components/BlockRenderer';
export { toolColor } from '../components/render-utils';

/** Sentinel: ensures <Static> always has ≥1 item so Header renders even with no completed blocks */
const HEADER_SENTINEL = { __header: true } as const;

/**
 * Stable renderer cache key for a block's identity and visual state.
 * Only changes when the block's visual output actually changes.
 * This is the single source of truth for cache invalidation.
 */
export function blockRenderCacheKey(b: OutputBlock): string {
  // Lifecycle is a Timeline concern, but it must participate in the cache
  // key so a live item is reconsidered for Static promotion when the same
  // render model becomes sealed. The digest itself remains visual-only.
  return `${b.id}:${b.kind}:${b.presentationState ?? 'live'}:${outputBlockVisualDigest(b)}`;
}

/** Element-by-element reference identity comparison. */
function blocksIdentical(a: OutputBlock[], b: OutputBlock[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Keep canonical Timeline item references stable between real projection changes. */
function timelineItemsIdentical(a: readonly TimelineItem[], b: readonly TimelineItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]!;
    const right = b[index]!;
    if (
      left.id !== right.id ||
      left.state !== right.state ||
      (left.state === 'sealed' &&
        right.state === 'sealed' &&
        left.visualDigest !== right.visualDigest) ||
      left.renderModel.block !== right.renderModel.block
    ) {
      return false;
    }
  }
  return true;
}

/**
 * `turns.slice(0, -1)` creates a new array on every App render, while the
 * immutable history turns themselves retain their identity.  Recomputing each
 * block fingerprint for that history on an unrelated presentation update made typing
 * cost proportional to the whole conversation. Cache the expensive per-turn
 * walk by immutable Turn identity instead.
 */
const turnFingerprintCache = new WeakMap<Turn, string>();

function turnFingerprint(turn: Turn): string {
  const cached = turnFingerprintCache.get(turn);
  if (cached !== undefined) return cached;
  const fingerprint = turn.blocks.map(blockRenderCacheKey).join(',');
  turnFingerprintCache.set(turn, fingerprint);
  return fingerprint;
}

/** Compare history turn identities without rebuilding their block fingerprints. */
function turnsIdentical(a: Turn[], b: Turn[]): boolean {
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
  /** Canonical sealed Timeline items owned by the physical Static ledger. */
  mergedStaticTimeline: readonly TimelineItem[];
  /** Canonical live/dynamic Timeline items after the approval viewport projection. */
  activeDynamicTimeline: readonly TimelineItem[];
  /** Monotonic physical-render epoch used to fence React child identities. */
  renderEpoch: number;
}

export interface UseStaticContentOptions {
  turns: Turn[];
  /** Reducer-owned normalized message projection. Tests and compatibility
   * callers may omit it and use the one-way OutputBlock adapter. */
  presentationTimeline?: TimelineState;
  running: boolean;
  sessionKey?: number;
  header: ReactNode;
  /** > 0 时表示 resize 重挂载，开启同步输出缓冲消除闪烁 / When > 0, resize remount detected, enables sync output to eliminate flicker */
  resizeGeneration?: number;
  /** Presentation changes such as locale need a complete Static re-render. */
  presentationKey?: string;
  /** Focused approval owns a bounded viewport frontier; projection lives with Timeline. */
  awaitingApproval?: boolean;
}

export function useStaticContent({
  turns,
  presentationTimeline,
  running,
  sessionKey,
  header,
  resizeGeneration,
  presentationKey,
  awaitingApproval = false,
}: UseStaticContentOptions): StaticContentResult {
  // ── Session / resize lifecycle ──
  const prevSessionKeyRef = useRef<number | undefined>(undefined);
  const prevPresentationKeyRef = useRef<string | undefined>(undefined);
  const prevResizeGenerationRef = useRef<number | undefined>(undefined);
  const prevTurnCountRef = useRef(turns.length);
  const renderEpochRef = useRef(0);
  const [transitionPaintEpoch, setTransitionPaintEpoch] = useState(0);
  const staticCommittedRef = useRef(
    new Map<string, { readonly digest: string; readonly item: TimelineItem }>(),
  );
  const pendingTransitionRef = useRef<number | undefined>(undefined);
  const synchronizedTransitionRef = useRef<number | undefined>(undefined);
  // 会话重挂载后历史（含最后 turn）整体进 Static；新 run 开始时恢复活跃尾。
  // After a session remount the whole history (including the last turn) is
  // immutable; a new run (SET_RUNNING) restores the live-tail split.
  const prevRunningRef = useRef(running);
  const allSettledRef = useRef(false);
  const isInitialMount = prevSessionKeyRef.current === undefined;
  const resizeChanged = resizeGeneration !== prevResizeGenerationRef.current;
  const clearDetected = prevTurnCountRef.current > 0 && turns.length === 0;
  const needsClear =
    sessionKey !== prevSessionKeyRef.current ||
    presentationKey !== prevPresentationKeyRef.current ||
    resizeChanged ||
    clearDetected;

  if (needsClear) {
    renderEpochRef.current += 1;
    staticCommittedRef.current.clear();
    prevSessionKeyRef.current = sessionKey;
    prevPresentationKeyRef.current = presentationKey;
    prevResizeGenerationRef.current = resizeGeneration;
    pendingTransitionRef.current = isInitialMount ? undefined : renderEpochRef.current;

    // Session switch / remount with an idle session: promote the ENTIRE
    // conversation (including the last turn) to <Static>. The screen was
    // cleared below, so this cannot duplicate Windows scrollback frames the
    // way a live model.responded promotion would. Keeping the last turn
    // dynamic here would leave the whole history in the dynamic tree and
    // re-render it on every keystroke. A session that is still running keeps
    // its live tail dynamic so streamed content stays updateable.
    allSettledRef.current = !running;
  }
  prevTurnCountRef.current = turns.length;
  const renderEpoch = renderEpochRef.current;
  const pendingTransition = pendingTransitionRef.current;

  // A new run (SET_RUNNING fires before the durable user.message in the same tick) ends
  // the remount all-settled window: the freshly appended user turn becomes the
  // live tail and older turns remain immutable.
  if (running && !prevRunningRef.current) {
    allSettledRef.current = false;
  }
  prevRunningRef.current = running;

  // ── Stable-history / live-tail split ──
  // Older turns are immutable wholesale. Within the latest turn, only the
  // contiguous prefix whose reducer-owned completion facts are final may move
  // to Static. In particular, a tool_summary is complete only after reducer
  // publishes its aggregate result; active and child tool states are not a
  // second completion authority.
  const allSettled = allSettledRef.current;
  const settledTurns = allSettled ? turns : turns.slice(0, -1);
  const activeTurn = allSettled ? undefined : turns.at(-1);
  const timelineRef = useRef<TimelineState | undefined>(undefined);
  const flatBlocks = turns.flatMap((turn) => turn.blocks);
  let fallbackTimeline = timelineRef.current;
  if (!presentationTimeline) {
    fallbackTimeline = advanceOutputBlockTimeline(fallbackTimeline, flatBlocks, renderEpoch);
    timelineRef.current = fallbackTimeline;
  }
  const timeline: TimelineState = presentationTimeline
    ? { renderEpoch, items: presentationTimeline.items }
    : (fallbackTimeline ?? { renderEpoch, items: [] });
  const settledBlockCount = settledTurns.reduce((count, turn) => count + turn.blocks.length, 0);
  const settledTimelineItems = timeline.items.slice(0, settledBlockCount);
  const activeTimelineItems = timeline.items.slice(settledBlockCount);

  // Physical screen ownership belongs to the commit phase. Keeping this out
  // of render is important: a reducer replay or StrictMode render must never
  // emit a partial clear/synchronized-output sequence.
  useLayoutEffect(() => {
    const epoch = pendingTransition;
    if (epoch === undefined) return;
    pendingTransitionRef.current = undefined;
    // Scroll to the bottom before freezing the viewport. Ink then commits the
    // new Static/dynamic tree as one terminal transaction.
    process.stdout.write('\x1B[9999H\x1B[?2026h\x1B[H\x1B[2J\x1B[3J');
    // The transition-triggering commit happened before this layout effect and
    // is intentionally erased. Force one new Static key while synchronized
    // output is held so the rebuilt viewport is committed after the clear.
    synchronizedTransitionRef.current = epoch;
    setTransitionPaintEpoch(epoch);
  }, [pendingTransition]);

  useLayoutEffect(() => {
    const epoch = synchronizedTransitionRef.current;
    if (epoch === undefined || transitionPaintEpoch !== epoch) return;
    synchronizedTransitionRef.current = undefined;
    // This effect runs only after the forced paint commit above. Releasing in
    // a microtask from the clearing commit races React and can expose an empty
    // viewport when LOAD_SESSION and local presentation notes are batched.
    process.stdout.write('\x1B[?2026l');
  }, [transitionPaintEpoch]);

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

  // ── Settled turn Timeline items: cache by fingerprint ──
  // When running flips from true to false, the active turn moves into
  // settled turns. If a block inside it later changes state (e.g. running
  // sub-agent receives subagent_error, tool_card receives tool_done), the
  // count stays the same but the content differs. Fingerprint catches this.
  const prevSettledFpRef = useRef('');
  const prevSettledTurnsRef = useRef<Turn[]>([]);
  const staticTimelineRef = useRef<readonly TimelineItem[]>([]);

  // Most renders are input/status updates. Their `turns` container may be
  // recreated, but settled Turn identities are unchanged, so avoid walking
  // every historical block (and especially large text/caption fingerprints).
  let settledFp = prevSettledFpRef.current;
  if (!turnsIdentical(prevSettledTurnsRef.current, settledTurns)) {
    settledFp = settledTurns.map(turnFingerprint).join('|');
    prevSettledTurnsRef.current = settledTurns;
  }

  if (settledFp !== prevSettledFpRef.current) {
    prevSettledFpRef.current = settledFp;
    staticTimelineRef.current = settledTimelineItems;
  }

  // ── Active turn dynamic cache: cache by fingerprint ──
  // The fingerprint captures block identity, kind, status, and step count —
  // everything that affects the active turn visual output.
  const prevFingerprintRef = useRef('');
  const activeSettledRef = useRef<OutputBlock[]>([]);
  const activeDynamicRef = useRef<OutputBlock[]>([]);
  const activeSettledTimelineRef = useRef<readonly TimelineItem[]>([]);
  const activeDynamicTimelineRef = useRef<readonly TimelineItem[]>([]);

  let fingerprint = running ? 'running:' : 'idle:';
  if (activeTurn) {
    fingerprint += activeTurn.blocks.map(blockRenderCacheKey).join(',');
  }

  if (fingerprint !== prevFingerprintRef.current) {
    prevFingerprintRef.current = fingerprint;

    let nextSettled: OutputBlock[];
    let nextDynamic: OutputBlock[];
    let nextSettledTimeline: readonly TimelineItem[];
    let nextDynamicTimeline: readonly TimelineItem[];

    if (activeTurn && activeTurn.blocks.length > 0) {
      // active turn 中已完成（绝对不可变）的连续前缀提升进 <Static>，只把活跃
      // 后缀留在动态树。Ink <Static> 是 append-only 的（items.slice(index) 只
      // 渲染新增项），所以只有 isBlockSettledInRun 判定的、后续事件绝不再
      // 修改的 block 才能离开动态树；一旦遇到第一个仍可变的块，其后的块
      // 全部留在动态树（保证 Static→动态的渲染顺序）。
      const blocks = activeTurn.blocks;
      const timelineItems = activeTimelineItems;
      let split = 0;
      while (split < blocks.length && timelineItems[split]?.state === 'sealed') {
        split++;
      }

      // Terminal facts can close the remaining contiguous prefix on the same
      // frame that the Run becomes idle.  ADR-0168/0171/0172 make those block
      // facts—not Run liveness—the completion authority, so retain no stale
      // dynamic owner once the prefix is proven immutable.
      // Timeline owns both lifecycle and the immutable render model. Reading
      // the fresh OutputBlock array here would bypass advanceOutputBlockTimeline:
      // a late event could then swap a previously sealed block into Static even
      // though the Timeline correctly retained its committed digest/model.
      nextSettled = timelineItems.slice(0, split).map((item) => item.renderModel.block);
      nextDynamic = timelineItems.slice(split).map((item) => item.renderModel.block);
      nextSettledTimeline = timelineItems.slice(0, split);
      nextDynamicTimeline = timelineItems.slice(split);
    } else {
      nextSettled = [];
      nextDynamic = [];
      nextSettledTimeline = [];
      nextDynamicTimeline = [];
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
    if (!timelineItemsIdentical(activeSettledTimelineRef.current, nextSettledTimeline)) {
      activeSettledTimelineRef.current = nextSettledTimeline;
    }
    if (!timelineItemsIdentical(activeDynamicTimelineRef.current, nextDynamicTimeline)) {
      activeDynamicTimelineRef.current = nextDynamicTimeline;
    }
  }

  // ── Derived values with stable references ──
  // These useMemos depend on the ref values. Since we only update the refs
  // when content actually changes, the useMemo dependencies are stable
  // between renders, preventing unnecessary recomputation.
  const activeDynamicBlocks = activeDynamicRef.current;
  const staticTimeline = staticTimelineRef.current;
  const activeSettledTimeline = activeSettledTimelineRef.current;
  const activeDynamicTimeline = activeDynamicTimelineRef.current;

  const proposedStaticTimeline = useMemo(
    () => [...staticTimeline, ...activeSettledTimeline],
    [staticTimeline, activeSettledTimeline],
  );
  const physicalStaticTimelineRef = useRef<readonly TimelineItem[]>([]);
  const resolvedStaticTimeline = proposedStaticTimeline.map((item) => {
    const committed = staticCommittedRef.current.get(`${renderEpoch}:item-${item.id}`);
    // Ink Static ownership is irreversible. A late identity join or stale
    // presentation packet may update the reducer DTO, but it cannot replace
    // the render model already committed for this logical item.
    if (!committed) return item;
    return committed.digest === outputBlockVisualDigest(item.renderModel.block)
      ? item
      : committed.item;
  });
  if (!timelineItemsIdentical(physicalStaticTimelineRef.current, resolvedStaticTimeline)) {
    physicalStaticTimelineRef.current = resolvedStaticTimeline;
  }
  const mergedStaticTimeline = physicalStaticTimelineRef.current;
  const mergedStaticBlocks = mergedStaticTimeline.map((item) => item.renderModel.block);
  const projectedApproval = projectApprovalViewport(activeDynamicTimeline, awaitingApproval);
  const visibleDynamicTimeline = projectedApproval.visibleItems;

  const staticItems = useMemo(() => [HEADER_SENTINEL, ...mergedStaticBlocks], [mergedStaticBlocks]);

  // Effects run after Ink commits the render. Until this point the ledger is
  // only a plan and cannot claim physical Static ownership.
  useEffect(() => {
    for (const item of mergedStaticTimeline) {
      const block = item.renderModel.block;
      const id = `${renderEpoch}:item-${item.id}`;
      if (staticCommittedRef.current.has(id)) continue;
      staticCommittedRef.current.set(id, {
        digest: outputBlockVisualDigest(block),
        item,
      });
    }
  }, [mergedStaticTimeline, renderEpoch]);

  const staticKey = useMemo(
    () =>
      renderEpoch === 0
        ? `s-${sessionKey ?? 0}-${presentationKey ?? 'default'}`
        : `s-${sessionKey ?? 0}-${presentationKey ?? 'default'}-e${renderEpoch}-p${transitionPaintEpoch}`,
    [presentationKey, renderEpoch, sessionKey, transitionPaintEpoch],
  );

  return {
    staticItems,
    staticKey,
    header,
    mergedStaticBlocks,
    activeDynamicBlocks,
    mergedStaticTimeline,
    activeDynamicTimeline: visibleDynamicTimeline,
    renderEpoch,
  };
}
