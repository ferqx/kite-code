import { Database } from 'bun:sqlite';
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

async function exerciseFormalCurrentTurnBoundary(
  role: 'review' | 'code',
  eagerFollowup = false,
  secondChildModel = false,
  unsafeToolAfterRoute = false,
): Promise<void> {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-current-turn-boundary-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'boundary-input.txt'), 'Boundary child may read this file.\n');
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'current-turn-boundary-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  let releaseFirstChildModel: (() => void) | undefined;
  const firstChildModelReleased = new Promise<void>((resolve) => {
    releaseFirstChildModel = resolve;
  });
  let parentCalls = 0;
  let childCalls = 0;
  let childCallsAtFollowupResponse = -1;
  const childToolSurfaces: string[][] = [];
  const childInputs: string[] = [];
  const parentInputs: string[] = [];
  const shellCommands: string[] = [];
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  let failed = false;
  let cleanupError: unknown;
  const parentEvents = () =>
    storage?.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event) ?? [];
  try {
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
          if (
            transcript.includes('CURRENT_BOUNDARY_CHILD') &&
            !transcript.includes('CURRENT_BOUNDARY_PARENT')
          ) {
            childCalls++;
            childInputs.push(transcript);
            childToolSurfaces.push(
              Array.isArray(body.tools)
                ? body.tools.flatMap((entry) => {
                    const name = (entry as { function?: { name?: string } }).function?.name;
                    return name ? [name] : [];
                  })
                : [],
            );
            if (childCalls === 1) await firstChildModelReleased;
            if (childCalls === 1 && secondChildModel)
              return {
                message: {
                  tool_calls: [
                    {
                      id: 'current-boundary-read',
                      name: 'read_file',
                      args: { path: 'boundary-input.txt' },
                    },
                  ],
                },
                toolContinuation: 'required' as const,
              };
            if (childCalls === 2 && unsafeToolAfterRoute)
              return {
                message: {
                  tool_calls: [
                    {
                      id: 'current-boundary-unsafe-shell',
                      name: 'shell_execute',
                      args: { command: 'printf forbidden' },
                    },
                  ],
                },
                toolContinuation: 'required' as const,
                expectedRequest: { toolResults: [{ toolCallId: 'current-boundary-read' }] },
              };
            return {
              message: {
                content: childCalls === 1 ? 'FIRST_CHILD_FINAL' : 'FOLLOWUP_CHILD_FINAL',
              },
              ...(secondChildModel && childCalls > 1
                ? {
                    expectedRequest: {
                      toolResults: [
                        {
                          toolCallId:
                            unsafeToolAfterRoute && childCalls > 2
                              ? 'current-boundary-unsafe-shell'
                              : 'current-boundary-read',
                        },
                      ],
                    },
                  }
                : {}),
              usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
            };
          }
          parentCalls++;
          parentInputs.push(transcript);
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'start-current-boundary-child',
                    name: 'task',
                    args: {
                      name: 'Boundary child',
                      subagent_type: role,
                      task: 'CURRENT_BOUNDARY_CHILD',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2) {
            if (!eagerFollowup) await until(() => childCalls === 1);
            childCallsAtFollowupResponse = childCalls;
            const childSessionId = parentEvents().find(
              (event) => event.type === 'subagent.child_session_intended',
            )?.childThreadId;
            if (!childSessionId) throw new Error('The child Session identity is unavailable.');
            return {
              message: {
                tool_calls: [
                  {
                    id: 'followup-current-boundary-child',
                    name: 'followup_task',
                    args: { agent_id: childSessionId, message: 'CURRENT_BOUNDARY_FOLLOWUP' },
                  },
                ],
              },
              toolContinuation: 'required' as const,
              expectedRequest: { toolResults: [{ toolCallId: 'start-current-boundary-child' }] },
            };
          }
          if (secondChildModel && !unsafeToolAfterRoute && parentCalls === 3)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'wait-for-current-turn-reply',
                    name: 'wait_agent',
                    args: { timeout_ms: 10_000 },
                  },
                ],
              },
              toolContinuation: 'required' as const,
              expectedRequest: {
                toolResults: [{ toolCallId: 'followup-current-boundary-child' }],
              },
            };
          return {
            message: { content: 'PARENT_PROVISIONAL_FINAL' },
            expectedRequest: {
              toolResults: [
                {
                  toolCallId:
                    secondChildModel && !unsafeToolAfterRoute
                      ? 'wait-for-current-turn-reply'
                      : 'followup-current-boundary-child',
                },
              ],
            },
          };
        },
      })),
    );
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'current-turn-boundary-host',
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'current-turn-boundary-user',
          workspace,
          config: {
            providerName: 'current-turn-boundary-model',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 32_768, maxOutputTokens: 64 },
            features: { resourceBudget: true, toolSearch: false },
            sandbox: { enabled: false },
          },
          shellExecutor: async ({ command }: { command: string }) => {
            shellCommands.push(command);
            return {
              ok: true as const,
              command,
              exitCode: 0,
              stdout: '',
              stderr: '',
            };
          },
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
      clientInfo: { name: 'current-turn-boundary-test', version: '1', instanceId: 'client' },
    });
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-current-boundary-parent',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Parent Session creation failed.');
    let parentRevision = created.revision;
    if (role === 'code') {
      const changed = await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'set_interaction_mode',
        commandId: 'current-boundary-parent-auto',
        sessionId: parentSessionId,
        expectedRevision: parentRevision,
        mode: 'auto',
      });
      expect(changed.status).toBe('applied');
      if (changed.status !== 'applied') throw new Error('Parent auto mode was not committed.');
      parentRevision = changed.revision;
    }
    expect(
      await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'start-current-boundary-parent',
        sessionId: parentSessionId,
        expectedRevision: parentRevision,
        input: 'CURRENT_BOUNDARY_PARENT',
      }),
    ).toMatchObject({ status: 'applied' });
    if (!eagerFollowup) await until(() => childCalls === 1);
    else
      await until(() =>
        parentEvents().some((event) => event.type === 'subagent.child_session_intended'),
      );
    const childSessionId = parentEvents().find(
      (event) => event.type === 'subagent.child_session_intended',
    )?.childThreadId;
    if (!childSessionId) throw new Error('The child Session was not registered.');
    expect(storage.loadCurrentSnapshot(parentSessionId)?.interactionModeRevision).toBe(
      role === 'code' ? 1 : 0,
    );
    expect(storage.loadCurrentSnapshot(childSessionId)?.interactionModeRevision).toBe(0);
    expect(storage.loadCurrentSnapshot(childSessionId)?.childSessionOrigin?.role).toBe(role);
    if (!eagerFollowup)
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(childSessionId)
          .some(({ event }) => event.type === 'model.invocation_attempt_started'),
      );
    const sealed = storage.runWithSessionExecution(parentSessionId, () =>
      storage!.readChildSealedGrant(childSessionId),
    );
    if (!sealed) throw new Error('The child grant was not sealed.');
    const grant = JSON.parse(sealed.sealedGrantJson) as {
      capabilityCeiling?: { allowedTools?: string[] };
    };
    if (role === 'review') expect(grant.capabilityCeiling?.allowedTools?.length).toBeGreaterThan(0);
    else expect(grant.capabilityCeiling?.allowedTools).toEqual([]);
    if (!eagerFollowup) expect(childToolSurfaces[0]?.length).toBeGreaterThan(0);
    if (role === 'code') {
      await until(() =>
        parentEvents().some((event) => event.type === 'resource_budget.waiter_enqueued'),
      );
      expect(
        parentEvents().filter(
          (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
        ),
      ).toHaveLength(0);
      releaseFirstChildModel?.();
    }
    await until(() =>
      parentEvents().some(
        (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
      ),
    );
    const accepted = parentEvents().find(
      (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
    );
    if (accepted?.type !== 'agent.mail_accepted' || !accepted.submissionId)
      throw new Error('The parent followup was not accepted.');
    const acceptedSubmissionId = accepted.submissionId;
    expect(accepted.targetAgentId).toBe(childSessionId);
    if (eagerFollowup) expect(childCallsAtFollowupResponse).toBe(1);
    if (eagerFollowup) await until(() => childCalls === 1);
    expect(childToolSurfaces[0]?.length).toBeGreaterThan(0);
    const beforeRelease = storage.storage.sessions
      .loadEventsStrict(childSessionId)
      .map(({ event }) => event);
    const currentTurnRoutes = beforeRelease.filter(
      (event) => event.type === 'agent.followup_routed' && event.route === 'current_turn',
    );
    expect(currentTurnRoutes).toHaveLength(0);
    if (eagerFollowup) expect(childInputs[0]).not.toContain('CURRENT_BOUNDARY_FOLLOWUP');
    expect(
      beforeRelease.filter((event) => event.type === 'model.invocation_attempt_started').length,
    ).toBeGreaterThanOrEqual(1);
    if (secondChildModel)
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(childSessionId)
          .some(
            ({ event }) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
          ),
      );
    releaseFirstChildModel?.();
    if (secondChildModel) {
      await until(() => childCalls >= 2);
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(childSessionId)
          .some(
            ({ event }) => event.type === 'agent.followup_routed' && event.route === 'current_turn',
          ),
      );
      expect(childInputs[1]).toContain('CURRENT_BOUNDARY_FOLLOWUP');
      expect(childToolSurfaces[1]).toContain('read_file');
      expect(childToolSurfaces[1]).not.toContain('shell_execute');
      expect(childToolSurfaces[1]).not.toContain('read_mcp_resource');
      const resumedEvents = storage.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      expect(
        resumedEvents.filter((event) => event.type === 'agent.followup_turn_prepared'),
      ).toHaveLength(0);
      expect(
        resumedEvents.filter((event) => event.type === 'agent.mail_input_prepared'),
      ).toHaveLength(1);
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(childSessionId)
          .some(({ event }) => event.type === 'subagent.child_terminal_sealed'),
      );
      if (!unsafeToolAfterRoute) {
        await until(() =>
          storage!.storage.sessions
            .loadEventsStrict(childSessionId)
            .some(
              ({ event }) =>
                event.type === 'agent.followup_turn_settled' &&
                event.submissionId === accepted.submissionId,
            ),
        );
        await until(() =>
          parentEvents().some(
            (event) => event.type === 'agent.mail_accepted' && event.mode === 'reply',
          ),
        ).catch((error) => {
          const routed = storage!.storage.sessions
            .loadEventsStrict(childSessionId)
            .map(({ event }) => event.type);
          throw new Error(
            `${String(error)} parent=${JSON.stringify(parentEvents().map((event) => event.type))} child=${JSON.stringify(routed)}`,
          );
        });
        expect(
          parentEvents().filter(
            (event) => event.type === 'agent.mail_accepted' && event.mode === 'reply',
          ),
        ).toHaveLength(1);
        expect(
          parentEvents().filter((event) => event.type === 'subagent.child_terminal_imported'),
        ).toHaveLength(1);
        await until(() => parentInputs.some((input) => input.includes('agent_terminal_reply')));
        expect(parentInputs.filter((input) => input.includes('agent_terminal_reply'))).toHaveLength(
          1,
        );
        expect(storage.listUnrepliedSettledFollowupTerminalSources(100)).toEqual([]);
        const replayed = storage.runWithSessionExecution(childSessionId, () =>
          storage!.storage.crossSessionQueueMail.acceptFollowupTerminalReply(
            childSessionId,
            parentSessionId,
            acceptedSubmissionId,
            Date.now(),
          ),
        );
        expect(replayed.messageId).toBeTruthy();
        expect(storage.listUnrepliedSettledFollowupTerminalSources(100)).toEqual([]);
        const inspection = new Database(databasePath, { readonly: true });
        try {
          expect(
            inspection
              .query<{ count: number }, [string]>(
                "SELECT count(*) AS count FROM agent_mail_outbox WHERE mode='reply' AND source_effect_attempt_id=?",
              )
              .get(accepted.submissionId),
          ).toEqual({ count: 1 });
        } finally {
          inspection.close();
        }
      }
      if (unsafeToolAfterRoute) {
        await until(() =>
          parentEvents().some((event) => event.type === 'subagent.child_terminal_imported'),
        );
        expect(
          storage!.storage.sessions
            .loadEventsStrict(childSessionId)
            .filter(
              ({ event }) =>
                event.type === 'agent.followup_turn_settled' &&
                event.submissionId === acceptedSubmissionId &&
                event.status === 'unknown',
            ),
        ).toHaveLength(1);
        expect(
          parentEvents().filter(
            (event) => event.type === 'agent.mail_accepted' && event.mode === 'reply',
          ),
        ).toHaveLength(0);
        expect(shellCommands).toEqual([]);
        expect(
          storage.storage.sessions
            .loadEventsStrict(childSessionId)
            .some(
              ({ event }) =>
                (event.type === 'tool.rejected' || event.type === 'tool.failed') &&
                event.toolCallId === 'current-boundary-unsafe-shell',
            ),
        ).toBe(true);
      }
    } else {
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(childSessionId)
          .some(({ event }) => event.type === 'subagent.child_terminal_sealed'),
      );
      const childEvents = storage.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      expect(
        childEvents.filter(
          (event) => event.type === 'agent.followup_routed' && event.route === 'current_turn',
        ),
      ).toHaveLength(0);
      expect(
        childEvents.filter((event) => event.type === 'model.invocation_attempt_started').length,
      ).toBeGreaterThanOrEqual(1);
      expect(childEvents.filter((event) => event.type === 'run.error')).toHaveLength(0);
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    releaseFirstChildModel?.();
    try {
      await client?.close();
    } catch (error) {
      if (!failed) cleanupError = error;
    }
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
}

test(
  'formal review child cannot route an accepted followup into its attempted first Model',
  () => exerciseFormalCurrentTurnBoundary('review'),
  30_000,
);

test(
  'formal code child with an empty unrestricted grant and independent mode revision cannot enter zero Tool current_turn',
  () => exerciseFormalCurrentTurnBoundary('code'),
  30_000,
);

test(
  'formal eager followup still arrives after a review child first Model attempt',
  () => exerciseFormalCurrentTurnBoundary('review', true),
  30_000,
);

test(
  'formal review child consumes an accepted followup in its next read-only Model',
  () => exerciseFormalCurrentTurnBoundary('review', false, true),
  30_000,
);

test(
  'formal review child rejects an unadvertised shell Tool after current_turn routing',
  () => exerciseFormalCurrentTurnBoundary('review', false, true, true),
  30_000,
);

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Formal current-turn boundary was not reached.');
    await Bun.sleep(20);
  }
}
