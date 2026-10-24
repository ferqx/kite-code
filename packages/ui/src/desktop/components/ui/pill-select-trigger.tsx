import { ArrowDown01Icon, ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Button } from '../../ui';

export type PillSelectTriggerProps = Omit<ComponentProps<typeof Button>, 'asChild'> & {
  leading?: ReactNode;
  suffix?: ReactNode;
  indicator?: 'down' | 'right' | 'none';
};

export function PillSelectTrigger({
  children,
  className,
  leading,
  suffix,
  indicator = 'down',
  variant = 'ghost',
  size = 'sm',
  ...props
}: PillSelectTriggerProps) {
  return (
    <Button
      className={cn('pill-select-trigger', className)}
      variant={variant}
      size={size}
      {...props}
    >
      {leading && <span className="pill-select-leading">{leading}</span>}
      <span className="pill-select-label">{children}</span>
      {suffix && <span className="pill-select-suffix">{suffix}</span>}
      {indicator !== 'none' && (
        <HugeiconsIcon
          className="pill-select-chevron"
          data-direction={indicator}
          data-icon="inline-end"
          icon={indicator === 'right' ? ArrowRight01Icon : ArrowDown01Icon}
          aria-hidden="true"
        />
      )}
    </Button>
  );
}
