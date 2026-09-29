import {
  Root as Collapsible,
  Content as CollapsibleContent,
  Trigger as CollapsibleTrigger,
} from '@radix-ui/react-collapsible';
import type { ComponentProps } from 'react';

function AnimatedCollapsibleContent({
  children,
  className,
  ...props
}: ComponentProps<typeof CollapsibleContent>) {
  return (
    <CollapsibleContent
      className={`collapsible-motion-content${className ? ` ${className}` : ''}`}
      {...props}
    >
      <div className="collapsible-motion-reveal">
        <div className="collapsible-motion-reveal-inner">{children}</div>
      </div>
    </CollapsibleContent>
  );
}

export { AnimatedCollapsibleContent, Collapsible, CollapsibleContent, CollapsibleTrigger };
