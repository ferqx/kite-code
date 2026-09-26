import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyBuiltinShellIntent } from '@kite-ai/builtin-runtime';
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
import { createChildApprovalProxyOwner } from '../../src/bootstrap/runtime/subagent/child-approval-owner';
import { projectChildApprovalProxy } from '../../src/bootstrap/runtime/subagent/child-approval-proxy';
import { APP_PREPARED_SHELL_EXECUTION_ } from '../../src/sandbox/prepared-tool-pipeline';

const [home, workspace, modelBaseURL, marker, decisionWindow] = process.argv.slice(2);
if (!home || !workspace || !modelBaseURL || !marker || !decisionWindow)
  throw new Error('Missing child approval crash fixture input.');
if (decisionWindow !== 'pending' && decisionWindow !== 'decided')
  throw new Error('Unknown child approval crash window.');
process.env.KITE_CODE_HOME = home;
const parentSessionId = 'child-approval-restart-parent';
const databasePath = join(home, 'kite-session.sqlite');
const storage = await createKiteSessionAppServerStorageComposition({
  databasePath,
  hostInstanceId: 'child-approval-crashed-host',
  executionLeaseMs: 200,
  renewIntervalMs: 40,
});
// Keep the fixture's crashed child lease short so the successor can prove a
// fenced takeover without waiting for the production lease duration.
const shortChildLease = {
  ...storage,
  createChildSession: (creation: Parameters<typeof storage.createChildSession>[0]) =>
    storage.createChildSession({
      ...creation,
      controller: { ...creation.controller, executionLeaseUntilMs: Date.now() + 200 },
    }),
};
const shellExecutor = async ({ command }: { command: string }) => ({
  ok: true as const,
  command,
  exitCode: 0,
  stdout: 'approved child shell',
  stderr: '',
});
Object.defineProperty(shellExecutor, APP_PREPARED_SHELL_EXECUTION_, {
  enumerable: false,
  value: Object.freeze({
    execute: async (prepared: { readonly command: string }) =>
      Object.freeze({
        ok: true as const,
        command: prepared.command,
        exitCode: 0,
        stdout: 'approved child shell',
        stderr: '',
        intent: classifyBuiltinShellIntent(prepared.command),
        executionPhase: 'go_started' as const,
      }),
  }),
});
const server = createKiteMultiWorkspaceRuntimeServer({
  checkpointPath: databasePath,
  storageOwner: shortChildLease,
  workspaces: [
    {
      userId: 'child-approval-restart-user',
      workspace,
      config: {
        providerName: 'child-approval-restart-model',
        providerType: 'openai-compatible' as const,
        apiKey: 'fixture-key',
        baseURL: modelBaseURL,
        modelName: 'mock-model',
        modelKwargs: { maxOutputTokens: 64 },
        modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
        features: { resourceBudget: true },
        sandbox: { enabled: true },
      },
      shellExecutor,
      interactionMode: 'accept_edits' as const,
      sandboxBackend: 'seatbelt' as const,
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
  clientInfo: { name: 'child-approval-crash-fixture', version: '1', instanceId: 'client' },
});
const created = await client.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  type: 'create_session',
  commandId: 'child-approval-create',
  workspace,
  bootstrapSessionId: parentSessionId,
});
if (created.status !== 'applied') throw new Error('Approval fixture could not create parent.');
const started = await client.command({
  schema: RUNTIME_COMMAND_SCHEMA_,
  type: 'start_turn',
  commandId: 'child-approval-start',
  sessionId: parentSessionId,
  expectedRevision: created.revision,
  input: 'APPROVAL_RESTART_PARENT',
});
if (started.status !== 'applied') throw new Error('Approval fixture could not start parent.');

const deadline = Date.now() + 8_000;
while (Date.now() < deadline) {
  const proxy = storage.listPendingChildApprovalProxies(parentSessionId, 10)[0];
  const child = proxy && storage.loadCurrentSnapshot(proxy.childThreadId);
  const model = child?.tools.calls[proxy?.childToolCallId ?? '']?.modelInvocationId;
  const completed = model ? child?.modelInvocations[model] : undefined;
  if (
    proxy?.status === 'pending' &&
    child?.turn.status === 'active' &&
    completed?.status === 'completed' &&
    completed.responseArtifact &&
    child.tools.calls[proxy.childToolCallId]?.status === 'awaiting_approval' &&
    storage.storage.sessions
      .loadEventsStrict(parentSessionId)
      .some(({ event }) => event.type === 'completion.blocked') &&
    !storage.storage.sessions
      .loadEventsStrict(proxy.childThreadId)
      .some(({ event }) => event.type === 'tool.started')
  ) {
    if (decisionWindow === 'decided') {
      const parentState = storage.loadCurrentSnapshot(parentSessionId);
      if (!parentState) throw new Error('Approval fixture parent State vanished.');
      const interaction = projectChildApprovalProxy({
        parentState,
        childState: child,
        proxy,
      });
      if (!interaction) throw new Error('Approval fixture has no parent-scoped interaction.');
      const proxyOwner = createChildApprovalProxyOwner({
        owner: storage,
        parentSessionId,
        getParentState: () => storage.loadCurrentSnapshot(parentSessionId)!,
        publishParentEvent: () => {
          throw new Error('Decision fixture must not wake the child before SIGKILL.');
        },
      });
      proxyOwner.decide({
        parentState,
        interaction,
        decision: 'approve_once',
        evidence: {
          scopeSessionId: parentSessionId,
          targetSessionId: parentSessionId,
          commandId: 'parent-approval-before-sigkill',
          requestDigest: 'a'.repeat(64),
          committedAt: Date.now(),
        },
      });
    }
    writeFileSync(
      marker,
      JSON.stringify({
        childThreadId: proxy.childThreadId,
        proxyInteractionId: proxy.proxyInteractionId,
      }),
    );
    await new Promise(() => undefined);
  }
  await Bun.sleep(10);
}
throw new Error('Approval fixture did not reach the requested persisted crash boundary.');
