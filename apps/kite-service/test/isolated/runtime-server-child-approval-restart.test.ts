import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyBuiltinShellIntent } from '@kite-ai/builtin-runtime';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
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
import { APP_PREPARED_SHELL_EXECUTION_ } from '../../src/sandbox/prepared-tool-pipeline';

for (const decisionWindow of ['pending', 'decided'] as const)
  test(`SIGKILL child approval recovery from durable ${decisionWindow} proxy`, async () => {
    const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-child-approval-restart-'));
    const workspace = join(home, 'workspace');
    mkdirSync(workspace);
    const databasePath = join(home, 'kite-session.sqlite');
    const marker = join(home, 'approval.marker');
    const parentSessionId = 'child-approval-restart-parent';
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = home;
    const model = createMockModelServer();
    let childRequests = 0;
    let parentRequests = 0;
    let shellCalls = 0;
    model.setResponses(
      Array.from({ length: 30 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const transcript = JSON.stringify(messages);
          if (
            transcript.includes('APPROVAL_RESTART_CHILD') &&
            !transcript.includes('APPROVAL_RESTART_PARENT')
          ) {
            childRequests += 1;
            if (childRequests === 1)
              return {
                message: {
                  tool_calls: [
                    {
                      id: 'approval-restart-shell',
                      name: 'shell_execute',
                      args: { command: 'echo hello > /outside-workspace/output' },
                    },
                  ],
                },
                toolContinuation: 'required' as const,
              };
            return {
              message: { content: 'APPROVAL_RESTART_CHILD_RESULT' },
              expectedRequest: { toolResults: [{ toolCallId: 'approval-restart-shell' }] },
            };
          }
          parentRequests += 1;
          if (parentRequests === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'approval-restart-task',
                    name: 'task',
                    args: {
                      name: 'Approval child',
                      subagent_type: 'code',
                      task: 'APPROVAL_RESTART_CHILD',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          return {
            message: {
              content: transcript.includes('APPROVAL_RESTART_CHILD_RESULT')
                ? 'Approval child result imported.'
                : 'Waiting for approval child.',
            },
            ...(parentRequests === 2
              ? { expectedRequest: { toolResults: [{ toolCallId: 'approval-restart-task' }] } }
              : {}),
          };
        },
      })),
    );
    const crashed = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, 'runtime-server-child-approval-restart-fixture.ts'),
        home,
        workspace,
        model.baseURL,
        marker,
        decisionWindow,
      ],
      { cwd: join(import.meta.dir, '../../../..'), stdout: 'pipe', stderr: 'pipe' },
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
        throw new Error(`Approval fixture failed: ${await new Response(crashed.stderr).text()}`, {
          cause: error,
        });
      });
      const ids = JSON.parse(readFileSync(marker, 'utf8')) as {
        childThreadId: string;
        proxyInteractionId: string;
      };
      crashed.kill('SIGKILL');
      await crashed.exited;
      expect(childRequests).toBe(1);
      storage = await createKiteSessionAppServerStorageComposition({
        databasePath,
        hostInstanceId: `child-approval-recovered-${decisionWindow}`,
        executionLeaseMs: 200,
        renewIntervalMs: 40,
      });
      const before = storage.readChildApprovalProxy(parentSessionId, ids.proxyInteractionId);
      expect(before?.status).toBe(decisionWindow);
      expect(storage.storage.sessions.loadEventsStrict(ids.childThreadId)).toContainEqual(
        expect.objectContaining({ event: expect.objectContaining({ type: 'approval.requested' }) }),
      );
      expect(
        storage.storage.sessions
          .loadEventsStrict(ids.childThreadId)
          .filter(({ event }) => event.type === 'tool.started'),
      ).toHaveLength(0);
      const admission: RuntimeServerAdmissionPort = Object.freeze({
        authorize: async (_request: RuntimeServerAdmissionInput) => ({
          allowed: true as const,
          workspace,
        }),
      });
      const shellExecutor = async ({ command }: { command: string }) => {
        shellCalls += 1;
        return {
          ok: true as const,
          command,
          exitCode: 0,
          stdout: 'approved child shell',
          stderr: '',
        };
      };
      Object.defineProperty(shellExecutor, APP_PREPARED_SHELL_EXECUTION_, {
        enumerable: false,
        value: Object.freeze({
          execute: async (prepared: { readonly command: string }) => {
            shellCalls += 1;
            return Object.freeze({
              ok: true as const,
              command: prepared.command,
              exitCode: 0,
              stdout: 'approved child shell',
              stderr: '',
              intent: classifyBuiltinShellIntent(prepared.command),
              executionPhase: 'go_started' as const,
            });
          },
        }),
      });
      server = createKiteMultiWorkspaceRuntimeServer({
        checkpointPath: databasePath,
        storageOwner: storage,
        workspaces: [
          {
            userId: 'child-approval-restart-user',
            workspace,
            config: {
              providerName: 'child-approval-restart-model',
              providerType: 'openai-compatible' as const,
              apiKey: 'fixture-key',
              baseURL: model.baseURL,
              modelName: 'mock-model',
              modelKwargs: { maxOutputTokens: 64 },
              modelCapabilities: { contextWindowTokens: 4_096, maxOutputTokens: 64 },
              features: { resourceBudget: true },
              sandbox: { enabled: true },
            },
            shellExecutor,
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
        clientInfo: { name: 'child-approval-restart-test', version: '1', instanceId: 'client' },
      });
      await client.connect();
      await Bun.sleep(300);
      const resumed = await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'resume_session',
        commandId: `resume-child-approval-${decisionWindow}`,
        sessionId: parentSessionId,
      });
      expect(resumed.status).toBe('applied');
      if (decisionWindow === 'pending') {
        await until(async () => {
          const projection = await client!.query({
            schema: RUNTIME_QUERY_SCHEMA_,
            type: 'get_session_projection',
            sessionId: parentSessionId,
          });
          return (
            projection.status === 'ok' &&
            Boolean(
              projection.session?.interactionQueue.interactions.some(
                (entry) => entry.kind === 'approval' && entry.owner.kind === 'subagent_tool',
              ),
            )
          );
        });
        expect(childRequests).toBe(1);
        expect(shellCalls).toBe(0);
        let approved = false;
        for (let attempt = 0; attempt < 5 && !approved; attempt += 1) {
          const projection = await client.query({
            schema: RUNTIME_QUERY_SCHEMA_,
            type: 'get_session_projection',
            sessionId: parentSessionId,
          });
          const approval =
            projection.status === 'ok'
              ? projection.session?.interactionQueue.interactions.find(
                  (entry) => entry.kind === 'approval' && entry.owner.kind === 'subagent_tool',
                )
              : undefined;
          if (approval?.kind !== 'approval')
            throw new Error('Recovered parent approval is hidden.');
          const response = await client.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'respond_interaction',
            commandId: `approve-after-sigkill-${attempt}`,
            sessionId: parentSessionId,
            expectedRevision: approval.sessionRevision,
            interaction: approval,
            response: { kind: 'approval', decision: 'approve_once' },
          });
          approved = response.status === 'applied';
          if (!approved && response.status !== 'conflict')
            throw new Error(`Parent approval was ${response.status}.`);
        }
        expect(approved).toBe(true);
      }
      await until(() => shellCalls === 1);
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(ids.childThreadId)
          .some(({ event }) => event.type === 'run.completed'),
      );
      expect(shellCalls).toBe(1);
      expect(childRequests).toBe(2);
      expect(
        storage.storage.sessions
          .loadEventsStrict(ids.childThreadId)
          .filter(({ event }) => event.type === 'tool.started'),
      ).toHaveLength(1);
      expect(storage.readChildApprovalProxy(parentSessionId, ids.proxyInteractionId)?.status).toBe(
        'applied',
      );
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(parentSessionId)
          .some(({ event }) => event.type === 'subagent.background_result_persisted'),
      );
      expect(
        storage.storage.sessions
          .loadEventsStrict(parentSessionId)
          .filter(({ event }) => event.type === 'subagent.background_result_persisted'),
      ).toHaveLength(1);
      await until(() =>
        storage!.storage.sessions
          .loadEventsStrict(parentSessionId)
          .some(({ event }) => event.type === 'run.completed'),
      );
      expect(
        storage.storage.sessions
          .loadEventsStrict(parentSessionId)
          .filter(({ event }) => event.type === 'run.completed'),
      ).toHaveLength(1);
      expect(parentRequests).toBe(3);
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

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(10);
  if (!(await predicate()))
    throw new Error('Child approval crash fixture did not reach its boundary.');
}
