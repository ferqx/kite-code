import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Button({
  className,
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        'inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] font-medium text-foreground shadow-[0_1px_1px_rgb(0_0_0/0.03)] transition-[background-color,border-color,color,box-shadow] hover:border-border-strong hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
      {...props}
    />
  );
}
