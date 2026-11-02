import { Button } from '@kite-ai/ui/desktop';
import type { MouseEventHandler, ReactNode } from 'react';

/** One visual row owns its separator and selection marker; trailing controls stay independent. */
export function NativeSettingsListRow({
  label,
  title,
  description,
  metadata,
  status,
  actions,
  selected,
  controls,
  disabled,
  onOpen,
}: {
  label: string;
  title: string;
  description?: ReactNode;
  metadata?: ReactNode;
  status: ReactNode;
  actions?: ReactNode;
  selected: boolean;
  controls?: string;
  disabled?: boolean;
  onOpen: MouseEventHandler<HTMLButtonElement>;
}) {
  return (
    <li className="settings-list-row" data-selected={selected || undefined}>
      <Button
        type="button"
        className="settings-list-row-trigger"
        variant="ghost"
        aria-label={label}
        aria-expanded={selected}
        aria-controls={controls}
        disabled={disabled}
        onClick={onOpen}
      >
        <span className="provider-instance-info">
          <strong>{title}</strong>
          {description && <span className="settings-catalogue-summary">{description}</span>}
          {metadata && <span>{metadata}</span>}
        </span>
        <span className="settings-list-row-status">{status}</span>
      </Button>
      {actions && <div className="settings-list-row-actions">{actions}</div>}
    </li>
  );
}
