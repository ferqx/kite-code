import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type {
  RuntimeServerAdmissionInput,
  RuntimeServerAdmissionPort,
} from '@kite-ai/runtime-server';
import {
  listPendingCrossSessionFollowupFunding,
  readPreparedCrossSessionFollowupRecoveryProof,
} from '../../../../../packages/runtime-storage-sqlite/src/kite-cross-session-followup';
import { createMockModelServer } from '../../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../../src/bootstrap';

const parentSessionId = 'orchestrator-parent';

function childAndSubmission(databasePath: string): {
  childSessionId: string;
  submissionId: string;
} {
  const database = new Database(databasePath, { readonly: true });
  try {
    const child = database
      .query<{ child_thread_id: string }, []>(
        'SELECT child_thread_id FROM child_session_intents LIMIT 1',
      )
      .get();
    const mail = database
      .query<{ submission_id: string }, []>(
        "SELECT submission_id FROM agent_mail_outbox WHERE mode='trigger_turn' LIMIT 1",
      )
      .get();
    if (!child || !mail) throw new Error('Synthetic D3 crash fixture lacks child or submission.');
    return { childSessionId: child.child_thread_id, submissionId: mail.submission_id };
  } finally {
    database.close();
  }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Synthetic D3 process did not reach its durable boundary.');
}

