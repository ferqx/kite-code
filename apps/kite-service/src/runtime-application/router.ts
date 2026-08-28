import type {
  RuntimeCommand,
  RuntimeNotification,
  RuntimeQuery,
  RuntimeQueryResult,
} from '@kite-ai/runtime-contract';
import type {
  RuntimeHostCommandInspection,
  RuntimeHostCommandInspectionContext,
  RuntimeHostExecutionBridge,
} from '@kite-ai/runtime-host';
import type { AdmittedWorkspace, RuntimeWorkspaceAdmission } from './admission';
import type { RuntimeWorkspaceContext, RuntimeWorkspaceContextFactory } from './context';

export type RuntimeExecutionBridgeRouterErrorCode =
  | 'workspace_context_unavailable'
  | 'workspace_admission_unavailable'
  | 'runtime_bridge_closed';

export class RuntimeExecutionBridgeRouterError extends Error {
  readonly code: RuntimeExecutionBridgeRouterErrorCode;

  constructor(code: RuntimeExecutionBridgeRouterErrorCode, message: string) {
    super(message);
    this.name = 'RuntimeExecutionBridgeRouterError';
    this.code = code;
  }
}

export interface RuntimeExecutionBridgeRouterDependencies {
  readonly contexts: RuntimeWorkspaceContextFactory;
  readonly admission?: RuntimeWorkspaceAdmission;
  /** Process-wide list query remains an injected Runtime owner; no second Host is created here. */
  readonly queryWithoutSession?: (query: RuntimeQuery) => Promise<RuntimeQueryResult>;
}

export interface RuntimeExecutionBridgeRouter extends RuntimeHostExecutionBridge {
  bindSession(sessionId: string, admission: AdmittedWorkspace): Promise<void>;
  releaseSession(sessionId: string): Promise<void>;
}

function sessionIdFromQuery(query: RuntimeQuery): string | undefined {
  return query.type === 'list_sessions' ? undefined : query.sessionId;
}

function isCreateCommand(
  command: RuntimeCommand,
): command is Extract<RuntimeCommand, { type: 'create_session' }> {
  return command.type === 'create_session';
}

function isForkCommand(
  command: RuntimeCommand,
): command is Extract<RuntimeCommand, { type: 'fork_session' }> {
  return command.type === 'fork_session';
}

function sameWorkspace(left: RuntimeWorkspaceContext, right: RuntimeWorkspaceContext): boolean {
  return (
    left.admission.canonicalPath === right.admission.canonicalPath &&
    left.admission.projectId === right.admission.projectId &&
    left.admission.workspaceDigest === right.admission.workspaceDigest
  );
}

function contextMatchesAdmission(
  context: RuntimeWorkspaceContext,
  admission: AdmittedWorkspace,
): boolean {
  return (
    context.admission.canonicalPath === admission.canonicalPath &&
    context.admission.projectId === admission.projectId &&
    context.admission.workspaceDigest === admission.workspaceDigest
  );
}

