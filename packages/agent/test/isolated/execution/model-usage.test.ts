import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelAdapter } from '@kite-ai/ai';
import { createCompatibleModelBinding, createSdkModelAdapter } from '@kite-ai/ai/sdk';
import { createRuntime } from '../../../src/runtime';
import { openSqliteStore } from '../../../src/sqlite';

const raw = {
  prompt_tokens: 13,
  completion_tokens: 5,
  total_tokens: 20,
  prompt_cache_hit_tokens: 7,
  prompt_tokens_details: { cache_write_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 3, text_tokens: 2 },
};
const measured = {
  inputTokens: 13,
  outputTokens: 5,
  totalTokens: 20,
  cachedInputTokens: 7,
  reasoningTokens: 3,
  raw,
};

test.each([
  'succeeded',
  'failed',
  'cancelled',
  'missing',
] as const)('SDK usage is retained through real SQLite completion and cold reads: %s', async (mode) => {
  const temporary = realpathSync(tmpdir());
  const root = realpathSync(mkdtempSync(join(temporary, 'kite-model-usage-')));
  const storeOptions = { dataRoot: join(root, 'data'), profile: 'test' };
  const store = await openSqliteStore(storeOptions);
  let received!: () => void;
  const usageReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  let calls = 0;
  const binding = createCompatibleModelBinding({
    baseURL: 'http://local-usage-fixture.invalid/v1',
    modelId: 'fixture',
    fetch: Object.assign(
      async (_url: unknown, init?: RequestInit) => {
        calls++;
        expect(JSON.parse(String(init?.body))).toMatchObject({
          stream_options: { include_usage: true },
        });
        const chunk = (choices: unknown[], usage: unknown) =>
          `data: ${JSON.stringify({ id: 'fixture', choices, usage })}\n\n`;
        return new Response(
          chunk([{ index: 0, delta: { content: 'Original content' }, finish_reason: null }], null) +
            chunk(
              [
                {
                  index: 0,
                  delta: {},
                  finish_reason: mode === 'failed' ? 'content_filter' : 'stop',
                },
              ],
              null,
            ) +
            (mode === 'missing' ? '' : chunk([], raw)) +
            'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
      { preconnect: fetch.preconnect },
    ),
  });
  const adapter = createSdkModelAdapter({ models: new Map([['fixture', binding]]) });
  const model: ModelAdapter = {
    async *stream(request, options) {
      for await (const event of adapter.stream(request, options)) {
        yield event;
        if (mode === 'cancelled' && event.type === 'usage') {
          received();
          await new Promise<void>((_resolve, reject) => {
            if (options.signal.aborted) reject(options.signal.reason);
            else
              options.signal.addEventListener('abort', () => reject(options.signal.reason), {
                once: true,
              });
          });
        }
      }
    },
  };
  const runtime = createRuntime({
    store,
    model,
    modelId: 'fixture',
    permissions: {
      async authorize() {
        return { allowed: true, revision: 'fixture' };
      },
    },
  });
  try {
    const expectedStoreId = (await store.getMetadata()).storeId;
    await runtime.createWorkspace({
      expectedStoreId,
      id: 'workspace',
      name: 'Fixture',
      rootUri: pathToFileURL(root).href,
    });
    const input = { expectedStoreId, sessionId: 'session', subjectId: 'owner' };
    await runtime.createSession({
      ...input,
      commandId: 'create',
      workspaceId: 'workspace',
      title: 'Fixture',
    });
    await runtime.submitCommand({
      ...input,
      commandId: 'work',
      request: { kind: 'run.start', content: 'Local fixture' },
    });
    if (mode === 'cancelled') {
      await usageReceived;
      await runtime.cancelCommand({ ...input, commandId: 'cancel', targetCommandId: 'work' });
    }
    await runtime.waitForCommand('work');
    const view = await runtime.getView('session');
    const executions = view.executions.filter((entry) => entry.kind === 'model');
    expect(executions).toHaveLength(1);
    expect(executions[0]!.status).toBe(mode === 'missing' ? 'succeeded' : mode);
    const expected = mode === 'missing' ? { inputTokens: null, outputTokens: null } : measured;
    expect(executions[0]!.result).toMatchObject({ usage: expected });
    expect(
      await store.getSessionTokenUsage({ expectedStoreId, sessionId: 'session' }),
    ).toMatchObject({
      executionCount: 1,
      missingInputCount: mode === 'missing' ? 1 : 0,
      missingOutputCount: mode === 'missing' ? 1 : 0,
      ...(mode === 'missing' ? {} : { inputTokens: 13, outputTokens: 5 }),
    });
    expect(view.executions.some((entry) => entry.kind === 'tool')).toBe(false);
    expect(calls).toBe(1);
    await runtime.close();
    const cold = await openSqliteStore({ ...storeOptions, mode: 'readonly' });
    try {
      const original = await cold.getExecution(executions[0]!.id);
      expect(original?.status).toBe(executions[0]!.status);
      expect(original?.result).toMatchObject({ usage: expected });
      expect(calls).toBe(1);
    } finally {
      await cold.close();
    }
  } finally {
    await runtime.close();
    expect(dirname(root).toLowerCase()).toBe(temporary.toLowerCase());
    expect(basename(root)).toStartWith('kite-model-usage-');
    rmSync(root, { recursive: true, force: true });
  }
});
