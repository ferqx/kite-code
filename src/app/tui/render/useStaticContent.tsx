// ── Static content computation hook ──
// Only truly immutable blocks go to <Static>. Blocks with mutable state
// (tool_card running→done, subagent running→done, streaming text, etc.)
// stay in the dynamic tree until they become immutable.

import { useRef, useMemo, useState, useEffect, type ReactNode } from "react";
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
    case "plan_card":
      return block.planStatus === "completed";
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
}

export function useStaticContent({
  turns,
  running,
  sessionKey,
  header,
}: UseStaticContentOptions): StaticContentResult {
  // ── Two-level Static/Dynamic split ──
  const settledTurns = running ? turns.slice(0, -1) : turns;
  const activeTurn = running ? turns.at(-1) : undefined;

  // ── Turn-level settled blocks cache ──
  const staticBlocksRef = useRef<OutputBlock[]>([]);
  const prevSessionKeyRef = useRef<number | undefined>(undefined);
  const prevSettledRef = useRef<Turn[] | null>(null);

  const needsClear = sessionKey !== prevSessionKeyRef.current;

  // ── Two-phase rendering: header first, then content appended ──
  // When sessionKey changes, clear the screen and render only the header
  // in the first pass. After that render commits, append all content blocks
  // via Ink's <Static> append mechanism (same staticKey, new items at the end).
  // Skip on initial mount to avoid hiding content on startup.
  const showContentRef = useRef(true);
  const [, forceUpdate] = useState(0);
  const isInitialMount = prevSessionKeyRef.current === undefined;

  if (needsClear) {
    prevSessionKeyRef.current = sessionKey;
    prevSettledRef.current = settledTurns;
    staticBlocksRef.current = settledTurns.flatMap((t) => t.blocks);
    // eslint-disable-next-line no-restricted-properties -- intentional synchronous clear before Ink flush
    process.stdout.write("\x1B[2J\x1B[3J\x1B[H");
    if (!isInitialMount) {
      showContentRef.current = false;
    }
  }

  // After the header-only render commits, trigger the content phase
  useEffect(() => {
    if (!showContentRef.current) {
      showContentRef.current = true;
      const id = setTimeout(() => forceUpdate((n) => n + 1), 0);
      return () => clearTimeout(id);
    }
  });

  const showContent = showContentRef.current;

  if (settledTurns !== prevSettledRef.current) {
    prevSettledRef.current = settledTurns;
    staticBlocksRef.current = settledTurns.flatMap((t) => t.blocks);
  }
  const staticBlocks = staticBlocksRef.current;

  // ── Block-level split within the active turn ──
  // Find the LEFTMOST unsettled block. Everything BEFORE it is settled
  // (truly immutable) and goes to <Static>. Everything from the leftmost
  // unsettled onwards stays in the dynamic tree so that state transitions
  // (running→done, pending→completed) are reflected in real time.
  //
  // Example: [tool(ls,running), tool(find,running)] → leftmost at index 0,
  // both tools stay dynamic. If tool(find) finishes: [tool(ls,running), tool(find,done)]
  // → leftmost at index 0, both still dynamic. If tool(ls) also finishes:
  // [tool(ls,done), tool(find,done)] → all settled, both go to Static.
  const { activeSettledBlocks, activeDynamicBlocks } = useMemo(() => {
    if (!activeTurn) return { activeSettledBlocks: [] as OutputBlock[], activeDynamicBlocks: [] as OutputBlock[] };
    const allBlocks = activeTurn.blocks;
    if (allBlocks.length === 0) return { activeSettledBlocks: [], activeDynamicBlocks: [] };

    let leftmostUnsettled = allBlocks.length;
    for (let i = 0; i < allBlocks.length; i++) {
      if (!isSettled(allBlocks[i])) {
        leftmostUnsettled = i;
        break;
      }
    }

    if (leftmostUnsettled === allBlocks.length) {
      // All blocks are settled — all go to Static
      return { activeSettledBlocks: allBlocks, activeDynamicBlocks: [] };
    }

    return {
      activeSettledBlocks: allBlocks.slice(0, leftmostUnsettled),
      activeDynamicBlocks: allBlocks.slice(leftmostUnsettled),
    };
  }, [activeTurn]);

  const mergedStaticBlocks = useMemo(
    () => [...staticBlocks, ...activeSettledBlocks],
    [staticBlocks, activeSettledBlocks],
  );

  // In header-only phase, suppress static content; dynamic blocks always render
  const phasedStaticBlocks = showContent ? mergedStaticBlocks : [];

  const staticItems = useMemo(
    () => [HEADER_SENTINEL, ...phasedStaticBlocks],
    [phasedStaticBlocks],
  );

  const staticKey = useMemo(() => `s-${sessionKey ?? 0}`, [sessionKey]);

  return { staticItems, staticKey, header, mergedStaticBlocks: phasedStaticBlocks, activeDynamicBlocks };
}
