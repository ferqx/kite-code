import type { ModelUsage } from '@kite-ai/ai';
import type {
  CommandRecord,
  ExecutionRecord,
  Json,
  RunRecord,
  SessionRecord,
} from '../storage/types';

export interface RunBoundaryEvent {
  readonly command: Readonly<CommandRecord>;
  readonly session: Readonly<SessionRecord>;
  /** Null before activation; the active Run at the completion boundary. */
  readonly run: Readonly<RunRecord> | null;
}

export interface LifecycleAction {
  readonly actionId: string;
  readonly definitionVersion: string;
  readonly input: Json;
}

export interface LifecycleHooks {
  /** Pure Action selection for explicit run.start/input.follow_up, before configuration.
   * Internal child activation and automatic reports do not dispatch lifecycle Actions. */
  beforeRun?(event: RunBoundaryEvent): Promise<LifecycleAction | null>;
  /** Pure Action selection for the same explicit input, before its successful completion CAS. */
  beforeRunComplete?(event: RunBoundaryEvent): Promise<LifecycleAction | null>;
  /** Best-effort observation of a newly activated Run; recovery does not replay start. */
  onRunStart?: LifecycleObserver<RunStartedEvent>;
  /** Published after dispatch admission, before entering the adapter; delivery is not awaited. */
  onModelStart?: LifecycleObserver<ModelStartedEvent>;
  /** Best-effort, read-only observation after the actual Step Model result is committed. */
  onModelEnd?: LifecycleObserver<ModelSettledEvent>;
  /** Best-effort, read-only observation after the original Run terminal fact is committed. */
  onRunEnd?: LifecycleObserver<RunSettledEvent>;
}

/** Observers receive facts only: no execution, record-write or resource capabilities. */
export type LifecycleObserver<Event> = (event: Readonly<Event>) => void | Promise<void>;

interface LifecycleIdentity {
  readonly eventId: string;
  readonly originStoreId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly originCommandId: string;
}

interface ModelIdentity extends LifecycleIdentity {
  readonly executionId: string;
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly attempt: number;
}

export interface ModelStartedEvent extends ModelIdentity {
  readonly type: 'model.started';
}

export interface RunStartedEvent extends LifecycleIdentity {
  readonly type: 'run.started';
  readonly createdAt: number;
}

export interface ModelSettledEvent extends ModelIdentity {
  readonly type: 'model.settled';
  readonly resultRevision: string;
  readonly status: Extract<
    ExecutionRecord['status'],
    'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown'
  >;
  readonly usage: Readonly<Omit<ModelUsage, 'raw'>> | null;
  readonly finishReason: string | null;
  readonly code: string | null;
  readonly incomplete: boolean;
}

export interface RunSettledEvent extends LifecycleIdentity {
  readonly type: 'run.settled';
  readonly status: Extract<
    RunRecord['status'],
    'completed' | 'failed' | 'cancelled' | 'interrupted'
  >;
  readonly createdAt: number;
  readonly finishedAt: number;
  readonly reason: string | null;
}

type Delivery = () => void | Promise<void>;
interface ObserverQueue {
  pending: Delivery[];
  running: boolean;
  disabled: boolean;
}

/** Non-authoritative notifications never retain bindings or join Runtime drain. */
export class LifecycleObservers {
  private readonly queues = new WeakMap<object, ObserverQueue>();
  private readonly active = new Set<ObserverQueue>();
  private pending = 0;
  private closed = false;

  publish<Event>(observer: LifecycleObserver<Event>, event: Event): void {
    // Includes in-flight deliveries, so an unresolved observer also consumes capacity.
    if (this.closed || this.pending >= 128) return;
    let queue = this.queues.get(observer);
    if (!queue) {
      queue = { pending: [], running: false, disabled: false };
      this.queues.set(observer, queue);
    }
    if (queue.disabled) return;
    // One slow observer must leave room for unrelated observers.
    if (queue.pending.length >= 16) return;
    queue.pending.push(() => observer(event));
    this.pending++;
    this.active.add(queue);
    if (queue.running) return;
    queue.running = true;
    const selected = queue;
    queueMicrotask(() => void this.deliver(selected));
  }

