import { ArrowRight01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ButtonGroup } from './components/ui/button-group';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import { ScrollArea } from './components/ui/scroll-area';
import { Spinner } from './components/ui/spinner';
import { FileTypeIcon } from './FileTypeIcon';
import { outputFileFormat } from './output-file-format';
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
  onOpenInApp?: (file: OutputFileSummary) => Promise<void>;
  onSave: (file: OutputFileSummary) => void;
  onReveal?: (file: OutputFileSummary) => Promise<void>;
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
function FileNameParts({ name }: { name: string }) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return <span>{name}</span>;
  return (
    <>
      <span>{name.slice(0, dot)}</span>
      <span className="output-file-extension">{name.slice(dot)}</span>
    </>
  );
}
function OutputFileMenu({
  file,
  onSave,
  onReveal,
  withOpenButton = false,
}: Partial<Pick<OutputFilesProps, 'onSave' | 'onReveal'>> & {
  file: OutputFileSummary;
  withOpenButton?: boolean;
}) {
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
          variant={withOpenButton ? 'outline' : 'ghost'}
          size={withOpenButton ? 'icon' : 'icon-xs'}
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
        <DropdownMenuGroup>
          {onSave && <DropdownMenuItem onSelect={() => onSave(file)}>另存为</DropdownMenuItem>}
          {onReveal && (
            <DropdownMenuItem disabled={revealing} onSelect={() => void reveal()}>
              在资源管理器中显示
            </DropdownMenuItem>
          )}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
function FileRow({
  file,
  distinguish,
  onOpen,
  onOpenInApp,
  onSave,
  onReveal,
}: Omit<OutputFilesProps, 'items'> & { file: OutputFileSummary; distinguish: boolean }) {
  const id = useId();
  const titleId = `${id}-name`;
  const sourceId = `${id}-source`;
  const detailId = `${id}-detail`;
  const opening = useRef(false);
  const [busy, setBusy] = useState(false);
  const format = outputFileFormat(file.name, file.mediaType);
  const description =
    [file.sourceLabel ? sourceId : '', distinguish ? detailId : ''].filter(Boolean).join(' ') ||
    undefined;
  async function open() {
    if (!onOpenInApp) {
      onOpen(file);
      return;
    }
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    try {
      await onOpenInApp(file);
    } finally {
      opening.current = false;
      setBusy(false);
    }
  }
  return (
    <li className="output-file-card" aria-labelledby={titleId} aria-describedby={description}>
      <Button
        className="output-file-preview"
        variant="plain"
        onClick={() => onOpen(file)}
        aria-label={`预览 ${file.name}`}
        aria-describedby={description}
      >
        <FileTypeIcon format={format} className="output-file-icon size-6" />
        <span className="output-file-description">
          <span id={titleId} className="output-file-name" title={file.name}>
            <FileNameParts name={file.name} />
          </span>
          <small className="output-file-type">{format.label}</small>
          {file.sourceLabel && <small id={sourceId}>{file.sourceLabel}</small>}
          {distinguish && (
            <small id={detailId} className="output-file-distinction">
              {collectionTime(file.publishedAt)} ·{' '}
              <span className="whitespace-nowrap">{file.size} 字节</span>
            </small>
          )}
        </span>
      </Button>
      <ButtonGroup className="output-file-actions" aria-label={file.name}>
        <Button
          className="output-file-open"
          variant="outline"
          onClick={open}
          aria-label={`打开 ${file.name}`}
          aria-describedby={description}
          aria-busy={busy || undefined}
          aria-disabled={busy || undefined}
        >
          打开
        </Button>
        <OutputFileMenu file={file} onSave={onSave} onReveal={onReveal} withOpenButton />
      </ButtonGroup>
    </li>
  );
}
export function OutputFiles({ items, ...actions }: OutputFilesProps) {
  if (!items.length) return null;
  const repeated = duplicateNames(items);
  return (
    <section className="turn-output-files" aria-label="本次产出">
      <ul>
        {items.map((file) => (
          <FileRow
            {...actions}
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
  const { onMore, moreDisabled } = props;
  const viewport = useRef<HTMLDivElement>(null);
  const requested = useRef<typeof onMore>(undefined);
  const loadNearEnd = useCallback(
    ({ clientHeight, scrollHeight, scrollTop }: HTMLDivElement) => {
      if (
        onMore &&
        !moreDisabled &&
        requested.current !== onMore &&
        clientHeight > 0 &&
        scrollHeight - scrollTop - clientHeight <= 64
      ) {
        requested.current = onMore;
        onMore();
      }
    },
    [onMore, moreDisabled],
  );
  useEffect(() => {
    const node = viewport.current;
    // Keep loading across a page handoff if the reader already reached the end, or the list cannot scroll yet.
    if (node && (node.scrollTop > 0 || node.scrollHeight <= node.clientHeight)) loadNearEnd(node);
  }, [loadNearEnd]);
  if (!props.items.length && !onMore) return null;
  const repeated = duplicateNames(props.items);
  return (
    <section className="output-references background-execution-group" aria-label="输出">
      <h3>输出</h3>
      <ScrollArea
        className="environment-list-scroll"
        fade="y"
        nativeScrollbars
        viewportRef={viewport}
        viewportProps={{
          'aria-busy': (onMore && moreDisabled) || undefined,
          onScroll: (event) => loadNearEnd(event.currentTarget),
        }}
      >
        <ul>
          {props.items.map((file) => (
            <li key={fileIdentity(file)}>
              <button
                type="button"
                className="output-reference-link"
                title={[file.name, file.sourceLabel].filter(Boolean).join(' · ')}
                aria-label={`打开 ${file.name}${file.sourceLabel ? `，${file.sourceLabel}` : ''}${repeated.has(file.name) ? `，${collectionTime(file.publishedAt)}，${file.size} 字节` : ''}`}
                onClick={() => props.onOpen(file)}
              >
                <FileTypeIcon format={outputFileFormat(file.name, file.mediaType)} />
                <span className="output-reference-name">
                  <FileNameParts name={file.name} />
                  {file.sourceLabel && (
                    <span className="output-reference-source">{` · ${file.sourceLabel}`}</span>
                  )}
                </span>
                {!props.onReveal && <HugeiconsIcon icon={ArrowRight01Icon} aria-hidden="true" />}
              </button>
              {props.onReveal && <OutputFileMenu file={file} onReveal={props.onReveal} />}
            </li>
          ))}
        </ul>
      </ScrollArea>
    </section>
  );
}
