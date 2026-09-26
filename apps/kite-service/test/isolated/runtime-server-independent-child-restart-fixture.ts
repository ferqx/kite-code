import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';

const [home, workspace, modelBaseURL, marker] = process.argv.slice(2);
if (!home || !workspace || !modelBaseURL || !marker)
  throw new Error('Missing crash fixture input.');
process.env.KITE_CODE_HOME = home;
const databasePath = join(home, 'kite-session.sqlite');
const storage = await createKiteSessionAppServerStorageComposition({
  databasePath,
  hostInstanceId: 'child-restart-crashed-host',
  executionLeaseMs: 150,
  renewIntervalMs: 40,
});
const guardedStorage = {
  ...storage,
  createChildSession: (...args: Parameters<typeof storage.createChildSession>) => {
    writeFileSync(marker, 'accepted-and-blocked');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    return storage.createChildSession(...args);
  },
};
const server = createKiteMultiWorkspaceRuntimeServer({
  checkpointPath: databasePath,
  storageOwner: guardedStorage,
  workspaces: [
    {
      userId: 'child-restart-user',
      workspace,
      config: {
        providerName: 'child-restart-model',
        providerType: 'openai-compatible' as const,
        apiKey: 'fixture-key',
        baseURL: modelBaseURL,
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
  clientInfo: { name: 'child-restart-crash-fixture', version: '1', instanceId: 'client' },
});
const created = await client.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  type: 'create_session',
  commandId: 'child-restart-create',
  workspace,
  bootstrapSessionId: 'child-restart-parent',
});
if (created.status !== 'applied') throw new Error('Crash fixture could not create parent.');
const started = await client.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  type: 'start_turn',
  commandId: 'child-restart-start',
  sessionId: 'child-restart-parent',
  expectedRevision: created.revision,
  input: 'RESTART_PARENT',
});
if (started.status !== 'applied') throw new Error('Crash fixture could not start parent.');
await new Promise(() => undefined);
