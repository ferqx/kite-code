import { ArrowLeft01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { AttachmentGroup } from './components/ui/attachment';
import { cn } from './lib/utils';
import { Button } from './ui';

/** Presentation only: scrolling never grants attachment reading or opening authority. */
export function MessageAttachments({
  count,
  children,
  className,
}: {
  count: number;
  children: ReactNode;
  className?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ overflow: false, start: true, end: true });
  useLayoutEffect(() => {
    const element = list.current;
    if (!element || !count) return;
    const update = () => {
      const max = element.scrollWidth - element.clientWidth;
      const next = {
        overflow: max > 1,
        start: element.scrollLeft <= 1,
        end: element.scrollLeft >= max - 1,
      };
      setPosition((previous) =>
        previous.overflow === next.overflow &&
        previous.start === next.start &&
        previous.end === next.end
          ? previous
          : next,
      );
    };
    update();
    element.addEventListener('scroll', update, { passive: true });
    const observer =
      typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(update) : undefined;
    observer?.observe(element);
    return () => {
      element.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [count]);
  function scroll(direction: number) {
    const element = list.current;
    if (!element) return;
    const step = element.firstElementChild?.getBoundingClientRect().width ?? 148;
    const stride = step + 8;
    element.scrollBy({
      left: direction * Math.max(stride, Math.floor(element.clientWidth / stride) * stride),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }
  if (!count) return null;
  return (
    <section className="message-attachments" aria-label="消息附件">
      {position.overflow && (
        <div className="message-attachments-navigation">
          <span>{count} 个附件</span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="向左查看附件"
            disabled={position.start}
            onClick={() => scroll(-1)}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="向右查看附件"
            disabled={position.end}
            onClick={() => scroll(1)}
          >
            <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />
          </Button>
        </div>
      )}
      <AttachmentGroup
        ref={list}
        className={cn('composer-attachments message-attachments-list', className)}
      >
        {children}
      </AttachmentGroup>
    </section>
  );
}
