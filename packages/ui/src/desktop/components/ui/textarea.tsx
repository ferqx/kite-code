import type * as React from 'react';
import { cn } from '../../lib/utils';
import { formControlClassName } from './form-control';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        formControlClassName,
        'flex field-sizing-content min-h-16 w-full px-3 py-2',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
