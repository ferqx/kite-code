import { describe, expect, test } from 'bun:test';
import type { KiteWorkspaceIdentity } from '@kite-ai/kite-app-contract';
import {
  createWorkspaceWorkerCapabilityAuthority,
  createWorkspaceWorkerControlCarrier,
  createWorkspaceWorkerControlLink,
  KITE_WORKER_CONTROL_DIRECTORY_OUTBOX_PATH,
} from '../../src/workspace-worker/control-carrier';
import type {
  WorkspaceWorkerControlIdentity,
  WorkspaceWorkerDirectoryOutboxPage,
} from '../../src/workspace-worker/process-host';

const workspace: KiteWorkspaceIdentity = {
  canonicalPath: '/workspace/directory-control',
  projectId: 'project-directory-control',
  workspaceDigest: `sha256:${'a'.repeat(64)}`,
};

const identity: WorkspaceWorkerControlIdentity = {
  workerScopeId: 'worker-directory-control',
  workerInstanceId: 'instance-directory-control',
  buildId: 'build-directory-control',
  workspace,
};

describe('Workspace Worker authenticated Directory control', () => {
  test('reads only the path-free current Store outbox through the restart credential', async () => {
    const page: WorkspaceWorkerDirectoryOutboxPage = {
      entries: [
        {
          sessionId: 'session-directory-control',
          workerScopeId: identity.workerScopeId,
          revision: 3,
          updatedAt: 100,
          tombstone: false,
        },
      ],
      nextCursor: 11,
      hasMore: true,
    };
    let received: { readonly cursor?: number; readonly limit?: number } | undefined;
    const authority = createWorkspaceWorkerCapabilityAuthority({ identity });
    const carrier = createWorkspaceWorkerControlCarrier({
      identity,
      authority,
      credential: 'c'.repeat(43),
      requestIp: () => ({ address: '127.0.0.1' }),
      directoryOutbox: {
        list(request) {
          received = request;
          return page;
        },
      },
    });
    try {
      const link = createWorkspaceWorkerControlLink({
        origin: carrier.origin,
        credential: carrier.credential,
        expectedWorker: {
          workerScopeId: identity.workerScopeId,
          workerInstanceId: identity.workerInstanceId,
          buildId: identity.buildId,
          workspaceDigest: workspace.workspaceDigest,
        },
      });
      const read = link.readDirectoryOutbox;
      expect(read).toBeDefined();
      const result = await read!({ cursor: 10, limit: 1 });
      expect(result).toEqual(page);
      expect(received).toEqual({ cursor: 10, limit: 1 });
      expect(JSON.stringify(result)).not.toMatch(
        /canonicalPath|path|title|body|controller|effect/u,
      );

      const invalid = await fetch(`${carrier.origin}${KITE_WORKER_CONTROL_DIRECTORY_OUTBOX_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Kite-Worker-Control ${carrier.credential}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ cursor: 10, unknown: true }),
      });
      expect(invalid.status).toBe(400);

      const query = await fetch(
        `${carrier.origin}${KITE_WORKER_CONTROL_DIRECTORY_OUTBOX_PATH}?cursor=10`,
        {
          method: 'POST',
          headers: {
            authorization: `Kite-Worker-Control ${carrier.credential}`,
            'content-type': 'application/json',
          },
          body: '{}',
        },
      );
      expect(query.status).toBe(403);

      const oldCredential = createWorkspaceWorkerControlLink({
        origin: carrier.origin,
        credential: 'o'.repeat(43),
        expectedWorker: {
          workerScopeId: identity.workerScopeId,
          workerInstanceId: identity.workerInstanceId,
          buildId: identity.buildId,
          workspaceDigest: workspace.workspaceDigest,
        },
      });
      expect(await oldCredential.readDirectoryOutbox!({})).toBeUndefined();
    } finally {
      await carrier.close();
      authority.close();
    }
  });
});
