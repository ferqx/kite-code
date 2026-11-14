/** Bounded text geometry for the trusted PDF preview, never OCR or HTML. */
export type PdfTextTransform = [number, number, number, number, number, number];
export interface PdfTextItem {
  text: string;
  transform: PdfTextTransform;
  width: number;
  height: number;
  ascent: number | null;
  descent: number | null;
  vertical: boolean;
  dir: 'ltr' | 'rtl' | 'ttb';
  fontFamily: 'sans-serif' | 'serif' | 'monospace';
  hasEOL: boolean;
}
export interface PdfTextLayer {
  status: 'available' | 'empty' | 'unavailable';
  width: number;
  height: number;
  items: PdfTextItem[];
}
export const pdfTextLimits = { items: 10000, itemLength: 16384, textBytes: 1024 * 1024 };
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000;
const dimension = (value: unknown): value is number =>
  finite(value) && Number.isInteger(value) && value > 0 && value <= 4096;
const matrix = (value: unknown): value is PdfTextTransform =>
  Array.isArray(value) && value.length === 6 && value.every(finite);
const multiply = (a: PdfTextTransform, b: PdfTextTransform): PdfTextTransform => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
export function validPdfTextLayer(value: unknown): value is PdfTextLayer {
  if (!value || typeof value !== 'object') return false;
  const layer = value as PdfTextLayer;
  if (
    !['available', 'empty', 'unavailable'].includes(layer.status) ||
    !dimension(layer.width) ||
    !dimension(layer.height) ||
    !Array.isArray(layer.items) ||
    layer.items.length > pdfTextLimits.items ||
    (layer.status !== 'available' && layer.items.length !== 0) ||
    (layer.status === 'available' && layer.items.length === 0)
  )
    return false;
  let bytes = 0;
  for (const item of layer.items) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.text !== 'string' ||
      item.text.length > pdfTextLimits.itemLength ||
      !matrix(item.transform) ||
      !finite(item.width) ||
      item.width < 0 ||
      !finite(item.height) ||
      item.height < 0 ||
      (item.ascent !== null && (!finite(item.ascent) || Math.abs(item.ascent) > 4)) ||
      (item.descent !== null && (!finite(item.descent) || Math.abs(item.descent) > 4)) ||
      typeof item.vertical !== 'boolean' ||
      typeof item.hasEOL !== 'boolean' ||
      !['ltr', 'rtl', 'ttb'].includes(item.dir) ||
      !['sans-serif', 'serif', 'monospace'].includes(item.fontFamily)
    )
      return false;
    bytes += new TextEncoder().encode(item.text).byteLength;
    if (bytes > pdfTextLimits.textBytes) return false;
  }
  return true;
}
export function createPdfTextLayer(
  content: { items: unknown[]; styles: Record<string, unknown> },
  viewport: { width: number; height: number; scale: number; transform: number[] },
): PdfTextLayer {
  const result: PdfTextLayer = {
    status: 'unavailable',
    width: Math.ceil(viewport.width),
    height: Math.ceil(viewport.height),
    items: [],
  };
  if (
    !matrix(viewport.transform) ||
    !dimension(result.width) ||
    !dimension(result.height) ||
    !finite(viewport.scale) ||
    viewport.scale <= 0 ||
    content.items.length > pdfTextLimits.items
  )
    return result;
  const items: PdfTextItem[] = [];
  let bytes = 0;
  for (const raw of content.items) {
    if (!raw || typeof raw !== 'object' || !('str' in raw)) continue;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.str !== 'string' ||
      item.str.length > pdfTextLimits.itemLength ||
      !matrix(item.transform) ||
      !finite(item.width) ||
      !finite(item.height) ||
      typeof item.fontName !== 'string'
    )
      return result;
    const rawStyle = content.styles[item.fontName];
    if (!rawStyle || typeof rawStyle !== 'object') return result;
    const style = rawStyle as Record<string, unknown>;
    const family = typeof style.fontFamily === 'string' ? style.fontFamily : '';
    bytes += new TextEncoder().encode(item.str).byteLength;
    if (bytes > pdfTextLimits.textBytes) return result;
    items.push({
      text: item.str,
      transform: multiply(viewport.transform, item.transform),
      width: item.width * viewport.scale,
      height: item.height * viewport.scale,
      ascent: finite(style.ascent) ? style.ascent : null,
      descent: finite(style.descent) ? style.descent : null,
      vertical: style.vertical === true,
      dir: item.dir === 'rtl' || item.dir === 'ttb' ? item.dir : 'ltr',
      fontFamily: /mono/i.test(family)
        ? 'monospace'
        : /serif/i.test(family) && !/sans/i.test(family)
          ? 'serif'
          : 'sans-serif',
      hasEOL: item.hasEOL === true,
    });
  }
  const complete = {
    ...result,
    status: items.some((item) => item.text.trim()) ? 'available' : 'empty',
    items,
  };
  if (complete.status === 'empty') complete.items = [];
  return validPdfTextLayer(complete) ? complete : result;
}
