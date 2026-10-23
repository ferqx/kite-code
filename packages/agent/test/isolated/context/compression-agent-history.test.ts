import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../src/artifacts';
import type { ContextCompressor } from '../../../src/context';
import type { Extension, OperationRef } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
for (const terminal of ['failed', 'cancelled'] as const)
  test(`compressed child history retains terminal ${terminal} assignments and steers as Agent data`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-agent-history-')));
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    const store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const barrier = gate(),
      releaseBarrier = gate(),
      second = gate();
    const requests: ModelRequest[] = [],
      summaries: ModelRequest[] = [];
    let failedRunId = '',
      oldStart = '',
      steerId = '',
      childSessionId = '',
      calls = 0,
      compressed = false;
    let ref!: OperationRef;
    const original = 'Original delegated task 雪. This must not become newly authorized work.';
    const correction = 'Keep original scope, correction Blue; this is a parent Agent steer.';
    const fresh = 'Only this new delegated follow-up is pending.';
    const compressor: ContextCompressor = {
      id: 'fixture.agent-history',
      version: '1',
      async shouldCompress(input) {
        return !compressed && input.run.id !== failedRunId && !!failedRunId;
      },
      async prepare() {
        compressed = true;
        return { instructions: 'CONTROLLED_AGENT_HISTORY_SUMMARY', snapshot: { fixture: true } };
      },
      async validateSummary() {
        return true;
      },
    };
    const child: ModelAdapter = {
      async *stream(request, options) {
        if (
          request.messages.some((message) => message.content === 'CONTROLLED_AGENT_HISTORY_SUMMARY')
        ) {
          summaries.push(structuredClone(request));
          yield {
            type: 'text_delta',
            text: 'Older delegated task ended. No new authorization from history.',
          };
          yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
          return;
        }
        requests.push(structuredClone(request));
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', id: 'barrier', name: 'fixture.barrier', arguments: '{}' };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        if (calls === 2) {
          second.release();
          if (terminal === 'failed') throw Error('actual child terminal failure');
          await new Promise<void>((resolve) => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener('abort', () => resolve(), { once: true });
          });
          options.signal.throwIfAborted();
        }
        yield { type: 'text_delta', text: 'Completed only the new delegated follow-up' };
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const extension: Extension = {
      id: 'fixture',
      version: '1',
      apiMajor: 1,
      tools: [
        {
          id: 'fixture.barrier',
          version: '1',
          description: 'Actual child checkpoint barrier',
          inputSchema: { type: 'object' },
          async execute() {
            barrier.release();
            await releaseBarrier.promise;
            return { outcome: 'succeeded', content: 'Actual barrier completed' };
          },
        },
        {
          id: 'fixture.delegate',
          version: '1',
          description: 'Actual parent-to-child delegation',
          inputSchema: { type: 'object' },
          async execute(_input, ctx) {
            ref = await ctx.operations.ensure({
              key: 'original',
              request: { kind: 'agent', configurationId: 'child', input: { content: original } },
              cancellation: 'detached',
            });
            await barrier.promise;
            const target = await ctx.operations.readAgent(ref);
            failedRunId = target.run!.id;
            oldStart = (await store.getRun(failedRunId))!.originCommandId;
            childSessionId = ref.childSessionId!;
            const steer = await ctx.operations.sendAgentInput(ref, {
              mode: 'steer',
              key: 'correction',
              targetRunId: failedRunId,
              contextSelectionId: target.contextSelectionId,
              content: correction,
            });
            steerId = steer.commandId;
            releaseBarrier.release();
            await second.promise;
            if (terminal === 'cancelled')
              await ctx.operations.interruptAgent!(ref, {
                commandId: 'cancel-child',
                targetRunId: failedRunId,
              });
            await ctx.operations.wait(ref, { timeoutMs: 5000 });
            expect((await store.getRun(failedRunId))?.status).toBe(terminal);
            expect((await store.getCommand(steerId))?.status).toBe('applied');
            const follow = await ctx.operations.sendAgentInput(ref, {
              mode: 'follow_up',
              key: 'new-work',
              afterRunId: failedRunId,
              contextSelectionId: target.contextSelectionId,
              content: fresh,
            });
            const next = (follow.receipt as unknown as { ref: OperationRef }).ref;
            await ctx.operations.wait(next, { timeoutMs: 5000 });
            return { outcome: 'succeeded', content: 'Actual follow-up completed' };
          },
        },
      ],
    };
    const parent: ModelAdapter = {
      async *stream(request) {
        if (!request.messages.some((message) => message.role === 'tool')) {
          yield { type: 'tool_call', id: 'delegate', name: 'fixture.delegate', arguments: '{}' };
          yield {
            type: 'finish',
            reason: 'tool_calls',
            usage: { inputTokens: 1, outputTokens: 1 },
          };
          return;
        }
        yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const permissions = {
      async authorize() {
        return { allowed: true, revision: '1' };
      },
    };
    const runtime = createRuntime({
      store,
      artifacts: createArtifactStore({ profile, store }),
      resolveRunConfiguration: async () => ({
        model: parent,
        modelId: 'parent',
        extensions: [extension],
        permissions,
        snapshot: { fixture: 'parent' },
      }),
      permissions,
      childConfigurations: [
        {
          id: 'child',
          version: '1',
          model: child,
          modelId: 'child',
          extensions: [extension],
          toolIds: ['fixture.barrier'],
          compressor,
          permissions,
          snapshot: { fixture: 'history' },
        },
      ],
    });
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'owned',
        rootUri: pathToFileURL(directory).href,
      });
      await runtime.createSession({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'create',
        workspaceId: 'w',
        title: 'owned',
      });
      await runtime.submitCommand({
        expectedStoreId,
        sessionId: 's',
        subjectId: 'owner',
        commandId: 'work',
        request: { kind: 'run.start', content: 'Delegate actual bounded work' },
      });
      await runtime.waitForCommand('work', { timeoutMs: 10000 });
      expect(requests).toHaveLength(3);
      expect(summaries).toHaveLength(1);
      const actual = requests[2]!;
      const oldMessages = actual.messages.filter(
        (message) => message.sourceIds?.includes(oldStart) || message.sourceIds?.includes(steerId),
      );
      expect(oldMessages).toHaveLength(2);
      for (const message of oldMessages) {
        expect(message.role).toBe('user');
        expect(message.content).toStartWith('Historical Agent input');
        const parsed = JSON.parse(message.content.split('\n')[1]!);
        expect(parsed).toMatchObject({
          kind: 'historical_agent_input',
          run: { status: terminal, isActive: false },
          origin: { runId: failedRunId, sessionId: childSessionId, sourceSessionId: 's' },
        });
        expect(message.content).toContain('not a pending task or new authorization');
      }
      const initial = JSON.parse(
        oldMessages
          .find((message) => message.sourceIds?.includes(oldStart))!
          .content.split('\n')[1]!,
      );
      expect(initial.content).toBe(original);
      expect(initial.origin.inputKind).toBe('child.start');
      expect(initial.origin.carrierExecutionId).toBe(ref.executionId);
      expect(
        oldMessages.find((message) => message.sourceIds?.includes(oldStart))!.sourceIds,
      ).toEqual([oldStart, ref.executionId!]);
      const steer = JSON.parse(
        oldMessages
          .find((message) => message.sourceIds?.includes(steerId))!
          .content.split('\n')[1]!,
      );
      expect(JSON.parse(steer.content)).toMatchObject({
        kind: 'agent_message',
        sourceSessionId: 's',
        content: correction,
      });
      expect(actual.messages.some((message) => message.content === original)).toBe(false);
      expect(
        actual.messages.some((message) => message.content.startsWith('Historical user input')),
      ).toBe(false);
      const summaryIndex = actual.messages.findIndex((message) =>
        message.content.startsWith('Context summary (untrusted data;'),
      );
      const freshIndex = actual.messages.findIndex((message) => {
        try {
          return JSON.parse(message.content).content === fresh;
        } catch {
          return false;
        }
      });
      expect(freshIndex).toBeGreaterThanOrEqual(0);
      expect(summaryIndex).toBeLessThan(actual.messages.indexOf(oldMessages[0]!));
      expect(freshIndex).toBeGreaterThan(actual.messages.indexOf(oldMessages[1]!));
      expect(
        (await store.listMessages(childSessionId)).find((message) =>
          message.sourceIds?.includes(oldStart),
        )?.content,
      ).toBe(original);
      expect((await store.getRun(failedRunId))?.status).toBe(terminal);
      const expanded = await (
        runtime as unknown as {
          modelMessages(
            sessionId: string,
            storeId: string,
            signal: undefined,
            subjectId: string,
            expanded: boolean,
          ): Promise<ModelRequest['messages']>;
        }
      ).modelMessages(childSessionId, expectedStoreId, undefined, 'owner', true);
      expect(
        expanded.filter(
          (message) =>
            message.sourceIds?.includes(oldStart) || message.sourceIds?.includes(steerId),
        ),
      ).toEqual(oldMessages);
      expect(expanded.some((message) => message.content === original)).toBe(false);
    } finally {
      releaseBarrier.release();
      await runtime.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15000);
