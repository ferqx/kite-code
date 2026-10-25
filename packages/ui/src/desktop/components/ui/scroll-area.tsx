import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import * as React from 'react';

import { cn } from '../../lib/utils';

type ScrollAreaProps = React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
  orientation?: 'vertical' | 'horizontal' | 'both';
  fade?: 'x' | 'y' | false;
  /** Continue vertical wheel input in an ancestor when this reader reaches its edge. */
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
      const wheel = (event: WheelEvent) => {
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
      return () => element.removeEventListener('wheel', wheel);
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
