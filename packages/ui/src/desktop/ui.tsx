import type { ComponentProps } from 'react';
import { Button as ShadcnButton } from './components/ui/button';
import { Textarea as ShadcnTextarea } from './components/ui/textarea';
import { cn } from './lib/utils';

// Keep the shared page's design hooks on the actual shadcn/ui controls.
export function Button({
  className,
  variant = 'outline',
  size = 'sm',
  ...props
}: ComponentProps<typeof ShadcnButton>) {
  return (
    <ShadcnButton
      className={cn('button shadow-none focus-visible:ring-0', className)}
      variant={variant}
      size={size}
      {...props}
    />
  );
}
export function Textarea({ className, ...props }: ComponentProps<typeof ShadcnTextarea>) {
  return <ShadcnTextarea className={cn('textarea', className)} {...props} />;
}
