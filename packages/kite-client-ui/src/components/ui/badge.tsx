import type * as React from 'react';

import { cn } from '../../lib/utils';

function Badge({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-transparent bg-[var(--attention-background)] px-2 py-0.5 text-xs font-medium text-[var(--attention-foreground)]',
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
