import type { SessionDeps, SessionManager } from '#app/runtime/session';

/** Client-facing SessionManager surface projected by the Runtime Host bridge. */
export type TuiSessionManager = Omit<SessionManager, 'abortAll' | 'dispose' | 'removeRuntime'> & {
  abortAll(): Promise<void>;
  dispose(): Promise<void>;
  removeRuntime(sessionId: string): Promise<void>;
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
>;

export type TuiSessionManagerFactory = (
  dependencies: TuiSessionManagerDependencies,
) => TuiSessionManager;
