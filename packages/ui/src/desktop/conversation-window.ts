const ENTRY_SELECTOR = '[data-conversation-entry-key]';

export type ConversationScrollAnchor = { entryKey: string; offset: number };

/** Persist only a visible entry identity and its position relative to the viewport. */
export function captureConversationScrollAnchor(
  viewport: HTMLElement,
): ConversationScrollAnchor | undefined {
  if (!viewport.isConnected) return undefined;
  const bounds = viewport.getBoundingClientRect();
  if (bounds.bottom <= bounds.top) return undefined;
  const entries = viewport.querySelectorAll<HTMLElement>(ENTRY_SELECTOR);
  let start = 0;
  let end = entries.length;
  while (start < end) {
    const middle = (start + end) >>> 1;
    if (entries[middle]!.getBoundingClientRect().bottom <= bounds.top) start = middle + 1;
    else end = middle;
  }
  for (let index = start; index < entries.length; index++) {
    const entry = entries[index]!;
    const position = entry.getBoundingClientRect();
    if (position.top >= bounds.bottom) break;
    const entryKey = entry.dataset.conversationEntryKey;
    if (entryKey !== undefined && position.bottom > bounds.top)
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
    (candidate) => candidate.dataset.conversationEntryKey === anchor.entryKey,
  );
  if (!entry) return false;
  const offset = entry.getBoundingClientRect().top - bounds.top;
  if (!Number.isFinite(offset)) return false;
  viewport.scrollTop += offset - anchor.offset;
  return true;
}
