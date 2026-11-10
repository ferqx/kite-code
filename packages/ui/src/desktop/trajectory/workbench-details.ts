import {
  parseDecimal64,
  type TrajectoryEvent,
  type TrajectoryEvidenceRef,
  type TrajectoryStep,
} from '@kite-ai/trajectory';
import { trajectoryVirtualPartTargets } from './loops';
import type { WorkbenchRow } from './workbench';

export type TrajectoryDetailKind =
  | 'message'
  | 'model'
  | 'tool'
  | 'compression'
  | 'interaction'
  | 'job'
  | 'child'
  | 'artifact'
  | 'verification'
  | 'structure'
  | 'metadata';
export type TrajectoryDetailTab =
  | 'overview'
  | 'preview'
  | 'parameters'
  | 'result'
  /** Recognized only for obsolete saved state; never offered as a detail tab. */
  | 'raw'
  | 'system_prompt'
  | 'tools'
  | 'content'
  | 'thinking'
  /** Obsolete node tab; requests now use their independent inspector. */
  | 'request_info';
export interface TrajectoryMaterialTarget {
  event: TrajectoryEvent;
  reference: TrajectoryEvidenceRef;
}

export function trajectoryDetailKind(row: WorkbenchRow): TrajectoryDetailKind {
  if (row.category === 'compression') return 'compression';
  if (row.operation?.type === 'shell') return 'tool';
  if (row.operation?.type === 'child') return 'child';
  if (row.operation?.type === 'model') return 'model';
  if (row.kind === 'session' || row.kind === 'run' || (row.category === 'structure' && !row.event))
    return 'structure';
  if (
    [
      'message',
      'model',
      'tool',
      'job',
      'child',
      'artifact',
      'verification',
      'interaction',
    ].includes(row.kind)
  )
    return row.kind as TrajectoryDetailKind;
  return 'metadata';
}

export function trajectoryDetailTabs(
  row: WorkbenchRow,
): readonly Exclude<TrajectoryDetailTab, 'raw'>[] {
  if (row.virtualPart)
    return row.virtualPart.kind === 'system'
      ? ['system_prompt', 'tools']
      : row.virtualPart.kind === 'thinking'
        ? ['thinking']
        : ['content'];
  const kind = trajectoryDetailKind(row);
  if (kind === 'message') return ['content'];
  if (kind === 'tool') return ['overview', 'parameters', 'result'];
  if (kind === 'structure') return row.kind === 'run' ? ['overview', 'preview'] : ['overview'];
  if (kind === 'metadata' && !row.events.some((event) => event.evidenceRefs.length))
    return ['overview'];
  return ['overview', 'preview'];
}

/** Removed raw/input/output/lifecycle tabs normalize before any material is requested. */
export function normalizeTrajectoryDetailTab(
  row: WorkbenchRow,
  tab?: string | null,
): TrajectoryDetailTab {
  const tabs = trajectoryDetailTabs(row);
  return tabs.includes(tab as Exclude<TrajectoryDetailTab, 'raw'>)
    ? (tab as TrajectoryDetailTab)
    : tabs[0]!;
}

/** The observation must belong to this owner; an unavailable revision never falls forward. */
export function trajectorySelectedObservation(
  row: WorkbenchRow,
  selectedObservationId?: string | null,
): TrajectoryEvent | undefined {
  if (selectedObservationId)
    return row.events.find((event) => event.eventId === selectedObservationId);
  return (
    row.operation?.members
      .find((member) => member.nodeId === row.operation?.primaryNodeId)
      ?.events.at(-1) ?? row.events.at(-1)
  );
}

/** A selection keeps its exact original owner even when several owners share one visible row. */
export function trajectorySelectedMember(row: WorkbenchRow, observationId?: string | null) {
  const members = row.operation?.members;
  if (!members) return row;
  if (observationId)
    return members.find((member) => member.events.some((event) => event.eventId === observationId));
  return members.find((member) => member.nodeId === row.operation?.primaryNodeId);
}

