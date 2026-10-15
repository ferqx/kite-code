import { fileURLToPath } from 'node:url';
import type { AuthorizationRequest } from '../extensions';
import type { AgentRuntime } from '../runtime';
import type { Json } from '../storage';
import type { AutoReviewContext } from './index';

type ReviewRuntime = Pick<
  AgentRuntime,
  | 'getExecution'
  | 'getRun'
  | 'getCommand'
  | 'getSession'
  | 'getWorkspace'
  | 'getView'
  | 'readRunExtensionRecord'
>;
const object = (value: Json | undefined): Record<string, Json> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const content = (value: Json): string | null => {
  const request = object(value);
  if (typeof request?.content === 'string') return request.content;
  const child = request?.kind === 'child.start' ? object(request.input) : null;
  return typeof child?.content === 'string' ? child.content : null;
};

/** Saved review material is untrusted evidence, never a grant or a dispatch instruction. */
export function createPermissionReviewContextReader(options: {
  readonly readRuntime: () => ReviewRuntime | null;
  readonly subjectId: string;
  readonly originStoreId: string;
}): (request: AuthorizationRequest) => Promise<AutoReviewContext> {
  return async (request) => {
    const signal = request.signal;
    const read = async <T>(operation: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted();
      const result = await operation();
      signal.throwIfAborted();
      return result;
    };
    const unknown = (reason: string): AutoReviewContext => ({
      task: { availability: 'unknown', reason, trustedAsAuthority: false },
      plan: null,
      rejectionReasons: [],
    });
    signal.throwIfAborted();
    const runtime = options.readRuntime();
    if (!runtime || !request.runId) return unknown('review_run_unavailable');
    const execution = await read(() => runtime.getExecution(request.executionId));
    const run = await read(() => runtime.getRun(request.runId!));
    if (
      !execution ||
      !run ||
      execution.id !== request.executionId ||
      execution.sessionId !== request.sessionId ||
      run.sessionId !== request.sessionId ||
      execution.runId !== run.id ||
      execution.originStoreId !== options.originStoreId ||
      run.originStoreId !== options.originStoreId ||
      execution.originCommandId !== run.originCommandId ||
      execution.rootWorkCommandId !== run.rootWorkCommandId ||
      execution.rootWorkSeq !== run.rootWorkSeq ||
      execution.kind !== request.kind ||
      execution.definitionId !== request.definitionId ||
      execution.definitionVersion !== request.definitionVersion
    )
      return unknown('review_scope_unavailable');
    const command = await read(() => runtime.getCommand(run.originCommandId));
    const session = await read(() => runtime.getSession(request.sessionId));
    if (
      !command ||
      !session ||
      session.deletedAt !== null ||
      command.subjectId !== options.subjectId ||
      command.sessionId !== session.id ||
      command.originStoreId !== options.originStoreId ||
      command.rootWorkCommandId !== run.rootWorkCommandId ||
      command.rootWorkSeq !== run.rootWorkSeq
    )
      return unknown('review_scope_unavailable');
    const workspace = await read(() => runtime.getWorkspace(session.workspaceId));
    if (!workspace || workspace.id !== session.workspaceId)
      return unknown('review_workspace_unavailable');
    let workspaceRoot: string;
    try {
      workspaceRoot = fileURLToPath(workspace.rootUri);
    } catch {
      return unknown('review_workspace_unavailable');
    }
    const root = await read(() => runtime.getCommand(run.rootWorkCommandId));
    if (
      !root ||
      root.subjectId !== options.subjectId ||
      root.originStoreId !== options.originStoreId ||
      root.rootWorkCommandId !== run.rootWorkCommandId ||
      root.rootWorkSeq !== run.rootWorkSeq ||
      root.sessionId !== session.rootSessionId
    )
      return unknown('review_root_task_unavailable');
    const rootSession = await read(() => runtime.getSession(root.sessionId));
    if (
      !rootSession ||
      rootSession.workspaceId !== session.workspaceId ||
      rootSession.rootSessionId !== session.rootSessionId ||
      rootSession.deletedAt !== null
    )
      return unknown('review_root_task_unavailable');
    const isChild = session.parentSessionId !== null;
    const frozen = object(object(run.configuration)?.snapshot);
    const role =
      isChild && typeof frozen?.roleId === 'string' && typeof frozen.roleVersion === 'string'
        ? { id: frozen.roleId, version: frozen.roleVersion }
        : null;
    const task: Record<string, Json> = {
      availability: 'available',
      trustedAsAuthority: false,
      workspaceRoot,
      // Own review/human waits change progress; Core separately enforces
      // active/cancel/fencing. Bind this material to stable Run identity.
      currentRun: { id: run.id },
      isChild,
      role,
      roleAvailability: isChild ? (role ? 'available' : 'unknown') : 'not_applicable',
      content: content(command.request),
      parentUserTask: isChild ? content(root.request) : null,
      rootUserTask: content(root.request),
    };
    let plan: Json | null = null;
    task.planAvailability = 'not_selected';
    // The existing readonly Run port enforces selected Extension and current Store.
    if (
      object(run.configuration)?.extensions &&
      Array.isArray(object(run.configuration)?.extensions) &&
      (object(run.configuration)!.extensions as Json[]).some(
        (entry) => object(entry)?.id === 'builtin.planning',
      )
    ) {
      task.planAvailability = 'absent';
      const pointer = await read(() =>
        runtime.readRunExtensionRecord({
          sessionId: session.id,
          runId: run.id,
          extensionId: 'builtin.planning',
          key: 'plan.current',
        }),
      );
      const key = object(pointer?.value)?.key;
      if (pointer) task.planAvailability = 'unknown';
      if (
        pointer &&
        pointer.originStoreId === options.originStoreId &&
        pointer.contentType === 'builtin.planning.record' &&
        pointer.contentVersion === 1 &&
        typeof key === 'string'
      ) {
        const saved = await read(() =>
          runtime.readRunExtensionRecord({
            sessionId: session.id,
            runId: run.id,
            extensionId: 'builtin.planning',
            key,
          }),
        );
        if (
          saved &&
          saved.originStoreId === options.originStoreId &&
          saved.contentType === 'builtin.planning.record' &&
          saved.contentVersion === 1
        ) {
          plan = structuredClone(saved.value);
          task.planAvailability = 'available';
        }
      }
    }
    const view = await read(() => runtime.getView(session.id));
    const rejectionReasons: string[] = [];
    if (view.storeId === options.originStoreId && view.session.id === session.id) {
      for (const saved of view.executions) {
        if (
          // A target's new review result cannot become input to its own
          // frozen review. Other scoped executions remain relevant evidence.
          saved.id === request.executionId ||
          saved.sessionId !== session.id ||
          saved.runId !== run.id ||
          saved.originStoreId !== options.originStoreId ||
          saved.originCommandId !== command.id ||
          saved.rootWorkCommandId !== run.rootWorkCommandId ||
          saved.rootWorkSeq !== run.rootWorkSeq
        )
          continue;
        const review = saved.authorization?.review;
        if (review?.decision === 'reject' && review.reason) rejectionReasons.push(review.reason);
      }
    }
    task.rejectionReasonsAvailability =
      view.storeId === options.originStoreId && view.session.id === session.id
        ? rejectionReasons.length
          ? 'available'
          : 'absent'
        : 'unknown';
    signal.throwIfAborted();
    return { task, plan, rejectionReasons: [...new Set(rejectionReasons)] };
  };
}
