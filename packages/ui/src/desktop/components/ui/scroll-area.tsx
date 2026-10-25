import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import * as React from 'react';

import { cn } from '../../lib/utils';

type ScrollAreaProps = React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
  orientation?: 'vertical' | 'horizontal' | 'both';
  fade?: 'x' | 'y' | false;
  /** Continue edge wheel input and keep keyboard-selected reader edges visible in ancestors. */
  chainScroll?: boolean;
  viewportRef?: React.Ref<HTMLDivElement>;
  viewportClassName?: string;
  viewportProps?: Omit<
    React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Viewport>,
    'children' | 'className'
  >;
};

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  ScrollAreaProps
>(
  (
    {
      className,
      children,
      orientation = 'vertical',
      fade = false,
      chainScroll = false,
      viewportRef,
      viewportClassName,
      viewportProps,
      ...props
    },
    ref,
  ) => {
    const viewport = React.useRef<HTMLDivElement>(null);
    const bindViewport = React.useCallback(
      (node: HTMLDivElement | null) => {
        viewport.current = node;
        if (typeof viewportRef === 'function') viewportRef(node);
        else if (viewportRef) viewportRef.current = node;
      },
      [viewportRef],
    );
    React.useEffect(() => {
      const element = viewport.current;
      if (!chainScroll || !element) return;
      const view = element.ownerDocument.defaultView!;
      const canScroll = (node: HTMLElement, delta: number) =>
        /^(auto|scroll)$/.test(view.getComputedStyle(node).overflowY) &&
        (delta < 0
          ? node.scrollTop > 0
          : node.scrollTop + node.clientHeight < node.scrollHeight - 1);
      let frame: number | undefined;
      let keyboardRevision = 0;
      const invalidate = () => {
        keyboardRevision++;
        if (frame !== undefined) view.cancelAnimationFrame(frame);
        frame = undefined;
      };
      const wheel = (event: WheelEvent) => {
        invalidate();
        if (
          event.defaultPrevented ||
          !event.cancelable ||
          event.ctrlKey ||
          event.shiftKey ||
          !event.deltaY ||
          event.deltaX !== 0
        )
          return;
        // A nested code/output reader that can still move owns its native wheel.
        for (let node = event.target as HTMLElement | null; node; node = node.parentElement) {
          if (canScroll(node, event.deltaY)) return;
          if (node === element) break;
        }
        for (let node = element.parentElement; node; node = node.parentElement) {
          if (!canScroll(node, event.deltaY)) continue;
          const unit =
            event.deltaMode === 2
              ? node.clientHeight
              : event.deltaMode === 1
                ? Number.parseFloat(view.getComputedStyle(element).lineHeight) || 16
                : 1;
          event.preventDefault();
          node.scrollTop += event.deltaY * unit;
          return;
        }
      };
      element.addEventListener('wheel', wheel, { passive: false });
      const keydown = (event: KeyboardEvent) => {
        invalidate();
        if (
          event.target !== element ||
          event.defaultPrevented ||
          event.ctrlKey ||
          event.altKey ||
          event.metaKey ||
          event.shiftKey ||
          !['Home', 'End'].includes(event.key)
        )
          return;
        const revision = keyboardRevision;
        const reveal = () => {
          if (revision !== keyboardRevision) return;
          if (frame !== undefined) view.cancelAnimationFrame(frame);
          // Native Home/End runs first. A newly opening disclosure can still
          // change the enclosing window, so recheck after its actual animation.
          frame = view.requestAnimationFrame(() => {
            frame = undefined;
            if (
              revision !== keyboardRevision ||
              !element.isConnected ||
              element.ownerDocument.activeElement !== element
            )
              return;
            element.scrollTop = event.key === 'End' ? element.scrollHeight : 0;
            for (let node = element.parentElement; node; node = node.parentElement) {
              if (!/^(auto|scroll)$/.test(view.getComputedStyle(node).overflowY)) continue;
              const inner = element.getBoundingClientRect();
              const outer = node.getBoundingClientRect();
              const top = outer.top + node.clientTop;
              const delta =
                event.key === 'End' ? inner.bottom - top - node.clientHeight : inner.top - top;
              if (event.key === 'End' ? delta > 0 : delta < 0) node.scrollTop += delta;
            }
          });
        };
        const animations: Animation[] = [];
        for (let node: HTMLElement | null = element; node; node = node.parentElement)
          animations.push(
            ...(node.getAnimations?.({ subtree: node === element }) ?? []).filter(
              (animation) =>
                animation.timeline === element.ownerDocument.timeline &&
                Number.isFinite(animation.effect?.getComputedTiming().endTime) &&
                animation.playState !== 'finished' &&
                animation.playState !== 'idle',
            ),
          );
        reveal();
        if (animations.length)
          void Promise.all(animations.map((animation) => animation.finished.catch(() => {}))).then(
            reveal,
          );
      };
      element.addEventListener('keydown', keydown);
      element.addEventListener('blur', invalidate);
      element.ownerDocument.addEventListener('pointerdown', invalidate, {
        capture: true,
        passive: true,
      });
      return () => {
        element.removeEventListener('wheel', wheel);
        element.removeEventListener('keydown', keydown);
        element.removeEventListener('blur', invalidate);
        element.ownerDocument.removeEventListener('pointerdown', invalidate, true);
        invalidate();
      };
    }, [chainScroll]);
    return (
      <ScrollAreaPrimitive.Root
        data-slot="scroll-area"
        ref={ref}
        className={cn('relative overflow-hidden', className)}
        {...props}
      >
        <ScrollAreaPrimitive.Viewport
          data-slot="scroll-area-viewport"
          ref={bindViewport}
          className={cn(
            'h-full w-full rounded-[inherit]',
            fade === 'x' && 'scroll-fade-x',
            fade === 'y' && 'scroll-fade-y',
            viewportClassName,
          )}
          {...viewportProps}
        >
          {children}
        </ScrollAreaPrimitive.Viewport>
        {orientation !== 'horizontal' && <ScrollBar />}
        {orientation !== 'vertical' && <ScrollBar orientation="horizontal" />}
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    );
  },
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = 'vertical', ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    data-slot="scroll-area-scrollbar"
    ref={ref}
    orientation={orientation}
    className={cn(
      'flex touch-none select-none transition-colors',
      orientation === 'vertical' && 'h-full w-2.5 border-l border-l-transparent p-[1px]',
      orientation === 'horizontal' && 'h-2.5 flex-col border-t border-t-transparent p-[1px]',
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb
      data-slot="scroll-area-thumb"
      className="relative flex-1 rounded-full bg-[var(--scrollbar-thumb)] transition-colors hover:bg-[var(--scrollbar-thumb-hover)]"
    />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
