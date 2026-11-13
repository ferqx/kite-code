import { useState } from 'react';
import type { SessionFileTarget } from './SessionTabs';
import { Button } from './ui';

export interface OutputFileSummary extends SessionFileTarget {
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
function FileRow({
  file,
  ...props
}: Omit<OutputFilesProps, 'items'> & { file: OutputFileSummary }) {
  return (
    <li className="output-file-card">
      <Button variant="ghost" onClick={() => props.onOpen(file)}>
        {file.name}
      </Button>
      <small>
        {file.size} 字节{props.turnLabel ? ` · ${props.turnLabel(file.ownerRunId)}` : ''}
      </small>
      <Button variant="ghost" onClick={() => props.onSave(file)}>
        另存为
      </Button>
      <Button variant="ghost" onClick={() => props.onEdit(file)}>
        继续修改
      </Button>
    </li>
  );
}
export function OutputFiles(props: OutputFilesProps) {
  const statuses =
    props.collections?.filter(
      (item) =>
        item.state === 'failed' || (item.state === 'pending' && (item.expectedCount ?? 0) > 0),
    ) ?? [];
  if (!props.items.length && !statuses.length) return null;
  return (
    <section className="turn-output-files" aria-label="已保存的文件">
      {props.items.length > 0 && (
        <>
          <h4>已保存的文件</h4>
          <ul>
            {props.items.map((file) => (
              <FileRow
                {...props}
                key={JSON.stringify([file.storeId, file.sessionId, file.fileId])}
                file={file}
              />
            ))}
          </ul>
        </>
      )}
      {statuses.map((collection) => (
        <div
          key={collection.collectionId}
          role={collection.state === 'failed' ? 'alert' : 'status'}
        >
          {collection.errorCode === 'output_staging_expired' ||
          (collection.retryUntil && Date.parse(collection.retryUntil) <= Date.now())
            ? '暂存文件已过期，请重新生成'
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
  return (
    <section className="output-references" aria-label="参考项">
      <h4>参考项</h4>
      {!items.length && (
        <small>{props.loading ? '读取中…' : props.error ? '暂时无法读取参考项' : '暂无'}</small>
      )}
      <ul>
        {items.map((file) => (
          <FileRow
            {...props}
            key={JSON.stringify([file.storeId, file.sessionId, file.fileId])}
            file={file}
          />
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
