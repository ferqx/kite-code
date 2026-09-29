import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { createPreparedAppShellExecutor } from '../../src/sandbox/composition';

for (const firstChildOutcome of ['completed', 'failed'] as const) {
  test(
    `three required children, first ${firstChildOutcome}, settle before one parent model resume`,
    async () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-three-child-barrier-'));
      const workspace = join(root, 'workspace');
      mkdirSync(workspace);
      const sessionId = 'three-child-barrier-session';
      const databasePath = join(root, 'kite-session.sqlite');
      const previousHome = process.env.KITE_CODE_HOME;
      process.env.KITE_CODE_HOME = root;
      const model = createMockModelServer();
      const storage = await createKiteSessionAppServerStorageComposition({
        databasePath,
        hostInstanceId: 'three-child-barrier-host',
      });
      const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
      const started = [deferred<void>(), deferred<void>(), deferred<void>()];
      const parentFinalCandidate = deferred<void>();
      const parentResumed = deferred<void>();
      let parentCalls = 0;
      model.setResponses(
        Array.from({ length: 16 }, () => ({
          response: async ({ messages }: { messages: readonly unknown[] }) => {
            const snapshot = JSON.stringify(messages);
            for (let index = 0; index < 3; index += 1) {
              if (
                snapshot.includes(`BARRIER_CHILD_${index}`) &&
                !snapshot.includes('BARRIER_PARENT')
              ) {
                started[index]!.resolve();
                await gates[index]!.promise;
                return { message: { content: `BARRIER_RESULT_${index}` } };
              }
            }
            parentCalls += 1;
            if (parentCalls === 1) {
              return {
                message: {
                  tool_calls: [0, 1, 2].map((index) => ({
                    id: `barrier-start-${index}`,
                    name: 'task',
                    args: {
                      name: `Barrier child ${index}`,
                      subagent_type: 'review',
                      task: `BARRIER_CHILD_${index}`,
                      background: true,
                      result_disposition: 'required',
                    },
                  })),
                },
                toolContinuation: 'required' as const,
              };
            }
            if (parentCalls === 2) {
              parentFinalCandidate.resolve();
              return {
                message: { content: 'Provisional final while children are running.' },
                expectedRequest: {
                  toolResults: [0, 1, 2].map((index) => ({ toolCallId: `barrier-start-${index}` })),
                },
              };
            }
            for (let index = 0; index < 3; index += 1) {
              if (index === 0 && firstChildOutcome === 'failed') {
                expect(snapshot).toMatch(/failed|failure|provider/iu);
              } else {
                expect(snapshot).toContain(`BARRIER_RESULT_${index}`);
              }
            }
            parentResumed.resolve();
            return { message: { content: 'All three children settled.' } };
          },
        })),
      );
      const server = createKiteMultiWorkspaceRuntimeServer({
        checkpointPath: databasePath,
        storageOwner:
          firstChildOutcome === 'failed'
            ? {
                ...storage,
                createChildSession: (
                  creation: Parameters<typeof storage.createChildSession>[0],
                ) => {
                  const created = storage.createChildSession(creation);
                  if (creation.childSessionIntent.originToolCallId === 'barrier-start-0')
                    throw new Error('Injected local child creation failure after Store commit.');
                  return created;
                },
              }
            : storage,
        workspaces: [
          {
            userId: 'three-child-user',
            workspace,
            config: {
              providerName: 'three-child-model',
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
        clientInfo: { name: 'three-child-barrier-test', version: '1', instanceId: 'client' },
      });
      const events = () =>
        storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
      try {
        const created = await client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'create_session',
          commandId: 'barrier-create',
          workspace,
          bootstrapSessionId: sessionId,
        });
        expect(created).toMatchObject({ status: 'applied' });
        if (created.status !== 'applied') throw new Error('Session creation failed.');
        expect(
          await client.command({
            schema: RUNTIME_COMMAND_SCHEMA_,
            type: 'start_turn',
            commandId: 'barrier-start',
            sessionId,
            expectedRevision: created.revision,
            input: 'BARRIER_PARENT',
          }),
        ).toMatchObject({ status: 'applied' });
        await bounded(
          Promise.all(
            (firstChildOutcome === 'failed' ? started.slice(1, 2) : started.slice(0, 2)).map(
              (entry) => entry.promise,
            ),
          ),
        );
        await bounded(parentFinalCandidate.promise);
        await until(() => events().some((event) => event.type === 'completion.blocked'));
        const firstBlocked = events().find((event) => event.type === 'completion.blocked');
        expect(firstBlocked).toMatchObject({
          code: 'tool_pending',
          nextAction: 'wait_for_background',
          correctionAttempt: 0,
        });
        expect(parentCalls).toBe(2);
        for (let index = 0; index < 2; index += 1) {
          gates[index]!.resolve();
          await until(
            () =>
              events().filter((event) => event.type === 'subagent.background_result_persisted')
                .length ===
              index + 1,
          );
          if (index === 0) await bounded(started[2]!.promise);
          await Bun.sleep(50);
          expect(parentCalls).toBe(2);
          expect(
            events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
          ).toBe(false);
        }
        gates[2]!.resolve();
        await bounded(parentResumed.promise);
        await until(() => events().some((event) => event.type === 'run.completed'));
        const finalEvents = events();
        expect(parentCalls).toBe(3);
        expect(
          finalEvents.filter((event) => event.type === 'subagent.background_result_persisted'),
        ).toHaveLength(3);
        if (firstChildOutcome === 'failed') {
          expect(finalEvents).toContainEqual(
            expect.objectContaining({
              type: 'subagent.child_creation_failed',
            }),
          );
        }
        expect(finalEvents.filter((event) => event.type === 'run.completed')).toHaveLength(1);
        expect(finalEvents.filter((event) => event.type === 'turn.completed')).toHaveLength(1);
        expect(
          finalEvents.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
        ).toBe(false);
      } finally {
        for (const gate of gates) gate.resolve();
        await client.close();
        await server[Symbol.asyncDispose]();
        storage.disposeStorage();
        model.assertComplete({ allowUnconsumedResponses: true });
        model.stop();
        if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
        else process.env.KITE_CODE_HOME = previousHome;
        rmSync(root, { recursive: true, force: true });
      }
    },
    firstChildOutcome === 'failed' ? 60_000 : 30_000,
  );
}

