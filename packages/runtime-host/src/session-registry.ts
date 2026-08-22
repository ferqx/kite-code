import type { RuntimeSessionProjection } from '@kite/runtime-contract';
import { SessionMailbox } from './session-mailbox';

export class SessionRegistry {
  readonly #mailboxes = new Map<string, SessionMailbox>();
  readonly #projections = new Map<string, RuntimeSessionProjection>();

  mailbox(sessionId: string): SessionMailbox {
    const existing = this.#mailboxes.get(sessionId);
    if (existing) return existing;
    const mailbox = new SessionMailbox();
    this.#mailboxes.set(sessionId, mailbox);
    return mailbox;
  }

  commitProjection(projection: RuntimeSessionProjection): void {
    const current = this.#projections.get(projection.sessionId);
    if (current && current.revision > projection.revision) return;
    this.#projections.set(projection.sessionId, projection);
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
  }
}
