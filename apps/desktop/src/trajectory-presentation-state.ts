import { canonicalSerialize } from '@kite-ai/trajectory';
import { type TrajectoryViewState, trajectoryViewStateKey } from '@kite-ai/ui/desktop';

/** Panel callbacks may outlive their render. Only their changed presentation fields can commit. */
export function mergeTrajectoryPresentation(
  current: TrajectoryViewState,
  rendered: TrajectoryViewState,
  update: TrajectoryViewState,
): TrajectoryViewState {
  const sameSource =
    current.descriptor === rendered.descriptor ||
    (current.descriptor !== null &&
      rendered.descriptor !== null &&
      trajectoryViewStateKey(current.descriptor) ===
        trajectoryViewStateKey({
          ...rendered.descriptor,
          upperCursor: current.descriptor.upperCursor,
        }));
  const sameReader =
    current.cursor === rendered.cursor &&
    current.listMode === rendered.listMode &&
    current.pageAfterCursor === rendered.pageAfterCursor &&
    canonicalSerialize(current.filters ?? null) === canonicalSerialize(rendered.filters ?? null) &&
    (current.descriptor === rendered.descriptor ||
      (current.descriptor !== null &&
        rendered.descriptor !== null &&
        trajectoryViewStateKey(current.descriptor) ===
          trajectoryViewStateKey(rendered.descriptor)));
  const modeChanged = sameSource && update.listMode !== rendered.listMode;
  const sameSelectedNode = current.selectedNodeId === rendered.selectedNodeId;
  const sameSelection =
    sameSelectedNode &&
    (current.selectedRequestId ?? null) === (rendered.selectedRequestId ?? null);
  const tabChanged = sameSource && sameSelection && update.detailTab !== rendered.detailTab;
  const treeChanged =
    sameSource &&
    ((update.collapsedNodeIds ?? []).length !== (rendered.collapsedNodeIds ?? []).length ||
      (update.collapsedNodeIds ?? []).some(
        (id, index) => id !== (rendered.collapsedNodeIds ?? [])[index],
      ));
  const nodeChanged =
    sameReader && sameSelection && update.selectedNodeId !== rendered.selectedNodeId;
  const requestChanged =
    sameReader &&
    sameSelection &&
    (update.selectedRequestId ?? null) !== (rendered.selectedRequestId ?? null);
  const requestTabChanged =
    sameReader &&
    sameSelection &&
    (current.requestTab ?? 'overview') === (rendered.requestTab ?? 'overview') &&
    update.requestTab !== rendered.requestTab;
  const newTabChanged =
    sameReader && sameSelection && update.workbenchTab !== rendered.workbenchTab;
  const detailOpenChanged =
    sameReader && sameSelection && update.detailOpen !== rendered.detailOpen;
  const widthChanged = sameSource && update.detailWidth !== rendered.detailWidth;
  const timelineChanged = sameSource && update.timelineMode !== rendered.timelineMode;
  const expansionChanged =
    sameSource &&
    canonicalSerialize(update.expansion ?? null) !== canonicalSerialize(rendered.expansion ?? null);
  const nodeExpansionChanged =
    sameSource &&
    canonicalSerialize(update.expandedNodeIds ?? []) !==
      canonicalSerialize(rendered.expandedNodeIds ?? []);
  const filtersChanged =
    sameSource &&
    canonicalSerialize(update.filters ?? null) !== canonicalSerialize(rendered.filters ?? null);
  const observationChanged =
    sameReader && sameSelection && update.selectedObservationId !== rendered.selectedObservationId;
  const relatedSelectionChanged =
    sameReader &&
    sameSelection &&
    canonicalSerialize(update.selectedRelatedScope ?? null) !==
      canonicalSerialize(rendered.selectedRelatedScope ?? null);
  const sameDetail =
    sameReader &&
    sameSelection &&
    (current.workbenchTab ?? 'overview') === (rendered.workbenchTab ?? 'overview') &&
    (current.requestTab ?? 'overview') === (rendered.requestTab ?? 'overview') &&
    (current.selectedObservationId ?? null) === (rendered.selectedObservationId ?? null) &&
    (current.detailTab ?? 'lifecycle') === (rendered.detailTab ?? 'lifecycle');
  const detailAnchorChanged = sameDetail && update.detailScrollTop !== rendered.detailScrollTop;
  const expandedChanged =
    sameDetail &&
    (rendered.detailTab ?? 'lifecycle') === 'lifecycle' &&
    (update.expandedEventIds.length !== rendered.expandedEventIds.length ||
      update.expandedEventIds.some((id, index) => id !== rendered.expandedEventIds[index]));
  const selectedChanged =
    sameDetail &&
    (rendered.detailTab ?? 'lifecycle') === 'lifecycle' &&
    update.selectedEventId !== rendered.selectedEventId;
  const anchorChanged =
    sameReader &&
    (update.readingAnchor.eventId !== rendered.readingAnchor.eventId ||
      update.readingAnchor.offset !== rendered.readingAnchor.offset ||
      update.readingAnchor.scrollTop !== rendered.readingAnchor.scrollTop);
  if (
    !modeChanged &&
    !tabChanged &&
    !treeChanged &&
    !nodeChanged &&
    !requestChanged &&
    !requestTabChanged &&
    !newTabChanged &&
    !detailOpenChanged &&
    !widthChanged &&
    !timelineChanged &&
    !expansionChanged &&
    !nodeExpansionChanged &&
    !filtersChanged &&
    !observationChanged &&
    !relatedSelectionChanged &&
    !detailAnchorChanged &&
    !expandedChanged &&
    !selectedChanged &&
    !anchorChanged
  )
    return current;
  return {
    ...current,
    ...(modeChanged ? { listMode: update.listMode } : {}),
    ...(tabChanged ? { detailTab: update.detailTab } : {}),
    ...(treeChanged ? { collapsedNodeIds: [...(update.collapsedNodeIds ?? [])] } : {}),
    ...(nodeChanged ? { selectedNodeId: update.selectedNodeId } : {}),
    ...(requestChanged ? { selectedRequestId: update.selectedRequestId ?? null } : {}),
    ...(requestTabChanged ? { requestTab: update.requestTab } : {}),
    ...(newTabChanged ? { workbenchTab: update.workbenchTab } : {}),
    ...(detailOpenChanged ? { detailOpen: update.detailOpen } : {}),
    ...(widthChanged ? { detailWidth: update.detailWidth } : {}),
    ...(timelineChanged ? { timelineMode: update.timelineMode } : {}),
    ...(expansionChanged
      ? {
          expansion: {
            ...(current.expansion ?? { rounds: true, calls: true, subcalls: false }),
            ...Object.fromEntries(
              Object.entries(update.expansion ?? {}).filter(
                ([key, value]) =>
                  value !==
                  rendered.expansion?.[key as keyof NonNullable<TrajectoryViewState['expansion']>],
              ),
            ),
          },
        }
      : {}),
    ...(nodeExpansionChanged ? { expandedNodeIds: [...(update.expandedNodeIds ?? [])] } : {}),
    ...(filtersChanged
      ? {
          filters: update.filters
            ? Object.assign(
                { ...(current.filters ?? update.filters) },
                ...Object.entries(update.filters)
                  .filter(
                    ([key, value]) =>
                      canonicalSerialize(value) !==
                      canonicalSerialize(
                        rendered.filters?.[
                          key as keyof NonNullable<TrajectoryViewState['filters']>
                        ] ?? null,
                      ),
                  )
                  .map(([key, value]) => ({ [key]: structuredClone(value) })),
              )
            : undefined,
        }
      : {}),
    ...(observationChanged ? { selectedObservationId: update.selectedObservationId } : {}),
    ...(relatedSelectionChanged
      ? {
          selectedRelatedScope: update.selectedRelatedScope
            ? { ...update.selectedRelatedScope }
            : null,
        }
      : {}),
    ...(detailAnchorChanged ? { detailScrollTop: update.detailScrollTop } : {}),
    ...(expandedChanged ? { expandedEventIds: [...update.expandedEventIds] } : {}),
    ...(selectedChanged ? { selectedEventId: update.selectedEventId } : {}),
    ...(anchorChanged ? { readingAnchor: { ...update.readingAnchor } } : {}),
  };
}
