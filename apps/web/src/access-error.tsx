import { useLayoutEffect, useRef } from 'react';

export function AccessError({
  browser,
  code,
  connection = false,
}: {
  readonly browser: Window;
  readonly code: string;
  readonly connection?: boolean;
}) {
  const reload = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => reload.current?.focus(), []);
  return (
    <div className="web-access">
      <p role="alert">
        {connection ? 'Read-only connection unavailable' : 'Read-only identity unavailable'} ·{' '}
        {code}. Reload this page to verify its current identity.
      </p>
      <button type="button" ref={reload} onClick={() => browser.location.reload()}>
        Reload page
      </button>
    </div>
  );
}
