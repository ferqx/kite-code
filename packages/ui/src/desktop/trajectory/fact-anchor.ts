import type { WorkbenchRow } from './workbench';

/** Only used for an incoming fact revision, never search, density switches or explicit navigation. */
export function trajectoryFactAnchor(
  previousIds: readonly string[],
  rows: readonly WorkbenchRow[],
  scrollTop: number,
  byId: ReadonlyMap<string, WorkbenchRow>,
): number | undefined {
  const id = previousIds[Math.floor(scrollTop / 38)];
  if (!id) return;
  const original = byId.get(id);
  const owner =
    original && byId.get(original.virtualPart?.ownerId ?? original.originalParentId ?? '');
  const representative =
    original?.presentationRepresentativeId ?? owner?.presentationRepresentativeId;
  let index = rows.findIndex((row) => row.id === id);
  if (index < 0 && representative) index = rows.findIndex((row) => row.id === representative);
  if (index < 0) return;
  return index * 38 + (scrollTop % 38);
}
