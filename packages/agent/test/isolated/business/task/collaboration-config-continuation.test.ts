import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createArtifactStore } from '../../../../src/artifacts';
import { createTaskExtension } from '../../../../src/extensions/task';
import { createRuntime, type RunConfiguration } from '../../../../src/runtime';
import { openSqliteStore } from '../../../../src/sqlite';

const finish: Extract<ModelEvent, { type: 'finish' }> = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
};
const call = (name: string, input: unknown): ModelEvent[] => [
  { type: 'tool_call', id: crypto.randomUUID(), name, arguments: JSON.stringify(input) },
  { ...finish, reason: 'tool_calls' },
];
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}
async function until<T>(read: () => Promise<T | undefined>): Promise<T> {
  const end = Date.now() + 7000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= end) throw Error('configuration_continuation_deadline');
    await Bun.sleep(5);
  }
}
for (const cold of [false, true])
  test(`${cold ? 'cold' : 'hot'} explicit continue A uses its exact Model/configuration and current permission revision while B sources stay outside A`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'kite-config-continuation-')));
    const profile = { dataRoot: join(directory, 'data'), profile: 'test' };
    let store = await openSqliteStore(profile);
    const expectedStoreId = (await store.getMetadata()).storeId;
    const identity = { expectedStoreId, subjectId: 'owner', sessionId: 'root' };
    const aGate = gate(),
      bGate = gate(),
      bFinish = gate();
    let aCalls = 0,
      bCalls = 0,
      revision = 'permission-1',
      bCursor = '0',
      bSourceId = '';
    const aRequests: ModelRequest[] = [],
      bRequests: ModelRequest[] = [];
    const permissionCalls: { model: string; revision: string }[] = [];
    const currentResolverCommands: string[] = [];
    const recoveryCommands: string[] = [];
    const resultA = 'EXACT_A_CHILD_RESULT';
    const resultB = 'EXACT_B_CHILD_RESULT';
    const modelA: ModelAdapter = {
      async *stream(request) {
        aRequests.push(structuredClone(request));
        if (aCalls++ === 0) {
          for (const event of call('spawn_agent', { prompt: 'Assignment A' })) yield event;
        } else {
          if (aCalls > 2) {
            expect(JSON.stringify(request.messages)).toContain(resultA);
            expect(request.messages.some((message) => message.sourceIds?.includes(bSourceId))).toBe(
              false,
            );
          }
          yield {
            type: 'text_delta',
            text:
              aCalls === 2
                ? 'A ordinary turn ended.'
                : 'A continued with its original configuration.',
          };
          yield finish;
        }
      },
    };
    const modelB: ModelAdapter = {
      async *stream(request) {
        bRequests.push(structuredClone(request));
        expect(JSON.stringify(request.messages)).not.toContain(resultA);
        const last = request.messages.filter((message) => message.role === 'tool').at(-1);
        if (last) {
          try {
            bCursor = JSON.parse(last.content).next_seq ?? bCursor;
          } catch {}
        }
        if (bCalls++ === 0) {
          for (const event of call('spawn_agent', { prompt: 'Assignment B' })) yield event;
        } else if (!JSON.stringify(request.messages).includes(resultB)) {
          for (const event of call('wait_agent_events', { after_seq: bCursor, wait_ms: 5000 }))
            yield event;
        } else {
          await bFinish.promise;
          yield { type: 'text_delta', text: 'B ordinary work completed with its own result.' };
          yield finish;
        }
      },
    };
    const child: ModelAdapter = {
      async *stream(request) {
        const isA = JSON.stringify(request.messages).includes('Assignment A');
        await (isA ? aGate.promise : bGate.promise);
        yield { type: 'text_delta', text: isA ? resultA : resultB };
        yield finish;
      },
    };
    const task = createTaskExtension({
      roles: [{ id: 'worker', configurationId: 'worker', description: 'trusted' }],
    });
    const tools = task.tools!.filter((tool) => !tool.model?.hidden).map((tool) => tool.id);
    const permissions = {
      async authorize(request: { kind: string; definitionId: string }) {
        if (request.kind === 'model')
          permissionCalls.push({ model: request.definitionId, revision });
        return { allowed: true, revision };
      },
    };
    const binding = (which: 'A' | 'B'): RunConfiguration => ({
      model: which === 'A' ? modelA : modelB,
      modelId: which,
      toolIds: tools,
      snapshot: { route: which, immutableConfiguration: `snapshot-${which}` },
      permissions,
      afterTurn: {
        async authorize() {
          return { allowed: true, revision: 'idle-authority' };
        },
      },
    });
    const options = () => ({
      store,
      artifacts: createArtifactStore({ profile, store }),
      model: modelB,
      modelId: 'B',
      modelConcurrency: 3,
      extensions: [task],
      permissions,
      childConfigurations: [
        {
          id: 'worker',
          version: '1',
          model: child,
          modelId: 'child',
          toolIds: [],
          snapshot: { child: true },
        },
      ],
      async resolveRunConfiguration(
        input: Parameters<
          NonNullable<Parameters<typeof createRuntime>[0]['resolveRunConfiguration']>
        >[0],
      ) {
        currentResolverCommands.push(input.command.id);
        return binding((input.command.request as { modelId?: string }).modelId === 'A' ? 'A' : 'B');
      },
      async resolveRecoveryRunConfiguration(
        input: Parameters<
          NonNullable<Parameters<typeof createRuntime>[0]['resolveRecoveryRunConfiguration']>
        >[0],
      ) {
        recoveryCommands.push(input.command.id);
        expect(input.command.id).toBe('A');
        expect(input.run.rootWorkCommandId).toBe('A');
        expect(input.run.configuration).toMatchObject({
          modelId: 'A',
          snapshot: { route: 'A', immutableConfiguration: 'snapshot-A' },
        });
        return binding('A');
      },
    });
    let runtime = createRuntime(options());
    try {
      await runtime.createWorkspace({
        expectedStoreId,
        id: 'w',
        name: 'private',
        rootUri: pathToFileURL(directory).href,
      });
      await runtime.createSession({
        ...identity,
        commandId: 'create',
        workspaceId: 'w',
        title: 'A and B',
      });
      await runtime.submitCommand({
        ...identity,
        commandId: 'A',
        request: { kind: 'run.start', modelId: 'A', content: 'Original task A' },
      });
      await runtime.waitForCommand('A', { timeoutMs: 7000 });
      const originalA = (await store.getView('root')).runs.find(
        (run) => run.originCommandId === 'A',
      )!;
      await runtime.submitCommand({
        ...identity,
        commandId: 'B',
        request: { kind: 'run.start', modelId: 'B', content: 'Independent task B' },
      });
      await until(async () => (bCalls >= 2 ? true : undefined));
      aGate.release();
      bGate.release();
      const carriers = await until(async () => {
        const values = (await store.listExecutions('root')).filter(
          (execution) => execution.childSessionId,
        );
        return values.length === 2 ? values : undefined;
      });
      const carrierA = carriers.find((execution) => execution.rootWorkCommandId === 'A')!;
      const carrierB = carriers.find((execution) => execution.rootWorkCommandId === 'B')!;
      await until(async () => {
        const current = await store.getExecution(carrierB.id);
        return current?.resultAcceptance?.sourceId ? current : undefined;
      }).then((value) => {
        bSourceId = value.resultAcceptance!.sourceId;
      });
      const deferred = await until(async () => {
        const page = await store.listPendingJobReports(identity);
        return page.commands.find((command) => command.rootWorkCommandId === 'A');
      });
      const eligibility = await store.readHumanWorkEligibility({
        ...identity,
        rootWorkCommandId: 'A',
        rootWorkSeq: originalA.rootWorkSeq,
      });
      expect(eligibility.state).toBe('deferred');
      expect(deferred.status).toBe('accepted');
      expect((await store.getExecution(carrierA.id))!.resultAcceptance).toBeNull();
      bFinish.release();
      await runtime.waitForCommand('B', { timeoutMs: 7000 });
      if (cold) {
        await runtime.close();
        await store.close();
        const readonly = await openSqliteStore({ ...profile, mode: 'readonly' });
        try {
          const before = aRequests.length + bRequests.length;
          expect((await readonly.getRun(originalA.id))!.status).toBe('completed');
          expect((await readonly.getExecution(carrierA.id))!.delivery).toBe('pending');
          await readonly.getView('root');
          expect(aRequests.length + bRequests.length).toBe(before);
        } finally {
          await readonly.close();
        }
        store = await openSqliteStore(profile);
        runtime = createRuntime(options());
      }
      revision = 'permission-2';
      const beforeB = bRequests.length;
      await runtime.submitCommand({
        ...identity,
        commandId: 'continue-A',
        request: { kind: 'run.start', modelId: 'B', content: '继续 A' },
      });
      await runtime.waitForCommand('continue-A', { timeoutMs: 7000 });
      const command = (await store.getCommand('continue-A'))!;
      expect(command.request).toMatchObject({ modelId: 'B' });
      const receipt = command.receipt as { runId: string };
      const continued = (await store.getRun(receipt.runId))!;
      expect(continued.rootWorkCommandId).toBe('A');
      expect(continued.id).not.toBe(originalA.id);
      expect(continued.configuration).toEqual(originalA.configuration);
      expect(continued.status).toBe('completed');
      expect((await store.getRun(originalA.id))!.status).toBe('completed');
      expect(bRequests).toHaveLength(beforeB);
      expect(permissionCalls).toContainEqual({ model: 'A', revision: 'permission-2' });
      expect(currentResolverCommands).not.toContain(continued.originCommandId);
      expect(recoveryCommands).toEqual(cold ? ['A'] : []);
      const accepted = (await store.getExecution(carrierA.id))!.resultAcceptance!;
      expect(accepted.runId).toBe(continued.id);
      const selected = await store.getSelectedContext({ expectedStoreId, sessionId: 'root' });
      expect(
        selected.resultSources.filter((source) => source.executionId === carrierA.id),
      ).toHaveLength(1);
    } finally {
      aGate.release();
      bGate.release();
      bFinish.release();
      await runtime.close();
      await store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20000);
