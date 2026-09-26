import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient, type RuntimeClientTransport } from '@kite-ai/runtime-client';
import { RUNTIME_COMMAND_SCHEMA_ } from '@kite-ai/runtime-contract';
import type { RuntimeProtocolMessage } from '@kite-ai/runtime-protocol';
import type { RuntimeServerAdmissionPort } from '@kite-ai/runtime-server';
import { createMockModelServer } from '../../../../tests/tui-system/harness/fixtures';
import {
  createKiteMultiWorkspaceRuntimeServer,
  createKiteSessionAppServerStorageComposition,
} from '../../src/bootstrap';

async function until(check: () => boolean, stage: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  if (!check()) throw new Error(`Interrupt AppServer did not reach ${stage}.`);
}

test('formal AppServer discloses interrupt_agent and stops only a direct child Agent', async () => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'kite-interrupt-formal-'));
  const workspace = join(home, 'workspace');
  mkdirSync(workspace);
  const databasePath = join(home, 'kite-session.sqlite');
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = home;
  const model = createMockModelServer();
  let parentCalls = 0;
  let childCalls = 0;
  let childAgentId: string | undefined;
  let releaseChildResponse: (() => void) | undefined;
  const childResponseGate = new Promise<void>((resolve) => {
    releaseChildResponse = resolve;
  });
  const advertised: string[][] = [];
  let storage: Awaited<ReturnType<typeof createKiteSessionAppServerStorageComposition>> | undefined;
  let server: ReturnType<typeof createKiteMultiWorkspaceRuntimeServer> | undefined;
  let client: RuntimeClient | undefined;
  let mainFailure: unknown;
  let disposeFailure: unknown;
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
            ? body.tools.flatMap((tool) => {
                const fn = (tool as { function?: { name?: string } }).function;
                return fn?.name ? [fn.name] : [];
              })
            : [];
          if (transcript.includes('INTERRUPT_CHILD') && !transcript.includes('INTERRUPT_PARENT')) {
            childCalls++;
            await childResponseGate;
            return { message: { content: 'INTERRUPT_CHILD_DONE' } };
          }
          parentCalls++;
          advertised.push(toolNames);
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'spawn-interrupt-child',
                    name: 'task',
                    args: {
                      name: 'Interrupt target',
                      subagent_type: 'review',
                      task: 'INTERRUPT_CHILD',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2)
            return {
              message: {
                tool_calls: [{ id: 'list-interrupt-children', name: 'list_agents', args: {} }],
              },
              expectedRequest: { toolResults: [{ toolCallId: 'spawn-interrupt-child' }] },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 3) {
            childAgentId = transcript.match(/child_[a-f0-9]{64}/u)?.[0];
            if (!childAgentId) throw new Error('list_agents did not disclose the direct child ID.');
            return {
              message: {
                tool_calls: [
                  {
                    id: 'foreign-interrupt',
                    name: 'interrupt_agent',
                    args: { agent_id: 'foreign-agent' },
                  },
                ],
              },
              expectedRequest: { toolResults: [{ toolCallId: 'list-interrupt-children' }] },
              toolContinuation: 'required' as const,
            };
          }
          if (parentCalls === 4)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'direct-interrupt',
                    name: 'interrupt_agent',
                    args: { agent_id: childAgentId },
                  },
                ],
              },
              expectedRequest: { toolResults: [{ toolCallId: 'foreign-interrupt' }] },
              toolContinuation: 'required' as const,
            };
          return {
            message: { content: 'INTERRUPT_PARENT_DONE' },
            ...(parentCalls === 5
              ? { expectedRequest: { toolResults: [{ toolCallId: 'direct-interrupt' }] } }
              : {}),
          };
        },
      })),
    );
    storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'interrupt-formal-host',
    });
    server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'interrupt-user',
          workspace,
          config: {
            providerName: 'interrupt-model',
            providerType: 'openai-compatible' as const,
            apiKey: 'fixture-key',
            baseURL: model.baseURL,
            modelName: 'mock-model',
            modelKwargs: { maxOutputTokens: 64 },
            modelCapabilities: { contextWindowTokens: 4096, maxOutputTokens: 64 },
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
      authorize: async () => ({ allowed: true as const, workspace }),
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
      clientInfo: { name: 'interrupt-formal-test', version: '1', instanceId: 'client' },
    });
    expect(
      await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'create_session',
        commandId: 'create-foreign-agent',
        workspace,
        bootstrapSessionId: 'foreign-agent',
      }),
    ).toMatchObject({ status: 'applied' });
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'create-interrupt-parent',
      workspace,
      bootstrapSessionId: 'interrupt-parent',
    });
    expect(created.status).toBe('applied');
    if (created.status !== 'applied') throw new Error('Session creation failed.');
    const started = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'start_turn',
      commandId: 'start-interrupt-parent',
      sessionId: 'interrupt-parent',
      expectedRevision: created.revision,
      input: 'INTERRUPT_PARENT',
    });
    expect(started.status).toBe('applied');
    await until(() => parentCalls >= 4, 'the direct child interrupt Tool call');
    expect(advertised[0]).toContain('interrupt_agent');
    expect(advertised[0]).toContain('list_agents');
    expect(childAgentId).toMatch(/^child_[a-f0-9]{64}$/u);
    if (!childAgentId) throw new Error('Direct child Agent ID is unavailable.');
    await until(
      () =>
        storage!.storage.sessions
          .loadEventsStrict('interrupt-parent')
          .some(({ event }) => event.type === 'background_execution.stop_requested'),
      'the durable stop request',
    );
    releaseChildResponse?.();
    await until(() => {
      const db = new Database(databasePath, { readonly: true });
      try {
        return (
          db
            .query<{ status: string }, []>('SELECT status FROM agent_interrupt_intents LIMIT 1')
            .get()?.status === 'settled'
        );
      } finally {
        db.close();
      }
    }, 'the settled direct child stop');
    const db = new Database(databasePath, { readonly: true });
    try {
      expect(
        db
          .query<{ target_session_id: string; status: string }, []>(
            'SELECT target_session_id,status FROM agent_interrupt_intents',
          )
          .all(),
      ).toEqual([{ target_session_id: childAgentId, status: 'settled' }]);
    } finally {
      db.close();
    }
    expect(
      storage.storage.sessions
        .loadEventsStrict('interrupt-parent')
        .filter(({ event }) => event.type === 'background_execution.stop_requested'),
    ).toHaveLength(1);
    const parent = storage.loadCurrentSnapshot('interrupt-parent');
    expect(parent?.tools.calls['foreign-interrupt']?.status).toBe('rejected');
    expect(parent?.tools.calls['direct-interrupt']?.status).toBe('succeeded');
    expect(childCalls).toBeGreaterThanOrEqual(1);
  } catch (error) {
    mainFailure = error;
  } finally {
    releaseChildResponse?.();
    await client?.close();
    try {
      await server?.[Symbol.asyncDispose]();
    } catch (error) {
      disposeFailure = error;
    }
    storage?.disposeStorage();
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
  if (mainFailure) throw mainFailure;
  if (disposeFailure) throw disposeFailure;
}, 30000);
