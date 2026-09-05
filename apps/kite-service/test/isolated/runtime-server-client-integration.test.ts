import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccessNotification,
  type RuntimeNotification,
} from '@kite-ai/runtime-contract';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import { createKiteCliRuntimeAccess } from '../../src/bootstrap';

test('App CLI access routes one Host through InProcess Protocol with fixed admission and safe projections', async () => {
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'kite-runtime-server-client-'));
  const previousKiteCodeHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = workspace;
  const model = createMockModelServer();
  model.setResponses([{ message: { content: 'Integration terminal response.' } }]);
  const sessionId = 'integration-session';
  const access = createKiteCliRuntimeAccess({
    sessionId,
    userId: 'integration-user',
    workspace,
    checkpointPath: join(workspace, 'runtime.sqlite'),
    config: {
      providerName: 'integration-model',
      providerType: 'openai-compatible',
      apiKey: 'test-key',
      baseURL: model.baseURL,
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
    skillOptions: skillOptions(workspace),
    initialSkillActivations: [],
  });

  try {
    // The wire command deliberately supplies a different Workspace. Admission
    // injects the trusted App Workspace before the Host bridge validates it.
    const created = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'create-integration-session',
      type: 'create_session',
      workspace: '/attacker-controlled-workspace',
      bootstrapSessionId: sessionId,
    });
    expect(created).toMatchObject({ status: 'applied', sessionId, revision: 0 });

    const queried = await access.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId,
    });
    expect(queried).toMatchObject({
      status: 'ok',
      queryType: 'get_session_projection',
      session: { sessionId, revision: 0 },
    });
    expect(JSON.stringify(queried)).not.toContain(workspace);

    const stream = access.subscribe({ spec: { scope: 'session', sessionId } });
    const iterator = stream[Symbol.asyncIterator]();
    const initial = await nextNotification(iterator);
    expect(initial).toMatchObject({ durability: 'durable', sessionId, revision: 0 });
    expect(JSON.stringify(initial)).not.toContain(workspace);
    expect(JSON.stringify(initial)).not.toContain('/attacker-controlled-workspace');

    await expect(
      access.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_session_projection',
        sessionId: 'other-session',
      }),
    ).rejects.toMatchObject({ code: 'protocol_error' });
    await expect(
      access.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        commandId: 'cross-session-turn',
        type: 'start_turn',
        sessionId: 'other-session',
        expectedRevision: 0,
        input: 'must not reach another Session',
      }),
    ).rejects.toMatchObject({ code: 'protocol_error' });

    const started = await access.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      commandId: 'start-integration-turn',
      type: 'start_turn',
      sessionId,
      expectedRevision: 0,
      input: 'Respond once without calling a tool.',
    });
    expect(started).toMatchObject({ status: 'applied', sessionId });
    if (started.status !== 'applied') throw new Error('Expected the turn to be committed.');
    expect(started.revision).toBeGreaterThan(0);

    const eventfulNotifications: Extract<
      RuntimeNotification,
      { readonly durability: 'durable' }
    >[] = [];
    const terminal = await terminalNotification(iterator, sessionId, (notification) => {
      if (
        'durability' in notification &&
        notification.durability === 'durable' &&
        notification.projection.event
      ) {
        eventfulNotifications.push(notification);
      }
    });
    expect(terminal.durability).toBe('durable');
    expect(terminal.projection.session.sessionId).toBe(sessionId);
    expect(terminal.projection.session.workspace).toBeUndefined();
    expect(JSON.stringify(terminal)).not.toContain('test-key');
    expect(JSON.stringify(terminal)).not.toContain(workspace);
    expect(model.getRequestCount()).toBe(1);
    expect(eventfulNotifications.length).toBeGreaterThan(0);
    for (const notification of eventfulNotifications) {
      expect(notification.runId).toBeString();
      expect(notification.turnId).toBeString();
      if (notification.projection.event?.type === 'task.terminal') {
        expect(notification.taskId).toBe(notification.projection.event.taskId);
      }
    }

    await expect(
      access.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'get_session_projection', sessionId }),
    ).resolves.toMatchObject({
      status: 'ok',
      session: {
        currentRun: { status: 'completed' },
      },
    });

    await iterator.return?.();
    await access[Symbol.asyncDispose]();
    await expect(
      access.query({ schema: RUNTIME_QUERY_SCHEMA_, type: 'list_sessions' }),
    ).rejects.toMatchObject({ code: 'connection_closed' });
  } finally {
    if (previousKiteCodeHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousKiteCodeHome;
    await access[Symbol.asyncDispose]();
    model.stop();
    rmSync(resolve(workspace), { recursive: true, force: true });
  }
});

function skillOptions(workspace: string) {
  return {
    userKiteCodeSkillsDir: join(workspace, 'user-kite-skills'),
    userAgentsSkillsDir: join(workspace, 'user-agent-skills'),
    projectKiteCodeSkillsDir: join(workspace, '.kite-code', 'skills'),
    projectAgentsSkillsDir: join(workspace, '.agents', 'skills'),
  };
}

async function nextNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
): Promise<RuntimeAccessNotification> {
  const item = await Promise.race([
    iterator.next(),
    Bun.sleep(1_000).then(() => {
      throw new Error('Timed out waiting for a Runtime subscription notification.');
    }),
  ]);
  if (item.done) throw new Error('Expected a Runtime subscription notification.');
  return item.value;
}

async function terminalNotification(
  iterator: AsyncIterator<RuntimeAccessNotification>,
  sessionId: string,
  observe: (notification: RuntimeAccessNotification) => void = () => undefined,
): Promise<Extract<RuntimeNotification, { readonly durability: 'durable' }>> {
  const observed: string[] = [];
  for (let attempt = 0; attempt < 40; attempt += 1) {
    let notification: RuntimeAccessNotification;
    try {
      notification = await nextNotification(iterator);
    } catch (error) {
      throw new Error(`Runtime subscription stalled after: ${observed.join(', ')}`, {
        cause: error,
      });
    }
    observe(notification);
    observed.push(
      'durability' in notification && notification.durability === 'durable'
        ? `${notification.revision}:${notification.projection.event?.type ?? notification.projection.kind}`
        : 'durability' in notification
          ? notification.durability
          : notification.type,
    );
    if (
      'durability' in notification &&
      notification.durability === 'durable' &&
      notification.sessionId === sessionId &&
      ((notification.projection.session.currentRun !== undefined &&
        notification.projection.session.currentRun.status !== 'running' &&
        notification.projection.session.currentRun.status !== 'waiting') ||
        notification.projection.event?.type === 'run.terminal' ||
        notification.projection.event?.type === 'turn.terminal' ||
        notification.projection.event?.type === 'task.terminal')
    ) {
      return notification;
    }
  }
  throw new Error(
    `Runtime subscription did not reach a terminal projection: ${observed.join(', ')}`,
  );
}
