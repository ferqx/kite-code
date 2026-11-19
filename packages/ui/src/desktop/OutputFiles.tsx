import {
  ArrowRight01Icon,
  Attachment01Icon,
  File01Icon,
  FileImageIcon,
  FilePenIcon,
  FileQuestionMarkIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  MoreHorizontalIcon,
  Pdf01Icon,
  Ppt01Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useId, useState } from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { Spinner } from './components/ui/spinner';
import type { SessionOutputFileTarget } from './SessionTabs';
import { Button } from './ui';

export interface OutputFileSummary extends SessionOutputFileTarget {
  readonly ownerRunId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: string;
  readonly publishedAt: string;
  /** Presentation only; immutable file targets retain their original source scope. */
  readonly sourceLabel?: string;
}
export interface OutputFilesProps {
  items: readonly OutputFileSummary[];
  onOpen: (file: OutputFileSummary) => void;
  onSave: (file: OutputFileSummary) => void;
  onReveal?: (file: OutputFileSummary) => Promise<void>;
}
function fileType(file: OutputFileSummary) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const labels: Record<string, string> = {
    doc: 'Word 文档',
    docx: 'Word 文档',
    xls: 'Excel 工作簿',
    xlsx: 'Excel 工作簿',
    ppt: '演示文稿',
    pptx: '演示文稿',
    pdf: 'PDF 文档',
    txt: '文本文件',
    md: 'Markdown 文档',
    csv: 'CSV 表格',
    json: 'JSON 文件',
    zip: 'ZIP 压缩包',
  };
  if (extension && labels[extension]) return labels[extension];
  if (file.mediaType.startsWith('image/')) return '图片';
  if (file.mediaType.startsWith('audio/')) return '音频';
  if (file.mediaType.startsWith('video/')) return '视频';
  return '文件';
}
function referenceIcon(file: OutputFileSummary) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const mime = (file.mediaType.toLowerCase().split(';')[0] ?? '').trim();
  if (
    ['doc', 'docx', 'odt', 'rtf'].includes(extension ?? '') ||
    [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.oasis.opendocument.text',
      'application/rtf',
    ].includes(mime)
  )
    return FilePenIcon;
  if (
    ['xls', 'xlsx', 'ods', 'csv', 'tsv'].includes(extension ?? '') ||
    [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.oasis.opendocument.spreadsheet',
      'text/csv',
      'text/tab-separated-values',
    ].includes(mime)
  )
    return FileSpreadsheetIcon;
  if (
    ['ppt', 'pptx', 'odp'].includes(extension ?? '') ||
    [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.presentation',
    ].includes(mime)
  )
    return Ppt01Icon;
  if (extension === 'pdf' || mime === 'application/pdf') return Pdf01Icon;
  if (
    ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff', 'avif'].includes(extension ?? '') ||
    mime.startsWith('image/')
  )
    return FileImageIcon;
  if (
    ['txt', 'md', 'markdown', 'json', 'xml', 'yaml', 'yml', 'log'].includes(extension ?? '') ||
    mime.startsWith('text/') ||
    ['application/json', 'application/xml'].includes(mime)
  )
    return FileTextIcon;
  return FileQuestionMarkIcon;
}
function fileIdentity(file: OutputFileSummary) {
  return JSON.stringify([
    file.storeId,
    file.sessionId,
    file.fileId,
    file.locator.kind,
    file.locator.kind === 'legacy-operation' ? file.locator.executionId : file.locator.key,
  ]);
}
function duplicateNames(items: readonly OutputFileSummary[]) {
  const counts = new Map<string, number>();
  for (const file of items) counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}
function collectionTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '收集时间未知';
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `收集于 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
function OutputFileMenu({
  file,
  onSave,
  onReveal,
}: Partial<Pick<OutputFilesProps, 'onSave' | 'onReveal'>> & { file: OutputFileSummary }) {
  const [revealing, setRevealing] = useState(false);
  const label = `${file.name} 的更多操作`;
  async function reveal() {
    if (!onReveal || revealing) return;
    setRevealing(true);
    try {
      await onReveal(file);
    } finally {
      setRevealing(false);
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-busy={revealing || undefined}
        >
          {revealing ? (
            <Spinner aria-hidden="true" className="motion-reduce:animate-none" />
          ) : (
            <HugeiconsIcon icon={MoreHorizontalIcon} aria-hidden="true" />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={label}>
        {onSave && <DropdownMenuItem onSelect={() => onSave(file)}>另存为</DropdownMenuItem>}
        {onReveal && (
          <DropdownMenuItem disabled={revealing} onSelect={() => void reveal()}>
            在资源管理器中显示
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function FileRow({
  file,
  distinguish = false,
  ...props
}: Omit<OutputFilesProps, 'items'> & { file: OutputFileSummary; distinguish?: boolean }) {
  const titleId = useId();
  const detailId = useId();
  const sourceId = useId();
  const description =
    [file.sourceLabel ? sourceId : '', distinguish ? detailId : ''].filter(Boolean).join(' ') ||
    undefined;
  return (
    <li className="output-file-card" aria-labelledby={titleId} aria-describedby={description}>
      <span className="output-file-icon" aria-hidden="true">
        <HugeiconsIcon icon={File01Icon} />
      </span>
      <div className="output-file-description">
        <span id={titleId} className="output-file-name" title={file.name}>
          {file.name}
        </span>
        <small>{fileType(file)}</small>
        {file.sourceLabel && <small id={sourceId}>{file.sourceLabel}</small>}
        {distinguish && (
          <small id={detailId} className="output-file-distinction">
            {collectionTime(file.publishedAt)} · {file.size} 字节
          </small>
        )}
      </div>
      <Button
        className="output-file-open"
        onClick={() => props.onOpen(file)}
        aria-label={`打开 ${file.name}`}
        aria-describedby={description}
      >
        打开
      </Button>
      <OutputFileMenu file={file} onSave={props.onSave} onReveal={props.onReveal} />
    </li>
  );
}
export function OutputFiles(props: OutputFilesProps) {
  if (!props.items.length) return null;
  const repeated = duplicateNames(props.items);
  return (
    <section className="turn-output-files" aria-label="本次产出">
      <ul>
        {props.items.map((file) => (
          <FileRow
            {...props}
            key={fileIdentity(file)}
            file={file}
            distinguish={repeated.has(file.name)}
          />
        ))}
      </ul>
    </section>
  );
}

export function OutputReferences(
  props: Pick<OutputFilesProps, 'items' | 'onOpen' | 'onReveal'> & {
    onMore?: () => void;
    moreDisabled?: boolean;
  },
) {
  if (!props.items.length && !props.onMore) return null;
  const repeated = duplicateNames(props.items);
  return (
    <section className="output-references background-execution-group" aria-label="输出">
      <h3>
        <HugeiconsIcon icon={Attachment01Icon} aria-hidden="true" />
        <span>输出</span>
      </h3>
      <ul>
        {props.items.map((file) => {
          const dot = file.name.lastIndexOf('.');
          return (
            <li key={fileIdentity(file)}>
              <button
                type="button"
                className="output-reference-link"
                title={[file.name, file.sourceLabel].filter(Boolean).join(' · ')}
                aria-label={`打开 ${file.name}${file.sourceLabel ? `，${file.sourceLabel}` : ''}${repeated.has(file.name) ? `，${collectionTime(file.publishedAt)}，${file.size} 字节` : ''}`}
                onClick={() => props.onOpen(file)}
              >
                <HugeiconsIcon icon={referenceIcon(file)} aria-hidden="true" />
                <span className="output-reference-name">
                  <span>{dot > 0 ? file.name.slice(0, dot) : file.name}</span>
                  {dot > 0 && (
                    <span className="output-reference-extension">{file.name.slice(dot)}</span>
                  )}
                  {file.sourceLabel && (
                    <span className="output-reference-source">{` · ${file.sourceLabel}`}</span>
                  )}
                </span>
                {!props.onReveal && <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />}
              </button>
              {props.onReveal && <OutputFileMenu file={file} onReveal={props.onReveal} />}
            </li>
          );
        })}
      </ul>
      {props.onMore && (
        <Button
          className="output-reference-more"
          variant="ghost"
          disabled={props.moreDisabled}
          onClick={props.onMore}
        >
          加载更多
        </Button>
      )}
    </section>
  );
}
