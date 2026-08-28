import type { RuntimeSessionProjection } from '@kite-ai/runtime-contract';
import { SessionMailbox } from '../session-mailbox';

export type SessionProjectionChange =
  | { readonly type: 'upsert'; readonly projection: RuntimeSessionProjection }
  | { readonly type: 'remove'; readonly sessionId: string };

export type SessionProjectionCommit = 'inserted' | 'updated' | 'unchanged';

export class SessionRegistry {
  readonly #mailboxes = new Map<string, SessionMailbox>();
  readonly #projections = new Map<string, RuntimeSessionProjection>();
  readonly #listeners = new Set<(change: SessionProjectionChange) => void>();

  mailbox(sessionId: string): SessionMailbox {
    const existing = this.#mailboxes.get(sessionId);
    if (existing) return existing;
    const mailbox = new SessionMailbox();
    this.#mailboxes.set(sessionId, mailbox);
    return mailbox;
  }

  commitProjection(projection: RuntimeSessionProjection): SessionProjectionCommit {
    const current = this.#projections.get(projection.sessionId);
    if (current && current.revision > projection.revision) return 'unchanged';
    if (current && current.revision === projection.revision) {
      if (canonicalProjection(current) !== canonicalProjection(projection)) {
        const stableCurrent = withoutModel(current);
        const stableProjection = withoutModel(projection);
        if (
          canonicalProjection(stableCurrent) !== canonicalProjection(stableProjection) &&
          !isExecutionCleanupEnrichment(stableCurrent, stableProjection)
        ) {
          throw new Error('Runtime Session projection diverged at the same revision.');
        }
        const enriched =
          projection.model === undefined && current.model !== undefined
            ? { ...projection, model: current.model }
            : projection;
        if (canonicalProjection(current) !== canonicalProjection(enriched)) {
          this.#projections.set(enriched.sessionId, enriched);
          this.#emit({ type: 'upsert', projection: enriched });
          return 'updated';
        }
      }
      return 'unchanged';
    }
    this.#projections.set(projection.sessionId, projection);
    this.#emit({ type: 'upsert', projection });
    return current ? 'updated' : 'inserted';
  }

  removeProjection(sessionId: string): boolean {
    const removed = this.#projections.delete(sessionId);
    if (removed) this.#emit({ type: 'remove', sessionId });
    return removed;
  }

  onProjectionChange(listener: (change: SessionProjectionChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  projection(sessionId: string): RuntimeSessionProjection | undefined {
    return this.#projections.get(sessionId);
  }

  projections(): readonly RuntimeSessionProjection[] {
    return [...this.#projections.values()].sort((left, right) =>
      left.sessionId.localeCompare(right.sessionId),
    );
  }

  close(): void {
    this.#mailboxes.clear();
    this.#projections.clear();
    this.#listeners.clear();
  }

  #emit(change: SessionProjectionChange): void {
    for (const listener of this.#listeners) listener(change);
  }
}

function isExecutionCleanupEnrichment(
  current: RuntimeSessionProjection,
  next: RuntimeSessionProjection,
): boolean {
  const currentWork = current.activeWork;
  const nextWork = next.activeWork;
  if (!currentWork || !nextWork) return false;
  if (!['queued', 'running', 'waiting'].includes(currentWork.status)) return false;
  if (!['completed', 'cancelled', 'failed'].includes(nextWork.status)) return false;
  if (currentWork.activeTurn && nextWork.activeTurn?.status !== nextWork.status) return false;
  const expected: RuntimeSessionProjection = {
    ...current,
    activeWork: {
      ...currentWork,
      status: nextWork.status,
      activeTurn: currentWork.activeTurn
        ? { ...currentWork.activeTurn, status: nextWork.status, interaction: undefined }
        : undefined,
    },
  };
  return stableSerializeIgnoringUndefined(expected) === stableSerializeIgnoringUndefined(next);
}

function stableSerializeIgnoringUndefined(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerializeIgnoringUndefined).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerializeIgnoringUndefined(record[key])}`)
    .join(',')}}`;
}

function withoutModel(projection: RuntimeSessionProjection): RuntimeSessionProjection {
  const { model: _model, ...stable } = projection;
  return stable;
}

function canonicalProjection(projection: RuntimeSessionProjection): string {
  return stableSerialize(projection);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}
