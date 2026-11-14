import { useState } from 'react';
import type { OfficeExcelSelectionView, OfficeSelection } from './output-files-bridge';
import './native-office-toolbar.css';

export function NativeOfficeToolbar(props: {
  name: string;
  source: string;
  powerpoint: boolean;
  ready: boolean;
  zoom: number | 'fit';
  presentation: boolean;
  onZoom: (zoom: number | 'fit') => void;
  onPresentation: () => void;
  onEdit?: () => void;
  onSave?: () => void;
}) {
  return (
    <fieldset
      className="native-office-toolbar"
      aria-label={`${props.name} 预览工具栏`}
      aria-description="只读预览，排版可能与 Office 不同；复杂 3D 与动画不受支持。"
      title={`${props.source}。只读预览，排版可能与 Office 不同；复杂 3D 与动画不受支持。`}
    >
      {props.onEdit && (
        <div className="native-office-pill native-office-edit-actions">
          <button type="button" onClick={props.onEdit}>
            请求修改
          </button>
        </div>
      )}
      <div className="native-office-pill native-office-view-actions">
        <select
          aria-label="预览缩放"
          value={props.zoom}
          disabled={!props.ready}
          onChange={(event) =>
            props.onZoom(event.target.value === 'fit' ? 'fit' : Number(event.target.value))
          }
        >
          <option value="fit">适应窗口</option>
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((zoom) => (
            <option key={zoom} value={zoom}>
              {zoom * 100}%
            </option>
          ))}
        </select>
        {props.powerpoint && (
          <button
            type="button"
            disabled={!props.ready}
            className="native-office-icon-button"
            aria-label={props.presentation ? '退出放映' : '放映'}
            title={props.presentation ? '退出放映' : '放映'}
            aria-pressed={props.presentation}
            onClick={props.onPresentation}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              {props.presentation ? (
                <rect x="6" y="6" width="12" height="12" rx="1" />
              ) : (
                <path d="m8 4 12 8-12 8Z" strokeLinejoin="round" />
              )}
            </svg>
          </button>
        )}
      </div>
      {props.onSave && (
        <div className="native-office-pill native-office-file-actions">
          <button
            type="button"
            className="native-office-icon-button"
            aria-label="另存为"
            title="另存为"
            onClick={props.onSave}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5" />
            </svg>
          </button>
        </div>
      )}
    </fieldset>
  );
}

/** Document strings are text only, never markup or commands. */
export function NativeExcelReadonlyBar(props: {
  selection: OfficeSelection | null;
  view?: OfficeExcelSelectionView;
  ready: boolean;
  onLocate: (serial: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const selection =
    props.selection?.kind === 'excel' && 'cells' in props.selection ? props.selection : undefined;
  const active = selection?.cells.find((cell) => cell.address === props.view?.activeAddress);
  const addresses = selection?.range.split(':');
  const coordinate = (address: string) => {
    const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(address);
    if (!match) return undefined;
    let column = 0;
    for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
    return { column, row: Number(match[2]) };
  };
  const start = addresses?.[0] ? coordinate(addresses[0]) : undefined;
  const end = addresses?.length ? coordinate(addresses[addresses.length - 1]!) : undefined;
  const dimensions =
    start && end ? `${end.row - start.row + 1} 行 × ${end.column - start.column + 1} 列` : '';
  return (
    <section className="native-excel-readonly" aria-label="单元格信息">
      <div className="native-excel-readonly-row native-office-pill">
        <button
          type="button"
          aria-label="定位当前选区"
          title="定位当前选区"
          disabled={!props.ready || !active || !props.view}
          onClick={() => {
            if (props.ready && active && props.view) props.onLocate(props.view.selectionSerial);
          }}
        >
          {selection?.range ?? '未选择'}
        </button>
        <span className="native-excel-dimensions">{dimensions}</span>
        <label className="native-excel-value">
          <span>
            {props.view?.activeAddress ?? '值'}
            {active?.formula ? ' · fx' : ''}
          </span>
          <textarea
            aria-label={active?.formula ? '单元格公式（只读）' : '单元格值（只读）'}
            readOnly
            rows={expanded ? 5 : 1}
            value={active?.formula ?? active?.value ?? ''}
          />
        </label>
        <button
          type="button"
          aria-label={expanded ? '收起单元格内容' : '展开单元格内容'}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? '收起' : '展开'}
        </button>
      </div>
    </section>
  );
}
