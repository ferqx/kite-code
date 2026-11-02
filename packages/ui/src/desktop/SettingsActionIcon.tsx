import { ArrowDown01Icon, MoreHorizontalIcon, RefreshIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';

const icons = { refresh: RefreshIcon, more: MoreHorizontalIcon, expand: ArrowDown01Icon };

export function SettingsActionIcon({
  name,
  className,
}: {
  name: keyof typeof icons;
  className?: string;
}) {
  return <HugeiconsIcon icon={icons[name]} className={className} aria-hidden="true" />;
}
