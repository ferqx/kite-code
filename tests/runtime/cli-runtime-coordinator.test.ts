import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_COMMAND_SCHEMA_V1, RUNTIME_QUERY_SCHEMA_V1 } from '@kite/runtime-contract';
import { createKiteCliRuntimeAccess } from '../../apps/kite/src/bootstrap';
import { createMockModelServer } from '../tui-system/harness/fixtures';

test('CLI start_turn uses one Host-runtime coordinator and one model attempt', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-cli-retained-'));
  const server = createMockModelServer();
  server.setResponses([{ message: { content: 'runtime coordinator response' } }]);
  const sessionId = 'cli-retained-session';
  const access = createKiteCliRuntimeAccess({
    sessionId,
    userId: 'cli-test-user',
    workspace,
    checkpointPath: join(workspace, 'checkpoints.sqlite'),
    config: {
      providerName: 'cli-retained-test',
      providerType: 'openai-compatible',
      apiKey: 'test-key',
      baseURL: server.baseURL,
      modelName: 'mock-model',
      sandbox: { enabled: false },
    },
    shellExecutor: async ({ command }) => ({
      ok: true,
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
    }),
    interactionMode: 'accept_edits',
    sandboxBackend: 'none',
    skillOptions: {
      userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
      userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
      projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
      projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
    },
    initialSkillActivations: [],
  });

  try {
    const created = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_V1,
      commandId: 'cli-retained-create',
      type: 'create_session',
      workspace,
      bootstrapSessionId: sessionId,
    });
    expect(created).toMatchObject({ status: 'applied', sessionId, revision: 0 });

    const started = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_V1,
      commandId: 'cli-retained-turn',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'Respond once without calling a tool.',
    });
    expect(started).toMatchObject({ status: 'applied', sessionId, revision: 1 });
    await access.waitForSessionIdle(sessionId);

    const projection = await access.query({
      schema: RUNTIME_QUERY_SCHEMA_V1,
      type: 'get_session_projection',
      sessionId,
    });
    expect(projection).toMatchObject({
      status: 'ok',
      session: { sessionId, activeWork: { status: 'completed' } },
    });

    expect(
      await access.command({
        schema: RUNTIME_COMMAND_SCHEMA_V1,
        commandId: 'cli-retained-turn',
        type: 'start_turn',
        sessionId,
        expectedRevision: 0,
        input: 'Respond once without calling a tool.',
      }),
    ).toEqual({
      status: 'idempotent_replay',
      commandId: 'cli-retained-turn',
      sessionId,
      originalRevision: 1,
    });
    expect(
      await access.command({
        schema: RUNTIME_COMMAND_SCHEMA_V1,
        commandId: 'cli-retained-turn',
        type: 'start_turn',
        sessionId,
        expectedRevision: 0,
        input: 'tampered retry',
      }),
    ).toEqual({
      status: 'rejected',
      commandId: 'cli-retained-turn',
      code: 'invalid_command',
    });
    expect(server.getRequestCount()).toBe(1);
    server.assertComplete();
  } finally {
    await access[Symbol.asyncDispose]();
    server.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});
