import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type { RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../../src/bootstrap';

const parentSessionId = 'orchestrator-parent';

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Synthetic current-turn process did not reach its boundary.');
}

for (const stage of ['current_turn_routed', 'current_turn_prepared'] as const)
  test(`SIGKILL ${stage} current-turn Model resumes the same invocation once`, async () => {
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
          if (transcript.includes('ORCHESTRATED_CHILD_TASK')) {
            childModelRequests += 1;
            return {
              message: { content: 'CURRENT_TURN_RESTARTED_RESULT' },
              usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
            };
          }
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
                    args: {
                      agent_id: childId,
                      message: 'Resume the active child before its first model.',
                    },
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
        '^same mode revision routes an active zero Tool child mail into its first Model$',
        join(import.meta.dir, '../cross-session-followup-current-turn.test.ts'),
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
        throw new Error(
          `Current-turn seed process failed: ${await new Response(crashed.stderr).text()}`,
          {
            cause: error,
          },
        );
      });
      crashed.kill('SIGKILL');
      await crashed.exited;
      expect(childModelRequests).toBe(0);
      const database = new Database(databasePath, { readonly: true });
      let childSessionId: string;
      let submissionId: string;
      let invocationId: string;
      try {
        const child = database
          .query<{ child_thread_id: string }, []>(
            'SELECT child_thread_id FROM child_session_intents LIMIT 1',
          )
          .get();
        const route = database
          .query<{ submission_id: string; invocation_id: string; route: string }, []>(
            'SELECT submission_id,invocation_id,route FROM agent_followup_routes LIMIT 1',
          )
          .get();
        if (!child || !route) throw new Error('Current-turn durable route is absent.');
        expect(route.route).toBe('current_turn');
        childSessionId = child.child_thread_id;
        submissionId = route.submission_id;
        invocationId = route.invocation_id;
        const releaseRow = database
          .query<{ source_revision: number | null }, []>(
            'SELECT current_turn_release_source_revision AS source_revision FROM agent_mail_outbox LIMIT 1',
          )
          .get();
        expect(releaseRow?.source_revision === null).toBe(stage === 'current_turn_routed');
        const sourceSnapshot = database
          .query<{ state_json: string }, []>(
            "SELECT state_json FROM runtime_snapshots WHERE session_id='orchestrator-parent'",
          )
          .get();
        const sourceBudget = sourceSnapshot
          ? (
              JSON.parse(sourceSnapshot.state_json) as {
                resourceBudget?: { reservations?: Record<string, { state?: string }> };
              }
            ).resourceBudget
          : undefined;
        const backupStates = Object.entries(sourceBudget?.reservations ?? {})
          .filter(([id]) => id.startsWith('backup_'))
          .map(([, reservation]) => reservation.state);
        expect(backupStates).toEqual([stage === 'current_turn_routed' ? 'queued' : 'released']);
        const prepared = database
          .query<{ count: number }, [string, string]>(
            `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
           AND json_extract(event_json,'$.type')='model.invocation_prepared'
           AND json_extract(event_json,'$.invocationId')=?`,
          )
          .get(childSessionId, invocationId)?.count;
        const attempted = database
          .query<{ count: number }, [string, string]>(
            `SELECT count(*) AS count FROM runtime_events WHERE session_id=?
           AND json_extract(event_json,'$.type')='model.invocation_attempt_started'
           AND json_extract(event_json,'$.invocationId')=?`,
          )
          .get(childSessionId, invocationId)?.count;
        expect(prepared).toBe(1);
        expect(attempted).toBe(0);
      } finally {
        database.close();
      }
      await Bun.sleep(1_200);
      storage = await createKiteSessionAppServerStorageComposition({
        databasePath,
        hostInstanceId: 'current-turn-sigkill-recovered',
        executionLeaseMs: 1_000,
        renewIntervalMs: 200,
      });
      const admission: RuntimeServerAdmissionPort = Object.freeze({
        authorize: async () => ({ allowed: true as const, workspace }),
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
        clientInfo: { name: 'current-turn-sigkill-test', version: '1', instanceId: 'client' },
      });
      await client.connect();
      const resumed = await client
        .command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'resume_session',
          commandId: 'resume-current-turn-after-sigkill',
          sessionId: parentSessionId,
        })
        .catch((error) => {
          throw new Error(
            JSON.stringify({
              errorName: error instanceof Error ? error.name : 'unknown',
              protocolData:
                error && typeof error === 'object' && 'protocol' in error ? error.protocol : null,
              parentEvents: storage!.storage.sessions
                .loadEventsStrict(parentSessionId)
                .slice(-12)
                .map(({ event }) => event.type),
              childEvents: storage!.storage.sessions
                .loadEventsStrict(childSessionId)
                .slice(-14)
                .map(({ event }) => event.type),
              childStatus: storage!.loadCurrentSnapshot(childSessionId)?.turn.status,
              childModelStatus:
                storage!.loadCurrentSnapshot(childSessionId)?.modelInvocations[invocationId]
                  ?.status,
              childModelRequests,
            }),
            { cause: error },
          );
        });
      expect(resumed.status).toBe('applied');
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(childSessionId)
          .some(({ event }) => event.type === 'subagent.child_terminal_sealed'),
      );
      const events = storage.storage.sessions
        .loadEventsStrict(childSessionId)
        .map(({ event }) => event);
      expect(
        events.filter(
          (event) =>
            event.type === 'model.invocation_prepared' && event.invocationId === invocationId,
        ),
      ).toHaveLength(1);
      expect(
        events.filter(
          (event) =>
            event.type === 'model.invocation_attempt_started' &&
            event.invocationId === invocationId,
        ),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === 'agent.followup_routed')).toHaveLength(1);
      expect(events.filter((event) => event.type === 'agent.mail_input_prepared')).toHaveLength(1);
      expect(
        storage.storage.sessions
          .loadEventsStrict(parentSessionId)
          .filter(
            ({ event }) =>
              event.type === 'resource_budget.released' &&
              event.reservationId.startsWith('backup_'),
          ),
      ).toHaveLength(1);
      expect(childModelRequests).toBe(1);
      expect(
        storage.loadCurrentSnapshot(childSessionId)?.childSessionOrigin?.terminal?.status,
      ).toBe('completed');
      expect(
        storage.runWithSessionExecution(childSessionId, () =>
          storage!.storage.crossSessionQueueMail.readFollowupRoute(childSessionId, submissionId),
        )?.invocationId,
      ).toBe(invocationId);
    } finally {
      if (crashed.exitCode === null) crashed.kill('SIGKILL');
      await crashed.exited;
      await client?.close().catch(() => undefined);
      await server?.[Symbol.asyncDispose]();
      storage?.close();
      await model.stop();
      process.env.KITE_CODE_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  }, 40_000);
