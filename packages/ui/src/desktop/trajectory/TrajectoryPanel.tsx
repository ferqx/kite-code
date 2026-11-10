import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Clock01Icon,
  MinusSignIcon,
  MoreHorizontalIcon,
  Search01Icon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  parseDecimal64,
  projectTrajectory,
  type TrajectoryEvent,
  type TrajectoryEvidenceRef,
  type TrajectoryIntegrity,
  type TrajectoryProjection,
} from '@kite-ai/trajectory';
import {
  type ComponentProps,
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, AlertDescription, AlertTitle } from '../components/ui/alert';
import { Badge } from '../components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Input } from '../components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../components/ui/resizable';
import { ScrollArea } from '../components/ui/scroll-area';
import { Sheet, SheetContent, SheetTitle } from '../components/ui/sheet';
import { cn } from '../lib/utils';
import { Button } from '../ui';
import { trajectoryFactAnchor } from './fact-anchor';
import {
  loopModelLabel,
  loopPartLabel,
  loopPartSnippet,
  loopSystemPreparations,
} from './loop-materials';
import { composeTrajectoryScopes, trajectoryChildScopeTarget } from './related';
import { normalizeTrajectoryRequestTab, trajectoryRequestTargets } from './request-details';
import { buildTrajectoryRequestMarkers } from './request-markers';
import { TrajectoryDetails, trajectoryPhaseLabels, trajectoryTypeBadge } from './TrajectoryDetails';
import { TrajectoryRequestDetails } from './TrajectoryRequestDetails';
import { TrajectoryTimeline } from './TrajectoryTimeline';
import { buildTrajectoryTree } from './tree';
import {
  type TrajectoryDetailTab,
  type TrajectoryViewState,
  trajectoryViewStateKey,
} from './view-state';
import {
  buildTrajectoryWorkbenchIndex,
  defaultWorkbenchFilters,
  filterTrajectoryWorkbench,
  type WorkbenchFilters,
  type WorkbenchRow,
  type WorkbenchSummary,
} from './workbench';
import { normalizeTrajectoryDetailTab, trajectoryMaterialTargets } from './workbench-details';
export interface TrajectoryEvidenceView {
  eventId: string;
  evidenceId: string;
  contentVersion: string;
  status:
    | 'loading'
    | 'available'
    | 'partial'
    | 'truncated'
    | 'missing'
    | 'unavailable'
    | 'redacted'
    | 'empty';
  kind?: TrajectoryEvidenceRef['kind'];
  mediaType?: string;
  /** Already validated public projection supplied by the material owner. */
  data?: unknown;
  rawText?: string;
  /** Host-owned, validated original raster Blob URL, revoked on scope/tab close. */
  imageUrl?: string;
  text?: string;
  notice?: string;
  details?: { label: string; text: string }[];
}
export interface TrajectoryMaterialTarget {
  event: TrajectoryEvent;
  reference: TrajectoryEvidenceRef;
}
export interface TrajectoryPanelProps {
  state: TrajectoryViewState;
  onStateChange: (state: TrajectoryViewState) => void;
  events: readonly TrajectoryEvent[];
  projection: TrajectoryProjection | null;
  integrity: TrajectoryIntegrity;
  mode: 'live' | 'history' | 'replay';
  playing: boolean;
  offline?: boolean;
  visible?: boolean;
  loading?: boolean;
  exhausted: boolean;
  hasNextPage?: boolean;
  newEventsAvailable?: boolean;
  errorCode?: string;
  onRetry?: () => void;
  onReadMore?: () => void;
  onPreviousPage?: () => void;
  canReadPrevious?: boolean;
  pageLabel?: string;
  onSeek: (cursor: string) => void;
  onStep: (direction: -1 | 1) => void;
  onPlay: () => void;
  onPause: () => void;
  onReturnToLatest: () => void;
  onVisibilityChange?: (visible: boolean) => void;
  onMaterialsRetry?: () => void;
  onMaterialsChange?: (targets: readonly TrajectoryMaterialTarget[]) => void;
  materials?: readonly TrajectoryEvidenceView[];
  onLoopMaterialsChange?: (targets: readonly TrajectoryMaterialTarget[]) => void;
  onLoopMaterialsRetry?: () => void;
  loopMaterials?: readonly TrajectoryEvidenceView[];
  onEvidenceOpen?: (event: TrajectoryEvent, reference: TrajectoryEvidenceRef) => void;
  onEvidenceClose?: () => void;
  evidence?: TrajectoryEvidenceView | null;
  onExport?: (includeEvidence: boolean) => void;
  onOpenOffline?: () => void;
  relatedTrajectories?: readonly {
    parentNodeId: string;
    projection: TrajectoryProjection | null;
    status?: 'loading' | 'unavailable';
  }[];
  onExpandedChildrenChange?: (
    targets: readonly {
      parentNodeId: string;
      sessionId: string;
      runId: string;
      carrierExecutionId?: string;
    }[],
  ) => void;
}
function bounded(cursor: string, upper: string) {
  try {
    return parseDecimal64(cursor) <= parseDecimal64(upper);
  } catch {
    return false;
  }
}
function rowMetadata(row: WorkbenchRow): string {
  if (row.kind === 'run') return '';
  const step = row.step;
  if (row.kind === 'model' && row.category === 'approval')
    return [
      step?.display?.modelName,
      row.operation?.reconnectCount ? `重连 ${row.operation.reconnectCount} 次` : null,
    ]
      .filter(Boolean)
      .join(' · ');
  const display = ['shell', 'child'].includes(row.operation?.type ?? '')
    ? (row.operation?.members.find((member) => member.nodeId === row.nodeId)?.step?.display ??
      step?.display)
    : step?.display;
  const folded = row.collapse;
  if (folded?.collapsed && folded.hiddenCount > 0) {
    if (row.summary)
      return `${row.operation?.type === 'child' ? '内部：' : ''}${summaryLabel(row.summary)}`;
    if (row.operation?.type === 'child' || row.kind === 'child') return '内部轨迹尚未载入';
  }
  if (row.kind === 'message')
    return display?.summary
      ? step?.messageStatus === 'incomplete'
        ? '已保存前缀'
        : ''
      : step?.messageStatus === 'incomplete'
        ? '已保存前缀'
        : step?.messageStatus === 'complete'
          ? '已保存的消息'
          : '完整性未记录';
  return [
    row.operation?.reconnectCount ? `重连 ${row.operation.reconnectCount} 次` : null,
    row.operation?.type !== 'child' && display?.summary !== display?.title
      ? display?.summary
      : null,
    display?.requestContext
      ? `输入准备：${display.requestContext.systemMessages} 条系统指令 · ${display.requestContext.historyMessages} 条上下文 · ${display.requestContext.tools} 个工具`
      : null,
    step?.definitionId &&
    !row.loop &&
    !row.requestIndex &&
    row.kind !== 'model' &&
    !display?.summary &&
    !display?.title &&
    !display?.modelName &&
    step.definitionId !== row.label &&
    !row.label.endsWith(` · ${step.definitionId}`)
      ? step.definitionId
      : null,
    row.relationNotice,
  ]
    .filter(Boolean)
    .join(' · ');
}
function summaryLabel(summary?: WorkbenchSummary): string {
  if (!summary) return '执行信息尚未记录';
  const actions = [
    summary.model ? `${summary.model} 次 Agent 处理` : null,
    summary.tool ? `${summary.tool} 个工具操作` : null,
    summary.child ? `${summary.child} 个子任务` : null,
    summary.approval ? `${summary.approval} 次审批` : null,
    summary.compression ? `${summary.compression} 次压缩` : null,
  ].filter(Boolean);
  if (actions.length) return actions.join(' · ');
  const messages = summary.userMessages + summary.assistantMessages;
  return messages ? `${messages} 条消息` : '尚无执行操作';
}
function rowDuration(row: WorkbenchRow): string {
  const duration = row.interval.durationMs;
  if (duration === undefined) return row.interval.unknownReason === 'not_a_call' ? '' : '未知';
  return `${duration < 1000 ? `${Math.round(duration)}ms` : `${(duration / 1000).toFixed(1)}s`}${row.interval.ongoing ? '+' : ''}`;
}
function statusIcon(row: WorkbenchRow) {
  if (row.kind === 'message' && row.step?.messageStatus === 'complete') return Tick02Icon;
  const phase = row.phase;
  if (phase === 'completed') return Tick02Icon;
  if (phase === 'failed' || phase === 'cancelled') return Cancel01Icon;
  if (phase === 'outcome_unknown') return AlertCircleIcon;
  if (phase === 'observed') return MinusSignIcon;
  return Clock01Icon;
}
function InitialPanel({ defaultSize, ...props }: ComponentProps<typeof ResizablePanel>) {
  const initial = useRef(defaultSize);
  return <ResizablePanel {...props} defaultSize={initial.current} />;
}
const typeLabels = {
  message: '消息',
  model: '思考',
  tool: '工具',
  compression: '自动压缩',
  approval: '审批',
};
const emptyEvents: readonly TrajectoryEvent[] = [];

