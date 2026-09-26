import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_, RUNTIME_QUERY_SCHEMA_ } from '@kite-ai/runtime-contract';
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

test('after_turn current_turn reply reaches the new parent Run once after original result import', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-after-turn-independent-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'after-turn-input.txt'), 'A safe file for the active child.\n');
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'after-turn-independent-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  const childGate = deferred();
  const childStarted = deferred();
  let parentCalls = 0;
  let childCalls = 0;
  let replyInput = '';
  let rootRunId: string | undefined;
  let humanRunId: string | undefined;
  let childSessionId: string | undefined;
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  let reachedTerminal = false;
  const parentEvents = () =>
    storage?.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event) ?? [];
  try {
    model.setResponses(
      Array.from({ length: 10 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          if (
            transcript.includes('INDEPENDENT_AFTER_TURN_CHILD') &&
            !transcript.includes('INDEPENDENT_AFTER_TURN_PARENT')
          ) {
            childCalls += 1;
            if (childCalls === 1) {
              childStarted.resolve();
              await childGate.promise;
              return {
                message: {
                  tool_calls: [
                    {
                      id: 'after-turn-current-read',
                      name: 'read_file',
                      args: { path: 'after-turn-input.txt' },
                    },
                  ],
                },
                toolContinuation: 'required' as const,
              };
            }
            return {
              message: { content: 'INDEPENDENT_AFTER_TURN_FOLLOWUP_RESULT' },
              expectedRequest: { toolResults: [{ toolCallId: 'after-turn-current-read' }] },
            };
          }
          parentCalls += 1;
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'independent-after-turn-start',
                    name: 'task',
                    args: {
                      name: 'Independent after turn reviewer',
                      subagent_type: 'review',
                      task: 'INDEPENDENT_AFTER_TURN_CHILD',
                      background: true,
                      result_disposition: 'after_turn',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2)
            return {
              message: { content: 'Initial parent Run complete.' },
              expectedRequest: { toolResults: [{ toolCallId: 'independent-after-turn-start' }] },
            };
          expect(transcript).not.toContain('<subagent_result task_id=');
          if (parentCalls === 3) {
            childSessionId = parentEvents().find(
              (event) => event.type === 'subagent.child_session_intended',
            )?.childThreadId;
            if (!childSessionId) throw new Error('Independent child Session was not intended.');
            return {
              message: {
                tool_calls: [
                  {
                    id: 'independent-after-turn-followup',
                    name: 'followup_task',
                    args: {
                      agent_id: childSessionId,
                      message: 'INDEPENDENT_AFTER_TURN_PRIVATE_FOLLOWUP',
                    },
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
            );
            return {
              message: {
                tool_calls: [{ id: 'independent-after-turn-list', name: 'list_agents', args: {} }],
              },
              toolContinuation: 'required' as const,
              expectedRequest: { toolResults: [{ toolCallId: 'independent-after-turn-followup' }] },
            };
          }
          replyInput = transcript;
          return {
            message: { content: 'Human Run received explicit reply.' },
            expectedRequest: { toolResults: [{ toolCallId: 'independent-after-turn-list' }] },
          };
        },
      })),
    );
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'after-turn-independent-host',
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'after-turn-independent-user',
          workspace,
          config: {
            providerName: 'after-turn-independent-model',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 32_768, maxOutputTokens: 64 },
            features: { resourceBudget: true, afterTurnContinuation: true, toolSearch: false },
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
    client = new RuntimeClient({
      transport: Object.freeze({
        connect: async () => {
          const pair = server!.open({ admission });
          return Object.freeze({
            send: (message: RuntimeProtocolMessage) => pair.client.send(message),
            messages: () => pair.client.messages(),
            close: (reason?: string) => pair.client.close(reason),
          });
        },
      }),
      clientInfo: { name: 'after-turn-independent-test', version: '1', instanceId: 'client' },
    });
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'after-turn-independent-create',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Parent Session creation failed.');
    expect(
      await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'after-turn-independent-root-start',
        sessionId: parentSessionId,
        expectedRevision: created.revision,
        input: 'INDEPENDENT_AFTER_TURN_PARENT_ROOT',
      }),
    ).toMatchObject({ status: 'applied' });
    await until(() => parentEvents().some((event) => event.type === 'run.completed'));
    await server.host.waitForSessionIdle(parentSessionId);
    await Promise.race([
      childStarted.promise,
      Bun.sleep(12_000).then(() => {
        throw new Error('Independent child first Model did not start.');
      }),
    ]);
    rootRunId = parentEvents().find((event) => event.type === 'run.completed')?.turnId;
    childSessionId = parentEvents().find(
      (event) => event.type === 'subagent.child_session_intended',
    )?.childThreadId;
    expect(rootRunId).toBeDefined();
    expect(childSessionId).toBeDefined();
    expect(parentCalls).toBe(2);
    const background = await client.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'list_background_executions',
      sessionId: parentSessionId,
    });
    expect(background).toMatchObject({
      status: 'ok',
      backgroundSnapshot: {
        executions: expect.arrayContaining([
          expect.objectContaining({ kind: 'subagent', status: 'running' }),
        ]),
      },
    });
    const projected = await client.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'get_session_projection',
      sessionId: parentSessionId,
    });
    expect(projected.status).toBe('ok');
    if (projected.status !== 'ok' || !projected.session)
      throw new Error('Parent Session projection is missing.');
    expect(
      await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'after-turn-independent-human-start',
        sessionId: parentSessionId,
        expectedRevision: projected.session.revision,
        input: 'INDEPENDENT_AFTER_TURN_PARENT_HUMAN',
      }),
    ).toMatchObject({ status: 'applied' });
    await until(
      () =>
        parentEvents().filter(
          (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
        ).length === 1,
    );
    childGate.resolve();
    await until(
      () => parentEvents().filter((event) => event.type === 'run.completed').length === 2,
    );
    const events = parentEvents();
    const runs = events.filter((event) => event.type === 'run.completed');
    humanRunId = runs[1]?.turnId;
    expect(humanRunId).toBeDefined();
    expect(humanRunId).not.toBe(rootRunId);
    expect(parentCalls).toBe(5);
    expect(childCalls).toBe(2);
    expect(replyInput).toContain('<agent_message');
    expect(replyInput).toContain('agent_terminal_reply');
    expect(replyInput).not.toContain('<subagent_result task_id=');
    expect(events.filter((event) => event.type === 'turn.started')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'run.completed')).toHaveLength(2);
    expect(events.filter((event) => event.type === 'run.error')).toHaveLength(0);
    expect(
      events.filter(
        (event) =>
          event.type === 'subagent.child_terminal_imported' &&
          event.childThreadId === childSessionId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter(
        (event) =>
          event.type === 'subagent.background_result_persisted' && event.originRunId === rootRunId,
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === 'agent.mail_accepted' && event.mode === 'reply'),
    ).toHaveLength(1);
    const childEvents = storage.storage.sessions
      .loadEventsStrict(childSessionId!)
      .map(({ event }) => event);
    expect(
      childEvents.filter(
        (event) => event.type === 'agent.followup_routed' && event.route === 'current_turn',
      ),
    ).toHaveLength(1);
    expect(
      childEvents.filter((event) => event.type === 'agent.followup_turn_settled'),
    ).toHaveLength(1);
    expect(childEvents.filter((event) => event.type === 'agent.mail_input_prepared')).toHaveLength(
      1,
    );
    expect(replyInput.match(/<agent_message/g)).toHaveLength(1);
    const reportReservationId = events.find(
      (event) => event.type === 'subagent.background_result_persisted',
    )?.afterTurn?.reservationId;
    expect(reportReservationId).toBeDefined();
    await until(() =>
      parentEvents().some(
        (event) =>
          event.type === 'resource_budget.released' && event.reservationId === reportReservationId,
      ),
    );
    expect(parentEvents().filter((event) => event.type === 'turn.started')).toHaveLength(2);
    model.assertComplete({ allowUnconsumedResponses: true });
    reachedTerminal = true;
  } finally {
    childGate.resolve();
    if (!reachedTerminal) {
      try {
        await Promise.race([
          until(() =>
            parentEvents().some((event) => event.type === 'subagent.child_terminal_imported'),
          ),
          Bun.sleep(3_000),
        ]);
      } catch {
        // Keep the first test failure visible if cleanup cannot settle.
      }
    }
    if (reachedTerminal) await client?.close();
    else await client?.close().catch(() => undefined);
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
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('After-turn independent child missed a boundary.');
    await Bun.sleep(20);
  }
}
