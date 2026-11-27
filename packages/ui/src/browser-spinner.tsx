import { LoaderCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ComponentProps } from 'react';
import { cn } from './desktop/lib/utils';

export function Spinner({
  className,
  'aria-label': ariaLabel = 'Loading',
  ...props
}: Omit<ComponentProps<typeof HugeiconsIcon>, 'icon'>) {
  return (
    <HugeiconsIcon
      icon={LoaderCircleIcon}
      strokeWidth={2}
      role="status"
      aria-label={ariaLabel}
      className={cn('size-[var(--ui-icon-size,14px)] animate-spin', className)}
      {...props}
    />
  );
}
