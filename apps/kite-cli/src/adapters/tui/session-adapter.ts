import type {
  RuntimeCheckpointProjection,
  RuntimeCommandReceipt,
  RuntimeRewindPreviewProjection,
  RuntimeSessionProjection,
} from '@kite-ai/runtime-contract';
import type { SessionDeps, SessionManager } from '#kite-cli/runtime/session';

/** Client-facing SessionManager surface projected by the Runtime Host bridge. */
export type TuiSessionManager = Omit<
  SessionManager,
  | 'abortAll'
  | 'dispose'
  | 'removeRuntime'
  | 'clearSessionCommandGrants'
  | 'listSessionCommandGrants'
  | 'listRewindCheckpoints'
  | 'previewRewind'
  | 'isRewindCheckpointAvailable'
> & {
  abortAll(): Promise<void>;
  dispose(): Promise<void>;
  removeRuntime(sessionId: string): Promise<void>;
  /** Host-owned durable delete; the App client has no direct Store mutation fallback. */
  deletePersistedSession(sessionId: string): Promise<void>;
  /** Wait for Host resume admission, restart cleanup and durable recovery. */
  waitForSessionReady(sessionId: string): Promise<void>;
  /** Closed receipt-bearing grant mutation; no coordinator or event-batch access leaks to TUI. */
  clearSessionCommandGrants(sessionId: string): Promise<RuntimeCommandReceipt>;
  /** Closed Runtime query projections; Store access remains in the App execution bridge. */
  listRewindCheckpoints(sessionId: string): Promise<readonly RuntimeCheckpointProjection[]>;
  previewRewind(
    sessionId: string,
    checkpointId: string,
  ): Promise<RuntimeRewindPreviewProjection | null>;
  getSessionProjection(sessionId: string): Promise<RuntimeSessionProjection | null>;
};

export type TuiSessionManagerDependencies = Omit<
  SessionDeps,
  | 'openStateRuntimeStorage'
  | 'tokenStatsStorage'
  | 'capabilityExecution'
  | 'modelInvocationRuntimeFactory'
  | 'resolveRecoveryIdentity'
  | 'allocateRecoveryIdentity'
  | 'builtinToolCatalog'
> & {
  /** Canonical TUI workspace admitted by the Runtime Server. */
  readonly workspace: string;
};

export type TuiSessionManagerFactory = (
  dependencies: TuiSessionManagerDependencies,
) => TuiSessionManager;
