import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from 'react';
import type { OfficeExcelSelectionView, OfficeSelection } from './output-files-bridge';
import './native-office-toolbar.css';

const iconPaths = {
  edit: 'm15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15v5Z',
  save: 'M12 3v12m-4-4 4 4 4-4M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
  play: 'm8 4 12 8-12 8Z',
  stop: 'M6 6h12v12H6z',
  down: 'm6 9 6 6 6-6',
  more: 'M5 12h.1m6.9 0h.1m6.9 0h.1',
};

export function PreviewIcon({ name }: { name: keyof typeof iconPaths }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === 'more' ? 3.5 : 1.65}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={iconPaths[name]} />
    </svg>
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
  editDisabled?: boolean;
  onEdit?: () => void;
  more?: ReactNode;
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
      {(props.onEdit || props.onSave || props.more) && (
        <fieldset className="native-preview-file-actions" aria-label="文件操作">
          {(props.onEdit || props.more) && (
            <div className="native-preview-capsule">
              {props.onEdit && (
                <button
                  type="button"
                  aria-label={props.editLabel}
                  title={props.editLabel}
                  disabled={props.editDisabled}
                  onClick={props.onEdit}
                >
                  <PreviewIcon name="edit" />
                </button>
              )}
              {props.more}
            </div>
          )}
          {props.onSave && (
            <button
              className="native-preview-save"
              type="button"
              aria-label="另存为"
              title="另存为"
              onClick={props.onSave}
            >
              <PreviewIcon name="save" />
            </button>
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
  onEdit?: () => void;
  onSave?: () => void;
  skill?: {
    id: string;
    options: { id: string; name: string }[];
    select: (id: string) => void;
  };
}) {
  const cell = selectedCell(props.excel);
  const [expandedSerial, setExpandedSerial] = useState<number | null>(null);
  const expanded = !!cell?.text && expandedSerial === cell.serial;
  // A reopened preview can reuse a serial; a retired selection must not reopen its details.
  if (expandedSerial !== null && !expanded) setExpandedSerial(null);
  const detailsId = useId();
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
  const skill = props.onEdit ? props.skill : undefined;
  const selectedSkill = skill?.options.find((option) => option.id === skill.id);
  return (
    <>
      <NativePreviewToolbar
        name={props.name}
        description={description}
        title={`${props.source}。${description}`}
        editLabel="请求修改"
        editDisabled={!props.ready}
        onEdit={props.onEdit}
        onSave={props.onSave}
        align={props.excel ? 'end' : undefined}
        reading={
          <>
            <span className="native-preview-zoom">
              <select
                className="ui-form-control"
                aria-label="预览缩放"
                title="预览缩放"
                disabled={!props.ready}
                value={props.zoom}
                onChange={(event) =>
                  props.onZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))
                }
              >
                <option value="fit">适应</option>
                {[0.5, 0.75, 1, 1.25, 1.5, 2].map((zoom) => (
                  <option key={zoom} value={zoom}>
                    {zoom * 100}%
                  </option>
                ))}
              </select>
              <PreviewIcon name="down" />
            </span>
            {props.powerpoint && (
              <button
                type="button"
                disabled={!props.ready}
                aria-label={playLabel}
                title={playLabel}
                aria-pressed={props.presentation}
                onClick={props.onPresentation}
              >
                <PreviewIcon name={props.presentation ? 'stop' : 'play'} />
              </button>
            )}
          </>
        }
        more={
          skill && (
            <span className="native-preview-more">
              <select
                className="ui-form-control"
                aria-label="修改 Skill"
                title={selectedSkill ? `修改 Skill：${selectedSkill.name}` : '修改 Skill'}
                disabled={!props.ready}
                value={skill.id}
                onChange={(event) => skill.select(event.target.value)}
              >
                <optgroup label="修改 Skill">
                  <option value="">自动选择</option>
                  {skill.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <PreviewIcon name="more" />
            </span>
          )
        }
      />
      {cell && (
        <fieldset className="native-excel-readonly" aria-label="单元格信息">
          <button
            type="button"
            className="native-excel-range"
            aria-label="定位当前选区"
            aria-description={cell.identity}
            title={`定位当前选区：${cell.identity}`}
            disabled={!props.ready}
            onClick={() => props.excel?.onLocate(cell.serial)}
          >
            {cell.address}
          </button>
          {cell.text !== '' && (
            <>
              <label className="native-excel-value" title={`${cell.address} · ${cell.label}`}>
                {cell.formula && <i aria-hidden="true">ƒx</i>}
                <textarea
                  className="ui-form-control"
                  aria-label={cell.label}
                  onKeyDown={dismissExpanded}
                  aria-description={cell.identity}
                  readOnly
                  rows={1}
                  wrap="off"
                  value={cell.text}
                />
              </label>
              <button
                className="native-excel-expand"
                ref={expandButton}
                onKeyDown={dismissExpanded}
                type="button"
                title={expanded ? '收起单元格内容' : '展开单元格内容'}
                aria-label={expanded ? '收起单元格内容' : '展开单元格内容'}
                aria-expanded={expanded}
                aria-controls={expanded ? detailsId : undefined}
                onClick={() => setExpandedSerial(expanded ? null : cell.serial)}
              >
                <PreviewIcon name="down" />
              </button>
            </>
          )}
        </fieldset>
      )}
      {expanded && cell && (
        <label className="native-excel-details" id={detailsId}>
          <span>{cell.identity}</span>
          <textarea
            className="ui-form-control"
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
