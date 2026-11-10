import { canonicalSerialize, type Decimal64, type TrajectorySnapshot } from '@kite-ai/trajectory';
import type { WorkbenchFilters } from './workbench';

export type TrajectoryDetailTab =
  | 'overview'
  | 'preview'
  | 'parameters'
  | 'result'
  /** Old saved selections migrate to the selected stage's first supported tab. */
  | 'raw'
  | 'system_prompt'
  | 'tools'
  | 'content'
  | 'thinking'
  /** Obsolete node tab; requests now use their independent inspector. */
  | 'request_info';

/** Serializable values only. Handles, callbacks, caches and authorization never live here. */
export interface TrajectoryViewState {
  descriptor: TrajectorySnapshot | null;
  cursor: Decimal64;
  mode?: 'live' | 'history' | 'replay';
  pageAfterCursor?: Decimal64;
  listMode: 'key_steps' | 'all_events';
  expandedEventIds: string[];
  selectedEventId: string | null;
  selectedNodeId?: string | null;
  /** A request boundary opens its own inspector, independently from a content node. */
  selectedRequestId?: string | null;
  requestTab?: 'overview' | 'options' | 'usage' | 'timing';
  detailTab?: 'input' | 'output' | 'lifecycle';
  workbenchTab?: TrajectoryDetailTab;
  filters?: WorkbenchFilters;
  detailOpen?: boolean;
  detailWidth?: number;
  selectedObservationId?: string | null;
  selectedRelatedScope?: {
    nodeId: string;
    parentNodeId: string;
    sessionId: string;
    runId: string;
  } | null;
  timelineMode?: 'time' | 'order';
  collapsedNodeIds?: string[];
  /** Presentation density only; every original fact and relationship remains retained. */
  expansion?: { rounds: boolean; calls: boolean; subcalls: boolean };
  expandedNodeIds?: string[];
  detailScrollTop?: number;
  readingAnchor: { eventId: string | null; offset: number; scrollTop: number };
}
export function initialTrajectoryViewState(
  descriptor: TrajectorySnapshot | null = null,
): TrajectoryViewState {
  return {
    descriptor: descriptor ? structuredClone(descriptor) : null,
    cursor: descriptor?.upperCursor ?? '0',
    mode: 'live',
    listMode: 'key_steps',
    expandedEventIds: [],
    selectedEventId: null,
    selectedNodeId: 'session',
    detailTab: 'lifecycle',
    workbenchTab: 'overview',
    detailOpen: false,
    detailWidth: 40,
    selectedObservationId: null,
    timelineMode: 'time',
    collapsedNodeIds: [],
    expansion: { rounds: true, calls: true, subcalls: false },
    expandedNodeIds: [],
    detailScrollTop: 0,
    readingAnchor: { eventId: null, offset: 0, scrollTop: 0 },
  };
}
/** A key identifies retained viewing state, never a projection cache or permission to read it. */
export function trajectoryViewStateKey(descriptor: TrajectorySnapshot): string {
  return canonicalSerialize({
    source: { storeId: descriptor.storeId, sessionId: descriptor.sessionId },
    scope: {
      runId: descriptor.runId ?? null,
      executionId: descriptor.executionId ?? null,
      eventKinds: descriptor.eventKinds ?? [],
    },
    upperCursor: descriptor.upperCursor,
  });
}
