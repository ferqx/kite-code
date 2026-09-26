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

test('formal AppServer exposes followup_task and admits one completed-child new turn', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-followup-server-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'followup-formal-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  let parentCalls = 0;
  let childCalls = 0;
  let invalidCalls = 0;
  const parentToolSurfaces: string[][] = [];
  const parentInputs: string[] = [];
  const parentEvents = () =>
    storage?.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event) ?? [];
  try {
    model.setResponses(
      Array.from({ length: 12 }, () => ({
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
                const name = (entry as { function?: { name?: string } }).function?.name;
                return name ? [name] : [];
              })
            : [];
          if (transcript.includes('FORMAL_INVALID_TARGET')) {
            invalidCalls++;
            if (invalidCalls === 1)
              return {
                message: {
                  tool_calls: [
                    {
                      id: 'invalid-followup',
                      name: 'followup_task',
                      args: { agent_id: 'missing-child', message: 'No recipient.' },
                    },
                  ],
                },
                toolContinuation: 'required' as const,
              };
            return {
              message: { content: 'INVALID_TARGET_REJECTED' },
              expectedRequest: { toolResults: [{ toolCallId: 'invalid-followup' }] },
            };
          }
          if (transcript.includes('FORMAL_LATER_PARENT')) {
            parentInputs.push(transcript);
            return { message: { content: 'LATER_PARENT_DONE' } };
          }
          if (
            transcript.includes('FORMAL_FOLLOWUP_CHILD') &&
            !transcript.includes('FORMAL_FOLLOWUP_PARENT')
          ) {
            childCalls++;
            if (childCalls === 2)
              await until(() => parentEvents().some((event) => event.type === 'run.completed'));
            return {
              message: {
                content: childCalls === 1 ? 'CHILD_INITIAL_FINAL' : 'CHILD_FOLLOWUP_FINAL',
              },
            };
          }
          parentCalls++;
          parentToolSurfaces.push(toolNames);
          parentInputs.push(transcript);
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'spawn-followup-child',
                    name: 'task',
                    args: {
                      name: 'Followup child',
                      subagent_type: 'review',
                      task: 'FORMAL_FOLLOWUP_CHILD',
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
              expectedRequest: { toolResults: [{ toolCallId: 'spawn-followup-child' }] },
            };
          }
          if (parentCalls === 3) {
            const childSessionId = parentEvents().find(
              (event) => event.type === 'subagent.child_session_intended',
            )?.childThreadId;
            if (!childSessionId) throw new Error('The intended child Session is unavailable.');
            return {
              message: {
                tool_calls: [
                  {
                    id: 'parent-followup',
                    name: 'followup_task',
                    args: {
                      agent_id: childSessionId,
                      message: 'FORMAL_PRIVATE_FOLLOWUP',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          }
          return {
            message: { content: 'PARENT_FOLLOWUP_DONE' },
            expectedRequest: { toolResults: [{ toolCallId: 'parent-followup' }] },
          };
        },
      })),
    );
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'followup-formal-host',
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'followup-user',
          workspace,
          config: {
            providerName: 'followup-model',
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
      clientInfo: { name: 'formal-followup-test', version: '1', instanceId: 'client' },
    });
    const invalid = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-invalid-followup',
      workspace,
      bootstrapSessionId: 'invalid-followup-root',
    });
    expect(invalid.status).toBe('applied');
    if (invalid.status !== 'applied') throw new Error('Invalid target Session creation failed.');
    const invalidStarted = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-invalid-followup',
      sessionId: 'invalid-followup-root',
      expectedRevision: invalid.revision,
      input: 'FORMAL_INVALID_TARGET',
    });
    expect(invalidStarted.status).toBe('applied');
    await until(() =>
      storage!.storage.sessions
        .loadEventsStrict('invalid-followup-root')
        .some(({ event }) => event.type === 'run.completed'),
    );
    const invalidEvents = storage.storage.sessions
      .loadEventsStrict('invalid-followup-root')
      .map(({ event }) => event);
    expect(invalidEvents.filter((event) => event.type === 'agent.mail_accepted')).toHaveLength(0);
    expect(
      invalidEvents.find(
        (event) => event.type === 'tool.rejected' && event.toolCallId === 'invalid-followup',
      ),
    ).toBeDefined();

    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-followup-parent',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Parent Session creation failed.');
    const started = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-followup-parent',
      sessionId: parentSessionId,
      expectedRevision: created.revision,
      input: 'FORMAL_FOLLOWUP_PARENT',
    });
    expect(started.status).toBe('applied');
    await until(() =>
      parentEvents().some(
        (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
      ),
    );
    const accepted = parentEvents().find(
      (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
    );
    if (accepted?.type !== 'agent.mail_accepted' || !accepted.submissionId)
      throw new Error('Parent followup Tool did not durably accept.');
    const submissionId = accepted.submissionId;
    const childSessionId = accepted.targetAgentId;
    expect(parentToolSurfaces[0]).toContain('followup_task');
    expect(parentToolSurfaces[1]).toContain('followup_task');
    expect(
      parentEvents().filter(
        (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
      ),
    ).toHaveLength(1);
    const followupTool = parentEvents().find(
      (event) => event.type === 'tool.finished' && event.toolCallId === 'parent-followup',
    );
    expect(followupTool?.type).toBe('tool.finished');
    if (followupTool?.type === 'tool.finished')
      expect(followupTool.result).toMatchObject({ ok: true, stdout: '', stderr: '' });
    await until(() =>
      storage!.storage.sessions
        .loadEventsStrict(childSessionId)
        .some(({ event }) => event.type === 'agent.followup_turn_settled'),
    );
    await until(() =>
      storage!.runWithSessionExecution(
        parentSessionId,
        () =>
          storage!.storage.crossSessionQueueMail.readFollowupTerminalForSource(
            parentSessionId,
            submissionId,
          )?.disposition === 'completed',
      ),
    );
    await until(
      () =>
        parentEvents().filter(
          (event) => event.type === 'agent.mail_accepted' && event.mode === 'reply',
        ).length === 1,
    );
    const childEvents = storage.storage.sessions
      .loadEventsStrict(childSessionId)
      .map(({ event }) => event);
    const settledFollowup = childEvents.find(
      (event) => event.type === 'agent.followup_turn_settled',
    );
    if (settledFollowup?.type !== 'agent.followup_turn_settled')
      throw new Error('Followup terminal event is unavailable.');
    expect(childEvents.filter((event) => event.type === 'agent.followup_routed')).toContainEqual(
      expect.objectContaining({ route: 'new_turn' }),
    );
    expect(childEvents.filter((event) => event.type === 'agent.mail_input_prepared')).toHaveLength(
      1,
    );
    expect(
      childEvents.filter((event) => event.type === 'model.invocation_attempt_started'),
    ).toHaveLength(2);
    expect(childCalls).toBe(2);
    expect(parentEvents().filter((event) => event.type === 'run.error')).toHaveLength(0);
    expect(childEvents.filter((event) => event.type === 'run.error')).toHaveLength(0);
    const inspection = new Database(databasePath, { readonly: true });
    expect(
      inspection.query('SELECT mode,count(*) AS count FROM agent_mail_outbox GROUP BY mode').all(),
    ).toEqual([
      { mode: 'reply', count: 1 },
      { mode: 'trigger_turn', count: 1 },
    ]);
    expect(inspection.query('SELECT count(*) AS count FROM agent_mail_inbox').get()).toEqual({
      count: 2,
    });
    expect(
      inspection
        .query<{ target_run_id: string | null }, [string, string]>(
          `SELECT target_run_id FROM agent_mail_outbox
           WHERE source_session_id=? AND mode='reply' AND source_run_id=?`,
        )
        .get(childSessionId, settledFollowup.targetRunId),
    ).toEqual({ target_run_id: null });
    inspection.close();

    await until(() => parentEvents().some((event) => event.type === 'run.completed'));

    const laterRevision = storage.loadCurrentSnapshot(parentSessionId)?.revision;
    if (laterRevision === undefined) throw new Error('Parent Session revision is unavailable.');
    const laterStarted = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-later-parent',
      sessionId: parentSessionId,
      expectedRevision: laterRevision,
      input: 'FORMAL_LATER_PARENT',
    });
    expect(laterStarted.status).toBe('applied');
    await until(
      () => parentEvents().filter((event) => event.type === 'run.completed').length === 2,
    );

    const after = new Database(databasePath, { readonly: true });
    expect(after.query('SELECT count(*) AS count FROM agent_mail_outbox').get()).toEqual({
      count: 2,
    });
    expect(
      after
        .query<{ prepared_invocation_id: string | null }, [string, string]>(
          `SELECT i.prepared_invocation_id FROM agent_mail_inbox i
           JOIN agent_mail_outbox o ON o.message_id=i.message_id
            AND o.source_session_id=i.source_session_id
           WHERE o.source_session_id=? AND o.source_run_id=? AND o.mode='reply'`,
        )
        .get(childSessionId, settledFollowup.targetRunId),
    ).toEqual({ prepared_invocation_id: null });
    after.close();
    expect(parentInputs.length).toBeGreaterThanOrEqual(2);
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
    if (Date.now() > deadline)
      throw new Error('Formal followup did not reach its durable boundary.');
    await Bun.sleep(20);
  }
}
