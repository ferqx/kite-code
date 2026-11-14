import {
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import type { SessionOutputFileTarget } from './SessionTabs';
import { Button } from './ui';

export interface OutputFileSummary extends SessionOutputFileTarget {
  readonly ownerRunId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: string;
  readonly publishedAt: string;
}
export interface OutputCollectionSummary {
  collectionId: string;
  ownerRunId: string;
  state: 'pending' | 'failed' | 'ready';
  expectedCount: number | null;
  publishedCount: number;
  errorCode?: string;
  retryUntil?: string;
}
export interface OutputFilesProps {
  items: readonly OutputFileSummary[];
  collections?: readonly OutputCollectionSummary[];
  onOpen: (file: OutputFileSummary) => void;
  onSave: (file: OutputFileSummary) => void;
  onEdit: (file: OutputFileSummary) => void;
  onRetry?: (collectionId: string) => void;
  turnLabel?: (runId: string) => string;
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
function FileRow({
  file,
  distinguish = false,
  ...props
}: Omit<OutputFilesProps, 'items'> & { file: OutputFileSummary; distinguish?: boolean }) {
  const titleId = useId();
  const detailId = useId();
  return (
    <li
      className="output-file-card"
      aria-labelledby={titleId}
      aria-describedby={distinguish ? detailId : undefined}
    >
      <span className="output-file-icon" aria-hidden="true">
        <HugeiconsIcon icon={File01Icon} />
      </span>
      <div className="output-file-description">
        <span id={titleId} className="output-file-name" title={file.name}>
          {file.name}
        </span>
        <small>{fileType(file)}</small>
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
        aria-describedby={distinguish ? detailId : undefined}
      >
        打开
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label={`${file.name} 的更多操作`}>
            <HugeiconsIcon icon={MoreHorizontalIcon} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" aria-label={`${file.name} 的更多操作`}>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            {file.size} 字节{props.turnLabel ? ` · ${props.turnLabel(file.ownerRunId)}` : ''}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => props.onSave(file)}>另存为</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => props.onEdit(file)}>继续修改</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}
export function OutputFiles(props: OutputFilesProps) {
  const repeated = duplicateNames(props.items);
  const statuses =
    props.collections?.filter(
      (item) =>
        // A producer that never entered collection is a tool-step fact, not an output error.
        // Its execution history remains authoritative; this does not infer recovery from cards.
        item.errorCode !== 'producer_failed' &&
        (item.state === 'failed' || (item.state === 'pending' && (item.expectedCount ?? 0) > 0)),
    ) ?? [];
  if (!props.items.length && !statuses.length) return null;
  return (
    <section className="turn-output-files" aria-label="本次产出">
      {props.items.length > 0 && (
        <ul>
          {props.items.map((file) => (
            <FileRow
              {...props}
              key={JSON.stringify([file.storeId, file.sessionId, file.fileId])}
              file={file}
              distinguish={repeated.has(file.name)}
            />
          ))}
        </ul>
      )}
      {statuses.map((collection) => (
        <div
          key={collection.collectionId}
          role={collection.state === 'failed' ? 'alert' : 'status'}
        >
          {collection.errorCode === 'output_staging_expired' ||
          (collection.retryUntil && Date.parse(collection.retryUntil) <= Date.now())
            ? '暂存文件已过期，请重新生成'
            : collection.errorCode === 'producer_stop_unknown'
              ? '生成结果未知，未收集该次输出'
              : collection.state === 'failed'
                ? '文件整理失败'
                : '正在整理输出文件'}
          {collection.errorCode && <small> · {collection.errorCode}</small>}
          {collection.state === 'failed' &&
            props.onRetry &&
            collection.errorCode !== 'output_staging_expired' &&
            collection.retryUntil &&
            Date.parse(collection.retryUntil) > Date.now() && (
              <Button variant="ghost" onClick={() => props.onRetry?.(collection.collectionId)}>
                重试整理
              </Button>
            )}
        </div>
      ))}
    </section>
  );
}
export function OutputReferences(
  props: OutputFilesProps & {
    hasMore?: boolean;
    loading?: boolean;
    onMore?: () => void;
    error?: string;
  },
) {
  const [expanded, setExpanded] = useState(false);
  const items = expanded ? props.items : props.items.slice(0, 5);
  const repeated = duplicateNames(items);
  return (
    <section className="output-references" aria-label="参考">
      <h4>
        <HugeiconsIcon icon={File01Icon} aria-hidden="true" />
        参考
      </h4>
      {!items.length && (
        <small>{props.loading ? '读取中…' : props.error ? '暂时无法读取参考项' : '暂无'}</small>
      )}
      {!!items.length && props.error && (
        <small role="status">暂时无法更新参考，当前显示上次结果</small>
      )}
      <ul>
        {items.map((file) => (
          <li key={JSON.stringify([file.storeId, file.sessionId, file.fileId])}>
            <button
              type="button"
              className="output-reference-link"
              title={file.name}
              aria-label={`打开 ${file.name}${repeated.has(file.name) ? `，${collectionTime(file.publishedAt)}，${file.size} 字节` : ''}`}
              onClick={() => props.onOpen(file)}
            >
              <HugeiconsIcon icon={referenceIcon(file)} aria-hidden="true" />
              <span>{file.name}</span>
            </button>
          </li>
        ))}
      </ul>
      {props.items.length > 5 && !expanded && (
        <Button variant="ghost" onClick={() => setExpanded(true)}>
          展开更多
        </Button>
      )}
      {(expanded || props.items.length <= 5) && props.hasMore && (
        <Button variant="ghost" disabled={props.loading} onClick={props.onMore}>
          加载更多
        </Button>
      )}
    </section>
  );
}
