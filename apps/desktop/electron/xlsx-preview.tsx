import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';
import type { Workbook, Worksheet } from 'exceljs';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import type { OfficePreviewControl, OfficeSelection } from '../src/output-files-bridge';
import type { OfficeInteraction } from './office-preview-interaction';
import { startOfficePreview } from './office-preview-source';
import { officeChromeCss } from './office-request-input';
import {
  cellDisplay,
  cellStyle,
  columnName,
  makeRange,
  type SheetPosition,
  sheetCell,
  workbookTheme,
} from './xlsx-workbook';

const rowHeader = 43;
const columnHeader = 25;
const fitCellBudget = 16384;

function offsets(count: number, size: (index: number) => number) {
  const values = new Float64Array(count + 1);
  for (let index = 0; index < count; index++) values[index + 1] = values[index]! + size(index);
  return values;
}

type Range = Extract<ReturnType<typeof makeRange>, { selection: unknown }>;
type Request = {
  serial: number;
  selection: OfficeSelection;
  anchor?: HTMLElement;
  consumed: boolean;
};

function sheetDimensions(sheet: Worksheet) {
  const rows = offsets(Math.max(12, sheet.rowCount), (index) => {
    const row = sheet.findRow(index + 1);
    return row?.hidden ? 0 : ((row?.height ?? sheet.properties.defaultRowHeight ?? 15) * 4) / 3;
  });
  const cols = offsets(Math.max(6, sheet.columnCount, sheet.columns?.length ?? 0), (index) => {
    const column = sheet.getColumn(index + 1);
    return column.hidden ? 0 : (column.width ?? sheet.properties.defaultColWidth ?? 10) * 7 + 5;
  });
  return { rows, cols };
}

function mergeBounds(sheet: Worksheet) {
  const byMaster = new Map<string, [number, number, number, number]>();
  function coord(address: string) {
    const match = /^([A-Z]+)([0-9]+)$/.exec(address);
    if (!match) return;
    let column = 0;
    for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
    return [Number(match[2]) - 1, column - 1] as const;
  }
  for (const merge of sheet.model.merges ?? []) {
    const [low, high] = merge.split(':');
    const first = coord(low ?? ''),
      last = coord(high ?? '');
    if (first && last) byMaster.set(low!, [first[0], first[1], last[0], last[1]]);
  }
  return byMaster;
}

function visibleFrozen(count: number, present: Float64Array, extent: number) {
  let end = Math.min(count, present.length - 1);
  while (end > 0 && present[end - 1]! >= extent) end--;
  return end;
}

function pinnedRange(range: Parameters<typeof defaultRangeExtractor>[0], frozen: number) {
  const result = defaultRangeExtractor(range);
  for (let index = Math.min(frozen, result[0] ?? 0) - 1; index >= 0; index--) result.unshift(index);
  return result;
}

function cellPosition(
  x: number,
  y: number,
  viewport: HTMLElement | null,
): SheetPosition | undefined {
  const item = document
    .elementFromPoint(x, y)
    ?.closest<HTMLElement>('.xlsx-cell[data-row][data-col]');
  if (item && viewport?.contains(item))
    return { row: Number(item.dataset.row), col: Number(item.dataset.col) };
}

