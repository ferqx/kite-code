import type { Cell, Color, Workbook, Worksheet } from 'exceljs';
import type { CSSProperties } from 'react';
import { format } from 'ssf';
import type { OfficeSelection } from '../src/output-files-bridge';

export type SheetPosition = { row: number; col: number };
export type SheetRange = Extract<OfficeSelection, { kind: 'excel'; range: string }>;

export function columnName(column: number) {
  let name = '';
  for (let n = column + 1; n; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const address = ({ row, col }: SheetPosition) => columnName(col) + (row + 1);

export function sheetCell(sheet: Worksheet, { row, col }: SheetPosition) {
  return sheet.findRow(row + 1)?.findCell(col + 1);
}

export function cellDisplay(cell: Cell | undefined, date1904: boolean) {
  if (!cell) return { value: '' };
  const raw = cell.value;
  const formula = cell.formula ? `=${cell.formula}` : undefined;
  const result = formula ? cell.result : raw;
  if (result === null || result === undefined) return { value: '', formula };
  if (typeof result === 'boolean') return { value: result ? 'TRUE' : 'FALSE', formula };
  if (typeof result === 'number' || result instanceof Date) {
    try {
      return { value: format(cell.numFmt ?? 'General', result, { date1904 }), formula };
    } catch {
      return {
        value: result instanceof Date ? result.toISOString().slice(0, 10) : String(result),
        formula,
      };
    }
  }
  if (typeof result === 'object' && 'error' in result) return { value: result.error, formula };
  return { value: cell.text, formula };
}

export function makeRange(
  sheet: Worksheet,
  from: SheetPosition,
  to: SheetPosition,
  date1904: boolean,
) {
  const top = Math.min(from.row, to.row);
  const bottom = Math.max(from.row, to.row);
  const left = Math.min(from.col, to.col);
  const right = Math.max(from.col, to.col);
  if ((bottom - top + 1) * (right - left + 1) > 256)
    return { error: '最多选择 256 个单元格' } as const;
  const cells: SheetRange['cells'] = [];
  for (let row = top; row <= bottom; row++) {
    for (let col = left; col <= right; col++) {
      const cell = sheetCell(sheet, { row, col });
      if (cell?.isMerged) return { error: '此区域不可用，请重新选择' } as const;
      const cellAddress = address({ row, col });
      const data = cellDisplay(cell, date1904);
      if (data.value.length > 4096 || (data.formula?.length ?? 0) > 4096)
        return { error: '所选内容过长，请缩小范围' } as const;
      cells.push({
        path: `/${sheet.name}/${cellAddress}`,
        address: cellAddress,
        value: data.value,
        ...(data.formula ? { formula: data.formula } : {}),
      });
    }
  }
  const first = cells[0]!.address;
  const last = cells.at(-1)!.address;
  const selection: SheetRange = {
    kind: 'excel',
    sheet: sheet.name,
    range: first === last ? first : `${first}:${last}`,
    cells,
  };
  if (new TextEncoder().encode(JSON.stringify(selection)).byteLength > 32768)
    return { error: '所选内容过长，请缩小范围' } as const;
  return { selection, activeAddress: address(from), top, bottom, left, right };
}

export function workbookTheme(workbook: Workbook) {
  const theme = Object.values(workbook.model.themes ?? {})[0];
  if (!theme) return [];
  const xml = new DOMParser().parseFromString(theme, 'application/xml');
  const scheme = xml.getElementsByTagNameNS('*', 'clrScheme')[0];
  return [
    'lt1',
    'dk1',
    'lt2',
    'dk2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink',
  ].map((name) => {
    const node = scheme?.getElementsByTagNameNS('*', name)[0]?.firstElementChild;
    return node?.getAttribute('lastClr') ?? node?.getAttribute('val') ?? '';
  });
}

function color(value: Partial<Color> | undefined, theme: readonly string[]) {
  const rgb =
    value?.argb?.slice(-6) ?? (value?.theme !== undefined ? theme[value.theme] : undefined);
  return rgb && /^[0-9a-f]{6}$/i.test(rgb) ? `#${rgb}` : undefined;
}

export function cellStyle(
  cell: Cell | undefined,
  scale: number,
  theme: readonly string[],
): CSSProperties {
  if (!cell) return {};
  const { font, fill, alignment, border } = cell;
  const style: CSSProperties = {
    backgroundColor:
      fill?.type === 'pattern' && fill.pattern === 'solid' ? color(fill.fgColor, theme) : undefined,
    color: color(font?.color, theme),
    fontFamily: font?.name,
    fontSize: font?.size ? ((font.size * 4) / 3) * scale : undefined,
    fontWeight: font?.bold ? 'bold' : undefined,
    fontStyle: font?.italic ? 'italic' : undefined,
    textDecoration:
      [font?.underline && 'underline', font?.strike && 'line-through'].filter(Boolean).join(' ') ||
      undefined,
    justifyContent:
      alignment?.horizontal === 'center'
        ? 'center'
        : alignment?.horizontal === 'right' ||
            (!alignment?.horizontal &&
              (typeof cell.value === 'number' || typeof cell.result === 'number'))
          ? 'flex-end'
          : undefined,
    alignItems:
      alignment?.vertical === 'top'
        ? 'flex-start'
        : alignment?.vertical === 'bottom'
          ? 'flex-end'
          : undefined,
    whiteSpace: alignment?.wrapText ? 'pre-wrap' : undefined,
  };
  for (const [side, property] of [
    ['top', 'borderTop'],
    ['right', 'borderRight'],
    ['bottom', 'borderBottom'],
    ['left', 'borderLeft'],
  ] as const) {
    const edge = border?.[side];
    if (!edge?.style) continue;
    const weight =
      edge.style === 'thick'
        ? 3
        : edge.style.startsWith('medium') || edge.style === 'double'
          ? 2
          : 1;
    const line =
      edge.style === 'double'
        ? 'double'
        : /dash/i.test(edge.style)
          ? 'dashed'
          : /dot/i.test(edge.style)
            ? 'dotted'
            : 'solid';
    style[property] = `${weight * scale}px ${line} ${color(edge.color, theme) ?? '#1f2937'}`;
  }
  return style;
}
