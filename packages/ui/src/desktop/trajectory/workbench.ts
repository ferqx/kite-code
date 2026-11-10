import {
  parseDecimal64,
  type TrajectoryEvent,
  type TrajectoryProjection,
  type TrajectoryStep,
} from '@kite-ai/trajectory';
import { buildLoopPresentation, type WorkbenchVirtualPart } from './loops';
import { groupWorkbenchOperations } from './operations';
import { attachWorkbenchSummaries } from './stats';
import { filterTrajectoryTree, type TrajectoryTreeNode } from './tree';

export type WorkbenchCategory = 'message' | 'model' | 'tool' | 'compression' | 'approval';
export interface WorkbenchFilters {
  duration: 'all' | 'observed_ge_1s' | 'observed_ge_5s' | 'unknown';
  runKeys: readonly string[] | null;
  types: readonly WorkbenchCategory[];
  /** Independent child Agent visibility; absent in older saved views means enabled. */
  childAgents?: boolean;
  subcalls: 'all' | 'root' | 'child';
  metadataQuery: string;
  includeAdministrative: boolean;
}
export function defaultWorkbenchFilters(): WorkbenchFilters {
  return {
    duration: 'all',
    runKeys: null,
    types: ['message', 'model', 'tool', 'compression', 'approval'],
    childAgents: true,
    subcalls: 'all',
    metadataQuery: '',
    includeAdministrative: false,
  };
}
export interface WorkbenchObservedInterval {
  basis: 'planned_to_terminal' | 'observed_progress' | 'unknown';
  startEventId?: string;
  endEventId?: string;
  startAt?: number;
  endAt?: number;
  durationMs?: number;
  originStoreId?: string;
  ongoing: boolean;
  unknownReason?:
    | 'missing_time'
    | 'missing_boundary'
    | 'cross_store'
    | 'clock_reversed'
    | 'incomplete_history'
    | 'not_a_call';
}
export interface WorkbenchRow {
  id: string;
  /** The unchanged original tree owner, including for an administrative observation row. */
  nodeId: string;
  parentId: string | null;
  /** Original logical parent before the flat Agent loop presentation. */
  originalParentId?: string | null;
  /** Material owners remain addressable even when their wrapper is omitted from the log. */
  presentationHidden?: boolean;
  /** A proved tool-only output is retained by identity, but is not a visible reply/message. */
  outputSuppressed?: boolean;
  outputHistory?: boolean;
  presentationRepresentativeId?: string;
  compact?: boolean;
  summary?: WorkbenchSummary;
  depth: number;
  kind: TrajectoryTreeNode['kind'];
  label: string;
  category: WorkbenchCategory | 'administrative' | 'structure';
  step?: TrajectoryStep;
  event?: TrajectoryEvent;
  events: readonly TrajectoryEvent[];
  firstSequence: string;
  lastSequence: string;
  phase?: TrajectoryTreeNode['phase'];
  runKey?: string;
  interval: WorkbenchObservedInterval;
  subcall: 'root' | 'child' | 'unknown' | 'not_a_call';
  structural: boolean;
  matched: boolean;
  hiddenByCollapse: boolean;
  relationNotice?: string;
  positionAt?: number;
  clockDomain?: string;
  relatedNodeIds: string[];
  operation?: WorkbenchOperation;
  collapse?: WorkbenchCollapse;
  collapsedById?: string;
  loop?: number;
  loopPhase?: TrajectoryTreeNode['phase'];
  requestIndex?: number;
  requestPhase?: TrajectoryTreeNode['phase'];
  virtualPart?: WorkbenchVirtualPart;
}
export type WorkbenchOperationMember = Pick<
  WorkbenchRow,
  | 'id'
  | 'nodeId'
  | 'parentId'
  | 'kind'
  | 'label'
  | 'category'
  | 'step'
  | 'phase'
  | 'events'
  | 'firstSequence'
  | 'lastSequence'
  | 'interval'
  | 'runKey'
