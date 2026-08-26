import type { RuntimeHostExecutionBridge } from '@kite-ai/runtime-host';
import { type AdmittedWorkspace, freezeAdmittedWorkspace } from './admission';

/** Per-Workspace execution seam. It contains no Store, Host, Server, or UI manager. */
export interface RuntimeWorkspaceContext {
  readonly admission: AdmittedWorkspace;
  readonly bridge: RuntimeHostExecutionBridge;
  close(): Promise<void>;
}

export interface RuntimeWorkspaceContextFactory {
  create(admission: AdmittedWorkspace): Promise<RuntimeWorkspaceContext>;
  resolveForSession(sessionId: string): Promise<RuntimeWorkspaceContext | undefined>;
  readonly bindSession?: (
    sessionId: string,
    admission: AdmittedWorkspace,
  ) => Promise<RuntimeWorkspaceContext>;
  readonly releaseSession?: (sessionId: string) => Promise<void>;
  readonly close?: () => Promise<void>;
}

export interface RuntimeWorkspaceContextFactoryDependencies {
  /** Creates one context with dependencies scoped to exactly this canonical Workspace. */
  readonly create: (admission: AdmittedWorkspace) => Promise<RuntimeWorkspaceContext>;
  /** Resolves persisted Session identity; no client path may be used as a substitute. */
  readonly resolveWorkspaceForSession: (
    sessionId: string,
  ) => Promise<AdmittedWorkspace | undefined>;
}

interface PendingSessionBinding {
  readonly key: string;
  readonly promise: Promise<RuntimeWorkspaceContext>;
}

interface PendingWorkspaceCreation {
  readonly admission: AdmittedWorkspace;
  readonly promise: Promise<RuntimeWorkspaceContext>;
}

export class RuntimeWorkspaceContextError extends Error {
  readonly code: 'workspace_context_identity_mismatch' | 'workspace_context_closed';

  constructor(code: RuntimeWorkspaceContextError['code'], message: string) {
    super(message);
    this.name = 'RuntimeWorkspaceContextError';
    this.code = code;
  }
}

function workspaceKey(admission: AdmittedWorkspace): string {
  return admission.workspaceDigest;
}

function sameWorkspace(left: AdmittedWorkspace, right: AdmittedWorkspace): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.projectId === right.projectId &&
    left.workspaceDigest === right.workspaceDigest
  );
}

/**
 * Caches one injected context per canonical Workspace and binds Session identities to that
 * context. Contexts are never selected by process.cwd() or a mutable current-Workspace value.
 */
export function createRuntimeWorkspaceContextFactory(
  dependencies: RuntimeWorkspaceContextFactoryDependencies,
): RuntimeWorkspaceContextFactory {
  const contexts = new Map<string, RuntimeWorkspaceContext>();
  const pendingCreates = new Map<string, PendingWorkspaceCreation>();
  const pendingBinds = new Map<string, PendingSessionBinding>();
  const sessions = new Map<string, string>();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const create = async (input: AdmittedWorkspace): Promise<RuntimeWorkspaceContext> => {
    if (closed)
      throw new RuntimeWorkspaceContextError(
        'workspace_context_closed',
        'Workspace contexts are closed.',
      );
    const admission = freezeAdmittedWorkspace(input);
    const key = workspaceKey(admission);
    const current = contexts.get(key);
    if (current) {
      if (!sameWorkspace(current.admission, admission)) {
        throw new RuntimeWorkspaceContextError(
          'workspace_context_identity_mismatch',
          'One Workspace digest resolved to conflicting canonical identity facts.',
        );
      }
      return current;
    }
    const pending = pendingCreates.get(key);
    if (pending) {
      if (!sameWorkspace(pending.admission, admission)) {
        throw new RuntimeWorkspaceContextError(
          'workspace_context_identity_mismatch',
          'One Workspace digest is being created with conflicting canonical identity facts.',
        );
      }
      return pending.promise;
    }
    const creation = (async (): Promise<RuntimeWorkspaceContext> => {
      const created = await dependencies.create(admission);
      if (!sameWorkspace(created.admission, admission)) {
        await created.close().catch(() => undefined);
        throw new RuntimeWorkspaceContextError(
          'workspace_context_identity_mismatch',
          'Workspace context returned identity facts different from admission.',
        );
      }
      if (closed) {
        await created.close().catch(() => undefined);
        throw new RuntimeWorkspaceContextError(
          'workspace_context_closed',
          'Workspace contexts are closed.',
        );
      }
      const context = Object.freeze({
        ...created,
        admission,
      });
      contexts.set(key, context);
      return context;
    })();
    pendingCreates.set(key, { admission, promise: creation });
    try {
      return await creation;
    } finally {
      if (pendingCreates.get(key)?.promise === creation) pendingCreates.delete(key);
    }
  };

  const bindSession = async (
    sessionId: string,
    admission: AdmittedWorkspace,
  ): Promise<RuntimeWorkspaceContext> => {
    if (sessionId.length === 0) throw new TypeError('Session identity must not be empty.');
    if (closed)
      throw new RuntimeWorkspaceContextError(
        'workspace_context_closed',
        'Workspace contexts are closed.',
      );
    const normalized = freezeAdmittedWorkspace(admission);
    const key = workspaceKey(normalized);
    const existing = sessions.get(sessionId);
    if (existing !== undefined && existing !== key) {
      throw new RuntimeWorkspaceContextError(
        'workspace_context_identity_mismatch',
        'Session identity is already bound to a different Workspace.',
      );
    }
    const pending = pendingBinds.get(sessionId);
    if (pending) {
      if (pending.key !== key) {
        throw new RuntimeWorkspaceContextError(
          'workspace_context_identity_mismatch',
          'Session identity is already being bound to a different Workspace.',
        );
      }
      return pending.promise;
    }
    const binding = (async (): Promise<RuntimeWorkspaceContext> => {
      const context = await create(normalized);
      if (closed) {
        throw new RuntimeWorkspaceContextError(
          'workspace_context_closed',
          'Workspace contexts are closed.',
        );
      }
      sessions.set(sessionId, workspaceKey(context.admission));
      return context;
    })();
    pendingBinds.set(sessionId, { key, promise: binding });
    try {
      return await binding;
    } finally {
      if (pendingBinds.get(sessionId)?.promise === binding) pendingBinds.delete(sessionId);
    }
  };

  const resolveForSession = async (
    sessionId: string,
  ): Promise<RuntimeWorkspaceContext | undefined> => {
    if (closed) return undefined;
    const key = sessions.get(sessionId);
    if (key !== undefined) return contexts.get(key);
    const admission = await dependencies.resolveWorkspaceForSession(sessionId);
    if (admission === undefined) return undefined;
    return bindSession(sessionId, admission);
  };

  const releaseSession = async (sessionId: string): Promise<void> => {
    sessions.delete(sessionId);
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    sessions.clear();
    pendingBinds.clear();
    const current = [...contexts.values()];
    contexts.clear();
    const pending = [...pendingCreates.values()].map(({ promise }) => promise);
    closePromise = (async () => {
      const results = await Promise.allSettled(current.map((context) => context.close()));
      // Pending creations observe `closed`, close any late-created context, and reject their
      // callers.  That rejection is expected shutdown cancellation, not a factory close error.
      await Promise.allSettled(pending);
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (failure) throw failure.reason;
    })();
    return closePromise;
  };

  return Object.freeze({
    create,
    resolveForSession,
    bindSession,
    releaseSession,
    close,
  });
}
