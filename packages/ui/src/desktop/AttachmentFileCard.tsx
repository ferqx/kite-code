import { File01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';

export function AttachmentFileCard({ name, children }: { name: string; children?: ReactNode }) {
  return (
    <div className="composer-attachment">
      <div className="composer-attachment-preview">
        <HugeiconsIcon icon={File01Icon} aria-hidden="true" />
      </div>
      <span className="composer-attachment-name" title={name}>
        {name}
      </span>
      {children}
    </div>
  );
}