  close(): void {
    this.closed = true;
    for (const queue of this.active) {
      this.pending -= queue.pending.length;
      queue.pending.length = 0;
    }
    this.active.clear();
  }

  private async deliver(queue: ObserverQueue): Promise<void> {
    try {
      while (!this.closed && queue.pending.length) {
        const delivery = queue.pending.shift()!;
        try {
          await delivery();
        } catch {
          queue.disabled = true;
          break;
        } finally {
          this.pending--;
        }
      }
    } finally {
      this.pending -= queue.pending.length;
      queue.pending.length = 0;
      queue.running = false;
      this.active.delete(queue);
    }
  }
}

/** Called only after the original dispatch acknowledgement and cancellation check. */
export function modelStartedEvent(execution: ExecutionRecord): ModelStartedEvent {
  return Object.freeze({
    type: 'model.started',
    eventId: JSON.stringify(['model.started', execution.originStoreId, execution.id]),
    originStoreId: execution.originStoreId,
    sessionId: execution.sessionId,
    runId: execution.runId!,
    originCommandId: execution.originCommandId,
    executionId: execution.id,
    definitionId: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    attempt: execution.attempt,
  });
}

/** Activation has already committed; the resumed path intentionally omits this event. */
export function runStartedEvent(run: RunRecord): RunStartedEvent {
  return Object.freeze({
    type: 'run.started',
    eventId: JSON.stringify(['run.started', run.originStoreId, run.id]),
    originStoreId: run.originStoreId,
    sessionId: run.sessionId,
    runId: run.id,
    originCommandId: run.originCommandId,
    createdAt: run.createdAt,
  });
}

export function modelSettledEvent(execution: ExecutionRecord): ModelSettledEvent | null {
  if (
    execution.kind !== 'model' ||
    !execution.runId ||
    !['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(execution.status)
  )
    return null;
  const result = execution.result;
  const data = result && typeof result === 'object' && !Array.isArray(result) ? result : {};
  const measured = data.usage;
  let usage: ModelSettledEvent['usage'] = null;
  if (measured && typeof measured === 'object' && !Array.isArray(measured)) {
    const count = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const optional = (key: 'totalTokens' | 'cachedInputTokens' | 'reasoningTokens') => {
      const value = count(measured[key]);
      return value === null ? {} : { [key]: value };
    };
    usage = Object.freeze({
      inputTokens: count(measured.inputTokens),
      outputTokens: count(measured.outputTokens),
      ...optional('totalTokens'),
      ...optional('cachedInputTokens'),
      ...optional('reasoningTokens'),
    });
  }
  return Object.freeze({
    type: 'model.settled',
    eventId: JSON.stringify([
      'model',
      execution.originStoreId,
      execution.id,
      execution.resultRevision,
    ]),
    originStoreId: execution.originStoreId,
    sessionId: execution.sessionId,
    runId: execution.runId,
    originCommandId: execution.originCommandId,
    executionId: execution.id,
    definitionId: execution.definitionId,
    definitionVersion: execution.definitionVersion,
    attempt: execution.attempt,
    resultRevision: execution.resultRevision,
    status: execution.status as ModelSettledEvent['status'],
    usage,
    finishReason: typeof data.finishReason === 'string' ? data.finishReason : null,
    code: typeof data.code === 'string' ? data.code : null,
    incomplete: data.incomplete === true,
  });
}

export function runSettledEvent(run: RunRecord): RunSettledEvent | null {
  if (
    run.isActive ||
    run.finishedAt === null ||
    !['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)
  )
    return null;
  return Object.freeze({
    type: 'run.settled',
    eventId: JSON.stringify(['run', run.originStoreId, run.id, run.status, run.finishedAt]),
    originStoreId: run.originStoreId,
    sessionId: run.sessionId,
    runId: run.id,
    originCommandId: run.originCommandId,
    status: run.status as RunSettledEvent['status'],
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    reason: run.reason,
  });
}