function launchMember(row: WorkbenchRow) {
  return (
    row.operation?.members.find(
      (member) => member.kind === 'tool' && member.nodeId === row.nodeId,
    ) ??
    row.operation?.members.find(
      (member) =>
        member.kind === 'tool' &&
        !row.operation?.observations.some((observation) => observation.nodeId === member.nodeId),
    )
  );
}

/** Exact original references only. The caller still owns authorization, open/read/close and epochs. */
export function trajectoryMaterialTargets(
  row: WorkbenchRow,
  tab: TrajectoryDetailTab,
  selectedObservationId?: string | null,
  rowsById?: ReadonlyMap<string, WorkbenchRow>,
): TrajectoryMaterialTarget[] {
  if (row.virtualPart && normalizeTrajectoryDetailTab(row, tab) === tab)
    return trajectoryVirtualPartTargets(row, selectedObservationId);
  if (normalizeTrajectoryDetailTab(row, tab) !== tab || tab === 'overview') return [];
  const observation = trajectorySelectedObservation(row, selectedObservationId);
  if (!observation) return [];
  const kind = trajectoryDetailKind(row);
  const wanted = new Set<string>(
    tab === 'parameters'
      ? ['tool_input']
      : tab === 'result'
        ? ['tool_result', 'job_output', 'file_change', 'artifact']
        : kind === 'message'
          ? ['message']
          : kind === 'model'
            ? ['model_input', 'model_output']
            : kind === 'compression'
              ? ['context', 'model_output']
              : kind === 'job'
                ? ['job_output', 'tool_result']
                : kind === 'interaction'
                  ? ['interaction']
                  : kind === 'verification'
                    ? ['verification']
                    : kind === 'artifact'
                      ? ['artifact', 'file_change']
                      : kind === 'child'
                        ? ['tool_input', 'tool_result', 'job_output']
                        : ['context', 'interaction', 'verification', 'artifact', 'file_change'],
  );
  const latest = new Map<string, TrajectoryMaterialTarget>();
  const selected = trajectorySelectedMember(row, selectedObservationId);
  let observations = [...(selected?.events ?? [])];
  const grouped = row.operation && ['shell', 'child'].includes(row.operation.type);
  if (grouped && !selectedObservationId) {
    const launch = launchMember(row);
    observations =
      tab === 'parameters'
        ? [...(launch?.events ?? [])]
        : [...(launch?.events ?? []), ...(selected?.events ?? [])];
    // Without a saved command-output checkpoint, show one latest exact observation.
    // All other reads/waits remain selectable; opening a result does not pre-read every poll.
    if (
      row.operation?.type === 'shell' &&
      tab !== 'parameters' &&
      !observations.some((event) =>
        event.evidenceRefs.some((reference) => reference.kind === 'job_output'),
      )
    ) {
      const observed = [...row.operation.observations]
        .reverse()
        .find((member) =>
          member.events.some((event) =>
            event.evidenceRefs.some((reference) => reference.kind === 'tool_result'),
          ),
        );
      if (observed) observations.push(...observed.events);
    }
  }
  if (!row.operation) observations = [...row.events];
  if (kind === 'compression') observations = [...row.events];
  if (kind === 'compression' && rowsById)
    for (const id of row.relatedNodeIds) {
      const related = rowsById.get(id);
      if (related && ['model', 'context'].includes(related.kind))
        observations.push(...related.events);
    }
  observations.sort((a, b) => (parseDecimal64(a.sequence) < parseDecimal64(b.sequence) ? -1 : 1));
  const cutoff =
    ((kind === 'compression' && row.kind === 'model') || grouped) && !selectedObservationId
      ? (observations.at(-1)?.sequence ?? observation.sequence)
      : observation.sequence;
  for (const event of observations) {
    if (parseDecimal64(event.sequence) > parseDecimal64(cutoff)) continue;
    if (event.evidenceRefs.some((reference) => reference.kind === 'artifact'))
      for (const [key, target] of latest)
        if (
          target.reference.kind === 'artifact' &&
          target.event.executionId === event.executionId &&
          target.event.sessionId === event.sessionId &&
          target.event.origin.storeId === event.origin.storeId
        )
          latest.delete(key);
    for (const reference of event.evidenceRefs) {
      if (!wanted.has(reference.kind)) continue;
      // Multiple independent Artifacts of the same observation remain separate materials.
      const owner =
        grouped && !selectedObservationId
          ? `${event.origin.storeId}:${event.sessionId}:${event.executionOriginStoreId ?? ''}:${event.executionId ?? event.eventId}:`
          : '';
      const key =
        owner +
        (reference.kind === 'artifact'
          ? `${reference.kind}:${reference.evidenceId}`
          : reference.kind);
      latest.set(key, { event, reference });
    }
  }
  const targets = [...latest.values()];
  if (row.operation?.type !== 'child' || selectedObservationId) return targets;
  // A managed child can publish a progress checkpoint before its own final reply.
  // Its terminal fact may also attach that earlier progress checkpoint again.
  // Only that same original Job's available terminal result replaces the default preview.
  const completed = targets.filter(
    ({ event, reference }) =>
      reference.kind === 'tool_result' &&
      reference.availability === 'available' &&
      event.kind === 'job' &&
      event.identityConfidence === 'verified_origin' &&
      event.executionId &&
      ['completed', 'failed', 'cancelled', 'outcome_unknown'].includes(event.phase),
  );
  return targets.filter(
    ({ event, reference }) =>
      reference.kind !== 'job_output' ||
      event.kind !== 'job' ||
      event.identityConfidence !== 'verified_origin' ||
      !event.executionId ||
      !completed.some(
        ({ event: result }) =>
          result.executionId === event.executionId &&
          result.sessionId === event.sessionId &&
          result.origin.storeId === event.origin.storeId &&
          (result.executionOriginStoreId ?? result.origin.storeId) ===
            (event.executionOriginStoreId ?? event.origin.storeId) &&
          result.runId === event.runId &&
          (!event.runId ||
            (result.runOriginStoreId ?? result.origin.storeId) ===
              (event.runOriginStoreId ?? event.origin.storeId)) &&
          parseDecimal64(result.sequence) >= parseDecimal64(event.sequence),
      ),
  );
}

