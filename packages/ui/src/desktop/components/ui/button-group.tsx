import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

type ButtonGroupProps = ComponentProps<'div'> & {
  orientation?: 'horizontal' | 'vertical';
};

export function ButtonGroup({ className, orientation = 'horizontal', ...props }: ButtonGroupProps) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: Button groups organize desktop actions outside forms.
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn('button-group', className)}
      {...props}
    />
  );
}