export function createRuntimeExecutionBridgeRouter(
  dependencies: RuntimeExecutionBridgeRouterDependencies,
): RuntimeExecutionBridgeRouter {
  const localContexts = new Map<string, RuntimeWorkspaceContext>();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) {
      throw new RuntimeExecutionBridgeRouterError(
        'runtime_bridge_closed',
        'Runtime execution bridge router is closed.',
      );
    }
  };

  const contextForSession = async (sessionId: string): Promise<RuntimeWorkspaceContext> => {
    assertOpen();
    const local = localContexts.get(sessionId);
    if (local) return local;
    let context: RuntimeWorkspaceContext | undefined;
    try {
      context = await dependencies.contexts.resolveForSession(sessionId);
    } catch (error) {
      if (closed) {
        throw new RuntimeExecutionBridgeRouterError(
          'runtime_bridge_closed',
          'Runtime execution bridge router is closed.',
        );
      }
      throw error;
    }
    assertOpen();
    if (!context) {
      throw new RuntimeExecutionBridgeRouterError(
        'workspace_context_unavailable',
        `No admitted Workspace context is available for Session ${sessionId}.`,
      );
    }
    localContexts.set(sessionId, context);
    return context;
  };

  const bindSession = async (sessionId: string, admission: AdmittedWorkspace): Promise<void> => {
    assertOpen();
    const binder = dependencies.contexts.bindSession;
    let context: RuntimeWorkspaceContext;
    try {
      context = binder
        ? await binder(sessionId, admission)
        : await dependencies.contexts.create(admission);
    } catch (error) {
      if (closed) {
        throw new RuntimeExecutionBridgeRouterError(
          'runtime_bridge_closed',
          'Runtime execution bridge router is closed.',
        );
      }
      throw error;
    }
    assertOpen();
    localContexts.set(sessionId, context);
  };

  const ensureCommandContext = async (
    command: RuntimeCommand,
    targetSessionId: string,
  ): Promise<RuntimeWorkspaceContext> => {
    assertOpen();
    const assertCreateMatches = async (context: RuntimeWorkspaceContext): Promise<void> => {
      if (!isCreateCommand(command)) return;
      if (!dependencies.admission) {
        throw new RuntimeExecutionBridgeRouterError(
          'workspace_admission_unavailable',
          'Create command requires an injected Workspace admission resolver.',
        );
      }
      const admission = await dependencies.admission.admitForCreate(command.workspace);
      assertOpen();
      if (!contextMatchesAdmission(context, admission)) {
        throw new RuntimeExecutionBridgeRouterError(
          'workspace_context_unavailable',
          'Create target is already bound to a different Workspace.',
        );
      }
    };
    const existing = localContexts.get(targetSessionId);
    if (existing) {
      await assertCreateMatches(existing);
      if (isForkCommand(command)) {
        const source = await contextForSession(command.sourceSessionId);
        if (!sameWorkspace(existing, source)) {
          throw new RuntimeExecutionBridgeRouterError(
            'workspace_context_unavailable',
            'Fork target is already bound to a different Workspace.',
          );
        }
      }
      return existing;
    }
    let persisted: RuntimeWorkspaceContext | undefined;
    try {
      persisted = await dependencies.contexts.resolveForSession(targetSessionId);
    } catch (error) {
      if (closed) {
        throw new RuntimeExecutionBridgeRouterError(
          'runtime_bridge_closed',
          'Runtime execution bridge router is closed.',
        );
      }
      throw error;
    }
    assertOpen();
    if (persisted) {
      await assertCreateMatches(persisted);
      if (isForkCommand(command)) {
        const source = await contextForSession(command.sourceSessionId);
        if (!sameWorkspace(persisted, source)) {
          throw new RuntimeExecutionBridgeRouterError(
            'workspace_context_unavailable',
            'Fork target is already bound to a different Workspace.',
          );
        }
      }
      localContexts.set(targetSessionId, persisted);
      return persisted;
    }
    if (isCreateCommand(command)) {
      if (!dependencies.admission) {
        throw new RuntimeExecutionBridgeRouterError(
          'workspace_admission_unavailable',
          'Create command requires an injected Workspace admission resolver.',
        );
      }
      const admission = await dependencies.admission.admitForCreate(command.workspace);
      assertOpen();
      await bindSession(targetSessionId, admission);
      return contextForSession(targetSessionId);
    }
    if (isForkCommand(command)) {
      const source = await contextForSession(command.sourceSessionId);
      await bindSession(targetSessionId, source.admission);
      return contextForSession(targetSessionId);
    }
    return contextForSession(targetSessionId);
  };

  const bridge: RuntimeExecutionBridgeRouter = {
    async recoverSession(
      sessionId: string,
      publish: (notification: RuntimeNotification) => void,
    ): Promise<void> {
      const context = await contextForSession(sessionId);
      assertOpen();
      await context.bridge.recoverSession(sessionId, publish);
    },

    async inspectCommand(
      command: RuntimeCommand,
      context: RuntimeHostCommandInspectionContext,
    ): Promise<RuntimeHostCommandInspection> {
      const workspace = await ensureCommandContext(command, context.targetSessionId);
      assertOpen();
      return workspace.bridge.inspectCommand(command, context);
    },

    async query(query: RuntimeQuery): Promise<RuntimeQueryResult> {
      const sessionId = sessionIdFromQuery(query);
      if (sessionId === undefined) {
        if (dependencies.queryWithoutSession) return dependencies.queryWithoutSession(query);
        return {
          status: 'unavailable',
          queryType: query.type,
          code: 'session_unavailable',
        };
      }
      const context = await contextForSession(sessionId);
      assertOpen();
      return context.bridge.query(query);
    },

    async shutdownSession(
      sessionId: string,
      reason: string,
      publish: (notification: RuntimeNotification) => void,
    ): Promise<void> {
      const context = await contextForSession(sessionId);
      assertOpen();
      await context.bridge.shutdownSession(sessionId, reason, publish);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      localContexts.clear();
      if (dependencies.contexts.close) await dependencies.contexts.close();
    },

    async bindSession(sessionId: string, admission: AdmittedWorkspace): Promise<void> {
      await bindSession(sessionId, admission);
    },

    async releaseSession(sessionId: string): Promise<void> {
      localContexts.delete(sessionId);
      if (dependencies.contexts.releaseSession)
        await dependencies.contexts.releaseSession(sessionId);
    },
  };
  return Object.freeze(bridge);
}
