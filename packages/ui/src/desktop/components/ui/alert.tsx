import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

function Alert({
  className,
  variant = 'default',
  ...props
}: ComponentProps<'div'> & { variant?: 'default' | 'destructive' }) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn('alert', variant === 'destructive' && 'alert-destructive', className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="alert-title" className={cn('alert-title', className)} {...props} />;
}

function AlertDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div data-slot="alert-description" className={cn('alert-description', className)} {...props} />
  );
}

export { Alert, AlertDescription, AlertTitle };
