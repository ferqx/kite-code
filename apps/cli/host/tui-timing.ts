import type { AgentClient, SessionLogEntry, SessionView } from '@kite-ai/client';

export interface TuiExecutionTiming {
  /** Committed dispatch boundary, not Provider first token or native process birth. */
  availability: 'recorded_dispatch' | 'unavailable';
  startedAt?: number;
  finishedAt?: number;
}
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'outcome_unknown']);
function cursor(value: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > 9223372036854775807n)
    throw Error('tui_timing_cursor_invalid');
  return BigInt(value);
}
function timestamp(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value >= 0;
}

/** Optional display read: exhaust one fixed session bound, retain no log history. */
export async function readTuiTimings(
  client: Pick<AgentClient, 'listSessionLogs'>,
  storeId: string,
  view: SessionView,
  signal: AbortSignal,
): Promise<Readonly<Record<string, TuiExecutionTiming>>> {
  const unavailable = Object.fromEntries(
    view.executions.map((execution) => [execution.id, { availability: 'unavailable' as const }]),
  );
  const targets = new Map(
    view.executions
      .filter(
        (execution) =>
          execution.sessionId === view.session.id && execution.originStoreId === storeId,
      )
      .map((execution) => [execution.id, execution]),
  );
  if (!targets.size || view.storeId !== storeId) return unavailable;
  const boundaries = new Map<string, { start?: number; finish?: number; invalid?: boolean }>();
  try {
    const upper = cursor(view.snapshotCursor);
    let after = '0';
    for (;;) {
      signal.throwIfAborted();
      const page = await client.listSessionLogs(view.session.id, {
        expectedStoreId: storeId,
        afterCursor: after,
        upperCursor: view.snapshotCursor,
        limit: 200,
        signal,
      });
      signal.throwIfAborted();
      if (
        page.storeId !== storeId ||
        page.sessionId !== view.session.id ||
        page.upperCursor !== view.snapshotCursor ||
        cursor(page.replayFloor) > cursor(after) ||
        upper > cursor(page.snapshotCursor) ||
        page.entries.length > 200 ||
        page.complete !== (page.nextAfterCursor === null)
      )
        throw Error('tui_timing_page_invalid');
      let previous = cursor(after);
      for (const entry of page.entries) {
        const position = cursor(entry.cursor);
        cursor(entry.revision);
        if (entry.sessionId !== view.session.id || position <= previous || position > upper)
          throw Error('tui_timing_page_invalid');
        previous = position;
        if (entry.type !== 'execution.dispatching' && entry.type !== 'execution.finished') continue;
        const target = targets.get(entry.objectId);
        if (!target) continue;
        const boundary = boundaries.get(target.id) ?? {};
        boundaries.set(target.id, boundary);
        if (!matches(entry, target) || !timestamp(entry.occurredAt)) {
          boundary.invalid = true;
          continue;
        }
        if (entry.type === 'execution.dispatching') {
          if (
            entry.recordedStatus !== 'dispatching' ||
            boundary.start !== undefined ||
            boundary.finish !== undefined
          )
            boundary.invalid = true;
          else boundary.start = entry.occurredAt;
        } else if (
          !terminal.has(entry.recordedStatus ?? '') ||
          entry.recordedStatus !== target.status ||
          boundary.start === undefined ||
          boundary.finish !== undefined ||
          entry.occurredAt < boundary.start
        ) {
          boundary.invalid = true;
        } else boundary.finish = entry.occurredAt;
      }
      if (page.complete) break;
      if (
        !page.entries.length ||
        page.nextAfterCursor !== page.entries.at(-1)!.cursor ||
        previous >= upper
      )
        throw Error('tui_timing_page_invalid');
      after = page.nextAfterCursor!;
    }
    const result = { ...unavailable } as Record<string, TuiExecutionTiming>;
    for (const [id, target] of targets) {
      const boundary = boundaries.get(id);
      if (
        !boundary ||
        boundary.invalid ||
        boundary.start === undefined ||
        (terminal.has(target.status) && boundary.finish === undefined) ||
        (!terminal.has(target.status) && boundary.finish !== undefined)
      )
        continue;
      result[id] = {
        availability: 'recorded_dispatch',
        startedAt: boundary.start,
        ...(boundary.finish === undefined ? {} : { finishedAt: boundary.finish }),
      };
    }
    return result;
  } catch {
    // Unavailable metadata never becomes an observer-time substitute or blocks work.
    return unavailable;
  }
}

function matches(entry: SessionLogEntry, execution: SessionView['executions'][number]): boolean {
  return (
    entry.category === 'execution' &&
    entry.details.executionId === execution.id &&
    entry.details.kind === execution.kind &&
    entry.details.definitionId === execution.definitionId &&
    entry.details.definitionVersion === execution.definitionVersion &&
    (entry.details.runId ?? null) === execution.runId &&
    (execution.kind !== 'model' || entry.modelExecutionId === execution.id)
  );
}
