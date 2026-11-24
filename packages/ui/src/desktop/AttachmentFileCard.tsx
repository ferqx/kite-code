import { File01Icon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import type { ReactNode } from 'react';
import { Attachment, AttachmentMedia, AttachmentTitle } from './components/ui/attachment';
import { FileTypeIcon } from './FileTypeIcon';
import { outputFileFormat } from './output-file-format';

export function AttachmentFileCard({ name, children }: { name: string; children?: ReactNode }) {
  const format = outputFileFormat(name);
  return (
    <Attachment orientation="vertical" className="composer-attachment">
      <AttachmentMedia className="composer-attachment-preview">
        {format.documentIcon ? (
          <FileTypeIcon format={format} />
        ) : (
          <HugeiconsIcon icon={File01Icon} aria-hidden="true" />
        )}
      </AttachmentMedia>
      <AttachmentTitle className="composer-attachment-name" title={name}>
        {name}
      </AttachmentTitle>
      {children}
    </Attachment>
  );
}