>;
export interface WorkbenchOperation {
  type: 'model' | 'shell' | 'child' | 'compression' | 'tool';
  primaryNodeId: string;
  memberNodeIds: readonly string[];
  members: readonly WorkbenchOperationMember[];
  attempts: readonly WorkbenchOperationMember[];
  observations: readonly WorkbenchOperationMember[];
  reconnectCount?: number;
  attemptsComplete?: boolean;
}
/** Matched logical work in one exact Run. Messages are never included in actions. */
export interface WorkbenchSummary {
  model: number;
  tool: number;
  child: number;
  approval: number;
  compression: number;
  actions: number;
  userMessages: number;
  assistantMessages: number;
}
export interface WorkbenchCollapse {
  level: 'round' | 'call' | 'subcall';
  collapsed: boolean;
  hiddenCount: number;
  counts: {
    model: number;
    tool: number;
    child: number;
    approval: number;
    compression: number;
    message: number;
  };
}
export interface WorkbenchExpansion {
  rounds: boolean;
  calls: boolean;
  subcalls: boolean;
  expandedNodeIds?: readonly string[];
}
export interface WorkbenchRunOption {
  key: string;
  label: string;
  originStoreId?: string;
  sessionId: string;
  runId: string;
}
export interface WorkbenchTimelineDomain {
  originStoreId: string | null;
  startAt: number | null;
  endAt: number | null;
  rows: readonly WorkbenchRow[];
  unknown: boolean;
}
export interface TrajectoryWorkbench {
  rows: WorkbenchRow[];
  visibleRows: WorkbenchRow[];
  byId: ReadonlyMap<string, WorkbenchRow>;
  matchingIds: ReadonlySet<string>;
  structuralIds: ReadonlySet<string>;
  eventOwners: ReadonlyMap<string, string>;
  eventsById: ReadonlyMap<string, TrajectoryEvent>;
  runOptions: WorkbenchRunOption[];
  timelineDomains: WorkbenchTimelineDomain[];
  counts: { matched: number; total: number; structural: number; visible: number };
}
export interface TrajectoryWorkbenchIndex {
  rows: readonly WorkbenchRow[];
  eventOwners: ReadonlyMap<string, string>;
  eventsById: ReadonlyMap<string, TrajectoryEvent>;
  runOptions: WorkbenchRunOption[];
  defaultVisibleIds: ReadonlySet<string>;
  searchTextById: ReadonlyMap<string, string>;
  aliases: ReadonlyMap<string, string>;
}
export const workbenchRunKey = (step: TrajectoryStep): string | undefined =>
  step.runId === undefined
    ? undefined
    : JSON.stringify([
        step.runOriginStoreId ?? step.originStoreId ?? null,
        step.sessionId,
        step.runId,
      ]);

function category(node: TrajectoryTreeNode): WorkbenchRow['category'] {
  const step = node.step;
  if (node.kind === 'message') return 'message';
  if (node.approvalCheck) return 'approval';
  if (node.kind === 'model')
    return step?.compressionTrigger === 'automatic' ? 'compression' : 'model';
  if (['tool', 'job', 'child'].includes(node.kind)) return 'tool';
  if (
    node.kind === 'context' &&
    step?.sourceEventType === 'context.compressed' &&
    step.compressionTrigger === 'automatic'
  )
    return 'compression';
  if (
    node.kind === 'interaction' &&
    (step?.interactionKind === 'approval' || step?.interactionKind === 'plan_review')
  )
    return 'approval';
  return node.kind === 'session' || node.kind === 'run' ? 'structure' : 'administrative';
}
const call = (node: TrajectoryTreeNode) =>
  ['model', 'tool', 'job'].includes(node.kind) && node.step?.executionId !== undefined;
const terminal = (event: TrajectoryEvent) =>
  ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(event.phase);
const time = (event: TrajectoryEvent) =>
  typeof event.occurredAt === 'number' &&
  Number.isFinite(event.occurredAt) &&
  event.occurredAt >= 0;

