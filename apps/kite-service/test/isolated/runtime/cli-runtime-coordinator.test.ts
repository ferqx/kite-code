import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import { createMockModelServer } from '../../../../../tests/tui-system/harness/fixtures';
import { createKiteCliRuntimeAccess } from '../../../src/bootstrap';

test('CLI start_turn uses one Host coordinator and the configured Provider route', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-cli-retained-'));
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const server = createMockModelServer();
  server.setResponses([{ message: { content: 'CLI configured provider response.' } }]);
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
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cli-retained-create',
      type: 'create_session',
      workspace,
      bootstrapSessionId: sessionId,
    });
    expect(created).toMatchObject({ status: 'applied', sessionId, revision: 0 });

    const started = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cli-retained-turn',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'Respond once without calling a tool.',
    });
    expect(started).toMatchObject({ status: 'applied', sessionId, revision: 2 });
    await waitForModelRequest(server);
    expect(server.getRequestCount()).toBe(1);

    const projection = await access.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(projection).toMatchObject({
      status: 'ok',
      session: { sessionId },
    });

    expect(
      await access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'cli-retained-turn',
        type: 'start_turn',
        sessionId,
        expectedRevision: 0,
        input: 'Respond once without calling a tool.',
      }),
    ).toMatchObject({
      status: 'idempotent_replay',
      commandId: 'cli-retained-turn',
      sessionId,
      originalRevision: 2,
      resource: {
        kind: 'run',
        messageId: expect.any(String),
        run: { sessionId, status: 'queued' },
      },
    });
    expect(
      await access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
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
  } finally {
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    await access[Symbol.asyncDispose]();
    server.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});

async function waitForModelRequest(
  server: ReturnType<typeof createMockModelServer>,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (server.getRequestCount() > 0) return;
    await Bun.sleep(5);
  }
  throw new Error('CLI Runtime Client did not observe a terminal projection.');
}

test('CLI close_session commits active cancellation instead of returning runtime_busy', async () => {
  const workspace = mkdtempSync(join(process.cwd(), '.kite-cli-close-'));
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const server = createMockModelServer();
  const sessionId = 'cli-close-session';
  server.setResponses([{ message: { content: 'late response' }, delay: 500 }]);
  const access = createKiteCliRuntimeAccess({
    sessionId,
    userId: 'cli-test-user',
    workspace,
    checkpointPath: join(workspace, 'checkpoints.sqlite'),
    config: {
      providerName: 'cli-close-test',
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
    await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cli-close-create',
      type: 'create_session',
      workspace,
      bootstrapSessionId: sessionId,
    });
    await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cli-close-start',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'Wait for the provider response.',
    });
    await waitForModelRequest(server);
    const current = await access.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    if (current.status !== 'ok' || current.revision === undefined) {
      throw new Error('Expected an active CLI session projection.');
    }
    const closed = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'cli-close-active',
      type: 'close_session',
      sessionId,
      expectedRevision: current.revision,
    });
    expect(closed).toMatchObject({ status: 'applied', sessionId });
    const projection = await access.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(projection).toMatchObject({
      status: 'ok',
      session: {
        lifecycle: 'closed',
        currentRun: { status: 'cancelled' },
      },
    });
  } finally {
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    await access[Symbol.asyncDispose]();
    server.stop();
    rmSync(workspace, { recursive: true, force: true });
  }
});
