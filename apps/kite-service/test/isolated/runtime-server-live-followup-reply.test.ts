import { expect, test } from 'bun:test';
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

test('completed child new_turn replies into the active source Run exactly once', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-live-followup-reply-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'live-followup-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  let parentCalls = 0;
  let childCalls = 0;
  let replyInput = '';
  const parentEvents = () =>
    storage?.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event) ?? [];
  try {
    model.setResponses(
      Array.from({ length: 10 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          if (
            transcript.includes('LIVE_REPLY_CHILD') &&
            !transcript.includes('LIVE_REPLY_PARENT')
          ) {
            childCalls++;
            return {
              message: {
                content:
                  childCalls === 1 ? 'LIVE_REPLY_CHILD_INITIAL' : 'LIVE_REPLY_CHILD_FOLLOWUP',
              },
            };
          }
          parentCalls++;
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'spawn-live-reply-child',
                    name: 'task',
                    args: {
                      name: 'Live reply child',
                      subagent_type: 'review',
                      task: 'LIVE_REPLY_CHILD',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2) {
            await until(() =>
              parentEvents().some((event) => event.type === 'subagent.child_terminal_imported'),
            );
            return {
              message: { content: 'CHILD_RESULT_IMPORTED' },
              expectedRequest: { toolResults: [{ toolCallId: 'spawn-live-reply-child' }] },
            };
          }
          if (parentCalls === 3) {
            const childSessionId = parentEvents().find(
              (event) => event.type === 'subagent.child_session_intended',
            )?.childThreadId;
            if (!childSessionId) throw new Error('The child Session is missing.');
            return {
              message: {
                tool_calls: [
                  {
                    id: 'trigger-live-followup',
                    name: 'followup_task',
                    args: { agent_id: childSessionId, message: 'LIVE_REPLY_PRIVATE_FOLLOWUP' },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          }
          if (parentCalls === 4) {
            await until(
              () =>
                parentEvents().filter(
                  (event) => event.type === 'agent.mail_accepted' && event.mode === 'reply',
                ).length === 1,
            ).catch((error) => {
              const childSessionId = parentEvents().find(
                (event) => event.type === 'subagent.child_session_intended',
              )?.childThreadId;
              const childEvents = childSessionId
                ? storage?.storage.sessions
                    .loadEventsStrict(childSessionId)
                    .map(({ event }) => event)
                : [];
              throw new Error(
                `${String(error)} ${JSON.stringify({ parentCalls, childCalls, parentEvents: parentEvents().map((event) => event.type), childEvents: childEvents?.map((event) => event.type) })}`,
              );
            });
            return {
              message: {
                tool_calls: [{ id: 'inspect-after-reply', name: 'list_agents', args: {} }],
              },
              toolContinuation: 'required' as const,
              expectedRequest: { toolResults: [{ toolCallId: 'trigger-live-followup' }] },
            };
          }
          replyInput = transcript;
          return {
            message: { content: 'LIVE_REPLY_PARENT_DONE' },
            expectedRequest: { toolResults: [{ toolCallId: 'inspect-after-reply' }] },
          };
        },
      })),
    );
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'live-followup-host',
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'live-followup-user',
          workspace,
          config: {
            providerName: 'live-followup-model',
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
        const pair = server!.open({ admission });
        return Object.freeze({
          send: (message: RuntimeProtocolMessage) => pair.client.send(message),
          messages: () => pair.client.messages(),
          close: (reason?: string) => pair.client.close(reason),
        });
      },
    });
    client = new RuntimeClient({
      transport,
      clientInfo: { name: 'live-followup-reply-test', version: '1', instanceId: 'client' },
    });
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-live-followup-parent',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Parent creation failed.');
    const started = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-live-followup-parent',
      sessionId: parentSessionId,
      expectedRevision: created.revision,
      input: 'LIVE_REPLY_PARENT',
    });
    expect(started.status).toBe('applied');
    await until(() => parentEvents().some((event) => event.type === 'run.completed')).catch(
      (error) => {
        const childSessionId = parentEvents().find(
          (event) => event.type === 'subagent.child_session_intended',
        )?.childThreadId;
        const childEvents = childSessionId
          ? storage?.storage.sessions.loadEventsStrict(childSessionId).map(({ event }) => event)
          : [];
        throw new Error(
          `${String(error)} ${JSON.stringify({ parentCalls, childCalls, parentEvents: parentEvents().map((event) => event.type), childEvents: childEvents?.map((event) => event.type) })}`,
        );
      },
    );
    const events = parentEvents();
    const childSessionId = events.find(
      (event) => event.type === 'subagent.child_session_intended',
    )?.childThreadId;
    if (!childSessionId) throw new Error('The child Session was not created.');
    const childEvents = storage.storage.sessions
      .loadEventsStrict(childSessionId)
      .map(({ event }) => event);
    expect(childCalls).toBe(2);
    expect(parentCalls).toBe(5);
    expect(replyInput).toContain('<agent_message');
    expect(replyInput).toContain('agent_terminal_reply');
    expect(replyInput).toContain('taskReadHint');
    expect(replyInput).toContain('completed');
    expect(replyInput).not.toContain('LIVE_REPLY_CHILD_FOLLOWUP');
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'run.error')).toHaveLength(0);
    expect(
      events.filter(
        (event) =>
          event.type === 'subagent.child_terminal_imported' &&
          event.childThreadId === childSessionId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'agent.mail_accepted' && event.mode === 'reply'),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === 'agent.mail_input_prepared')).toHaveLength(1);
    expect(
      childEvents.filter(
        (event) => event.type === 'agent.followup_routed' && event.route === 'new_turn',
      ),
    ).toHaveLength(1);
    expect(
      childEvents.filter((event) => event.type === 'agent.followup_turn_settled'),
    ).toHaveLength(1);
    model.assertComplete({ allowUnconsumedResponses: true });
  } finally {
    await client?.close();
    await server?.[Symbol.asyncDispose]();
    storage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Live followup reply missed its durable boundary.');
    await Bun.sleep(20);
  }
}