function rectOf(el: HTMLElement | undefined) {
  const rect = el?.getBoundingClientRect();
  if (rect?.width && rect.height)
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function selectionEdges(
  row: number,
  col: number,
  range: Range,
  authored: ReturnType<typeof cellStyle>,
) {
  const edges = [row === range.top, col === range.right, row === range.bottom, col === range.left];
  const borderWidths = [
    authored.borderTop,
    authored.borderRight,
    authored.borderBottom,
    authored.borderLeft,
  ].map(
    (value, index) => Number.parseFloat(String(value ?? (index === 1 || index === 2 ? 1 : 0))) || 0,
  );
  const ink = '#667085';
  const paint = (edge: number) => edges[edge] && borderWidths[edge]! > 0;
  return {
    borders: {
      ...(paint(0) ? { borderTopColor: ink, borderTopStyle: 'solid' } : {}),
      ...(paint(1) ? { borderRightColor: ink, borderRightStyle: 'solid' } : {}),
      ...(paint(2) ? { borderBottomColor: ink, borderBottomStyle: 'solid' } : {}),
      ...(paint(3) ? { borderLeftColor: ink, borderLeftStyle: 'solid' } : {}),
    },
    outline: edges.map((edge, index) => (edge && !paint(index) ? '1px' : '0')).join(' '),
  };
}

function Preview({ workbook, editable }: { workbook: Workbook; editable: boolean }) {
  const sheets = workbook.worksheets.filter((sheet) => sheet.state === 'visible');
  const [sheet, setSheet] = useState(sheets[0]!);
  const { rows, cols } = useMemo(() => sheetDimensions(sheet), [sheet]);
  const merges = useMemo(() => mergeBounds(sheet), [sheet]);
  const theme = useMemo(() => workbookTheme(workbook), [workbook]);
  const date1904 = workbook.properties.date1904 === true;
  const viewport = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLTableElement>(null);
  const [box, setBox] = useState({ width: 800, height: 600 });
  const [scroll, setScroll] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [range, setRange] = useState<Range>();
  const [status, setStatus] = useState<string>();
  const [menu, setMenu] = useState<{
    sheet: Worksheet;
    x: number;
    y: number;
    anchor: HTMLElement;
  }>();
  const [busy, setBusy] = useState(false);
  const rangeRef = useRef<Range | undefined>(undefined);
  const serial = useRef(0);
  const selectionSerial = useRef(0);
  const request = useRef<Request | undefined>(undefined);
  const anchor = useRef<SheetPosition | undefined>(undefined);
  const end = useRef<SheetPosition | undefined>(undefined);
  // Paint the live gesture in the grid, but publish only settled selection geometry to the host.
  const drag = useRef<
    { pointerId: number; previous: Range | undefined; previousSerial: number } | undefined
  >(undefined);
  const offsetsBySheet = useRef(new Map<number, { x: number; y: number }>());
  const totalWidth = cols.at(-1)!;
  const fitScale = Math.max(1, box.width - rowHeader - 1) / Math.max(1, totalWidth);
  // Keep the viewport virtualized for large sheets at very small fit scales.
  const fitFloor = (rows.length - 1) * (cols.length - 1) > fitCellBudget ? 0.5 : 0;
  const scale = zoom === 'fit' ? Math.min(1, Math.max(fitFloor, fitScale)) : zoom;
  const views = sheet.views ?? [];
  const view = views.find((value) => value.state === 'frozen');
  const frozenRows = visibleFrozen(view?.ySplit ?? 0, rows, box.height / scale);
  const frozenCols = visibleFrozen(view?.xSplit ?? 0, cols, box.width / scale);
  const rowVirtual = useVirtualizer({
    count: rows.length - 1,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => (rows[index + 1]! - rows[index]!) * scale,
    paddingStart: columnHeader,
    overscan: 4,
    initialRect: box,
    rangeExtractor: (value) => pinnedRange(value, frozenRows),
  });
  const colVirtual = useVirtualizer({
    horizontal: true,
    count: cols.length - 1,
    getScrollElement: () => viewport.current,
    estimateSize: (index) => (cols[index + 1]! - cols[index]!) * scale,
    paddingStart: rowHeader,
    overscan: 3,
    initialRect: box,
    rangeExtractor: (value) => pinnedRange(value, frozenCols),
  });
  useLayoutEffect(() => {
    const element = viewport.current!;
    const resized = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(resized);
    observer.observe(element);
    resized();
    return () => observer.disconnect();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Recalculate the cached axis measurements when their size estimates change.
  useLayoutEffect(() => {
    rowVirtual.measure();
    colVirtual.measure();
  }, [rows, cols, scale, rowVirtual, colVirtual]);
  useLayoutEffect(() => {
    const offset = offsetsBySheet.current.get(sheet.id) ?? { x: 0, y: 0 };
    viewport.current?.scrollTo(offset.x, offset.y);
    setScroll(offset);
  }, [sheet]);

  function clear() {
    const pointerId = drag.current?.pointerId;
    drag.current = undefined;
    if (pointerId !== undefined && viewport.current?.hasPointerCapture(pointerId))
      viewport.current.releasePointerCapture(pointerId);
    rangeRef.current = undefined;
    anchor.current = undefined;
    end.current = undefined;
    setRange(undefined);
    setStatus(undefined);
  }

  function select(first: SheetPosition, last: SheetPosition) {
    anchor.current = first;
    end.current = last;
    const result = makeRange(sheet, first, last, date1904);
    if ('error' in result) {
      rangeRef.current = undefined;
      setRange(undefined);
      setStatus(result.error);
      return;
    }
    const previous = rangeRef.current;
    if (
      previous?.selection.range !== result.selection.range ||
      previous.activeAddress !== result.activeAddress
    )
      selectionSerial.current++;
    rangeRef.current = result;
    setRange(result);
    setStatus(undefined);
  }

  function findCell(position: SheetPosition | undefined) {
    return (
      (position &&
        viewport.current?.querySelector<HTMLElement>(
          `.xlsx-cell[data-row="${position.row}"][data-col="${position.col}"]`,
        )) ||
      undefined
    );
  }

  function requestEdit(selection?: OfficeSelection, element?: HTMLElement) {
    const scope = selection ?? rangeRef.current?.selection;
    if (!editable || !scope || request.current || drag.current !== undefined) return;
    request.current = {
      serial: ++serial.current,
      selection: scope,
      anchor: element,
      consumed: false,
    };
    setMenu(undefined);
    setBusy(true);
  }

  useLayoutEffect(() => {
    const controller = {
      zoomScale: () => (request.current || drag.current ? undefined : scale),
      read(consume = true): OfficeInteraction {
        const gesture = drag.current;
        const selection = gesture ? gesture.previous : rangeRef.current;
        const current = request.current;
        const report = current && !current.consumed;
        if (current && consume) current.consumed = true;
        const requestAnchor = current && rectOf(current.anchor ?? findCell(end.current));
        return {
          selection: selection?.selection ?? null,
          ...(selection
            ? {
                excelSelection: {
                  selectionSerial: gesture?.previousSerial ?? selectionSerial.current,
                  activeAddress: selection.activeAddress,
                },
              }
            : {}),
          ...(report
            ? { floatingRequest: current.serial, floatingSelection: current.selection }
            : {}),
          ...(requestAnchor ? { requestAnchor } : {}),
          zoom,
        };
      },
      control(command: OfficePreviewControl) {
        if (request.current) return;
        if (command.kind === 'zoom') setZoom(command.value);
        else if (
          command.kind === 'locate-selection' &&
          !drag.current &&
          command.selectionSerial === selectionSerial.current &&
          anchor.current
        ) {
          rowVirtual.scrollToIndex(anchor.current.row, { align: 'center' });
          colVirtual.scrollToIndex(anchor.current.col, { align: 'center' });
        } else if (command.kind === 'request-edit') requestEdit();
      },
      releaseScope(id: number) {
        if (request.current?.serial !== id) return;
        request.current = undefined;
        setBusy(false);
      },
    };
    Object.assign(globalThis, { kiteOfficeInteraction: controller });
    const keys = (event: KeyboardEvent) => {
      if (!event.isTrusted || request.current) return;
      if (event.key === 'Escape' && (rangeRef.current || menu || drag.current)) {
        event.preventDefault();
        setMenu(undefined);
        clear();
      }
      if (!event.repeat && event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'x') {
        event.preventDefault();
        requestEdit();
      }
    };
    document.addEventListener('keydown', keys);
    return () => document.removeEventListener('keydown', keys);
  });

  const x = (col: number) => rowHeader + cols[col]! * scale + (col < frozenCols ? scroll.x : 0);
  const y = (row: number) => columnHeader + rows[row]! * scale + (row < frozenRows ? scroll.y : 0);
  const width = (from: number, to = from) => (cols[to + 1]! - cols[from]!) * scale;
  const height = (from: number, to = from) => (rows[to + 1]! - rows[from]!) * scale;
  const virtualRows = rowVirtual.getVirtualItems();
  const virtualCols = colVirtual.getVirtualItems();
  const rendered = new Set<string>();
  const hit = range && rectOf(findCell({ row: range.bottom, col: range.right }));
  const frame = viewport.current?.getBoundingClientRect();
  let trigger: { left: number; top: number } | undefined;
  if (editable && !busy && drag.current === undefined && hit && frame && viewport.current) {
    const left = frame.left + rowHeader;
    const right = frame.left + viewport.current.clientWidth;
    const top = frame.top + columnHeader;
    const bottom = frame.top + viewport.current.clientHeight;
    const outside =
      hit.x + hit.width <= left || hit.x >= right || hit.y + hit.height <= top || hit.y >= bottom;
    if (!outside && right - left >= 84) {
      if (hit.x + hit.width + 90 <= right && Math.max(top, hit.y) + 30 <= bottom)
        trigger = { left: hit.x + hit.width + 5, top: Math.max(top, hit.y) };
      else if (hit.y + hit.height + 35 <= bottom)
        trigger = {
          left: Math.max(left, Math.min(hit.x, right - 84)),
          top: hit.y + hit.height + 5,
        };
    }
  }

  return (
    <>
      <style>{css + officeChromeCss}</style>
      <div
        className="xlsx-viewport"
        ref={viewport}
        onScroll={(event) => {
          setMenu(undefined);
          setScroll({ x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop });
        }}
        onPointerDown={(event) => {
          if (
            !event.nativeEvent.isTrusted ||
            event.button !== 0 ||
            event.pointerType === 'touch' ||
            drag.current ||
            request.current
          )
            return;
          setMenu(undefined);
          const hit = cellPosition(event.clientX, event.clientY, viewport.current);
          if (!hit) {
            clear();
            return;
          }
          event.preventDefault();
          grid.current?.focus({ preventScroll: true });
          drag.current = {
            pointerId: event.pointerId,
            previous: rangeRef.current,
            previousSerial: selectionSerial.current,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          select(event.shiftKey && anchor.current ? anchor.current : hit, hit);
        }}
        onPointerMove={(event) => {
          if (!event.nativeEvent.isTrusted || drag.current?.pointerId !== event.pointerId) return;
          const hit = cellPosition(event.clientX, event.clientY, viewport.current);
          if (anchor.current && hit) select(anchor.current, hit);
        }}
        onPointerUp={(event) => {
          if (!event.nativeEvent.isTrusted || drag.current?.pointerId !== event.pointerId) return;
          drag.current = undefined;
          const hit = cellPosition(event.clientX, event.clientY, viewport.current);
          if (anchor.current && hit) select(anchor.current, hit);
          else if (!hit) clear();
        }}
        onPointerCancel={(event) => {
          if (event.nativeEvent.isTrusted && drag.current?.pointerId === event.pointerId) clear();
        }}
        onLostPointerCapture={(event) => {
          if (event.nativeEvent.isTrusted && drag.current?.pointerId === event.pointerId) clear();
        }}
      >
        <table
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: The virtual table exposes a selectable grid.
          role="grid"
          ref={grid}
          aria-label={sheet.name}
          tabIndex={0}
          aria-rowcount={rows.length - 1}
          aria-colcount={cols.length - 1}
          className={`xlsx-plane${views[0]?.showGridLines === false ? ' xlsx-no-grid' : ''}`}
          style={{
            width: Math.max(box.width, totalWidth * scale + rowHeader),
            height: Math.max(box.height, rows.at(-1)! * scale + columnHeader),
            fontSize: 13 * scale,
          }}
        >
          <thead>
            <tr>
              <th
                className="xlsx-header"
                style={{
                  left: scroll.x,
                  top: scroll.y,
                  width: rowHeader,
                  height: columnHeader,
                  zIndex: 7,
                }}
              />
              {virtualCols.map(
                ({ index }) =>
                  width(index) > 0 && (
                    <th
                      key={index}
                      scope="col"
                      className="xlsx-header"
                      style={{
                        left: x(index),
                        top: scroll.y,
                        width: width(index),
                        height: columnHeader,
                        fontSize: Math.min(11, width(index) / 2),
                        zIndex: index < frozenCols ? 6 : 5,
                      }}
                    >
                      {columnName(index)}
                    </th>
                  ),
              )}
            </tr>
          </thead>
          <tbody>
            {virtualRows.map(({ index: row }) => (
              <tr key={row} aria-rowindex={row + 1}>
                {height(row) > 0 && (
                  <th
                    scope="row"
                    className="xlsx-header"
                    style={{
                      left: scroll.x,
                      top: y(row),
                      width: rowHeader,
                      height: height(row),
                      fontSize: Math.min(11, height(row) * 0.8),
                      zIndex: row < frozenRows ? 6 : 5,
                    }}
                  >
                    {row + 1}
                  </th>
                )}
                {virtualCols.map(({ index: col }) => {
                  const cell = sheetCell(sheet, { row, col });
                  const merge = cell?.isMerged ? merges.get(cell.master.address) : undefined;
                  const [firstRow, firstCol, lastRow, lastCol] = merge ?? [row, col, row, col];
                  const key = `${firstRow}:${firstCol}`;
                  if (
                    rendered.has(key) ||
                    width(firstCol, lastCol) <= 0 ||
                    height(firstRow, lastRow) <= 0
                  )
                    return null;
                  rendered.add(key);
                  const source = cell?.master;
                  const displayed = cellDisplay(source, date1904);
                  const authored = cellStyle(source, scale, theme);
                  const selected =
                    range &&
                    row >= range.top &&
                    row <= range.bottom &&
                    col >= range.left &&
                    col <= range.right;
                  const edges = selected ? selectionEdges(row, col, range, authored) : undefined;
                  return (
                    <td
                      key={key}
                      className="xlsx-cell"
                      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: This cell belongs to a selectable grid.
                      role="gridcell"
                      tabIndex={-1}
                      aria-rowindex={firstRow + 1}
                      aria-colindex={firstCol + 1}
                      aria-selected={Boolean(selected)}
                      data-row={firstRow}
                      data-col={firstCol}
                      aria-label={displayed.resultUnavailable ? '计算结果不可用' : undefined}
                      title={
                        displayed.resultUnavailable
                          ? '计算结果不可用'
                          : displayed.value || undefined
                      }
                      style={{
                        left: x(firstCol),
                        top: y(firstRow),
                        width: width(firstCol, lastCol),
                        height: height(firstRow, lastRow),
                        paddingInline: 4 * scale,
                        zIndex: Number(firstRow < frozenRows) * 2 + Number(firstCol < frozenCols),
                        ...authored,
                        ...edges?.borders,
                      }}
                    >
                      <span className="xlsx-value">{displayed.value}</span>
                      {displayed.resultUnavailable && (
                        <span className="xlsx-result-unavailable" aria-hidden="true">
                          —
                        </span>
                      )}
                      {edges && (
                        <span
                          aria-hidden="true"
                          className="xlsx-highlight"
                          style={{ borderWidth: edges.outline }}
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="xlsx-tabs" role="tablist" aria-label="工作表">
        {sheets.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item === sheet}
            onClick={() => {
              if (request.current || item === sheet) return;
              offsetsBySheet.current.set(sheet.id, scroll);
              clear();
              setMenu(undefined);
              setSheet(item);
            }}
            onContextMenu={(event) => {
              if (!event.nativeEvent.isTrusted || !editable || request.current) return;
              event.preventDefault();
              setMenu({
                sheet: item,
                x: event.clientX,
                y: event.clientY,
                anchor: event.currentTarget,
              });
            }}
          >
            {item.name}
          </button>
        ))}
      </div>
      {status && (
        <span className="xlsx-status kite-office-chrome" role="status">
          {status}
        </span>
      )}
      {trigger && (
        <button
          type="button"
          className="kite-office-chrome kite-office-request-trigger"
          style={{
            position: 'fixed',
            zIndex: 8,
            ...trigger,
          }}
          onClick={(event) => {
            if (event.nativeEvent.isTrusted) requestEdit();
          }}
        >
          请求修改
        </button>
      )}
      {menu && (
        <div
          role="menu"
          className="kite-office-chrome kite-office-context-menu"
          style={{
            position: 'fixed',
            zIndex: 9,
            left: Math.min(menu.x, innerWidth - 112),
            top: Math.min(menu.y, innerHeight - 40),
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              if (event.nativeEvent.isTrusted)
                requestEdit({ kind: 'excel', scope: 'sheet', sheet: menu.sheet.name }, menu.anchor);
            }}
          >
            请求修改
          </button>
        </div>
      )}
    </>
  );
}

const css = [
  'html,body,#office-preview{margin:0;height:100%;overflow:hidden}',
  'body{background:var(--office-background);color:#111;font-family:Arial,sans-serif}',
  '#office-preview{display:flex;flex-direction:column}',
  '.xlsx-viewport{flex:1;min-height:0;overflow:auto;position:relative;outline:none;overscroll-behavior:contain;user-select:none}',
  '.xlsx-plane{display:block;position:relative;overflow:hidden;background:#fff;color-scheme:light;border-spacing:0}',
  '.xlsx-plane thead,.xlsx-plane tbody,.xlsx-plane tr{display:contents}',
  '.xlsx-cell,.xlsx-header{position:absolute;box-sizing:border-box;display:flex;align-items:center;overflow:hidden}',
  '.xlsx-cell{background:#fff;border:solid #d6d9dc;border-width:0 1px 1px 0;white-space:nowrap;cursor:cell;overflow:visible}',
  '.xlsx-no-grid .xlsx-cell{border-color:transparent}',
  '.xlsx-result-unavailable{color:#667085;pointer-events:none}',
  '.xlsx-value{overflow:hidden;text-overflow:clip;max-width:100%;max-height:100%}',
  '.xlsx-header{background:#f3f4f6;border:solid #d6d9dc;border-width:0 1px 1px 0;justify-content:center;font-size:11px;font-weight:normal;color:#374151}',
  '.xlsx-highlight{position:absolute;inset:0;background:#64748b1c;border:solid #667085;pointer-events:none}',
  '.xlsx-tabs{display:flex;flex:none;overflow:auto;align-items:stretch;gap:2px;background:var(--office-background);border-top:1px solid var(--office-border);min-height:28px}',
  '.xlsx-tabs button{font:12px var(--office-font);background:transparent;border:0;border-bottom:2px solid transparent;color:var(--office-foreground);padding:3px 12px;white-space:nowrap}',
  '.xlsx-tabs button[aria-selected="true"]{background:var(--office-card);color:light-dark(#126348,#8bdbc4);border-bottom-color:light-dark(#168363,#57cbb0);font-weight:600}',
  '.xlsx-status{position:fixed;z-index:9;left:48px;bottom:40px}',
].join('');

startOfficePreview('workbook.xlsx', async (element, bytes) => {
  const globals = globalThis as typeof globalThis & { ExcelJS: { Workbook: new () => Workbook } };
  const workbook = new globals.ExcelJS.Workbook();
  await workbook.xlsx.load(bytes);
  if (!workbook.worksheets.some((sheet) => sheet.state === 'visible'))
    throw Error('preview_xlsx_no_visible_sheet');
  const root = createRoot(element);
  flushSync(() =>
    root.render(<Preview workbook={workbook} editable={element.dataset.editable === 'true'} />),
  );
  if (!element.querySelector('.xlsx-viewport')) throw Error('preview_xlsx_render_failed');
});
