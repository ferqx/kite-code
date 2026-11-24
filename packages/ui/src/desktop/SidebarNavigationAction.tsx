import type { ComponentProps, ReactNode } from 'react';
import { cn } from './lib/utils';
import { Button } from './ui';

export function SidebarNavigationList({
  as: Element = 'nav',
  className,
  ...props
}: ComponentProps<'nav'> & { readonly as?: 'nav' | 'section' }) {
  return <Element {...props} className={cn('sidebar-navigation-list', className)} />;
}

export function SidebarNavigationHeading({
  label,
  className,
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className={cn('sidebar-navigation-heading', className)}>
      <span>{label}</span>
      {children}
    </div>
  );
}

export function SidebarNavigationButton({ className, ...props }: ComponentProps<typeof Button>) {
  return <Button {...props} className={cn('sidebar-navigation-row', className)} />;
}

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
    <SidebarNavigationButton
      {...props}
      className={cn('sidebar-navigation-action', className)}
      variant="plain"
    >
      {icon}
      <span>{children}</span>
    </SidebarNavigationButton>
  );
}