function interval(
  node: TrajectoryTreeNode,
  events: readonly TrajectoryEvent[],
): WorkbenchObservedInterval {
  const unknown = (unknownReason: WorkbenchObservedInterval['unknownReason']) => ({
    basis: 'unknown' as const,
    ongoing: false,
    unknownReason,
  });
  if (!call(node)) return unknown('not_a_call');
  if (!events.length || events.some((event) => event.identityConfidence !== 'verified_origin'))
    return unknown('incomplete_history');
  if (new Set(events.map((event) => event.origin.storeId)).size !== 1)
    return unknown('cross_store');
  const start = events.find((event) => event.phase === 'planned');
  const end = events.at(-1)!;
  if (!start || start !== events[0] || start === end || (!terminal(end) && end.phase === 'planned'))
    return unknown('missing_boundary');
  if (!time(start) || !time(end)) return unknown('missing_time');
  let previous = -Infinity;
  for (const event of events) {
    if (!time(event)) continue;
    if (event.occurredAt! < previous) return unknown('clock_reversed');
    previous = event.occurredAt!;
  }
  return {
    basis: terminal(end) ? 'planned_to_terminal' : 'observed_progress',
    startEventId: start.eventId,
    endEventId: end.eventId,
    startAt: start.occurredAt!,
    endAt: end.occurredAt!,
    durationMs: end.occurredAt! - start.occurredAt!,
    originStoreId: start.origin.storeId,
    ongoing: !terminal(end),
  };
}

