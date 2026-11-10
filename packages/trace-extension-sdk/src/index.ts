import type {
  Decimal64,
  KnownTrajectoryKind,
  TraceDeliveryResult,
  TraceEventBatch,
  TraceEventView,
  TrajectoryEvidenceChunk,
  TrajectoryEvidenceDescriptor,
  TrajectoryEvidenceRef,
} from '@kite-ai/trajectory';

export type {
  Decimal64,
  KnownTrajectoryKind,
  TraceEventBatch,
  TraceEventView,
  TrajectoryEvidenceRef,
} from '@kite-ai/trajectory';
export type TraceJson =
  | null
  | boolean
  | number
  | string
  | TraceJson[]
  | { [key: string]: TraceJson };
export interface TraceManifest {
  apiVersion: 1;
  name: string;
  history: boolean;
  eventKinds: KnownTrajectoryKind[];
  evidenceKinds: TrajectoryEvidenceRef['kind'][];
  origins: string[];
  settings: Record<string, 'string' | 'number' | 'boolean'>;
}
export interface TraceHistoryRequest {
  storeRef: string;
  sessionRef: string;
  runRef?: string;
  executionRef?: string;
  fromSequence?: Decimal64;
  toSequence?: Decimal64;
  eventKinds?: KnownTrajectoryKind[];
  contentMode: 'metadata' | 'authorized_evidence';
}
export type TraceHttpResult =
  | { status: 'complete'; httpStatus: number; bodyBase64: string }
  | { status: 'unconfirmed'; code: 'request_interrupted' | 'response_unavailable' }
  | {
      status: 'unavailable';
      code:
        | 'origin_denied'
        | 'target_denied'
        | 'credential_unavailable'
        | 'request_limit'
        | 'broker_busy'
        | 'permission_revoked'
        | 'invalid_request'
        | 'network_unavailable'
        | 'redirect_denied';
    };
export interface TraceExtensionContext {
  readonly installationId: string;
  readonly apiVersion: 1;
  readonly settings: { get(): Promise<Record<string, string | number | boolean>> };
  readonly history: { request(input: TraceHistoryRequest): Promise<{ partitionId: string }> };
  readonly evidence: {
    open(input: {
      eventId: string;
      evidenceId: string;
      contentVersion: string;
    }): Promise<TrajectoryEvidenceDescriptor>;
    read(input: {
      readId: string;
      offset: Decimal64;
      limit?: number;
    }): Promise<TrajectoryEvidenceChunk>;
    close(input: { readId: string }): Promise<void>;
  };
  readonly http: {
    request(input: {
      url: string;
      method: 'GET' | 'POST';
      headers?: { 'content-type'?: string; accept?: string; 'idempotency-key'?: string };
      bodyBase64?: string;
      credentialHandle?: string;
    }): Promise<TraceHttpResult>;
  };
  readonly log: {
    emit(code: 'delivery_started' | 'delivery_complete' | 'delivery_failed'): Promise<void>;
  };
}
export interface TraceDeliveryContext extends TraceExtensionContext {
  readonly source: TraceEventBatch['source'];
  /** Distinct from eventId. A user may deliberately export one event to another destination/task. */
  readonly taskId: string;
}
export interface TraceDeliveryDecision {
  acknowledgedEventIds: string[];
  rejected: TraceDeliveryResult['rejected'];
}
export interface TraceExtension {
  initialize?(context: TraceExtensionContext): Promise<void> | void;
  onEvents(
    batch: TraceEventBatch,
    context: TraceDeliveryContext,
  ): Promise<TraceDeliveryDecision> | TraceDeliveryDecision;
  flush?(): Promise<void> | void;
  shutdown?(): Promise<void> | void;
}
interface EngineGlobals {
  trace: { request(method: string, input: unknown): Promise<unknown> };
  defineTraceExtension(value: {
    initialize(input: { installationId: string; apiVersion: 1 }): Promise<void>;
    onEvents(batch: TraceEventBatch): Promise<TraceDeliveryResult>;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
  }): void;
}

/** Returns only an explicit successful subset. No timeout/failure implicitly acknowledges an event. */
export function acknowledge(
  events: readonly Pick<TraceEventView, 'eventId'>[],
): TraceDeliveryDecision {
  return { acknowledgedEventIds: events.map((event) => event.eventId), rejected: [] };
}

/** Compile this registration into one local IIFE. No Host objects, I/O runtime or storage API is exposed. */
export function defineTraceExtension(extension: TraceExtension): void {
  const engine = globalThis as unknown as EngineGlobals;
  if (
    typeof engine.defineTraceExtension !== 'function' ||
    !engine.trace ||
    typeof extension.onEvents !== 'function'
  )
    throw new Error('trace_extension_runtime_unavailable');
  const broker = engine.trace.request.bind(engine.trace);
  let context: TraceExtensionContext | undefined;
  const evidenceFor = (batchId?: string): TraceExtensionContext['evidence'] =>
    Object.freeze({
      open: async (value) => {
        if (!batchId) throw new Error('trace_evidence_requires_delivery');
        return (await broker('evidence.open', {
          ...value,
          batchId,
        })) as TrajectoryEvidenceDescriptor;
      },
      read: (value) => broker('evidence.read', value) as Promise<TrajectoryEvidenceChunk>,
      close: async (value) => {
        await broker('evidence.close', value);
      },
    });
  engine.defineTraceExtension({
    async initialize(input) {
      context = Object.freeze({
        installationId: input.installationId,
        apiVersion: input.apiVersion,
        settings: Object.freeze({
          get: () =>
            broker('settings.get', null) as Promise<Record<string, string | number | boolean>>,
        }),
        history: Object.freeze({
          request: (value: TraceHistoryRequest) =>
            broker('history.request', value) as Promise<{ partitionId: string }>,
        }),
        evidence: evidenceFor(),
        http: Object.freeze({
          request: (value: Parameters<TraceExtensionContext['http']['request']>[0]) =>
            broker('http.request', value) as ReturnType<TraceExtensionContext['http']['request']>,
        }),
        log: Object.freeze({
          emit: async (code: Parameters<TraceExtensionContext['log']['emit']>[0]) => {
            await broker('log.emit', { code });
          },
        }),
      });
      await extension.initialize?.(context);
    },
    async onEvents(batch) {
      if (!context) throw new Error('trace_extension_not_initialized');
      const taskId =
        batch.partition.lane.kind === 'history'
          ? batch.partition.lane.exportId
          : `live:${batch.partition.installationId}:${batch.partition.subscriptionEpoch}`;
      const result = await extension.onEvents(
        batch,
        Object.freeze({
          ...context,
          evidence: evidenceFor(batch.batchId),
          source: batch.source,
          taskId,
        }),
      );
      if (!result || !Array.isArray(result.acknowledgedEventIds) || !Array.isArray(result.rejected))
        throw new Error('invalid_trace_delivery');
      const sent = new Set(batch.events.map((event) => event.eventId)),
        seen = new Set<string>();
      for (const id of [
        ...result.acknowledgedEventIds,
        ...result.rejected.map((item) => item.eventId),
      ]) {
        if (!sent.has(id) || seen.has(id)) throw new Error('invalid_trace_delivery');
        seen.add(id);
      }
      return {
        batchId: batch.batchId,
        leaseToken: batch.leaseToken,
        processGeneration: batch.processGeneration,
        subscriptionEpoch: batch.partition.subscriptionEpoch,
        acknowledgedEventIds: result.acknowledgedEventIds,
        rejected: result.rejected,
      };
    },
    async flush() {
      await extension.flush?.();
    },
    async shutdown() {
      await extension.shutdown?.();
    },
  });
}