for (const stage of ['prepared', 'activated', 'attempt_started'] as const)
  test(`SIGKILL TriggerTurn from durable ${stage} stage`, async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-d3-sigkill-'));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    const databasePath = join(home, 'kite-session.sqlite');
    const marker = join(home, 'stage.marker');
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = home;
    const model = createMockModelServer();
    let childModelRequests = 0;
    let parentToolProduced = false;
    model.setResponses(
      Array.from({ length: 12 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          if (transcript.includes('Resume the completed child.')) {
            childModelRequests += 1;
            return {
              message: { content: 'FOLLOWUP_CHILD_RESULT' },
              usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
            };
          }
          if (transcript.includes('ORCHESTRATED_CHILD_TASK'))
            return { message: { content: 'ORCHESTRATED_CHILD_RESULT' } };
          if (!parentToolProduced) {
            parentToolProduced = true;
            const database = new Database(databasePath, { readonly: true });
            let childId: string;
            try {
              const row = database
                .query<{ child_thread_id: string }, []>(
                  'SELECT child_thread_id FROM child_session_intents LIMIT 1',
                )
                .get();
              if (!row) throw new Error('Synthetic child was not durably registered.');
              childId = row.child_thread_id;
            } finally {
              database.close();
            }
            return {
              message: {
                tool_calls: [
                  {
                    id: 'followup-tool',
                    name: 'followup_task',
                    args: { agent_id: childId, message: 'Resume the completed child.' },
                  },
                ],
              },
              toolContinuation: 'aborted' as const,
            };
          }
          return { message: { content: 'Parent remained available.' } };
        },
      })),
    );
    const crashed = Bun.spawn(
      [
        process.execPath,
        'test',
        '--test-name-pattern',
        '^completed child permits a real parent Model Surface for a followup Tool attempt$',
        join(import.meta.dir, '../cross-session-followup-new-turn.test.ts'),
        '--parallel=1',
        '--max-concurrency=1',
      ],
      {
        cwd: join(import.meta.dir, '../../../../..'),
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          KITE_D3_SIGKILL_HOME: home,
          KITE_D3_SIGKILL_MOCK_URL: model.baseURL,
          KITE_D3_SIGKILL_STAGE: stage,
        },
      },
    );
    let storage:
      | Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>>
      | undefined;
    let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
    let client: RuntimeClient | undefined;
    try {
      await until(() => existsSync(marker)).catch(async (error) => {
        if (crashed.exitCode === null) crashed.kill('SIGKILL');
        await crashed.exited;
        throw new Error(`D3 seed process failed: ${await new Response(crashed.stderr).text()}`, {
          cause: error,
        });
      });
      const ids = childAndSubmission(databasePath);
      crashed.kill('SIGKILL');
      await crashed.exited;
      expect(childModelRequests).toBe(0);
      if (stage === 'activated') {
        const readOnly = new Database(databasePath, { readonly: true });
        try {
          const pending = listPendingCrossSessionFollowupFunding(readOnly, parentSessionId, 10);
          expect(pending).toMatchObject([{ stage: 'activated', submissionId: ids.submissionId }]);
          const proof = readPreparedCrossSessionFollowupRecoveryProof(
            readOnly,
            ids.childSessionId,
            parentSessionId,
            ids.submissionId,
          );
          expect(proof).not.toBeNull();
          expect(pending[0]?.targetRunId).toBe(proof?.targetRunId);
          expect(pending[0]?.modelInvocationId).toBe(proof?.invocationId);
        } finally {
          readOnly.close();
        }
      }
      await Bun.sleep(1_200);
      storage = await createKiteSessionAppServerStorageComposition({
        databasePath,
        hostInstanceId: `d3-sigkill-recovered-${stage}`,
        executionLeaseMs: 1_000,
        renewIntervalMs: 200,
      });
      const beforeTargetEvents = storage.storage.sessions
        .loadEventsStrict(ids.childSessionId)
        .map(({ event }) => event);
      const beforePrepared = beforeTargetEvents.filter(
        (event) => event.type === 'model.invocation_prepared',
      );
      const beforeAttempts = beforeTargetEvents.filter(
        (event) => event.type === 'model.invocation_attempt_started',
      );
      expect(beforePrepared).toHaveLength(2);
      expect(beforeAttempts).toHaveLength(stage === 'attempt_started' ? 2 : 1);
      const admission: RuntimeServerAdmissionPort = Object.freeze({
        authorize: async (_request: RuntimeServerAdmissionInput) => ({
          allowed: true as const,
          workspace,
        }),
      });
      server = createKiteMultiWorkspaceRuntimeServer({
        checkpointPath: databasePath,
        storageOwner: storage,
        workspaces: [
          {
            userId: 'orchestrator-user',
            workspace,
            config: {
              providerName: 'fixture',
              providerType: 'openai-compatible' as const,
              apiKey: 'fixture-key',
              baseURL: model.baseURL,
              modelName: 'mock-model',
              modelKwargs: { maxOutputTokens: 64 },
              modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
              features: { resourceBudget: true },
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
      const currentServer = server;
      const transport: RuntimeClientTransport = Object.freeze({
        connect: async () => {
          const pair = currentServer.open({ admission });
          return Object.freeze({
            send: (message: RuntimeProtocolMessage) => pair.client.send(message),
            messages: () => pair.client.messages(),
            close: (reason?: string) => pair.client.close(reason),
          });
        },
      });
      client = new RuntimeClient({
        transport,
        clientInfo: { name: 'd3-sigkill-test', version: '1', instanceId: 'client' },
      });
      await client.connect();
      const resumed = await client
        .command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'resume_session',
          commandId: `resume-d3-after-${stage}`,
          sessionId: parentSessionId,
        })
        .catch((error) => {
          throw new Error(
            JSON.stringify({
              commandErrorName: error instanceof Error ? error.name : typeof error,
              commandErrorMessage: error instanceof Error ? error.message : String(error),
              protocolError: (error as { protocol?: { data?: unknown } }).protocol?.data,
              sourceEvents: storage!.storage.sessions
                .loadEventsStrict(parentSessionId)
                .slice(-14)
                .map(({ event }) => event.type),
              targetEvents: storage!.storage.sessions
                .loadEventsStrict(ids.childSessionId)
                .slice(-12)
                .map(({ event }) => event.type),
              childModelRequests,
            }),
            { cause: error },
          );
        });
      if (resumed.status !== 'applied')
        throw new Error(
          JSON.stringify({
            resumeStatus: resumed.status,
            resumeCode: 'code' in resumed ? resumed.code : null,
            sourceEvents: storage.storage.sessions
              .loadEventsStrict(parentSessionId)
              .slice(-16)
              .map(({ event }) => event.type),
            targetEvents: storage.storage.sessions
              .loadEventsStrict(ids.childSessionId)
              .slice(-12)
              .map(({ event }) => event.type),
            targetProof: (() => {
              try {
                return storage!.runWithSessionExecution(ids.childSessionId, () =>
                  Boolean(
                    storage!.storage.crossSessionQueueMail.readPreparedFollowupRecoveryProof(
                      ids.childSessionId,
                      parentSessionId,
                      ids.submissionId,
                    ),
                  ),
                );
              } catch {
                return 'authority_unavailable';
              }
            })(),
          }),
        );
      if (stage === 'activated') {
        await until(() =>
          storage!.storage.sessions
            .loadEventsStrict(ids.childSessionId)
            .some(({ event }) => event.type === 'agent.followup_turn_settled'),
        ).catch((error) => {
          throw new Error(
            JSON.stringify({
              childEvents: storage!.storage.sessions
                .loadEventsStrict(ids.childSessionId)
                .slice(-18)
                .map(({ event }) => event.type),
              sourceEvents: storage!.storage.sessions
                .loadEventsStrict(parentSessionId)
                .slice(-18)
                .map(({ event }) => event.type),
              childModelRequests,
            }),
            { cause: error },
          );
        });
        expect(childModelRequests).toBe(1);
        expect(
          storage.storage.sessions
            .loadEventsStrict(ids.childSessionId)
            .filter(({ event }) => event.type === 'model.invocation_attempt_started'),
        ).toHaveLength(2);
        await until(() =>
          storage!.runWithSessionExecution(
            parentSessionId,
            () =>
              storage!.storage.crossSessionQueueMail.readFollowupTerminalForSource(
                parentSessionId,
                ids.submissionId,
              ) !== null,
          ),
        ).catch((error) => {
          throw new Error(
            JSON.stringify({
              targetEvents: storage!.storage.sessions
                .loadEventsStrict(ids.childSessionId)
                .slice(-12)
                .map(({ event }) => event.type),
              sourceEvents: storage!.storage.sessions
                .loadEventsStrict(parentSessionId)
                .slice(-12)
                .map(({ event }) => event.type),
            }),
            { cause: error },
          );
        });
        expect(
          storage.runWithSessionExecution(parentSessionId, () =>
            storage!.storage.crossSessionQueueMail.readFollowupTerminalForSource(
              parentSessionId,
              ids.submissionId,
            ),
          )?.disposition,
        ).toBe('completed');
      } else if (stage === 'attempt_started') {
        await until(() =>
          storage!.storage.sessions
            .loadEventsStrict(ids.childSessionId)
            .some(({ event }) => event.type === 'agent.followup_turn_settled'),
        ).catch((error) => {
          throw new Error(
            JSON.stringify({
              targetEvents: storage!.storage.sessions
                .loadEventsStrict(ids.childSessionId)
                .slice(-16)
                .map(({ event }) => event.type),
              sourceEvents: storage!.storage.sessions
                .loadEventsStrict(parentSessionId)
                .slice(-12)
                .map(({ event }) => event.type),
              childModelRequests,
            }),
            { cause: error },
          );
        });
        const targetSettled = storage.storage.sessions
          .loadEventsStrict(ids.childSessionId)
          .map(({ event }) => event)
          .find((event) => event.type === 'agent.followup_turn_settled');
        expect(targetSettled).toMatchObject({ status: 'unknown' });
        expect(
          storage.storage.sessions
            .loadEventsStrict(ids.childSessionId)
            .filter(({ event }) => event.type === 'task.failed'),
        ).toHaveLength(1);
        await until(() =>
          storage!.runWithSessionExecution(
            parentSessionId,
            () =>
              storage!.storage.crossSessionQueueMail.readFollowupTerminalForSource(
                parentSessionId,
                ids.submissionId,
              ) !== null,
          ),
        ).catch((error) => {
          throw new Error(
            JSON.stringify({
              targetEvents: storage!.storage.sessions
                .loadEventsStrict(ids.childSessionId)
                .slice(-12)
                .map(({ event }) => event.type),
              sourceEvents: storage!.storage.sessions
                .loadEventsStrict(parentSessionId)
                .slice(-12)
                .map(({ event }) => event.type),
            }),
            { cause: error },
          );
        });
        expect(
          storage.runWithSessionExecution(parentSessionId, () =>
            storage!.storage.crossSessionQueueMail.readFollowupTerminalForSource(
              parentSessionId,
              ids.submissionId,
            ),
          )?.disposition,
        ).toBe('unknown');
        expect(childModelRequests).toBe(0);
        expect(
          storage.storage.sessions
            .loadEventsStrict(ids.childSessionId)
            .filter(({ event }) => event.type === 'model.invocation_attempt_started'),
        ).toHaveLength(beforeAttempts.length);
      } else {
        await Bun.sleep(500);
        expect(childModelRequests).toBe(0);
        expect(
          storage.storage.sessions
            .loadEventsStrict(ids.childSessionId)
            .map(({ event }) => event)
            .filter((event) => event.type === 'model.invocation_prepared'),
        ).toEqual(beforePrepared);
        expect(
          storage.storage.sessions
            .loadEventsStrict(ids.childSessionId)
            .filter(({ event }) => event.type === 'model.invocation_attempt_started'),
        ).toHaveLength(beforeAttempts.length);
        expect(
          storage.storage.sessions
            .loadEventsStrict(ids.childSessionId)
            .filter(({ event }) => event.type === 'agent.followup_turn_settled'),
        ).toHaveLength(0);
      }
      expect(ids.submissionId).toMatch(/^submission_/u);
    } finally {
      if (crashed.exitCode === null) crashed.kill('SIGKILL');
      await crashed.exited;
      await client?.close();
      await server?.[Symbol.asyncDispose]();
      storage?.disposeStorage();
      model.stop();
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
