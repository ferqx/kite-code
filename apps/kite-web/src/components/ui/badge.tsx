import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-surface-subtle px-1.5 py-0.5 text-[10px] font-medium tracking-[0.01em] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}
