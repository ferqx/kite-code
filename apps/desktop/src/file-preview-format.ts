/** Classification selects a presentation, never grants access to the underlying file. */
export function filePreviewFormat(name: string, mediaType = '') {
  const extension = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase();
  if (extension && ['docx', 'xlsx', 'pptx'].includes(extension)) return 'office';
  if (extension === 'pdf' || mediaType === 'application/pdf') return 'pdf';
  if (extension && ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image';
  if (/^image\/(png|jpeg|webp|gif)$/.test(mediaType)) return 'image';
  if (extension && ['md', 'markdown'].includes(extension)) return 'markdown';
  if (
    extension &&
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'mjs',
      'cjs',
      'py',
      'rs',
      'go',
      'java',
      'c',
      'h',
      'cpp',
      'hpp',
      'cs',
      'swift',
      'kt',
      'sh',
      'bash',
      'zsh',
      'ps1',
      'bat',
      'cmd',
      'html',
      'htm',
      'css',
      'scss',
      'vue',
      'svelte',
      'sql',
      'json',
      'yaml',
      'yml',
      'toml',
      'xml',
      'svg',
    ].includes(extension)
  )
    return 'code';
  if (extension && ['txt', 'log', 'csv', 'tsv'].includes(extension)) return 'text';
  if (mediaType.startsWith('text/')) return 'text';
  return 'unknown';
}
