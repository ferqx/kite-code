import { isOfficeEditContext, type OfficeSelection } from '../src/output-files-bridge';
import type { OfficeInteraction } from './office-preview-interaction';

export type OfficePreviewKind = OfficeSelection['kind'];

/** Document evidence is not an IPC result. Project only descriptive fields. */
export function readOfficeDescription(
  value: unknown,
  kind: OfficePreviewKind | undefined,
  sourceHash: string | undefined,
): OfficeInteraction {
  const fail = (): never => {
    throw Error('preview_selection_budget');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  if (JSON.stringify(value).length > 131072) return fail();
  const item = value as Record<string, unknown>;
  const selection = (candidate: unknown): OfficeSelection => {
    if (
      !kind ||
      !isOfficeEditContext({ sourceHash, selection: candidate }) ||
      !candidate ||
      (candidate as OfficeSelection).kind !== kind
    )
      return fail();
    return structuredClone(candidate as OfficeSelection);
  };
  const result: OfficeInteraction = {
    selection: item.selection == null ? null : selection(item.selection),
  };
  if (item.excelSelection !== undefined) {
    const metadata = item.excelSelection;
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      Array.isArray(metadata) ||
      Object.keys(metadata).sort().join(',') !== 'activeAddress,selectionSerial'
    )
      return fail();
    const view = metadata as { activeAddress: unknown; selectionSerial: unknown };
    const current = result.selection;
    if (
      kind !== 'excel' ||
      current?.kind !== 'excel' ||
      !('cells' in current) ||
      !Number.isSafeInteger(view.selectionSerial) ||
      Number(view.selectionSerial) < 1 ||
      typeof view.activeAddress !== 'string' ||
      !current.cells.some((cell) => cell.address === view.activeAddress)
    )
      return fail();
    result.excelSelection = {
      selectionSerial: Number(view.selectionSerial),
      activeAddress: view.activeAddress,
    };
  }
  if (item.requestInvalidated !== undefined) {
    if (
      !kind ||
      !Number.isSafeInteger(item.requestInvalidated) ||
      Number(item.requestInvalidated) < 1
    )
      return fail();
    result.requestInvalidated = Number(item.requestInvalidated);
  }
  if (item.floatingSelection !== undefined)
    result.floatingSelection = selection(item.floatingSelection);
  if (item.floatingRequest !== undefined) {
    if (
      !Number.isSafeInteger(item.floatingRequest) ||
      Number(item.floatingRequest) < 1 ||
      !result.floatingSelection
    )
      return fail();
    result.floatingRequest = Number(item.floatingRequest);
  }
  for (const field of ['currentSlide', 'slideCount'] as const) {
    if (item[field] === undefined) continue;
    if (
      kind !== 'powerpoint' ||
      !Number.isSafeInteger(item[field]) ||
      Number(item[field]) < 1 ||
      Number(item[field]) > 10000
    )
      return fail();
    result[field] = Number(item[field]);
  }
  if (item.notes !== undefined) {
    if (kind !== 'powerpoint' || typeof item.notes !== 'string' || item.notes.length > 8192)
      return fail();
    result.notes = item.notes;
  }
  if (item.presentation !== undefined) {
    if (kind !== 'powerpoint' || typeof item.presentation !== 'boolean') return fail();
    result.presentation = item.presentation;
  }
  if (item.zoom !== undefined) {
    if (
      !kind ||
      (item.zoom !== 'fit' &&
        (typeof item.zoom !== 'number' ||
          !Number.isFinite(item.zoom) ||
          item.zoom < 0.5 ||
          item.zoom > 2))
    )
      return fail();
    result.zoom = item.zoom as number | 'fit';
  }
  if (item.requestAnchor !== undefined) {
    const anchor = item.requestAnchor;
    if (
      !anchor ||
      typeof anchor !== 'object' ||
      Array.isArray(anchor) ||
      Object.keys(anchor).sort().join(',') !== 'height,width,x,y'
    )
      return fail();
    const rect = anchor as NonNullable<OfficeInteraction['requestAnchor']>;
    if (
      !Object.values(rect).every(
        (v) => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100000,
      ) ||
      rect.width < 0 ||
      rect.height < 0
    )
      return fail();
    result.requestAnchor = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }
  return result;
}
