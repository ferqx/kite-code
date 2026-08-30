import type { WebSessionStatus, WebWorkspaceSummary } from '@kite-ai/kite-app-contract';
import type { RuntimeLogQueryPort } from '@kite-ai/runtime-host/storage';
import { projectRuntimeClientText } from '../runtime-client/safe-text';
import type { WebObserverDirectoryPort } from './core';

const MAX_DIRECTORY_SESSIONS = 256;
const LOG_PAGE_LIMIT = 100;

type RuntimeLogQuerySource = RuntimeLogQueryPort | (() => RuntimeLogQueryPort);

export interface WebObserverWorkspaceDirectorySource {
  /** Opaque stable Workspace/Worker scope identity; never a filesystem path. */
  readonly workspaceId: string;
  /** Human project label owned by Coordinator/Worker metadata, never Browser input. */
  readonly label: string;
  /** Current-format, query-only Store reader. */
  readonly logs: RuntimeLogQuerySource;
  readonly status: (sessionId: string) => WebSessionStatus;
}

/**
 * Build the path-free Directory DTO from current-format Worker readers. No
 * compatibility source or writer is accepted by this boundary.
 */
export function createWebObserverDirectoryPort(
  sources: readonly WebObserverWorkspaceDirectorySource[],
): WebObserverDirectoryPort {
  const identities = new Set<string>();
  for (const source of sources) {
    assertWorkspaceIdentity(source.workspaceId, source.label);
    if (identities.has(source.workspaceId)) {
      throw new TypeError('Web Directory contains a duplicate Workspace identity.');
    }
    identities.add(source.workspaceId);
  }
  return Object.freeze({
    list: () =>
      sources
        .map(readWorkspace)
        .sort(
          (left, right) =>
            left.label.localeCompare(right.label) ||
            left.workspaceId.localeCompare(right.workspaceId),
        ),
  });
}

function readWorkspace(source: WebObserverWorkspaceDirectorySource): WebWorkspaceSummary {
  const reader = typeof source.logs === 'function' ? source.logs() : source.logs;
  try {
    const sessions: WebWorkspaceSummary['sessions'][number][] = [];
    let cursor: { readonly updatedAt: number; readonly sessionId: string } | undefined;
    for (;;) {
      const page = reader.listSessions({
        ...(cursor === undefined ? {} : { cursor }),
        limit: Math.min(LOG_PAGE_LIMIT, MAX_DIRECTORY_SESSIONS - sessions.length),
      });
      for (const entry of page.entries) {
        if (sessions.some((session) => session.sessionId === entry.sessionId)) {
          throw new Error('Web Directory Session pagination repeated an identity.');
        }
        const displayName = projectRuntimeClientText(entry.name || entry.sessionId, 160).trim();
        const status = source.status(entry.sessionId);
        assertStatus(status);
        sessions.push({
          sessionId: entry.sessionId,
          displayName: displayName || entry.sessionId,
          updatedAt: entry.updatedAt,
          lastSequence: entry.lastSequence,
          status,
        });
        if (sessions.length === MAX_DIRECTORY_SESSIONS) break;
      }
      if (!page.hasMore || sessions.length === MAX_DIRECTORY_SESSIONS) break;
      const next = page.nextCursor;
      if (
        next === undefined ||
        (cursor !== undefined &&
          (next.updatedAt > cursor.updatedAt ||
            (next.updatedAt === cursor.updatedAt && next.sessionId >= cursor.sessionId)))
      ) {
        throw new Error('Web Directory Session pagination did not advance.');
      }
      cursor = next;
    }
    return Object.freeze({
      workspaceId: source.workspaceId,
      label: source.label,
      sessions: Object.freeze(sessions),
    });
  } finally {
    if (typeof source.logs === 'function') reader.close();
  }
}

function assertWorkspaceIdentity(workspaceId: string, label: string): void {
  if (
    !safeText(workspaceId) ||
    !safeText(label) ||
    label.startsWith('/') ||
    label.includes('\\') ||
    /^[A-Za-z]:/u.test(label)
  ) {
    throw new TypeError('Web Directory Workspace identity is invalid or path-like.');
  }
}

function assertStatus(value: WebSessionStatus): void {
  if (
    value !== 'idle' &&
    value !== 'running' &&
    value !== 'waiting' &&
    value !== 'completed' &&
    value !== 'cancelled' &&
    value !== 'failed' &&
    value !== 'unavailable'
  ) {
    throw new TypeError('Web Directory Session status is invalid.');
  }
}

function safeText(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/\p{Cc}/u.test(value);
}