/** Full-prefix metadata only: filtering never fetches bodies or changes the original tree. */
export function buildTrajectoryWorkbenchIndex(
  projection: TrajectoryProjection | null,
  tree: { root: TrajectoryTreeNode; byId: ReadonlyMap<string, TrajectoryTreeNode> },
  options: { loopParts?: boolean } = {},
): TrajectoryWorkbenchIndex {
  const eventsById = new Map<string, TrajectoryEvent>();
  for (const event of projection?.eventIndex ?? [])
    if (parseDecimal64(event.sequence) <= parseDecimal64(projection!.atCursor))
      eventsById.set(event.eventId, event);
  const clockReset = new Map<string, bigint>(),
    lastClock = new Map<string, number>();
  for (const event of eventsById.values()) {
    if (event.identityConfidence !== 'verified_origin' || !time(event)) continue;
    const store = event.origin.storeId;
    if (event.occurredAt! < (lastClock.get(store) ?? -Infinity) && !clockReset.has(store))
      clockReset.set(store, parseDecimal64(event.sequence));
    lastClock.set(store, event.occurredAt!);
  }
  const eventOwners = new Map<string, string>();
  const nodeEvents = new Map<string, TrajectoryEvent[]>();
  for (const node of tree.byId.values()) {
    for (const id of node.sourceEventIds) eventOwners.set(id, node.id);
    nodeEvents.set(node.id, []);
  }
  for (const event of eventsById.values()) {
    const owner = eventOwners.get(event.eventId);
    if (owner) nodeEvents.get(owner)!.push(event);
  }
  const depths = new Map<string, number>([[tree.root.id, 0]]);
  const childScope = new Map<string, boolean>([[tree.root.id, false]]);
  const traversal: TrajectoryTreeNode[] = [tree.root];
  for (let index = 0; index < traversal.length; index++) {
    const parent = traversal[index]!;
    for (const node of parent.children) {
      depths.set(node.id, depths.get(parent.id)! + 1);
      childScope.set(
        node.id,
        childScope.get(parent.id)! ||
          (node.kind === 'run' && ['child', 'job'].includes(parent.kind)),
      );
      traversal.push(node);
    }
  }
  const owningRuns = new Map<string, string>();
  const runKeysByNode = new Map<string, Set<string>>();
  for (const node of traversal) {
    const owner =
      node.kind === 'run' ? node.id : node.parentId ? owningRuns.get(node.parentId) : undefined;
    if (!owner) continue;
    owningRuns.set(node.id, owner);
    const key = node.step && workbenchRunKey(node.step);
    if (!key) continue;
    const keys = runKeysByNode.get(owner) ?? new Set<string>();
    keys.add(key);
    runKeysByNode.set(owner, keys);
  }
  const rows: WorkbenchRow[] = [];
  const byId = new Map<string, WorkbenchRow>();
  const business = new Set<string>();
  const make = (
    node: TrajectoryTreeNode,
    id: string,
    rowCategory: WorkbenchRow['category'],
    events: readonly TrajectoryEvent[],
    event?: TrajectoryEvent,
  ): WorkbenchRow => {
    const step = node.step;
    const eligibleCall = call(node) && !event;
    const verified = step?.identityConfidence === 'verified_origin';
    const subcall = !eligibleCall
      ? 'not_a_call'
      : !verified
        ? 'unknown'
        : step.parentExecutionId || childScope.get(node.id)
          ? 'child'
          : projection?.completePrefix === true &&
              !node.relationNotice &&
              step.executionOriginStoreId &&
              (!step.runId || step.runOriginStoreId)
            ? 'root'
            : 'unknown';
    let ownInterval = event
      ? { basis: 'unknown' as const, ongoing: false, unknownReason: 'not_a_call' as const }
      : interval(node, events);
    const sameClock =
      events.length && new Set(events.map((fact) => fact.origin.storeId)).size === 1;
    const reset = events[0] && clockReset.get(events[0].origin.storeId);
    const reliableClock =
      reset === undefined || !events.length || parseDecimal64(events.at(-1)!.sequence) < reset;
    const clock = sameClock && reliableClock;
    if (!reliableClock && ownInterval.basis !== 'unknown')
      ownInterval = { basis: 'unknown', ongoing: false, unknownReason: 'clock_reversed' };
    let monotonic = true,
      previous = -Infinity;
    for (const fact of events) {
      if (!time(fact)) continue;
      if (fact.occurredAt! < previous) monotonic = false;
      previous = fact.occurredAt!;
    }
    const first = events[0];
    const row: WorkbenchRow = {
      id,
      nodeId: node.id,
      parentId:
        event && category(node) === 'administrative' && !node.children.length
          ? node.parentId
          : event
            ? node.id
            : node.parentId,
      depth: depths.get(node.id) ?? 0,
      kind: node.kind,
      label: node.approvalCheck
        ? '自动审批检查'
        : event && node.kind !== 'unknown'
          ? event.sourceEventType
          : node.label,
      category: rowCategory,
      ...(step ? { step } : {}),
      ...(event ? { event } : {}),
      events,
      firstSequence: event?.sequence ?? node.firstSequence,
      lastSequence: event?.sequence ?? node.lastSequence,
      ...(event ? { phase: event.phase } : node.phase ? { phase: node.phase } : {}),
      ...(step && workbenchRunKey(step)
        ? { runKey: workbenchRunKey(step) }
        : node.kind === 'run' && !event && runKeysByNode.get(node.id)?.size === 1
          ? { runKey: [...runKeysByNode.get(node.id)!][0] }
          : {}),
      interval: ownInterval,
      subcall,
      structural: rowCategory === 'structure',
      matched: false,
      hiddenByCollapse: false,
      ...(node.relationNotice ? { relationNotice: node.relationNotice } : {}),
      ...(clock &&
      monotonic &&
      first &&
      time(first) &&
      first.identityConfidence === 'verified_origin'
        ? { positionAt: first.occurredAt!, clockDomain: first.origin.storeId }
        : {}),
      relatedNodeIds: [],
    };
    byId.set(id, row);
    rows.push(row);
    return row;
  };
  for (const node of tree.byId.values()) {
    const type = category(node),
      events = nodeEvents.get(node.id)!;
    if (!['administrative', 'structure'].includes(type)) {
      business.add(node.id);
      make(node, node.id, type, events);
    } else {
      if (type === 'structure' || node.children.length) make(node, node.id, 'structure', events);
      if (events.length)
        for (const event of events)
          make(node, `event:${event.eventId}`, 'administrative', [event], event);
      else if (node.sourceEventIds.length && !byId.has(node.id))
        make(node, node.id, 'administrative', events);
    }
  }
  // Derive display depth from the unchanged relation, including administrative leaf rows.
  for (const row of rows) {
    if (row.event && row.parentId === row.nodeId) row.depth++;
    if (row.parentId && !byId.has(row.parentId)) row.parentId = tree.root.id;
  }
  const runNodes = new Map<string, { option: WorkbenchRunOption; sequence: bigint }>();
  for (const node of tree.byId.values()) {
    const step = node.step,
      key = step && workbenchRunKey(step);
    if (!step?.runId || !key) continue;
    const sequence = parseDecimal64(node.firstSequence),
      old = runNodes.get(key);
    if (!old || sequence < old.sequence)
      runNodes.set(key, {
        option: {
          key,
          label: '',
          originStoreId: step.runOriginStoreId ?? step.originStoreId,
          sessionId: step.sessionId,
          runId: step.runId,
        },
        sequence,
      });
  }
  const runOrdinals = new Map<string, number>();
  const runNumbers = new Map<string, number>();
  const runOptions = [...runNodes.values()]
    .sort((a, b) =>
      a.sequence < b.sequence
        ? -1
        : a.sequence > b.sequence
          ? 1
          : a.option.key.localeCompare(b.option.key),
    )
    .map(({ option }) => {
      const scope = JSON.stringify([option.originStoreId ?? null, option.sessionId]);
      const ordinal = (runOrdinals.get(scope) ?? 0) + 1;
      runOrdinals.set(scope, ordinal);
      runNumbers.set(option.key, ordinal);
      return { ...option, label: `Agent loop ${ordinal}` };
    });
  const runLabels = new Map(runOptions.map((option) => [option.key, option.label]));
  const compressionGroups = new Map<string, WorkbenchRow[]>();
  for (const row of rows) {
    if (!business.has(row.id) || !row.step?.compressionId) continue;
    const key = JSON.stringify([
      row.step.executionOriginStoreId ?? row.step.originStoreId,
      row.step.sessionId,
      row.step.compressionId,
      row.step.executionId ?? null,
    ]);
    const group = compressionGroups.get(key) ?? [];
    group.push(row);
    compressionGroups.set(key, group);
  }
  for (const group of compressionGroups.values()) {
    const models = group.filter((row) => row.kind === 'model');
    if (models.length !== 1) continue;
    const model = models[0]!;
    for (const row of group)
      if (row !== model && row.kind === 'context') {
        row.relatedNodeIds = [model.nodeId];
        model.relatedNodeIds.push(row.nodeId);
      }
  }
  rows.sort((a, b) => {
    const left = parseDecimal64(a.firstSequence),
      right = parseDecimal64(b.firstSequence);
    return left < right ? -1 : left > right ? 1 : a.depth - b.depth || a.id.localeCompare(b.id);
  });
  const grouped = groupWorkbenchOperations(rows);
  const presentation = buildLoopPresentation(grouped.rows, options.loopParts === true, runNumbers);
  const searchTextById = new Map(
    grouped.rows.map((row) => [
      row.id,
      (row.operation?.members ?? [row])
        .map((member) => searchableMetadata(member as WorkbenchRow, runLabels))
        .join('\n'),
    ]),
  );
  return {
    rows: presentation,
    eventOwners,
    eventsById,
    runOptions,
    searchTextById,
    aliases: grouped.aliases,
    defaultVisibleIds: filterTrajectoryTree(tree.root, 'key_steps').visibleNodeIds,
  };
}

