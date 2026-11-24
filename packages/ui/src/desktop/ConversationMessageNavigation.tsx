import { type KeyboardEvent, memo, useLayoutEffect, useRef } from 'react';
import { ScrollArea } from './components/ui/scroll-area';

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
  }, [activeIndex, markerCount]);
  return (
    <nav className="conversation-message-navigation" aria-label="会话消息导航">
      <ScrollArea
        nativeScrollbars
        fade="y"
        className="conversation-marker-scroll-area"
        viewportRef={listRef}
        viewportClassName="conversation-marker-list"
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
      </ScrollArea>
    </nav>
  );
});
