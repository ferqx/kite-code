import type { ComponentProps, ReactNode } from 'react';
import { cn } from './lib/utils';
import { Button } from './ui';

/** A primary navigation action whose current page is semantic, not a selection style. */
export function SidebarNavigationAction({
  icon,
  children,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, 'children' | 'variant' | 'size'> & {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Button
      {...props}
      className={cn('sidebar-navigation-action', className)}
      size="sm"
      variant="plain"
    >
      {icon}
      <span>{children}</span>
    </Button>
  );
}