for (const scenario of ['first', 'reverse', 'nonzero'] as const) {
  test(`two finite Shell completions (${scenario}) do not spend a parent correction attempt`, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-two-shell-barrier-'));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const sessionId = 'two-shell-barrier-session';
    const databasePath = join(root, 'kite-session.sqlite');
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = root;
    const model = createMockModelServer();
    const gates = [deferred<void>(), deferred<void>()];
    const started = [deferred<void>(), deferred<void>()];
    const finalCandidate = deferred<void>();
    let parentCalls = 0;
    let shellStarts = 0;
    model.setResponses(
      Array.from({ length: 6 }, () => ({
        response: ({ messages }: { messages: readonly unknown[] }) => {
          const snapshot = JSON.stringify(messages);
          parentCalls += 1;
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [0, 1].map((index) => ({
                  id: `shell-start-${index}`,
                  name: 'shell_execute',
                  args: { command: 'pwd', yield_ms: 0 },
                })),
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2) {
            finalCandidate.resolve();
            return {
              message: { content: 'Provisional final while both Shells remain active.' },
              expectedRequest: {
                toolResults: [0, 1].map((index) => ({ toolCallId: `shell-start-${index}` })),
              },
            };
          }
          if (parentCalls === 3) {
            const ids = [...new Set(snapshot.match(/sh_[A-Za-z0-9._:-]+/gu) ?? [])];
            expect(ids).toHaveLength(2);
            return {
              message: {
                tool_calls: ids.map((shellId, index) => ({
                  id: `shell-read-${index}`,
                  name: 'shell_read',
                  args: { shell_id: shellId, wait_until: 'terminal' },
                })),
              },
              toolContinuation: 'required' as const,
            };
          }
          expect(snapshot).toContain('shell-output-0');
          expect(snapshot).toContain('shell-output-1');
          return {
            message: { content: 'Both Shells exited.' },
            expectedRequest: {
              toolResults: [0, 1].map((index) => ({ toolCallId: `shell-read-${index}` })),
            },
          };
        },
      })),
    );
    const storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: 'two-shell-barrier-host',
    });
    const shellExecutor = createPreparedAppShellExecutor({
      workspace,
      sandboxEnabled: false,
      resolveBackend: () => 'none',
      createNativeExecutor: () => async () => {
        throw new Error('Host Shell seam required.');
      },
      createHostExecutor:
        () =>
        async ({ command }) => {
          const index = shellStarts++;
          started[index]!.resolve();
          await gates[index]!.promise;
          return {
            ok: true,
            command,
            exitCode: scenario === 'nonzero' && index === 1 ? 7 : 0,
            stdout: `shell-output-${index}`,
            stderr: scenario === 'nonzero' && index === 1 ? 'shell-diagnostic-1' : '',
          };
        },
    });
    const server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'two-shell-user',
          workspace,
          config: {
            providerName: 'two-shell-model',
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
    const admission: RuntimeServerAdmissionPort = Object.freeze({
      authorize: async (_request: RuntimeServerAdmissionInput) => ({
        allowed: true as const,
        workspace,
      }),
    });
    const client = new RuntimeClient({
      transport: Object.freeze({
        connect: async () => {
          const pair = server.open({ admission });
          return Object.freeze({
            send: (message: RuntimeProtocolMessage) => pair.client.send(message),
            messages: () => pair.client.messages(),
            close: (reason?: string) => pair.client.close(reason),
          });
        },
      }),
      clientInfo: { name: 'two-shell-barrier-test', version: '1', instanceId: 'client' },
    });
    const events = () =>
      storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
    try {
      const created = await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'create_session',
        commandId: 'shell-barrier-create',
        workspace,
        bootstrapSessionId: sessionId,
      });
      expect(created).toMatchObject({ status: 'applied' });
      if (created.status !== 'applied') throw new Error('Session creation failed.');
      expect(
        await client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'start_turn',
          commandId: 'shell-barrier-start',
          sessionId,
          expectedRevision: created.revision,
          input: 'SHELL_BARRIER_PARENT',
        }),
      ).toMatchObject({ status: 'applied' });
      await bounded(Promise.all(started.map((entry) => entry.promise)));
      await bounded(finalCandidate.promise);
      await until(() => events().some((event) => event.type === 'completion.blocked'));
      expect(events().find((event) => event.type === 'completion.blocked')).toMatchObject({
        code: 'tool_pending',
        nextAction: 'wait_for_tool',
        correctionAttempt: 0,
      });
      const firstIndex = scenario === 'first' ? 0 : 1;
      gates[firstIndex]!.resolve();
      await Bun.sleep(150);
      expect(parentCalls).toBe(2);
      expect(
        events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
      gates[1 - firstIndex]!.resolve();
      await until(() => events().some((event) => event.type === 'run.completed'));
      expect(parentCalls).toBe(4);
      expect(events().filter((event) => event.type === 'run.completed')).toHaveLength(1);
      expect(events().filter((event) => event.type === 'turn.completed')).toHaveLength(1);
      expect(
        events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
    } finally {
      for (const gate of gates) gate.resolve();
      await client.close();
      await server[Symbol.asyncDispose]();
      storage.disposeStorage();
      model.assertComplete({ allowUnconsumedResponses: true });
      model.stop();
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}

for (const firstTerminal of ['child', 'shell'] as const) {
  test(`mixed required child and finite Shell wait when ${firstTerminal} settles first`, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), `kite-mixed-${firstTerminal}-`));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const sessionId = `mixed-${firstTerminal}-session`;
    const databasePath = join(root, 'kite-session.sqlite');
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = root;
    const model = createMockModelServer();
    const storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: `mixed-${firstTerminal}-host`,
    });
    const childGate = deferred<void>();
    const shellGate = deferred<void>();
    const childStarted = deferred<void>();
    const shellStarted = deferred<void>();
    const finalCandidate = deferred<void>();
    let parentCalls = 0;
    model.setResponses(
      Array.from({ length: 6 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const snapshot = JSON.stringify(messages);
          if (snapshot.includes('MIXED_CHILD_TASK') && !snapshot.includes('MIXED_PARENT')) {
            childStarted.resolve();
            await childGate.promise;
            return { message: { content: 'MIXED_CHILD_RESULT' } };
          }
          parentCalls += 1;
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [
                  {
                    id: 'mixed-child-start',
                    name: 'task',
                    args: {
                      name: 'Mixed child',
                      subagent_type: 'review',
                      task: 'MIXED_CHILD_TASK',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                  {
                    id: 'mixed-shell-start',
                    name: 'shell_execute',
                    args: { command: 'pwd', yield_ms: 0 },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2) {
            finalCandidate.resolve();
            return {
              message: { content: 'Provisional mixed final.' },
              expectedRequest: {
                toolResults: [
                  { toolCallId: 'mixed-child-start' },
                  { toolCallId: 'mixed-shell-start' },
                ],
              },
            };
          }
          if (parentCalls === 3) {
            expect(snapshot).toContain('MIXED_CHILD_RESULT');
            expect(snapshot.match(/<subagent_result task_id=/gu)).toHaveLength(1);
            const shellId = snapshot.match(/sh_[A-Za-z0-9._:-]+/u)?.[0];
            expect(shellId).toBeDefined();
            return {
              message: {
                tool_calls: [
                  {
                    id: 'mixed-shell-read',
                    name: 'shell_read',
                    args: { shell_id: shellId, wait_until: 'terminal' },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          }
          expect(snapshot).toContain('MIXED_CHILD_RESULT');
          expect(snapshot).toContain('mixed-shell-output');
          return {
            message: { content: 'Mixed child and Shell settled.' },
            expectedRequest: { toolResults: [{ toolCallId: 'mixed-shell-read' }] },
          };
        },
      })),
    );
    const shellExecutor = createPreparedAppShellExecutor({
      workspace,
      sandboxEnabled: false,
      resolveBackend: () => 'none',
      createNativeExecutor: () => async () => {
        throw new Error('Host Shell seam required.');
      },
      createHostExecutor:
        () =>
        async ({ command }) => {
          shellStarted.resolve();
          await shellGate.promise;
          return { ok: true, command, exitCode: 0, stdout: 'mixed-shell-output', stderr: '' };
        },
    });
    const server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'mixed-user',
          workspace,
          config: {
            providerName: 'mixed-model',
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
    const admission: RuntimeServerAdmissionPort = Object.freeze({
      authorize: async (_request: RuntimeServerAdmissionInput) => ({
        allowed: true as const,
        workspace,
      }),
    });
    const client = new RuntimeClient({
      transport: Object.freeze({
        connect: async () => {
          const pair = server.open({ admission });
          return Object.freeze({
            send: (message: RuntimeProtocolMessage) => pair.client.send(message),
            messages: () => pair.client.messages(),
            close: (reason?: string) => pair.client.close(reason),
          });
        },
      }),
      clientInfo: { name: `mixed-${firstTerminal}-test`, version: '1', instanceId: 'client' },
    });
    const events = () =>
      storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
    try {
      const created = await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'create_session',
        commandId: `mixed-${firstTerminal}-create`,
        workspace,
        bootstrapSessionId: sessionId,
      });
      expect(created).toMatchObject({ status: 'applied' });
      if (created.status !== 'applied') throw new Error('Session creation failed.');
      expect(
        await client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'start_turn',
          commandId: `mixed-${firstTerminal}-start`,
          sessionId,
          expectedRevision: created.revision,
          input: 'MIXED_PARENT',
        }),
      ).toMatchObject({ status: 'applied' });
      await bounded(
        Promise.all([childStarted.promise, shellStarted.promise, finalCandidate.promise]),
      );
      await until(() => events().some((event) => event.type === 'completion.blocked'));
      expect(events().find((event) => event.type === 'completion.blocked')).toMatchObject({
        code: 'tool_pending',
        nextAction: 'wait_for_tool',
        correctionAttempt: 0,
      });
      if (firstTerminal === 'child') {
        childGate.resolve();
        await until(() =>
          events().some((event) => event.type === 'subagent.background_result_persisted'),
        );
      } else {
        shellGate.resolve();
        await Bun.sleep(100);
      }
      await Bun.sleep(100);
      expect(parentCalls).toBe(2);
      expect(
        events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
      childGate.resolve();
      shellGate.resolve();
      await until(() => events().some((event) => event.type === 'run.completed'));
      expect(parentCalls).toBe(4);
      expect(
        events().filter((event) => event.type === 'subagent.background_result_persisted'),
      ).toHaveLength(1);
      expect(events().filter((event) => event.type === 'run.completed')).toHaveLength(1);
      expect(events().filter((event) => event.type === 'turn.completed')).toHaveLength(1);
      expect(
        events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
    } finally {
      childGate.resolve();
      shellGate.resolve();
      await client.close();
      await server[Symbol.asyncDispose]();
      storage.disposeStorage();
      model.assertComplete({ allowUnconsumedResponses: true });
      model.stop();
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}

for (const order of ['shells-first', 'children-first', 'same-batch'] as const) {
  test(`two Shells and two required children settle ${order} without an early parent resume`, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), `kite-four-background-${order}-`));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const sessionId = `four-background-${order}-session`;
    const databasePath = join(root, 'kite-session.sqlite');
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = root;
    const model = createMockModelServer();
    const storage = await createKiteSessionAppServerStorageComposition({
      databasePath,
      hostInstanceId: `four-background-${order}-host`,
    });
    const childGates = [deferred<void>(), deferred<void>()];
    const shellGates = [deferred<void>(), deferred<void>()];
    const childStarted = [deferred<void>(), deferred<void>()];
    const shellStarted = [deferred<void>(), deferred<void>()];
    const finalCandidate = deferred<void>();
    let parentCalls = 0;
    model.setResponses(
      Array.from({ length: 12 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const snapshot = JSON.stringify(messages);
          for (let index = 0; index < 2; index += 1) {
            if (snapshot.includes(`FOUR_CHILD_${index}`) && !snapshot.includes('FOUR_PARENT')) {
              childStarted[index]!.resolve();
              await childGates[index]!.promise;
              return { message: { content: `FOUR_RESULT_${index}` } };
            }
          }
          parentCalls += 1;
          if (parentCalls === 1)
            return {
              message: {
                tool_calls: [0, 1].flatMap((index) => [
                  {
                    id: `four-child-${index}`,
                    name: 'task',
                    args: {
                      name: `Four child ${index}`,
                      subagent_type: 'review',
                      task: `FOUR_CHILD_${index}`,
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                  {
                    id: `four-shell-${index}`,
                    name: 'shell_execute',
                    args: { command: 'pwd', yield_ms: 0 },
                  },
                ]),
              },
              toolContinuation: 'required' as const,
            };
          if (parentCalls === 2) {
            finalCandidate.resolve();
            return {
              message: { content: 'Provisional four-task final.' },
              expectedRequest: {
                toolResults: [0, 1].flatMap((index) => [
                  { toolCallId: `four-child-${index}` },
                  { toolCallId: `four-shell-${index}` },
                ]),
              },
            };
          }
          expect(snapshot).toContain('FOUR_RESULT_0');
          expect(snapshot).toContain('FOUR_RESULT_1');
          expect(snapshot.match(/<subagent_result task_id=/gu)).toHaveLength(2);
          if (parentCalls === 3) {
            const shellIds = [...new Set(snapshot.match(/sh_[A-Za-z0-9._:-]+/gu) ?? [])];
            expect(shellIds).toHaveLength(2);
            return {
              message: {
                tool_calls: shellIds.map((shellId, index) => ({
                  id: `four-shell-read-${index}`,
                  name: 'shell_read',
                  args: { shell_id: shellId, wait_until: 'terminal' },
                })),
              },
              toolContinuation: 'required' as const,
            };
          }
          expect(snapshot).toContain('four-shell-output-0');
          expect(snapshot).toContain('four-shell-output-1');
          return {
            message: { content: 'All four background tasks settled.' },
            expectedRequest: {
              toolResults: [0, 1].map((index) => ({ toolCallId: `four-shell-read-${index}` })),
            },
          };
        },
      })),
    );
    let shellIndex = 0;
    const shellExecutor = createPreparedAppShellExecutor({
      workspace,
      sandboxEnabled: false,
      resolveBackend: () => 'none',
      createNativeExecutor: () => async () => {
        throw new Error('Host Shell seam required.');
      },
      createHostExecutor:
        () =>
        async ({ command }) => {
          const index = shellIndex++;
          shellStarted[index]!.resolve();
          await shellGates[index]!.promise;
          return {
            ok: true,
            command,
            exitCode: 0,
            stdout: `four-shell-output-${index}`,
            stderr: '',
          };
        },
    });
    const server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: databasePath,
      storageOwner: storage,
      workspaces: [
        {
          userId: 'four-background-user',
          workspace,
          config: {
            providerName: 'four-background-model',
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
    const admission: RuntimeServerAdmissionPort = Object.freeze({
      authorize: async (_request: RuntimeServerAdmissionInput) => ({
        allowed: true as const,
        workspace,
      }),
    });
    const client = new RuntimeClient({
      transport: Object.freeze({
        connect: async () => {
          const pair = server.open({ admission });
          return Object.freeze({
            send: (message: RuntimeProtocolMessage) => pair.client.send(message),
            messages: () => pair.client.messages(),
            close: (reason?: string) => pair.client.close(reason),
          });
        },
      }),
      clientInfo: { name: `four-background-${order}-test`, version: '1', instanceId: 'client' },
    });
    const events = () =>
      storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
    try {
      const created = await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'create_session',
        commandId: `four-${order}-create`,
        workspace,
        bootstrapSessionId: sessionId,
      });
      expect(created).toMatchObject({ status: 'applied' });
      if (created.status !== 'applied') throw new Error('Session creation failed.');
      expect(
        await client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'start_turn',
          commandId: `four-${order}-start`,
          sessionId,
          expectedRevision: created.revision,
          input: 'FOUR_PARENT',
        }),
      ).toMatchObject({ status: 'applied' });
      await bounded(Promise.all([...childStarted, ...shellStarted].map((entry) => entry.promise)));
      await bounded(finalCandidate.promise);
      await until(() => events().some((event) => event.type === 'completion.blocked'));
      expect(events().find((event) => event.type === 'completion.blocked')).toMatchObject({
        nextAction: 'wait_for_tool',
        correctionAttempt: 0,
      });
      const releaseShells = () => {
        for (const gate of shellGates) gate.resolve();
      };
      const releaseChildren = () => {
        for (const gate of childGates) gate.resolve();
      };
      if (order === 'shells-first') releaseShells();
      if (order === 'children-first') releaseChildren();
      if (order !== 'same-batch') {
        if (order === 'children-first')
          await until(
            () =>
              events().filter((event) => event.type === 'subagent.background_result_persisted')
                .length === 2,
          );
        else await Bun.sleep(150);
        expect(parentCalls).toBe(2);
        expect(
          events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
        ).toBe(false);
      }
      releaseShells();
      releaseChildren();
      await until(() => events().some((event) => event.type === 'run.completed'));
      const finalEvents = events();
      expect(parentCalls).toBe(4);
      expect(
        finalEvents.filter((event) => event.type === 'subagent.background_result_persisted'),
      ).toHaveLength(2);
      expect(finalEvents.filter((event) => event.type === 'run.completed')).toHaveLength(1);
      expect(finalEvents.filter((event) => event.type === 'turn.completed')).toHaveLength(1);
      expect(
        finalEvents.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
    } finally {
      for (const gate of [...childGates, ...shellGates]) gate.resolve();
      await client.close();
      await server[Symbol.asyncDispose]();
      storage.disposeStorage();
      model.assertComplete({ allowUnconsumedResponses: true });
      model.stop();
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}

async function runThreeAdmittedChildren(lastChildOutcome: 'completed' | 'lease-expired') {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'kite-cancel-first-child-barrier-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  const sessionId = 'cancel-first-child-barrier-session';
  const databasePath = join(root, 'kite-session.sqlite');
  const previousHome = process.env.KITE_CODE_HOME;
  process.env.KITE_CODE_HOME = root;
  const model = createMockModelServer();
  const storage = await createKiteSessionAppServerStorageComposition({
    databasePath,
    hostInstanceId: 'cancel-first-child-barrier-host',
  });
  const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
  const started = [deferred<void>(), deferred<void>(), deferred<void>()];
  const finalCandidate = deferred<void>();
  let parentCalls = 0;
  let thirdChildRequests = 0;
  model.setResponses(
    Array.from({ length: 9 }, () => ({
      response: async ({
        messages,
      }: {
        messages: readonly { role?: string; tool_call_id?: string; content?: unknown }[];
      }) => {
        const snapshot = JSON.stringify(messages);
        for (let index = 0; index < 3; index += 1) {
          if (snapshot.includes(`CANCEL_CHILD_${index}`) && !snapshot.includes('CANCEL_PARENT')) {
            if (index === 2) thirdChildRequests += 1;
            started[index]!.resolve();
            await gates[index]!.promise;
            return { message: { content: `CANCEL_LATE_RESULT_${index}` } };
          }
        }
        parentCalls += 1;
        if (parentCalls === 1)
          return {
            message: {
              tool_calls: [0, 1, 2].map((index) => ({
                id: `cancel-start-${index}`,
                name: 'task',
                args: {
                  name: `Required child ${index}`,
                  subagent_type: 'review',
                  task: `CANCEL_CHILD_${index}`,
                  background: true,
                  result_disposition: 'required',
                },
              })),
            },
            toolContinuation: 'required' as const,
          };
        if (parentCalls === 2) {
          finalCandidate.resolve();
          return {
            message: { content: 'Provisional final while three children run.' },
            expectedRequest: {
              toolResults: [0, 1, 2].map((index) => ({ toolCallId: `cancel-start-${index}` })),
            },
          };
        }
        expect(snapshot).toContain('CANCEL_LATE_RESULT_0');
        expect(snapshot).toContain('CANCEL_LATE_RESULT_1');
        expect(snapshot).toContain('CANCEL_LATE_RESULT_2');
        return { message: { content: 'All three children settled.' } };
      },
    })),
  );
  const server = createKiteMultiWorkspaceRuntimeServer({
    checkpointPath: databasePath,
    storageOwner: storage,
    workspaces: [
      {
        userId: 'cancel-first-user',
        workspace,
        config: {
          providerName: 'cancel-first-model',
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
  const admission: RuntimeServerAdmissionPort = Object.freeze({
    authorize: async (_request: RuntimeServerAdmissionInput) => ({
      allowed: true as const,
      workspace,
    }),
  });
  const client = new RuntimeClient({
    transport: Object.freeze({
      connect: async () => {
        const pair = server.open({ admission });
        return Object.freeze({
          send: (message: RuntimeProtocolMessage) => pair.client.send(message),
          messages: () => pair.client.messages(),
          close: (reason?: string) => pair.client.close(reason),
        });
      },
    }),
    clientInfo: { name: 'cancel-first-child-barrier-test', version: '1', instanceId: 'client' },
  });
  const events = () =>
    storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
  try {
    const created = await client.command({
      schema: RUNTIME_COMMAND_SCHEMA_,
      type: 'create_session',
      commandId: 'cancel-create',
      workspace,
      bootstrapSessionId: sessionId,
    });
    expect(created).toMatchObject({ status: 'applied' });
    if (created.status !== 'applied') throw new Error('Session creation failed.');
    expect(
      await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'start_turn',
        commandId: 'cancel-start',
        sessionId,
        expectedRevision: created.revision,
        input: 'CANCEL_PARENT',
      }),
    ).toMatchObject({ status: 'applied' });
    await bounded(Promise.all(started.map((item) => item.promise)));
    await bounded(finalCandidate.promise);
    await until(() => events().some((event) => event.type === 'completion.blocked'));
    expect(events().find((event) => event.type === 'completion.blocked')).toMatchObject({
      nextAction: 'wait_for_background',
      correctionAttempt: 0,
    });
    expect(parentCalls).toBe(2);
    const background = await client.query({
      schema: RUNTIME_QUERY_SCHEMA_,
      type: 'list_background_executions',
      sessionId,
    });
    expect(background).toMatchObject({
      status: 'ok',
      backgroundSnapshot: {
        executions: expect.arrayContaining(
          [0, 1, 2].map((index) =>
            expect.objectContaining({ displayName: `Required child ${index}`, status: 'running' }),
          ),
        ),
      },
    });
    for (let index = 0; index < 2; index += 1) {
      if (index === 1 && lastChildOutcome === 'lease-expired') {
        // Shorten the still-active third child's lease before the second
        // terminal changes parent revision and starts the next wait.
        const database = new Database(databasePath);
        try {
          const child = database
            .query<{ child_thread_id: string }, [string, string]>(
              'SELECT child_thread_id FROM child_session_intents WHERE parent_session_id = ? AND origin_tool_call_id = ?',
            )
            .get(sessionId, 'cancel-start-2');
          if (!child) throw new Error('Expected the third independent child intent.');
          const updated = database
            .query(
              "UPDATE kite_meta SET value = json_set(value, '$.leaseUntilMs', ?, '$.revision', json_extract(value, '$.revision') + 1) WHERE key = ? AND json_extract(value, '$.status') = 'active'",
            )
            .run(Date.now() + 1_500, `session_execution/${child.child_thread_id}`);
          expect(updated.changes).toBe(1);
        } finally {
          database.close();
        }
      }
      gates[index]!.resolve();
      await until(
        () =>
          events().filter((event) => event.type === 'subagent.background_result_persisted')
            .length ===
          index + 1,
      );
      expect(parentCalls).toBe(2);
      expect(
        events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
    }
    if (lastChildOutcome === 'lease-expired') {
      await until(() => events().some((event) => event.type === 'run.error'));
      const terminal = events();
      expect(terminal.find((event) => event.type === 'run.error')).toMatchObject({
        message: 'Required child Session needs explicit execution recovery.',
      });
      expect(parentCalls).toBe(2);
      expect(terminal.some((event) => event.type === 'run.completed')).toBe(false);
      expect(terminal.some((event) => event.type === 'turn.aborted')).toBe(true);
      expect(thirdChildRequests).toBe(1);
    } else {
      gates[2]!.resolve();
      await until(() => events().some((event) => event.type === 'run.completed'));
      const terminal = events();
      expect(parentCalls).toBe(3);
      const terminalResults = terminal.filter(
        (event) => event.type === 'subagent.background_result_persisted',
      );
      expect(terminalResults).toHaveLength(3);
      expect(new Set(terminalResults.map((event) => event.taskId)).size).toBe(3);
      expect(thirdChildRequests).toBe(1);
      expect(terminal.filter((event) => event.type === 'run.completed')).toHaveLength(1);
      expect(terminal.filter((event) => event.type === 'turn.completed')).toHaveLength(1);
      expect(
        terminal.some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
    }
  } finally {
    for (const gate of gates) gate.resolve();
    await client.close();
    if (lastChildOutcome === 'lease-expired')
      await expect(server[Symbol.asyncDispose]()).rejects.toThrow(
        'Runtime Server owner disposal failed.',
      );
    else await server[Symbol.asyncDispose]();
    storage.disposeStorage();
    model.assertComplete({ allowUnconsumedResponses: true });
    model.stop();
    if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
    else process.env.KITE_CODE_HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  'three admitted children keep the parent waiting until the last is completed',
  () => runThreeAdmittedChildren('completed'),
  30_000,
);
test(
  'three admitted children stop waiting when the last lease expires',
  () => runThreeAdmittedChildren('lease-expired'),
  30_000,
);

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(30_000).then(() => {
      throw new Error('Timed out waiting for controlled gate.');
    }),
  ]);
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Timed out waiting for durable Runtime event.');
}