export interface TrajectoryModelRequestGroups {
  system: readonly Record<string, unknown>[];
  messages: readonly Record<string, unknown>[];
  tools: readonly unknown[];
  sources: readonly string[];
  modelId?: string;
}

/** Group the already validated public request only; never classify instructions by their text. */
export function trajectoryModelRequestGroups(value: unknown): TrajectoryModelRequestGroups | null {
  const object = (item: unknown): Record<string, unknown> | undefined =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : undefined;
  const body = object(value),
    request = object(body?.request);
  if (!request || !Array.isArray(request.messages) || !Array.isArray(request.tools)) return null;
  const system: Record<string, unknown>[] = [],
    messages: Record<string, unknown>[] = [];
  for (const value of request.messages) {
    const message = object(value);
    if (!message || typeof message.role !== 'string') return null;
    (message.role === 'system' ? system : messages).push(message);
  }
  const sources = object(object(body?.metadata)?.context)?.sources;
  return {
    system,
    messages,
    tools: request.tools,
    sources: Array.isArray(sources)
      ? sources.flatMap((value) => {
          const source = object(value);
          return typeof source?.id === 'string' ? [source.id] : [];
        })
      : [],
    ...(typeof request.modelId === 'string' ? { modelId: request.modelId } : {}),
  };
}

