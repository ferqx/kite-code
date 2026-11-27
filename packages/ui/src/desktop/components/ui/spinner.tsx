import type * as React from 'react';

function Spinner({
  size,
  style,
  'aria-hidden': ariaHidden,
  'aria-label': ariaLabel = '加载中',
  ...props
}: React.ComponentProps<'span'> & { size?: number }) {
  const ringProps = {
    'data-slot': 'spinner',
    style: size === undefined ? style : { width: size, height: size, ...style },
    ...props,
  };
  if (ariaHidden === true || ariaHidden === 'true')
    return <span {...ringProps} aria-hidden="true" />;
  return <span {...ringProps} role="status" aria-hidden={ariaHidden} aria-label={ariaLabel} />;
}

export { Spinner };
