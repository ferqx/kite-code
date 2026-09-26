import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeHistorySessionTranscript,
} from '@kite-ai/runtime-contract';
import { runtimeHostCurrentStateEventTypes } from '@kite-ai/runtime-host';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import {
  KITE_SESSION_STORE10_DDL,
  KITE_SESSION_STORE10_TABLE_COLUMNS,
  KITE_SESSION_STORE11_DDL,
  KITE_SESSION_STORE11_TABLE_COLUMNS,
} from '../../../../packages/runtime-storage-sqlite/src/kite-home-store';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';
import { createKiteRuntimeObserverHistoryClient } from '../../src/runtime-client/history-adapter';

const sessionId = 'legacy-store10-history';
const prompt = 'Remember this older conversation';
const answer = 'The older conversation is still available.';

function copyCurrentConversationIntoHistoricalStore(input: {
  sourcePath: string;
  oldPath: string;
  ddl: readonly string[];
  tableColumns: Readonly<Record<string, readonly string[]>>;
  version: 10 | 11;
  epoch: string;
}): void {
  const { sourcePath, oldPath, ddl, tableColumns, version, epoch } = input;
  const old = new Database(oldPath);
  try {
    for (const statement of ddl) old.run(statement);
    old.query('ATTACH DATABASE ? AS source').run(sourcePath);
    for (const [table, columns] of Object.entries(tableColumns)) {
      if (table === 'kite_meta') continue;
      const names = columns.map((column) => `"${column}"`).join(', ');
      old.run(`INSERT INTO "${table}" (${names}) SELECT ${names} FROM source."${table}"`);
    }
    old
      .query('INSERT INTO kite_meta(key,value) VALUES (?,?),(?,?)')
      .run('schema_version', String(version), 'format_epoch', epoch);
    old.run(`PRAGMA user_version=${version}`);
    expect(old.query('PRAGMA foreign_key_check').all()).toEqual([]);
    old.run('DETACH DATABASE source');
  } finally {
    old.close(false);
  }
}

for (const sourceFormat of [
  {
    version: 10 as const,
    epoch: 'kite-session-app-server-2026-09-02',
    ddl: KITE_SESSION_STORE10_DDL,
    tableColumns: KITE_SESSION_STORE10_TABLE_COLUMNS,
  },
  {
    version: 11 as const,
    epoch: 'kite-session-lineage-2026-09-24',
    ddl: KITE_SESSION_STORE11_DDL,
    tableColumns: KITE_SESSION_STORE11_TABLE_COLUMNS,
  },
])
  test(`a Store${sourceFormat.version} conversation keeps its ID and exact History replay after normal startup`, async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-store10-history-'));
    const workspace = join(home, 'workspace');
    const seedHome = join(home, 'seed');
    mkdirSync(workspace);
    mkdirSync(seedHome, { mode: 0o700 });
    chmodSync(seedHome, 0o700);
    const seedPath = join(seedHome, 'kite-session.sqlite');
    const oldPath = join(home, 'kite-session.sqlite');
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = home;
    const model = createMockModelServer();
    model.setResponses([{ message: { content: answer } }]);
    const runtimeInput = {
      userId: 'legacy-history-user',
      workspace,
      config: {
        providerName: 'fixture-provider',
        providerType: 'openai-compatible' as const,
        apiKey: 'fixture-key',
        baseURL: model.baseURL,
        modelName: 'fixture-model',
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
    };
    const admission: RuntimeServerAdmissionPort = Object.freeze({
      authorize: async (_request: RuntimeServerAdmissionInput) => ({
        allowed: true as const,
        workspace,
      }),
    });
    const openClient = (server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>) => {
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
      return new RuntimeClient({
        transport,
        clientInfo: { name: 'store10-history', version: '1', instanceId: 'history-client' },
      });
    };
    try {
      const seedStorage = await createKiteSessionAppServerStorageComposition({
        databasePath: seedPath,
        hostInstanceId: 'history-seed',
      });
      const seedServer = createKiteMultiWorkspaceRuntimeServer({
        checkpointPath: seedPath,
        storageOwner: seedStorage,
        workspaces: [runtimeInput],
      });
      const seedClient = openClient(seedServer);
      let before: RuntimeHistorySessionTranscript;
      try {
        expect(
          await seedClient.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'create_session',
            commandId: 'seed-create',
            workspace,
            bootstrapSessionId: sessionId,
          }),
        ).toMatchObject({ status: 'applied' });
        const subscription = seedClient
          .subscribe({ spec: { scope: 'session', sessionId } })
          [Symbol.asyncIterator]();
        await subscription.next();
        expect(
          await seedClient.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'start_turn',
            commandId: 'seed-turn',
            sessionId,
            expectedRevision: 0,
            input: prompt,
          }),
        ).toMatchObject({ status: 'applied' });
        for (let count = 0; count < 50; count++) {
          const next = await subscription.next();
          if (next.done) throw new Error('Seed subscription closed before completion.');
          if (
            'durability' in next.value &&
            next.value.durability === 'durable' &&
            next.value.projection.session.currentRun?.status === 'completed'
          )
            break;
          if (count === 49) throw new Error('Seed conversation did not complete.');
        }
        const history = createKiteRuntimeObserverHistoryClient(() =>
          seedStorage.openHistoryLogs(runtimeHostCurrentStateEventTypes()),
        );
        before = await history.loadSession(sessionId);
        expect(JSON.stringify(before.events)).toContain(prompt);
        expect(JSON.stringify(before.events)).toContain(answer);
      } finally {
        await seedClient.close();
        await seedServer[Symbol.asyncDispose]();
      }

      copyCurrentConversationIntoHistoricalStore({
        sourcePath: seedPath,
        oldPath,
        ...sourceFormat,
      });
      chmodSync(oldPath, 0o600);
      const storage = await createKiteSessionAppServerStorageComposition({
        databasePath: oldPath,
        hostInstanceId: 'history-upgraded',
        assertRetiredStoreWritersStopped: () => undefined,
      });
      const server = createKiteMultiWorkspaceRuntimeServer({
        checkpointPath: oldPath,
        storageOwner: storage,
        workspaces: [runtimeInput],
      });
      const client = openClient(server);
      try {
        const listed = await client.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' });
        expect(listed.status).toBe('ok');
        if (listed.status === 'ok') {
          expect(listed.sessions?.map((session) => session.sessionId)).toContain(sessionId);
        }
        const history = createKiteRuntimeObserverHistoryClient(() =>
          storage.openHistoryLogs(runtimeHostCurrentStateEventTypes()),
        );
        const after = await history.loadSession(sessionId);
        expect(after.session.sessionId).toBe(sessionId);
        expect(after.events).toEqual(before.events);
        expect(after.records).toEqual(before.records);
        expect(new Set(after.records.map((record) => record.sequence)).size).toBe(
          after.records.length,
        );
      } finally {
        await client.close();
        await server[Symbol.asyncDispose]();
      }
    } finally {
      model.assertComplete({ allowUnconsumedResponses: true });
      model.stop();
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