/** A single fixed-prefix workbench. All I/O and authorization remain owned by its host. */
export function TrajectoryPanel(props: TrajectoryPanelProps) {
  const { state, onStateChange } = props;
  const callbacks = useRef(props);
  callbacks.current = props;
  const panel = useRef<HTMLElement>(null),
    workspace = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000),
    [height, setHeight] = useState(0),
    [scrollTop, setScrollTop] = useState(state.readingAnchor.scrollTop);
  const [showReplay, setShowReplay] = useState(false),
    [showInformation, setShowInformation] = useState(false),
    [position, setPosition] = useState(state.cursor),
    [invalid, setInvalid] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(state.selectedNodeId ?? null);
  const id = useId(),
    visible = props.visible !== false,
    descriptor = state.descriptor;
  const events = useMemo(
    () =>
      props.events.length
        ? props.events.filter((event) => bounded(event.sequence, state.cursor))
        : emptyEvents,
    [props.events, state.cursor],
  );
  const projected = useMemo(
    () =>
      props.projection?.atCursor === state.cursor
        ? props.projection
        : events.length
          ? projectTrajectory(events, { atCursor: state.cursor })
          : null,
    [props.projection, events, state.cursor],
  );
  const waiting = props.loading && !projected && events.length === 0;
  const scopes = useMemo(
    () =>
      projected
        ? composeTrajectoryScopes(
            projected,
            (props.relatedTrajectories ?? []).flatMap((scope) =>
              scope.projection
                ? [{ parentNodeId: scope.parentNodeId, projection: scope.projection }]
                : [],
            ),
          )
        : null,
    [projected, props.relatedTrajectories],
  );
  const tree = useMemo(
    () => scopes?.tree ?? buildTrajectoryTree(projected, events),
    [scopes, projected, events],
  );
  const filters = useMemo(
    () => ({
      ...defaultWorkbenchFilters(),
      ...state.filters,
      duration: 'all' as const,
      runKeys: null,
      subcalls: 'all' as const,
      includeAdministrative: state.listMode === 'all_events',
    }),
    [state.filters, state.listMode],
  );
  const activeFilters =
    filters.types.length !== 5 || filters.childAgents === false || filters.metadataQuery !== '';
  const index = useMemo(
    () => buildTrajectoryWorkbenchIndex(scopes?.projection ?? projected, tree, { loopParts: true }),
    [scopes, projected, tree],
  );
  const workbench = useMemo(
    () =>
      filterTrajectoryWorkbench(index, filters, state.collapsedNodeIds ?? [], {
        ...(state.expansion ?? { rounds: true, calls: true, subcalls: false }),
        expandedNodeIds: state.expandedNodeIds ?? [],
      }),
    [index, filters, state.collapsedNodeIds, state.expansion, state.expandedNodeIds],
  );
  const rows = useMemo(
    () =>
      workbench.visibleRows.filter(
        (row) => state.listMode === 'all_events' || row.kind !== 'session',
      ),
    [workbench, state.listMode],
  );
  const requestMarkers = useMemo(
    () => buildTrajectoryRequestMarkers(workbench.rows, rows),
    [workbench.rows, rows],
  );
  const requestCandidate = workbench.byId.get(state.selectedRequestId ?? '');
  const selectedRequest =
    requestCandidate?.kind === 'model' &&
    (requestCandidate.category === 'model' ||
      (requestCandidate.category === 'compression' &&
        requestCandidate.operation?.type === 'compression')) &&
    !requestCandidate.virtualPart &&
    !requestCandidate.event
      ? requestCandidate
      : undefined;
  const requestTab = normalizeTrajectoryRequestTab(state.requestTab);
  const selectedCandidate =
    selectedRequest ??
    workbench.byId.get(state.selectedNodeId ?? 'session') ??
    workbench.rows.find((row) => row.nodeId === state.selectedNodeId);
  const selectedRow =
    !selectedRequest && selectedCandidate?.presentationRepresentativeId
      ? (workbench.byId.get(selectedCandidate.presentationRepresentativeId) ?? selectedCandidate)
      : selectedCandidate;
  const selected = selectedRow ? tree.byId.get(selectedRow.nodeId) : undefined;
  const detailOpen = state.detailOpen === true;
  const expandedChildren = useMemo(() => {
    const wanted = new Set(
      workbench.visibleRows
        .filter((row) => row.operation?.type === 'child' && !row.collapse?.collapsed)
        .map((row) => row.id),
    );
    if (detailOpen && selectedRow?.step?.sessionId !== descriptor?.sessionId) {
      for (const scope of props.relatedTrajectories ?? []) {
        if (
          scope.projection?.steps.some((step) => step.sessionId === selectedRow?.step?.sessionId)
        ) {
          const carrier = workbench.byId.get(scope.parentNodeId);
          if (carrier) wanted.add(carrier.id);
        }
      }
    }
    const targets = workbench.rows
      .filter((row) => wanted.has(row.id))
      .flatMap((row) => {
        const members = row.operation?.members ?? [row];
        const child =
          members.find(
            (member) =>
              member.kind === 'child' && member.step?.childSessionId && member.step.childRunId,
          ) ??
          members.find(
            (member) =>
              member.kind === 'job' &&
              member.step?.childSessionId &&
              member.step.display?.targetRunId,
          );
        const target = child
          ? trajectoryChildScopeTarget(scopes?.projection ?? projected, tree, child.nodeId)
          : null;
        return target ? [target] : [];
      });
    const retained = state.selectedRelatedScope;
    if (
      detailOpen &&
      retained &&
      retained.nodeId === state.selectedNodeId &&
      !targets.some((target) => target.parentNodeId === retained.parentNodeId)
    ) {
      const target = trajectoryChildScopeTarget(
        scopes?.projection ?? projected,
        tree,
        retained.parentNodeId,
      );
      if (target?.sessionId === retained.sessionId && target.runId === retained.runId)
        targets.push(target);
    }
    return targets;
  }, [
    workbench,
    detailOpen,
    selectedRow,
    descriptor?.sessionId,
    props.relatedTrajectories,
    state.selectedRelatedScope,
    state.selectedNodeId,
    scopes,
    projected,
    tree,
  ]);
  const expandedChildrenKey = JSON.stringify(expandedChildren);
  // Exact visible branches and retained child detail, without re-opening unchanged scopes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: The stable target key represents the entire value.
  useEffect(() => {
    callbacks.current.onExpandedChildrenChange?.(expandedChildren);
  }, [expandedChildrenKey]);
  const tab = selectedRow
    ? normalizeTrajectoryDetailTab(selectedRow, state.workbenchTab)
    : 'overview';
  const targets = useMemo(
    () =>
      selectedRow && detailOpen && visible && !waiting
        ? selectedRequest
          ? trajectoryRequestTargets(selectedRequest, requestTab, state.selectedObservationId)
          : trajectoryMaterialTargets(selectedRow, tab, state.selectedObservationId, workbench.byId)
        : [],
    [
      selectedRow,
      selectedRequest,
      requestTab,
      detailOpen,
      visible,
      waiting,
      tab,
      state.selectedObservationId,
      workbench.byId,
    ],
  );
  const identity = descriptor ? trajectoryViewStateKey(descriptor) : 'empty';
  const targetKey = `${identity}:${state.cursor}:${targets.map((target) => `${target.event.eventId}/${target.reference.evidenceId}/${target.reference.contentVersion}`).join('|')}`;
  const materialTargets = useRef(targets);
  materialTargets.current = targets;
  const onMaterialsChange = props.onMaterialsChange;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Exact immutable source/ref identity controls a read, not derived array allocation.
  useEffect(() => {
    onMaterialsChange?.(materialTargets.current);
    return () => onMaterialsChange?.([]);
  }, [targetKey, onMaterialsChange]);
  useEffect(() => {
    callbacks.current.onVisibilityChange?.(visible);
    if (!visible) {
      callbacks.current.onPause();
      callbacks.current.onEvidenceClose?.();
    }
    return () => {
      callbacks.current.onVisibilityChange?.(false);
      callbacks.current.onPause();
      callbacks.current.onEvidenceClose?.();
    };
  }, [visible]);
  useEffect(() => {
    setPosition(state.cursor);
    setInvalid(false);
  }, [state.cursor]);
  useLayoutEffect(() => {
    const element = workspace.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0) setWidth(rect.width);
      const h = viewport.current?.clientHeight;
      if (h) setHeight(h);
    });
    observer.observe(element);
    const rect = element.getBoundingClientRect();
    if (rect.width > 0) setWidth(rect.width);
    return () => observer.disconnect();
  }, []);
  const narrow = width < 840;
  const restored = useRef<{ identity: string; viewport: HTMLDivElement } | null>(null);
  const navigationPending = useRef(false);
  const presentationScope = JSON.stringify([
    descriptor?.storeId,
    descriptor?.sessionId,
    descriptor?.runId,
    descriptor?.executionId,
    descriptor?.eventKinds,
  ]);
  const presentationControls = JSON.stringify([
    filters,
    state.listMode,
    state.expansion,
    state.collapsedNodeIds,
    state.expandedNodeIds,
  ]);
  const factRevision = `${state.cursor}:${tree.root.eventOrder.length}:${tree.root.eventOrder.at(-1) ?? ''}`;
  const factPresentation = useRef<{
    scope: string;
    controls: string;
    revision: string;
    cursor: string;
    rowIds: string[];
    scrollTop: number;
    mode: string;
  } | null>(null);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (waiting || !element) return;
    const previous = factPresentation.current;
    const incoming =
      previous &&
      previous.scope === presentationScope &&
      previous.controls === presentationControls &&
      previous.revision !== factRevision &&
      parseDecimal64(state.cursor) >= parseDecimal64(previous.cursor) &&
      props.mode === 'live' &&
      previous.mode === 'live' &&
      !navigationPending.current;
    const adjusted = incoming
      ? trajectoryFactAnchor(previous.rowIds, rows, previous.scrollTop, workbench.byId)
      : undefined;
    if (
      adjusted !== undefined ||
      restored.current?.identity !== identity ||
      restored.current.viewport !== element
    ) {
      // Docking details replaces the list viewport; restore it before its first paint.
      element.scrollTop = adjusted ?? state.readingAnchor.scrollTop;
      setScrollTop(element.scrollTop);
      if (element.clientHeight) setHeight(element.clientHeight);
      restored.current = { identity, viewport: element };
    }
    factPresentation.current = {
      scope: presentationScope,
      controls: presentationControls,
      revision: factRevision,
      cursor: state.cursor,
      rowIds: rows.map((row) => row.id),
      scrollTop: element.scrollTop,
      mode: props.mode,
    };
    navigationPending.current = false;
  });
  const returnToLatest = () => {
    navigationPending.current = true;
    props.onReturnToLatest();
  };
  const changeFilters = (patch: Partial<WorkbenchFilters>) =>
    onStateChange({ ...state, filters: { ...filters, ...patch } });
  const choose = (nodeId: string, requestedTab?: TrajectoryDetailTab, request = false) => {
    const original =
      workbench.byId.get(nodeId) ?? workbench.rows.find((item) => item.nodeId === nodeId);
    const row =
      !request && original?.presentationRepresentativeId
        ? (workbench.byId.get(original.presentationRepresentativeId) ?? original)
        : original;
    if (!row) return;
    const same = selectedRow?.id === row.id && !!selectedRequest === request;
    const nextTab = requestedTab
      ? normalizeTrajectoryDetailTab(row, requestedTab)
      : same
        ? tab
        : normalizeTrajectoryDetailTab(row, state.workbenchTab);
    const relatedScope = props.relatedTrajectories?.find((scope) =>
      scope.projection?.steps.some(
        (step) => step.sessionId === row.step?.sessionId && step.runId === row.step?.runId,
      ),
    );
    const relatedTarget =
      relatedScope &&
      expandedChildren.find((target) => target.parentNodeId === relatedScope.parentNodeId);
    setFocusId(
      request
        ? ([...requestMarkers].find(([, value]) => value.marker && value.ownerId === row.id)?.[0] ??
            row.presentationRepresentativeId ??
            row.id)
        : row.id,
    );
    onStateChange({
      ...state,
      selectedNodeId: row.id,
      selectedRequestId: request ? row.id : null,
      requestTab: request ? (same ? requestTab : 'overview') : state.requestTab,
      selectedRelatedScope: relatedTarget
        ? { ...relatedTarget, nodeId: row.id }
        : same
          ? state.selectedRelatedScope
          : null,
      detailOpen: true,
      workbenchTab: request ? state.workbenchTab : nextTab,
      selectedObservationId: same ? state.selectedObservationId : (row.event?.eventId ?? null),
      detailScrollTop: same ? state.detailScrollTop : 0,
    });
  };
  const chooseRequestResult = (nodeId: string) => {
    const original = workbench.byId.get(nodeId);
    if (!original) return;
    const cutoff = state.selectedObservationId
      ? selectedRequest?.events.find((event) => event.eventId === state.selectedObservationId)
      : undefined;
    const messageEvent =
      original.kind === 'message'
        ? [...original.events]
            .reverse()
            .find(
              (event) =>
                event.kind === 'message' &&
                (!state.selectedObservationId ||
                  (cutoff && parseDecimal64(event.sequence) <= parseDecimal64(cutoff.sequence))),
            )
        : undefined;
    if (original.kind === 'message' && state.selectedObservationId && !messageEvent) return;
    onStateChange({
      ...state,
      selectedRequestId: null,
      selectedNodeId: original.id,
      workbenchTab: normalizeTrajectoryDetailTab(
        original,
        original.category === 'compression' ? 'preview' : 'content',
      ),
      selectedObservationId: original.virtualPart
        ? state.selectedObservationId
        : (messageEvent?.eventId ?? original.event?.eventId ?? null),
      detailScrollTop: 0,
    });
    setFocusId(original.id);
  };
  const focusRow = (nodeId: string | undefined, reveal = true) => {
    if (!nodeId) return;
    nodeId = workbench.byId.get(nodeId)?.presentationRepresentativeId ?? nodeId;
    const hiddenOutput = workbench.byId.get(nodeId);
    if (
      hiddenOutput?.presentationHidden &&
      (hiddenOutput.virtualPart?.kind === 'reply' || hiddenOutput.outputSuppressed)
    ) {
      const owner = workbench.byId.get(
        hiddenOutput.virtualPart?.ownerId ?? hiddenOutput.originalParentId ?? '',
      );
      nodeId = owner?.presentationRepresentativeId ?? nodeId;
    }
    setFocusId(nodeId);
    const index = rows.findIndex((row) => row.id === nodeId);
    if (index < 0) {
      viewport.current?.focus({ preventScroll: true });
      return;
    }
    if (reveal && viewport.current && index >= 0) {
      const top = index * 38;
      if (
        top < viewport.current.scrollTop ||
        top + 38 > viewport.current.scrollTop + viewport.current.clientHeight
      ) {
        viewport.current.scrollTop = top;
        setScrollTop(top);
      }
    }
    requestAnimationFrame(() =>
      [...(viewport.current?.querySelectorAll<HTMLButtonElement>('.trajectory-node-select') ?? [])]
        .find((button) => button.dataset.nodeId === nodeId)
        ?.focus({ preventScroll: true }),
    );
  };
  const restoreDetailFocus = () => {
    const requestId = callbacks.current.state.selectedRequestId;
    if (requestId) {
      const point = [
        ...(panel.current?.querySelectorAll<HTMLButtonElement>('.trajectory-request-marker') ?? []),
      ].find((button) => button.dataset.requestOwner === requestId);
      if (point) {
        point.focus({ preventScroll: true });
        return;
      }
    }
    focusRow(callbacks.current.state.selectedNodeId ?? undefined, false);
  };
  const close = () => {
    onStateChange({ ...state, detailOpen: false });
    // The modal owns focus until Presence and hideOthers have both retired.
    if (!narrow) requestAnimationFrame(restoreDetailFocus);
  };
  const collapsed = new Set(state.collapsedNodeIds ?? []);
  const toggle = (nodeId: string) => {
    const next = new Set(collapsed);
    const expanded = new Set(state.expandedNodeIds ?? []);
    const row = workbench.byId.get(nodeId);
    if (row?.collapse?.collapsed || next.has(nodeId)) {
      next.delete(nodeId);
      expanded.add(nodeId);
    } else {
      next.add(nodeId);
      expanded.delete(nodeId);
    }
    onStateChange({ ...state, collapsedNodeIds: [...next], expandedNodeIds: [...expanded] });
  };
  const virtual = height > 0 && rows.length > 200;
  const start = virtual ? Math.max(0, Math.floor(scrollTop / 38) - 8) : 0;
  const end = virtual ? Math.min(rows.length, start + Math.ceil(height / 38) + 16) : rows.length;
  const focus = rows.some((row) => row.id === focusId) ? focusId : rows[0]?.id;
  const mountedIndices = Array.from({ length: end - start }, (_, offset) => start + offset);
  const activeId =
    typeof document !== 'undefined'
      ? (document.activeElement as HTMLElement | null)?.dataset?.nodeId
      : undefined;
  const activeIndex = activeId ? rows.findIndex((row) => row.id === activeId) : -1;
  if (virtual && activeIndex >= 0 && (activeIndex < start || activeIndex >= end))
    mountedIndices.push(activeIndex);
  mountedIndices.sort((left, right) => left - right);
  const loopTargets = useMemo(() => {
    if (!visible || waiting) return [];
    const first = Math.max(0, Math.floor(scrollTop / 38) - 1);
    const last = Math.min(rows.length, first + Math.ceil((height || 600) / 38) + 2);
    const owners = new Set<string>();
    for (const row of rows.slice(first, last)) {
      let current: WorkbenchRow | undefined = row;
      while (
        current &&
        (current.kind !== 'model' || current.category !== 'model' || current.virtualPart)
      )
        current = workbench.byId.get(current.virtualPart?.ownerId ?? current.parentId ?? '');
      if (current) owners.add(current.id);
      if (owners.size >= 4) break;
    }
    return [...owners].flatMap((key) => {
      const row = workbench.byId.get(key)!;
      if (row.collapse?.collapsed && row.step?.display?.modelName) return [];
      return trajectoryMaterialTargets(row, 'preview').filter(
        (target) => !row.collapse?.collapsed || target.reference.kind === 'model_input',
      );
    });
  }, [rows, workbench, scrollTop, height, visible, waiting]);
  const loopTargetKey = `${identity}:${state.cursor}:${loopTargets.map((target) => `${target.event.eventId}/${target.reference.evidenceId}/${target.reference.contentVersion}`).join('|')}`;
  const loopTargetRef = useRef(loopTargets);
  loopTargetRef.current = loopTargets;
  const onLoopMaterialsChange = props.onLoopMaterialsChange;
  // biome-ignore lint/correctness/useExhaustiveDependencies: The key contains the complete immutable scope and original refs.
  useEffect(() => {
    onLoopMaterialsChange?.(loopTargetRef.current);
    return () => onLoopMaterialsChange?.([]);
  }, [loopTargetKey, onLoopMaterialsChange]);
  const detailMaterials = useMemo(() => {
    const values = new Map<string, TrajectoryEvidenceView>();
    for (const value of [...(props.loopMaterials ?? []), ...(props.materials ?? [])]) {
      const key = `${value.eventId}/${value.evidenceId}/${value.contentVersion}`;
      if (value.status !== 'loading' || !values.has(key)) values.set(key, value);
    }
    return [...values.values()];
  }, [props.loopMaterials, props.materials]);
  const loopMaterials = detailMaterials;
  const preparations = useMemo(
    () => loopSystemPreparations(workbench.rows, loopMaterials),
    [workbench.rows, loopMaterials],
  );
  const visibleParents = new Set(rows.map((row) => row.parentId));
  const expandableRows = new Set(workbench.rows.map((row) => row.parentId));
  const { runLabels, childRunKeys } = useMemo(() => {
    const runLabels = new Map(workbench.runOptions.map((option) => [option.key, option.label]));
    const childRunKeys = new Map<string, string>();
    for (const row of workbench.rows)
      if (row.runKey) {
        if (row.parentId && !childRunKeys.has(row.parentId))
          childRunKeys.set(row.parentId, row.runKey);
      }
    return { runLabels, childRunKeys };
  }, [workbench]);
  const list = (
    <nav className="trajectory-tree" aria-label="轨迹日志">
      <div className="trajectory-tree-heading">
        <span>执行过程</span>
        <span role="status">
          {waiting ? '读取中' : activeFilters ? `找到 ${workbench.matchingIds.size} 项` : ''}
        </span>
      </div>
      <ScrollArea
        className="trajectory-tree-scroll"
        nativeScrollbars
        chainScroll
        viewportRef={viewport}
        viewportProps={{
          tabIndex: 0,
          'aria-label': '轨迹事件树',
          onScroll: (event) => {
            if (!visible || waiting) return;
            const element = event.currentTarget;
            if (factPresentation.current) factPresentation.current.scrollTop = element.scrollTop;
            setScrollTop(element.scrollTop);
            if (element.clientHeight) setHeight(element.clientHeight);
            const index = Math.floor(element.scrollTop / 38);
            onStateChange({
              ...state,
              readingAnchor: {
                eventId: rows[index]?.nodeId ?? null,
                offset: -(element.scrollTop % 38),
                scrollTop: element.scrollTop,
              },
            });
          },
        }}
      >
        {waiting ? (
          <p className="trajectory-tree-loading" role="status">
            正在读取事件树…
          </p>
        ) : (
          <table
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: A semantic table is the WAI-ARIA treegrid pattern.
            role="treegrid"
            aria-label="事件层级"
            aria-rowcount={rows.length}
            className="trajectory-tree-list"
          >
            <tbody>
              {mountedIndices.map((index, mountedIndex) => {
                const row = rows[index]!;
                const node = tree.byId.get(row.nodeId)!;
                const gap = index - (mountedIndices[mountedIndex - 1] ?? -1) - 1;
                const actualCollapsed =
                  row.collapse?.collapsed ?? (collapsed.has(row.id) && !visibleParents.has(row.id));
                const hasChildScope =
                  row.operation?.type === 'child' &&
                  row.operation.members.some(
                    (member) =>
                      member.step?.childSessionId &&
                      (member.step.childRunId || member.step.display?.targetRunId),
                  );
                const hasChildren =
                  !row.event &&
                  !row.virtualPart &&
                  (row.kind === 'run' || row.operation?.type === 'child' || row.kind === 'child') &&
                  (expandableRows.has(row.id) || hasChildScope);
                const requestOwner = row.virtualPart
                  ? workbench.byId.get(row.virtualPart.ownerId)
                  : undefined;
                const requestMarker = requestMarkers.get(row.id);
                const markerOwner = requestMarker?.marker
                  ? workbench.byId.get(requestMarker.ownerId)
                  : undefined;
                const markerLabel =
                  markerOwner?.category === 'compression'
                    ? '查看压缩模型请求'
                    : requestMarker?.requestIndex !== undefined
                      ? `查看第 ${requestMarker.requestIndex} 次模型请求`
                      : '查看模型请求';
                const thinking = row.virtualPart?.kind === 'thinking';
                const preparation = preparations.get(row.id);
                const timingRow = thinking && requestOwner ? requestOwner : row;
                const displayPhase = thinking
                  ? requestOwner?.phase
                  : (row.requestPhase ?? row.loopPhase ?? row.phase);
                const isRun = row.kind === 'run' && !row.event;
                const badge = trajectoryTypeBadge(row);
                const related = props.relatedTrajectories?.find(
                  (scope) => workbench.byId.get(scope.parentNodeId)?.id === row.id,
                );
                const metadata = [
                  row.virtualPart?.kind === 'thinking' && requestOwner?.operation?.reconnectCount
                    ? `重连 ${requestOwner.operation.reconnectCount} 次`
                    : null,
                  preparation === 'unchanged'
                    ? '提示词与工具目录未变'
                    : row.virtualPart
                      ? loopPartSnippet(row, loopMaterials)
                      : rowMetadata(row),
                  row.compact && thinking ? '精简展示' : null,
                  related?.status === 'loading'
                    ? '正在读取内部轨迹…'
                    : related?.status === 'unavailable'
                      ? '内部轨迹读取未完成'
                      : null,
                ]
                  .filter(Boolean)
                  .join(' · ');
                const runKey = row.runKey ?? childRunKeys.get(row.id);
                const display = ['shell', 'child'].includes(row.operation?.type ?? '')
                  ? (row.operation?.members.find((member) => member.nodeId === row.nodeId)?.step
                      ?.display ?? row.step?.display)
                  : row.step?.display;
                const rowLabel =
                  row.kind === 'model' && row.category === 'approval'
                    ? row.label
                    : row.virtualPart
                      ? row.virtualPart.kind === 'thinking' && requestOwner
                        ? `思考 · ${loopModelLabel(requestOwner, loopMaterials)}`
                        : preparation === 'unchanged'
                          ? '沿用系统准备'
                          : preparation === 'changed'
                            ? '系统准备已更新'
                            : loopPartLabel(row, loopMaterials)
                      : row.loop
                        ? `Agent loop ${row.loop}`
                        : row.category === 'model' && row.kind === 'model'
                          ? `思考 · ${loopModelLabel(row, loopMaterials)}`
                          : isRun && runKey
                            ? (runLabels.get(runKey) ?? row.label)
                            : row.kind === 'message' || row.operation?.type === 'child'
                              ? (display?.summary ?? display?.title ?? row.label)
                              : [display?.title ?? row.label, display?.modelName]
                                  .filter(Boolean)
                                  .join(' · ');
                return (
                  <Fragment key={row.id}>
                    {gap > 0 && (
                      // biome-ignore lint/a11y/noAriaHiddenOnFocusable: Empty virtual spacers have no focusable descendants.
                      <tr aria-hidden="true">
                        <td role="presentation" style={{ height: gap * 38 }} />
                      </tr>
                    )}
                    <tr
                      tabIndex={-1}
                      aria-level={row.depth + 1}
                      aria-rowindex={index + 1}
                      aria-selected={!selectedRequest && row.id === selectedRow?.id}
                      aria-expanded={hasChildren ? !actualCollapsed : undefined}
                      className={cn(
                        'trajectory-tree-node',
                        row.structural && 'trajectory-structural',
                        isRun && 'trajectory-run-band',
                        row.kind === 'session' && 'trajectory-session-row',
                      )}
                      key={row.id}
                    >
                      <td
                        tabIndex={-1}
                        className={cn(
                          'trajectory-node',
                          !selectedRequest &&
                            row.id === selectedRow?.id &&
                            'trajectory-node-selected',
                        )}
                        data-trajectory-node={node.id}
                        data-trajectory-row={row.id}
                        data-trajectory-parent={row.parentId ?? undefined}
                        data-depth={row.depth}
                        style={{
                          paddingInlineStart:
                            10 + (isRun ? Math.min(Math.max(row.depth - 1, 0), 7) * 13 : 0),
                        }}
                      >
                        {row.depth > 0 || markerOwner ? (
                          <span
                            className={cn(
                              'trajectory-row-branch',
                              requestMarker && 'trajectory-request-rail',
                            )}
                            aria-hidden={!markerOwner || undefined}
                            data-request-boundary={requestMarker?.marker || undefined}
                            data-connect-before={requestMarker?.continuation || undefined}
                            data-connect-after={requestMarker?.continuesAfter || undefined}
                            data-omitted-before={requestMarker?.omittedBefore || undefined}
                            style={{
                              marginInlineStart: Math.min(Math.max(row.depth - 1, 0), 7) * 13,
                            }}
                          >
                            {markerOwner && (
                              <Button
                                variant="ghost"
                                className="trajectory-request-marker"
                                aria-label={markerLabel}
                                aria-pressed={selectedRequest?.id === markerOwner.id}
                                title={[
                                  markerLabel,
                                  loopModelLabel(markerOwner, loopMaterials),
                                  requestMarker?.omittedBefore ? '此处的请求记录顺序不连续' : null,
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                                data-request-owner={markerOwner.id}
                                onClick={() => choose(markerOwner.id, undefined, true)}
                                onKeyDown={(event) => {
                                  if (event.key === 'Escape' && detailOpen) {
                                    event.preventDefault();
                                    close();
                                  }
                                }}
                              >
                                <span aria-hidden="true" />
                              </Button>
                            )}
                          </span>
                        ) : (
                          <span className="trajectory-root-mark" aria-hidden="true" />
                        )}
                        {hasChildren ? (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            className="trajectory-node-collapse"
                            aria-label={`${actualCollapsed ? '展开' : '折叠'}${row.loop ? `Agent loop ${row.loop}` : node.label}`}
                            aria-expanded={!actualCollapsed}
                            tabIndex={-1}
                            onClick={() => toggle(row.id)}
                          >
                            <HugeiconsIcon
                              icon={actualCollapsed ? ArrowRight01Icon : ArrowDown01Icon}
                              aria-hidden="true"
                            />
                          </Button>
                        ) : (
                          <span className="trajectory-chevron-space" />
                        )}
                        <Button
                          variant="ghost"
                          className="trajectory-node-select"
                          data-node-id={row.id}
                          aria-pressed={!selectedRequest && row.id === selectedRow?.id}
                          tabIndex={focus === row.id ? 0 : -1}
                          title={[rowLabel, metadata].filter(Boolean).join(' · ')}
                          onClick={() => choose(row.id)}
                          onFocus={() => setFocusId(row.id)}
                          onKeyDown={(event) => {
                            let target: string | undefined;
                            if (event.key === 'ArrowDown') target = rows[index + 1]?.id;
                            else if (event.key === 'ArrowUp') target = rows[index - 1]?.id;
                            else if (event.key === 'Home') target = rows[0]?.id;
                            else if (event.key === 'End') target = rows.at(-1)?.id;
                            else if (event.key === 'ArrowRight') {
                              if (hasChildren && actualCollapsed) toggle(row.id);
                              else target = rows.find((item) => item.parentId === row.id)?.id;
                            } else if (event.key === 'ArrowLeft') {
                              if (hasChildren && !actualCollapsed) toggle(row.id);
                              else target = row.parentId ?? undefined;
                            } else if (event.key === 'Escape' && detailOpen) close();
                            else return;
                            event.preventDefault();
                            focusRow(target);
                          }}
                        >
                          {!isRun && row.kind !== 'session' && (
                            <span className="trajectory-type-badge" data-tone={badge.tone}>
                              {badge.label}
                            </span>
                          )}
                          <span className="trajectory-row-text">
                            <span
                              className={
                                row.kind === 'tool' || row.kind === 'job'
                                  ? 'trajectory-node-label trajectory-code'
                                  : 'trajectory-node-label'
                              }
                            >
                              {rowLabel}
                            </span>
                            {metadata && !isRun && (
                              <span className="trajectory-row-secondary">{metadata}</span>
                            )}
                          </span>
                          <span className="sr-only">#{row.firstSequence}</span>
                          {isRun ? null : row.kind === 'session' ? (
                            <span className="trajectory-run-count">会话记录</span>
                          ) : (
                            <>
                              <span
                                className="trajectory-node-duration"
                                title={
                                  thinking || row.requestIndex
                                    ? '模型请求耗时，包含重连；工具执行另列'
                                    : timingRow.interval.durationMs === undefined
                                      ? '没有可比较的完整执行边界'
                                      : '已记录区间，包含已保存的等待阶段'
                                }
                              >
                                {row.virtualPart && !thinking
                                  ? ''
                                  : row.structural
                                    ? '上下文'
                                    : `${thinking || row.requestIndex ? '请求 ' : ''}${rowDuration(timingRow)}`}
                              </span>
                              {displayPhase &&
                                !(
                                  row.kind === 'message' &&
                                  displayPhase === 'observed' &&
                                  row.step?.messageStatus !== 'incomplete'
                                ) &&
                                !row.structural &&
                                (!row.virtualPart || thinking) && (
                                  <span
                                    className={cn(
                                      'trajectory-node-status',
                                      ['failed', 'outcome_unknown'].includes(displayPhase) &&
                                        'trajectory-negative',
                                    )}
                                    role="img"
                                    aria-label={trajectoryPhaseLabels[displayPhase]}
                                    title={trajectoryPhaseLabels[displayPhase]}
                                  >
                                    <HugeiconsIcon
                                      icon={statusIcon({
                                        ...row,
                                        phase: displayPhase,
                                      })}
                                      aria-hidden="true"
                                    />
                                  </span>
                                )}
                            </>
                          )}
                        </Button>
                        {row.category === 'model' && !row.structural && !row.virtualPart && (
                          <Button
                            variant="ghost"
                            size="xs"
                            className="trajectory-input-preparation"
                            aria-label={`查看${rowLabel}的输入准备`}
                            onClick={() => choose(row.id, 'preview')}
                          >
                            输入准备
                          </Button>
                        )}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
              {(mountedIndices.at(-1) ?? -1) + 1 < rows.length && (
                // biome-ignore lint/a11y/noAriaHiddenOnFocusable: Empty virtual spacers have no tabindex or focusable children.
                <tr aria-hidden="true">
                  <td
                    role="presentation"
                    style={{ height: (rows.length - (mountedIndices.at(-1) ?? -1) - 1) * 38 }}
                  />
                </tr>
              )}
              {!rows.length && (
                <tr>
                  <td>
                    <p className="trajectory-empty" role="status">
                      没有匹配记录。调整筛选或清除条件后查看。
                    </p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </ScrollArea>
    </nav>
  );
  const detail = waiting ? (
    <p role="status" className="trajectory-tree-loading">
      正在读取所选记录…
    </p>
  ) : selectedRequest ? (
    <TrajectoryRequestDetails
      row={selectedRequest}
      runLabel={runLabels.get(selectedRequest.runKey ?? childRunKeys.get(selectedRequest.id) ?? '')}
      tab={requestTab}
      targets={targets}
      materials={detailMaterials.length ? detailMaterials : props.evidence ? [props.evidence] : []}
      observationId={state.selectedObservationId}
      active={visible && !waiting && detailOpen}
      scrollTop={state.detailScrollTop ?? 0}
      onScroll={(top) => {
        if (visible && !waiting && detailOpen)
          onStateChange({ ...callbacks.current.state, detailScrollTop: top });
      }}
      onTabChange={(requestTab) => onStateChange({ ...state, requestTab, detailScrollTop: 0 })}
      onObservationChange={(selectedObservationId) =>
        onStateChange({ ...state, selectedObservationId, detailScrollTop: 0 })
      }
      onRetry={() => props.onMaterialsRetry?.()}
      onClose={close}
      rowsById={workbench.byId}
      onResult={chooseRequestResult}
      excluded={!workbench.matchingIds.has(selectedRequest.id)}
      collapsed={selectedRequest.hiddenByCollapse}
    />
  ) : selected && selectedRow ? (
    <TrajectoryDetails
      node={selected}
      runLabel={runLabels.get(selectedRow.runKey ?? childRunKeys.get(selectedRow.id) ?? '')}
      active={visible && !waiting && detailOpen}
      row={selectedRow}
      events={selectedRow.events}
      tab={tab}
      targets={targets}
      onRetry={() => {
        props.onMaterialsRetry?.();
        if (selectedRow.kind === 'model' || selectedRow.virtualPart) props.onLoopMaterialsRetry?.();
      }}
      materials={detailMaterials.length ? detailMaterials : props.evidence ? [props.evidence] : []}
      excluded={
        selectedRow.category !== 'structure' &&
        !workbench.matchingIds.has(selectedRow.virtualPart?.ownerId ?? selectedRow.id)
      }
      collapsed={selectedRow.hiddenByCollapse}
      scrollTop={state.detailScrollTop ?? 0}
      onScroll={(top) => {
        if (visible && !waiting && detailOpen)
          onStateChange({ ...callbacks.current.state, detailScrollTop: top });
      }}
      observationId={state.selectedObservationId}
      relatedRows={selectedRow.relatedNodeIds.flatMap((nodeId) => {
        const related = workbench.byId.get(nodeId);
        return related ? [related] : [];
      })}
      rowsById={workbench.byId}
      onRelated={(id) => choose(id)}
      onTabChange={(workbenchTab: TrajectoryDetailTab) =>
        onStateChange({ ...state, workbenchTab, detailScrollTop: 0 })
      }
      onObservationChange={(selectedObservationId) =>
        onStateChange({ ...state, selectedObservationId, detailScrollTop: 0 })
      }
      onClose={close}
      onParent={() => {
        if (selected.parentId) choose(selected.parentId);
      }}
    />
  ) : (
    <p role="status">所选记录不在当前来源范围中。</p>
  );
  const container = panel.current?.closest<HTMLElement>('.kite-client') ?? undefined;
  const menu = (
    label: string,
    children: React.ReactNode,
    icon: typeof Clock01Icon,
    ariaLabel: string,
    active = false,
  ) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          className="trajectory-filter-button"
          aria-label={ariaLabel}
          data-active={active || undefined}
        >
          <HugeiconsIcon icon={icon} aria-hidden="true" />
          <span>{label}</span>
          <HugeiconsIcon
            icon={ArrowDown01Icon}
            aria-hidden="true"
            className="trajectory-filter-chevron"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        container={container}
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <DropdownMenuGroup>{children}</DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <section className="trajectory-panel" aria-label="执行轨迹" hidden={!visible} ref={panel}>
      <header className="trajectory-toolbar">
        <div className="trajectory-heading">
          <h2>执行轨迹</h2>
          <Badge>{props.offline ? '离线重放' : props.mode === 'live' ? '实时' : '历史'}</Badge>
        </div>
        <div className="trajectory-toolbar-actions">
          {props.newEventsAvailable && (
            <>
              <span className="sr-only" role="status">
                有新的执行记录，当前阅读位置保持不变。
              </span>
              <Button
                variant="ghost"
                size="xs"
                className="trajectory-new-records"
                title="有新的执行记录，当前阅读位置保持不变。点击返回最新。"
                onClick={returnToLatest}
              >
                返回最新
              </Button>
            </>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="更多轨迹操作">
                <HugeiconsIcon icon={MoreHorizontalIcon} aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              container={container}
              align="end"
              onEscapeKeyDown={(event) => event.stopPropagation()}
            >
              <DropdownMenuGroup>
                <DropdownMenuItem disabled={!descriptor || props.loading} onSelect={returnToLatest}>
                  {props.offline ? '返回包内最新' : '返回最新'}
                </DropdownMenuItem>
                {props.onExport && (
                  <>
                    <DropdownMenuItem onSelect={() => props.onExport?.(false)}>
                      导出事件
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => props.onExport?.(true)}>
                      导出含证据
                    </DropdownMenuItem>
                  </>
                )}
                {props.onOpenOffline && (
                  <DropdownMenuItem onSelect={props.onOpenOffline}>打开离线轨迹</DropdownMenuItem>
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem
                  checked={state.listMode === 'all_events'}
                  onCheckedChange={(all) =>
                    onStateChange({ ...state, listMode: all ? 'all_events' : 'key_steps' })
                  }
                >
                  显示全部事件
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem checked={showReplay} onCheckedChange={setShowReplay}>
                  显示回放控制
                </DropdownMenuCheckboxItem>
                <DropdownMenuCheckboxItem
                  checked={showInformation}
                  onCheckedChange={setShowInformation}
                >
                  轨迹信息
                </DropdownMenuCheckboxItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <section className="trajectory-filters" aria-label="轨迹筛选">
        <fieldset className="trajectory-filter-controls" aria-label="轨迹展示开关">
          <Button
            variant="ghost"
            size="xs"
            className="trajectory-filter-button"
            aria-label="时长"
            aria-pressed={state.timelineMode !== 'order'}
            data-active={state.timelineMode !== 'order' || undefined}
            title="按耗时比例绘制；关闭后按事件顺序排列"
            onClick={() =>
              onStateChange({
                ...state,
                timelineMode: state.timelineMode === 'order' ? 'time' : 'order',
              })
            }
          >
            <HugeiconsIcon icon={Clock01Icon} aria-hidden="true" />
            <span>时长</span>
          </Button>
          {menu(
            '筛选',
            <>
              {Object.entries(typeLabels).map(([value, label]) => (
                <DropdownMenuCheckboxItem
                  key={value}
                  checked={filters.types.includes(value as WorkbenchFilters['types'][number])}
                  onCheckedChange={(checked) =>
                    changeFilters({
                      types: checked
                        ? [...filters.types, value as WorkbenchFilters['types'][number]]
                        : filters.types.filter((type) => type !== value),
                    })
                  }
                >
                  {label}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuCheckboxItem
                checked={filters.childAgents !== false}
                onCheckedChange={(checked) => changeFilters({ childAgents: checked })}
              >
                子 Agent
              </DropdownMenuCheckboxItem>
            </>,
            Search01Icon,
            '筛选轨迹',
            activeFilters,
          )}
        </fieldset>
        <div className="trajectory-search">
          <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
          <Input
            aria-label="搜索元数据"
            placeholder="搜索元数据"
            value={filters.metadataQuery}
            onChange={(event) => changeFilters({ metadataQuery: event.currentTarget.value })}
          />
        </div>
        {activeFilters && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onStateChange({ ...state, filters: defaultWorkbenchFilters() })}
          >
            清除筛选
          </Button>
        )}
      </section>
      {activeFilters && (
        <section className="trajectory-filter-summary" aria-label="当前筛选">
          {(filters.types.length !== 5 || filters.childAgents === false) && (
            <Button
              size="xs"
              variant="ghost"
              aria-label="移除调用类型筛选"
              onClick={() =>
                changeFilters({ types: defaultWorkbenchFilters().types, childAgents: true })
              }
            >
              {[
                ...filters.types.map((type) => typeLabels[type]),
                ...(filters.childAgents !== false ? ['子 Agent'] : []),
              ].join('、') || '未选择调用'}{' '}
              ×
            </Button>
          )}
          {filters.metadataQuery !== '' && (
            <Button
              size="xs"
              variant="ghost"
              aria-label="移除搜索筛选"
              title={filters.metadataQuery}
              onClick={() => changeFilters({ metadataQuery: '' })}
            >
              搜索：{filters.metadataQuery} ×
            </Button>
          )}
          {(state.collapsedNodeIds?.length ?? 0) > 0 && (
            <span>筛选临时展开命中路径，原折叠状态已保留。</span>
          )}
        </section>
      )}
      {props.errorCode && (
        <Alert variant="destructive">
          <AlertTitle>轨迹读取未完成</AlertTitle>
          <AlertDescription>
            {props.errorCode}
            {props.onRetry && (
              <Button size="xs" variant="ghost" onClick={props.onRetry}>
                重试读取
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {props.integrity.identityConfidence === 'legacy_local' && (
        <div className="trajectory-integrity" role="status">
          <span>旧格式记录只保留有限元数据，父子关系和入出参可能缺失。</span>
        </div>
      )}
      {showInformation && (
        <div className="trajectory-integrity">
          <span>
            快照上界 #{descriptor?.upperCursor ?? '—'} · 当前来源位置 #{state.cursor}
            {!props.exhausted && ' · 记录尚未读取完'}
          </span>
          {props.integrity.facts !== 'complete' && <span>事实覆盖尚未完整核实。</span>}
        </div>
      )}
      <TrajectoryTimeline
        workbench={workbench}
        labelFor={(row) =>
          row.kind === 'model' && row.category === 'approval'
            ? row.label
            : row.category === 'model' && row.kind === 'model'
              ? `思考 · ${loopModelLabel(row, loopMaterials)}`
              : (row.step?.display?.title ?? row.label)
        }
        mode={state.timelineMode ?? 'time'}
        selectedId={selectedRow?.virtualPart?.ownerId ?? selectedRow?.id}
        onModeChange={() =>
          onStateChange({
            ...state,
            timelineMode: state.timelineMode === 'order' ? 'time' : 'order',
          })
        }
        onChoose={(nodeId) => {
          choose(nodeId);
          focusRow(nodeId);
        }}
      />
      <div
        className="trajectory-workspace"
        ref={workspace}
        data-detail-layout={narrow ? 'drawer' : 'docked'}
      >
        {detailOpen && !narrow ? (
          <ResizablePanelGroup
            orientation="horizontal"
            onLayoutChanged={(layout, meta) => {
              const size = layout[`${id}-trajectory-detail`];
              if (meta.isUserInteraction && typeof size === 'number')
                onStateChange({ ...callbacks.current.state, detailWidth: size });
            }}
          >
            <InitialPanel
              id={`${id}-trajectory-log`}
              defaultSize={`${100 - (state.detailWidth ?? 40)}%`}
              minSize="300px"
            >
              {list}
            </InitialPanel>
            <ResizableHandle aria-label="调整轨迹详情宽度" withHandle />
            <InitialPanel
              id={`${id}-trajectory-detail`}
              defaultSize={`${state.detailWidth ?? 40}%`}
              minSize="300px"
            >
              {detail}
            </InitialPanel>
          </ResizablePanelGroup>
        ) : (
          list
        )}
        {narrow && (
          <Sheet
            open={detailOpen}
            onOpenChange={(open) => {
              if (!open) close();
            }}
          >
            <SheetContent
              portalled={false}
              showCloseButton={false}
              aria-describedby={undefined}
              className="trajectory-detail-drawer"
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                panel.current
                  ?.querySelector<HTMLButtonElement>(
                    '.trajectory-detail [role="tab"][data-state="active"]',
                  )
                  ?.focus({ preventScroll: true });
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                if (callbacks.current.state.detailOpen) {
                  requestAnimationFrame(() =>
                    panel.current
                      ?.querySelector<HTMLButtonElement>(
                        '.trajectory-detail [role="tab"][data-state="active"]',
                      )
                      ?.focus({ preventScroll: true }),
                  );
                } else restoreDetailFocus();
              }}
            >
              <SheetTitle className="sr-only">
                {selectedRequest ? '模型请求详情' : '轨迹节点详情'}
              </SheetTitle>
              {detail}
            </SheetContent>
          </Sheet>
        )}
      </div>
      {showReplay && (
        <footer className="trajectory-replay-controls">
          <div className="trajectory-actions">
            <Button variant="ghost" size="xs" onClick={() => props.onStep(-1)}>
              上一条记录
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={props.playing ? props.onPause : props.onPlay}
              aria-label={props.playing ? '暂停轨迹' : '播放轨迹'}
            >
              {props.playing ? '暂停' : '播放'}
            </Button>
            <Button variant="ghost" size="xs" onClick={() => props.onStep(1)}>
              下一条记录
            </Button>
          </div>
          <div className="trajectory-position">
            <label htmlFor={`${id}-position`}>位置</label>
            <Input
              id={`${id}-position`}
              aria-label="轨迹位置"
              value={position}
              aria-invalid={invalid}
              onChange={(event) => setPosition(event.currentTarget.value)}
            />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                if (!descriptor || !bounded(position, descriptor.upperCursor)) {
                  setInvalid(true);
                  return;
                }
                props.onPause();
                navigationPending.current = true;
                props.onSeek(position);
                setPosition(state.cursor);
              }}
            >
              跳转
            </Button>
            <span>/ {descriptor?.upperCursor ?? '—'}</span>
          </div>
          {invalid && <p role="alert">请输入当前快照范围内的完整位置。</p>}
        </footer>
      )}
    </section>
  );
}
