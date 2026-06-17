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

import { useRef, useMemo, useEffect, type ReactNode } from "react";
import type { Turn, OutputBlock } from "../types";

export { changePrefix } from "../components/BlockRenderer";
export { toolColor } from "../components/render-utils";

/** Sentinel: ensures <Static> always has ≥1 item so Header renders even with no completed blocks */
const HEADER_SENTINEL = { __header: true } as const;

/**
 * A block is "settled" if its visual output will never change again.
 * Only settled blocks may enter <Static>, because Ink's <Static> never
 * re-renders or updates previously written items.
 */
function isSettled(block: OutputBlock): boolean {
  switch (block.kind) {
    case "user":
      return true; // never changes
    case "text":
      return !block.streaming; // streaming text is still mutating
    case "reason":
      return true; // content is final once emitted
    case "tool_card":
      return block.status === "done" || block.status === "error";
    case "subagent":
      return block.status === "done" || block.status === "error";
    case "approval":
      return block.resolved !== undefined;
    case "question":
      return block.resolved !== undefined;
    case "file_change":
      return true; // immutable once created
    default:
      return true;
  }
}

/**
 * Stable fingerprint of a block's identity and mutable state.
 * Only changes when the block's visual output actually changes.
 * This is the single source of truth for cache invalidation.
 */
export function blockFingerprint(b: OutputBlock): string {
  let extra = "";
  switch (b.kind) {
    case "text":
      extra = b.streaming ? `:s:${b.content.length}` : ":f";
      break;
    case "tool_card":
      extra = `:${b.status}`;
      break;
    case "subagent":
      extra = `:${b.status}:${b.steps.length}`;
      break;
    case "approval":
    case "question":
      extra = b.resolved !== undefined ? ":resolved" : ":pending";
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
  /** All static blocks (settled turns + settled blocks from active turn) */
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
  // ── Two-level Static/Dynamic split ──
  const settledTurns = running ? turns.slice(0, -1) : turns;
  const activeTurn = running ? turns.at(-1) : undefined;

  // ── Session / resize lifecycle ──
  const prevSessionKeyRef = useRef<number | undefined>(undefined);
  const syncOutputRef = useRef(false);

  const needsClear = sessionKey !== prevSessionKeyRef.current;
  const isResize = (resizeGeneration ?? 0) > 0;
  const isInitialMount = prevSessionKeyRef.current === undefined;

  if (needsClear) {
    prevSessionKeyRef.current = sessionKey;

    if (isResize || !isInitialMount) {
      // Resize / session switch: scroll to bottom, enable sync, clear.
      // \x1B[9999H forces viewport to bottom before sync freezes it.
      // eslint-disable-next-line no-restricted-properties
      process.stdout.write("\x1B[9999H\x1B[?2026h\x1B[H\x1B[2J\x1B[3J");
      syncOutputRef.current = true;
    } else {
      // Initial mount: clear only, no sync (content appears naturally).
      // eslint-disable-next-line no-restricted-properties
      process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
    }
  }

  // Disable synchronized output after the first render commits.
  useEffect(() => {
    if (syncOutputRef.current) {
      syncOutputRef.current = false;
      // eslint-disable-next-line no-restricted-properties
      process.stdout.write("\x1B[?2026l");
    }
    return () => {
      if (syncOutputRef.current) {
        syncOutputRef.current = false;
        // eslint-disable-next-line no-restricted-properties
        process.stdout.write("\x1B[?2026l");
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
  const prevSettledFpRef = useRef("");
  const staticBlocksRef = useRef<OutputBlock[]>([]);

  const settledFp = settledTurns
    .map((t) => t.blocks.map(blockFingerprint).join(","))
    .join("|");

  if (settledFp !== prevSettledFpRef.current) {
    prevSettledFpRef.current = settledFp;
    staticBlocksRef.current = settledTurns.flatMap((t) => t.blocks);
  }

  // ── Active turn Static/Dynamic split: cache by fingerprint ──
  // The fingerprint captures block identity, kind, status, and step count —
  // everything that affects the Static/Dynamic split and visual output.
  const prevFingerprintRef = useRef("");
  const activeSettledRef = useRef<OutputBlock[]>([]);
  const activeDynamicRef = useRef<OutputBlock[]>([]);

  let fingerprint = "";
  if (activeTurn) {
    fingerprint = activeTurn.blocks.map(blockFingerprint).join(",");
  }

  if (fingerprint !== prevFingerprintRef.current) {
    prevFingerprintRef.current = fingerprint;

    let nextSettled: OutputBlock[];
    let nextDynamic: OutputBlock[];

    if (activeTurn && activeTurn.blocks.length > 0) {
      // Find the LEFTMOST unsettled block. Everything BEFORE it goes to Static,
      // everything from it onwards stays dynamic.
      //
      // Example: [user, text(done), tool(ls,running), tool(find,running)]
      // → leftmost=2, static=[user, text], dynamic=[tool(ls), tool(find)]
      let leftmostUnsettled = activeTurn.blocks.length;
      for (let i = 0; i < activeTurn.blocks.length; i++) {
        if (!isSettled(activeTurn.blocks[i])) {
          leftmostUnsettled = i;
          break;
        }
      }

      if (leftmostUnsettled === activeTurn.blocks.length) {
        nextSettled = activeTurn.blocks;
        nextDynamic = [];
      } else {
        nextSettled = activeTurn.blocks.slice(0, leftmostUnsettled);
        nextDynamic = activeTurn.blocks.slice(leftmostUnsettled);
      }
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

  const staticItems = useMemo(
    () => [HEADER_SENTINEL, ...mergedStaticBlocks],
    [mergedStaticBlocks],
  );

  const staticKey = useMemo(() => `s-${sessionKey ?? 0}`, [sessionKey]);

  return { staticItems, staticKey, header, mergedStaticBlocks, activeDynamicBlocks };
}
