import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@kite-ai/ui/desktop';
import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { PreviewMenuOption } from './native-preview-menu-bridge';
import type { OfficeExcelSelectionView, OfficeSelection } from './output-files-bridge';
import './native-office-toolbar.css';

const iconPaths = {
  edit: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z',
  save: 'M12 3v12m-4-4 4 4 4-4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  play: 'm8 4 12 8-12 8Z',
  stop: 'M6 6h12v12H6z',
  down: 'm6 9 6 6 6-6',
};
const officeZoomOptions = [
  { value: 'fit', label: '适应' },
  ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((zoom) => ({ value: String(zoom), label: `${zoom * 100}%` })),
];

function PreviewIcon({ name }: { name: keyof typeof iconPaths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name]} />
    </svg>
  );
}

export function NativePreviewZoomSelect({
  label,
  title = label,
  className = 'w-[5.75rem]',
  aboveNativeView = false,
  value,
  customLabel,
  disabled,
  options,
  onChange,
}: {
  label: string;
  title?: string;
  className?: string;
  aboveNativeView?: boolean;
  value: string;
  customLabel?: string;
  disabled: boolean;
  options: readonly PreviewMenuOption[];
  onChange(value: string): void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const request = useRef<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const overlay =
    aboveNativeView && typeof window !== 'undefined' ? window.kitePreviewMenu : undefined;
  useLayoutEffect(() => {
    if (disabled) setPending(false);
    return () => {
      if (request.current) overlay?.close(request.current);
      request.current = undefined;
    };
  }, [overlay, disabled]);
  const openOverlay = (open: boolean) => {
    const button = trigger.current;
    if (!overlay || !button || !open || disabled || request.current) return;
    const id = crypto.randomUUID();
    const { x, y, width, height } = button.getBoundingClientRect();
    request.current = id;
    setPending(true);
    void overlay
      .open({ id, anchor: { x, y, width, height }, label, value, options })
      .catch(() => null)
      .then((selected) => {
        if (request.current !== id) return;
        request.current = undefined;
        setPending(false);
        button.focus({ preventScroll: true });
        if (
          typeof selected === 'string' &&
          options.some((option) => option.value === selected && !option.disabled)
        )
          onChange(selected);
      });
  };
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      open={overlay ? false : undefined}
      onOpenChange={overlay ? openOverlay : undefined}
    >
      <SelectTrigger
        ref={trigger}
        className={`${className} rounded-full text-xs tabular-nums disabled:opacity-50`}
        aria-label={label}
        title={title}
        {...(overlay ? { 'aria-expanded': pending, 'aria-controls': undefined } : {})}
      >
        <SelectValue>
          {customLabel ?? options.find((option) => option.value === value)?.label}
        </SelectValue>
      </SelectTrigger>
      {!overlay && (
        <SelectContent align="start">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      )}
    </Select>
  );
}

/** Renderer chrome stays in normal flow, above (never layered over) the native document. */
export function NativePreviewToolbar(props: {
  name: string;
  title?: string;
  description?: string;
  reading?: ReactNode;
  align?: 'end';
  editLabel?: string;
  onEdit?: () => void;
  onSave?: () => void;
}) {
  return (
    <fieldset
      className={
        props.reading ? 'native-preview-toolbar native-office-toolbar' : 'native-preview-toolbar'
      }
      aria-label={`${props.name} 预览工具栏`}
      aria-description={props.description}
      data-align={props.align}
      title={props.title}
    >
      {props.reading && (
        <fieldset className="native-preview-capsule" aria-label="阅读控制">
          {props.reading}
        </fieldset>
      )}
      {(props.onEdit || props.onSave) && (
        <fieldset className="native-preview-file-actions" aria-label="文件操作">
          {props.onEdit && (
            <Button
              size="icon"
              variant="outline"
              className="rounded-full"
              aria-label={props.editLabel}
              title={props.editLabel}
              onClick={props.onEdit}
            >
              <PreviewIcon name="edit" />
            </Button>
          )}
          {props.onSave && (
            <Button
              size="icon"
              variant="outline"
              className="rounded-full"
              aria-label="另存为"
              title="另存为"
              onClick={props.onSave}
            >
              <PreviewIcon name="save" />
            </Button>
          )}
        </fieldset>
      )}
    </fieldset>
  );
}

type ExcelContext = {
  selection: OfficeSelection | null;
  view?: OfficeExcelSelectionView;
  onLocate: (serial: number) => void;
};

function rangeDimensions(range: string) {
  const coordinate = (address: string) => {
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(address);
    if (!match) return undefined;
    let column = 0;
    for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
    return { column, row: Number(match[2]) };
  };
  const [first, last = first] = range.split(':');
  const start = coordinate(first!),
    end = coordinate(last!);
  return start && end ? `${end.row - start.row + 1} 行 × ${end.column - start.column + 1} 列` : '';
}

