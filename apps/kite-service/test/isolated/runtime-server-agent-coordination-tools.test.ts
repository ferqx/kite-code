import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
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

const D_TOOLS = new Set(['list_agents', 'wait_agent', 'followup_task', 'interrupt_agent']);
const AC_TOOLS = new Set(['task_wait', 'task_read', 'task_cancel']);

test('independent parent discloses Agent coordination tools while a child task settles', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-d0-agent-gate-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(root, 'kite-session.sqlite');
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const sessionId = 'd0-agent-gate-session';
  const model = createMockModelServer();
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'd0-agent-gate-host',
  });
  const storePorts = storage.storage as unknown as {
    readonly agentMailbox?: unknown;
    readonly agentMailInput?: unknown;
  };
  expect(storePorts.agentMailbox).toBeDefined();
  expect(storePorts.agentMailInput).toBeDefined();
  const childGate = deferred<void>();
  const childStarted = deferred<void>();
  const parentCandidate = deferred<void>();
  let parentCalls = 0;
  model.setResponses(
    Array.from({ length: 6 }, () => ({
      response: async ({
        body,
        messages,
      }: {
        body: Record<string, unknown>;
        messages: readonly unknown[];
      }) => {
        const toolNames = Array.isArray(body.tools)
          ? body.tools.map((item) =>
              item &&
              typeof item === 'object' &&
              'function' in item &&
              item.function &&
              typeof item.function === 'object' &&
              'name' in item.function
                ? item.function.name
                : undefined,
            )
          : [];
        const snapshot = JSON.stringify(messages);
        if (snapshot.includes('D0_CHILD') && !snapshot.includes('D0_PARENT')) {
          for (const name of D_TOOLS) expect(toolNames).not.toContain(name);
          expect(toolNames).not.toContain('send_message');
          childStarted.resolve();
          await childGate.promise;
          return { message: { content: 'D0_RESULT' } };
        }
        for (const name of D_TOOLS) expect(toolNames).toContain(name);
        expect(toolNames).toContain('send_message');
        for (const name of AC_TOOLS) expect(toolNames).toContain(name);
        parentCalls += 1;
        if (parentCalls === 1)
          return {
            message: {
              tool_calls: [
                {
                  id: 'd0-start-child',
                  name: 'task',
                  args: {
                    name: 'D0 child',
                    subagent_type: 'review',
                    task: 'D0_CHILD',
                    background: true,
                    result_disposition: 'required',
                  },
                },
              ],
            },
            toolContinuation: 'required' as const,
          };
        if (parentCalls === 2) {
          parentCandidate.resolve();
          return {
            message: { content: 'Waiting for the child.' },
            expectedRequest: { toolResults: [{ toolCallId: 'd0-start-child' }] },
          };
        }
        expect(snapshot).toContain('D0_RESULT');
        return { message: { content: 'D0 child settled.' } };
      },
    })),
  );
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [
      {
        userId: 'd0-user',
        workspace,
        config: {
          providerName: 'd0-model',
          providerType: 'openai-compatible' as const,
          apiKey: 'fixture-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          modelKwargs: { maxOutputTokens: 64 },
          modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
          features: { resourceBudget: true, toolSearch: false },
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
    clientInfo: { name: 'd0-agent-gate-test', version: '1', instanceId: 'client' },
  });
  const events = () =>
    storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
  try {
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'd0-create',
      workspace,
      bootstrapSessionId: sessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Session creation failed.');
    expect(
      (
        await client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'start_turn',
          commandId: 'd0-start',
          sessionId,
          expectedRevision: created.revision,
          input: 'D0_PARENT',
        })
      ).status,
    ).toBe('applied');
    await bounded(childStarted.promise);
    await bounded(parentCandidate.promise);
    childGate.resolve();
    await until(() => events().some((event) => event.type === 'run.completed'));
    expect(parentCalls).toBe(3);
    expect(
      events().filter((event) => event.type === 'subagent.background_result_persisted'),
    ).toHaveLength(1);
    expect(events().filter((event) => event.type === 'agent.created')).toHaveLength(0);
    expect(events().filter((event) => event.type === 'run.error')).toHaveLength(0);
    const internalSessionId = 'd0-internal-child';
    const database = new Database(databasePath);
    try {
      database.run('PRAGMA foreign_keys=ON');
      database
        .query(
          `INSERT INTO runtime_sessions (
             session_id, workspace_id, project_id, workspace_digest, state_schema,
             format_epoch, revision, name, model_provider, model_name, updated_at,
             run_index_from_revision, parent_session_id
           ) SELECT ?, workspace_id, project_id, workspace_digest, state_schema,
                    format_epoch, revision, 'internal child', model_provider, model_name,
                    updated_at + 1, run_index_from_revision, session_id
               FROM runtime_sessions WHERE session_id = ?`,
        )
        .run(internalSessionId, sessionId);
    } finally {
      database.close(false);
    }
    expect(storage.readSessionLineage(internalSessionId)).toEqual({ parentSessionId: sessionId });
    const listed = await client.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' });
    expect(listed.status).toBe('ok');
    if (listed.status === 'ok')
      expect(listed.sessions?.map((session) => session.sessionId)).not.toContain(internalSessionId);
    await expect(
      client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: internalSessionId,
      }),
    ).rejects.toMatchObject({
      code: 'protocol_error',
      protocol: { data: { code: 'unauthorized' } },
    });
  } finally {
    childGate.resolve();
    await client.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('D0 gate timed out')), 10_000),
    ),
  ]);
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('D0 settlement timed out');
    await Bun.sleep(20);
  }
}
