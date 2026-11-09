import * as SwitchPrimitive from '@radix-ui/react-switch';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  // Native keeps legacy styles without Preflight; own the button's box and padding.
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer box-border inline-flex h-5 w-9 shrink-0 cursor-pointer items-center justify-start rounded-full border-2 border-transparent bg-input p-0 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-offset-2 data-[state=checked]:bg-primary motion-reduce:transition-none',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-4 shrink-0 rounded-full bg-background shadow-sm transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0 motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  );
}
