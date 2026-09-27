import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { childThreadIdForToolAttempt } from '@kite-ai/agent-kernel';
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
  throw new Error('Missing queued child crash fixture input.');
process.env.KITE_CODE_HOME = home;
const parentSessionId = 'queued-child-restart-parent';
const databasePath = join(home, 'kite-session.sqlite');
const storage = await createKiteSessionAppServerStorageComposition({
  databasePath,
  hostInstanceId: 'queued-child-crashed-host',
  executionLeaseMs: 150,
  renewIntervalMs: 40,
});
const server = createKiteMultiWorkspaceRuntimeServer({
  checkpointPath: databasePath,
  storageOwner: storage,
  workspaces: [
    {
      userId: 'queued-child-user',
      workspace,
      config: {
        providerName: 'queued-child-model',
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
  clientInfo: { name: 'queued-child-crash-fixture', version: '1', instanceId: 'client' },
});
const created = await client.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  type: 'create_session',
  commandId: 'queued-child-create',
  workspace,
  bootstrapSessionId: parentSessionId,
});
if (created.status !== 'applied') throw new Error('Crash fixture could not create parent.');
const started = await client.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  type: 'start_turn',
  commandId: 'queued-child-start',
  sessionId: parentSessionId,
  expectedRevision: created.revision,
  input: 'QUEUED_RESTART_PARENT',
});
if (started.status !== 'applied') throw new Error('Crash fixture could not start parent.');

const deadline = Date.now() + 8_000;
while (Date.now() < deadline) {
  const parent = storage.loadCurrentSnapshot(parentSessionId);
  const events = storage.storage.sessions
    .loadEventsStrict(parentSessionId)
    .map(({ event }) => event);
  const childId = (label: 'A' | 'B' | 'C' | 'D') => {
    const toolCallId = `queued-restart-${label}`;
    const dispatch = events.find(
      (event) =>
        event.type === 'capability.subagent_dispatch_intent_recorded' &&
        parent?.capabilities.invocations[event.invocationId]?.toolCallId === toolCallId,
    );
    return dispatch?.type === 'capability.subagent_dispatch_intent_recorded'
      ? childThreadIdForToolAttempt({
          parentSessionId,
          parentInvocationId: dispatch.invocationId,
          parentToolCallId: toolCallId,
          attempt: dispatch.attempt,
        })
      : undefined;
  };
  const ids = [childId('A'), childId('B'), childId('C')];
  const ready = ids.every((id) => id !== undefined);
  if (ready && parent?.resourceBudget.status === 'active') {
    const [a, b, c] = ids as [string, string, string];
    const requested = [a, b, c].every((id) =>
      storage.storage.sessions
        .loadEventsStrict(id)
        .some(({ event }) => event.type === 'model.requested'),
    );
    const fourthRejected = events.some(
      (event) =>
        event.type === 'tool.finished' &&
        event.toolCallId === 'queued-restart-D' &&
        event.result.ok === false,
    );
    if (
      requested &&
      fourthRejected &&
      !childId('D') &&
      storage.listChildSessions(parentSessionId, 10).entries.length === 3
    ) {
      writeFileSync(marker, JSON.stringify({ a, b, c }));
      await new Promise(() => undefined);
    }
  }
  await Bun.sleep(10);
}
throw new Error('Crash fixture did not reach the queued child boundary.');
