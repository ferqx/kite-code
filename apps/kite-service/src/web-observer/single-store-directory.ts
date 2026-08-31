import type { WebSessionStatus } from '@kite-ai/kite-app-contract';
import { projectRuntimeClientText } from '../runtime-client/safe-text';
import type { WebObserverDirectoryPort } from './core';

export interface SingleStoreDirectorySession {
  readonly sessionId: string;
  readonly name: string;
  readonly updatedAt: number;
  readonly lastSequence: number;
}

export interface SingleStoreDirectoryWorkspace {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly sessions: readonly SingleStoreDirectorySession[];
}

export interface SingleStoreDirectoryQueryPort {
  list():
    | readonly SingleStoreDirectoryWorkspace[]
    | Promise<readonly SingleStoreDirectoryWorkspace[]>;
}

export interface SingleStoreWebObserverDirectoryOptions {
  readonly query: SingleStoreDirectoryQueryPort;
  /** In-process Runtime status lookup; unavailable is projected on lookup failure. */
  readonly status: (
    workspaceId: string,
    sessionId: string,
  ) => WebSessionStatus | Promise<WebSessionStatus>;
}

/** Project the single Store query into the existing path-free Browser Directory contract. */
export function createSingleStoreWebObserverDirectoryPort(
  options: SingleStoreWebObserverDirectoryOptions,
): WebObserverDirectoryPort {
  return Object.freeze({
    list: async () => {
      const workspaces = await options.query.list();
      return Promise.all(
        workspaces.map(async (workspace) => {
          assertSafeIdentity(workspace.workspaceId, 'Workspace identity');
          const label = safeLabel(workspace.displayName, workspace.workspaceId);
          const sessions = await Promise.all(
            workspace.sessions.map(async (session) => {
              assertSafeIdentity(session.sessionId, 'Session identity');
              let status: WebSessionStatus = 'unavailable';
              try {
                status = await options.status(workspace.workspaceId, session.sessionId);
                assertStatus(status);
              } catch {
                status = 'unavailable';
              }
              const displayName = projectRuntimeClientText(session.name, 160).trim();
              return Object.freeze({
                sessionId: session.sessionId,
                displayName: displayName || 'Untitled session',
                updatedAt: session.updatedAt,
                lastSequence: session.lastSequence,
                status,
              });
            }),
          );
          return Object.freeze({
            workspaceId: workspace.workspaceId,
            label,
            sessions: Object.freeze(sessions),
          });
        }),
      );
    },
  });
}

function safeLabel(value: string, workspaceId: string): string {
  const label = projectRuntimeClientText(value, 160).trim();
  if (
    label.length === 0 ||
    label.startsWith('/') ||
    label.includes('\\') ||
    /^[A-Za-z]:/u.test(label)
  ) {
    return `Workspace ${workspaceId.slice(-8)}`;
  }
  return label;
}

function assertSafeIdentity(value: string, label: string): void {
  if (value.length === 0 || value.length > 256 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
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
