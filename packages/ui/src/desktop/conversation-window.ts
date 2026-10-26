export const CONVERSATION_WINDOW_THRESHOLD = 100;
const INITIAL_ENTRIES = 40;
const EXPANSION_ENTRIES = 20;
const ANCHOR_PRECEDING_ENTRIES = 10;
const ENTRY_SELECTOR = '[data-conversation-entry-key]';

/** Window state contains identities only; indexes belong to the current projection. */
export type ConversationWindow = {
  firstKey?: string;
  lastKey?: string;
  order: readonly string[];
};

export type ConversationWindowRange = {
  start: number;
  end: number;
  state: ConversationWindow;
  hasBefore: boolean;
  hasAfter: boolean;
};

export type ConversationScrollAnchor = { entryKey: string; offset: number };

/** Let a browser frame finish before one load; cancellation owns both scheduling stages. */
export function scheduleConversationWindowLoad(view: Window, step: () => void) {
  let canceled = false;
  let frame: number | undefined;
  let task: number | undefined;
  const run = () => {
    task = undefined;
    if (!canceled) step();
  };
  if (typeof view.requestAnimationFrame === 'function')
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      if (!canceled) task = view.setTimeout(run, 0);
    });
  else task = view.setTimeout(run, 0);
  return () => {
    if (canceled) return;
    canceled = true;
    if (frame !== undefined) view.cancelAnimationFrame(frame);
    if (task !== undefined) view.clearTimeout(task);
    frame = undefined;
    task = undefined;
  };
}

function stateForRange(
  keys: readonly string[],
  start: number,
  end: number,
  previous?: ConversationWindow,
): ConversationWindow {
  const firstKey = keys[start];
  const lastKey = keys[end - 1];
  if (
    previous &&
    previous.firstKey === firstKey &&
    previous.lastKey === lastKey &&
    previous.order.length === keys.length &&
    previous.order.every((key, index) => key === keys[index])
  )
    return previous;
  return firstKey === undefined || lastKey === undefined
    ? { order: [...keys] }
    : { firstKey, lastKey, order: [...keys] };
}

/** Only a first large projection uses forty entries or a cold manual anchor region. */
export function createConversationWindow(
  keys: readonly string[],
  options: { anchorKey?: string; legacyManual?: boolean } = {},
): ConversationWindow {
  if (keys.length <= CONVERSATION_WINDOW_THRESHOLD) return stateForRange(keys, 0, keys.length);
  const anchor = options.anchorKey === undefined ? -1 : keys.indexOf(options.anchorKey);
  if (anchor >= 0)
    return stateForRange(
      keys,
      Math.max(0, anchor - ANCHOR_PRECEDING_ENTRIES),
      Math.min(keys.length, anchor + INITIAL_ENTRIES - ANCHOR_PRECEDING_ENTRIES),
    );
  return stateForRange(keys, options.legacyManual ? 0 : keys.length - INITIAL_ENTRIES, keys.length);
}

/** Resolve stable boundaries against fresh grouping, without resetting manual readers. */
export function resolveConversationWindow(
  keys: readonly string[],
  previous: ConversationWindow,
  options: { followTail?: boolean } = {},
): ConversationWindowRange {
  if (!keys.length) {
    const state = stateForRange(keys, 0, 0, previous);
    return { start: 0, end: 0, state, hasBefore: false, hasAfter: false };
  }
  if (keys.length <= CONVERSATION_WINDOW_THRESHOLD) {
    const state = stateForRange(keys, 0, keys.length, previous);
    return { start: 0, end: keys.length, state, hasBefore: false, hasAfter: false };
  }
  if (!previous.order.length || previous.firstKey === undefined || previous.lastKey === undefined)
    return resolveConversationWindow(keys, createConversationWindow(keys), options);
  const index = new Map(keys.map((key, offset) => [key, offset]));
  const oldStart = Math.max(0, previous.order.indexOf(previous.firstKey));
  const oldEnd = Math.max(oldStart, previous.order.indexOf(previous.lastKey));
  let start = index.get(previous.firstKey);
  let end = index.get(previous.lastKey);
  if (start === undefined) {
    start = 0;
    // Regrouping may replace the boundary or merge it into its predecessor.
    // Include the nearest surviving predecessor rather than drop that content.
    for (let position = oldStart - 1; position >= 0; position--) {
      const retained = index.get(previous.order[position]!);
      if (retained !== undefined) {
        start = retained;
        break;
      }
    }
  }
  if (end === undefined) {
    end = keys.length - 1;
    for (let position = oldEnd + 1; position < previous.order.length; position++) {
      const retained = index.get(previous.order[position]!);
      if (retained !== undefined) {
        end = retained;
        break;
      }
    }
  }
  // Keep all surviving loaded identities even when grouping moves a boundary.
  for (let position = oldStart; position <= oldEnd; position++) {
    const retained = index.get(previous.order[position]!);
    if (retained === undefined) continue;
    start = Math.min(start, retained);
    end = Math.max(end, retained);
  }
  if (options.followTail && previous.lastKey === previous.order.at(-1)) end = keys.length - 1;
  end++;
  const state = stateForRange(keys, start, end, previous);
  return { start, end, state, hasBefore: start > 0, hasAfter: end < keys.length };
}

/** Expand the current reading region; newly arrived tail entries stay outside manual windows. */
export function expandConversationWindow(
  keys: readonly string[],
  previous: ConversationWindow,
  direction: 'before' | 'after',
): ConversationWindow {
  const range = resolveConversationWindow(keys, previous);
  return stateForRange(
    keys,
    direction === 'before' ? Math.max(0, range.start - EXPANSION_ENTRIES) : range.start,
    direction === 'after' ? Math.min(keys.length, range.end + EXPANSION_ENTRIES) : range.end,
    range.state,
  );
}

export function jumpConversationWindowToLatest(keys: readonly string[]) {
  return createConversationWindow(keys);
}

/** Persist only a visible entry identity and its position relative to the viewport. */
export function captureConversationScrollAnchor(
  viewport: HTMLElement,
): ConversationScrollAnchor | undefined {
  if (!viewport.isConnected) return undefined;
  const bounds = viewport.getBoundingClientRect();
  if (bounds.bottom <= bounds.top) return undefined;
  for (const entry of viewport.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)) {
    const entryKey = entry.getAttribute('data-conversation-entry-key');
    if (entryKey === null) continue;
    const position = entry.getBoundingClientRect();
    if (position.bottom > bounds.top && position.top < bounds.bottom)
      return { entryKey, offset: position.top - bounds.top };
  }
  return undefined;
}

/** Compensate the anchor's own movement, never unrelated tail height changes. */
export function restoreConversationScrollAnchor(
  viewport: HTMLElement,
  anchor: ConversationScrollAnchor,
) {
  if (!viewport.isConnected || !Number.isFinite(anchor.offset)) return false;
  const bounds = viewport.getBoundingClientRect();
  if (bounds.bottom <= bounds.top) return false;
  const entry = [...viewport.querySelectorAll<HTMLElement>(ENTRY_SELECTOR)].find(
    (candidate) => candidate.getAttribute('data-conversation-entry-key') === anchor.entryKey,
  );
  if (!entry) return false;
  const offset = entry.getBoundingClientRect().top - bounds.top;
  if (!Number.isFinite(offset)) return false;
  viewport.scrollTop += offset - anchor.offset;
  return true;
}
