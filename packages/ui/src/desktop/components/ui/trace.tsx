import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Slot } from '@radix-ui/react-slot';
import type * as React from 'react';
import { cn } from '../../lib/utils';
import { AnimatedCollapsibleContent, Collapsible, CollapsibleTrigger } from './collapsible';

// Adapted from shadcn/ui Trace. Local class hooks retain the existing desktop
// layout and motion; callers continue to own execution state and disclosure IDs.
function Trace({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="trace" className={cn('flex min-w-0 flex-col', className)} {...props} />;
}

function TraceLine({
  className,
  status,
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & {
  status?: 'running' | 'error' | 'pending';
  asChild?: boolean;
}) {
  const Comp = asChild ? Slot : 'span';
  return (
    <Comp
      data-slot="trace-line"
      data-status={status}
      className={cn('flex max-w-full min-w-0 items-center gap-2 text-muted-foreground', className)}
      {...props}
    />
  );
}

function TraceIcon({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-icon"
      aria-hidden="true"
      className={cn(
        'flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg:not([class*="size-"])]:size-4',
        className,
      )}
      {...props}
    />
  );
}

function TraceTitle({ className, ...props }: React.ComponentProps<'span'>) {
  return <span data-slot="trace-title" className={cn('min-w-0', className)} {...props} />;
}

function TraceDescription({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="trace-description"
      className={cn('shrink-0 tabular-nums', className)}
      {...props}
    />
  );
}

function TraceCollapsible({ className, ...props }: React.ComponentProps<typeof Collapsible>) {
  return (
    <Collapsible data-slot="trace-collapsible" className={cn('min-w-0', className)} {...props} />
  );
}

function TraceCollapsibleTrigger({
  className,
  children,
  asChild,
  ...props
}: React.ComponentProps<typeof CollapsibleTrigger>) {
  // The desktop summary already places its arrow before execution/approval
  // status. asChild preserves that order and independent file buttons.
  return (
    <CollapsibleTrigger
      data-slot="trace-collapsible-trigger"
      className={cn('group/trace-collapsible-trigger', className)}
      asChild={asChild}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {children}
          <TraceIcon>
            <HugeiconsIcon icon={ArrowRight01Icon} />
          </TraceIcon>
        </>
      )}
    </CollapsibleTrigger>
  );
}

function TraceCollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof AnimatedCollapsibleContent>) {
  // Reuse desktop motion and restored-expanded handling rather than layering
  // the upstream accordion animation over the existing reveal animation.
  return (
    <AnimatedCollapsibleContent
      data-slot="trace-collapsible-content"
      className={cn('min-w-0', className)}
      {...props}
    />
  );
}

export {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
};
