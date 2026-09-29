import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
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

test('workspace data removal handles many sessions and corrupt history without loading a model', async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-remove-batch-'));
  const workspace = join(root, 'workspace');
  const otherWorkspace = join(root, 'other');
  mkdirSync(workspace);
  mkdirSync(otherWorkspace);
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const databasePath = join(root, 'kite-session.sqlite');
  const model = createMockModelServer();
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'batch-host',
  });
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [
      runtimeInput(workspace, model.baseURL, 'batch'),
      runtimeInput(otherWorkspace, model.baseURL, 'other'),
    ],
  });
  const runtime = client(server, admission(workspace), 'batch-client');
  const other = client(server, admission(otherWorkspace), 'other-client');
  const db = new Database(databasePath);
  try {
    for (let index = 0; index < 24; index += 1)
      await createSession(runtime, `batch-${index}`, workspace);
    await createSession(other, 'preserved-session', otherWorkspace);
    db.query(
      "UPDATE runtime_snapshots SET state_json='{}', state_checksum='corrupt' WHERE session_id='batch-0'",
    ).run();
    const started = performance.now();
    expect(
      await server.removeWorkspace({
        phase: 'remove',
        workspace,
        workspaceDigest: `sha256:${createHash('sha256').update(workspace).digest('hex')}`,
        token: 'batch-removal',
      }),
    ).toEqual({ deletedSessions: 24, token: 'batch-removal' });
    const elapsed = performance.now() - started;
    expect(db.query('SELECT session_id FROM runtime_sessions').all()).toEqual([
      { session_id: 'preserved-session' },
    ]);
    expect(model.getRequests()).toHaveLength(0);
    // A generous bound catches the old per-session cleanup timeout without depending on machine speed.
    expect(elapsed).toBeLessThan(5_000);
  } finally {
    db.close();
    await runtime.close();
    await other.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

function runtimeInput(workspace: string, baseURL: string, modelName: string) {
  return {
    userId: `user-${modelName}`,
    workspace,
    config: {
      providerName: `provider-${modelName}`,
      providerType: 'openai-compatible' as const,
      apiKey: `key-${modelName}`,
      baseURL,
      modelName,
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
}

function admission(workspace: string): RuntimeServerAdmissionPort {
  return Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
}

function client(
  owner: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
  workspaceAdmission: RuntimeServerAdmissionPort,
  instanceId: string,
): RuntimeClient {
  const transport: RuntimeClientTransport = Object.freeze({
    connect: async () => {
      const pair = owner.open({ admission: workspaceAdmission });
      return Object.freeze({
        send: (message: RuntimeProtocolMessage) => pair.client.send(message),
        messages: () => pair.client.messages(),
        close: (reason?: string) => pair.client.close(reason),
      });
    },
  });
  return new RuntimeClient({
    transport,
    clientInfo: { name: 'runtime-multi-workspace', version: '1', instanceId },
  });
}

async function createSession(
  runtime: RuntimeClient,
  sessionId: string,
  wireWorkspace: string,
): Promise<void> {
  await runtime.command({
    schema: RUNTIME_COMMAND_SCHEMA_,
    commandId: `create-${sessionId}-${wireWorkspace}`,
    type: 'create_session',
    workspace: wireWorkspace,
    bootstrapSessionId: sessionId,
  });
}
