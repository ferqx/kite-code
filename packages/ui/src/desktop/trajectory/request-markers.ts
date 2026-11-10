import type { WorkbenchRow } from './workbench';

export interface TrajectoryRequestMarker {
  /** The request represented by this record-order rail, never a tool's causal parent. */
  ownerId: string;
  requestIndex?: number;
  /** A request boundary immediately before this anchor row, never a dot on the node itself. */
  marker: boolean;
  /** Join the immediately previous / next visible row; gaps and scope changes break both. */
  continuation: boolean;
  continuesAfter: boolean;
  omittedBefore?: boolean;
}

function exactRunKey(row: WorkbenchRow): string | undefined {
  const original = row.operation?.members.find((member) => member.nodeId === row.nodeId) ?? row;
  const step = original.step;
  if (step?.identityConfidence !== 'verified_origin' || !step.runOriginStoreId || !step.runId)
    return;
  const key = JSON.stringify([step.runOriginStoreId, step.sessionId, step.runId]);
  return key === row.runKey ? key : undefined;
}

/** Request boundaries precede visible thinking (or its first remaining phase), and
 * genuine compression Model requests precede their existing compression operation row.
 * No body reads or synthesized rows: this rail expresses record order, not tool attribution.
 */
export function buildTrajectoryRequestMarkers(
  rows: readonly WorkbenchRow[],
  visibleRows: readonly WorkbenchRow[],
): ReadonlyMap<string, TrajectoryRequestMarker> {
  const owners = new Map<string, WorkbenchRow>();
  const ordinals = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of rows) {
    const compression =
      row.category === 'compression' &&
      row.operation?.type === 'compression' &&
      row.operation.members.some(
        (member) =>
          member.kind === 'model' &&
          member.step?.identityConfidence === 'verified_origin' &&
          !!member.step.executionId &&
          !!(member.step.executionOriginStoreId ?? member.step.originStoreId),
      );
    if (
      row.kind !== 'model' ||
      (row.category !== 'model' && !compression) ||
      row.event ||
      row.virtualPart ||
      row.step?.identityConfidence !== 'verified_origin' ||
      !row.step.executionId ||
      !(row.step.executionOriginStoreId ?? row.step.originStoreId)
    )
      continue;
    owners.set(row.id, row);
    const key = exactRunKey(row);
    if (key) {
      const ordinal = counts.get(key) ?? 0;
      ordinals.set(row.id, ordinal);
      counts.set(key, ordinal + 1);
    }
  }
  const anchorRows = new Map<string, WorkbenchRow>();
  for (const row of visibleRows) {
    if (row.category === 'compression' && owners.has(row.id)) {
      anchorRows.set(row.id, row);
      continue;
    }
    const owner = row.virtualPart && owners.get(row.virtualPart.ownerId);
    if (!owner) continue;
    const existing = anchorRows.get(owner.id);
    if (
      !existing ||
      (existing.virtualPart?.kind !== 'thinking' && row.virtualPart?.kind === 'thinking')
    )
      anchorRows.set(owner.id, row);
  }
  const anchors = new Map([...anchorRows].map(([ownerId, row]) => [row.id, owners.get(ownerId)!]));
  // Presentation-hidden owners/replies are not missing log rows. Filtered or folded phases are.
  const positions = new Map<string, number>();
  const visibleIds = new Set(visibleRows.map((row) => row.id));
  for (const row of rows)
    if (
      !row.presentationHidden &&
      (visibleIds.has(row.id) || !['administrative', 'structure'].includes(row.category))
    )
      positions.set(row.id, positions.size);
  const result = new Map<string, TrajectoryRequestMarker>();
  let active: WorkbenchRow | undefined;
  let previous: WorkbenchRow | undefined;
  let previousEntry: TrajectoryRequestMarker | undefined;
  const seenRuns = new Set<string>();
  for (const row of visibleRows) {
    const markerOwner = anchors.get(row.id);
    const runKey = exactRunKey(row);
    const previousKey = previous && exactRunKey(previous);
    const adjacent =
      previous !== undefined &&
      positions.has(previous.id) &&
      positions.has(row.id) &&
      positions.get(row.id) === positions.get(previous.id)! + 1;
    const priorOwner = active;
    const contiguous = !!runKey && runKey === previousKey && adjacent;
    if (!contiguous) active = undefined;
    if (markerOwner) active = markerOwner;
    if (active && (markerOwner || (contiguous && previousEntry))) {
      const ownerKey = exactRunKey(active);
      const priorOrdinal = priorOwner && ordinals.get(priorOwner.id);
      const ordinal = ordinals.get(active.id);
      const consecutiveOwner =
        priorOwner?.id === active.id ||
        (priorOrdinal !== undefined && ordinal === priorOrdinal + 1);
      const continuation = contiguous && !!previousEntry && !!ownerKey && consecutiveOwner;
      const omittedBefore =
        markerOwner && ownerKey && !continuation && (seenRuns.has(ownerKey) || (ordinal ?? 0) > 0);
      const entry: TrajectoryRequestMarker = {
        ownerId: active.id,
        ...(active.requestIndex !== undefined ? { requestIndex: active.requestIndex } : {}),
        marker: !!markerOwner,
        continuation,
        continuesAfter: false,
        ...(omittedBefore ? { omittedBefore: true } : {}),
      };
      result.set(row.id, entry);
      if (continuation && previousEntry) previousEntry.continuesAfter = true;
      if (ownerKey) seenRuns.add(ownerKey);
      previousEntry = entry;
      if (!ownerKey) active = undefined;
    } else {
      previousEntry = undefined;
    }
    previous = row;
  }
  return result;
}
