import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  if (!check()) throw new Error(`Current-turn budget fixture did not reach ${label}.`);
}

test('formal Service retains accepted followup funding when the old child exhausts its Model budget', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-current-turn-budget-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'read.txt'), 'Read-only child tool input.\n');
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'current-turn-budget-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  let releaseLastOldModel: (() => void) | undefined;
  const lastOldModelReleased = new Promise<void>((resolve) => {
    releaseLastOldModel = resolve;
  });
  let parentCalls = 0;
  let childCalls = 0;
  const childInputs: string[] = [];
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  let failed = false;
  let cleanupError: unknown;
  const parentEvents = () =>
    storage?.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event) ?? [];
  try {
    model.setResponses(
      Array.from({ length: 32 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          if (
            transcript.includes('BUDGET_CHILD_TASK') &&
            !transcript.includes('BUDGET_PARENT_TASK')
          ) {
            childCalls += 1;
            childInputs.push(transcript);
            if (childCalls === 15) await lastOldModelReleased;
            if (childCalls > 15)
              return {
                message: { content: 'FOLLOWUP_AFTER_OLD_BUDGET' },
                expectedRequest: {
                  toolResults: [{ toolCallId: `old-budget-read-${childCalls - 1}` }],
                },
              };
            return {
              message: {
                tool_calls: [
                  {
                    id: `old-budget-read-${childCalls}`,
                    name: 'read_file',
                    args: { path: 'read.txt' },
                  },
                ],
              },
              toolContinuation: 'required' as const,
              ...(childCalls > 1
                ? {
                    expectedRequest: {
                      toolResults: [{ toolCallId: `old-budget-read-${childCalls - 1}` }],
                    },
                  }
                : {}),
              usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
            };
          }
          parentCalls += 1;
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'spawn-budget-child',
                    name: 'task',
                    args: {
                      name: 'Budget child',
                      subagent_type: 'review',
                      task: 'BUDGET_CHILD_TASK',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2) {
            await until(() => childCalls === 15, 'old child final model request');
            const childSessionId = parentEvents().find(
              (event) => event.type === 'subagent.child_session_intended',
            )?.childThreadId;
            if (!childSessionId) throw new Error('Child identity is unavailable.');
            return {
              message: {
                tool_calls: [
                  {
                    id: 'followup-budget-child',
                    name: 'followup_task',
                    args: { agent_id: childSessionId, message: 'BUDGET_FOLLOWUP_MESSAGE' },
                  },
                ],
              },
              toolContinuation: 'required' as const,
              expectedRequest: { toolResults: [{ toolCallId: 'spawn-budget-child' }] },
            };
          }
          return {
            message: { content: 'PARENT_WAITING_FOR_CHILD' },
            expectedRequest: { toolResults: [{ toolCallId: 'followup-budget-child' }] },
          };
        },
      })),
    );
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'current-turn-budget-host',
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'current-turn-budget-user',
          workspace,
          config: {
            providerName: 'current-turn-budget-model',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
            features: { resourceBudget: true, toolSearch: false },
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
      clientInfo: { name: 'current-turn-budget-test', version: '1', instanceId: 'client' },
    });
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-current-turn-budget-parent',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    if (created.status !== 'applied') throw new Error('Parent Session creation failed.');
    expect(
      await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'start-current-turn-budget-parent',
        sessionId: parentSessionId,
        expectedRevision: created.revision,
        input: 'BUDGET_PARENT_TASK',
      }),
    ).toMatchObject({ status: 'applied' });
    await until(() => childCalls === 15, 'old child Model budget exhaustion').catch(() => {
      const childId = parentEvents().find(
        (event) => event.type === 'subagent.child_session_intended',
      )?.childThreadId;
      throw new Error(
        JSON.stringify({
          parentCalls,
          childCalls,
          parentEvents: parentEvents().map((event) => event.type),
          childEvents: childId
            ? storage!.storage.sessions
                .loadEventsStrict(childId)
                .filter(
                  ({ event }) =>
                    event.type === 'run.error' || event.type === 'model.invocation_interrupted',
                )
                .map(({ event }) => event)
            : [],
        }),
      );
    });
    const childSessionId = parentEvents().find(
      (event) => event.type === 'subagent.child_session_intended',
    )?.childThreadId;
    if (!childSessionId) throw new Error('Child Session was not created.');
    await until(
      () =>
        parentEvents().some(
          (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
        ),
      'accepted TriggerTurn',
    );
    const accepted = parentEvents().find(
      (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
    );
    if (accepted?.type !== 'agent.mail_accepted' || !accepted.submissionId)
      throw new Error('Followup submission was not accepted.');
    const pending = storage.runWithSessionExecution(parentSessionId, () =>
      storage!.storage.crossSessionQueueMail.listPendingFollowupFunding(parentSessionId, 100),
    );
    const row = pending.find((item) => item.submissionId === accepted.submissionId);
    if (!row) throw new Error('Accepted followup funding was not retained.');
    const source = storage.loadCurrentSnapshot(parentSessionId);
    expect(source?.resourceBudget.status).toBe('active');
    if (source?.resourceBudget.status !== 'active')
      throw new Error('Source ledger is unavailable.');
    const fundingRunId = source.resourceBudget.runId;
    expect(source.resourceBudget.reservations[row.backupReservationId]?.state).toBe('queued');
    expect(
      storage.storage.sessions
        .loadEventsStrict(childSessionId)
        .filter(({ event }) => event.type === 'agent.followup_routed'),
    ).toHaveLength(0);
    releaseLastOldModel?.();
    await until(
      () =>
        storage!.storage.sessions
          .loadEventsStrict(childSessionId)
          .some(
            ({ event }) => event.type === 'run.error' || event.type === 'agent.followup_routed',
          ),
      'target budget terminal or followup route',
    );
    const targetEvents = storage.storage.sessions
      .loadEventsStrict(childSessionId)
      .map(({ event }) => event);
    const targetState = storage.loadCurrentSnapshot(childSessionId);
    expect(targetState?.resourceBudget.status).toBe('active');
    if (targetState?.resourceBudget.status !== 'active')
      throw new Error('Target ledger is unavailable.');
    expect(targetState.resourceBudget.budget.maxModelRequests).toBe(15);
    expect(
      targetEvents.filter((event) => event.type === 'model.invocation_attempt_started'),
    ).toHaveLength(15);
    expect(
      targetEvents.filter(
        (event) => event.type === 'agent.followup_routed' && event.route === 'current_turn',
      ),
    ).toHaveLength(0);
    expect(targetEvents.filter((event) => event.type === 'agent.mail_input_prepared')).toHaveLength(
      0,
    );
    expect(
      childInputs.slice(0, 15).every((input) => !input.includes('BUDGET_FOLLOWUP_MESSAGE')),
    ).toBe(true);
    await until(
      () =>
        storage!.runWithSessionExecution(parentSessionId, () =>
          storage!.storage.crossSessionQueueMail.readLastReleasedFollowupForDirectChild(
            parentSessionId,
            fundingRunId,
            childSessionId,
          ),
        )?.submissionId === accepted.submissionId,
      'source backup settlement',
    );
    expect(
      storage.runWithSessionExecution(parentSessionId, () =>
        storage!.storage.crossSessionQueueMail.readLastReleasedFollowupForDirectChild(
          parentSessionId,
          fundingRunId,
          childSessionId,
        ),
      ),
    ).toMatchObject({ submissionId: accepted.submissionId, reason: 'context_unavailable' });
    expect(storage.loadCurrentSnapshot(parentSessionId)?.resourceBudget).toMatchObject({
      reservations: { [row.backupReservationId]: { state: 'released' } },
    });
    expect(childCalls).toBe(15);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    releaseLastOldModel?.();
    await client?.close();
    try {
      await server?.[Symbol.asyncDispose]();
    } catch (error) {
      if (!failed) cleanupError = error;
    }
    storage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
  if (cleanupError) throw cleanupError;
}, 30_000);
