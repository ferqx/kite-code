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
import type { OutputFileFormat } from './output-file-format';

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

const documentIcons: Record<
  NonNullable<OutputFileFormat['documentIcon']>,
  { page: string; fold: string; badge: string; detail: string; glyph: string; glyphWidth?: number }
> = {
  word: {
    page: '#2563eb',
    fold: '#97ccff',
    badge: '#163f9e',
    detail: 'M7 7.5h4M7 10.5h10',
    glyph: 'm9.5 15 1.3 4 1.2-3 1.2 3 1.3-4',
  },
  excel: {
    page: '#168347',
    fold: '#92e5a6',
    badge: '#0b5532',
    detail: 'M7 6.5h4v4.5H7zM9 6.5V11M7 8.75h4M13.5 10.5H17',
    glyph: 'm10 15 4 4m0-4-4 4',
  },
  powerpoint: {
    page: '#c55124',
    fold: '#ffba8f',
    badge: '#943520',
    detail: 'M10 6v2.8h2.8A2.8 2.8 0 1 1 10 6ZM14.5 10.5H17',
    glyph: 'M10.5 19v-4h2.4a1.2 1.2 0 0 1 0 2.4h-2.4',
  },
  access: {
    page: '#bc315c',
    fold: '#ffaac3',
    badge: '#872245',
    detail: 'M7 7.5a2 1 0 1 0 4 0 2 1 0 1 0-4 0zM7 7.5V10a2 1 0 0 0 4 0V7.5M14 10.5h3',
    glyph: 'm9.8 19 2.2-4 2.2 4m-3.7-1.2h3',
  },
  outlook: {
    page: '#067ab8',
    fold: '#97deff',
    badge: '#07527e',
    detail: 'M7 6.5h4v4H7zM7 7l2 1.5L11 7m2.5 3.5H17',
    glyph: 'M14 17a2 2 0 1 0-4 0 2 2 0 1 0 4 0Z',
  },
  onenote: {
    page: '#8b41bd',
    fold: '#e4b8ff',
    badge: '#5d2587',
    detail: 'M7 6.5h3.75v4.75H7zM8 6.5v4.75m5-.75h4',
    glyph: 'M10 19v-4l4 4v-4',
  },
  visio: {
    page: '#4a5bc9',
    fold: '#b9caff',
    badge: '#334096',
    detail: 'M7 6.5h3v2H7zM13 9.25h3v2h-3zM10 7.5h1.5v2.75H13',
    glyph: 'm9.9 15 2.1 4 2.1-4',
  },
  project: {
    page: '#19804f',
    fold: '#9ce7bd',
    badge: '#125e43',
    detail: 'M7 6.5h4M8.5 8.5h4M10.5 10.5H17',
    glyph: 'M9 19v-4h1.7a1.05 1.05 0 0 1 0 2.1H9m6-2.1v2.9a1.15 1.15 0 0 1-2 .8',
    glyphWidth: 1.35,
  },
  publisher: {
    page: '#168478',
    fold: '#99e6d8',
    badge: '#0d5a56',
    detail: 'M7 6.5h4V11H7zm6 3.75h4',
    glyph: 'M8.5 19v-4h1.7a1.05 1.05 0 0 1 0 2.1H8.5m5-2.1v2.5a1.5 1.5 0 0 0 3 0V15',
    glyphWidth: 1.35,
  },
  loop: {
    page: '#6753cc',
    fold: '#c5b7ff',
    badge: '#4b369b',
    detail: 'M7 7h4m-4 3.5h10',
    glyph: 'M12 17c-1.4-2.5-4.1-2.6-4.1 0s2.7 2.5 4.1 0 4.1-2.6 4.1 0-2.7 2.5-4.1 0Z',
    glyphWidth: 1.35,
  },
  whiteboard: {
    page: '#2488c8',
    fold: '#a8e6ff',
    badge: '#215b95',
    detail: 'm7 10.5 1.2-2 1.6 1L11 7m2 3.5h4',
    glyph: 'm9.2 19 .5-2 3.8-2.8 1.2 1.6-3.8 2.9z',
    glyphWidth: 1.35,
  },
  infopath: {
    page: '#9a3a79',
    fold: '#fbb8e3',
    badge: '#6d2658',
    detail: 'm7 8 1 1 2.3-2.2m1.5 3.7H17M7 11h2',
    glyph: 'M10.5 19v-4H14m-3.5 2h2.7',
  },
  clipchamp: {
    page: '#614ac7',
    fold: '#cdbaff',
    badge: '#453392',
    detail: 'M7 7h4v3.5H7zm5.5 3.5H17',
    glyph: 'M10 14.75 14.25 17 10 19.25z',
    glyphWidth: 1.4,
  },
  sharepoint: {
    page: '#0e7d91',
    fold: '#91e0e6',
    badge: '#085b69',
    detail:
      'm8 8 2.5-1 3 3.5M9 8a1 1 0 1 0-2 0 1 1 0 0 0 2 0zm5.5 2.5a1 1 0 1 0-2 0 1 1 0 0 0 2 0z',
    glyph: 'M14 15.4h-2.7a.8.8 0 0 0 0 1.6h1.4a1 1 0 0 1 0 2H10',
  },
  pdf: {
    page: '#d93948',
    fold: '#ffabb3',
    badge: '#a22232',
    detail: 'M7 7.5h4M7 10.5h10',
    glyph: 'M6 19v-4h1.2a1.1 1.1 0 0 1 0 2.2H6m4.5-2.2h1a2 2 0 0 1 0 4h-1zm5.1 4v-4h2.5m-2.5 1.9h2',
    glyphWidth: 1.15,
  },
};

export function FileTypeIcon({
  format: { kind, documentIcon },
  className,
}: {
  format: OutputFileFormat;
  className?: string;
}) {
  if (documentIcon) {
    const { page, fold, badge, detail, glyph, glyphWidth = 1.65 } = documentIcons[documentIcon];
    return (
      <svg
        className={className}
        width="1em"
        height="1em"
        viewBox="0 0 24 24"
        aria-hidden="true"
        data-file-kind={kind}
        data-document-icon={documentIcon}
      >
        <path
          d="M6 1.5h7.5l6.5 6.5v12.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-17a2 2 0 0 1 2-2Z"
          fill={page}
        />
        <path d="M13.5 1.5 20 8h-4.5a2 2 0 0 1-2-2z" fill={fold} />
        <path d={detail} fill="none" stroke={fold} strokeWidth="1.2" strokeLinecap="round" />
        <rect x="2" y="12.75" width="20" height="8.5" rx="2" fill={badge} />
        <path
          d={glyph}
          fill="none"
          stroke="white"
          strokeWidth={glyphWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  const Icon = fileTypeIcons[kind];
  return <Icon className={className} weight="duotone" aria-hidden="true" data-file-kind={kind} />;
}
