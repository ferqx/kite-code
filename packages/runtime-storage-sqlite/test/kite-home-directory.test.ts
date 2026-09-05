import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createKiteHomeDirectoryQuery, initializeKiteHomeStoreSchema } from '../src';

describe('Kite Home Store Directory query', () => {
  test('projects Workspace-scoped Sessions without returning canonical paths', () => {
    using database = new Database(':memory:', { strict: true });
    initializeKiteHomeStoreSchema(database);
    insertWorkspace(database, 'workspace-b', '/private/workspace-b', 'Beta', 'b');
    insertWorkspace(database, 'workspace-a', '/private/workspace-a', 'Alpha', 'a');
    insertSession(database, 'session-late', 'workspace-a', 'Late', 20);
    insertSession(database, 'session-early', 'workspace-a', 'Early', 10);
    insertSession(database, 'session-other', 'workspace-b', 'Other', 30);
    insertEvent(database, 'session-late', 'event-1', 1);
    insertEvent(database, 'session-late', 'event-4', 4);
    insertEvent(database, 'session-other', 'event-7', 7);

    const directory = createKiteHomeDirectoryQuery(database);
    expect(directory.list()).toEqual([
      {
        workspaceId: 'workspace-a',
        displayName: 'Alpha',
        sessions: [
          {
            sessionId: 'session-late',
            name: 'Late',
            updatedAt: 20,
            lastSequence: 4,
          },
          {
            sessionId: 'session-early',
            name: 'Early',
            updatedAt: 10,
            lastSequence: 0,
          },
        ],
      },
      {
        workspaceId: 'workspace-b',
        displayName: 'Beta',
        sessions: [
          {
            sessionId: 'session-other',
            name: 'Other',
            updatedAt: 30,
            lastSequence: 7,
          },
        ],
      },
    ]);
    expect(JSON.stringify(directory.list())).not.toContain('/private/');
  });

  test('enforces explicit projection bounds without moving Sessions across Workspace scope', () => {
    using database = new Database(':memory:', { strict: true });
    initializeKiteHomeStoreSchema(database);
    insertWorkspace(database, 'workspace-a', '/private/workspace-a', 'Alpha', 'a');
    insertWorkspace(database, 'workspace-b', '/private/workspace-b', 'Beta', 'b');
    insertSession(database, 'session-a-1', 'workspace-a', 'A1', 30);
    insertSession(database, 'session-a-2', 'workspace-a', 'A2', 20);
    insertSession(database, 'session-b-1', 'workspace-b', 'B1', 10);

    const directory = createKiteHomeDirectoryQuery(database, {
      maxWorkspaces: 2,
      maxSessionsPerWorkspace: 1,
    });
    expect(directory.list()).toEqual([
      {
        workspaceId: 'workspace-a',
        displayName: 'Alpha',
        sessions: [
          {
            sessionId: 'session-a-1',
            name: 'A1',
            updatedAt: 30,
            lastSequence: 0,
          },
        ],
      },
      {
        workspaceId: 'workspace-b',
        displayName: 'Beta',
        sessions: [
          {
            sessionId: 'session-b-1',
            name: 'B1',
            updatedAt: 10,
            lastSequence: 0,
          },
        ],
      },
    ]);
    expect(() => createKiteHomeDirectoryQuery(database, { maxSessionsPerWorkspace: 257 })).toThrow(
      RangeError,
    );
  });

  test('uses the first durable user message when a Session has no persisted name', () => {
    using database = new Database(':memory:', { strict: true });
    initializeKiteHomeStoreSchema(database);
    insertWorkspace(database, 'workspace-a', '/private/workspace-a', 'Alpha', 'a');
    insertSession(database, 'session-unnamed', 'workspace-a', '', 10);
    insertEvent(database, 'session-unnamed', 'event-system', 1, {
      type: 'session.created',
    });
    insertEvent(database, 'session-unnamed', 'event-user', 2, {
      type: 'user.message_appended',
      content: '修复 Web 会话列表超出问题',
    });

    expect(directorySession(database, 'session-unnamed')?.name).toBe('修复 Web 会话列表超出问题');
  });
});

function insertWorkspace(
  database: Database,
  workspaceId: string,
  canonicalPath: string,
  displayName: string,
  digestSeed: string,
): void {
  database
    .query(
      `INSERT INTO workspaces(
        workspace_id, canonical_path, workspace_identity_digest, project_id,
        workspace_digest, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
    )
    .run(
      workspaceId,
      canonicalPath,
      `sha256:${digestSeed.repeat(64)}`,
      `project-${digestSeed}`,
      `digest-${digestSeed}`,
      displayName,
    );
}

function insertSession(
  database: Database,
  sessionId: string,
  workspaceId: string,
  name: string,
  updatedAt: number,
): void {
  database
    .query(
      `INSERT INTO runtime_sessions(
        session_id, workspace_id, project_id, workspace_digest, state_schema,
        format_epoch, revision, name, updated_at, run_index_from_revision
      ) VALUES (?, ?, ?, ?, 27, 'epoch', 0, ?, ?, 0)`,
    )
    .run(
      sessionId,
      workspaceId,
      `project-${workspaceId}`,
      `digest-${workspaceId}`,
      name,
      updatedAt,
    );
}

function insertEvent(
  database: Database,
  sessionId: string,
  eventId: string,
  sequence: number,
  event: Readonly<Record<string, unknown>> = {},
): void {
  database
    .query(
      `INSERT INTO runtime_events(
        session_id, event_id, sequence, schema_version, event_json, created_at
      ) VALUES (?, ?, ?, 1, ?, 1)`,
    )
    .run(sessionId, eventId, sequence, JSON.stringify(event));
}

function directorySession(database: Database, sessionId: string) {
  return createKiteHomeDirectoryQuery(database)
    .list()
    .flatMap((workspace) => workspace.sessions)
    .find((session) => session.sessionId === sessionId);
}
