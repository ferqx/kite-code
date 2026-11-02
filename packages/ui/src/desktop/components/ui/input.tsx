import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';
import { formControlClassName } from './form-control';

export function Input({ className, type, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(formControlClassName, 'h-8 w-full min-w-0 px-2.5 py-1', className)}
      {...props}
    />
  );
}
