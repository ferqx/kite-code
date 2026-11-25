import { type AgentClient, ClientError } from '@kite-ai/client';

/** Pair the existing fact stubs. Real connection fences are exercised by Client HTTP tests. */
export async function getSelectionPermissions(
  this: Pick<AgentClient, 'getPermissionMode' | 'getWorkspaceTrust'>,
  sessionId: string,
  workspaceId: string,
  options: { storeId: string; signal?: AbortSignal },
) {
  const [mode, trust] = await Promise.all([
    this.getPermissionMode(sessionId, options),
    this.getWorkspaceTrust(workspaceId, options).catch((error: unknown) => {
      if (error instanceof ClientError && error.code === 'workspace_identity_unavailable')
        return undefined;
      throw error;
    }),
  ]);
  return { mode, trust };
}
