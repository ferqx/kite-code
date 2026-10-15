import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { type AgentClient, ClientError } from '@kite-ai/client';

/** An unavailable physical root does not erase the saved Session or grant execution authority. */
export function createTuiWorkspaceObserver(
  source: AgentClient,
  expected:
    | { storeId: string; sessionId: string; workspaceId: string; rootUri: string }
    | undefined,
) {
  let active = false;
  async function read(workspaceId: string, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (!expected || workspaceId !== expected.workspaceId) return false;
    const [view, workspace] = await Promise.all([
      source.getView(expected.sessionId, { signal }),
      source.getWorkspace(expected.workspaceId, { signal }),
    ]);
    if (
      view.storeId !== expected.storeId ||
      view.session.id !== expected.sessionId ||
      view.session.workspaceId !== expected.workspaceId ||
      view.session.deletedAt !== null ||
      workspace.id !== expected.workspaceId ||
      workspace.rootUri !== expected.rootUri
    )
      throw new ClientError('workspace_identity_mismatch');
    const uri = new URL(workspace.rootUri);
    if (uri.protocol !== 'file:' || (uri.hostname && uri.hostname !== 'localhost')) return false;
    try {
      await lstat(fileURLToPath(uri));
      return active;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // An unrelated broken profile remains an error; missing project configuration is not readiness.
    const settings = await source.getModelSettings('user', { storeId: expected.storeId, signal });
    if (
      settings.storeId !== expected.storeId ||
      settings.scope !== 'user' ||
      settings.errors.length ||
      !settings.readSet
    )
      throw new ClientError('configuration_unavailable');
    signal?.throwIfAborted();
    active = true;
    return true;
  }
  // Positive public read-method list: newly added API methods cannot silently gain observer writes.
  const reads = new Set([
    'getConfiguration',
    'getHostMutation',
    'getModelSettings',
    'getProviderSettings',
    'getPermissionMode',
    'getWorkspaceTrust',
    'listPermissionGrants',
    'listAllPermissionGrants',
    'getPermissionMutation',
    'getWorkspace',
    'getWorkspaceRemoval',
    'getView',
    'listSkills',
    'listAllSkills',
    'getHostStatus',
    'readSessionExportPage',
    'readSessionExportText',
    'verifySessionExport',
    'getContext',
    'listPendingInputs',
    'listInteractions',
    'getInteraction',
    'getCommand',
    'getRun',
    'getExecution',
    'listSessionLogs',
    'listModelInputs',
    'getModelInput',
    'getModelOutput',
    'listExecutionOutput',
    'listMessages',
    'listBackgroundExecutions',
    'listAllBackgroundExecutions',
    'listWorkspaceDirectory',
    'listSessionDirectory',
    'listAllWorkspaces',
    'listAllSessionDirectory',
    'listAllSessions',
    'listWorkspaces',
    'listSessions',
    'readArtifact',
    'readInteractionAttachment',
    'listFileCheckpoints',
    'getFileCheckpoint',
    'getFileRestoreStatus',
    'getFileCheckpointRecoveryBoundary',
    'listExtensions',
    'queryExtension',
    'observe',
    'disposeNetwork',
  ]);
  const client = new Proxy(source, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (active && (typeof property !== 'string' || !reads.has(property)))
          return Promise.reject(new ClientError('workspace_observer_readonly'));
        return Reflect.apply(value, target, args);
      };
    },
  });
  return {
    client,
    read,
    get active() {
      return active;
    },
  };
}
