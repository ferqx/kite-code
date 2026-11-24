export type OutputFileKind =
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'pdf'
  | 'image'
  | 'markdown'
  | 'text'
  | 'code'
  | 'archive'
  | 'audio'
  | 'video'
  | 'unknown';

type OutputFileFormat = { kind: OutputFileKind; label: string };
type KnownFormat = OutputFileFormat & {
  extensions: readonly string[];
  mediaTypes?: readonly string[];
};

const formats: readonly KnownFormat[] = [
  {
    kind: 'document',
    label: 'Word 文档',
    extensions: ['doc', 'docx'],
    mediaTypes: [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  {
    kind: 'spreadsheet',
    label: 'Excel 工作簿',
    extensions: ['xls', 'xlsx'],
    mediaTypes: [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },
  {
    kind: 'presentation',
    label: 'PPT 演示文稿',
    extensions: ['ppt', 'pptx'],
    mediaTypes: [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  {
    kind: 'document',
    label: 'OpenDocument 文档',
    extensions: ['odt'],
    mediaTypes: ['application/vnd.oasis.opendocument.text'],
  },
  {
    kind: 'spreadsheet',
    label: 'OpenDocument 表格',
    extensions: ['ods'],
    mediaTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
  },
  {
    kind: 'presentation',
    label: 'OpenDocument 演示文稿',
    extensions: ['odp'],
    mediaTypes: ['application/vnd.oasis.opendocument.presentation'],
  },
  {
    kind: 'document',
    label: 'RTF 文档',
    extensions: ['rtf'],
    mediaTypes: ['application/rtf', 'text/rtf'],
  },
  { kind: 'pdf', label: 'PDF 文档', extensions: ['pdf'], mediaTypes: ['application/pdf'] },
  { kind: 'image', label: 'PNG 图片', extensions: ['png'], mediaTypes: ['image/png'] },
  { kind: 'image', label: 'JPEG 图片', extensions: ['jpg', 'jpeg'], mediaTypes: ['image/jpeg'] },
  { kind: 'image', label: 'GIF 图片', extensions: ['gif'], mediaTypes: ['image/gif'] },
  { kind: 'image', label: 'WebP 图片', extensions: ['webp'], mediaTypes: ['image/webp'] },
  { kind: 'image', label: 'SVG 矢量图', extensions: ['svg'], mediaTypes: ['image/svg+xml'] },
  {
    kind: 'image',
    label: '图片',
    extensions: ['bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'ico'],
  },
  {
    kind: 'markdown',
    label: 'Markdown 文档',
    extensions: ['md', 'markdown', 'mdx'],
    mediaTypes: ['text/markdown', 'text/x-markdown'],
  },
  { kind: 'text', label: '文本文件', extensions: ['txt'], mediaTypes: ['text/plain'] },
  { kind: 'text', label: '日志文件', extensions: ['log'] },
  { kind: 'spreadsheet', label: 'CSV 表格', extensions: ['csv'], mediaTypes: ['text/csv'] },
  {
    kind: 'spreadsheet',
    label: 'TSV 表格',
    extensions: ['tsv'],
    mediaTypes: ['text/tab-separated-values'],
  },
  { kind: 'code', label: 'JSON 文件', extensions: ['json'], mediaTypes: ['application/json'] },
  {
    kind: 'code',
    label: 'XML 文件',
    extensions: ['xml'],
    mediaTypes: ['application/xml', 'text/xml'],
  },
  {
    kind: 'code',
    label: 'YAML 文件',
    extensions: ['yaml', 'yml'],
    mediaTypes: ['application/yaml', 'text/yaml'],
  },
  { kind: 'code', label: 'HTML 文档', extensions: ['html', 'htm'], mediaTypes: ['text/html'] },
  {
    kind: 'code',
    label: '源代码',
    extensions: [
      'js',
      'mjs',
      'cjs',
      'jsx',
      'ts',
      'tsx',
      'css',
      'vue',
      'py',
      'go',
      'rs',
      'java',
      'c',
      'h',
      'cpp',
      'sql',
      'sh',
      'ps1',
    ],
    mediaTypes: [
      'application/javascript',
      'text/javascript',
      'text/typescript',
      'text/css',
      'text/x-python',
    ],
  },
  {
    kind: 'archive',
    label: 'ZIP 压缩包',
    extensions: ['zip'],
    mediaTypes: ['application/zip', 'application/x-zip-compressed'],
  },
  {
    kind: 'archive',
    label: '压缩包',
    extensions: ['7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
    mediaTypes: [
      'application/x-7z-compressed',
      'application/vnd.rar',
      'application/x-rar-compressed',
      'application/x-tar',
      'application/gzip',
    ],
  },
  {
    kind: 'audio',
    label: '音频文件',
    extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'],
  },
  { kind: 'video', label: '视频文件', extensions: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v'] },
];

const byExtension = new Map(
  formats.flatMap((format) => format.extensions.map((extension) => [extension, format] as const)),
);
const byMediaType = new Map(
  formats.flatMap((format) => format.mediaTypes?.map((type) => [type, format] as const) ?? []),
);
const byMediaFamily = new Map<string, OutputFileFormat>([
  ['image', { kind: 'image', label: '图片' }],
  ['audio', { kind: 'audio', label: '音频文件' }],
  ['video', { kind: 'video', label: '视频文件' }],
  ['text', { kind: 'text', label: '文本文件' }],
]);

export function outputFileFormat(path: string, mediaType = ''): OutputFileFormat {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
  const mime = (mediaType.split(';', 1)[0] ?? '').trim().toLowerCase();
  return (
    byExtension.get(extension) ??
    byMediaType.get(mime) ??
    byMediaFamily.get(mime.split('/', 1)[0] ?? '') ?? { kind: 'unknown', label: '文件' }
  );
}
