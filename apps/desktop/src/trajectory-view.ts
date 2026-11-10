import type { TrajectoryReplaySource } from '@kite-ai/client';
import {
  parseDecimal64,
  type TrajectoryEvent,
  type TrajectoryProjection,
  TrajectoryProjector,
  type TrajectoryReadRequest,
  verifyTrajectoryPage,
} from '@kite-ai/trajectory';
import {
  buildTrajectoryTree,
  filterTrajectoryTree,
  trajectoryNodeEventIds,
} from '@kite-ai/ui/desktop';

function request(source: TrajectoryReplaySource, afterCursor: string): TrajectoryReadRequest {
  const descriptor = source.snapshot;
  return {
    storeId: descriptor.storeId,
    sessionId: descriptor.sessionId,
    ...(descriptor.runId === undefined ? {} : { runId: descriptor.runId }),
    ...(descriptor.executionId === undefined ? {} : { executionId: descriptor.executionId }),
    ...(descriptor.eventKinds === undefined ? {} : { eventKinds: descriptor.eventKinds }),
    afterCursor,
    upperCursor: descriptor.upperCursor,
    limit: 200,
  };
}
/** Resolve the latest presentation choice against the newly verified prefix, without another read. */
export function resolveNativeTrajectorySelection(
  projection: TrajectoryProjection,
  selectedNodeId: string | null | undefined,
  listMode: 'key_steps' | 'all_events',
): string {
  const tree = buildTrajectoryTree(projection, []);
  const filtered = filterTrajectoryTree(tree.root, listMode);
  let node = tree.byId.get(selectedNodeId ?? 'session') ?? tree.root;
  while (!filtered.visibleNodeIds.has(node.id) && node.parentId)
    node = tree.byId.get(node.parentId) ?? tree.root;
  return node.id;
}
/** One real prefix produces a navigable bounded window; source facts are never retained wholesale. */
export async function readNativeTrajectoryView(
  source: TrajectoryReplaySource,
  cursor: string,
  desiredPageAfter?: string,
  signal?: AbortSignal,
  selectedNodeId = 'session',
  listMode: 'key_steps' | 'all_events' = 'all_events',
  options: { treeOnly?: boolean } = {},
) {
  const minimum = source.minimumCursor ?? '0';
  const at = parseDecimal64(cursor);
  if (
    at < parseDecimal64(minimum) ||
    at > parseDecimal64(source.snapshot.upperCursor) ||
    (desiredPageAfter !== undefined &&
      (parseDecimal64(desiredPageAfter) < parseDecimal64(minimum) ||
        parseDecimal64(desiredPageAfter) > at))
  )
    throw Error('trajectory_view_position_invalid');
  const projector = new TrajectoryProjector({
    atCursor: cursor,
    integrity: source.snapshot.historyCoverage.integrity,
    completePrefix: minimum === '0',
  });
  let after = minimum;
  while (true) {
    signal?.throwIfAborted();
    const query = request(source, after);
    const page = verifyTrajectoryPage(await source.readEvents(query, signal), query);
    signal?.throwIfAborted();
    projector.apply(page.events);
    if (page.exhausted || parseDecimal64(page.scannedThrough) >= at) break;
    after = page.scannedThrough;
  }
  const projection = projector.project();
  if (options.treeOnly)
    return {
      events: [],
      projection,
      selectedNodeId: resolveNativeTrajectorySelection(projection, selectedNodeId, listMode),
      navigation: { after: minimum, through: cursor },
    };
  const tree = buildTrajectoryTree(projection, []);
  const filtered = filterTrajectoryTree(tree.root, listMode);
  let node = tree.byId.get(selectedNodeId) ?? tree.root;
  while (!filtered.visibleNodeIds.has(node.id) && node.parentId)
    node = tree.byId.get(node.parentId) ?? tree.root;
  const orderedIds = trajectoryNodeEventIds(node).filter((id) => filtered.eventIds.has(id));
  const ids = new Set(orderedIds);
  const lastBoundary = Math.floor(Math.max(0, orderedIds.length - 1) / 200) * 200;
  const boundaryId = orderedIds[lastBoundary - 1];
  // Projection source order identifies the boundary, but steps only retain first/last sequence.
  // Resolve an intermediate object's boundary from its raw record during the bounded second pass.
  let defaultBoundary = node.id === tree.root.id && boundaryId ? boundaryId : undefined;
  // A complete identity index is retained, while only this selected node's bounded raw page lives
  // in renderer state. A second streaming pass also covers sparse source pages without gaps.
  let pageAfter = desiredPageAfter ?? minimum;
  let lower = parseDecimal64(pageAfter);
  const selected: TrajectoryEvent[] = [];
  let previous: string | undefined;
  let boundary = minimum;
  let matching = 0;
  let hasNext = false;
  after = minimum;
  while (true) {
    signal?.throwIfAborted();
    const query = request(source, after);
    const page = verifyTrajectoryPage(await source.readEvents(query, signal), query);
    signal?.throwIfAborted();
    for (const event of page.events) {
      const sequence = parseDecimal64(event.sequence);
      if (sequence > at || !ids.has(event.eventId)) continue;
      if (desiredPageAfter === undefined && defaultBoundary) {
        if (event.eventId === defaultBoundary) {
          pageAfter = event.sequence;
          lower = sequence;
          defaultBoundary = undefined;
        }
        if (parseDecimal64(boundary) < sequence) previous = boundary;
        matching++;
        if (matching % 200 === 0) boundary = event.sequence;
        continue;
      }
      if (parseDecimal64(boundary) < lower) previous = boundary;
      matching++;
      if (sequence > lower) {
        if (selected.length === 200) {
          hasNext = true;
          break;
        }
        selected.push(event);
      }
      if (matching % 200 === 0) boundary = event.sequence;
    }
    if (hasNext || page.exhausted || parseDecimal64(page.scannedThrough) >= at) break;
    after = page.scannedThrough;
  }
  const through = hasNext ? selected.at(-1)!.sequence : cursor;
  return {
    events: selected,
    projection,
    selectedNodeId: node.id,
    navigation: {
      after: pageAfter,
      through,
      ...(previous === undefined ? {} : { previous }),
      ...(hasNext ? { next: through } : {}),
    },
  };
}
