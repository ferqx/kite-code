import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter, ModelEvent, ModelRequest } from '@kite-ai/ai';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { AgentError } from '../../../src/storage/types';

const finish = {
  type: 'finish',
  reason: 'stop',
  usage: { inputTokens: 1, outputTokens: 1 },
} satisfies ModelEvent;
const object = (value: unknown) =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > end) throw Error('resume_rejection_boundary_timeout');
    await Bun.sleep(5);
  }
}
async function fixture(providerFailure = false, holdDispatch = false, holdPreparation = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-resume-rejection-')));
  const actual = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  let releaseDispatch!: () => void, dispatchEntered!: () => void;
  const dispatchGate = new Promise<void>((resolve) => {
    releaseDispatch = resolve;
  });
  const dispatchReady = new Promise<void>((resolve) => {
    dispatchEntered = resolve;
  });
  const store = new Proxy(actual, {
    get(target, key) {
      if (key === 'beginHumanInputProcessing' && holdPreparation)
        return async (input: Parameters<Store['beginHumanInputProcessing']>[0]) => {
          dispatchEntered();
          await dispatchGate;
          return actual.beginHumanInputProcessing(input);
        };
      if (key === 'markDispatching')
        return async (input: Parameters<Store['markDispatching']>[0]) => {
          const execution = await actual.getExecution(input.executionId);
          if (
            holdDispatch &&
            execution?.kind === 'model' &&
            object(execution.decisionSource).humanInputInterpretation
          ) {
            dispatchEntered();
            await dispatchGate;
          }
          return actual.markDispatching(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const scope = {
    expectedStoreId: (await store.getMetadata()).storeId,
    sessionId: 's',
    subjectId: 'owner',
  };
  const requests: ModelRequest[] = [];
  const model: ModelAdapter = {
    async *stream(request) {
      requests.push(request);
      const instruction = request.messages.find((m) =>
        m.content.includes('Original input identity: '),
      );
      if (instruction) {
        expect(request.tools).toEqual([]);
        if (providerFailure) throw new AgentError('work_resume_unavailable');
        const identity = JSON.parse(
          instruction.content
            .split('\n')
            .find((line) => line.startsWith('Original input identity: '))!
            .slice('Original input identity: '.length),
        );
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            ...identity,
            relation: 'same_work',
            purpose: 'continue',
            target_root_work_command_id: 'A',
            selection_effect: 'select_work',
            answer: null,
            clarification: null,
          }),
        };
      } else yield { type: 'text_delta', text: 'Actual ordinary work completed.' };
      yield finish;
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixture',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'owned' };
      },
    },
    extensions: [
      {
        id: 'fixture',
        version: '1',
        apiMajor: 1,
        actions: [
          {
            id: 'wake',
            version: '1',
            description: 'Wake the ordinary Session pump',
            inputSchema: { type: 'object' },
            async prepare(input) {
              return input;
            },
            async execute() {
              return { outcome: 'succeeded', content: 'Original action completed.' };
            },
          },
        ],
      },
    ],
  });
  await runtime.createWorkspace({
    expectedStoreId: scope.expectedStoreId,
    id: 'w',
    name: 'owned',
    rootUri: pathToFileURL(root).href,
  });
  await runtime.createSession({
    ...scope,
    workspaceId: 'w',
    commandId: 'create',
    title: 'resume rejection',
  });
  await runtime.submitCommand({
    ...scope,
    commandId: 'A',
    request: { kind: 'run.start', content: 'New task: inspect original A.' },
  });
  await runtime.waitForCommand('A');
  const original = (await store.getView('s')).runs[0]!;
  await runtime.submitCommand({
    ...scope,
    commandId: 'stop-A',
    request: { kind: 'run.start', content: 'Stop A.' },
  });
  const stopped = await store.readHumanWorkState(scope);
  const eligibility = () =>
    store.readHumanWorkEligibility({
      ...scope,
      rootWorkCommandId: 'A',
      rootWorkSeq: original.rootWorkSeq,
    });
  expect((await eligibility()).reason).toBe('work_stopped');
  return {
    root,
    store,
    runtime,
    scope,
    requests,
    original,
    stopped,
    eligibility,
    dispatchReady,
    releaseDispatch,
    async close() {
      releaseDispatch();
      await runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
async function expectRejected(f: Awaited<ReturnType<typeof fixture>>, commandId: string) {
  const command = (await f.store.getCommand(commandId))!;
  expect(command.status).toBe('rejected');
  expect(command.receipt).toMatchObject({
    outcome: 'human_input_rejected',
    reason: 'work_resume_unavailable',
    runId: null,
    businessCommandId: null,
  });
  const receipt = object(command.receipt);
  const raw = (await f.store.getCommand(String(receipt.humanInputCommandId)))!;
  expect(object(raw.request).content).toBe('Continue A.');
  expect(raw.receipt).toMatchObject({
    state: 'decided',
    applicationState: 'rejected',
    businessCommandId: null,
    decisionCommandId: receipt.decisionCommandId,
  });
  const decision = (await f.store.getCommand(String(receipt.decisionCommandId)))!;
  expect(decision.status).toBe('rejected');
  expect(object(decision.request).proposal).toMatchObject({
    relation: 'same_work',
    purpose: 'continue',
    targetRootWorkCommandId: 'A',
    selectionEffect: 'select_work',
  });
  expect(decision.receipt).toMatchObject({
    outcome: 'human_input_rejected',
    selectionEffect: 'keep',
    businessCommandId: null,
    purpose: 'continue',
    targetRootWorkCommandId: 'A',
  });
  const state = await f.store.readHumanWorkState(f.scope);
  expect(state.selectedWork).toEqual(f.stopped.selectedWork);
  expect(state.pendingInputIds).not.toContain(raw.id);
  expect((await f.eligibility()).reason).toBe('work_stopped');
  return { command, raw, decision };
}
test('direct stopped Continue seals exact rejection with zero interpretation; original replay and new B stay independent', async () => {
  const f = await fixture();
  try {
    const request = {
      ...f.scope,
      commandId: 'continue-A',
      request: { kind: 'run.start' as const, content: 'Continue A.' },
    };
    await f.runtime.submitCommand(request);
    const rejected = await expectRejected(f, request.commandId);
    expect(f.requests).toHaveLength(1);
    expect((await f.store.getView('s')).runs).toHaveLength(1);
    expect(await f.runtime.submitCommand(request)).toEqual(rejected.command);
    expect(await f.runtime.waitForCommand(request.commandId)).toEqual(rejected.command);
    expect(f.requests).toHaveLength(1);
    await f.runtime.submitCommand({
      ...f.scope,
      commandId: 'B',
      request: { kind: 'run.start', content: 'New task: independent B.' },
    });
    await f.runtime.waitForCommand('B');
    expect(f.requests).toHaveLength(2);
    expect((await f.store.getView('s')).runs.map((run) => run.rootWorkCommandId)).toEqual([
      'A',
      'B',
    ]);
    expect(await f.store.getCommand(rejected.raw.id)).toEqual(rejected.raw);
    expect(await f.store.getRun(f.original.id)).toEqual(f.original);
  } finally {
    await f.close();
  }
});
for (const providerFailure of [false, true])
  test(`pending input interpretation and stopped-work final gate preserve actual Model outcome: provider failure=${providerFailure}`, async () => {
    const f = await fixture(providerFailure);
    try {
      // A genuine pending intake can be observed by the ordinary pump before its
      // caller reaches direct routing; no Run, decision or Model result is forged.
      await f.store.registerHumanCommand({
        ...f.scope,
        commandId: 'continue-A',
        request: { kind: 'run.start', content: 'Continue A.' },
        candidateWorkCommandIds: ['A'],
      });
      await f.runtime.submitCommand({
        ...f.scope,
        commandId: 'wake',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'wake',
          definitionVersion: '1',
          input: {},
        },
      });
      await until(
        async () =>
          (await f.store.getView('s')).runs.length === 2 &&
          (await f.store.getView('s')).runs.every((run) => !run.isActive),
      );
      const view = await f.store.getView('s');
      const processing = view.runs.find((run) => run.id !== f.original.id)!;
      expect(object(object(processing.configuration).snapshot).kind).toBe('human_input_processing');
      expect(object(processing.configuration).tools).toEqual([]);
      const model = view.executions.find(
        (execution) => execution.kind === 'model' && execution.runId === processing.id,
      )!;
      expect(
        view.executions
          .filter((execution) => execution.runId === processing.id)
          .map((execution) => execution.kind),
      ).toEqual(['model']);
      expect(f.requests).toHaveLength(2);
      if (providerFailure) {
        expect(processing.status).toBe('failed');
        expect(model.status).toBe('failed');
        const publicCommand = (await f.store.getCommand('continue-A'))!;
        expect(publicCommand.status).toBe('accepted');
        expect(object(publicCommand.receipt).decisionCommandId).toBeUndefined();
      } else {
        const rejected = await expectRejected(f, 'continue-A');
        expect(processing.status).toBe('completed');
        expect(model.status).toBe('succeeded');
        expect(model.result).toMatchObject({ finishReason: 'stop', toolCalls: [] });
        const before = f.requests.length;
        expect(
          await f.runtime.submitCommand({
            ...f.scope,
            commandId: 'continue-A',
            request: { kind: 'run.start', content: 'Continue A.' },
          }),
        ).toEqual(rejected.command);
        expect(f.requests.length).toBe(before);
      }
      expect((await f.eligibility()).reason).toBe('work_stopped');
    } finally {
      await f.close();
    }
  });

test('a sealed rejected Continue wins over already prepared readonly dispatch without calling a Provider', async () => {
  const f = await fixture(false, true);
  try {
    const request = {
      ...f.scope,
      commandId: 'continue-A',
      request: { kind: 'run.start' as const, content: 'Continue A.' },
    };
    await f.store.registerHumanCommand({ ...request, candidateWorkCommandIds: ['A'] });
    await f.runtime.submitCommand({
      ...f.scope,
      commandId: 'wake',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'wake',
        definitionVersion: '1',
        input: {},
      },
    });
    await f.dispatchReady;
    await f.runtime.submitCommand(request);
    await expectRejected(f, 'continue-A');
    f.releaseDispatch();
    await until(async () => (await f.store.getView('s')).runs.every((run) => !run.isActive));
    const view = await f.store.getView('s');
    const processing = view.runs.find((run) => run.id !== f.original.id)!;
    expect(processing.status).toBe('completed');
    const model = view.executions.find((execution) => execution.runId === processing.id)!;
    expect(model.kind).toBe('model');
    expect(model.status).toBe('failed');
    expect(model.authorization?.dispatched ?? false).toBe(false);
    expect(model.result).toMatchObject({
      code: 'input_processing_decided',
      dispatchCommitted: false,
    });
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('pending preparation observes exact rejection committed before begin-processing and does not poison the ordinary pump', async () => {
  const f = await fixture(false, false, true);
  try {
    const request = {
      ...f.scope,
      commandId: 'continue-A',
      request: { kind: 'run.start' as const, content: 'Continue A.' },
    };
    await f.store.registerHumanCommand({ ...request, candidateWorkCommandIds: ['A'] });
    await f.runtime.submitCommand({
      ...f.scope,
      commandId: 'wake',
      request: {
        kind: 'extension.invoke',
        extensionId: 'fixture',
        actionId: 'wake',
        definitionVersion: '1',
        input: {},
      },
    });
    await f.dispatchReady;
    await f.runtime.submitCommand(request);
    await expectRejected(f, 'continue-A');
    f.releaseDispatch();
    expect((await f.runtime.waitForCommand('wake')).status).toBe('applied');
    expect((await f.store.getView('s')).runs).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
  } finally {
    await f.close();
  }
});

for (const boundary of ['prepared_model', 'pending_preparation'] as const)
  test(`forged rejected decision cannot replace Core proof at ${boundary}`, async () => {
    const f = await fixture(
      false,
      boundary === 'prepared_model',
      boundary === 'pending_preparation',
    );
    try {
      const request = {
        ...f.scope,
        commandId: 'continue-A',
        request: { kind: 'run.start' as const, content: 'Continue A.' },
      };
      await f.store.registerHumanCommand({ ...request, candidateWorkCommandIds: ['A'] });
      await f.runtime.submitCommand({
        ...f.scope,
        commandId: 'wake',
        request: {
          kind: 'extension.invoke',
          extensionId: 'fixture',
          actionId: 'wake',
          definitionVersion: '1',
          input: {},
        },
      });
      await f.dispatchReady;
      await f.runtime.submitCommand(request);
      const rejected = await expectRejected(f, 'continue-A');
      // An isolated corrupted persistent decision must fail closed; this is not
      // a Provider callback or fabricated successful Model response.
      const database = new Database(join(f.root, 'data/test/core.db'));
      try {
        database.run("UPDATE command SET request_digest='forged' WHERE id=?", [
          rejected.decision.id,
        ]);
      } finally {
        database.close();
      }
      if (boundary === 'pending_preparation')
        await f.runtime.submitCommand({
          ...f.scope,
          commandId: 'witness-B',
          request: { kind: 'run.start', content: 'New task: independent witness B.' },
        });
      f.releaseDispatch();
      if (boundary === 'pending_preparation') {
        await until(async () => 'dispatchFailure' in (await f.runtime.getCommand('witness-B'))!);
        expect(await f.runtime.getCommand('witness-B')).toMatchObject({
          dispatchFailure: { code: 'input_processing_unavailable' },
        });
        expect((await f.store.getView('s')).runs).toHaveLength(1);
      } else {
        await until(async () => (await f.store.getView('s')).runs.every((run) => !run.isActive));
        const run = (await f.store.getView('s')).runs.find((run) => run.id !== f.original.id)!;
        expect(run.status).toBe('failed');
        expect(run.reason).toBe('input_proposal_unverifiable');
      }
      expect(f.requests).toHaveLength(1);
    } finally {
      await f.close();
    }
  });
