import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openSqliteStore } from '@kite-ai/agent/sqlite';
import {
  createTestWorkspace,
  observePersistedCommandSession,
  observePersistedSessionCommandEvents,
  observePersistedSessionEvents,
  observePersistedSessionIds,
  observePersistedSessionSummaries,
  observePersistedTurnEvents,
  persistedRuntimePath,
  readPersistedPlanArtifacts,
  requirePersistedRuntimeReady,
  type TestWorkspace,
  translateOriginalTestConfig,
} from './test-workspace';

describe('TUI persisted Runtime observers', () => {
  let workspace: TestWorkspace | undefined;

  afterEach(() => {
    workspace?.cleanup();
    workspace = undefined;
  });

  test('reports an uninitialized isolated workspace as not yet persisted', () => {
    workspace = createTestWorkspace();

    expect(observePersistedSessionIds(workspace)).toMatchObject({ status: 'not_created' });
    expect(observePersistedSessionSummaries(workspace)).toMatchObject({
      status: 'not_created',
    });
    expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
      status: 'not_created',
    });
    expect(
      observePersistedSessionCommandEvents(workspace, 'thread-a', '/compact marker'),
    ).toMatchObject({ status: 'not_created' });
    expect(observePersistedSessionEvents(workspace, 'thread-a')).toMatchObject({
      status: 'not_created',
    });
    expect(observePersistedTurnEvents(workspace, 'turn marker')).toMatchObject({
      status: 'not_created',
    });
  });

  test('fails fast when the Runtime database path is a directory', () => {
    workspace = createTestWorkspace();
    const databasePath = persistedRuntimePath(workspace);
    mkdirSync(databasePath);

    expect(() => observePersistedSessionIds(workspace!)).toThrow(
      'Failed to observe isolated Runtime Store',
    );
  });

  test('treats an existing database without Runtime schema as not ready', () => {
    workspace = createTestWorkspace();
    const databasePath = persistedRuntimePath(workspace);
    new Database(databasePath).close();

    expect(observePersistedSessionIds(workspace)).toMatchObject({ status: 'initializing' });
    expect(observePersistedSessionSummaries(workspace)).toMatchObject({ status: 'initializing' });
    expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
      status: 'initializing',
    });
    expect(
      observePersistedSessionCommandEvents(workspace, 'thread-a', '/compact marker'),
    ).toMatchObject({ status: 'initializing' });
    expect(observePersistedSessionEvents(workspace, 'thread-a')).toMatchObject({
      status: 'initializing',
    });
    expect(observePersistedTurnEvents(workspace, 'turn marker')).toMatchObject({
      status: 'initializing',
    });
  });

  test('fails fast when the Runtime database is corrupt', () => {
    workspace = createTestWorkspace();
    const databasePath = persistedRuntimePath(workspace);
    writeFileSync(databasePath, 'not a sqlite database');

    expect(() => observePersistedSessionSummaries(workspace!)).toThrow(
      'Failed to observe isolated Runtime Store',
    );
  });

  test('reads exact new Store persistence without competing with the child writer', async () => {
    workspace = createTestWorkspace();
    const store = await openSqliteStore({
      dataRoot: workspace.dataRoot,
      profile: workspace.profile,
    });
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: 'file:///fixture',
        name: 'w',
      });
      await store.createSession({
        expectedStoreId,
        sessionId: 'thread-a',
        workspaceId: 'w',
        commandId: 'create',
        subjectId: 'owner',
        title: 'Command session',
      });
      await store.acceptCommand({
        expectedStoreId,
        sessionId: 'thread-a',
        commandId: 'work',
        subjectId: 'owner',
        request: { kind: 'run.start', content: 'turn marker' },
      });
      const owner = (await store.acquireSessionOwner('thread-a', 'host'))!;
      const run = await store.startRun({
        expectedStoreId,
        owner,
        commandId: 'work',
        configuration: { modelId: 'fixed' },
      });
      await store.acceptCommand({
        expectedStoreId,
        sessionId: 'thread-a',
        commandId: 'plan-write',
        subjectId: 'owner',
        request: {
          kind: 'extension.invoke',
          extensionId: 'builtin.planning',
          actionId: 'fixture',
          definitionVersion: '1',
          input: {},
        },
      });
      await store.writeExtensionRecord({
        expectedStoreId,
        owner,
        sessionId: 'thread-a',
        extensionId: 'builtin.planning',
        originCommandId: 'plan-write',
        write: {
          key: 'plan/p/1',
          expectedRevision: null,
          contentType: 'builtin.planning.record',
          contentVersion: 1,
          value: {
            kind: 'plan_document',
            planId: 'p',
            version: 1,
            title: 'Title',
            body: 'Original plan\nwith all lines',
            steps: [],
          },
          executable: true,
        },
      });
      await store.finishRun({
        expectedStoreId,
        owner,
        runId: run.id,
        status: 'completed',
        requirements: [],
      });
      const session = await store.getSession('thread-a');
      await store.acceptCommand({
        expectedStoreId,
        sessionId: 'thread-a',
        commandId: 'command-a',
        subjectId: 'owner',
        request: {
          kind: 'context.compress',
          expectedContextSelectionId: session!.contextSelectionId,
          focus: 'marker',
        },
      });
      const writer = new Database(workspace.databasePath);
      writer.run('BEGIN IMMEDIATE');
      try {
        expect(observePersistedSessionIds(workspace)).toMatchObject({
          status: 'ready',
          value: ['thread-a'],
        });
        expect(observePersistedSessionSummaries(workspace)).toMatchObject({
          status: 'ready',
          value: [{ threadId: 'thread-a', name: 'Command session' }],
        });
        expect(observePersistedCommandSession(workspace, '/compact marker')).toMatchObject({
          status: 'ready',
          value: { threadId: 'thread-a', name: 'Command session' },
        });
        expect(observePersistedCommandSession(workspace, '/compact other')).toMatchObject({
          status: 'ready',
          value: undefined,
        });
        expect(observePersistedCommandSession(workspace, '/unknown marker')).toMatchObject({
          status: 'ready',
          value: undefined,
        });
        expect(
          observePersistedSessionCommandEvents(workspace, 'thread-other', '/compact marker'),
        ).toMatchObject({ status: 'ready', value: undefined });
        const suffix = requirePersistedRuntimeReady(
          observePersistedSessionCommandEvents(workspace, 'thread-a', '/compact marker'),
        )!;
        expect(suffix[0]).toMatchObject({
          type: 'command.accepted',
          objectId: 'command-a',
          sourceType: 'command.accepted',
        });
        const events = requirePersistedRuntimeReady(
          observePersistedSessionEvents(workspace, 'thread-a'),
        );
        expect(
          events.some((e) => e.type === 'message.updated' && e.content === 'turn marker'),
        ).toBe(true);
        const turn = requirePersistedRuntimeReady(
          observePersistedTurnEvents(workspace, 'turn marker'),
        )!;
        expect(turn.threadId).toBe('thread-a');
        expect(turn.turnId).toBe(run.id);
        expect(turn.events.map((e) => e.type)).toContain('run.started');
        expect(turn.events.map((e) => e.type)).toContain('run.finished');
        expect(turn.events.every((e) => e.turnId === run.id && e.sourceType === e.type)).toBe(true);
        expect(
          turn.events.some((e) => e.type === 'turn.completed' || e.type === 'completion.blocked'),
        ).toBe(false);
        expect(observePersistedTurnEvents(workspace, 'not persisted')).toMatchObject({
          status: 'ready',
          value: undefined,
        });
        expect(readPersistedPlanArtifacts(workspace)).toEqual([
          {
            path: `${workspace.databasePath}#builtin.planning/thread-a/plan/p/1`,
            content: 'Original plan\nwith all lines',
          },
        ]);
      } finally {
        writer.run('ROLLBACK');
        writer.close();
      }
    } finally {
      await store.close();
    }
  });

  test('uses the actual Session identity when title and first message are empty', async () => {
    workspace = createTestWorkspace();
    const store = await openSqliteStore({
      dataRoot: workspace.dataRoot,
      profile: workspace.profile,
    });
    try {
      const expectedStoreId = (await store.getMetadata()).storeId;
      await store.createWorkspace({
        expectedStoreId,
        id: 'w',
        rootUri: 'file:///fixture',
        name: 'w',
      });
      await store.createSession({
        expectedStoreId,
        sessionId: 'thread-empty',
        workspaceId: 'w',
        commandId: 'create',
        subjectId: 'owner',
        title: '',
      });
      const session = await store.getSession('thread-empty');
      await store.acceptCommand({
        expectedStoreId,
        sessionId: 'thread-empty',
        commandId: 'compact',
        subjectId: 'owner',
        request: {
          kind: 'context.compress',
          expectedContextSelectionId: session!.contextSelectionId,
          focus: 'empty',
        },
      });
      expect(observePersistedSessionSummaries(workspace)).toMatchObject({
        status: 'ready',
        value: [{ threadId: 'thread-empty', name: 'thread-empty' }],
      });
      expect(observePersistedCommandSession(workspace, '/compact empty')).toMatchObject({
        status: 'ready',
        value: { threadId: 'thread-empty', name: 'thread-empty' },
      });
    } finally {
      await store.close();
    }
  });

  test('creates a new isolated development profile and translates the original test provider', () => {
    workspace = createTestWorkspace({
      configOverrides: {
        model: { default: { provider: 'mock', name: 'fixture' } },
        provider: { mock: { baseURL: 'http://127.0.0.1:3210/v1', apiKey: 'test' } },
        interactionMode: 'auto',
      },
      projectMcpServers: { fixture: { command: 'fixture', args: [] } },
    });
    expect(workspace.databasePath).toBe(
      join(workspace.home, '.kite-code', 'development', 'core.db'),
    );
    expect(workspace.configPath).toBe(join(workspace.home, '.kite-code', 'kite-code.jsonc'));
    expect(existsSync(join(workspace.profilePath, 'config.jsonc'))).toBe(false);
    expect(existsSync(join(workspace.workspace, '.kite-code', 'config.jsonc'))).toBe(false);
    const project = JSON.parse(readFileSync(join(workspace.workspace, 'kite-agent.jsonc'), 'utf8'));
    expect(project.models).toBeUndefined();
    expect(project.modelId).toBeUndefined();
    expect(project.tools.length).toBeGreaterThan(0);
    expect(JSON.parse(readFileSync(workspace.configPath, 'utf8'))).toMatchObject({
      modelId: 'fixture',
      models: [
        {
          id: 'fixture',
          provider: 'compatible',
          model: 'fixture',
          baseURL: 'http://127.0.0.1:3210/v1',
        },
      ],
    });
    expect(
      JSON.parse(readFileSync(join(workspace.profilePath, 'ui', 'preferences.jsonc'), 'utf8'))
        .language,
    ).toBe('zh-CN');
    expect(workspace.permissionMode).toBe('auto');
    expect(
      JSON.parse(readFileSync(join(workspace.workspace, '.kite-code', 'mcp.json'), 'utf8')),
    ).toEqual({ mcpServers: { fixture: { command: 'fixture', args: [] } } });
    expect(() => translateOriginalTestConfig({ interactionMode: 'strict' })).toThrow(
      'test_permission_mode_invalid',
    );
  });
});
