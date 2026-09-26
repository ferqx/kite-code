import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeQuery,
} from '@kite-ai/runtime-contract';
import { runtimeHostCurrentStateEventTypes } from '@kite-ai/runtime-host';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';
import { createKiteRuntimeObserverHistoryClient } from '../../src/runtime-client/history-adapter';

test('known child Session ID cannot cross public query or observer-history read boundaries', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-child-read-boundary-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const rootSessionId = 'read-boundary-root';
  const childSessionId = 'read-boundary-child';
  const model = createMockModelServer();
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'read-boundary-host',
  });
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [
      {
        userId: 'read-boundary-user',
        workspace,
        config: {
          providerName: 'read-boundary-model',
          providerType: 'openai-compatible' as const,
          apiKey: 'fixture-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          modelKwargs: { maxOutputTokens: 64 },
          modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
          sandbox: { enabled: false },
        },
        shellExecutor: async ({ command }: { command: string }) => ({
          ok: true as const,
          command,
          exitCode: 0,
          stdout: '',
          stderr: '',
        }),
        interactionMode: 'accept_edits' as const,
        sandboxBackend: 'none' as const,
        skillOptions: {
          userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
          userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
          projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
          projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
        },
        initialSkillActivations: [],
      },
    ],
  });
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = server.open({ admission });
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  const client = new RuntimeClient({
    transport,
    clientInfo: { name: 'child-read-boundary-test', version: '1', instanceId: 'client' },
  });
  try {
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'read-boundary-create',
      workspace,
      bootstrapSessionId: rootSessionId,
    });
    expect(created.status).toBe('applied');
    const database = new Database(databasePath);
    try {
      database.run('PRAGMA foreign_keys=ON');
      database
        .query(`INSERT INTO runtime_sessions (
        session_id, workspace_id, project_id, workspace_digest, state_schema,
        format_epoch, revision, name, model_provider, model_name, updated_at,
        run_index_from_revision, parent_session_id
      ) SELECT ?, workspace_id, project_id, workspace_digest, state_schema,
               format_epoch, revision, 'internal child', model_provider, model_name,
               updated_at + 1, run_index_from_revision, session_id
          FROM runtime_sessions WHERE session_id = ?`)
        .run(childSessionId, rootSessionId);
    } finally {
      database.close(false);
    }
    expect(storage.readSessionLineage(childSessionId)).toEqual({ parentSessionId: rootSessionId });

    const knownIdQueries = (sessionId: string): readonly RuntimeQuery[] => [
      { schema: RUNTIME_QUERY_SCHEMA_, type: 'get_session_projection', sessionId },
      { schema: RUNTIME_QUERY_SCHEMA_, type: 'get_run', sessionId, runId: 'run-unknown' },
      { schema: RUNTIME_QUERY_SCHEMA_, type: 'list_runs', sessionId, limit: 10 },
      { schema: RUNTIME_QUERY_SCHEMA_, type: 'get_context_status', sessionId },
      { schema: RUNTIME_QUERY_SCHEMA_, type: 'get_session_recovery', sessionId },
      { schema: RUNTIME_QUERY_SCHEMA_, type: 'list_checkpoints', sessionId },
      {
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_rewind_preview',
        sessionId,
        checkpointId: 'missing',
      },
      { schema: RUNTIME_QUERY_SCHEMA_, type: 'list_background_executions', sessionId },
      {
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_background_execution',
        sessionId,
        executionId: 'missing',
      },
      ...(sessionId === childSessionId
        ? ([
            { schema: RUNTIME_QUERY_SCHEMA_, type: 'list_child_sessions', sessionId, limit: 10 },
            {
              schema: RUNTIME_QUERY_SCHEMA_,
              type: 'get_child_session_projection',
              sessionId,
              childSessionId: rootSessionId,
            },
          ] as const)
        : []),
    ];
    const listed = await client.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' });
    expect(listed.status).toBe('ok');
    if (listed.status === 'ok') {
      expect(listed.sessions?.map((session) => session.sessionId)).toContain(rootSessionId);
      expect(listed.sessions?.map((session) => session.sessionId)).not.toContain(childSessionId);
    }
    for (const query of knownIdQueries(childSessionId)) {
      await expect(client.query(query), query.type).rejects.toMatchObject({
        code: 'protocol_error',
        protocol: { data: { code: 'unauthorized' } },
      });
    }
    for (const query of knownIdQueries(rootSessionId)) {
      const result = await client.query(query);
      expect(result.queryType, query.type).toBe(query.type);
    }

    const history = createKiteRuntimeObserverHistoryClient(() =>
      storage.openHistoryLogs(runtimeHostCurrentStateEventTypes()),
    );
    expect(
      (await history.listSessions({ limit: 10 })).entries.map((entry) => entry.sessionId),
    ).toContain(rootSessionId);
    expect(
      (await history.listSessions({ limit: 10 })).entries.map((entry) => entry.sessionId),
    ).not.toContain(childSessionId);
    expect(
      (
        await history.listEvents({
          sessionId: rootSessionId,
          direction: 'forward',
          limit: 10,
        })
      ).entries,
    ).toEqual([]);
    await expect(history.loadSession(rootSessionId)).resolves.toBeDefined();
    await expect(
      history.listEvents({
        sessionId: childSessionId,
        direction: 'forward',
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'session_not_found' });
    await expect(history.loadSession(childSessionId)).rejects.toMatchObject({
      code: 'session_not_found',
    });
  } finally {
    await client.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);
