import { type KeyboardEvent, memo, useLayoutEffect, useRef } from 'react';

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

function navigateMarkers(event: KeyboardEvent<HTMLButtonElement>) {
  const button = event.currentTarget;
  const offset = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
  if (!offset) return;
  event.preventDefault();
  const target = offset < 0 ? button.previousElementSibling : button.nextElementSibling;
  if (target instanceof HTMLButtonElement) target.focus();
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
  const railRef = useRef<HTMLElement>(null);
  const activeIndex = markers.findIndex(({ key }) => key === activeKey);
  useLayoutEffect(() => {
    const rail = railRef.current;
    const marker = rail?.children[activeIndex] as HTMLButtonElement | undefined;
    if (!marker || !rail || rail.contains(rail.ownerDocument.activeElement)) return;
    const top = marker.offsetTop;
    if (top < rail.scrollTop) rail.scrollTop = top;
    else if (top + marker.offsetHeight > rail.scrollTop + rail.clientHeight)
      rail.scrollTop = top + marker.offsetHeight - rail.clientHeight;
  }, [activeIndex]);
  return (
    <nav ref={railRef} className="conversation-message-navigation" aria-label="会话消息导航">
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
    </nav>
  );
});