function selectedCell(excel?: ExcelContext) {
  const selection = excel?.selection,
    view = excel?.view;
  if (!view || selection?.kind !== 'excel' || !('cells' in selection)) return;
  const cell = selection.cells.find(({ address }) => address === view.activeAddress);
  if (!cell) return;
  const dimensions = rangeDimensions(selection.range);
  return {
    identity: `${selection.range} · ${dimensions} · 起选格 ${cell.address}`,
    address: cell.address,
    formula: !!cell.formula,
    label: cell.formula ? '单元格公式（只读）' : '单元格值（只读）',
    text: cell.formula ?? cell.value,
    serial: view.selectionSerial,
  };
}

export function NativeOfficeToolbar(props: {
  name: string;
  source: string;
  powerpoint: boolean;
  excel?: ExcelContext;
  ready: boolean;
  zoom: number | 'fit';
  presentation: boolean;
  onZoom: (zoom: number | 'fit') => void;
  onPresentation: () => void;
  onSave?: () => void;
}) {
  const cell = selectedCell(props.excel);
  const [expandedSerial, setExpandedSerial] = useState<number | null>(null);
  const expanded = !!cell?.text && expandedSerial === cell.serial;
  // A reopened preview can reuse a serial; a retired selection must not reopen its details.
  if (expandedSerial !== null && !expanded) setExpandedSerial(null);
  const detailsId = useId();
  const valueId = useId();
  const expandButton = useRef<HTMLButtonElement>(null);
  const dismissExpanded = (event: KeyboardEvent) => {
    if (
      !expanded ||
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    setExpandedSerial(null);
    expandButton.current?.focus();
  };
  const playLabel = props.presentation ? '退出放映' : '放映';
  const description = '只读预览，排版可能与 Office 不同；复杂 3D 与动画不受支持。';
  return (
    <>
      <NativePreviewToolbar
        name={props.name}
        description={description}
        title={`${props.source}。${description}`}
        onSave={props.onSave}
        align={props.excel ? 'end' : undefined}
        reading={
          <>
            <NativePreviewZoomSelect
              label="预览缩放"
              disabled={!props.ready}
              value={String(props.zoom)}
              customLabel={props.zoom === 'fit' ? undefined : `${Math.round(props.zoom * 100)}%`}
              onChange={(value) => props.onZoom(value === 'fit' ? 'fit' : Number(value))}
              options={officeZoomOptions}
            />
            {props.powerpoint && (
              <Button
                size="icon"
                variant={props.presentation ? 'secondary' : 'outline'}
                className="rounded-full"
                disabled={!props.ready}
                aria-label={playLabel}
                title={playLabel}
                aria-pressed={props.presentation}
                onClick={props.onPresentation}
              >
                <PreviewIcon name={props.presentation ? 'stop' : 'play'} />
              </Button>
            )}
          </>
        }
      />
      {cell && (
        <fieldset className="native-excel-readonly" aria-label="单元格信息">
          <Button
            variant="ghost"
            size="xs"
            className="native-excel-range"
            aria-label="定位当前选区"
            aria-description={cell.identity}
            title={`定位当前选区：${cell.identity}`}
            disabled={!props.ready}
            onClick={() => props.excel?.onLocate(cell.serial)}
          >
            {cell.address}
          </Button>
          {cell.text !== '' && (
            <>
              <label
                className="native-excel-value"
                htmlFor={valueId}
                title={`${cell.address} · ${cell.label}`}
              >
                {cell.formula && <i aria-hidden="true">ƒx</i>}
                <Textarea
                  id={valueId}
                  aria-label={cell.label}
                  onKeyDown={dismissExpanded}
                  aria-description={cell.identity}
                  readOnly
                  rows={1}
                  wrap="off"
                  value={cell.text}
                />
              </label>
              <Button
                variant="ghost"
                size="icon-sm"
                className="native-excel-expand rounded-full"
                ref={expandButton}
                onKeyDown={dismissExpanded}
                title={expanded ? '收起单元格内容' : '展开单元格内容'}
                aria-label={expanded ? '收起单元格内容' : '展开单元格内容'}
                aria-expanded={expanded}
                aria-controls={expanded ? detailsId : undefined}
                onClick={() => setExpandedSerial(expanded ? null : cell.serial)}
              >
                <PreviewIcon name="down" />
              </Button>
            </>
          )}
        </fieldset>
      )}
      {expanded && cell && (
        <label className="native-excel-details" id={detailsId} htmlFor={`${detailsId}-value`}>
          <span>{cell.identity}</span>
          <Textarea
            id={`${detailsId}-value`}
            aria-label="完整单元格内容（只读）"
            onKeyDown={dismissExpanded}
            readOnly
            rows={5}
            value={cell.text}
          />
        </label>
      )}
    </>
  );
}
