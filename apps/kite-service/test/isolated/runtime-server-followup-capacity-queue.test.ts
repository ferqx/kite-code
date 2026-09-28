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

type Outcome = 'release_slot' | 'capacity_timeout';

async function until(check: () => boolean, stage: string, waitMs = 12_000): Promise<void> {
  const deadline = Date.now() + waitMs;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  if (!check()) throw new Error(`Followup capacity fixture did not reach ${stage}.`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function cleanupUnlessAlreadyFailed(
  cleanup: () => Promise<unknown>,
  failed: boolean,
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    if (!failed) throw error;
  }
}

async function exerciseCapacity(outcome: Outcome): Promise<void> {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-followup-capacity-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const parentSessionId = 'capacity-parent';
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  const gateA = deferred();
  const gateB = deferred();
  let targetRequests = 0;
  let activeA = 0;
  let activeB = 0;
  let parentRequests = 0;
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  let failed = false;
  const parentEvents = () =>
    storage?.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event) ?? [];
  try {
    model.setResponses(
      Array.from({ length: 16 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          if (transcript.includes('CAPACITY_TARGET') && !transcript.includes('CAPACITY_PARENT')) {
            targetRequests++;
            return {
              message: {
                content:
                  targetRequests === 1 ? 'CAPACITY_TARGET_INITIAL' : 'CAPACITY_TARGET_FOLLOWUP',
              },
            };
          }
          if (transcript.includes('CAPACITY_HOLDER_A') && !transcript.includes('CAPACITY_PARENT')) {
            activeA++;
            await gateA.promise;
            return { message: { content: 'CAPACITY_HOLDER_A_DONE' } };
          }
          if (transcript.includes('CAPACITY_HOLDER_B') && !transcript.includes('CAPACITY_PARENT')) {
            activeB++;
            await gateB.promise;
            return { message: { content: 'CAPACITY_HOLDER_B_DONE' } };
          }
          parentRequests++;
          if (parentRequests === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'spawn-capacity-target',
                    name: 'task',
                    args: {
                      name: 'Followup target',
                      subagent_type: 'review',
                      task: 'CAPACITY_TARGET',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (parentRequests === 2)
            return {
              message: { content: 'Waiting for the initial target.' },
              expectedRequest: { toolResults: [{ toolCallId: 'spawn-capacity-target' }] },
            };
          if (parentRequests === 3) return { message: { content: 'Initial target settled.' } };
          if (parentRequests === 4)
            return {
              message: {
                tool_calls: (['A', 'B'] as const).map((label) => ({
                  id: `spawn-capacity-${label}`,
                  name: 'task',
                  args: {
                    name: `Capacity holder ${label}`,
                    subagent_type: 'review',
                    task: `CAPACITY_HOLDER_${label}`,
                    background: true,
                    result_disposition: 'required',
                  },
                })),
              },
              toolContinuation: 'required' as const,
            };
          if (parentRequests === 5) {
            const intended = parentEvents().find(
              (event) =>
                event.type === 'subagent.child_session_intended' &&
                event.originToolCallId === 'spawn-capacity-target',
            );
            const target =
              intended?.type === 'subagent.child_session_intended'
                ? intended.childThreadId
                : undefined;
            if (!target) throw new Error('Completed direct child target is unavailable.');
            return {
              message: {
                tool_calls: [
                  {
                    id: 'capacity-followup-tool',
                    name: 'followup_task',
                    args: { agent_id: target, message: 'CAPACITY_FOLLOWUP_INPUT' },
                  },
                ],
              },
              expectedRequest: {
                toolResults: [
                  { toolCallId: 'spawn-capacity-A' },
                  { toolCallId: 'spawn-capacity-B' },
                ],
              },
              toolContinuation: 'required' as const,
            };
          }
          return {
            message: { content: 'Parent waits for capacity holders.' },
            expectedRequest: { toolResults: [{ toolCallId: 'capacity-followup-tool' }] },
          };
        },
      })),
    );
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'capacity-host',
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'capacity-user',
          workspace,
          config: {
            providerName: 'capacity-model',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 32_768, maxOutputTokens: 64 },
            resources: { maxConcurrentSubagents: 2 },
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
      clientInfo: { name: 'capacity-followup-test', version: '1', instanceId: 'client' },
    });
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-capacity-parent',
      workspace,
      bootstrapSessionId: parentSessionId,
    });
    if (created.status !== 'applied') throw new Error('Capacity parent was not created.');
    expect(
      (
        await client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'start_turn',
          commandId: 'start-capacity-initial',
          sessionId: parentSessionId,
          expectedRevision: created.revision,
          input: 'CAPACITY_PARENT INITIAL',
        })
      ).status,
    ).toBe('applied');
    await until(
      () => parentEvents().some((event) => event.type === 'run.completed'),
      'initial target settlement',
    ).catch(() => {
      throw new Error(
        JSON.stringify({
          parentRequests,
          targetRequests,
          events: parentEvents().map((event) => event.type),
          errors: parentEvents()
            .filter((event) => event.type === 'run.error')
            .map((event) => ({ message: event.message, failure: event.failure })),
        }),
      );
    });
    await server.host.waitForSessionIdle(parentSessionId);
    const intendedTarget = parentEvents().find(
      (event) =>
        event.type === 'subagent.child_session_intended' &&
        event.originToolCallId === 'spawn-capacity-target',
    );
    const targetId =
      intendedTarget?.type === 'subagent.child_session_intended'
        ? intendedTarget.childThreadId
        : undefined;
    if (!targetId) throw new Error('Capacity target child ID is missing.');
    expect(targetRequests).toBe(1);
    const next = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-capacity-holders',
      sessionId: parentSessionId,
      expectedRevision: storage.loadCurrentSnapshot(parentSessionId)!.revision,
      input: 'CAPACITY_PARENT HOLDERS',
    });
    expect(next.status).toBe('applied');
    await until(() => activeA === 1 && activeB === 1, 'two occupied child slots');
    const source = storage.loadCurrentSnapshot(parentSessionId);
    if (!source || source.resourceBudget.status !== 'active')
      throw new Error('Funding Run is absent.');
    const fundingRunId = source.resourceBudget.runId;
    expect(source.resourceBudget.budget.maxConcurrentSubagents).toBe(2);
    const occupied = Object.values(source.resourceBudget.reservations).filter(
      (reservation) =>
        reservation.resourceKind === 'subagent' && reservation.state === 'dispatch_started',
    );
    expect(occupied).toHaveLength(2);
    await until(
      () =>
        parentEvents().some(
          (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
        ),
      'queued followup acceptance',
    ).catch(() => {
      const state = storage!.loadCurrentSnapshot(parentSessionId);
      throw new Error(
        JSON.stringify({
          parentRequests,
          activeA,
          activeB,
          targetRequests,
          followupToolStatus: state?.tools.calls['capacity-followup-tool']?.status,
          followupToolResult: state?.tools.calls['capacity-followup-tool']?.result?.resultMeta,
          reservationStates:
            state?.resourceBudget.status === 'active'
              ? Object.values(state.resourceBudget.reservations).map((reservation) => ({
                  kind: reservation.resourceKind,
                  state: reservation.state,
                  activeSubagents: reservation.executableUpperBound.gauges.activeSubagents,
                }))
              : [],
          eventTypes: parentEvents()
            .slice(-25)
            .map((event) => event.type),
        }),
      );
    });
    const accepted = parentEvents().find(
      (event) => event.type === 'agent.mail_accepted' && event.mode === 'trigger_turn',
    );
    if (accepted?.type !== 'agent.mail_accepted' || !accepted.submissionId)
      throw new Error('Followup was not durably accepted.');
    expect(accepted.targetAgentId).toBe(targetId);
    const backup = Object.values(
      storage.loadCurrentSnapshot(parentSessionId)?.resourceBudget.status === 'active'
        ? storage.loadCurrentSnapshot(parentSessionId)!.resourceBudget.reservations
        : {},
    ).find((reservation) => reservation.invocationId === accepted.submissionId);
    expect(backup).toMatchObject({
      state: 'queued',
      resourceKind: 'subagent',
      runId: fundingRunId,
    });
    expect(targetRequests).toBe(1);
    if (outcome === 'release_slot') {
      gateA.resolve();
      await until(() => targetRequests === 2, 'one resumed target Model');
      await until(
        () =>
          storage!.storage.sessions
            .loadEventsStrict(targetId)
            .some(({ event }) => event.type === 'agent.followup_turn_settled'),
        'followup terminal',
      );
      const targetEvents = storage.storage.sessions
        .loadEventsStrict(targetId)
        .map(({ event }) => event);
      expect(targetEvents.filter((event) => event.type === 'agent.followup_routed')).toEqual([
        expect.objectContaining({ route: 'new_turn', submissionId: accepted.submissionId }),
      ]);
      expect(
        targetEvents.filter((event) => event.type === 'agent.followup_turn_settled'),
      ).toHaveLength(1);
      expect(targetRequests).toBe(2);
    } else {
      await until(
        () =>
          storage!.runWithSessionExecution(
            parentSessionId,
            () =>
              storage!.storage.crossSessionQueueMail.readLastReleasedFollowupForDirectChild(
                parentSessionId,
                fundingRunId,
                targetId,
              )?.reason === 'capacity_timeout',
          ),
        'capacity timeout settlement',
        20_000,
      );
      expect(targetRequests).toBe(1);
      expect(storage.loadCurrentSnapshot(parentSessionId)?.resourceBudget).toMatchObject({
        reservations: { [backup!.reservationId]: { state: 'released' } },
      });
      expect(
        storage.runWithSessionExecution(targetId, () =>
          storage!.storage.crossSessionQueueMail.readFollowupRoute(
            targetId,
            accepted.submissionId!,
          ),
        ),
      ).toBeNull();
    }
    model.assertComplete({ allowUnconsumedResponses: true });
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    gateA.resolve();
    gateB.resolve();
    const holderIds = parentEvents().flatMap((event) =>
      event.type === 'subagent.child_session_intended' &&
      (event.originToolCallId === 'spawn-capacity-A' ||
        event.originToolCallId === 'spawn-capacity-B')
        ? [event.childThreadId]
        : [],
    );
    await cleanupUnlessAlreadyFailed(async () => {
      if (holderIds.length > 0)
        await until(
          () =>
            holderIds.every((id) =>
              storage!.storage.sessions
                .loadEventsStrict(id)
                .some(({ event }) => event.type === 'subagent.child_terminal_sealed'),
            ),
          'holder cleanup',
        );
    }, failed);
    await client?.close();
    await cleanupUnlessAlreadyFailed(async () => server?.[Symbol.asyncDispose](), failed);
    storage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
}

test(
  'two occupied child slots queue a followup until one slot releases',
  () => exerciseCapacity('release_slot'),
  45_000,
);
test(
  'two occupied child slots expire a queued followup without target dispatch',
  () => exerciseCapacity('capacity_timeout'),
  45_000,
);
