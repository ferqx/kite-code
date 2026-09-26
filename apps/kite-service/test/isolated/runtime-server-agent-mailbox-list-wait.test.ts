import { Database } from 'bun:sqlite';
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

test('parent lists direct children and waits on its own unread mailbox', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-agent-mail-read-e2e-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'mail-read-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  const childSendGates = [deferred(), deferred()];
  const childTerminalGate = deferred();
  let parentCalls = 0;
  let childCalls = 0;
  let unrelatedCalls = 0;
  let childSessionIdForUnrelated = '';
  const parentTools: string[][] = [];
  const parentInputs: string[] = [];
  const unrelatedInputs: string[] = [];
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  const parentEvents = () =>
    storage?.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event) ?? [];
  try {
    model.setResponses(
      Array.from({ length: 16 }, () => ({
        response: async ({
          body,
          messages,
        }: {
          body: Record<string, unknown>;
          messages: readonly unknown[];
        }) => {
          const transcript = JSON.stringify(messages);
          if (transcript.includes('MAIL_READ_UNRELATED')) {
            unrelatedCalls++;
            unrelatedInputs.push(transcript);
            if (unrelatedCalls === 1)
              return {
                message: {
                  tool_calls: [
                    {
                      id: 'unrelated-send',
                      name: 'send_message',
                      args: { agent_id: childSessionIdForUnrelated, message: 'DENIED_MAIL' },
                    },
                  ],
                },
                toolContinuation: 'required' as const,
              };
            return {
              message: { content: 'UNRELATED_DONE' },
              expectedRequest: { toolResults: [{ toolCallId: 'unrelated-send' }] },
            };
          }
          if (transcript.includes('MAIL_READ_CHILD') && !transcript.includes('MAIL_READ_PARENT')) {
            childCalls++;
            if (childCalls <= 2) {
              await childSendGates[childCalls - 1]!.promise;
              return {
                message: {
                  tool_calls: [
                    {
                      id: `child-send-${childCalls}`,
                      name: 'send_message',
                      args: {
                        agent_id: parentSessionId,
                        message: `CHILD_MAIL_${childCalls}`,
                      },
                    },
                  ],
                },
                toolContinuation: 'required' as const,
                ...(childCalls === 2
                  ? { expectedRequest: { toolResults: [{ toolCallId: 'child-send-1' }] } }
                  : {}),
              };
            }
            await childTerminalGate.promise;
            return {
              message: { content: 'MAIL_READ_CHILD_DONE' },
              expectedRequest: { toolResults: [{ toolCallId: 'child-send-2' }] },
            };
          }
          parentCalls++;
          parentInputs.push(transcript);
          const toolNames = Array.isArray(body.tools)
            ? body.tools.flatMap((entry) => {
                const value = entry as { function?: { name?: string } };
                return value.function?.name ? [value.function.name] : [];
              })
            : [];
          parentTools.push(toolNames);
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'spawn-read-child',
                    name: 'task',
                    args: {
                      name: 'Mailbox child',
                      subagent_type: 'code',
                      task: 'MAIL_READ_CHILD',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2) {
            childSendGates[0]!.resolve();
            await until(
              () =>
                parentEvents().filter((event) => event.type === 'agent.mail_accepted').length === 1,
            );
            return {
              message: { tool_calls: [{ id: 'parent-list', name: 'list_agents', args: {} }] },
              toolContinuation: 'required' as const,
              expectedRequest: { toolResults: [{ toolCallId: 'spawn-read-child' }] },
            };
          }
          if (parentCalls === 3) {
            childSendGates[1]!.resolve();
            await until(
              () =>
                parentEvents().filter((event) => event.type === 'agent.mail_accepted').length === 2,
            );
            return {
              message: {
                tool_calls: [
                  { id: 'parent-wait-unread', name: 'wait_agent', args: { timeout_ms: 500 } },
                ],
              },
              toolContinuation: 'required' as const,
              expectedRequest: { toolResults: [{ toolCallId: 'parent-list' }] },
            };
          }
          if (parentCalls === 4)
            return {
              message: {
                tool_calls: [
                  { id: 'parent-wait-timeout', name: 'wait_agent', args: { timeout_ms: 0 } },
                ],
              },
              toolContinuation: 'required' as const,
              expectedRequest: { toolResults: [{ toolCallId: 'parent-wait-unread' }] },
            };
          return {
            message: { content: 'MAIL_READ_PARENT_DONE' },
            expectedRequest: { toolResults: [{ toolCallId: 'parent-wait-timeout' }] },
          };
        },
      })),
    );
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'mail-read-host',
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'mail-read-user',
          workspace,
          config: {
            providerName: 'mail-read-model',
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
      clientInfo: { name: 'agent-mail-read-e2e-test', version: '1', instanceId: 'client' },
    });
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-mail-read-parent',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Parent Session creation failed.');
    const started = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-mail-read-parent',
      sessionId: parentSessionId,
      expectedRevision: created.revision,
      input: 'MAIL_READ_PARENT',
    });
    expect(started.status).toBe('applied');
    await until(() =>
      parentEvents().some(
        (event) =>
          (event.type === 'tool.finished' || event.type === 'tool.failed') &&
          event.toolCallId === 'parent-wait-timeout',
      ),
    );
    const childSessionId = parentEvents().find(
      (event) => event.type === 'subagent.child_session_intended',
    )?.childThreadId;
    expect(childSessionId).toEqual(expect.any(String));
    childSessionIdForUnrelated = childSessionId!;
    expect(
      parentTools
        .slice(0, 4)
        .every(
          (tools) =>
            tools.includes('list_agents') &&
            tools.includes('wait_agent') &&
            tools.includes('send_message'),
        ),
    ).toBe(true);
    expect(
      parentTools
        .slice(0, 4)
        .every((tools) => tools.includes('followup_task') && tools.includes('interrupt_agent')),
    ).toBe(true);
    expect(toolResult(parentInputs[2]!, 'parent-list')).toEqual({
      ok: true,
      agents: [
        { agent_id: parentSessionId, status: 'running', unread_count: 1 },
        expect.objectContaining({
          agent_id: childSessionId,
          parent_agent_id: parentSessionId,
          unread_count: 1,
        }),
      ],
    });
    expect(toolResult(parentInputs[3]!, 'parent-wait-unread')).toEqual({
      timed_out: false,
      reason: 'mailbox_update',
    });
    await until(() => parentInputs.length >= 5);
    expect(toolResult(parentInputs[4]!, 'parent-wait-timeout')).toEqual({
      timed_out: true,
      reason: 'timeout',
    });
    const childState = storage.storage.sessions.loadSnapshot(childSessionId!);
    expect(childState?.turn.status).toBe('active');
    const db = new Database(databasePath, { readonly: true });
    expect(db.query('SELECT count(*) AS count FROM agent_mail_outbox').get()).toEqual({ count: 2 });
    expect(db.query('SELECT count(*) AS count FROM agent_mail_inbox').get()).toEqual({ count: 2 });
    db.close();
    childTerminalGate.resolve();
    await until(() => parentEvents().some((event) => event.type === 'run.completed'));
    expect(parentEvents().filter((event) => event.type === 'run.error')).toHaveLength(0);
    expect(
      parentEvents().filter((event) => event.type === 'agent.mail_input_prepared'),
    ).toHaveLength(2);
    const unrelated = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-unrelated-root',
      workspace,
      bootstrapSessionId: 'mail-read-unrelated',
    });
    expect(unrelated.status).toBe('applied');
    if (unrelated.status !== 'applied') throw new Error('Unrelated Session creation failed.');
    const unrelatedStarted = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-unrelated-root',
      sessionId: 'mail-read-unrelated',
      expectedRevision: unrelated.revision,
      input: 'MAIL_READ_UNRELATED',
    });
    expect(unrelatedStarted.status).toBe('applied');
    await until(() => unrelatedInputs.length >= 2);
    expect(toolResult(unrelatedInputs[1]!, 'unrelated-send')).toMatchObject({ ok: false });
    const activeStorage = storage;
    await until(() =>
      activeStorage.storage.sessions
        .loadEventsStrict('mail-read-unrelated')
        .some(({ event }) => event.type === 'run.completed'),
    );
    const after = new Database(databasePath, { readonly: true });
    expect(after.query('SELECT count(*) AS count FROM agent_mail_outbox').get()).toEqual({
      count: 2,
    });
    expect(
      activeStorage.storage.sessions
        .loadEventsStrict('mail-read-unrelated')
        .filter(({ event }) => event.type === 'agent.mail_accepted'),
    ).toHaveLength(0);
    after.close();
    model.assertComplete({ allowUnconsumedResponses: true });
  } catch (error) {
    throw new Error(
      `Mailbox stage failed: ${JSON.stringify({
        parentCalls,
        childCalls,
        failed: parentEvents()
          .filter((event) => event.type === 'run.error' || event.type === 'tool.failed')
          .map((event) => event.type),
      })}`,
      { cause: error },
    );
  } finally {
    for (const gate of childSendGates) gate.resolve();
    childTerminalGate.resolve();
    await client?.close();
    await server?.[Symbol.asyncDispose]();
    storage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}, 30_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Agent mailbox E2E did not reach its durable boundary.');
    await Bun.sleep(20);
  }
}

function toolResult(transcript: string, toolCallId: string): unknown {
  const messages = JSON.parse(transcript) as readonly {
    role?: string;
    tool_call_id?: string;
    content?: unknown;
  }[];
  const content = messages.find(
    (message) => message.role === 'tool' && message.tool_call_id === toolCallId,
  )?.content;
  if (typeof content !== 'string') throw new Error(`Tool result ${toolCallId} is absent.`);
  return JSON.parse(content) as unknown;
}
