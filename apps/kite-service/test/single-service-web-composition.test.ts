import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import {
  WEB_DIRECTORY_REQUEST_SCHEMA_,
  WEB_OBSERVER_CONTRACT_REVISION_,
} from '@kite-ai/kite-app-contract';
import type { RuntimeAccess } from '@kite-ai/runtime-contract';
import { RUNTIME_PROJECTION_SCHEMA_ } from '@kite-ai/runtime-contract';
import {
  createKiteHomeDirectoryQuery,
  initializeKiteHomeStoreSchema,
} from '@kite-ai/runtime-storage-sqlite';
import { createKiteSingleServiceWebGatewayTarget } from '../src/bootstrap';

test('binds the Store 9 Directory to the in-process Web Observer only at the Service composition root', async () => {
  using database = new Database(':memory:', { strict: true });
  initializeKiteHomeStoreSchema(database);
  database
    .query(
      `INSERT INTO workspaces(
        workspace_id, canonical_path, workspace_identity_digest, project_id,
        workspace_digest, display_name, created_at, updated_at
      ) VALUES ('workspace-1', '/private/project', ?, 'project-1', 'digest-1', 'Project', 1, 1)`,
    )
    .run(`sha256:${'1'.repeat(64)}`);
  database
    .query(
      `INSERT INTO runtime_sessions(
        session_id, workspace_id, project_id, workspace_digest, state_schema,
        format_epoch, revision, name, updated_at, run_index_from_revision
      ) VALUES ('session-1', 'workspace-1', 'project-1', 'digest-1', 27, 'epoch', 1, 'Task', 2, 0)`,
    )
    .run();
  const target = createKiteSingleServiceWebGatewayTarget({
    directory: createKiteHomeDirectoryQuery(database),
    runtime: runtime(),
    history: {
      loadSession: async (sessionId) => ({ sessionId, lastSequence: 0, records: [] }),
    },
    serviceInstanceId: 'service-1',
    contractRevision: WEB_OBSERVER_CONTRACT_REVISION_,
  });
  expect(Object.keys(target)).toEqual(['contractRevision', 'createObserver']);
  const observer = target.createObserver({ tabHandle: 'tab-1', connectionGeneration: 1 });
  const directory = await observer.listDirectory({ schema: WEB_DIRECTORY_REQUEST_SCHEMA_ });
  expect(directory.workspaces).toEqual([
    {
      workspaceId: 'workspace-1',
      label: 'Project',
      sessions: [
        {
          sessionId: 'session-1',
          displayName: 'Task',
          updatedAt: 2,
          lastSequence: 0,
          status: 'idle',
        },
      ],
    },
  ]);
  expect(JSON.stringify(directory)).not.toContain('/private/project');
});

function runtime(): RuntimeAccess {
  return {
    command: async (command) => ({
      status: 'applied',
      commandId: command.commandId,
      sessionId: 'session-1',
      revision: 1,
    }),
    query: async (query) => ({
      status: 'ok',
      queryType: query.type,
      session: {
        schema: RUNTIME_PROJECTION_SCHEMA_,
        sessionId: 'session-1',
        revision: 1,
        lifecycle: 'open',
        interactionQueue: { revision: 1, interactions: [] },
      },
    }),
    subscribe: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () => await new Promise<IteratorResult<never>>(() => undefined),
      }),
    }),
  };
}
