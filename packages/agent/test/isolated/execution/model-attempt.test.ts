import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ModelAdapter, ModelAttemptError } from '@kite-ai/ai';
import { waitForModelRetry } from '../../../src/model-attempt';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

async function fixture(model: ModelAdapter) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kite-model-attempt-')));
  const store = await openSqliteStore({ dataRoot: join(root, 'data'), profile: 'test' });
  const expectedStoreId = (await store.getMetadata()).storeId;
  let effects = 0,
    authorizations = 0;
  const authorizationExecutions: string[] = [];
  const runtime = createRuntime({
    store,
    model,
    permissions: {
      async authorize(request) {
        authorizations++;
        authorizationExecutions.push(request.executionId);
        return { allowed: true, revision: 'actual' };
      },
    },
    extensions: [
      {
        id: 'test',
        version: '1',
        apiMajor: 1,
        tools: [
          {
            id: 'effect',
            version: '1',
            description: 'Count an actual test-owned local effect',
            inputSchema: { type: 'object' },
            async execute() {
              effects++;
              return { outcome: 'succeeded', content: 'actual' };
            },
          },
        ],
      },
    ],
  });
  const input = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
  await runtime.createWorkspace({
    expectedStoreId,
    id: 'workspace',
    rootUri: pathToFileURL(root).href,
    name: 'test',
  });
  await runtime.createSession({
    ...input,
    commandId: 'create',
    workspaceId: 'workspace',
    title: 'test',
  });
  return {
    runtime,
    input,
    get effects() {
      return effects;
    },
    get authorizations() {
      return authorizations;
    },
    authorizationExecutions,
    async close() {
      await runtime.close();
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('each safe transport attempt is a separate failed/successful execution with exact predecessor and no partial tool effect', async () => {
  let attempts = 0;
  const f = await fixture({
    async *stream() {
      attempts++;
      if (attempts === 1) {
        yield { type: 'text_delta', text: 'Original partial' };
        yield { type: 'tool_call', id: 'discarded', name: 'effect', arguments: '{}' };
        throw new ModelAttemptError('stream_incomplete');
      }
      yield { type: 'text_delta', text: 'Recovered' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  try {
    await f.runtime.submitCommand({
      ...f.input,
      commandId: 'work',
      request: { kind: 'run.start', content: 'do work' },
    });
    await f.runtime.waitForCommand('work');
    const view = await f.runtime.getView('session');
    const models = view.executions.filter((e) => e.kind === 'model');
    expect(attempts).toBe(2);
    expect(f.effects).toBe(0);
    expect(f.authorizations).toBe(4);
    for (const model of models)
      expect(f.authorizationExecutions.filter((id) => id === model.id)).toHaveLength(2);
    expect(models.map((e) => e.status)).toEqual(['failed', 'succeeded']);
    expect(models[0]!.result).toMatchObject({
      content: 'Original partial',
      incomplete: true,
      code: 'MODEL_ATTEMPT_RETRYABLE_FAILURE:stream_incomplete',
    });
    expect(models[1]!.decisionSource).toMatchObject({
      retry: {
        previousExecutionId: models[0]!.id,
        attempt: 2,
        maxAttempts: null,
        reason: 'stream_incomplete',
      },
    });
    expect(view.runs[0]!.status).toBe('completed');
  } finally {
    await f.close();
  }
});

test('safe transient failures continue beyond five attempts in the same Run', async () => {
  let attempts = 0;
  const f = await fixture({
    async *stream() {
      attempts++;
      if (attempts <= 5) throw new ModelAttemptError('provider_unavailable');
      yield { type: 'text_delta', text: 'New user reply' };
      yield { type: 'finish', reason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  });
  try {
    await f.runtime.submitCommand({
      ...f.input,
      commandId: 'work',
      request: { kind: 'run.start', content: 'fail' },
    });
    await f.runtime.waitForCommand('work');
    const first = await f.runtime.getView('session');
    expect(attempts).toBe(6);
    expect(
      first.executions.filter((e) => e.kind === 'model' && e.status === 'failed'),
    ).toHaveLength(5);
    expect(first.runs[0]!.status).toBe('completed');
    expect(first.runs).toHaveLength(1);
    expect(first.executions.at(-1)!.decisionSource).toMatchObject({
      retry: { attempt: 6, maxAttempts: null },
    });
    await f.runtime.submitCommand({
      ...f.input,
      commandId: 'followup',
      request: { kind: 'run.start', content: 'New task: new work' },
    });
    const followup = await f.runtime.waitForCommand('followup');
    const receipt = followup.receipt as { runId: string };
    const business = await f.runtime.getCommand(followup.id);
    expect(business?.receipt).toMatchObject({ runId: receipt.runId });
    expect(business?.id).toBe(followup.id);
    expect(receipt).not.toHaveProperty('businessCommandId');
    expect(attempts).toBe(7);
    expect(
      (await f.runtime.getView('session')).runs.find((r) => r.id === receipt.runId),
    ).toMatchObject({
      status: 'completed',
      originCommandId: business!.id,
      rootWorkCommandId: 'followup',
    });
  } finally {
    await f.close();
  }
});

test('unclassified model failure is retained and never retried', async () => {
  let attempts = 0;
  const f = await fixture({
    async *stream() {
      attempts++;
      yield { type: 'text_delta', text: 'Original failure prefix' };
      throw new Error('invalid_model_tool_call');
    },
  });
  try {
    await f.runtime.submitCommand({
      ...f.input,
      commandId: 'work',
      request: { kind: 'run.start', content: 'invalid' },
    });
    await f.runtime.waitForCommand('work');
    expect(attempts).toBe(1);
    expect((await f.runtime.getView('session')).runs[0]!.status).toBe('failed');
  } finally {
    await f.close();
  }
});

test('retry backoff observes cancellation before the next Provider attempt', async () => {
  const controller = new AbortController();
  const wait = waitForModelRetry(5, controller.signal);
  controller.abort(new Error('cancel actual retry'));
  await expect(wait).rejects.toThrow('cancel actual retry');
});
