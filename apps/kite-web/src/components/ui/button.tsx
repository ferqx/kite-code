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
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] border border-border/80 bg-surface/75 px-2.5 text-[12px] font-medium text-foreground transition-[background-color,border-color,color] hover:border-foreground/20 hover:bg-surface-raised disabled:pointer-events-none disabled:opacity-45',
        className,
      )}
      {...props}
    />
  );
}
