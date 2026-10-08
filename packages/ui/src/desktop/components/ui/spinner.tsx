import { LoaderCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type * as React from 'react';

import { cn } from '../../lib/utils';

function Spinner({
  className,
  'aria-label': ariaLabel = 'Loading',
  ...props
}: Omit<React.ComponentProps<typeof HugeiconsIcon>, 'icon'>) {
  return (
    <HugeiconsIcon
      icon={LoaderCircleIcon}
      strokeWidth={2}
      role="status"
      aria-label={ariaLabel}
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  );
}

export { Spinner };
