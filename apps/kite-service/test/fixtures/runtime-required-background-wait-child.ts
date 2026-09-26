import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';

const workspace = required('KITE_RESTART_TEST_WORKSPACE');
const databasePath = required('KITE_RESTART_TEST_DATABASE');
const sessionId = required('KITE_RESTART_TEST_SESSION');
const baseURL = required('KITE_RESTART_TEST_MODEL_URL');

const storage = await createKiteSessionAppServerStorageComposition({
  databasePath,
  hostInstanceId: 'required-background-crash-owner',
  executionLeaseMs: 200,
  renewIntervalMs: 50,
});
const owner = createKiteMultiWorkspaceRuntimeServer({
  checkpointPath: databasePath,
  storageOwner: storage,
  workspaces: [runtimeInput(workspace, baseURL)],
});
const runtime = client(owner, workspace);

await runtime.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  type: 'create_session',
  commandId: 'required-background-crash-create',
  workspace,
  bootstrapSessionId: sessionId,
});
await runtime.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  type: 'start_turn',
  commandId: 'required-background-crash-start',
  sessionId,
  expectedRevision: 0,
  input: 'REQUIRED_BACKGROUND_CRASH_PARENT',
});

for (let attempt = 0; attempt < 1_000; attempt += 1) {
  const result = await runtime.query({
    schema: RUNTIME_QUERY_SCHEMA_,
    type: 'get_session_projection',
    sessionId,
  });
  if (
    result.status === 'ok' &&
    result.session?.currentRun?.status === 'waiting' &&
    result.session.currentRun.waitingReason?.kind === 'required_background'
  ) {
    process.stdout.write(`${JSON.stringify({ runId: result.session.currentRun.runId })}\n`);
    await new Promise<never>(() => setInterval(() => undefined, 60_000));
  }
  await Bun.sleep(10);
}

throw new Error('Required background wait was not persisted before the child deadline.');

function runtimeInput(runtimeWorkspace: string, runtimeBaseURL: string) {
  return {
    userId: 'required-background-restart-user',
    workspace: runtimeWorkspace,
    config: {
      providerName: 'required-background-restart-model',
      providerType: 'openai-compatible' as const,
      apiKey: 'fixture-key',
      baseURL: runtimeBaseURL,
      modelName: 'mock-model',
      modelKwargs: { maxOutputTokens: 64 },
      modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
      features: { resourceBudget: true },
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
      userKiteCodeSkillsDir: join(runtimeWorkspace, 'user-kite-skills'),
      userAgentsSkillsDir: join(runtimeWorkspace, 'user-agent-skills'),
      projectKiteCodeSkillsDir: join(runtimeWorkspace, '.kite-code', 'skills'),
      projectAgentsSkillsDir: join(runtimeWorkspace, '.agents', 'skills'),
    },
    initialSkillActivations: [],
  };
}

function client(
  server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer>,
  runtimeWorkspace: string,
) {
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace: runtimeWorkspace,
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
  return new RuntimeClient({
    transport,
    clientInfo: { name: 'required-background-crash-child', version: '1', instanceId: 'child' },
  });
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
