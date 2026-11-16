import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentError, type AgentRuntime } from '@kite-ai/agent';
import type { Json, ToolContext } from '@kite-ai/agent/extensions';
import { inspectWorktreeExecutionRoot } from '@kite-ai/agent/shell';
import type { SessionExecutionRoot } from '@kite-ai/agent/storage';

const object = (value: unknown): Record<string, Json> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : null;

export async function inspectExecutionRoot(uri: string) {
  const url = new URL(uri);
  if (
    url.protocol !== 'file:' ||
    url.search ||
    url.hash ||
    (url.hostname && url.hostname !== 'localhost')
  )
    throw new AgentError('execution_root_unavailable');
  const lexical = fileURLToPath(url);
  const before = await lstat(lexical, { bigint: true });
  const root = await realpath(lexical);
  const after = await lstat(root, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  )
    throw new AgentError('execution_root_changed');
  return {
    root,
    rootUri: pathToFileURL(root).href,
    identity: { dev: String(after.dev), ino: String(after.ino) },
  };
}

/** Session selection and physical identity are one observation, never two independent path reads. */
export async function resolveSessionExecutionRoot(
  runtime: AgentRuntime,
  input: {
    sessionId: string;
    executionId?: string;
    epoch?: string;
    requireCurrent?: boolean;
  },
) {
  const current = await runtime.getSessionExecutionRoot({ sessionId: input.sessionId });
  let selected =
    input.epoch === undefined
      ? current
      : await runtime.getSessionExecutionRoot({ sessionId: input.sessionId, epoch: input.epoch });
  let sealedIdentity: Record<string, Json> | null = null;
  if (input.executionId) {
    const execution = await runtime.getExecution(input.executionId);
    if (!execution || execution.sessionId !== input.sessionId)
      throw new AgentError('execution_root_scope_mismatch');
    const root = object(object(execution.decisionSource)?.executionRoot);
    if (root) {
      if (
        root.sessionId !== input.sessionId ||
        root.workspaceId !== current.workspaceId ||
        typeof root.epoch !== 'string' ||
        typeof root.effectiveRootUri !== 'string'
      )
        throw new AgentError('execution_root_scope_mismatch');
      sealedIdentity = object(root.identity);
      selected = await runtime.getSessionExecutionRoot({
        sessionId: input.sessionId,
        epoch: root.epoch,
      });
      if (selected.effectiveRootUri !== root.effectiveRootUri)
        throw new AgentError('execution_root_changed');
    }
  }
  if (input.requireCurrent !== false && selected.epoch !== current.epoch)
    throw new AgentError('execution_root_changed');
  const physical = await inspectExecutionRoot(selected.effectiveRootUri);
  if (
    selected.identity &&
    (selected.identity.dev !== physical.identity.dev ||
      selected.identity.ino !== physical.identity.ino)
  )
    throw new AgentError('execution_root_changed');
  if (
    sealedIdentity &&
    (sealedIdentity.dev !== physical.identity.dev || sealedIdentity.ino !== physical.identity.ino)
  )
    throw new AgentError('execution_root_changed');
  const latest = await runtime.getSessionExecutionRoot({ sessionId: input.sessionId });
  if (input.requireCurrent !== false && latest.epoch !== current.epoch)
    throw new AgentError('execution_root_changed');
  const binding: SessionExecutionRoot = { ...selected, identity: physical.identity };
  const revision = createHash('sha256')
    .update(
      JSON.stringify({
        sessionId: binding.sessionId,
        workspaceId: binding.workspaceId,
        epoch: binding.epoch,
        root: physical.root,
        identity: physical.identity,
      }),
    )
    .digest('hex');
  return { binding, root: physical.root, revision };
}

export async function inspectWorktreeRootSelection(
  runtime: AgentRuntime,
  request: { action: 'use'; path: string } | { action: 'exit' },
  scope: { sessionId: string; executionId: string },
  sourceCwd: string,
) {
  const selected = await resolveSessionExecutionRoot(runtime, scope);
  if ((await realpath(sourceCwd)) !== selected.root) throw new AgentError('execution_root_changed');
  const workspace = await runtime.getWorkspace(selected.binding.workspaceId);
  if (!workspace) throw new AgentError('workspace_not_found');
  let target: Awaited<ReturnType<typeof inspectExecutionRoot>>;
  if (request.action === 'exit') target = await inspectExecutionRoot(workspace.rootUri);
  else {
    const verified = inspectWorktreeExecutionRoot(selected.root, request.path);
    target = await inspectExecutionRoot(pathToFileURL(verified.path).href);
    if (
      target.identity.dev !== verified.identity.dev ||
      target.identity.ino !== verified.identity.ino
    )
      throw new AgentError('execution_root_changed');
  }
  return {
    source: selected.binding,
    target: { ...target, rootUri: request.action === 'exit' ? workspace.rootUri : target.rootUri },
  };
}

export async function prepareWorktreeExecutionRoot(
  runtime: AgentRuntime,
  request: { action: 'use'; path: string } | { action: 'exit' },
  context: ToolContext,
  sourceCwd: string,
  approvedSelection: Awaited<ReturnType<typeof inspectWorktreeRootSelection>>,
): Promise<Json> {
  const [session, actual, metadata] = await Promise.all([
    runtime.getSession(context.sessionId),
    runtime.getExecution(context.executionId),
    runtime.getMetadata(),
  ]);
  if (
    !session ||
    !actual ||
    actual.sessionId !== session.id ||
    actual.kind !== 'tool' ||
    actual.definitionId !== 'git.worktree' ||
    actual.definitionVersion !== '1' ||
    actual.originStoreId !== metadata.storeId
  )
    throw new AgentError('execution_root_scope_mismatch');
  const ownerSession = await runtime.getSession(session.rootSessionId);
  if (!ownerSession?.ownerInstanceId) throw new AgentError('owner_changed');
  const selection = await inspectWorktreeRootSelection(runtime, request, context, sourceCwd);
  if (JSON.stringify(selection) !== JSON.stringify(approvedSelection))
    throw new AgentError('execution_root_changed');
  const { source, target } = selection;
  context.signal.throwIfAborted();
  const result = await runtime.prepareSessionExecutionRoot({
    expectedStoreId: metadata.storeId,
    owner: {
      sessionId: ownerSession.id,
      instanceId: ownerSession.ownerInstanceId,
      generation: ownerSession.ownerGeneration,
    },
    sessionId: session.id,
    executionId: actual.id,
    expectedEpoch: source.epoch,
    action: request.action,
    source: { rootUri: source.effectiveRootUri, identity: source.identity! },
    target: {
      rootUri: target.rootUri,
      identity: target.identity,
      ...(request.action === 'use' ? { requestedPath: request.path } : {}),
    },
  });
  context.signal.throwIfAborted();
  return result as unknown as Json;
}
