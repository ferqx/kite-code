import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createKiteHomeWorkspaceAdmissionPort,
  createKiteHomeWorkspaceAuthority,
  createKiteHomeWriteTransactionPort,
  initializeKiteHomeStoreSchema,
} from '../src';

describe('Kite Home Workspace authority', () => {
  test('persists Controller facts under the Workspace namespace on the Store 9 writer', () => {
    const database = new Database(':memory:', { strict: true });
    initializeKiteHomeStoreSchema(database);
    const writer = createKiteHomeWriteTransactionPort(database);
    const admission = createKiteHomeWorkspaceAdmissionPort({ database, writer, now: () => 1 });
    const workspace = workspaceIdentity('/workspace/authority');
    admission.admit(workspace);
    writer.run(() => {
      database
        .query(
          `INSERT INTO runtime_sessions(
            session_id, workspace_id, project_id, workspace_digest, state_schema, format_epoch,
            revision, name, updated_at, run_index_from_revision
          ) VALUES (?, ?, ?, ?, 27, 'kite-agent-server-api-v1-2026-08-29', 0, '', 1, 0)`,
        )
        .run('session-1', workspace.workspaceId, workspace.projectId, workspace.workspaceDigest);
    });

    const authority = createKiteHomeWorkspaceAuthority({
      database,
      writer,
      workspace,
      nowMs: () => 10,
    });
    const result = authority.controller.requestControl({
      sessionId: 'session-1',
      requestId: 'request-1',
      requestDigest: '1'.repeat(64),
      clientId: 'client-1',
      connectionGeneration: 1,
      workerInstanceId: 'service-1',
      resumeSecret: Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1)).toString(
        'base64url',
      ),
      resumeExpiresAtMs: 100,
    });
    expect(result).toMatchObject({
      status: 'applied',
      lease: { sessionId: 'session-1', controllerGeneration: 1 },
    });
    expect(authority.controller.read('session-1')).toMatchObject({
      status: 'active',
      clientId: 'client-1',
      workerInstanceId: 'service-1',
    });
    const keys = database
      .query<{ key: string }, []>(
        "SELECT key FROM kite_meta WHERE key LIKE 'workspace_authority/%' ORDER BY key",
      )
      .all()
      .map((row) => row.key);
    expect(keys).toEqual([
      `workspace_authority/${workspace.workspaceId}/workspace_authority_v1:controller:session-1`,
      `workspace_authority/${workspace.workspaceId}/workspace_authority_v1:operation:session-1:request-1`,
    ]);
    database.close();
  });
});

function workspaceIdentity(canonicalPath: string) {
  const pathHex = createHash('sha256').update(canonicalPath).digest('hex');
  const projectId = `project_${pathHex}`;
  const workspaceDigest = `sha256:${pathHex}`;
  const workspaceIdentityDigest = `sha256:${createHash('sha256')
    .update(
      `kite.workspace-identity.v1\0${JSON.stringify({ canonicalPath, projectId, workspaceDigest })}`,
    )
    .digest('hex')}`;
  return {
    workspaceId: `workspace_${workspaceIdentityDigest.slice('sha256:'.length)}`,
    canonicalPath,
    workspaceIdentityDigest,
    projectId,
    workspaceDigest,
    displayName: 'Authority',
  };
}
