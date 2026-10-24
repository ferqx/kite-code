import { createHash } from 'node:crypto';
import {
  type McpPrivateSourceEntry,
  mcpCanonical,
  type OwnedCredentialScope,
} from '@kite-ai/agent/config';

/** This namespace is issued only by the user settings owner; old Workspace tokens never migrate. */
export function userMcpOAuthScope(
  profileId: string,
  storeId: string,
  entry: McpPrivateSourceEntry,
): OwnedCredentialScope {
  if (entry.server.source.kind !== 'user' || !entry.binding)
    throw new Error('mcp_oauth_scope_changed');
  const auth = entry.transport?.auth as Record<string, unknown> | undefined;
  return {
    namespace: 'mcp.oauth',
    ownerDigest: createHash('sha256')
      .update(
        mcpCanonical({
          domain: 'kite-user-mcp-oauth-owner-v1',
          profileId,
          storeId,
          source: entry.server.source,
          serverId: entry.server.id,
          rawEntryDigest: entry.server.rawEntryDigest,
          transportDigest: entry.server.transportDigest,
          authProfile: auth?.profile ?? 'oauth',
        }),
      )
      .digest('hex'),
  };
}

// Shared by the global owner and real Run adapters. A single user credential must serialize
// refresh/revocation even when the actual connections belong to different Workspaces.
const locks = new Map<string, Promise<void>>();
export async function acquireUserMcpOAuth(
  scope: OwnedCredentialScope,
  signal: AbortSignal,
): Promise<() => void> {
  signal.throwIfAborted();
  const previous = locks.get(scope.ownerDigest) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  locks.set(scope.ownerDigest, tail);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    release();
    void tail.then(() => {
      if (locks.get(scope.ownerDigest) === tail) locks.delete(scope.ownerDigest);
    });
  };
  let aborted!: () => void;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_resolve, reject) => {
        aborted = () => reject(new Error('mcp_oauth_cancelled'));
        signal.addEventListener('abort', aborted, { once: true });
        if (signal.aborted) aborted();
      }),
    ]);
    signal.throwIfAborted();
  } catch (error) {
    finish();
    throw error;
  } finally {
    signal.removeEventListener('abort', aborted);
  }
  return finish;
}
