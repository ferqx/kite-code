import { type KeyboardEvent, memo, useCallback, useLayoutEffect, useRef, useState } from 'react';

export type ConversationMessageMarker = { key: string; preview: string };

export function conversationMessageNavigationTop(viewport: HTMLElement) {
  const padding = viewport.ownerDocument.defaultView?.getComputedStyle(viewport).scrollPaddingTop;
  return viewport.getBoundingClientRect().top + (Number.parseFloat(padding ?? '') || 0) + 12;
}

export function currentConversationMessage(
  targets: readonly HTMLElement[],
  viewport: HTMLElement,
  following: boolean,
) {
  if (!targets.length) return undefined;
  if (following) return targets.at(-1)?.dataset.conversationMessageMarker;
  const top = conversationMessageNavigationTop(viewport);
  let start = 0;
  let end = targets.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (targets[middle]!.getBoundingClientRect().top <= top + 1) start = middle + 1;
    else end = middle;
  }
  return targets[Math.max(0, start - 1)]?.dataset.conversationMessageMarker;
}

function revealMarker(list: HTMLElement, marker: HTMLElement) {
  const top = marker.offsetTop;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (top + marker.offsetHeight > list.scrollTop + list.clientHeight)
    list.scrollTop = top + marker.offsetHeight - list.clientHeight;
}

function navigateMarkers(event: KeyboardEvent<HTMLButtonElement>) {
  const button = event.currentTarget;
  const list = button.parentElement;
  if (!list) return;
  const target =
    event.key === 'ArrowUp'
      ? button.previousElementSibling
      : event.key === 'ArrowDown'
        ? button.nextElementSibling
        : event.key === 'Home'
          ? list.firstElementChild
          : event.key === 'End'
            ? list.lastElementChild
            : null;
  if (!(target instanceof HTMLButtonElement)) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
  revealMarker(list, target);
}

export const ConversationMessageNavigation = memo(function ConversationMessageNavigation({
  markers,
  activeKey,
  onJump,
}: {
  markers: readonly ConversationMessageMarker[];
  activeKey?: string;
  onJump: (key: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [{ earlier, later }, setOverflow] = useState({ earlier: false, later: false });
  const updateOverflow = useCallback((list: HTMLElement) => {
    const available = list.parentElement?.clientHeight ?? 0;
    // Compare with the whole rail so the paging buttons cannot keep themselves visible.
    const overflowing = available > 0 && list.scrollHeight > available;
    const earlier = overflowing && list.scrollTop > 1;
    const later = overflowing && list.scrollHeight - list.clientHeight - list.scrollTop > 1;
    setOverflow((previous) =>
      previous.earlier === earlier && previous.later === later ? previous : { earlier, later },
    );
  }, []);
  const activeIndex = markers.findIndex(({ key }) => key === activeKey);
  const markerCount = markers.length;
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || markerCount === 0) return;
    const reveal = () => {
      const marker = list.children[activeIndex];
      const visibleMarker = list.querySelector(':focus-visible') ?? marker;
      if (visibleMarker instanceof HTMLElement && list.clientHeight > 0)
        revealMarker(list, visibleMarker);
      updateOverflow(list);
    };
    let previousHeight = list.clientHeight;
    reveal();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (list.clientHeight === previousHeight) return;
      previousHeight = list.clientHeight;
      reveal();
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeIndex, markerCount, updateOverflow]);
  const pageMarkers = (direction: -1 | 1) => {
    const list = listRef.current;
    if (!list) return;
    list.scrollTop += direction * list.clientHeight;
    updateOverflow(list);
  };
  return (
    <nav className="conversation-message-navigation" aria-label="会话消息导航">
      {(earlier || later) && (
        <button
          className="conversation-marker-page earlier"
          type="button"
          aria-label="查看更早的消息刻度"
          aria-disabled={!earlier}
          tabIndex={earlier ? 0 : -1}
          onClick={earlier ? () => pageMarkers(-1) : undefined}
        />
      )}
      <div
        ref={listRef}
        className="conversation-marker-list"
        onScroll={(event) => updateOverflow(event.currentTarget)}
      >
        {markers.map(({ key, preview }, index) => {
          const active = index === activeIndex;
          const label = `第 ${index + 1} 条已加载的用户消息${preview ? ` · ${preview}` : ''}`;
          return (
            <button
              key={key}
              type="button"
              aria-label={label}
              aria-current={active ? 'location' : undefined}
              tabIndex={index === Math.max(0, activeIndex) ? 0 : -1}
              title={label}
              onKeyDown={navigateMarkers}
              onClick={() => onJump(key)}
            />
          );
        })}
      </div>
      {(earlier || later) && (
        <button
          className="conversation-marker-page later"
          type="button"
          aria-label="查看更新的消息刻度"
          aria-disabled={!later}
          tabIndex={later ? 0 : -1}
          onClick={later ? () => pageMarkers(1) : undefined}
        />
      )}
    </nav>
  );
});