function searchableMetadata(row: WorkbenchRow, runLabels: ReadonlyMap<string, string>): string {
  const step = row.step;
  return [
    row.label,
    row.kind,
    row.category,
    row.phase,
    row.runKey,
    row.runKey ? runLabels.get(row.runKey) : undefined,
    row.firstSequence,
    row.lastSequence,
    step?.definitionId,
    step?.definitionVersion,
    step?.executionId,
    step?.sessionId,
    step?.originStoreId,
    step?.executionOriginStoreId,
    step?.runOriginStoreId,
    step?.parentExecutionId,
    step?.parentExecutionOriginStoreId,
    step?.childSessionId,
    step?.childRunId,
    step?.carrierExecutionId,
    step?.runId,
    step?.messageId,
    step?.operationId,
    step?.recordedStatus,
    step?.display?.title,
    step?.display?.summary,
    step?.display?.modelName,
    step?.display?.operation,
    ...row.events.flatMap((event) => [
      event.eventId,
      event.sequence,
      event.sourceEventType,
      event.origin.storeId,
    ]),
  ]
    .filter((value) => value !== undefined)
    .join('\n')
    .toLocaleLowerCase();
}

/** O(rows + links). The immutable full-prefix metadata and search strings are shared. */
export function filterTrajectoryWorkbench(
  index: TrajectoryWorkbenchIndex,
  filters: WorkbenchFilters = defaultWorkbenchFilters(),
  collapsedNodeIds: readonly string[] = [],
  expansion?: WorkbenchExpansion,
): TrajectoryWorkbench {
  const { eventOwners, eventsById, runOptions } = index;
  const rows: WorkbenchRow[] = index.rows.map((row) => ({
    ...row,
    matched: false,
    structural: row.category === 'structure',
    hiddenByCollapse: false,
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const [alias, id] of index.aliases) {
    const row = byId.get(id);
    if (row) byId.set(alias, row);
  }
  const allTypes =
    filters.childAgents !== false &&
    ['message', 'model', 'tool', 'compression', 'approval'].every((type) =>
      filters.types.includes(type as WorkbenchCategory),
    );
  const allowedTypes = new Set<string>(filters.types),
    runs = filters.runKeys === null ? null : new Set(filters.runKeys),
    query = filters.metadataQuery.trim().toLocaleLowerCase(),
    defaultVisible = index.defaultVisibleIds;
  const matchingIds = new Set<string>();
  for (const row of rows) {
    if (row.virtualPart) continue;
    if (row.kind === 'message' && row.outputSuppressed) continue;
    if (row.category === 'structure') continue;
    const isChildAgent =
      row.operation?.type === 'child' ||
      row.kind === 'child' ||
      (row.kind === 'job' && !!row.step?.childSessionId);
    if (
      row.category === 'administrative'
        ? !filters.includeAdministrative || !allTypes
        : (isChildAgent ? filters.childAgents === false : !allowedTypes.has(row.category)) ||
          (!filters.includeAdministrative && !defaultVisible.has(row.nodeId))
    )
      continue;
    if (!defaultVisible.has(row.nodeId) && (!filters.includeAdministrative || !allTypes)) continue;
    if (runs && (!row.runKey || !runs.has(row.runKey))) continue;
    if (filters.subcalls !== 'all' && row.subcall !== filters.subcalls) continue;
    if (filters.duration !== 'all') {
      if (row.interval.unknownReason === 'not_a_call') continue;
      if (filters.duration === 'unknown') {
        if (row.interval.basis !== 'unknown') continue;
      } else if (
        row.interval.durationMs === undefined ||
        row.interval.durationMs < (filters.duration === 'observed_ge_1s' ? 1000 : 5000)
      )
        continue;
    }
    if (query && !index.searchTextById.get(row.id)?.includes(query)) continue;
    row.matched = true;
    matchingIds.add(row.id);
  }
  const included = new Set(matchingIds),
    structuralIds = new Set<string>();
  for (const id of matchingIds) {
    let parent = byId.get(id)?.parentId;
    while (parent && !included.has(parent)) {
      included.add(parent);
      structuralIds.add(parent);
      parent = byId.get(parent)?.parentId;
    }
  }
  for (const row of rows)
    if (row.virtualPart && matchingIds.has(row.virtualPart.ownerId)) {
      included.add(row.id);
      row.matched = true;
    }
  attachWorkbenchSummaries(rows);
  const active =
    filters.duration !== 'all' ||
    filters.runKeys !== null ||
    !allTypes ||
    filters.subcalls !== 'all' ||
    query.length > 0;
  const canonical = (id: string) => {
    const original = index.aliases.get(id) ?? id;
    return byId.get(original)?.presentationRepresentativeId ?? original;
  };
  const collapsed = new Set(collapsedNodeIds.map(canonical)),
    expanded = new Set(expansion?.expandedNodeIds?.map(canonical) ?? []),
    hidden = new Map<string, string>();
  // The chronological rows are not DFS. Process actual parents independently in linear time.
  const children = new Map<string, WorkbenchRow[]>();
  for (const row of rows)
    if (row.parentId) {
      const siblings = children.get(row.parentId) ?? [];
      siblings.push(row);
      children.set(row.parentId, siblings);
    }
  const pending = rows.filter((row) => !row.parentId);
  for (let index = 0; index < pending.length; index++) {
    const row = pending[index]!,
      inherited = hidden.get(row.id);
    const flat = row.originalParentId !== undefined;
    const level =
      row.presentationHidden ||
      row.virtualPart ||
      (flat && row.kind !== 'run' && row.operation?.type !== 'child' && row.kind !== 'child')
        ? undefined
        : row.kind === 'run'
          ? 'round'
          : row.operation?.type === 'child' || row.kind === 'child'
            ? 'subcall'
            : ['model', 'tool', 'job'].includes(row.kind)
              ? 'call'
              : undefined;
    const enabled =
      !expansion ||
      (level === 'round'
        ? expansion.rounds
        : level === 'subcall'
          ? expansion.subcalls
          : expansion.calls);
    const closed =
      !active &&
      (collapsed.has(row.id) || (level !== undefined && !enabled && !expanded.has(row.id)));
    // A folded round retains its own prompt. Nested child prompts stay inside their parent branch.
    const prompt =
      row.kind === 'message' &&
      row.step?.messageRole === 'user' &&
      inherited === row.parentId &&
      byId.get(inherited)?.kind === 'run';
    row.hiddenByCollapse = inherited !== undefined && !prompt;
    if (row.hiddenByCollapse) row.collapsedById = inherited;
    if (level)
      row.collapse = {
        level,
        collapsed: closed,
        hiddenCount: 0,
        counts: { model: 0, tool: 0, child: 0, approval: 0, compression: 0, message: 0 },
      };
    row.structural = included.has(row.id) && !row.matched;
    for (const child of children.get(row.id) ?? []) {
      if (inherited || closed) hidden.set(child.id, inherited ?? row.id);
      pending.push(child);
    }
  }
  // Count each logical descendant once, independently of the number of raw observations/retries.
  const totals = new Map<string, WorkbenchCollapse['counts']>();
  const emptyCounts = (): WorkbenchCollapse['counts'] => ({
    model: 0,
    tool: 0,
    child: 0,
    approval: 0,
    compression: 0,
    message: 0,
  });
  for (let position = pending.length - 1; position >= 0; position--) {
    const row = pending[position]!,
      own = totals.get(row.id) ?? emptyCounts();
    if (row.collapse) {
      const summary = row.summary;
      const counts = summary
        ? {
            model: summary.model,
            tool: summary.tool,
            child: summary.child,
            approval: summary.approval,
            compression: summary.compression,
            message: summary.userMessages + summary.assistantMessages,
          }
        : own;
      // Run and child summaries use a direct exact scope, never descendant totals.
      row.collapse.counts =
        summary || (row.kind !== 'run' && row.operation?.type !== 'child' && row.kind !== 'child')
          ? { ...counts }
          : emptyCounts();
      row.collapse.hiddenCount = Object.values(row.collapse.counts).reduce(
        (sum, value) => sum + value,
        0,
      );
    }
    if (included.has(row.id) && !row.virtualPart) {
      if (row.operation?.type === 'child' || row.kind === 'child') own.child++;
      else if (row.category === 'message') {
        if (row.step?.messageRole === 'assistant') own.message++;
      } else if (['model', 'tool', 'approval', 'compression'].includes(row.category))
        own[row.category as 'model' | 'tool' | 'approval' | 'compression']++;
    }
    if (row.parentId) {
      const parent = totals.get(row.parentId) ?? emptyCounts();
      for (const key of Object.keys(own) as (keyof typeof own)[]) parent[key] += own[key];
      totals.set(row.parentId, parent);
    }
  }
  // Calls are a compact presentation toggle, not a parent wrapper around the phases.
  // Keep one thought summary and every actual tool/approval/compression operation.
  for (const row of rows) {
    if (row.originalParentId === undefined) continue;
    const representative = row.virtualPart
      ? byId.get(row.virtualPart.ownerId)?.presentationRepresentativeId
      : undefined;
    const compact =
      !active &&
      (representative
        ? collapsed.has(representative) ||
          (!!expansion && !expansion.calls && !expanded.has(representative))
        : !!expansion && !expansion.calls);
    row.compact = compact;
    if (
      row.virtualPart &&
      row.virtualPart.kind !== 'thinking' &&
      compact &&
      !row.hiddenByCollapse
    ) {
      row.hiddenByCollapse = true;
      row.collapsedById = representative;
    }
  }
  const visibleRows = rows.filter(
    (row) => included.has(row.id) && !row.hiddenByCollapse && !row.presentationHidden,
  );
  const domains = new Map<string, WorkbenchRow[]>(),
    unknownRows: WorkbenchRow[] = [];
  for (const row of rows)
    if (
      !row.virtualPart &&
      (row.matched || (included.has(row.id) && row.positionAt !== undefined))
    ) {
      if (row.positionAt === undefined || !row.clockDomain) {
        if (row.matched) unknownRows.push(row);
      } else {
        const group = domains.get(row.clockDomain) ?? [];
        group.push(row);
        domains.set(row.clockDomain, group);
      }
    }
  const timelineDomains: WorkbenchTimelineDomain[] = [...domains].map(
    ([originStoreId, domainRows]) => ({
      originStoreId,
      startAt: domainRows.reduce((minimum, row) => Math.min(minimum, row.positionAt!), Infinity),
      endAt: domainRows.reduce(
        (maximum, row) => Math.max(maximum, row.interval.endAt ?? row.positionAt!),
        -Infinity,
      ),
      rows: domainRows,
      unknown: false,
    }),
  );
  if (unknownRows.length)
    timelineDomains.push({
      originStoreId: null,
      startAt: null,
      endAt: null,
      rows: unknownRows,
      unknown: true,
    });
  return {
    rows,
    visibleRows,
    byId,
    matchingIds,
    structuralIds,
    eventOwners,
    eventsById,
    runOptions,
    timelineDomains,
    counts: {
      matched: matchingIds.size,
      total: rows.filter((row) => row.category !== 'structure' && !row.virtualPart).length,
      structural: structuralIds.size,
      visible: visibleRows.length,
    },
  };
}

/** Convenience for callers that do not retain a full-prefix metadata index. */
export function buildTrajectoryWorkbench(
  projection: TrajectoryProjection | null,
  tree: { root: TrajectoryTreeNode; byId: ReadonlyMap<string, TrajectoryTreeNode> },
  filters: WorkbenchFilters = defaultWorkbenchFilters(),
  collapsedNodeIds: readonly string[] = [],
  expansion?: WorkbenchExpansion,
): TrajectoryWorkbench {
  return filterTrajectoryWorkbench(
    buildTrajectoryWorkbenchIndex(projection, tree),
    filters,
    collapsedNodeIds,
    expansion,
  );
}