/**
 * A Provider user role may also carry Host context. Session files and the exact
 * Planning runtime source follow history; omit only their last captured occurrence
 * in a complete, verified request. Earlier copies and unmarked user text remain visible.
 * Do not inspect bodies until yielded: list excerpts must stop before later bodies.
 */
export function* trajectoryRequestUserMessages(
  value: unknown,
  observation?: { event?: TrajectoryEvent; complete: boolean },
): Generator<Record<string, unknown>> {
  const object = (item: unknown): Record<string, unknown> | undefined =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : undefined;
  const body = object(value),
    messages = object(body?.request)?.messages;
  if (!Array.isArray(messages)) return;
  const context = object(object(body?.metadata)?.context),
    event = observation?.event,
    omitted = new Set<number>();
  if (
    observation?.complete &&
    event?.kind === 'model' &&
    event.identityConfidence === 'verified_origin' &&
    context?.transformationId === 'kite.model-request' &&
    (context.transformationVersion === '1' || context.transformationVersion === '2') &&
    context.messageOrder === 'request.messages' &&
    context.sourceOrder === 'request.messages[].sourceIds' &&
    Array.isArray(context.sources)
  ) {
    const suffix = `:session-files:${event.sessionId}`;
    const runtime = event.runId ? `builtin.planning:runtime:${event.runId}` : undefined;
    const current = new Set(
      context.sources.flatMap((item) => {
        const source = object(item);
        return typeof source?.id === 'string' &&
          ((source.id.length > suffix.length && source.id.endsWith(suffix)) ||
            source.id === runtime) &&
          typeof source.digest === 'string'
          ? [source.id]
          : [];
      }),
    );
    for (let index = messages.length - 1; index >= 0 && current.size; index--) {
      const message = object(messages[index]),
        ids = message?.sourceIds;
      if (
        message?.role === 'user' &&
        Array.isArray(ids) &&
        ids.length === 1 &&
        current.delete(ids[0])
      )
        omitted.add(index);
    }
  }
  for (let index = 0; index < messages.length; index++) {
    if (omitted.has(index)) continue;
    const message = object(messages[index]);
    if (message?.role !== 'user') continue;
    if (
      typeof message.content === 'string' &&
      !/\S/u.test(message.content) &&
      !(Array.isArray(message.images) && message.images.length) &&
      !(Array.isArray(message.toolCalls) && message.toolCalls.length)
    )
      continue;
    yield message;
  }
}

/** Publication can enrich a generated summary without changing either entity's own facts. */
export function trajectoryCompressionMetadata(
  row: WorkbenchRow,
  selectedObservationId?: string | null,
  rowsById?: ReadonlyMap<string, WorkbenchRow>,
): TrajectoryStep['compression'] {
  if (trajectoryDetailKind(row) !== 'compression') return undefined;
  const observation = trajectorySelectedObservation(row, selectedObservationId);
  if (!observation) return undefined;
  const cutoff = selectedObservationId
    ? observation.sequence
    : (row.events.at(-1)?.sequence ?? observation.sequence);
  let metadata: TrajectoryStep['compression'];
  for (const event of row.events)
    if (
      parseDecimal64(event.sequence) <= parseDecimal64(cutoff) &&
      (event.kind === 'model' || event.kind === 'context') &&
      event.attributes.compression
    )
      metadata = event.attributes.compression;
  let publishedAt = -1n;
  if (row.kind === 'model' && rowsById)
    for (const id of row.relatedNodeIds) {
      const related = rowsById.get(id);
      if (related?.kind !== 'context') continue;
      for (const event of related.events) {
        const at = parseDecimal64(event.sequence);
        if (selectedObservationId && at > parseDecimal64(observation.sequence)) continue;
        if (
          event.kind === 'context' &&
          event.sourceEventType === 'context.compressed' &&
          event.attributes.compression?.adopted === true &&
          at > publishedAt
        ) {
          metadata = event.attributes.compression;
          publishedAt = at;
        }
      }
    }
  return metadata ? structuredClone(metadata) : undefined;
}
