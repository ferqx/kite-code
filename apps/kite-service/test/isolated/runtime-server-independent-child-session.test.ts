import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { childThreadIdForToolAttempt } from '@kite-ai/agent-kernel';
import { classifyBuiltinShellIntent } from '@kite-ai/builtin-runtime';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import {
  RUNTIME_COMMAND_SCHEMA_,
  RUNTIME_QUERY_SCHEMA_,
  type RuntimeAccessNotification,
} from '@kite-ai/runtime-contract';
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
import { APP_PREPARED_SHELL_EXECUTION_ } from '../../src/sandbox/prepared-tool-pipeline';

for (const terminalAction of ['complete', 'stop', 'approve'] as const)
  test(`required background Task uses an independent Session and can ${terminalAction}`, async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-independent-child-'));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    const databasePath = join(home, 'kite-session.sqlite');
    const shellExecutor = async ({ command }: { command: string }) => ({
      ok: true as const,
      command,
      exitCode: 0,
      stdout: '',
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
            stdout: '',
            stderr: '',
            intent: classifyBuiltinShellIntent(prepared.command),
            executionPhase: 'go_started' as const,
          }),
      }),
    });
    const parentSessionId = 'independent-child-parent';
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = home;
    const model = createMockModelServer();
    const childGate = deferred();
    let childModelRequests = 0;
    let parentModelRequests = 0;
    model.setResponses(
      Array.from({ length: 8 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          if (
            transcript.includes('ISOLATED_CHILD_TASK') &&
            !transcript.includes('ISOLATED_PARENT')
          ) {
            childModelRequests += 1;
            if (terminalAction === 'approve' && childModelRequests === 1)
              return {
                message: {
                  tool_calls: [
                    {
                      id: 'approved-child-tool',
                      name: 'shell_execute',
                      args: { command: 'echo hello > /outside-workspace/output' },
                    },
                  ],
                },
                toolContinuation: 'required' as const,
              };
            if (terminalAction !== 'approve') await childGate.promise;
            return {
              message: { content: 'ISOLATED_CHILD_RESULT' },
              ...(terminalAction === 'approve'
                ? {
                    expectedRequest: {
                      toolResults: [{ toolCallId: 'approved-child-tool' }],
                    },
                  }
                : {}),
            };
          }
          parentModelRequests += 1;
          if (parentModelRequests === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'start-independent-child',
                    name: 'task',
                    args: {
                      name: 'Independent reviewer',
                      subagent_type: terminalAction === 'approve' ? 'code' : 'review',
                      task: 'ISOLATED_CHILD_TASK',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (transcript.includes('ISOLATED_CHILD_RESULT'))
            return { message: { content: 'Independent child result received.' } };
          return {
            message: { content: 'Waiting for required independent child.' },
            ...(parentModelRequests === 2
              ? {
                  expectedRequest: {
                    toolResults: [{ toolCallId: 'start-independent-child' }],
                  },
                }
              : {}),
          };
        },
      })),
    );
    const storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'independent-child-host',
    });
    const server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'independent-child-user',
          workspace,
          config: {
            providerName: 'independent-child-model',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
            features: { resourceBudget: true },
            sandbox: { enabled: terminalAction === 'approve' },
          },
          shellExecutor,
          interactionMode: 'accept_edits' as const,
          sandboxBackend: terminalAction === 'approve' ? ('seatbelt' as const) : ('none' as const),
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
      clientInfo: { name: 'independent-child-test', version: '1', instanceId: 'client' },
    });
    const parentEvents = () =>
      storage.storage.sessions.loadEventsStrict(parentSessionId).map(({ event }) => event);
    let reachedTerminal = false;
    let stage = 'create_session';
    let approvalNotifications: AsyncIterator<RuntimeAccessNotification> | undefined;
    try {
      const created = await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'create_session',
        commandId: 'create-independent-parent',
        workspace,
        bootstrapSessionId: parentSessionId,
      });
      expect(created.status).toBe('applied');
      if (created.status !== 'applied') throw new Error('Parent Session creation failed.');
      if (terminalAction === 'approve') {
        const stream = await client.subscribeReady({
          spec: { scope: 'session', sessionId: parentSessionId },
        });
        approvalNotifications = stream[Symbol.asyncIterator]();
      }
      stage = 'start_turn';
      const started = await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'start-independent-parent',
        sessionId: parentSessionId,
        expectedRevision: created.revision,
        input: 'ISOLATED_PARENT',
      });
      expect(started.status).toBe('applied');
      stage = 'wait_parent_task';

      await until(() =>
        parentEvents().some(
          (event) =>
            event.type === 'capability.subagent_dispatch_intent_recorded' &&
            event.taskArtifact !== undefined,
        ),
      ).catch(() => {
        const failures = parentEvents().filter(
          (event) =>
            event.type === 'tool.failed' ||
            event.type === 'capability.execution_unknown' ||
            event.type === 'run.error',
        );
        throw new Error(
          `Parent did not admit an independent Task: ${JSON.stringify(failures).replaceAll('fixture-key', '[redacted]')}`,
        );
      });
      const dispatch = parentEvents().find(
        (event) => event.type === 'capability.subagent_dispatch_intent_recorded',
      );
      if (dispatch?.type !== 'capability.subagent_dispatch_intent_recorded')
        throw new Error('Parent did not persist the Task dispatch intent.');
      const childThreadId = childThreadIdForToolAttempt({
        parentSessionId,
        parentInvocationId: dispatch.invocationId,
        parentToolCallId: 'start-independent-child',
        attempt: dispatch.attempt,
      });
      await until(() => storage.readChildSessionIntent(childThreadId) !== null);
      await until(
        () => storage.readChildSessionIntent(childThreadId)?.childSessionCreated === true,
      );
      const intent = storage.readChildSessionIntent(childThreadId);
      expect(intent).toMatchObject({
        parentSessionId,
        childThreadId,
        childSessionCreated: true,
      });
      expect(storage.readSessionLineage(childThreadId)).toEqual({ parentSessionId });
      const childList = await client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'list_child_sessions',
        sessionId: parentSessionId,
        limit: 10,
      });
      expect(childList.status).toBe('ok');
      if (childList.status !== 'ok') throw new Error('Parent child Session tree is unavailable.');
      expect(childList.childSessions).toContainEqual(
        expect.objectContaining({
          sessionId: childThreadId,
          parentSessionId,
          agentId: intent?.childInvocationId,
          taskId: intent?.childInvocationId,
        }),
      );
      const childDetail = await client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_child_session_projection',
        sessionId: parentSessionId,
        childSessionId: childThreadId,
      });
      expect(childDetail).toMatchObject({
        status: 'ok',
        queryType: 'get_child_session_projection',
        session: { sessionId: childThreadId },
      });
      const childHistory = createKiteRuntimeObserverHistoryClient(
        () => storage.openHistoryLogs(runtimeHostCurrentStateEventTypes()),
        (parent, child) =>
          storage.openChildSessionHistoryLogs(parent, child, runtimeHostCurrentStateEventTypes()),
      );
      expect(
        (await childHistory.loadChildSession!(parentSessionId, childThreadId)).session.sessionId,
      ).toBe(childThreadId);
      await expect(
        childHistory.loadChildSession!('wrong-parent', childThreadId),
      ).rejects.toMatchObject({ code: 'session_not_found' });
      await until(() => storage.readChildSessionIntent(childThreadId)?.dispatchAckEventId != null);
      expect(
        storage.loadCurrentSnapshot(childThreadId)?.childSessionOrigin?.taskInputAdmitted,
      ).toBe(true);
      await until(() => childModelRequests > 0);
      expect(storage.listCurrentSessions('', 10).map((entry) => entry.threadId)).not.toContain(
        childThreadId,
      );
      const whileChildRuns = <T>(work: Promise<T>): Promise<T> =>
        Promise.race([
          work,
          Bun.sleep(2_000).then(() => {
            throw new Error('Parent Session query waited for the child model to finish.');
          }),
        ]);
      const parentProjection = await whileChildRuns(
        client.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_session_projection',
          sessionId: parentSessionId,
        }),
      );
      expect(parentProjection.status).toBe('ok');
      const background = await whileChildRuns(
        client.query({
          schema: 'kite.runtime-query.v1',
          type: 'list_background_executions',
          sessionId: parentSessionId,
        }),
      );
      expect(background.status).toBe('ok');
      if (background.status !== 'ok') throw new Error('Parent background query failed.');
      const childExecution = background.backgroundSnapshot?.executions.find(
        (execution) => execution.executionId === intent?.childInvocationId,
      );
      expect(childExecution).toMatchObject({
        sessionId: parentSessionId,
        executionId: intent?.childInvocationId,
        kind: 'subagent',
        status: 'running',
      });

      if (terminalAction === 'approve') {
        stage = 'wait_child_approval_proxy';
        await until(
          () => storage.listPendingChildApprovalProxies(parentSessionId, 10).length === 1,
        ).catch(() => {
          throw new Error(
            JSON.stringify({
              childStatus: storage.loadCurrentSnapshot(childThreadId)?.turn.status,
              childAbort: storage.loadCurrentSnapshot(childThreadId)?.turn.abortReason,
              childEvents: storage.storage.sessions
                .loadEventsStrict(childThreadId)
                .map(({ event }) =>
                  event.type === 'tool.rejected'
                    ? { type: event.type, reason: event.reason, failure: event.failure }
                    : event.type,
                ),
              proxyCount: storage.listPendingChildApprovalProxies(parentSessionId, 10).length,
            }),
          );
        });
        stage = 'query_child_approval';
        const projected = await client.query({
          schema: RUNTIME_QUERY_SCHEMA_,
          type: 'get_session_projection',
          sessionId: parentSessionId,
        });
        if (projected.status !== 'ok')
          throw new Error('Parent approval projection is unavailable.');
        const visibleApproval = projected.session?.interactionQueue.interactions.find(
          (entry) => entry.kind === 'approval' && entry.owner.kind === 'subagent_tool',
        );
        const proxy = storage.listPendingChildApprovalProxies(parentSessionId, 10)[0];
        let notified = false;
        for (let index = 0; approvalNotifications && index < 80; index += 1) {
          const item = await Promise.race([
            approvalNotifications.next(),
            Bun.sleep(2_000).then(() => {
              throw new Error('Parent approval notification did not arrive.');
            }),
          ]);
          if (item.done) throw new Error('Parent approval subscription closed.');
          if (
            'durability' in item.value &&
            item.value.durability === 'durable' &&
            item.value.projection.session.interactionQueue.interactions.some(
              (interaction) => interaction.interactionId === proxy?.proxyInteractionId,
            )
          ) {
            notified = true;
            break;
          }
        }
        expect(notified).toBe(true);
        const approval = visibleApproval;
        if (approval?.kind !== 'approval') throw new Error('Child approval is hidden.');
        expect(approval).toMatchObject({
          owner: {
            kind: 'subagent_tool',
            subagentId: intent?.childInvocationId,
            parentToolCallId: 'start-independent-child',
            toolCallId: 'approved-child-tool',
          },
          grants: ['approve_once'],
        });
        expect(parentEvents()).toContainEqual(
          expect.objectContaining({
            type: 'subagent.child_approval_proxy_changed',
            proxyInteractionId: approval.interactionId,
            status: 'pending',
          }),
        );
        expect(
          parentEvents().filter(
            (event) =>
              event.type === 'subagent.child_approval_proxy_changed' &&
              event.proxyInteractionId === approval.interactionId &&
              event.status === 'pending',
          ),
        ).toHaveLength(1);
        expect(JSON.stringify(approval)).not.toContain(childThreadId);
        stage = 'respond_child_approval';
        const response = await Promise.race([
          client.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'respond_interaction',
            commandId: 'approve-independent-child-tool',
            sessionId: parentSessionId,
            expectedRevision: approval.sessionRevision,
            interaction: approval,
            response: { kind: 'approval', decision: 'approve_once' },
          }),
          Bun.sleep(4_000).then(() => {
            throw new Error('Parent approval command timed out.');
          }),
        ]);
        expect(response.status).toBe('applied');
        expect(parentEvents()).toContainEqual(
          expect.objectContaining({
            type: 'subagent.child_approval_proxy_changed',
            proxyInteractionId: approval.interactionId,
            status: 'decided',
          }),
        );
        expect(
          parentEvents().filter(
            (event) =>
              event.type === 'subagent.child_approval_proxy_changed' &&
              event.proxyInteractionId === approval.interactionId &&
              event.status === 'decided',
          ),
        ).toHaveLength(1);
        let settledNotification = false;
        for (let index = 0; approvalNotifications && index < 80; index += 1) {
          const item = await Promise.race([
            approvalNotifications.next(),
            Bun.sleep(2_000).then(() => {
              throw new Error('Parent approval settlement notification did not arrive.');
            }),
          ]);
          if (item.done) throw new Error('Parent approval subscription closed before settlement.');
          if (
            'durability' in item.value &&
            item.value.durability === 'durable' &&
            item.value.revision > approval.sessionRevision &&
            !item.value.projection.session.interactionQueue.interactions.some(
              (interaction) => interaction.interactionId === approval.interactionId,
            )
          ) {
            settledNotification = true;
            break;
          }
        }
        expect(settledNotification).toBe(true);
        expect(visibleApproval).toBeTruthy();
      } else if (terminalAction === 'stop') {
        if (!childExecution) throw new Error('Independent child is absent from the parent query.');
        const stop = await whileChildRuns(
          client.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'stop_background_execution',
            commandId: 'stop-independent-child',
            sessionId: parentSessionId,
            expectedRevision: childExecution.sessionRevision,
            executionId: childExecution.executionId,
            executionKind: childExecution.kind,
            expectedExecutionRevision: childExecution.revision,
            expectedOwnerGeneration: childExecution.ownerGeneration,
          }),
        );
        expect(stop.status).toBe('applied');
      } else {
        childGate.resolve();
      }
      stage = 'wait_child_terminal_import';
      await until(() =>
        parentEvents().some((event) => event.type === 'subagent.child_terminal_imported'),
      );
      const child = storage.loadCurrentSnapshot(childThreadId);
      expect(child?.childSessionOrigin?.terminal?.status).toBe(
        terminalAction === 'stop' ? 'cancelled' : 'completed',
      );
      const checkpointDb = new Database(databasePath, { readonly: true });
      try {
        const row = checkpointDb
          .query<
            {
              artifact_id: string | null;
              integrity_identifier: string | null;
              byte_length: number | null;
            },
            [string]
          >(`SELECT latest_checkpoint_artifact_id AS artifact_id,
          latest_checkpoint_integrity_identifier AS integrity_identifier,
          latest_checkpoint_byte_length AS byte_length FROM agent_nodes
          WHERE session_id=? AND agent_id=session_id`)
          .get(childThreadId);
        if (terminalAction === 'stop') {
          expect(row?.artifact_id ?? null).toBeNull();
        } else {
          expect(row?.artifact_id).toMatch(/^pa_[a-f0-9]{64}$/u);
          if (
            !row?.artifact_id ||
            !row.integrity_identifier ||
            row.byte_length === null ||
            !child?.childSessionOrigin
          )
            throw new Error('Completed child has no durable checkpoint reference.');
          const stored = storage.artifactStore.readSubagentCheckpoint({
            artifactId: row.artifact_id,
            kind: 'subagent_checkpoint',
            integrityIdentifier: row.integrity_identifier,
            byteLength: row.byte_length,
          });
          const payload = JSON.parse(stored.canonicalJson) as {
            terminalRevision: number;
            terminalTaskId: string;
            transcriptDigest: string;
            transcript: unknown;
          };
          expect(payload.terminalRevision).toBe(child.revision);
          expect(payload.terminalTaskId).toBe(child.childSessionOrigin.childInvocationId);
          expect(payload.transcript).toEqual(child.transcript);
          expect(payload.transcriptDigest).toBe(
            `sha256:${createHash('sha256').update(JSON.stringify(child.transcript)).digest('hex')}`,
          );
        }
      } finally {
        checkpointDb.close();
      }
      expect(parentEvents()).toContainEqual(
        expect.objectContaining({
          type: 'subagent.background_result_persisted',
          childTerminalStatus: terminalAction === 'stop' ? 'cancelled' : 'completed',
        }),
      );
      if (terminalAction === 'stop') {
        const stopped = await client.query({
          schema: 'kite.runtime-query.v1',
          type: 'get_background_execution',
          sessionId: parentSessionId,
          executionId: intent?.childInvocationId ?? '',
        });
        expect(stopped.status).toBe('ok');
        if (stopped.status !== 'ok') throw new Error('Independent child detail query failed.');
        expect(stopped.backgroundExecution).toMatchObject({
          status: 'cancelled',
          cleanupConfirmed: true,
        });
        expect(childModelRequests).toBe(1);
      }
      reachedTerminal = true;
    } catch (error) {
      if (terminalAction === 'approve') {
        try {
          const background = await client.query({
            schema: RUNTIME_QUERY_SCHEMA_,
            type: 'list_background_executions',
            sessionId: parentSessionId,
          });
          const running =
            background.status === 'ok'
              ? background.backgroundSnapshot?.executions.find(
                  (entry) => entry.kind === 'subagent' && entry.status === 'running',
                )
              : undefined;
          if (running)
            await Promise.race([
              client.command({
                schema: RUNTIME_COMMAND_SCHEMA_,
                type: 'stop_background_execution',
                commandId: 'cleanup-stalled-approval-child',
                sessionId: parentSessionId,
                expectedRevision: running.sessionRevision,
                executionId: running.executionId,
                executionKind: running.kind,
                expectedExecutionRevision: running.revision,
                expectedOwnerGeneration: running.ownerGeneration,
              }),
              Bun.sleep(3_000),
            ]);
        } catch {
          /* Preserve the original assertion failure. */
        }
      }
      throw new Error(
        `Independent child scenario failed at ${stage}: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    } finally {
      childGate.resolve();
      await client.close();
      await server[Symbol.asyncDispose]();
      storage.disposeStorage();
      if (reachedTerminal) model.assertComplete({ allowUnconsumedResponses: true });
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

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Independent child did not reach the next durable boundary.');
}
