import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeClient } from '@kite-ai/runtime-client';
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

for (const stoppedKind of ['subagent', 'shell'] as const) {
  test(`mixed required child and finite Shell: stopping ${stoppedKind} keeps its sibling alive`, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), `kite-mixed-stop-${stoppedKind}-`));
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const sessionId = `mixed-stop-${stoppedKind}`;
    const previousHome = process.env.KITE_CODE_HOME;
    process.env.KITE_CODE_HOME = root;
    const model = createMockModelServer();
    const storage = await createKiteSessionAppServerStorageComposition({
      databasePath: join(root, 'kite-session.sqlite'),
      hostInstanceId: `mixed-stop-${stoppedKind}-host`,
    });
    const childGate = deferred();
    const shellGate = deferred();
    const childStarted = deferred();
    const shellStarted = deferred();
    const finalCandidate = deferred();
    let parentCalls = 0;
    let childModelCalls = 0;
    model.setResponses(
      Array.from({ length: 8 }, () => ({
        response: async ({ messages }: { messages: readonly unknown[] }) => {
          const snapshot = JSON.stringify(messages);
          if (snapshot.includes('MIXED_STOP_CHILD') && !snapshot.includes('MIXED_STOP_PARENT')) {
            childModelCalls += 1;
            childStarted.resolve();
            await childGate.promise;
            return { message: { content: 'MIXED_STOP_CHILD_RESULT' } };
          }
          parentCalls += 1;
          if (parentCalls === 1) {
            return {
              message: {
                tool_calls: [
                  {
                    id: 'mixed-stop-child-start',
                    name: 'task',
                    args: {
                      name: 'Mixed stop reviewer',
                      subagent_type: 'review',
                      task: 'MIXED_STOP_CHILD',
                      background: true,
                      result_disposition: 'required',
                    },
                  },
                  {
                    id: 'mixed-stop-shell-start',
                    name: 'shell_execute',
                    args: { command: 'pwd', yield_ms: 0 },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          }
          if (parentCalls === 2) {
            finalCandidate.resolve();
            return {
              message: { content: 'Provisional mixed stop final.' },
              expectedRequest: {
                toolResults: [
                  { toolCallId: 'mixed-stop-child-start' },
                  { toolCallId: 'mixed-stop-shell-start' },
                ],
              },
            };
          }
          expect(snapshot.match(/<subagent_result task_id=/gu)).toHaveLength(1);
          if (parentCalls === 3) {
            const shellId = snapshot.match(/sh_[A-Za-z0-9._:-]+/u)?.[0];
            expect(shellId).toBeDefined();
            return {
              message: {
                tool_calls: [
                  {
                    id: 'mixed-stop-shell-read',
                    name: 'shell_read',
                    args: { shell_id: shellId, wait_until: 'terminal' },
                  },
                ],
              },
              toolContinuation: 'required' as const,
            };
          }
          return {
            message: { content: 'Mixed stop tasks settled.' },
            expectedRequest: { toolResults: [{ toolCallId: 'mixed-stop-shell-read' }] },
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
        async ({ command, signal }) => {
          shellStarted.resolve();
          const stopped = await Promise.race([
            shellGate.promise.then(() => false),
            new Promise<boolean>((resolve) => {
              if (signal?.aborted) resolve(true);
              else signal?.addEventListener('abort', () => resolve(true), { once: true });
            }),
          ]);
          return stopped
            ? {
                ok: false,
                command,
                exitCode: 130,
                stdout: '',
                stderr: '',
                terminationReason: 'cancelled' as const,
                processCleanup: {
                  confirmedExited: true,
                  gracefulRequested: true,
                  forced: false,
                  unconfirmedDescendantCount: 0,
                },
              }
            : { ok: true, command, exitCode: 0, stdout: 'mixed-shell-output', stderr: '' };
        },
    });
    const server = createKiteMultiWorkspaceRuntimeServer({
      checkpointPath: join(root, 'kite-session.sqlite'),
      storageOwner: storage,
      workspaces: [
        {
          userId: 'mixed-stop-user',
          workspace,
          config: {
            providerName: 'mixed-stop-model',
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
      clientInfo: { name: `mixed-stop-${stoppedKind}`, version: '1', instanceId: 'client' },
    });
    const events = () =>
      storage.storage.sessions.loadEventsStrict(sessionId).map(({ event }) => event);
    let reachedTerminal = false;
    try {
      const created = await client.command({
        schema: RUNTIME_COMMAND_SCHEMA_,
        type: 'create_session',
        commandId: 'mixed-stop-create',
        workspace,
        bootstrapSessionId: sessionId,
      });
      expect(created.status).toBe('applied');
      if (created.status !== 'applied') throw new Error('Session creation failed.');
      expect(
        await client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'start_turn',
          commandId: 'mixed-stop-start',
          sessionId,
          expectedRevision: created.revision,
          input: 'MIXED_STOP_PARENT',
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
      const background = await client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'list_background_executions',
        sessionId,
      });
      expect(background.status).toBe('ok');
      if (background.status !== 'ok') throw new Error('Background query failed.');
      const target = background.backgroundSnapshot?.executions.find(
        (execution) => execution.kind === stoppedKind && execution.status === 'running',
      );
      expect(target).toBeDefined();
      if (!target) throw new Error('Exact running target is unavailable.');
      expect(
        await client.command({
          schema: RUNTIME_COMMAND_SCHEMA_,
          type: 'stop_background_execution',
          commandId: `mixed-stop-${stoppedKind}-exact`,
          sessionId,
          expectedRevision: target.sessionRevision,
          executionId: target.executionId,
          executionKind: target.kind,
          expectedOwnerGeneration: target.ownerGeneration,
          expectedExecutionRevision: target.revision,
        }),
      ).toMatchObject({ status: 'applied' });
      await until(() =>
        events().some(
          (event) =>
            event.type === 'background_execution.stop_settled' &&
            event.executionId === target.executionId,
        ),
      );
      const stopped = await client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_background_execution',
        sessionId,
        executionId: target.executionId,
      });
      expect(stopped).toMatchObject({
        status: 'ok',
        backgroundExecution: { status: 'cancelled', cleanupConfirmed: true },
      });
      const sibling = background.backgroundSnapshot?.executions.find(
        (execution) => execution.kind !== stoppedKind && execution.status === 'running',
      );
      expect(sibling).toBeDefined();
      if (!sibling) throw new Error('Running sibling is unavailable.');
      const siblingNow = await client.query({
        schema: RUNTIME_QUERY_SCHEMA_,
        type: 'get_background_execution',
        sessionId,
        executionId: sibling.executionId,
      });
      expect(siblingNow).toMatchObject({
        status: 'ok',
        backgroundExecution: { status: 'running', cleanupConfirmed: false },
      });
      expect(parentCalls).toBe(2);
      expect(
        events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
      childGate.resolve();
      shellGate.resolve();
      if (stoppedKind === 'subagent') {
        await until(() => events().some((event) => event.type === 'run.error'));
        expect(events().filter((event) => event.type === 'resource_budget.unknown')).toHaveLength(
          1,
        );
        expect(events().find((event) => event.type === 'run.error')).toMatchObject({
          message: 'Runtime resource admission denied: reconciliation_required.',
        });
        expect(parentCalls).toBe(2);
        expect(
          events().filter((event) => event.type === 'subagent.background_result_persisted'),
        ).toHaveLength(1);
        expect(events().filter((event) => event.type === 'run.completed')).toHaveLength(0);
        return;
      }
      await until(() => events().some((event) => event.type === 'run.completed'));
      expect(parentCalls).toBe(4);
      expect(childModelCalls).toBe(1);
      expect(
        events().filter((event) => event.type === 'subagent.background_result_persisted'),
      ).toHaveLength(1);
      expect(events().filter((event) => event.type === 'run.completed')).toHaveLength(1);
      expect(events().filter((event) => event.type === 'turn.completed')).toHaveLength(1);
      expect(
        events().some((event) => event.type === 'run.error' || event.type === 'turn.aborted'),
      ).toBe(false);
      reachedTerminal = true;
    } finally {
      childGate.resolve();
      shellGate.resolve();
      await client.close();
      await server[Symbol.asyncDispose]();
      storage.disposeStorage();
      if (reachedTerminal) model.assertComplete({ allowUnconsumedResponses: true });
      model.stop();
      if (previousHome === undefined) delete process.env.KITE_CODE_HOME;
      else process.env.KITE_CODE_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    Bun.sleep(10_000).then(() => {
      throw new Error('Timed out waiting for controlled start.');
    }),
  ]);
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error('Timed out waiting for durable Runtime event.');
}
