import {
  FileAudioIcon,
  FileCodeIcon,
  FileDocIcon,
  FileIcon,
  FileImageIcon,
  FileMdIcon,
  FilePdfIcon,
  FilePptIcon,
  FileTextIcon,
  FileVideoIcon,
  FileXlsIcon,
  FileZipIcon,
} from '@phosphor-icons/react';
import type { OutputFileKind } from './output-file-format';

const fileTypeIcons = {
  document: FileDocIcon,
  spreadsheet: FileXlsIcon,
  presentation: FilePptIcon,
  pdf: FilePdfIcon,
  image: FileImageIcon,
  markdown: FileMdIcon,
  text: FileTextIcon,
  code: FileCodeIcon,
  archive: FileZipIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  unknown: FileIcon,
};

export function FileTypeIcon({ kind, className }: { kind: OutputFileKind; className?: string }) {
  const Icon = fileTypeIcons[kind];
  return <Icon className={className} weight="duotone" aria-hidden="true" data-file-kind={kind} />;
}
