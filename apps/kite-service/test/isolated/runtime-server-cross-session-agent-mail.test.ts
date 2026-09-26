import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import { runtimeHostCurrentStateEventTypes } from '@kite-ai/runtime-host';
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
import { createKiteRuntimeObserverHistoryClient } from '../../src/runtime-client/history-adapter';

test('independent child QueueOnly Tool delivers into parent Run model input', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-agent-mail-e2e-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'mail-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  let childCalls = 0;
  let parentCalls = 0;
  let parentSawMail = false;
  const seenTools: string[][] = [];
  model.setResponses(
    Array.from({ length: 10 }, () => ({
      response: async ({
        body,
        messages,
      }: {
        body: Record<string, unknown>;
        messages: readonly unknown[];
      }) => {
        const transcript = JSON.stringify(messages);
        const toolNames = Array.isArray(body.tools)
          ? body.tools.flatMap((entry) => {
              const value = entry as { function?: { name?: string } };
              return value.function?.name ? [value.function.name] : [];
            })
          : [];
        seenTools.push(toolNames);
        if (transcript.includes('MAIL_CHILD') && !transcript.includes('MAIL_PARENT')) {
          childCalls++;
          if (childCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'child-send-parent',
                    name: 'send_message',
                    args: { agent_id: parentSessionId, message: 'CHILD_PRIVATE_MAIL' },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          await childGate;
          return {
            message: { content: 'MAIL_CHILD_DONE' },
            ...(childCalls === 2
              ? { expectedRequest: { toolResults: [{ toolCallId: 'child-send-parent' }] } }
              : {}),
          };
        }
        parentCalls++;
        if (parentCalls === 1)
          return {
            message: {
              tool_calls: [
                {
                  id: 'spawn-mail-child',
                  name: 'task',
                  args: {
                    name: 'Mail child',
                    subagent_type: 'code',
                    task: 'MAIL_CHILD',
                    background: true,
                    result_disposition: 'required',
                  },
                },
              ],
            },
            toolContinuation: 'required' as const,
          };
        if (transcript.includes('MAIL_CHILD_DONE')) {
          parentSawMail =
            transcript.includes('CHILD_PRIVATE_MAIL') && transcript.includes('<agent_message');
          return {
            message: { content: 'MAIL_PARENT_DONE' },
            ...(parentCalls === 2
              ? { expectedRequest: { toolResults: [{ toolCallId: 'spawn-mail-child' }] } }
              : {}),
          };
        }
        return {
          message: { content: 'Waiting for mail child.' },
          ...(parentCalls === 2
            ? { expectedRequest: { toolResults: [{ toolCallId: 'spawn-mail-child' }] } }
            : {}),
        };
      },
    })),
  );
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'mail-host',
  });
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [
      {
        userId: 'mail-user',
        workspace,
        config: {
          providerName: 'mail-model',
          providerType: 'openai-compatible' as const,
          apiKey: 'fixture-key',
          baseURL: model.baseURL,
          modelName: 'mock-model',
          modelKwargs: { maxOutputTokens: 64 },
          modelCapabilities: { contextWindowTokens: 32_768, maxOutputTokens: 64 },
          features: { resourceBudget: true, toolSearch: false },
          sandbox: { enabled: true },
        },
        shellExecutor: async ({ command }: { command: string }) => ({
          ok: true as const,
          command,
          exitCode: 0,
          stdout: '',
          stderr: '',
        }),
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
    clientInfo: { name: 'agent-mail-e2e-test', version: '1', instanceId: 'client' },
  });
  const parentEvents = () =>
    storage.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event);
  try {
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-mail-parent',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Parent creation failed.');
    const started = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-mail-parent',
      sessionId: parentSessionId,
      expectedRevision: created.revision,
      input: 'MAIL_PARENT',
    });
    expect(started.status).toBe('applied');
    await until(() => parentEvents().some((event) => event.type === 'agent.mail_accepted')).catch(
      () => {
        const childSessionId = parentEvents().find(
          (event) => event.type === 'subagent.child_terminal_imported',
        )?.childThreadId;
        const childEvents = childSessionId
          ? storage.storage.sessions.loadEventsStrict(childSessionId).map(({ event }) => event)
          : [];
        throw new Error(
          `Mail acceptance absent: ${JSON.stringify({ seenTools, parentCalls, childCalls, parentErrors: parentEvents().filter((event) => event.type === 'run.error' || event.type === 'tool.failed'), child: childEvents.filter((event) => ['run.error', 'tool.failed', 'agent.mail_accepted', 'tool.completed', 'tool.queued'].includes(event.type)) })}`,
        );
      },
    );
    const accepted = parentEvents().find((event) => event.type === 'agent.mail_accepted');
    expect(accepted).toMatchObject({
      senderAgentId: expect.any(String),
      targetAgentId: parentSessionId,
      mode: 'queue_only',
    });
    releaseChild();
    await until(() => parentEvents().some((event) => event.type === 'run.completed'));
    expect(parentSawMail).toBe(true);
    expect(childCalls).toBeGreaterThanOrEqual(2);
    expect(parentCalls).toBeGreaterThanOrEqual(2);
    expect(
      parentEvents().filter((event) => event.type === 'agent.mail_input_prepared'),
    ).toHaveLength(1);
    expect(parentEvents().filter((event) => event.type === 'run.error')).toHaveLength(0);
    const childSessionId = parentEvents().find(
      (event) => event.type === 'subagent.child_session_intended',
    )?.childThreadId;
    expect(childSessionId).toEqual(expect.any(String));
    const childEvents = storage.storage.sessions
      .loadEventsStrict(childSessionId!)
      .map(({ event }) => event);
    expect(childEvents.filter((event) => event.type === 'agent.mail_accepted')).toHaveLength(1);
    expect(
      parentEvents().filter(
        (event) => event.type === 'agent.mail_accepted' && event.mode === 'queue_only',
      ),
    ).toHaveLength(1);
    expect(
      parentEvents().filter(
        (event) => event.type === 'agent.mail_accepted' && event.mode === 'reply',
      ),
    ).toHaveLength(0);
    expect(seenTools[0]).toContain('send_message');
    expect(seenTools[0]).toContain('list_agents');
    expect(seenTools[0]).toContain('wait_agent');
    for (const coordinated of ['followup_task', 'interrupt_agent'])
      expect(seenTools[0]).toContain(coordinated);
    const inspection = new Database(databasePath, { readonly: true });
    const bodies = inspection
      .query<{ body_text: string }, []>('SELECT body_text FROM agent_mail_bodies')
      .all()
      .map((row) => row.body_text);
    expect(bodies).toContain('CHILD_PRIVATE_MAIL');
    expect(bodies.some((body) => body.includes('agent_terminal_reply'))).toBe(false);
    inspection.close();
    expect(
      parentEvents()
        .filter((event) => JSON.stringify(event).includes('CHILD_PRIVATE_MAIL'))
        .map((event) => event.type),
    ).toEqual([]);
    const history = createKiteRuntimeObserverHistoryClient(() =>
      storage.openHistoryLogs(runtimeHostCurrentStateEventTypes()),
    );
    expect(JSON.stringify(await history.loadSession(parentSessionId))).not.toContain(
      'CHILD_PRIVATE_MAIL',
    );
    model.assertComplete({ allowUnconsumedResponses: true });
  } finally {
    releaseChild();
    await client.close();
    await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Cross-Session mail did not reach its durable boundary.');
    await Bun.sleep(20);
  }
}
