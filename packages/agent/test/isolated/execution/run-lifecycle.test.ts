import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFixedModel } from '@kite-ai/ai';
import type { Extension } from '../../../src/extensions';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';
import type { Store } from '../../../src/storage/port';
import { AgentError } from '../../../src/storage/types';

async function until<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('lifecycle fixture did not settle');
}

test.each([
  'success',
  'no_hooks',
  'no_model',
  'action_failure',
  'action_throw',
  'completion_retry',
] as const)('ordinary lifecycle Actions preserve scoped facts and original Run outcome: %s', async (mode) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-lifecycle-')));
  const profile = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(profile);
  const observed: string[] = [];
  const extension: Extension = {
    id: 'lifecycle.fixture',
    version: '1',
    apiMajor: 1,
    runLifecycle: {
      async prepare(event) {
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.isFrozen(event.command)).toBe(true);
        expect(event.command.id).toBe('work');
        expect(event.command.request).toMatchObject({ content: 'Original input' });
        if (event.phase === 'before_start') expect(event.run).toBeNull();
        else expect(event.run?.isActive).toBe(true);
        observed.push(event.phase);
        return {
          actionId: 'record',
          definitionVersion: '1',
          input: { phase: event.phase, commandId: event.command.id },
        };
      },
    },
    records: [{ contentType: 'fixture.lifecycle', contentVersion: 1, schema: { type: 'object' } }],
    actions: [
      {
        id: 'record',
        version: '1',
        description: 'Save a finite lifecycle observation',
        inputSchema: { type: 'object' },
        async prepare(input) {
          return input;
        },
        async execute(input, context) {
          const phase = (input as { phase: string }).phase;
          if (mode === 'action_throw') throw new Error('fixture lifecycle action failed');
          if (mode === 'action_failure')
            return { outcome: 'failed', content: 'Finite lifecycle failure' };
          await context.records.write({
            key: phase,
            expectedRevision: null,
            contentType: 'fixture.lifecycle',
            contentVersion: 1,
            value: input,
          });
          return { outcome: 'succeeded', content: 'Lifecycle observation saved' };
        },
      },
    ],
  };
  const model = createFixedModel([
    [
      { type: 'text_delta', text: 'Original main answer' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } },
    ],
  ]);
  const permissions = {
    async authorize() {
      return { allowed: true, revision: 'fixture' };
    },
  };
  let completionRejected = false;
  const runtimeStore = new Proxy(store, {
    get(target, key) {
      if (key === 'finishRun')
        return async (input: Parameters<Store['finishRun']>[0]) => {
          if (mode === 'completion_retry' && input.status === 'completed' && !completionRejected) {
            completionRejected = true;
            throw new AgentError('input_pending');
          }
          return target.finishRun(input);
        };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const runtime = createRuntime({
    store: runtimeStore,
    ...(mode === 'no_model' ? {} : { model }),
    modelId: 'fixture',
    extensions: mode === 'no_hooks' ? [] : [extension],
    permissions,
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    const base = { expectedStoreId, sessionId: 's', subjectId: 'owner' };
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'w',
      name: 'Fixture',
      rootUri: pathToFileURL(root).href,
    });
    await runtime.createSession({
      ...base,
      commandId: 'create',
      workspaceId: 'w',
      title: '',
    });
    const submission = {
      ...base,
      commandId: 'work',
      request: { kind: 'run.start' as const, content: 'Original input' },
    };
    await runtime.submitCommand(submission);
    await runtime.waitForCommand('work');
    const expectedPhases =
      mode === 'no_hooks'
        ? []
        : mode === 'no_model'
          ? ['before_start']
          : ['before_start', 'before_complete'];
    await until(async () => {
      const view = await runtime.getView('s');
      const actions = view.executions.filter(
        (execution) => (execution.decisionSource as { kind?: string })?.kind === 'action_decision',
      );
      return actions.length === expectedPhases.length &&
        actions.every((execution) =>
          ['failed', 'succeeded', 'outcome_unknown'].includes(execution.status),
        )
        ? actions
        : null;
    });
    expect(observed).toEqual(expectedPhases);
    for (const phase of expectedPhases) {
      const record = await store.getExtensionRecord({
        extensionId: extension.id,
        sessionId: 's',
        key: phase,
      });
      if (mode === 'action_failure' || mode === 'action_throw') expect(record).toBeNull();
      else expect(record?.value).toEqual({ phase, commandId: 'work' });
    }
    const view = await runtime.getView('s');
    expect(view.session).toMatchObject({ title: '', controlRevision: '0' });
    expect(
      (await store.getChanges({ after: '0', limit: 100 })).events.filter(
        (event) => event.type === 'session.renamed',
      ),
    ).toHaveLength(0);
    if (mode === 'no_model') {
      expect(view.runs).toHaveLength(0);
      expect((await store.getCommand('work'))?.status).toBe('rejected');
      expect(model.requests).toHaveLength(0);
    } else {
      expect(view.runs).toHaveLength(1);
      expect(view.runs[0]?.status).toBe('completed');
      expect(view.messages).toHaveLength(2);
      expect(JSON.stringify(view.messages)).not.toContain('Lifecycle observation saved');
      expect(model.requests).toHaveLength(1);
    }
    const actions = view.executions.filter(
      (execution) => (execution.decisionSource as { kind?: string })?.kind === 'action_decision',
    );
    expect(
      actions.every(
        (execution) =>
          execution.status ===
          (mode === 'action_failure'
            ? 'failed'
            : mode === 'action_throw'
              ? 'outcome_unknown'
              : 'succeeded'),
      ),
    ).toBe(true);
    await runtime.submitCommand(submission);
    await runtime.getView('s');
    expect(observed).toEqual(expectedPhases);
    await runtime.close();
    const coldStore = await openSqliteStore(profile);
    const cold = createRuntime({
      store: coldStore,
      model,
      modelId: 'fixture',
      extensions: mode === 'no_hooks' ? [] : [extension],
      permissions,
    });
    try {
      await cold.getView('s');
      await cold.listMessages('s');
      expect(observed).toEqual(expectedPhases);
      if (mode === 'completion_retry') expect(completionRejected).toBe(true);
      expect(model.requests).toHaveLength(mode === 'no_model' ? 0 : 1);
    } finally {
      await cold.close();
    }
  } finally {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
