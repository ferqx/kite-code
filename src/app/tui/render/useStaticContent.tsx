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
  /** 主题切换时递增，强制 Static 重新渲染 / Incremented on theme switch to force Static re-render */
  themeGeneration?: number;
}

export function useStaticContent({
  turns,
  running,
  sessionKey,
  header,
  resizeGeneration,
  themeGeneration,
}: UseStaticContentOptions): StaticContentResult {
  // ── Two-level Static/Dynamic split ──
  const settledTurns = running ? turns.slice(0, -1) : turns;
  const activeTurn = running ? turns.at(-1) : undefined;

  // ── Turn-level settled blocks cache ──
  const staticBlocksRef = useRef<OutputBlock[]>([]);
  const prevSessionKeyRef = useRef<number | undefined>(undefined);
  const prevThemeGenRef = useRef<number | undefined>(undefined);
  const prevSettledRef = useRef<Turn[] | null>(null);

  const needsClear = sessionKey !== prevSessionKeyRef.current || themeGeneration !== prevThemeGenRef.current;
  const isResize = (resizeGeneration ?? 0) > 0;
  const isInitialMount = prevSessionKeyRef.current === undefined;

  // Track whether sync output was enabled so we can disable it after commit
  const syncOutputRef = useRef(false);

  if (needsClear) {
    prevSessionKeyRef.current = sessionKey;
    prevThemeGenRef.current = themeGeneration;
    prevSettledRef.current = settledTurns;
    staticBlocksRef.current = settledTurns.flatMap((t) => t.blocks);

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
  // The terminal then displays all buffered output in a single frame.
  // Cleanup handles rapid consecutive transitions that unmount before the effect fires.
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

  const staticItems = useMemo(
    () => [HEADER_SENTINEL, ...mergedStaticBlocks],
    [mergedStaticBlocks],
  );

  const staticKey = useMemo(() => `s-${sessionKey ?? 0}-t${themeGeneration ?? 0}`, [sessionKey, themeGeneration]);

  return { staticItems, staticKey, header, mergedStaticBlocks, activeDynamicBlocks };
}
